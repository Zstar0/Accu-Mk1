"""SLA resolution engine (sub-project A of the SLA / processing-time feature).

Pure, DB-free logic so it can run identically in two places:
  * server-side flows (jobs/notifications) resolve tiers and call
    :func:`resolve_sla_tier`;
  * the D2 SLA column caches tier data and runs the same fallback
    client-side in TypeScript (one cache, not O(N) backend round-trips).

Keeping the logic free of any session/engine import is what makes the engine
trivially unit-testable and lets the same contract be mirrored in TS.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Callable, Iterable, Mapping, Optional, TypeVar
from zoneinfo import ZoneInfo

# T is the SLA tier type, returned as-is — resolve_sla_tier is a passthrough and
# never reads tier attributes; attribute access is the caller's responsibility.
T = TypeVar("T")


@dataclass(frozen=True)
class BusinessSchedule:
    """A global business-hours schedule for the business-minutes engine.

    DB-free so the engine stays unit-testable; the API builds one from the
    BusinessHoursConfig row via :meth:`from_orm`.
    """

    open_time: time
    close_time: time
    timezone: str
    working_days: frozenset[int]  # Python weekday ints, Mon=0..Sun=6

    @classmethod
    def from_orm(cls, config: Any) -> "BusinessSchedule":
        return cls(
            open_time=config.open_time,
            close_time=config.close_time,
            timezone=config.timezone,
            working_days=frozenset(config.working_days),
        )


def _to_aware_utc(dt: datetime) -> datetime:
    """Make a datetime tz-aware. Naive datetimes are UTC by codebase convention;
    already-aware datetimes pass through (compared in absolute time)."""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def sla_status_dict(target_minutes: int, elapsed_minutes: float) -> dict:
    """The single SLA status formula shared by the raw and business-hours paths.

    ``breached`` is strict ``>`` — sitting exactly at target is not yet a breach.
    """
    return {
        "target_minutes": target_minutes,
        "elapsed_minutes": elapsed_minutes,
        "remaining_minutes": target_minutes - elapsed_minutes,
        "breached": elapsed_minutes > target_minutes,
    }


def compute_business_minutes(
    received_at: Optional[datetime],
    now: datetime,
    schedule: BusinessSchedule,
    is_holiday: Callable[[date], bool],
) -> float:
    """Business minutes elapsed between ``received_at`` and ``now``.

    Counts only the [open_time, close_time] window on working days in the
    schedule's timezone, skipping holidays. Day-by-day window overlap (not
    minute-by-minute). The clock-start rule falls out of the ``max(...)`` clamp:
    a sample received after close contributes 0 until the next working open.

    Returns 0.0 for no/zero/negative span and for any misconfiguration
    (close <= open, no working days, every day a holiday) — never raises on
    those. Assumes ``schedule.timezone`` is a valid IANA zone (enforced at write
    time by the config PUT validation).
    """
    if received_at is None:
        return 0.0
    start = _to_aware_utc(received_at)
    end = _to_aware_utc(now)
    if end <= start:
        return 0.0
    tz = ZoneInfo(schedule.timezone)
    total = 0.0
    d = start.astimezone(tz).date()
    last = end.astimezone(tz).date()
    while d <= last:
        if d.weekday() in schedule.working_days and not is_holiday(d):
            open_dt = datetime.combine(d, schedule.open_time, tzinfo=tz)
            close_dt = datetime.combine(d, schedule.close_time, tzinfo=tz)
            lo = max(start, open_dt)
            hi = min(end, close_dt)
            if hi > lo:
                total += (hi - lo).total_seconds() / 60.0
        d += timedelta(days=1)
    return total


def resolve_sla_tier(
    priority_map: Mapping[str, T],
    group_tier: Optional[T],
    priority: Optional[str],
    default_tier: Optional[T],
) -> Optional[T]:
    """Resolve the effective SLA tier with fixed precedence.

    1. priority override — if ``priority`` has a row in ``priority_map`` -> that
       tier (per the lab's decision, priority beats the group SLA);
    2. else the service's ``group_tier`` (NULL = no tier on the group);
    3. else ``default_tier`` (the is_default tier, the 24h fallback).

    Sparsity contract: ``priority_map`` holds a row ONLY for priorities that
    override. An unmapped priority — including ``normal`` and ``None`` —
    ``.get()``s to None and falls through. Do not add a ``normal -> default``
    entry; it's operationally identical to no row.

    Returns None only if nothing matches and ``default_tier`` is None (the seed
    guarantees a default in production; this keeps the engine from raising).
    """
    prio_tier = priority_map.get(priority) if priority is not None else None
    if prio_tier is not None:
        return prio_tier
    if group_tier is not None:
        return group_tier
    return default_tier


def compute_sla_status(
    received_at: Optional[datetime],
    target_minutes: int,
    now: datetime,
) -> Optional[dict]:
    """Raw wall-clock SLA status for a sample.

    Returns None when ``received_at`` is None ("Awaiting sample"). Elapsed is raw
    wall-clock here; the business-hours-aware variant is
    :func:`compute_business_minutes`. Both paths return the same shape via
    :func:`sla_status_dict`.
    """
    if received_at is None:
        return None
    elapsed_minutes = (now - received_at).total_seconds() / 60.0
    return sla_status_dict(target_minutes, elapsed_minutes)


def tier_by_service(
    profile_tiers: Iterable[tuple[T, Iterable[int]]],
    group_tiers: Iterable[tuple[T, Iterable[int]]],
) -> dict[int, T]:
    """analysis_service id -> the tier that service owes.

    Each argument is ``(tier, service_ids)`` pairs: one per tiered ACTIVE
    analysis profile, one per tiered service group. A profile tier beats a
    group tier (the lab configures SLAs on analysis profiles; same precedence
    as src/lib/sla-resolution.ts), and within a level the tightest
    ``target_minutes`` wins. A service in neither is absent from the map and
    falls to the default tier in :func:`sample_tier`.

    Unlike :func:`resolve_sla_tier` this READS ``tier.target_minutes``.
    """
    def tightest(pairs: Iterable[tuple[T, Iterable[int]]]) -> dict[int, T]:
        out: dict[int, T] = {}
        for tier, service_ids in pairs:
            for sid in service_ids:
                cur = out.get(sid)
                if cur is None or tier.target_minutes < cur.target_minutes:  # type: ignore[attr-defined]
                    out[sid] = tier
        return out

    by_service = tightest(group_tiers)
    by_service.update(tightest(profile_tiers))
    return by_service


def sample_tier(
    service_ids: Iterable[int],
    by_service: Mapping[int, T],
    default_tier: Optional[T],
    *,
    loosest: bool = False,
) -> Optional[T]:
    """One tier for a sample from its services' own tiers.

    Every service resolves to ``by_service[sid]`` or, when it has no profile
    or group tier, the default. The sample then takes the TIGHTEST of those
    (the first COA out is the fast work and owes the fast deadline) or, with
    ``loosest=True``, the LOOSEST (a COA already went out, so what remains is
    the slow work: USP 71 sterility against the 3-day tier would read late on
    every sample). A sample with no services takes the default.
    """
    tiers = [by_service.get(sid) or default_tier for sid in service_ids]
    tiers = [t for t in tiers if t is not None]
    if not tiers:
        return default_tier
    pick = max if loosest else min
    return pick(tiers, key=lambda t: t.target_minutes)  # type: ignore[attr-defined]
