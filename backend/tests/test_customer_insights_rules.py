from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from customer_insights import rules

T0 = datetime(2026, 9, 1, 12, tzinfo=timezone.utc)


def days(*offsets: int) -> list[datetime]:
    return [T0 + timedelta(days=o) for o in offsets]


def test_customer_key_registered_guest_and_none() -> None:
    assert rules.customer_key(1188, "X@Y.com") == "wc:1188"
    assert rules.customer_key(0, "  Guest@Example.COM ") == "email:guest@example.com"
    assert rules.customer_key(None, "") is None


def test_exclusions(monkeypatch) -> None:
    assert rules.is_excluded("email:forrestp@outlook.com", exclude_launch=False)
    monkeypatch.setattr(rules, "LAUNCH_ACCOUNT_KEYS", frozenset({"wc:5"}))
    assert rules.is_excluded("wc:5", exclude_launch=True)
    assert not rules.is_excluded("wc:5", exclude_launch=False)


def test_is_paid() -> None:
    assert rules.is_paid("completed", T0)
    assert rules.is_paid("processing", T0)
    assert not rules.is_paid("pending", T0)
    assert not rules.is_paid("completed", None)
    assert not rules.is_paid("refunded", T0)


def test_usual_gap_needs_three_orders() -> None:
    assert rules.usual_gap_days(days(0)) == 60
    assert rules.usual_gap_days(days(0, 10)) == 60
    assert rules.usual_gap_days(days(0, 10, 30)) == 15  # gaps 10, 20 -> median 15


def test_at_risk_needs_two_orders_and_overdue() -> None:
    weekly = days(0, 7, 14, 21)
    assert not rules.is_at_risk(weekly, T0 + timedelta(days=30))   # 9 d since, floor 21
    assert rules.is_at_risk(weekly, T0 + timedelta(days=50))       # 29 d > max(14, 21)
    assert not rules.is_at_risk(days(0), T0 + timedelta(days=400))  # one order: never at risk
    assert rules.overdue_ratio(weekly, T0 + timedelta(days=56)) == 5.0


def test_spend_status() -> None:
    s = rules.spend_status
    assert s(paid_orders=1, at_risk=False, period=Decimal(0), prior=Decimal(0)) == "one_time"
    assert s(paid_orders=5, at_risk=True, period=Decimal(9000), prior=Decimal(1)) == "at_risk"
    assert s(paid_orders=5, at_risk=False, period=Decimal(500), prior=Decimal(1000)) == "dropping"
    assert s(paid_orders=5, at_risk=False, period=Decimal(100), prior=Decimal(400)) == "steady"  # prior < $500
    assert s(paid_orders=5, at_risk=False, period=Decimal(1500), prior=Decimal(1000)) == "growing"


def test_lab_month_uses_lab_zone() -> None:
    late_evening_pt = datetime(2026, 10, 1, 6, 30, tzinfo=timezone.utc)  # Sep 30 23:30 PDT
    assert rules.lab_month(late_evening_pt, "America/Los_Angeles") == "2026-09"


def test_resolve_period() -> None:
    now = datetime(2026, 10, 5, 18, tzinfo=timezone.utc)
    start, end = rules.resolve_period("90d", None, None, now, "America/Los_Angeles")
    assert end == now and start == now - timedelta(days=90)
    assert rules.resolve_period("all", None, None, now, "UTC")[0] is None
    start, end = rules.resolve_period(None, date(2026, 9, 1), date(2026, 9, 30), now, "America/Los_Angeles")
    assert start == datetime(2026, 9, 1, 7, tzinfo=timezone.utc)   # 00:00 PDT
    assert end == datetime(2026, 10, 1, 7, tzinfo=timezone.utc)    # end date inclusive
