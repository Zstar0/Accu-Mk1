"""Unit tests for the SLA tier resolution engine (A, revised to tiers).

Pure-function tests: resolve_sla_tier() takes the priority->tier map, the
service's group tier, the priority, and the default tier — no DB. The same
fixed-precedence chain runs server-side here and client-side in D2 (src/lib).
"""
from datetime import datetime, timedelta

from models import SlaTier
from sla_engine import compute_sla_status, resolve_sla_tier


def _tier(target_minutes=1440, *, name="t", is_default=False):
    return SlaTier(name=name, target_minutes=target_minutes, is_default=is_default)


DEFAULT = _tier(1440, name="Standard", is_default=True)
RUSH = _tier(240, name="Rush")
GROUP = _tier(2880, name="Microbiology")


# ── resolve_sla_tier: fixed precedence (priority override > group > default) ──

def test_priority_override_wins_over_group():
    pmap = {"expedited": RUSH}
    assert resolve_sla_tier(pmap, GROUP, "expedited", DEFAULT) is RUSH


def test_priority_override_wins_even_without_group():
    pmap = {"expedited": RUSH}
    assert resolve_sla_tier(pmap, None, "expedited", DEFAULT) is RUSH


def test_unmapped_priority_falls_to_group_tier():
    pmap = {"expedited": RUSH}  # 'normal' is not mapped
    assert resolve_sla_tier(pmap, GROUP, "normal", DEFAULT) is GROUP


def test_no_group_tier_falls_to_default():
    pmap = {"expedited": RUSH}
    assert resolve_sla_tier(pmap, None, "normal", DEFAULT) is DEFAULT


def test_none_priority_falls_to_group_then_default():
    pmap = {"expedited": RUSH}
    assert resolve_sla_tier(pmap, GROUP, None, DEFAULT) is GROUP
    assert resolve_sla_tier(pmap, None, None, DEFAULT) is DEFAULT


def test_empty_priority_map_uses_group_or_default():
    assert resolve_sla_tier({}, GROUP, "expedited", DEFAULT) is GROUP
    assert resolve_sla_tier({}, None, "expedited", DEFAULT) is DEFAULT


def test_returns_none_when_no_default_and_nothing_matches():
    assert resolve_sla_tier({}, None, "normal", None) is None


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
