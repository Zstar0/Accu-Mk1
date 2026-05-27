"""Unit tests for the SLA tier resolution engine (A, revised to tiers).

Pure-function tests: resolve_sla_tier() takes the priority->tier map, the
service's group tier, the priority, and the default tier — no DB. The same
fixed-precedence chain runs server-side here and client-side in D2 (src/lib).
"""
from datetime import datetime, timedelta, date

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


# ── Business-hours engine (sub-project B) ──────────────────────────────
from datetime import time, timezone as _tz
from zoneinfo import ZoneInfo

from sla_engine import (
    BusinessSchedule,
    compute_business_minutes,
    sla_status_dict,
)

_PT = ZoneInfo("America/Los_Angeles")
_SCHED = BusinessSchedule(
    open_time=time(9, 0),
    close_time=time(17, 0),
    timezone="America/Los_Angeles",
    working_days=frozenset({0, 1, 2, 3, 4}),
)
_NO_HOLIDAY = lambda d: False  # noqa: E731


def _utc(y, mo, d, h, mi=0):
    """A Pacific wall-clock instant expressed as NAIVE UTC (codebase convention)."""
    return (
        datetime(y, mo, d, h, mi, tzinfo=_PT)
        .astimezone(_tz.utc)
        .replace(tzinfo=None)
    )


def test_received_after_close_friday_through_weekend_is_zero():
    # Fri 2026-07-10 18:00 PT -> Sat 2026-07-11 14:00 PT
    got = compute_business_minutes(_utc(2026, 7, 10, 18), _utc(2026, 7, 11, 14), _SCHED, _NO_HOLIDAY)
    assert got == 0.0


def test_friday_evening_to_monday_morning_counts_monday_only():
    # Fri 18:00 PT -> Mon 2026-07-13 10:00 PT == Mon 09:00-10:00 == 60 min
    got = compute_business_minutes(_utc(2026, 7, 10, 18), _utc(2026, 7, 13, 10), _SCHED, _NO_HOLIDAY)
    assert got == 60.0


def test_received_before_open_clamps_to_open():
    # Mon 08:00 PT -> Mon 10:00 PT == 09:00-10:00 == 60 min
    got = compute_business_minutes(_utc(2026, 7, 13, 8), _utc(2026, 7, 13, 10), _SCHED, _NO_HOLIDAY)
    assert got == 60.0


def test_received_exactly_at_close_is_zero():
    got = compute_business_minutes(_utc(2026, 7, 13, 17), _utc(2026, 7, 13, 17, 30), _SCHED, _NO_HOLIDAY)
    assert got == 0.0


def test_now_before_received_is_zero():
    got = compute_business_minutes(_utc(2026, 7, 13, 12), _utc(2026, 7, 13, 11), _SCHED, _NO_HOLIDAY)
    assert got == 0.0


def test_received_none_is_zero():
    assert compute_business_minutes(None, _utc(2026, 7, 13, 12), _SCHED, _NO_HOLIDAY) == 0.0


def test_full_working_day_is_480_minutes_in_pdt_and_pst():
    # Summer (PDT) full day Wed 2026-07-08
    pdt = compute_business_minutes(_utc(2026, 7, 8, 0), _utc(2026, 7, 8, 23, 59), _SCHED, _NO_HOLIDAY)
    # Winter (PST) full day Wed 2026-01-14
    pst = compute_business_minutes(_utc(2026, 1, 14, 0), _utc(2026, 1, 14, 23, 59), _SCHED, _NO_HOLIDAY)
    assert pdt == 480.0
    assert pst == 480.0  # DST does not shift the 9-5 window


def test_spans_dst_spring_forward_full_days_still_480_each():
    # Spring-forward is Sun 2026-03-08 (non-working). Mon 03-09 and Tue 03-10 are full working days.
    got = compute_business_minutes(_utc(2026, 3, 9, 0), _utc(2026, 3, 10, 23, 59), _SCHED, _NO_HOLIDAY)
    assert got == 960.0  # 480 + 480


def test_holiday_in_middle_is_skipped():
    # Mon 16:00 -> Wed 10:00, with Tue 2026-07-14 a holiday:
    # Mon 16:00-17:00 (60) + Tue skipped + Wed 09:00-10:00 (60) == 120
    is_holiday = lambda d: d == date(2026, 7, 14)  # noqa: E731
    got = compute_business_minutes(_utc(2026, 7, 13, 16), _utc(2026, 7, 15, 10), _SCHED, is_holiday)
    assert got == 120.0


def test_misconfig_close_before_open_returns_zero():
    bad = BusinessSchedule(time(17, 0), time(9, 0), "America/Los_Angeles", frozenset({0, 1, 2, 3, 4}))
    assert compute_business_minutes(_utc(2026, 7, 13, 0), _utc(2026, 7, 17, 23), bad, _NO_HOLIDAY) == 0.0


def test_misconfig_no_working_days_returns_zero():
    bad = BusinessSchedule(time(9, 0), time(17, 0), "America/Los_Angeles", frozenset())
    assert compute_business_minutes(_utc(2026, 7, 13, 0), _utc(2026, 7, 17, 23), bad, _NO_HOLIDAY) == 0.0


def test_every_day_holiday_returns_zero():
    assert compute_business_minutes(_utc(2026, 7, 13, 0), _utc(2026, 7, 17, 23), _SCHED, lambda d: True) == 0.0


def test_sla_status_dict_shared_formula():
    assert sla_status_dict(100, 40.0) == {
        "target_minutes": 100,
        "elapsed_minutes": 40.0,
        "remaining_minutes": 60.0,
        "breached": False,
    }
    assert sla_status_dict(100, 100.0)["breached"] is False   # strict >
    assert sla_status_dict(100, 100.5)["breached"] is True


def test_compute_sla_status_raw_path_unchanged():
    # Regression: refactor must preserve A's exact output.
    recv = datetime(2026, 7, 13, 9, 0, 0)
    now = datetime(2026, 7, 13, 11, 0, 0)
    assert compute_sla_status(recv, 60, now) == {
        "target_minutes": 60,
        "elapsed_minutes": 120.0,
        "remaining_minutes": -60.0,
        "breached": True,
    }
    assert compute_sla_status(None, 60, now) is None
