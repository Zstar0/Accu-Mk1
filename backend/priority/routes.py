"""/priorities API (spec §5).

Route order matters: every literal sub-path (`/assign`, `/resolve`,
`/customers`, `/default/{key}`, ...) is declared BEFORE the `/{key}` routes so
FastAPI can never match `customers` as a priority key.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import (
    CustomerPriority, LimsOrder, LimsSample, LimsSubSample, Priority, SlaPriorityTier,
    SlaTier, User,
)
from priority import service
from priority.schemas import (
    KEY_MAX, AssignIn, AssignOut, BulkAssignIn, CustomerPriorityOut, CustomerSeenOut,
    EffectiveOut, PriorityCreate, PriorityOut, PriorityPatch, ResolveIn, ResolveOut, slugify,
)

router = APIRouter(prefix="/priorities", tags=["priorities"])


def _global_tier_ids(db: Session) -> dict[str, int]:
    rows = db.execute(select(SlaPriorityTier).where(SlaPriorityTier.service_group_id.is_(None))).scalars()
    return {r.priority: r.sla_tier_id for r in rows}


def _explicit_counts(db: Session) -> dict[str, int]:
    """Explicit assignments per priority key across every level.

    Four GROUPed queries for the whole catalog, never one per row. NULL is
    "inherit", not an assignment, so it is filtered out rather than counted
    into a None bucket.
    """
    counts: dict[str, int] = {}
    for col in (CustomerPriority.priority_key, LimsOrder.priority_key,
                LimsSample.priority_key, LimsSubSample.priority_key):
        for key, n in db.execute(select(col, func.count()).where(col.is_not(None)).group_by(col)):
            counts[key] = counts.get(key, 0) + n
    return counts


def _out(p: Priority, tiers: dict[str, int], counts: dict[str, int] | None = None) -> PriorityOut:
    # `counts` is supplied by the list route only: a single-row response would
    # otherwise pay four aggregate scans to report a number nothing renders.
    return PriorityOut(key=p.key, name=p.name, rank=p.rank, icon=p.icon, color=p.color, pulse=p.pulse,
                       is_default=p.is_default, is_active=p.is_active, sla_tier_id=tiers.get(p.key),
                       explicit_count=(counts or {}).get(p.key, 0))


def _get(db: Session, key: str) -> Priority:
    p = db.execute(select(Priority).where(Priority.key == key)).scalar_one_or_none()
    if p is None:
        raise HTTPException(404, f"priority {key!r} not found")
    return p


def _set_global_tier(db: Session, key: str, tier_id: int | None) -> None:
    row = db.execute(select(SlaPriorityTier).where(
        SlaPriorityTier.priority == key, SlaPriorityTier.service_group_id.is_(None))).scalar_one_or_none()
    if tier_id is None:
        if row:
            db.delete(row)
        return
    if db.get(SlaTier, tier_id) is None:
        raise HTTPException(422, "unknown sla_tier_id")
    if row:
        row.sla_tier_id = tier_id
    else:
        db.add(SlaPriorityTier(priority=key, sla_tier_id=tier_id, service_group_id=None))


@router.get("", response_model=list[PriorityOut])
def list_priorities(db: Session = Depends(get_db), _=Depends(get_current_user)):
    tiers = _global_tier_ids(db)
    counts = _explicit_counts(db)
    rows = db.execute(select(Priority).order_by(Priority.rank.desc(), Priority.name)).scalars().all()
    return [_out(p, tiers, counts) for p in rows]


@router.post("", response_model=PriorityOut, status_code=status.HTTP_201_CREATED)
def create_priority(body: PriorityCreate, db: Session = Depends(get_db), _=Depends(get_current_user)):
    base = slugify(body.name); key = base; n = 2
    while db.execute(select(Priority.id).where(Priority.key == key)).scalar_one_or_none():
        # sla_priority_tiers.priority is VARCHAR(20): the suffix must survive
        # the cap, so truncate the base rather than the whole string.
        suffix = f"-{n}"
        key = f"{base[:KEY_MAX - len(suffix)]}{suffix}"; n += 1
    p = Priority(key=key, name=body.name, rank=body.rank, icon=body.icon, color=body.color, pulse=body.pulse)
    db.add(p); db.flush()
    _set_global_tier(db, key, body.sla_tier_id)
    db.commit(); service.invalidate_priority_cache()
    return _out(p, _global_tier_ids(db))


@router.put("/default/{key}", response_model=PriorityOut)
def set_default(key: str, db: Session = Depends(get_db), _=Depends(get_current_user)):
    p = _get(db, key)
    if not p.is_active:
        raise HTTPException(409, "an inactive priority cannot be the default")
    for row in db.execute(select(Priority).where(Priority.is_default)).scalars():
        row.is_default = False
    db.flush(); p.is_default = True
    db.commit(); service.invalidate_priority_cache()
    return _out(p, _global_tier_ids(db))


@router.put("/assign", response_model=AssignOut)
def assign_one(body: AssignIn, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        res = service.assign(db, level=body.level, entity_id=body.id, priority_key=body.priority_key,
                             user_id=getattr(user, "id", None), source="ui", note=body.note)
    except ValueError as e:
        raise HTTPException(422, str(e))
    db.commit()
    return AssignOut(level=res.level, id=res.entity_id, old_key=res.old_key, new_key=res.new_key,
                     affected_sample_pks=res.affected_sample_pks)


@router.put("/assign/bulk", response_model=list[AssignOut])
def assign_bulk(body: BulkAssignIn, db: Session = Depends(get_db), user=Depends(get_current_user)):
    out = []
    try:
        for item in body.items:
            res = service.assign(db, level=item.level, entity_id=item.id, priority_key=item.priority_key,
                                 user_id=getattr(user, "id", None), source="bulk", note=item.note)
            out.append(AssignOut(level=res.level, id=res.entity_id, old_key=res.old_key, new_key=res.new_key,
                                 affected_sample_pks=res.affected_sample_pks))
    except ValueError as e:
        db.rollback(); raise HTTPException(422, str(e))
    db.commit()
    return out


@router.post("/resolve", response_model=ResolveOut)
def resolve(body: ResolveIn, db: Session = Depends(get_db), _=Depends(get_current_user)):
    # Read path: degrade to "no priority known" on a half-migrated DB rather
    # than 500, exactly like every other read that embeds a priority.
    by_s, by_v = service.load_effective_safe(db, sample_pks=body.sample_pks,
                                             sub_sample_pks=body.sub_sample_pks)
    return ResolveOut(samples={str(k): EffectiveOut(**v.as_dict()) for k, v in by_s.items()},
                      sub_samples={str(k): EffectiveOut(**v.as_dict()) for k, v in by_v.items()})


@router.get("/customers", response_model=list[CustomerPriorityOut])
def list_customer_priorities(db: Session = Depends(get_db), _=Depends(get_current_user)):
    rows = db.execute(select(CustomerPriority)).scalars().all()
    ids = [r.wp_customer_user_id for r in rows]
    latest: dict[int, LimsOrder] = {}
    if ids:
        for o in db.execute(select(LimsOrder).where(LimsOrder.customer_user_id.in_(ids))
                            .order_by(LimsOrder.wp_created_at.desc().nullslast())).scalars():
            latest.setdefault(o.customer_user_id, o)
    # Who last touched each row, resolved in ONE query over the ids present.
    user_ids = {r.updated_by for r in rows if r.updated_by is not None}
    names: dict[int, str] = {}
    if user_ids:
        for uid, first, last, email in db.execute(
                select(User.id, User.first_name, User.last_name, User.email).where(User.id.in_(user_ids))):
            full = " ".join(x for x in (first, last) if x)
            names[uid] = full or email
    return [CustomerPriorityOut(
        wp_customer_user_id=r.wp_customer_user_id, priority_key=r.priority_key, note=r.note,
        updated_at=r.updated_at.isoformat() if r.updated_at else None,
        customer_name=getattr(latest.get(r.wp_customer_user_id), "customer_name", None),
        customer_email=getattr(latest.get(r.wp_customer_user_id), "customer_email", None),
        updated_by_name=names.get(r.updated_by) if r.updated_by is not None else None,
    ) for r in rows]


@router.get("/customers/seen", response_model=list[CustomerSeenOut])
def customers_seen(q: str = "", db: Session = Depends(get_db), _=Depends(get_current_user)):
    stmt = (select(LimsOrder.customer_user_id, func.max(LimsOrder.customer_name), func.max(LimsOrder.customer_email),
                   func.max(LimsOrder.wp_created_at))
            .where(LimsOrder.customer_user_id.is_not(None)))
    if q:
        like = f"%{q}%"
        stmt = stmt.where((LimsOrder.customer_name.ilike(like)) | (LimsOrder.customer_email.ilike(like)))
    stmt = stmt.group_by(LimsOrder.customer_user_id).order_by(func.max(LimsOrder.wp_created_at).desc().nullslast()).limit(25)
    return [CustomerSeenOut(wp_customer_user_id=cid, customer_name=n, customer_email=e,
                            last_order_at=t.isoformat() if t else None) for cid, n, e, t in db.execute(stmt)]


@router.patch("/{key}", response_model=PriorityOut)
def patch_priority(key: str, body: PriorityPatch, db: Session = Depends(get_db), _=Depends(get_current_user)):
    p = _get(db, key)
    data = body.model_dump(exclude_unset=True)
    if "sla_tier_id" in data:
        _set_global_tier(db, key, data.pop("sla_tier_id"))
    if data.get("is_active") is False and p.is_default:
        raise HTTPException(409, "the default priority cannot be deactivated")
    for k, v in data.items():
        setattr(p, k, v)
    db.commit(); service.invalidate_priority_cache()
    return _out(p, _global_tier_ids(db))


@router.delete("/{key}")
def deactivate_priority(key: str, db: Session = Depends(get_db), _=Depends(get_current_user)):
    p = _get(db, key)
    if p.is_default:
        raise HTTPException(409, "the default priority cannot be deactivated")
    p.is_active = False
    db.commit(); service.invalidate_priority_cache()
    return {"key": key, "is_active": False}
