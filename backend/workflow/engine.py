"""Side-by-side workflow engine (2026-07-26 spec).

Pure and DB-local: reads lims_samples / lims_analyses / lims_sample_transitions
and the workflow catalog. NO SENAITE reads, NO IS calls — publish success is
attested by the touchpoint. Flush-only helpers; touchpoint wrappers own their
sessions and commits. Imported by the Mk1-originated touchpoints (receive,
publish, analysis cascades) and by the read-only divergence summary endpoint
(pure SELECTs plus a live requirements probe). It never performs SENAITE or
Integration Service I/O.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import (LimsAnalysis, LimsSample, LimsSampleTransition,
                    LimsWorkflowShadowEvaluation, LimsWorkflowState,
                    LimsWorkflowTransition)

log = logging.getLogger(__name__)

_EXCLUDED_LINE_STATES = frozenset({"retracted", "rejected", "cancelled"})
CASCADE_CAP = 10


def shadow_enabled() -> bool:
    """Kill-switch semantics (spec §8): enabled unless explicitly off."""
    return os.environ.get("MK1_WORKFLOW_SHADOW_ENABLED", "1").strip().lower() \
        not in ("0", "false", "no")


def _live_parent_line_states(db: Session, sample: LimsSample) -> dict[str, str]:
    """{keyword: effective_state} for the sample's LIVE parent-tier lines.
    Canonical rows win per keyword over shadow mirrors (read-flip collapse
    rule); shadow rows contribute mirror_review_state. Exception states and
    retest-superseded canonical rows are excluded."""
    rows = db.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == sample.id,
        LimsAnalysis.lims_sub_sample_pk.is_(None),
    )).scalars().all()
    out: dict[str, str] = {}
    shadow: dict[str, str] = {}
    for r in rows:
        if r.provenance == "canonical":
            if r.retested or r.review_state in _EXCLUDED_LINE_STATES:
                continue
            out[r.keyword] = r.review_state
        elif r.provenance == "shadow":
            st = r.mirror_review_state
            if not st or st in _EXCLUDED_LINE_STATES:
                continue
            shadow[r.keyword] = st
    for kw, st in shadow.items():
        out.setdefault(kw, st)
    return out


def _eval_one(db: Session, sample: LimsSample, entry: dict, *,
              actor_user_id: Optional[int],
              attested: Optional[dict]) -> dict:
    kind = entry.get("kind")
    value = entry.get("value")
    met, gates, detail = False, True, None

    if kind == "all_analyses_in_state":
        allowed = {v.strip() for v in (value or "").split(",") if v.strip()}
        states = _live_parent_line_states(db, sample)
        if not states:
            detail = "no live parent analyses"          # empty ∀ = fail-closed
        else:
            off = {kw: st for kw, st in states.items() if st not in allowed}
            met = not off
            if off:
                detail = f"outside {sorted(allowed)}: {off}"
    elif kind == "field_present":
        met = getattr(sample, value or "", None) not in (None, "")
    elif kind == "coa_published":
        met = bool((attested or {}).get("coa_published"))
        detail = None if met else "publish not attested"
    elif kind == "distinct_actor":
        gates = False                                    # dormant (spec §8.2)
        if actor_user_id is None:
            detail = "actor unknown"
        else:
            last = db.execute(
                select(LimsSampleTransition.actor_user_id).where(
                    LimsSampleTransition.lims_sample_pk == sample.id,
                    LimsSampleTransition.verb == value,
                ).order_by(LimsSampleTransition.occurred_at.desc(),
                           LimsSampleTransition.id.desc()).limit(1)
            ).scalar_one_or_none()
            met = last is not None and last != actor_user_id
    elif kind in ("role_at_least", "manual"):
        detail = "not evaluable in shadow v1"
    else:
        detail = "unknown kind"

    return {"kind": kind, "value": value, "met": met, "gates": gates,
            "detail": detail}


def evaluate_requirements(db: Session, sample: LimsSample, entries: list,
                          *, actor_user_id: Optional[int] = None,
                          attested: Optional[dict] = None,
                          ) -> tuple[bool, list[dict]]:
    """(gate_met, outcomes). gate_met = ALL gating outcomes met (non-gating
    kinds — distinct_actor — are recorded but ignored by the gate)."""
    outcomes = [_eval_one(db, sample, e, actor_user_id=actor_user_id,
                          attested=attested)
                for e in (entries or [])]
    gate_met = all(o["met"] for o in outcomes if o["gates"])
    return gate_met, outcomes


def _outcomes_hash(outcomes: list[dict]) -> str:
    return hashlib.md5(json.dumps(outcomes, sort_keys=True,
                                  default=str).encode()).hexdigest()


def _record(db: Session, sample: LimsSample, *, trigger: str,
            verb: Optional[str], from_status: Optional[str],
            to_status: Optional[str], outcome: str,
            requirements_met: Optional[bool], outcomes: list,
            actor_user_id: Optional[int],
            ) -> Optional[LimsWorkflowShadowEvaluation]:
    """Insert one trajectory row (flush-only). Delta-dedup applies to
    REFUSALS only (spec §3.2): identical latest (verb, from_status, outcome,
    outcomes-hash) → skip. Advances and seeds always insert."""
    if outcome in ("requirements_unmet", "no_edge"):
        latest = db.execute(
            select(LimsWorkflowShadowEvaluation).where(
                LimsWorkflowShadowEvaluation.lims_sample_pk == sample.id,
            ).order_by(LimsWorkflowShadowEvaluation.evaluated_at.desc(),
                       LimsWorkflowShadowEvaluation.id.desc()).limit(1)
        ).scalars().first()
        if (latest is not None and latest.verb == verb
                and latest.from_status == from_status
                and latest.outcome == outcome
                and _outcomes_hash(latest.outcomes or []) == _outcomes_hash(outcomes)):
            return None
    row = LimsWorkflowShadowEvaluation(
        lims_sample_pk=sample.id, trigger=trigger, verb=verb,
        from_status=from_status, to_status=to_status, outcome=outcome,
        requirements_met=requirements_met, outcomes=outcomes,
        actor_user_id=actor_user_id)
    db.add(row)
    db.flush()
    return row


def _find_edge(db: Session, from_slug: str, verb: str,
               ) -> Optional[tuple[LimsWorkflowTransition, str]]:
    """(edge, to_slug) for the active sample-scope edge `verb` out of
    `from_slug`, or None. Two aliased joins — native_status stores SLUGS,
    the catalog stores state ids. Also imported by
    `workflow.routes._shadow_summary_payload` for its verb-aware
    SENAITE-action classification (same-package internal use)."""
    from sqlalchemy.orm import aliased
    FromS, ToS = aliased(LimsWorkflowState), aliased(LimsWorkflowState)
    row = db.execute(
        select(LimsWorkflowTransition, ToS.slug)
        .join(FromS, LimsWorkflowTransition.from_state_id == FromS.id)
        .join(ToS, LimsWorkflowTransition.to_state_id == ToS.id)
        .where(LimsWorkflowTransition.entity_scope == "sample",
               LimsWorkflowTransition.is_active,
               LimsWorkflowTransition.verb == verb,
               FromS.slug == from_slug)
        .order_by(LimsWorkflowTransition.sort_order, LimsWorkflowTransition.id)
        .limit(1)
    ).first()
    return (row[0], row[1]) if row else None


def execute_verb(db: Session, sample: LimsSample, verb: str, *, trigger: str,
                 actor_user_id: Optional[int] = None,
                 attested: Optional[dict] = None,
                 ) -> Optional[LimsWorkflowShadowEvaluation]:
    """One native transition attempt. Flush-only; caller commits.
    NULL native_status → None (unseeded; spec §3.1)."""
    if sample.native_status is None:
        return None
    found = _find_edge(db, sample.native_status, verb)
    if found is None:
        return _record(db, sample, trigger=trigger, verb=verb,
                       from_status=sample.native_status,
                       to_status=sample.native_status, outcome="no_edge",
                       requirements_met=None, outcomes=[],
                       actor_user_id=actor_user_id)
    edge, to_slug = found
    met, outcomes = evaluate_requirements(
        db, sample, edge.requirements or [],
        actor_user_id=actor_user_id, attested=attested)
    if not met:
        return _record(db, sample, trigger=trigger, verb=verb,
                       from_status=sample.native_status,
                       to_status=sample.native_status,
                       outcome="requirements_unmet", requirements_met=False,
                       outcomes=outcomes, actor_user_id=actor_user_id)
    frm = sample.native_status
    sample.native_status = to_slug
    db.flush()
    return _record(db, sample, trigger=trigger, verb=verb, from_status=frm,
                   to_status=to_slug, outcome="advanced",
                   requirements_met=True, outcomes=outcomes,
                   actor_user_id=actor_user_id)


def evaluate_cascades(db: Session, sample: LimsSample, *, trigger: str,
                      actor_user_id: Optional[int] = None,
                      ) -> list[LimsWorkflowShadowEvaluation]:
    """Fire auto_fire edges out of native_status until none applies
    (cap CASCADE_CAP). Only edges whose requirements are ALL met fire —
    refusals are NOT recorded here (cascade probing is speculative; recording
    every probe would spam the trajectory). Flush-only."""
    if sample.native_status is None:
        return []
    from sqlalchemy.orm import aliased
    fired: list[LimsWorkflowShadowEvaluation] = []
    for _ in range(CASCADE_CAP):
        FromS = aliased(LimsWorkflowState)
        candidates = db.execute(
            select(LimsWorkflowTransition)
            .join(FromS, LimsWorkflowTransition.from_state_id == FromS.id)
            .where(LimsWorkflowTransition.entity_scope == "sample",
                   LimsWorkflowTransition.is_active,
                   LimsWorkflowTransition.auto_fire,
                   FromS.slug == sample.native_status)
            .order_by(LimsWorkflowTransition.sort_order,
                      LimsWorkflowTransition.id)
        ).scalars().all()
        advanced = None
        for edge in candidates:
            met, _outc = evaluate_requirements(
                db, sample, edge.requirements or [],
                actor_user_id=actor_user_id)
            if met:
                advanced = execute_verb(
                    db, sample, edge.verb, trigger=trigger,
                    actor_user_id=actor_user_id)
                break
        if advanced is None or advanced.outcome != "advanced":
            break
        fired.append(advanced)
    return fired


def run_cascades_bg(sample_pk: int, actor_user_id: Optional[int]) -> None:
    """Own-session, never-raise cascade run — the Task 5 BackgroundTasks
    target. Same hardening pattern as main._record_sample_transition_bg."""
    if not shadow_enabled():
        return
    db = None
    try:
        from database import SessionLocal
        db = SessionLocal()
        # Row lock (finding #2, 2026-07-27): the chokepoint bg session
        # (_record_sample_transition_bg) can interleave with this one on the
        # same sample. Background context only — no user-facing latency
        # impact.
        sample = db.get(LimsSample, sample_pk, with_for_update=True)
        if sample is not None:
            evaluate_cascades(db, sample, trigger="analysis_cascade",
                              actor_user_id=actor_user_id)
            db.commit()
    except Exception:
        log.exception("sbs.run_cascades_bg failed (never-raise)")
        if db is not None:
            db.rollback()
    finally:
        if db is not None:
            db.close()
