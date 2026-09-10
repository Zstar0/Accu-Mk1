"""SLA snapshot writer (spec §3.5). Records what was promised at the clock
events so reports never re-grade history against today's mapping."""
from __future__ import annotations

from datetime import datetime
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import LimsSample, LimsSubSample, SlaPriorityTier, SlaTier
from priority.service import load_effective

TERMINAL_STATUSES = ("published", "cancelled", "invalid")


def _targets(db: Session) -> tuple[int, dict[str, int]]:
    default = db.execute(select(SlaTier).where(SlaTier.is_default)).scalar_one()
    rows = db.execute(
        select(SlaPriorityTier).where(SlaPriorityTier.service_group_id.is_(None))
    ).scalars().all()
    return default.target_minutes, {r.priority: r.tier.target_minutes for r in rows}


def refresh(db: Session, sample_pks: Iterable[int], *, only_in_flight: bool = False) -> int:
    pks = list(dict.fromkeys(sample_pks))
    if not pks:
        return 0
    samples = db.execute(select(LimsSample).where(LimsSample.id.in_(pks))).scalars().all()
    if only_in_flight:
        samples = [s for s in samples if (s.status or "") not in TERMINAL_STATUSES]
    if not samples:
        return 0
    vials = db.execute(
        select(LimsSubSample).where(LimsSubSample.parent_sample_pk.in_([s.id for s in samples]))
    ).scalars().all()
    by_s, by_v = load_effective(db, sample_pks=[s.id for s in samples], sub_sample_pks=[v.id for v in vials])
    default_target, by_key = _targets(db)
    now = datetime.utcnow()
    for s in samples:
        eff = by_s[s.id]
        s.sla_priority_key, s.sla_priority_source = eff.key, eff.source_level
        s.sla_target_minutes, s.sla_snapshot_at = by_key.get(eff.key, default_target), now
    for v in vials:
        eff = by_v[v.id]
        v.sla_priority_key, v.sla_priority_source = eff.key, eff.source_level
        v.sla_target_minutes, v.sla_snapshot_at = by_key.get(eff.key, default_target), now
    db.flush()
    return len(samples)
