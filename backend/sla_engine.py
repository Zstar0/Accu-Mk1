"""SLA resolution engine (sub-project A of the SLA / processing-time feature).

Pure, DB-free logic so it can run identically in two places:
  * server-side flows (jobs/notifications) load all rows from ``sla_targets``
    and call :func:`resolve_sla_target`;
  * the D2 SLA column caches ``list_sla_targets()`` and runs the same fallback
    client-side in TypeScript (one cache, not O(N) backend round-trips).

Keeping the logic free of any session/engine import is what makes the engine
trivially unit-testable and lets the same contract be mirrored in TS.
"""
from __future__ import annotations

from datetime import datetime
from typing import Iterable, Optional, TypeVar

# Valid priority tiers (mirror SamplePriority/WorksheetItem.priority). NULL/None
# means "any priority". Callers normally pass a concrete priority, defaulting to
# 'normal' when a sample has no explicit SamplePriority override.
# Matching is case-sensitive (``t.priority == priority``): always use the
# lowercase canonical form here AND in the D2 TS resolver — 'Normal' != 'normal'.
# The Pydantic Literal on the API edge enforces this for stored rows.
PRIORITIES = ("normal", "high", "expedited")

# Duck-typed: anything with .analysis_service_id / .priority / .is_default
# attributes (a SlaTarget ORM row, or a plain object in tests).
T = TypeVar("T")


def resolve_sla_target(
    targets: Iterable[T],
    analysis_service_id: Optional[int],
    priority: Optional[str],
) -> Optional[T]:
    """Resolve the effective SLA target for a (service, priority) pair.

    Four-level fallback, most specific first:
      1. exact ``(service, priority)``
      2. ``(service, NULL)``  — the service's any-priority target
      3. ``(NULL, priority)`` — the priority's any-service target
      4. the ``is_default`` catch-all row

    When ``priority`` is None (caller has no priority info), levels 1 and 3 can
    only match rows whose own priority is also None, so resolution degrades
    cleanly to the service's any-priority row, then the default. Returns None
    only if nothing matches and there is no default (the seed guarantees one in
    production; this keeps the engine from raising in tests/edge cases).
    """
    rows = list(targets)
    levels = (
        lambda t: t.analysis_service_id == analysis_service_id and t.priority == priority,
        lambda t: t.analysis_service_id == analysis_service_id and t.priority is None,
        lambda t: t.analysis_service_id is None and t.priority == priority,
        lambda t: bool(t.is_default),
    )
    for matches in levels:
        for t in rows:
            if matches(t):
                return t
    return None


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
