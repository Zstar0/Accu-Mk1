"""Admin CRUD + read-only graph API for the workflow catalog (phase-out
slice 3).

Edits touch CATALOG rows only (documentation while SENAITE is authority) —
no live sample/analysis state is ever read from or written through here.
Guardrails are fail-loud (409/422, spec §9.4); routes own their commits
(flags routes convention).

Auth split: the router-level gate is `get_current_user` (any authenticated
user) — GET /graph exposes only the catalog + usage counts, no secrets, and
is the designed read-only view for non-admins (the Workflow nav item is
visible to everyone). Every mutating route (POST/PATCH/DELETE) additionally
requires `require_admin` via a per-route `dependencies=` override.
"""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from auth import get_current_user, require_admin
from database import get_db
from models import LimsWorkflowState, LimsWorkflowTransition
from workflow.catalog import graph_payload, usage_counts, validate_requirements

router = APIRouter(prefix="/api/workflow", tags=["workflow"],
                   dependencies=[Depends(get_current_user)])

Scope = Literal["sample", "analysis"]
Category = Literal["active", "terminal", "exception"]


# ── request bodies ───────────────────────────────────────────────────────

class StateCreate(BaseModel):
    entity_scope: Scope
    slug: str = Field(min_length=1, max_length=100)
    label: str = Field(min_length=1)
    description: Optional[str] = None
    category: Category = "active"
    color: Optional[str] = None
    sort_order: int = 0
    is_active: bool = True


class StateUpdate(BaseModel):
    # slug/entity_scope immutable by omission (unknown body keys are ignored).
    label: Optional[str] = Field(default=None, min_length=1)
    description: Optional[str] = None
    category: Optional[Category] = None
    color: Optional[str] = None
    sort_order: Optional[int] = None
    is_active: Optional[bool] = None


class TransitionCreate(BaseModel):
    # entity_scope is derived from the endpoint states, never client-supplied.
    from_state_id: int
    to_state_id: int
    verb: str = Field(min_length=1, max_length=100)
    label: Optional[str] = None
    description: Optional[str] = None
    requirements: list = Field(default_factory=list)
    sort_order: int = 0
    is_active: bool = True


class TransitionUpdate(BaseModel):
    # entity_scope immutable by omission; endpoints may move within the scope.
    from_state_id: Optional[int] = None
    to_state_id: Optional[int] = None
    verb: Optional[str] = Field(default=None, min_length=1, max_length=100)
    label: Optional[str] = None
    description: Optional[str] = None
    requirements: Optional[list] = None
    sort_order: Optional[int] = None
    is_active: Optional[bool] = None


# ── serializers (match graph_payload entry shape) ────────────────────────

def _state_out(s: LimsWorkflowState, usage_count: int = 0) -> dict:
    return {
        "id": s.id, "slug": s.slug, "label": s.label,
        "description": s.description, "category": s.category,
        "color": s.color, "sort_order": s.sort_order,
        "is_builtin": s.is_builtin, "is_active": s.is_active,
        "usage_count": usage_count,
    }


def _transition_out(t: LimsWorkflowTransition) -> dict:
    return {
        "id": t.id, "from_state_id": t.from_state_id,
        "to_state_id": t.to_state_id, "verb": t.verb, "label": t.label,
        "description": t.description, "requirements": t.requirements,
        "is_builtin": t.is_builtin, "is_active": t.is_active,
    }


def _clean_requirements(entries) -> list:
    try:
        return validate_requirements(entries)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


def _reject_null_for(non_nullable: frozenset, data: dict) -> None:
    """Explicit JSON nulls on non-nullable columns fail loud (422), not as a
    DB NOT NULL violation (500). Pydantic's Optional[...] update fields let
    null through — this is the backstop."""
    for k in non_nullable & data.keys():
        if data[k] is None:
            raise HTTPException(status_code=422,
                                detail=f"{k} cannot be null")


_STATE_NON_NULLABLE = frozenset({"label", "category", "sort_order", "is_active"})
_TRANSITION_NON_NULLABLE = frozenset({"from_state_id", "to_state_id", "verb",
                                      "requirements", "sort_order", "is_active"})


# ── graph ────────────────────────────────────────────────────────────────

@router.get("/graph")
def get_graph(scope: Scope = Query(...), db: Session = Depends(get_db)):
    return graph_payload(db, scope)


# ── states ───────────────────────────────────────────────────────────────

@router.post("/states", dependencies=[Depends(require_admin)])
def create_state(body: StateCreate, db: Session = Depends(get_db)):
    dup = (db.query(LimsWorkflowState)
           .filter_by(entity_scope=body.entity_scope, slug=body.slug)
           .one_or_none())
    if dup is not None:
        raise HTTPException(
            status_code=409,
            detail=f"state '{body.slug}' already exists in scope "
                   f"'{body.entity_scope}'")
    row = LimsWorkflowState(**body.model_dump(), is_builtin=False)
    db.add(row)
    db.commit()
    db.refresh(row)
    return _state_out(row)


@router.patch("/states/{state_id}", dependencies=[Depends(require_admin)])
def update_state(state_id: int, body: StateUpdate,
                 db: Session = Depends(get_db)):
    row = db.get(LimsWorkflowState, state_id)
    if row is None:
        raise HTTPException(status_code=404, detail="state not found")
    data = body.model_dump(exclude_unset=True)
    _reject_null_for(_STATE_NON_NULLABLE, data)
    for k, v in data.items():
        setattr(row, k, v)
    db.commit()
    db.refresh(row)
    return _state_out(row, usage_counts(db, row.entity_scope).get(row.slug, 0))


@router.delete("/states/{state_id}", status_code=204,
              dependencies=[Depends(require_admin)])
def delete_state(state_id: int, db: Session = Depends(get_db)):
    row = db.get(LimsWorkflowState, state_id)
    if row is None:
        raise HTTPException(status_code=404, detail="state not found")
    if row.is_builtin:
        raise HTTPException(
            status_code=409,
            detail="built-in state cannot be deleted — deactivate instead")
    usage = usage_counts(db, row.entity_scope).get(row.slug, 0)
    if usage:
        raise HTTPException(
            status_code=409,
            detail=f"state '{row.slug}' has {usage} live row(s) — "
                   "deactivate instead")
    refs = (db.query(LimsWorkflowTransition)
            .filter(or_(LimsWorkflowTransition.from_state_id == row.id,
                        LimsWorkflowTransition.to_state_id == row.id))
            .count())
    if refs:
        raise HTTPException(
            status_code=409,
            detail=f"{refs} transition(s) reference state '{row.slug}' — "
                   "remove them or deactivate instead")
    db.delete(row)
    db.commit()


# ── transitions ──────────────────────────────────────────────────────────

@router.post("/transitions", dependencies=[Depends(require_admin)])
def create_transition(body: TransitionCreate, db: Session = Depends(get_db)):
    frm = db.get(LimsWorkflowState, body.from_state_id)
    to = db.get(LimsWorkflowState, body.to_state_id)
    if frm is None or to is None:
        raise HTTPException(status_code=422,
                            detail="from/to state does not exist")
    if frm.entity_scope != to.entity_scope:
        raise HTTPException(
            status_code=422,
            detail=f"cross-scope edge rejected: '{frm.slug}' is "
                   f"{frm.entity_scope}-scope, '{to.slug}' is "
                   f"{to.entity_scope}-scope")
    reqs = _clean_requirements(body.requirements)
    dup = (db.query(LimsWorkflowTransition)
           .filter_by(entity_scope=frm.entity_scope,
                      from_state_id=frm.id, verb=body.verb)
           .one_or_none())
    if dup is not None:
        raise HTTPException(
            status_code=409,
            detail=f"transition '{body.verb}' from '{frm.slug}' already exists")
    row = LimsWorkflowTransition(
        entity_scope=frm.entity_scope, from_state_id=frm.id, to_state_id=to.id,
        verb=body.verb, label=body.label, description=body.description,
        requirements=reqs, sort_order=body.sort_order,
        is_active=body.is_active, is_builtin=False)
    db.add(row)
    db.commit()
    db.refresh(row)
    return _transition_out(row)


@router.patch("/transitions/{transition_id}",
             dependencies=[Depends(require_admin)])
def update_transition(transition_id: int, body: TransitionUpdate,
                      db: Session = Depends(get_db)):
    row = db.get(LimsWorkflowTransition, transition_id)
    if row is None:
        raise HTTPException(status_code=404, detail="transition not found")
    data = body.model_dump(exclude_unset=True)
    _reject_null_for(_TRANSITION_NON_NULLABLE, data)

    # Resolve the post-patch endpoints; both must exist and stay inside the
    # transition's (immutable) scope.
    frm = (db.get(LimsWorkflowState, data["from_state_id"])
           if "from_state_id" in data
           else db.get(LimsWorkflowState, row.from_state_id))
    to = (db.get(LimsWorkflowState, data["to_state_id"])
          if "to_state_id" in data
          else db.get(LimsWorkflowState, row.to_state_id))
    if frm is None or to is None:
        raise HTTPException(status_code=422,
                            detail="from/to state does not exist")
    if frm.entity_scope != row.entity_scope or to.entity_scope != row.entity_scope:
        raise HTTPException(
            status_code=422,
            detail=f"cross-scope edge rejected: transition is "
                   f"{row.entity_scope}-scope")

    if "requirements" in data:
        data["requirements"] = _clean_requirements(data["requirements"])

    new_verb = data.get("verb", row.verb)
    if new_verb != row.verb or frm.id != row.from_state_id:
        dup = (db.query(LimsWorkflowTransition)
               .filter_by(entity_scope=row.entity_scope,
                          from_state_id=frm.id, verb=new_verb)
               .filter(LimsWorkflowTransition.id != row.id)
               .one_or_none())
        if dup is not None:
            raise HTTPException(
                status_code=409,
                detail=f"transition '{new_verb}' from '{frm.slug}' "
                       "already exists")

    for k, v in data.items():
        setattr(row, k, v)
    db.commit()
    db.refresh(row)
    return _transition_out(row)


@router.delete("/transitions/{transition_id}", status_code=204,
              dependencies=[Depends(require_admin)])
def delete_transition(transition_id: int, db: Session = Depends(get_db)):
    row = db.get(LimsWorkflowTransition, transition_id)
    if row is None:
        raise HTTPException(status_code=404, detail="transition not found")
    if row.is_builtin:
        raise HTTPException(
            status_code=409,
            detail="built-in transition cannot be deleted — deactivate instead")
    db.delete(row)
    db.commit()


# ── shadow summary (Task 7 — flip-readiness report) ─────────────────────

def _shadow_summary_payload(db: Session, since) -> dict:
    """Side-by-side divergence report (2026-07-26 spec §6.1, live-probe
    amendment 2026-07-26). Core is a two-column comparison (status vs.
    native_status); the latest trajectory row supplies the WHY for anything
    that disagrees.

    `since` scopes ONLY the latest-shadow-row lookup used to explain an
    already-divergent sample — `total_seeded` and the `agree` count are
    always computed over the full population, unfiltered. This makes bucket
    labels WINDOW-RELATIVE, not immutable history: if `since` excludes the
    row that actually blocked the sample (its real refusal/no_edge is older
    than the cutoff), the WHY is re-derived from CURRENT state instead —
    either a fresh live probe (which may find a different, unrelated unmet
    auto edge and report `mk1_refused`/`live_probe_unmet` for a reason that
    isn't what actually blocked it) or, if no auto edge applies,
    `no_native_pathway` (masking a real historical refusal). Callers wanting
    the TRUE original blocker for a sample must pass `since=None` for that
    sample, or treat a `since`-scoped bucket as "reason as of now", not
    "reason it diverged".

    Live probe (amendment): a divergent sample whose latest shadow row is
    not itself a refusal (`requirements_unmet` / `no_edge`) would otherwise
    fall straight to `no_native_pathway` — but `evaluate_cascades` (Task 3)
    records NO refusal row for an auto_fire edge that simply never fired
    (cascade probing is speculative), so a sample whose auto-edge
    requirements are merely unmet looks identical to a true pathway gap.
    Before accepting `no_native_pathway`, re-evaluate every active
    sample-scope `auto_fire` edge out of `native_status` — same
    aliased-slug-join candidate query as `workflow.engine.evaluate_cascades`
    (only the FROM state needs resolving; the destination is irrelevant
    here) — via `workflow.engine.evaluate_requirements`, which is pure
    SELECTs and never writes. If ANY such edge is unmet, bucket =
    `mk1_refused` with a synthetic `latest_outcome = "live_probe_unmet"`
    (a payload-only value — deliberately NOT part of
    LimsWorkflowShadowEvaluation's persisted outcome vocabulary and never
    written to that table) and `latest_verb`/`unmet` taken from the first
    unmet edge in (sort_order, id) order. Otherwise `no_native_pathway`
    stands (true no-edge gaps, plus the rare met-but-not-yet-triggered
    transient, which self-heals at the next touchpoint). The probe runs
    ONLY for divergent samples reaching this branch — never the `agree`
    set — so cost stays proportional to divergence.
    """
    from sqlalchemy.orm import aliased

    from models import LimsSample, LimsWorkflowShadowEvaluation as Ev
    from workflow.engine import evaluate_requirements

    samples = db.execute(
        select(LimsSample).where(LimsSample.native_status.isnot(None))
    ).scalars().all()
    buckets = {"agree": 0, "mk1_refused": 0,
               "no_native_pathway": 0, "stuck_behind": 0}
    divergent = []
    for s in samples:
        if s.native_status == s.status:
            buckets["agree"] += 1
            continue
        q = select(Ev).where(Ev.lims_sample_pk == s.id)
        if since is not None:
            q = q.where(Ev.evaluated_at >= since)
        latest = db.execute(
            q.order_by(Ev.evaluated_at.desc(), Ev.id.desc()).limit(1)
        ).scalars().first()
        outcome = latest.outcome if latest else None
        latest_verb = latest.verb if latest else None
        unmet = ([o for o in (latest.outcomes or []) if not o.get("met")]
                 if latest else [])

        if outcome == "requirements_unmet":
            bucket = "mk1_refused"
        elif outcome == "no_edge":
            bucket = "stuck_behind"
        else:
            bucket = "no_native_pathway"
            FromS = aliased(LimsWorkflowState)
            candidates = db.execute(
                select(LimsWorkflowTransition)
                .join(FromS, LimsWorkflowTransition.from_state_id == FromS.id)
                .where(LimsWorkflowTransition.entity_scope == "sample",
                       LimsWorkflowTransition.is_active,
                       LimsWorkflowTransition.auto_fire,
                       FromS.slug == s.native_status)
                .order_by(LimsWorkflowTransition.sort_order,
                          LimsWorkflowTransition.id)
            ).scalars().all()
            for edge in candidates:
                gate_met, edge_outcomes = evaluate_requirements(
                    db, s, edge.requirements or [])
                if not gate_met:
                    bucket = "mk1_refused"
                    outcome = "live_probe_unmet"
                    latest_verb = edge.verb
                    unmet = [o for o in edge_outcomes if not o.get("met")]
                    break

        buckets[bucket] += 1
        if len(divergent) < 200:
            divergent.append({
                "sample_id": s.sample_id, "status": s.status,
                "native_status": s.native_status, "bucket": bucket,
                "latest_outcome": outcome, "latest_verb": latest_verb,
                "unmet": unmet,
            })
    return {"total_seeded": len(samples), "buckets": buckets,
            "divergent": divergent}


@router.get("/shadow/summary", dependencies=[Depends(require_admin)])
def shadow_summary(since: Optional[str] = Query(default=None),
                   db: Session = Depends(get_db)):
    """Flip-readiness report: agree / mk1_refused / no_native_pathway /
    stuck_behind over seeded samples (spec §6.1, live-probe amendment
    2026-07-26 — see `_shadow_summary_payload`)."""
    from datetime import datetime as _dt
    parsed = None
    if since is not None:
        try:
            parsed = _dt.fromisoformat(since)
        except ValueError:
            raise HTTPException(
                status_code=422,
                detail=f"invalid since (expected ISO 8601): {since!r}")
    return _shadow_summary_payload(db, since=parsed)
