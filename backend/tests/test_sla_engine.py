"""Unit tests for the SLA resolution engine (sub-project A).

Pure-function tests: ``resolve_sla_target()`` and ``compute_sla_status()`` take
in-memory ``SlaTarget`` rows and primitives, so no DB session is needed. The
same 4-level fallback runs server-side here and client-side in D2 (src/lib).
"""
from datetime import datetime, timedelta

from models import SlaTarget
from sla_engine import compute_sla_status, resolve_sla_target


def _target(*, service_id=None, priority=None, minutes=1440, is_default=False):
    return SlaTarget(
        analysis_service_id=service_id,
        priority=priority,
        target_minutes=minutes,
        is_default=is_default,
    )


# A (NULL, NULL) catch-all — the seeded default that encodes the old 24h goal.
DEFAULT = _target(minutes=1440, is_default=True)


# ── resolve_sla_target: the 4-level fallback chain ──


def test_resolve_exact_service_and_priority():
    exact = _target(service_id=7, priority="high", minutes=120)
    targets = [DEFAULT, _target(service_id=7, minutes=480), exact]
    assert resolve_sla_target(targets, 7, "high") is exact


def test_resolve_falls_back_to_service_any_priority():
    svc_any = _target(service_id=7, minutes=480)  # (7, NULL)
    targets = [DEFAULT, svc_any]
    # no (7, 'high') row → use the service's any-priority row
    assert resolve_sla_target(targets, 7, "high") is svc_any


def test_resolve_falls_back_to_any_service_for_priority():
    prio_any = _target(priority="expedited", minutes=60)  # (NULL, 'expedited')
    targets = [DEFAULT, prio_any]
    # no (7, *) row at all → use the priority's any-service row
    assert resolve_sla_target(targets, 7, "expedited") is prio_any


def test_resolve_falls_back_to_default():
    targets = [DEFAULT, _target(service_id=99, priority="high")]
    # nothing matches service 7 / 'normal' → the catch-all default
    assert resolve_sla_target(targets, 7, "normal") is DEFAULT


def test_resolve_prefers_service_any_over_priority_any():
    svc_any = _target(service_id=7, minutes=480)  # (7, NULL)
    prio_any = _target(priority="high", minutes=60)  # (NULL, 'high')
    targets = [DEFAULT, prio_any, svc_any]
    # both could match (7,'high'); service-wildcard beats priority-wildcard
    assert resolve_sla_target(targets, 7, "high") is svc_any


def test_resolve_none_priority_degrades_to_service_any():
    svc_any = _target(service_id=7, minutes=480)
    exact = _target(service_id=7, priority="high", minutes=120)
    targets = [DEFAULT, exact, svc_any]
    # caller has no priority info → must NOT pick the 'high' row; (7, NULL) wins
    assert resolve_sla_target(targets, 7, None) is svc_any


def test_resolve_returns_none_when_no_default_and_no_match():
    # Defensive: the seed guarantees a default in prod, but the engine must
    # degrade to None rather than raise when nothing matches.
    targets = [_target(service_id=99, priority="high")]
    assert resolve_sla_target(targets, 7, "normal") is None


# ── compute_sla_status: raw wall-clock elapsed (business hours = sub-project B) ──


def test_compute_status_within_target_not_breached():
    now = datetime(2026, 5, 26, 12, 0, 0)
    received = now - timedelta(minutes=600)  # 10h into a 24h SLA
    s = compute_sla_status(received, 1440, now)
    assert s["elapsed_minutes"] == 600
    assert s["remaining_minutes"] == 840
    assert s["breached"] is False


def test_compute_status_breached_when_over_target():
    now = datetime(2026, 5, 26, 12, 0, 0)
    received = now - timedelta(minutes=1500)  # past the 24h target
    s = compute_sla_status(received, 1440, now)
    assert s["elapsed_minutes"] == 1500
    assert s["remaining_minutes"] == -60
    assert s["breached"] is True


def test_compute_status_boundary_exactly_at_target_not_breached():
    now = datetime(2026, 5, 26, 12, 0, 0)
    received = now - timedelta(minutes=1440)  # exactly at target
    s = compute_sla_status(received, 1440, now)
    assert s["elapsed_minutes"] == 1440
    assert s["remaining_minutes"] == 0
    # strict >: sitting exactly at the target is not yet a breach
    assert s["breached"] is False


def test_compute_status_no_received_at_returns_none():
    now = datetime(2026, 5, 26, 12, 0, 0)
    # "Awaiting sample" — the clock hasn't started, so there's no active SLA.
    assert compute_sla_status(None, 1440, now) is None
