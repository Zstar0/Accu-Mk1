"""Customer Insights definitions (spec 2026-10-05, section 2). Pure; tune thresholds here.

ponytail: thresholds are constants; move to a settings table if the lab wants to tune
them from the UI.
"""
from __future__ import annotations

import statistics
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

from test_accounts import TEST_EMAILS

DEFAULT_GAP_DAYS = 60
AT_RISK_GAP_MULTIPLE = 2
AT_RISK_FLOOR_DAYS = 21
TREND_PCT = Decimal("0.40")
TREND_PRIOR_FLOOR = Decimal("500")
MATURITY_DAYS = 60
CHURN_WINDOW_DAYS = 60
UNPAID_STATUSES = frozenset({"pending", "failed", "cancelled", "refunded", "checkout-draft", "deleted", "trash"})
# Read-only prod WooCommerce lookup 2026-10-06, confirmed by the Handler.
# Internal: $0-only staff/partner accounts (the 2026-10-02 analysis's two Jan accounts plus two more).
# wc:1544 (Forrest) is excluded via test_accounts.TEST_EMAILS instead.
INTERNAL_CUSTOMER_KEYS: frozenset[str] = frozenset({
    "wc:1541",  # Harmony Fried (Jan, $0)
    "wc:1545",  # Anthony Burke, Valence (Jan, $0)
    "wc:1540",  # Levi Fried, Valence (Feb, $0)
    "wc:1714",  # results@accumarklabs.com ($0)
})
# Feb 2026 launch accounts; hidden only when exclude_launch_accounts is on (cohort views by default).
LAUNCH_ACCOUNT_KEYS: frozenset[str] = frozenset({
    "wc:1550",  # Mark Wilson, Platinum/Kold
    "wc:1551",  # Kyle Robertson
    "wc:1552",  # Walt Moscoso, Rapid
})
PERIOD_DAYS = {"30d": 30, "90d": 90, "6m": 182, "1y": 365}


def customer_key(customer_id: int | None, email: str | None) -> str | None:
    if customer_id:
        return f"wc:{int(customer_id)}"
    e = (email or "").strip().lower()
    return f"email:{e}" if e else None


def is_excluded(key: str, *, exclude_launch: bool, email: str | None = None) -> bool:
    if key in INTERNAL_CUSTOMER_KEYS:
        return True
    if (email or "").strip().lower() in TEST_EMAILS:
        return True
    if key.startswith("email:") and key[6:] in TEST_EMAILS:
        return True
    return exclude_launch and key in LAUNCH_ACCOUNT_KEYS


def is_paid(status: str, date_paid: datetime | None) -> bool:
    return date_paid is not None and (status or "").lower() not in UNPAID_STATUSES


def usual_gap_days(dates: list[datetime]) -> float:
    if len(dates) < 3:
        return float(DEFAULT_GAP_DAYS)
    s = sorted(dates)
    gaps = [(b - a).total_seconds() / 86400 for a, b in zip(s, s[1:])]
    return float(statistics.median(gaps))


def _days_since_last(dates: list[datetime], as_of: datetime) -> float:
    return (as_of - max(dates)).total_seconds() / 86400


def is_at_risk(dates: list[datetime], as_of: datetime) -> bool:
    past = [d for d in dates if d <= as_of]
    if len(past) < 2:
        return False
    threshold = max(AT_RISK_GAP_MULTIPLE * usual_gap_days(past), AT_RISK_FLOOR_DAYS)
    return _days_since_last(past, as_of) > threshold


def overdue_ratio(dates: list[datetime], as_of: datetime) -> float:
    past = [d for d in dates if d <= as_of]
    if not past:
        return 0.0
    return round(_days_since_last(past, as_of) / usual_gap_days(past), 1)


def spend_status(*, paid_orders: int, at_risk: bool, period: Decimal, prior: Decimal) -> str:
    if paid_orders <= 1:
        return "one_time"
    if at_risk:
        return "at_risk"
    if prior >= TREND_PRIOR_FLOOR and period <= prior * (1 - TREND_PCT):
        return "dropping"
    if prior > 0 and period >= prior * (1 + TREND_PCT):
        return "growing"
    return "steady"


def lab_month(t: datetime, tz: str) -> str:
    return t.astimezone(ZoneInfo(tz)).strftime("%Y-%m")


def resolve_period(
    period: str | None, start: date | None, end: date | None, now: datetime, tz: str
) -> tuple[datetime | None, datetime]:
    if start or end:
        z = ZoneInfo(tz)
        lo = datetime.combine(start, time(), z).astimezone(timezone.utc) if start else None
        hi = (datetime.combine(end + timedelta(days=1), time(), z).astimezone(timezone.utc) if end else now)
        return lo, hi
    if not period or period == "all":
        return None, now
    return now - timedelta(days=PERIOD_DAYS[period]), now
