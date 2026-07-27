"""Side-by-side workflow engine (2026-07-26 spec).

Pure and DB-local: reads lims_samples / lims_analyses / lims_sample_transitions
and the workflow catalog. NO SENAITE reads, NO IS calls — publish success is
attested by the touchpoint. Flush-only helpers; touchpoint wrappers own their
sessions and commits. Never imported by any read path.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import datetime
from typing import Any, Optional

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
