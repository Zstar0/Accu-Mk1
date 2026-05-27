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

from datetime import datetime
from typing import Mapping, Optional, TypeVar

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

    Returns None when ``received_at`` is None ("Awaiting sample" — the clock
    starts at sample ``date_received``, so there is no active SLA before then).

    ``breached`` uses a strict ``>``: sitting exactly at the target is not yet a
    breach. Elapsed is raw wall-clock here; the business-hours-aware variant
    (same signature, calendar-adjusted) is sub-project B's job.
    """
    if received_at is None:
        return None
    elapsed_minutes = (now - received_at).total_seconds() / 60.0
    return {
        "target_minutes": target_minutes,
        "elapsed_minutes": elapsed_minutes,
        "remaining_minutes": target_minutes - elapsed_minutes,
        "breached": elapsed_minutes > target_minutes,
    }
