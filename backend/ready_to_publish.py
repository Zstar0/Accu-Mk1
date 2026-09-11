"""Ready-to-Publish report engine (pure; no DB, no clock of its own).

One row per unpublished parent sample that qualifies by EITHER rule:

* ``all_verified`` — every live parent-tier line is verified or published
  (the line map is ``lims_analyses.service.native_parent_line_states``, the
  same map the sample page's lock gate reads, so the report cannot disagree
  with the page). A sample with no live lines never qualifies by this rule.
* ``flag_ready`` / ``flag_partial`` — an open or in-progress flag whose type
  is "Ready for Publish" / "Ready for Partial Publish" sits on the sample.
  Flag types are user-managed rows with generated slugs (prod: ``new_type_3``
  / ``new_type_4``), so :func:`resolve_ready_flag_kinds` matches the slug
  first and falls back to the label.

SLA comes from ``sla_engine`` exactly the way the SLA column and the SLA
Performance report compute it: tier = service-group tier with the default
fallback, elapsed in business hours. Colour mirrors the frontend's
``classifySampleColor`` (red = breached, amber = under the tier's amber
threshold, green otherwise).

Default sort is "most critical first": red before amber before green before
no-SLA, then least remaining minutes, then expedited/high priority before
normal, then oldest received. ``sort_rows`` is exported on its own so the
frontend's grouping helper can be pinned against the same order.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Iterable, Mapping, Optional

from sla_engine import BusinessSchedule, compute_business_minutes, resolve_sla_tier, sla_status_dict

LIVE_LINE_STATES = frozenset({"verified", "published"})
OPEN_FLAG_STATUSES = frozenset({"open", "in_progress", "blocked"})
READY_FULL = "flag_ready"
READY_PARTIAL = "flag_partial"
ALL_VERIFIED = "all_verified"
HOLD = "hold"

# Slug → kind (prod rows as of 2026-09-10); label fallback handles a re-seeded
# or renamed type. Keys are compared case-insensitively on the label side.
_READY_SLUGS: Mapping[str, str] = {"new_type_3": READY_FULL, "new_type_4": READY_PARTIAL}
_READY_LABELS: Mapping[str, str] = {
    "ready for publish": READY_FULL,
    "ready for partial publish": READY_PARTIAL,
}
# "On Hold" (Handler-created flag type, 2026-09-10) parks a qualifying row in
# the page's On-hold section without dropping it. Label-matched only: the
# slug is generated at creation time.
_HOLD_LABELS = frozenset({"on hold", "on-hold", "hold", "onhold"})

_PRIORITY_RANK = {"expedited": 0, "high": 1, "normal": 2}
_COLOR_RANK = {"red": 0, "amber": 1, "green": 2, None: 3}


@dataclass(frozen=True)
class SampleIn:
    pk: int
    sample_id: str
    status: Optional[str]
    client: Optional[str] = None
    order: Optional[str] = None
    email: Optional[str] = None
    created_at: Optional[datetime] = None
    date_received: Optional[datetime] = None
    lot: Optional[str] = None
    analytes: tuple[str, ...] = ()
    external_uid: Optional[str] = None


@dataclass(frozen=True)
class FlagIn:
    id: int
    sample_id: str
    type_slug: str
    status: str
    title: str = ""
    created_at: Optional[datetime] = None


@dataclass(frozen=True)
class FlagTypeIn:
    slug: str
    label: str
    color: str = ""


@dataclass(frozen=True)
class TierIn:
    id: int
    name: str
    target_minutes: int
    is_default: bool
    amber_threshold_percent: int = 25
    # The engine clocks elapsed time in business hours; the flag is surfaced so the
    # frontend's shared SLA breakdown card can label the target the same way the
    # Order Status page does.
    business_hours_only: bool = True


@dataclass(frozen=True)
class GroupIn:
    id: int
    name: str
    sla_tier_id: Optional[int]
    service_ids: frozenset = field(default_factory=frozenset)


def resolve_ready_flag_kinds(flag_types: Iterable[FlagTypeIn]) -> dict[str, str]:
    """{type_slug: READY_FULL | READY_PARTIAL} for the two ready types."""
    out: dict[str, str] = {}
    for ft in flag_types:
        kind = _READY_SLUGS.get(ft.slug) or _READY_LABELS.get((ft.label or "").strip().lower())
        if kind:
            out[ft.slug] = kind
    return out


def resolve_hold_flag_slugs(flag_types: Iterable[FlagTypeIn]) -> set[str]:
    """Slugs of the "On Hold" flag type(s), matched by label."""
    return {ft.slug for ft in flag_types if (ft.label or "").strip().lower() in _HOLD_LABELS}


def resolve_flag_kinds(flag_types: Iterable[FlagTypeIn]) -> dict[str, str]:
    """{type_slug: READY_FULL | READY_PARTIAL | HOLD} — every flag type the
    report reacts to (what the loader should fetch open flags for)."""
    kinds = resolve_ready_flag_kinds(flag_types)
    for slug in resolve_hold_flag_slugs(flag_types):
        kinds.setdefault(slug, HOLD)
    return kinds


def classify_lines(line_states: Mapping[str, str]) -> str:
    """'all_verified' | 'pending' | 'no_lines' for one sample's live line map."""
    if not line_states:
        return "no_lines"
    if all(s in LIVE_LINE_STATES for s in line_states.values()):
        return ALL_VERIFIED
    return "pending"


def strip_identity_suffix(name: str) -> str:
    n = (name or "").strip()
    if " - Identity" in n:
        n = n.split(" - Identity")[0].strip()
    return n


def sla_color(status: dict, tier: TierIn) -> str:
    """Mirror of src/lib/sla-resolution.ts classifySampleColor."""
    if status["breached"]:
        return "red"
    if status["remaining_minutes"] <= 0 or tier.target_minutes <= 0:
        return "green"
    pct = status["remaining_minutes"] / tier.target_minutes * 100.0
    if pct < tier.amber_threshold_percent:
        return "amber"
    return "green"


def _group_tier_for(service_ids: set, tier_of_service: Mapping[int, TierIn]) -> Optional[TierIn]:
    """Tightest (smallest target) tier among the sample's grouped services —
    the same rule sla_perf applies."""
    tiers = [tier_of_service[s] for s in service_ids if s in tier_of_service]
    if not tiers:
        return None
    return min(tiers, key=lambda t: t.target_minutes)


def build_ready_rows(
    *,
    samples: Iterable[SampleIn],
    line_states_by_pk: Mapping[int, Mapping[str, str]],
    flags: Iterable[FlagIn],
    flag_types: Iterable[FlagTypeIn],
    priorities: Mapping[str, str],
    services_of: Mapping[int, set],
    tiers: Iterable[TierIn],
    groups: Iterable[GroupIn],
    schedule: Optional[BusinessSchedule],
    holidays: frozenset,
    now: datetime,
    excluded_sample_ids: frozenset = frozenset(),
) -> list[dict]:
    """Qualifying rows, unsorted (see :func:`sort_rows`)."""
    types = {ft.slug: ft for ft in flag_types}
    ready_kind = resolve_ready_flag_kinds(types.values())
    hold_slugs = resolve_hold_flag_slugs(types.values())

    ready_flags_by_sample: dict[str, list[FlagIn]] = {}
    hold_flag_by_sample: dict[str, FlagIn] = {}
    for f in flags:
        if f.status not in OPEN_FLAG_STATUSES:
            continue
        if f.type_slug in ready_kind:
            ready_flags_by_sample.setdefault(f.sample_id, []).append(f)
        elif f.type_slug in hold_slugs:
            # Oldest open hold is "the" reason; all of them are open anyway.
            cur = hold_flag_by_sample.get(f.sample_id)
            if cur is None or f.id < cur.id:
                hold_flag_by_sample[f.sample_id] = f

    tier_by_id = {t.id: t for t in tiers}
    default_tier = next((t for t in tier_by_id.values() if t.is_default), None)
    tier_of_service: dict[int, TierIn] = {}
    for g in groups:
        tier = tier_by_id.get(g.sla_tier_id) if g.sla_tier_id else None
        if tier is None:
            continue
        for sid in g.service_ids:
            tier_of_service[sid] = tier

    def bh(start: datetime, end: datetime) -> float:
        if schedule is None:
            return (end - start).total_seconds() / 60.0
        return compute_business_minutes(start, end, schedule, holidays.__contains__)

    rows: list[dict] = []
    for s in samples:
        if s.sample_id in excluded_sample_ids:
            continue
        line_states = line_states_by_pk.get(s.pk, {})
        line_class = classify_lines(line_states)
        sample_flags = ready_flags_by_sample.get(s.sample_id, [])

        reasons: list[str] = []
        if line_class == ALL_VERIFIED:
            reasons.append(ALL_VERIFIED)
        kinds = {ready_kind[f.type_slug] for f in sample_flags}
        if READY_FULL in kinds:
            reasons.append(READY_FULL)
        if READY_PARTIAL in kinds:
            reasons.append(READY_PARTIAL)
        if not reasons:
            continue

        sla = None
        if s.date_received is not None:
            tier = resolve_sla_tier(
                {}, _group_tier_for(services_of.get(s.pk, set()), tier_of_service), None, default_tier
            )
            if tier is not None:
                status = sla_status_dict(tier.target_minutes, bh(s.date_received, now))
                sla = {
                    "tier": tier.name,
                    "target_minutes": tier.target_minutes,
                    "business_hours_only": tier.business_hours_only,
                    "elapsed_minutes": round(status["elapsed_minutes"], 1),
                    "remaining_minutes": round(status["remaining_minutes"], 1),
                    "breached": status["breached"],
                    "color": sla_color(status, tier),
                }

        pending = sorted(k for k, v in line_states.items() if v not in LIVE_LINE_STATES)
        hold = hold_flag_by_sample.get(s.sample_id)
        rows.append({
            "sample_id": s.sample_id,
            "status": s.status or "",
            "client": s.client,
            "order": s.order or "",
            "email": s.email,
            "created_at": s.created_at.isoformat() if s.created_at else None,
            "received_at": s.date_received.isoformat() if s.date_received else None,
            "lot": s.lot,
            "analytes": [strip_identity_suffix(a) for a in s.analytes if a],
            "reasons": reasons,
            "flags": [
                {
                    "id": f.id,
                    "type": f.type_slug,
                    "kind": ready_kind[f.type_slug],
                    "label": types[f.type_slug].label,
                    "color": types[f.type_slug].color,
                    "status": f.status,
                    "title": f.title,
                }
                for f in sorted(sample_flags, key=lambda f: f.id)
            ],
            "lines": {
                "total": len(line_states),
                "verified": sum(1 for v in line_states.values() if v in LIVE_LINE_STATES),
                "pending": pending,
            },
            "priority": priorities.get(s.external_uid or "", "normal") if s.external_uid else "normal",
            "sla": sla,
            # Parked, not dropped: the page shows held rows in their own
            # section with the flag title as the reason; totals skip them.
            "hold": None if hold is None else {
                "flag_id": hold.id,
                "type": hold.type_slug,
                "label": types[hold.type_slug].label,
                "color": types[hold.type_slug].color,
                "status": hold.status,
                "title": hold.title,
                "since": hold.created_at.isoformat() if hold.created_at else None,
            },
        })
    return rows


def sort_key(row: dict) -> tuple:
    sla = row.get("sla")
    color = sla["color"] if sla else None
    remaining = sla["remaining_minutes"] if sla else float("inf")
    prio = _PRIORITY_RANK.get(row.get("priority") or "normal", 2)
    received = row.get("received_at") or "9999"
    return (_COLOR_RANK.get(color, 3), remaining, prio, received, row["sample_id"])


def sort_rows(rows: Iterable[dict]) -> list[dict]:
    """Most critical first — see the module docstring for the ladder."""
    return sorted(rows, key=sort_key)
