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
    amendment 2026-07-26; `mk1_ahead` bucket added 2026-07-27, finding #3).
    Core is a two-column comparison (status vs. native_status); the latest
    trajectory row supplies the WHY for anything that disagrees. Buckets:
    `agree` / `mk1_refused` / `stuck_behind` / `mk1_ahead` (Mk1's native
    trajectory has advanced past SENAITE's status) / `no_native_pathway`.

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

    Live probe / verb-aware fallthrough (amendment 2026-07-26, made
    verb-aware 2026-07-27 per a UAT finding): a divergent sample whose
    latest shadow row is not itself a refusal (`requirements_unmet` /
    `no_edge`) would otherwise fall straight to `no_native_pathway`.
    `no_native_pathway` means "SENAITE acted where Mk1 has no trigger or no
    edge" — so before accepting it, find out WHAT SENAITE actually did:

    - Look up the sample's latest `lims_sample_transitions` row with
      `source='senaite'`. If one exists with a non-null `verb`, resolve the
      catalog edge for THAT verb out of `native_status` via
      `workflow.engine._find_edge` (any active edge, not just `auto_fire` —
      this is asking "could Mk1 have done what SENAITE just did", not
      probing speculative cascade candidates).
        - No edge for that verb → `no_native_pathway` stands (catalog gap:
          Mk1 has no notion of this verb from this state at all).
        - Edge exists, `evaluate_requirements` UNMET → `mk1_refused` with
          `latest_outcome='live_probe_unmet'`, `latest_verb` = that verb,
          `unmet` = that edge's unmet outcomes (Mk1 would have refused what
          SENAITE did — a genuine rule-miscalibration signal).
        - Edge exists, MET → `no_native_pathway` stands: Mk1 HAD the
          pathway and would have allowed it, so what's missing is a
          TRIGGER (Mk1 can't originate this verb yet), not a rule — this is
          exactly the "burn-in punch-list" signal the report exists to
          surface (see `project_native_verb_origination_punchlist`).
    - No SENAITE-sourced transition (or its `verb` is null) → fall back to
      the original transient-cascade-stall detector, unchanged: re-evaluate
      every active sample-scope `auto_fire` edge out of `native_status` —
      same aliased-slug-join candidate query as
      `workflow.engine.evaluate_cascades` (only the FROM state needs
      resolving; the destination is irrelevant here) — via
      `workflow.engine.evaluate_requirements`, which is pure SELECTs and
      never writes. `evaluate_cascades` (Task 3) records NO refusal row for
      an auto_fire edge that simply never fired (cascade probing is
      speculative), so this catches the case where a sample's auto-edge
      requirements are merely unmet but nothing has explicitly logged that
      yet. If ANY such edge is unmet, bucket = `mk1_refused` with
      `latest_outcome='live_probe_unmet'` and `latest_verb`/`unmet` taken
      from the first unmet edge in (sort_order, id) order; otherwise
      `no_native_pathway` stands (the rare met-but-not-yet-triggered
      transient, which self-heals at the next touchpoint).

    Either probe path runs ONLY for divergent samples reaching this
    branch — never the `agree` set — so cost stays proportional to
    divergence.
    """
    from sqlalchemy.orm import aliased

    from models import (LimsSample, LimsSampleTransition,
                        LimsWorkflowShadowEvaluation as Ev)
    from workflow.engine import _find_edge, evaluate_requirements

    samples = db.execute(
        select(LimsSample).where(LimsSample.native_status.isnot(None))
        .order_by(LimsSample.sample_id)
    ).scalars().all()
    buckets = {"agree": 0, "mk1_refused": 0, "no_native_pathway": 0,
               "stuck_behind": 0, "mk1_ahead": 0}
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
        elif outcome == "advanced":
            # Mk1 successfully advanced native_status past what SENAITE's
            # status reflects (finding #3) — this is progress, not a gap or
            # refusal, and must not fall into the live-probe branch below.
            bucket = "mk1_ahead"
        else:
            bucket = "no_native_pathway"
            # Verb-aware classification (2026-07-27, UAT cancel finding):
            # if SENAITE is what actually moved this sample, find out WHAT
            # it did and probe THAT edge — not an unrelated auto_fire
            # candidate. Without this, a sample sitting in sample_received
            # that SENAITE cancelled directly got misreported as
            # mk1_refused against the unrelated auto submit edge, which
            # systematically undercounts no_native_pathway (this report's
            # whole purpose) for any state that happens to have an
            # auto_fire edge.
            senaite_txn = db.execute(
                select(LimsSampleTransition)
                .where(LimsSampleTransition.lims_sample_pk == s.id,
                       LimsSampleTransition.source == "senaite")
                .order_by(LimsSampleTransition.occurred_at.desc(),
                          LimsSampleTransition.id.desc())
                .limit(1)
            ).scalars().first()
            if senaite_txn is not None and senaite_txn.verb is not None:
                found = _find_edge(db, s.native_status, senaite_txn.verb)
                if found is not None:
                    edge, _to_slug = found
                    gate_met, edge_outcomes = evaluate_requirements(
                        db, s, edge.requirements or [])
                    if not gate_met:
                        # Mk1 would have refused what SENAITE did — a
                        # genuine rule-miscalibration signal.
                        bucket = "mk1_refused"
                        outcome = "live_probe_unmet"
                        latest_verb = senaite_txn.verb
                        unmet = [o for o in edge_outcomes if not o.get("met")]
                    else:
                        # Mk1 HAD the pathway and would have allowed it —
                        # what's missing is a trigger, not a rule. Stays
                        # no_native_pathway, but the row still names the
                        # verb SENAITE used: this bucket exists to
                        # enumerate which verbs lack a Mk1 trigger, and an
                        # operator can't see that without it.
                        latest_verb = senaite_txn.verb
                else:
                    # No catalog edge for this verb at all — catalog gap.
                    # Stays no_native_pathway; still name the verb for the
                    # same punch-list-enumeration reason as above.
                    latest_verb = senaite_txn.verb
            else:
                # No SENAITE-sourced transition to explain the divergence
                # (or its verb is null) — fall back to the original
                # transient-cascade-stall detector: probe every active
                # auto_fire edge out of native_status for one that's simply
                # unmet but never fired (evaluate_cascades records no
                # refusal for those; speculative probing would spam the
                # trajectory).
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
    stuck_behind / mk1_ahead over seeded samples (spec §6.1, live-probe
    amendment 2026-07-26 — see `_shadow_summary_payload`)."""
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
