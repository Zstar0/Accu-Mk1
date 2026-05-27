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
from typing import Any, Callable, Mapping, Optional, TypeVar
from zoneinfo import ZoneInfo

# Valid priority tiers (mirror SamplePriority/WorksheetItem.priority). Callers
# normally pass a concrete priority, defaulting to 'normal' when a sample has no
# explicit SamplePriority override; None means "no priority info" and bypasses
# the map entirely. Dict-key lookup is case-sensitive: always use the lowercase
# canonical form here AND in the D2 TS resolver — 'Normal' != 'normal'.
# The Pydantic Literal on the API edge enforces this for stored rows.
PRIORITIES = ("normal", "high", "expedited")

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
