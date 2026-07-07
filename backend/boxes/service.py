import re
from datetime import datetime
from typing import List

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models import LimsBox, LimsSample, LimsSubSample, LimsSubSampleEvent

BOXABLE_ROLES = {"hplc", "endo", "ster", "xtra"}


def box_label_code(box: LimsBox) -> str:
    """Physical box name: 'BOX-<order#>-<n>'. Strips a leading 'WP-' from the
    order key so it reads 'BOX-3267-1' (not 'BOX-WP-3267-1'); order-less
    receives (order_key is a parent sample id) read 'BOX-P-0141-1'."""
    key = re.sub(r"^WP-", "", box.order_key, flags=re.IGNORECASE)
    return f"BOX-{key}-{box.box_number}"


def _log_box_event(db: Session, sub_sample_pk: int, event: str, details: dict, user_id) -> None:
    db.add(LimsSubSampleEvent(sub_sample_pk=sub_sample_pk, event=event, details=details, user_id=user_id))


def _box_labels(db: Session, box_ids: List[int]) -> dict:
    """box_id -> label_code for the given ids (skips None)."""
    ids = [b for b in set(box_ids) if b is not None]
    if not ids:
        return {}
    boxes = db.scalars(select(LimsBox).where(LimsBox.id.in_(ids))).all()
    return {b.id: box_label_code(b) for b in boxes}


def vial_count(db: Session, box_id: int) -> int:
    return db.scalar(
        select(func.count()).select_from(LimsSubSample).where(LimsSubSample.box_id == box_id)
    ) or 0


def vials_for_boxes(db: Session, box_ids: List[int]) -> dict:
    """Map box_id -> [{sample_id, parent_sample_id, assignment_role, vial_sequence}] for the given boxes."""
    if not box_ids:
        return {}
    rows = db.execute(
        select(
            LimsSubSample.box_id,
            LimsSubSample.sample_id,
            LimsSubSample.assignment_role,
            LimsSubSample.vial_sequence,
            LimsSample.sample_id.label("parent_sample_id"),
        )
        .join(LimsSample, LimsSample.id == LimsSubSample.parent_sample_pk)
        .where(LimsSubSample.box_id.in_(box_ids))
        .order_by(LimsSubSample.sample_id)
    ).all()
    out: dict = {}
    for r in rows:
        out.setdefault(r.box_id, []).append({
            "sample_id": r.sample_id,
            "parent_sample_id": r.parent_sample_id,
            "assignment_role": r.assignment_role,
            "vial_sequence": r.vial_sequence,
        })
    return out


def next_box(db: Session, order_key: str, role: str, user_id: int) -> LimsBox:
    if role not in BOXABLE_ROLES:
        raise ValueError(f"role {role!r} is not boxable")
    # Concurrent creates for one order race on uq_lims_box_order_number:
    # recompute max+1 and retry a few times before giving up.
    for _ in range(5):
        current_max = db.scalar(
            select(func.max(LimsBox.box_number)).where(LimsBox.order_key == order_key)
        )
        box = LimsBox(
            order_key=order_key,
            box_number=(current_max or 0) + 1,
            role=role,
            created_by_user_id=user_id,
        )
        db.add(box)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            continue
        db.refresh(box)
        return box
    raise ValueError(f"could not allocate a box number for order {order_key!r} (concurrent creates)")


def assign_vials(db: Session, box_id: int, sub_sample_ids: List[str], user_id=None) -> LimsBox:
    box = db.get(LimsBox, box_id)
    if box is None:
        raise LookupError(f"box {box_id} not found")
    if box.stored_at is not None:
        # No surface lists stored boxes, so a vial assigned here would be orphaned.
        raise ValueError(f"box {box_id} is closed/stored")
    subs = db.scalars(
        select(LimsSubSample).where(LimsSubSample.sample_id.in_(sub_sample_ids))
    ).all()
    found = {s.sample_id for s in subs}
    missing = set(sub_sample_ids) - found
    if missing:
        raise LookupError(f"sub-samples not found: {sorted(missing)}")
    for s in subs:
        if s.assignment_role != box.role:
            raise ValueError(
                f"vial {s.sample_id} role {s.assignment_role!r} != box role {box.role!r}"
            )
    to_label = box_label_code(box)
    prior_labels = _box_labels(db, [s.box_id for s in subs])
    for s in subs:
        prior = s.box_id
        s.box_id = box.id
        if prior is None:
            _log_box_event(
                db, s.id, "box_assigned",
                {"box_id": box.id, "box_label": to_label}, user_id,
            )
        elif prior != box.id:
            _log_box_event(
                db, s.id, "box_moved",
                {
                    "from_box_id": prior,
                    "from_box_label": prior_labels.get(prior),
                    "to_box_id": box.id,
                    "to_box_label": to_label,
                },
                user_id,
            )
    db.commit()
    db.refresh(box)
    return box


def unassign_vials(db: Session, sub_sample_ids: List[str], user_id=None) -> int:
    """Clear box membership (box_id = None) for the given sub-samples. Mirrors
    how `assign_vials` selects rows. Idempotent: unassigning an already-unboxed
    vial is a no-op. Returns the number of rows that were updated."""
    subs = db.scalars(
        select(LimsSubSample).where(LimsSubSample.sample_id.in_(sub_sample_ids))
    ).all()
    prior_labels = _box_labels(db, [s.box_id for s in subs])
    for s in subs:
        if s.box_id is not None:
            _log_box_event(
                db, s.id, "box_removed",
                {"box_id": s.box_id, "box_label": prior_labels.get(s.box_id)}, user_id,
            )
        s.box_id = None
    db.commit()
    return len(subs)


def mark_printed(db: Session, box_id: int, user_id: int) -> LimsBox:
    box = db.get(LimsBox, box_id)
    if box is None:
        raise LookupError(f"box {box_id} not found")
    box.printed_at = datetime.utcnow()
    box.printed_by_user_id = user_id
    db.commit()
    db.refresh(box)
    return box


def delete_box(db: Session, box_id: int, user_id=None) -> None:
    """Delete a box, returning any still-assigned vials to Unboxed (box_id=None).
    Non-destructive: clearing box_id mirrors unassign_vials (the FK is ON DELETE
    SET NULL anyway). Raises LookupError if the box is missing."""
    box = db.get(LimsBox, box_id)
    if box is None:
        raise LookupError(f"box {box_id} not found")
    label = box_label_code(box)
    subs = db.scalars(select(LimsSubSample).where(LimsSubSample.box_id == box_id)).all()
    for s in subs:
        _log_box_event(
            db, s.id, "box_removed",
            {"box_id": box_id, "box_label": label, "reason": "box_deleted"}, user_id,
        )
    db.execute(
        update(LimsSubSample).where(LimsSubSample.box_id == box_id).values(box_id=None)
    )
    db.delete(box)
    db.commit()


def close_box(db: Session, box_id: int, user_id: int) -> LimsBox:
    """Close out a box: return all its vials to Unboxed and stamp stored_at.

    The normal end-of-life path — unlike delete_box (the mistake path) it keeps
    the box row as a record. Idempotent: closing an already-stored box is a
    no-op (first closer's stamp wins). Raises LookupError if the box is missing.
    """
    box = db.get(LimsBox, box_id)
    if box is None:
        raise LookupError(f"box {box_id} not found")
    if box.stored_at is None:
        label = box_label_code(box)
        subs = db.scalars(select(LimsSubSample).where(LimsSubSample.box_id == box_id)).all()
        for s in subs:
            _log_box_event(
                db, s.id, "box_removed",
                {"box_id": box_id, "box_label": label, "reason": "stored"}, user_id,
            )
        db.execute(
            update(LimsSubSample).where(LimsSubSample.box_id == box_id).values(box_id=None)
        )
        box.stored_at = datetime.utcnow()
        box.stored_by_user_id = user_id
        db.commit()
    db.refresh(box)
    return box


def list_active(db: Session) -> List[LimsBox]:
    """All boxes not yet closed out to storage, oldest first (Active Boxes page)."""
    return list(
        db.scalars(
            select(LimsBox).where(LimsBox.stored_at.is_(None)).order_by(LimsBox.created_at, LimsBox.id)
        )
    )


def list_for_order(db: Session, order_key: str) -> List[LimsBox]:
    return list(
        db.scalars(
            select(LimsBox)
            .where(LimsBox.order_key == order_key, LimsBox.stored_at.is_(None))
            .order_by(LimsBox.box_number)
        ).all()
    )
