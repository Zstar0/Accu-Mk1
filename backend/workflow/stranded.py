# backend/workflow/stranded.py
"""Stranded-sample detector (spec §6.2). Read-only over samples; its only
writes are flags. Never advances a status — a stranded sample is a bug to
find and fix at the root (Handler ruling 2026-09-09)."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from flags import catalog as flag_catalog
from flags import seams as flag_seams
from flags import service as flag_service
from flags.models import FlagEntityLink, FlagFlag
from models import (LimsSample, LimsSampleTransition, LimsSenaiteTeeRetry,
                    LimsWorkflowShadowEvaluation, User)
from workflow.authority import sample_status_authority
from workflow.engine import _live_parent_line_states

log = logging.getLogger(__name__)

FLAG_TYPE = "workflow_stranded"
_BEHIND_VERIFIED = frozenset({"sample_registered", "sample_due", "sample_received",
                              "ready_for_initial_review", "waiting_for_addon_results",
                              "to_be_verified"})


@dataclass
class Stranded:
    sample: LimsSample
    condition: str
    diagnosis: str


def _recent_samples(db: Session, since_days: int) -> list[LimsSample]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=since_days)
    return db.execute(
        select(LimsSample).where(LimsSample.date_received >= cutoff)
    ).scalars().all()


def _diagnosis(db: Session, sample: LimsSample, condition: str) -> str:
    last_eval = db.execute(
        select(LimsWorkflowShadowEvaluation).where(
            LimsWorkflowShadowEvaluation.lims_sample_pk == sample.id,
            LimsWorkflowShadowEvaluation.outcome != "advanced",
        ).order_by(LimsWorkflowShadowEvaluation.id.desc()).limit(1)
    ).scalars().first()
    log_rows = db.execute(
        select(LimsSampleTransition).where(
            LimsSampleTransition.lims_sample_pk == sample.id
        ).order_by(LimsSampleTransition.occurred_at.desc()).limit(3)
    ).scalars().all()
    lines = [f"Condition: {condition}",
             f"status={sample.status!r} native_status={sample.native_status!r}"]
    if last_eval is not None:
        lines.append(f"Last cascade refusal: verb={last_eval.verb} outcome={last_eval.outcome} "
                     f"outcomes={last_eval.outcomes}")
    for r in log_rows:
        lines.append(f"log: {r.occurred_at:%Y-%m-%d %H:%M} {r.source} {r.verb} "
                     f"{r.from_status}->{r.to_status}")
    return "\n".join(lines)


def find_stranded(db: Session, *, since_days: int = 90) -> list[Stranded]:
    mk1 = sample_status_authority(db) == "mk1"
    gave_up_pks = set(db.execute(
        select(LimsSenaiteTeeRetry.lims_sample_pk).where(LimsSenaiteTeeRetry.status == "gave_up")
    ).scalars().all())
    published_pks = set(db.execute(
        select(LimsSampleTransition.lims_sample_pk).where(
            LimsSampleTransition.verb == "publish", LimsSampleTransition.source == "mk1")
    ).scalars().all())
    out: list[Stranded] = []
    for s in _recent_samples(db, since_days):
        condition: Optional[str] = None
        if s.status in _BEHIND_VERIFIED:
            states = _live_parent_line_states(db, s)
            if states and all(v == "verified" for v in states.values()):
                condition = "lines_verified_status_behind"
        if condition is None and s.id in published_pks and s.status != "published":
            condition = "published_in_ledger_not_status"
        if condition is None and mk1 and s.native_status and s.native_status != s.status:
            condition = "native_mirror_disagree"
        if condition is None and s.id in gave_up_pks:
            condition = "senaite_tee_gave_up"
        if condition is not None:
            out.append(Stranded(sample=s, condition=condition,
                                diagnosis=_diagnosis(db, s, condition)))
    return out


def _actor(db: Session):
    admin = db.execute(
        select(User).where(User.role == "admin").order_by(User.id).limit(1)
    ).scalars().first()
    return None if admin is None else SimpleNamespace(id=admin.id, role="admin")


def _open_flag_for(db: Session, sample_id: str) -> Optional[FlagFlag]:
    return db.execute(
        select(FlagFlag).join(FlagEntityLink, FlagEntityLink.flag_id == FlagFlag.id).where(
            FlagFlag.type == FLAG_TYPE,
            FlagFlag.status.in_(flag_catalog.OPEN_STATES),
            FlagEntityLink.entity_type == "sample",
            FlagEntityLink.entity_id == sample_id,
        ).order_by(FlagFlag.id.desc()).limit(1)
    ).scalars().first()


def run_check(db: Session, *, now: Optional[datetime] = None, since_days: int = 90) -> dict:
    """Scheduler job body (`workflow_stranded_check`, every 15 min)."""
    # `register_mk1_entities()` populates the module-level entity registry
    # that `flag_service.create_flag(..., entity_type="sample", ...)` below
    # depends on. main.py calls it once at app startup, but this job also
    # runs from tests that import workflow.stranded directly without going
    # through that lifespan — so call it here too, scoped to the one path
    # that needs it. `register_entity` is a plain dict assignment with no
    # side effects beyond that, so a repeat call is a harmless no-op.
    flag_seams.register_mk1_entities()
    stats = {"flagged": 0, "resolved": 0, "skipped_no_actor": 0, "errors": 0}
    actor = _actor(db)
    stranded = find_stranded(db, since_days=since_days)
    stranded_ids = {s.sample.sample_id for s in stranded}
    if actor is None:
        stats["skipped_no_actor"] = len(stranded)
        return stats
    for s in stranded:
        try:
            if _open_flag_for(db, s.sample.sample_id) is not None:
                continue
            flag = flag_service.create_flag(
                db, user=actor, entity_type="sample", entity_id=s.sample.sample_id,
                type=FLAG_TYPE,
                title=f"{s.sample.sample_id} stranded: {s.condition.replace('_', ' ')}",
                first_comment=s.diagnosis)
            # `create_flag` only sets FlagFlag.entity_type/entity_id (the
            # primary anchor) — it does not touch FlagEntityLink (that table
            # is the separate "related item" seam; see its docstring). This
            # module's own dedup (_open_flag_for, below) joins on
            # FlagEntityLink, so record the link explicitly.
            flag_service.add_entity_link(db, user=actor, flag_id=flag.id,
                                         entity_type="sample",
                                         entity_id=s.sample.sample_id)
            stats["flagged"] += 1
        except Exception:
            log.exception("stranded.flag_failed sample=%s", s.sample.sample_id)
            stats["errors"] += 1
    # resolve flags whose sample is no longer stranded
    open_flags = db.execute(
        select(FlagFlag, FlagEntityLink.entity_id)
        .join(FlagEntityLink, FlagEntityLink.flag_id == FlagFlag.id)
        .where(FlagFlag.type == FLAG_TYPE, FlagFlag.status.in_(flag_catalog.OPEN_STATES),
               FlagEntityLink.entity_type == "sample")
    ).all()
    for flag, sample_id in open_flags:
        if sample_id in stranded_ids:
            continue
        try:
            flag_service.add_comment(db, user=actor, flag_id=flag.id,
                                     body="Condition cleared — resolved by the stranded-sample check.")
            flag_service.change_status(db, user=actor, flag_id=flag.id, to_status="resolved")
            stats["resolved"] += 1
        except Exception:
            log.exception("stranded.resolve_failed flag=%s", flag.id)
            stats["errors"] += 1
    log.info("workflow.stranded_check %s", stats)
    return stats
