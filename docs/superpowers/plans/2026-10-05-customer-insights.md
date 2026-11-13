# Customer Insights (Accu-Mk1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Customer Insights to Accu-Mk1:
- an all-customers Insights page;
- an upgraded All customers list;
- a per-customer Dashboard tab;
- a `/reports/customers/*` API that the UI and the Hermes bots (via labmanager-mcp) share.

**Architecture:**
- **Loading:** one loader reads the IS DB (`wc_orders` money, `order_submissions` samples and tests, `wc_customers` names, published primary COA verdicts) and Mk1's own SLA records into an in-memory `Dataset`. It is cached for 60 seconds.
- **Computing:** pure builders in `backend/customer_insights/metrics.py` compute every view from the `Dataset` and an `as_of` instant. The same builders, run at two instants, produce the bots' change feed.
- **Serving:** a FastAPI router serves them.
- **Frontend:** React pages read the same JSON.

**Tech Stack:** FastAPI + pydantic, psycopg2 against the IS Postgres (`get_integration_db`), SQLAlchemy for the Mk1 DB, React 19 + TanStack Query + recharts + shadcn/ui, vitest, Playwright, pytest.

**Spec:** `docs/superpowers/specs/2026-10-05-customer-insights-design.md` (same branch).
**Depends on:** Plan 1, `integration-service/docs/superpowers/plans/2026-10-05-wc-orders-mirror.md`. The `wc_orders` table must exist in the IS DB. For local work, run Plan 1's migration on the local IS DB (`accumark_integration`) and its backfill against a dev WooCommerce, or seed rows via the fixtures in Task 2.

## Global Constraints

- Every rule lives in `backend/customer_insights/rules.py`: thresholds 60-day default gap, 2× gap, 21-day floor, 40% drop/growth, $500 prior-period floor, 60-day maturity, 60-day churn window.
- **Customer key:** `wc:<id>` for registered customers; `email:<lowercased email>` for guests (WooCommerce customer id 0 or NULL).
- **Excluded:**
  - `TEST_EMAILS` (moved to the shared `backend/test_accounts.py`);
  - `INTERNAL_CUSTOMER_KEYS`.
  - `LAUNCH_ACCOUNT_KEYS` are excluded only when `exclude_launch_accounts=true`, which defaults to true for cohorts and false elsewhere.
- **Paid order:** `date_paid_gmt` is set AND status is not in `{pending, failed, cancelled, refunded, checkout-draft, deleted, trash}`. Net = `total - refund_total`; an order with net <= 0 after refunds that was fully refunded drops out.
- **Testing order:** a paid order with an IS `order_submissions` row that has at least 1 sample and `is_transfer` false. Re-orders, repeat rate, usual gap and cohorts use testing orders only. Spend, order count and AOV use all paid orders.
- **Time:** buckets use the lab zone (`scheduled_publish.lab_tz(db)`); stored and transported times are UTC ISO strings.
- **Money:** a decimal string with 2 dp in every response (`"1980.00"`); the frontend formats it.
- **Response models:** every pydantic response model declares every field, because `response_model` silently drops undeclared keys. Each route has a TestClient test asserting the nested fields survive.
- **Auth:** routes use `Depends(get_current_user)`; no role gating (spec, audience).
- No em dashes in UI copy, comments, commits, docs.
- Frontend: npm only; the gate is `npm run typecheck && npx eslint <files> && npx prettier --check <files> && npx vitest run <files>`.
- Rich hovers use the shadcn `Tooltip` content-card pattern (`flex flex-col gap-1.5 p-3 text-xs font-mono`), never the native `title` beyond one word.
- Additive only: do not change existing endpoints' behavior. The existing `/explorer/customers*` routes stay as they are.

## Review Focus

1. **Guest customers:** checkout without an account (`customer_id` 0 or NULL), the same email in mixed case, and a guest who later registers. A guest must appear as `email:<addr>`, be clickable, and not merge with a registered `wc:` key. (Merging is a deliberate non-goal; documented.) Pinned in Task 1 and Task 2.
2. **Partially refunded orders count at net; a fully refunded order disappears.** A $1,000 order with a $1,000 refund must not count as an order or a customer's activity. Pinned in Task 2.
3. **Customers with exactly 1 or 2 testing orders:**
   - the usual gap falls back to 60 days below 3 orders;
   - at-risk requires 2+ testing orders;
   - 1 paid order = one-time.

   A brand-new customer must never show as "at risk". Pinned in Task 1.
4. **Period boundaries in lab time:** an order paid at 23:30 PT on the last day of a month belongs to that month, not the next (UTC). Pinned in Task 3.
5. **Empty and partial data:** no `wc_orders` rows yet (Plan 1 not run), a customer with orders but no COAs, and SLA records unavailable. Endpoints return 200 with zeros or `null`, never 500, and the page shows an empty state. Pinned in Task 2 and Task 6.

---

## File Structure

| File | Responsibility |
|---|---|
| `backend/test_accounts.py` (create) | `TEST_EMAILS` shared constant |
| `backend/customer_insights/__init__.py` (create) | package marker |
| `backend/customer_insights/rules.py` (create) | constants + pure rules (keys, exclusions, paid filter, gap, status, period resolution, lab-month) |
| `backend/customer_insights/dataset.py` (create) | dataclasses + `build_dataset(...)` pure assembly from raw rows |
| `backend/customer_insights/sources.py` (create) | SQL + `load_dataset(db, now)` with a 60 s cache |
| `backend/customer_insights/metrics.py` (create) | pure builders: `summary`, `cohorts`, `at_risk`, `customer_rows`, `dossier`, `churn_signals`, `changes`, `order_rows` |
| `backend/customer_insights/routes.py` (create) | pydantic models + router `/reports/customers` |
| `backend/sla_perf.py` (modify) | extract `sample_records(...)` (additive) |
| `backend/main.py` (modify) | include router; TEST_EMAILS import |
| `backend/tests/test_customer_insights_*.py` (create) | tests |
| `src/lib/api.ts` (modify) | types + client functions |
| `src/components/customers/insights-utils.ts` (+ test) (create) | money/format/period helpers |
| `src/components/customers/CustomerInsights.tsx` (+ test) (create) | Insights page |
| `src/components/customers/CustomerDashboard.tsx` (+ test) (create) | per-customer Dashboard tab |
| `src/components/CustomerStatusPage.tsx` (modify) | list columns, guest click, Dashboard tab, order money columns |
| `src/components/AccuMarkTools.tsx`, `src/components/layout/AppSidebar.tsx` (modify) | `customer-insights` sub-item |
| `e2e/customer-insights.spec.ts` (create) | stack e2e + screenshots |
| labmanager-mcp `src/labmanager_mcp/tools/reports.py` (+ test) (modify) | allowlist entries |

---

### Task 1: Rules (keys, exclusions, paid filter, gaps, status, periods)

**Files:**
- Create: `backend/test_accounts.py`, `backend/customer_insights/__init__.py`, `backend/customer_insights/rules.py`
- Modify: `backend/main.py:10321` and `backend/main.py:22750`. Replace the two inline `TEST_EMAILS` literals with `from test_accounts import TEST_EMAILS`, keeping the existing names. At `22750` a list was used; `TEST_EMAILS` is a set, and membership checks behave the same.
- Test: `backend/tests/test_customer_insights_rules.py`

**Interfaces:**
- Produces (all pure):
  - `customer_key(customer_id: int | None, email: str | None) -> str | None`
  - `is_excluded(key: str, *, exclude_launch: bool) -> bool`
  - `is_paid(status: str, date_paid: datetime | None) -> bool`
  - `usual_gap_days(dates: list[datetime]) -> float` (median gap; `DEFAULT_GAP_DAYS` when fewer than 3 dates)
  - `is_at_risk(dates: list[datetime], as_of: datetime) -> bool`
  - `overdue_ratio(dates: list[datetime], as_of: datetime) -> float`
  - `spend_status(*, paid_orders: int, at_risk: bool, period: Decimal, prior: Decimal) -> str` in `{"one_time", "at_risk", "dropping", "growing", "steady"}`
  - `resolve_period(period: str | None, start: date | None, end: date | None, now: datetime, tz: str) -> tuple[datetime | None, datetime]` (UTC bounds; `None` start = all time)
  - `lab_month(t: datetime, tz: str) -> str` (`"YYYY-MM"`)
  - constants `DEFAULT_GAP_DAYS = 60`, `AT_RISK_GAP_MULTIPLE = 2`, `AT_RISK_FLOOR_DAYS = 21`, `TREND_PCT = Decimal("0.40")`, `TREND_PRIOR_FLOOR = Decimal("500")`, `MATURITY_DAYS = 60`, `CHURN_WINDOW_DAYS = 60`, `INTERNAL_CUSTOMER_KEYS: frozenset[str]`, `LAUNCH_ACCOUNT_KEYS: frozenset[str]`, `UNPAID_STATUSES: frozenset[str]`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_customer_insights_rules.py
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `backend/`: `pytest tests/test_customer_insights_rules.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'customer_insights'`. The Mk1 backend pytest hits the host dev Postgres via conftest; run one suite at a time.

- [ ] **Step 3: Implement**

```python
# backend/test_accounts.py
"""Test/QA customer emails excluded from reports and the inbox. One copy (was 2 in main.py)."""
TEST_EMAILS: frozenset[str] = frozenset({"forrestp@outlook.com", "forrest@valenceanalytical.com"})
```

```python
# backend/customer_insights/__init__.py
```

```python
# backend/customer_insights/rules.py
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
# Filled from prod during Task 12 (read-only lookup): the two $0 internal Jan accounts
# and the five Feb launch accounts from the 2026-10-02 retention analysis.
INTERNAL_CUSTOMER_KEYS: frozenset[str] = frozenset()
LAUNCH_ACCOUNT_KEYS: frozenset[str] = frozenset()
PERIOD_DAYS = {"30d": 30, "90d": 90, "6m": 182, "1y": 365}


def customer_key(customer_id: int | None, email: str | None) -> str | None:
    if customer_id:
        return f"wc:{int(customer_id)}"
    e = (email or "").strip().lower()
    return f"email:{e}" if e else None


def is_excluded(key: str, *, exclude_launch: bool) -> bool:
    if key in INTERNAL_CUSTOMER_KEYS:
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
```

In `backend/main.py`, add `from test_accounts import TEST_EMAILS` near the other top-level imports (around line 41). Then delete the two local `TEST_EMAILS = ...` assignments at lines 10321 and 22750; the code below them keeps using the name.

- [ ] **Step 4: Run tests**

Run: `pytest tests/test_customer_insights_rules.py -q` → 8 passed. Then `grep -n "TEST_EMAILS =" main.py` → no output.

- [ ] **Step 5: Commit**

```bash
git add backend/test_accounts.py backend/customer_insights/__init__.py backend/customer_insights/rules.py backend/main.py backend/tests/test_customer_insights_rules.py
git commit -m "feat(customer-insights): rules module and shared TEST_EMAILS"
```

---

### Task 2: Dataset assembly and IS sources

**Files:**
- Create: `backend/customer_insights/dataset.py`, `backend/customer_insights/sources.py`
- Test: `backend/tests/test_customer_insights_dataset.py`

**Interfaces:**
- Consumes: Task 1 `customer_key`, `is_paid`.
- Produces:

```python
@dataclass(frozen=True)
class Customer: key: str; name: str; email: str | None; company: str | None; wc_id: int | None
@dataclass(frozen=True)
class Order:
    order_id: int; order_number: str; customer_key: str; paid_at: datetime
    net: Decimal; discount: Decimal; coupons: tuple[str, ...]; categories: tuple[str, ...]
    is_testing: bool; samples: int; tests: tuple[str, ...]   # one label per (sample, test)
    is_retest: bool; retest_of_order_id: int | None
@dataclass(frozen=True)
class Coa: order_number: str; sample_id: str; product: str; passed: bool; published_at: datetime
@dataclass(frozen=True)
class Dataset:
    customers: dict[str, Customer]; orders: tuple[Order, ...]   # sorted by paid_at
    coas: tuple[Coa, ...]; late_orders: frozenset[str] | None; delivered_orders: frozenset[str] | None
    synced_at: datetime | None
```

Also:
- `service_label(service_key: str) -> str | None`
- `build_dataset(*, order_rows, submission_rows, customer_rows, coa_rows, sla_records, synced_at) -> Dataset`
- `sources.load_dataset(db: Session, now: datetime) -> Dataset`, cached for 60 seconds.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_customer_insights_dataset.py
from datetime import datetime, timezone
from decimal import Decimal

from customer_insights.dataset import build_dataset, service_label

PAID = datetime(2026, 9, 10, 15, tzinfo=timezone.utc)


def order_row(id_, customer_id=1188, email="ops@h.example", total="100.00", refund="0.00",
              status="completed", paid=PAID, coupons=None, items=None):
    # columns: id, order_number, customer_id, billing_email, status, total, discount_total,
    #          refund_total, coupon_codes, line_items, date_paid_gmt
    return (id_, str(id_), customer_id, email, status, Decimal(total), Decimal("0.00"),
            Decimal(refund), coupons or [], items or [{"category": "testing"}], paid)


def sub_row(order_id, samples, is_retest=False, retest_of=None, is_transfer=False, billing=None):
    # columns: order_id, samples (payload->'samples'), is_retest, retest_of_order_id, is_transfer, billing
    return (order_id, samples, is_retest, retest_of, is_transfer, billing or {})


SAMPLE = {"services": {"hplcpurity&identity": True, "endotoxin": True, "residualsolvents": False}}


def build(order_rows, sub_rows=(), customers=(), coas=(), sla=None):
    return build_dataset(order_rows=order_rows, submission_rows=sub_rows, customer_rows=customers,
                         coa_rows=coas, sla_records=sla, synced_at=None)


def test_service_label() -> None:
    assert service_label("hplcpurity&identity") == "HPLC"
    assert service_label("rapidsterilityscreening(pcr)") == "Sterility"
    assert service_label("heavy_metals") == "Heavy metals"
    assert service_label("bacwaterpanel") == "Bac water panel"


def test_testing_order_net_and_tests() -> None:
    ds = build([order_row(1, refund="25.00")], [sub_row(1, [SAMPLE, SAMPLE])],
               customers=[(1188, "ops@h.example", "Ops", "Team", "Halcyon")])
    (o,) = ds.orders
    assert o.customer_key == "wc:1188" and o.is_testing and o.samples == 2
    assert o.net == Decimal("75.00")
    assert sorted(o.tests) == ["Endotoxin", "Endotoxin", "HPLC", "HPLC"]
    assert ds.customers["wc:1188"].name == "Ops Team"
    assert ds.customers["wc:1188"].company == "Halcyon"


def test_fully_refunded_and_unpaid_orders_drop_out() -> None:
    ds = build([order_row(1, refund="100.00"), order_row(2, status="pending"), order_row(3, paid=None)])
    assert ds.orders == ()


def test_acoa_only_order_is_paid_not_testing_and_transfer_is_not_testing() -> None:
    ds = build([order_row(1, items=[{"category": "additional_coa"}]), order_row(2)],
               [sub_row(2, [SAMPLE], is_transfer=True)])
    assert [o.is_testing for o in ds.orders] == [False, False]
    assert ds.orders[0].categories == ("additional_coa",)


def test_guest_named_from_submission_billing() -> None:
    ds = build([order_row(1, customer_id=0, email="Guest@X.com")],
               [sub_row(1, [SAMPLE], billing={"first_name": "Jo", "last_name": "Alvarez"})])
    assert ds.orders[0].customer_key == "email:guest@x.com"
    assert ds.customers["email:guest@x.com"].name == "Jo Alvarez"


def test_sla_records_map_to_orders_and_missing_sla_is_none() -> None:
    sla = [{"order": "1", "state": "delivered", "late": True},
           {"order": "1", "state": "delivered", "late": False},
           {"order": "2", "state": "open", "late": False}]
    ds = build([order_row(1)], sla=sla)
    assert ds.late_orders == frozenset({"1"}) and ds.delivered_orders == frozenset({"1"})
    assert build([order_row(1)]).late_orders is None


def test_empty_inputs() -> None:
    ds = build([])
    assert ds.orders == () and ds.customers == {}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_customer_insights_dataset.py -q` → FAIL (module missing).

- [ ] **Step 3: Implement `dataset.py`**

```python
# backend/customer_insights/dataset.py
"""In-memory Customer Insights dataset assembled from raw rows (pure; no I/O)."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any, Iterable

from customer_insights.rules import customer_key, is_paid

_LABELS = (
    ("hplc", "HPLC"), ("endotoxin", "Endotoxin"), ("steril", "Sterility"),
    ("solvent", "Residual solvents"), ("variance", "Variance"), ("bacwater", "Bac water panel"),
    ("heavy", "Heavy metals"),
)


@dataclass(frozen=True)
class Customer:
    key: str
    name: str
    email: str | None
    company: str | None
    wc_id: int | None


@dataclass(frozen=True)
class Order:
    order_id: int
    order_number: str
    customer_key: str
    paid_at: datetime
    net: Decimal
    discount: Decimal
    coupons: tuple[str, ...]
    categories: tuple[str, ...]
    is_testing: bool
    samples: int
    tests: tuple[str, ...]
    is_retest: bool
    retest_of_order_id: int | None


@dataclass(frozen=True)
class Coa:
    order_number: str
    sample_id: str
    product: str
    passed: bool
    published_at: datetime


@dataclass(frozen=True)
class Dataset:
    customers: dict[str, Customer]
    orders: tuple[Order, ...]
    coas: tuple[Coa, ...]
    late_orders: frozenset[str] | None
    delivered_orders: frozenset[str] | None
    synced_at: datetime | None


def service_label(service_key: str) -> str | None:
    k = (service_key or "").lower().replace("_", "").replace("-", "")
    return next((label for needle, label in _LABELS if needle in k), None)


def _sample_tests(sample: dict[str, Any]) -> list[str]:
    out: set[str] = set()
    for key, val in (sample.get("services") or {}).items():
        if isinstance(val, dict):
            val = any(val.values())
        if val and (label := service_label(key)):
            out.add(label)
    if sample.get("variance") or sample.get("variance_value"):
        out.add("Variance")
    return sorted(out)


def _name(first: str | None, last: str | None, fallback: str) -> str:
    return " ".join(p for p in (first, last) if p) or fallback


def build_dataset(
    *,
    order_rows: Iterable[tuple],
    submission_rows: Iterable[tuple],
    customer_rows: Iterable[tuple],
    coa_rows: Iterable[tuple],
    sla_records: Iterable[dict] | None,
    synced_at: datetime | None,
) -> Dataset:
    subs = {int(r[0]): r for r in submission_rows}
    customers: dict[str, Customer] = {}
    for cid, email, first, last, company in customer_rows:
        key = f"wc:{int(cid)}"
        customers[key] = Customer(key, _name(first, last, email or key), email, company or None, int(cid))

    orders: list[Order] = []
    for (oid, number, cid, email, status, total, discount, refund, coupons, items, paid) in order_rows:
        net = (total or Decimal(0)) - (refund or Decimal(0))
        key = customer_key(cid, email)
        if key is None or not is_paid(status, paid) or net <= 0:
            continue
        sub = subs.get(int(oid))
        samples = list((sub[1] if sub else None) or [])
        is_testing = bool(sub) and bool(samples) and not bool(sub[4])
        tests = tuple(t for s in samples for t in _sample_tests(s)) if is_testing else ()
        if key not in customers:
            billing = (sub[5] if sub else None) or {}
            customers[key] = Customer(
                key, _name(billing.get("first_name"), billing.get("last_name"), (email or "").lower()),
                (email or "").lower() or None, billing.get("company_name") or billing.get("company") or None,
                int(cid) if cid else None,
            )
        orders.append(Order(
            order_id=int(oid), order_number=str(number), customer_key=key, paid_at=paid,
            net=net.quantize(Decimal("0.01")), discount=(discount or Decimal(0)).quantize(Decimal("0.01")),
            coupons=tuple(c.lower() for c in coupons or []),
            categories=tuple(sorted({(i or {}).get("category", "testing") for i in items or []})),
            is_testing=is_testing, samples=len(samples) if is_testing else 0, tests=tests,
            is_retest=bool(sub[2]) if sub else False, retest_of_order_id=int(sub[3]) if sub and sub[3] else None,
        ))
    orders.sort(key=lambda o: o.paid_at)

    coas = tuple(Coa(str(n), str(s), p or "", (st or "").upper() == "PASSED", at) for n, s, p, st, at in coa_rows if n)

    late = delivered = None
    if sla_records is not None:
        recs = [r for r in sla_records if r.get("order") and r.get("state") == "delivered"]
        delivered = frozenset(r["order"] for r in recs)
        late = frozenset(r["order"] for r in recs if r.get("late"))
    return Dataset(customers, tuple(orders), coas, late, delivered, synced_at)
```

- [ ] **Step 4: Implement `sources.py`**

```python
# backend/customer_insights/sources.py
"""SQL readers + 60 s cached Dataset loader. IS DB via get_integration_db (psycopg2)."""
from __future__ import annotations

import threading
import time
from datetime import datetime

from sqlalchemy.orm import Session

from customer_insights.dataset import Dataset, build_dataset
from customer_insights.rules import UNPAID_STATUSES
from integration_db import get_integration_db

WC_ORDERS_SQL = """
    SELECT id, order_number, customer_id, billing_email, status, total, discount_total,
           refund_total, coupon_codes, line_items, date_paid_gmt
    FROM wc_orders
    WHERE date_paid_gmt IS NOT NULL AND status <> ALL(%s)
"""
SUBMISSIONS_SQL = """
    SELECT order_id::bigint, payload->'samples', COALESCE(is_retest, false),
           retest_of_order_id, COALESCE(is_transfer, false), payload->'billing'
    FROM order_submissions
    WHERE order_id ~ '^[0-9]+$'
"""
CUSTOMERS_SQL = "SELECT id, email, first_name, last_name, company_name FROM wc_customers WHERE deleted_at IS NULL"
# Published PRIMARY COAs only (same rule as Analyte Trends): one row per COA.
COAS_SQL = """
    SELECT DISTINCT ON (r.verification_code)
           r.order_number, r.sample_id, r.product_name, r.overall_status, r.published_at
    FROM published_coa_results r
    JOIN coa_generations cg ON cg.id = r.coa_generation_id
    WHERE cg.status = 'published' AND cg.parent_generation_id IS NULL
      AND (r.is_blend_overall OR NOT r.is_blend)
    ORDER BY r.verification_code, r.id
"""
SYNCED_SQL = "SELECT max(synced_at) FROM wc_orders"

_CACHE_SECONDS = 60
_cache: dict[str, tuple[float, Dataset]] = {}
_lock = threading.Lock()


def _sla_records(db: Session, now: datetime) -> list[dict] | None:
    """Per-sample SLA records (Task 7 adds sla_perf.sample_records). None until then / on failure."""
    try:
        from sla_perf import sample_records  # noqa: F401  (added in Task 7)
    except ImportError:
        return None
    import main  # local: main imports this package's router

    try:
        return main.sla_sample_records(db, now)
    except Exception:
        return None


def load_dataset(db: Session, now: datetime) -> Dataset:
    with _lock:
        hit = _cache.get("ds")
        if hit and time.monotonic() - hit[0] < _CACHE_SECONDS:
            return hit[1]
    with get_integration_db() as conn, conn.cursor() as cur:
        try:
            cur.execute(WC_ORDERS_SQL, (list(UNPAID_STATUSES),))
            order_rows = cur.fetchall()
            cur.execute(SYNCED_SQL)
            synced_at = cur.fetchone()[0]
        except Exception:  # wc_orders not migrated yet (Plan 1 pending): empty, not 500
            conn.rollback()
            order_rows, synced_at = [], None
        cur.execute(SUBMISSIONS_SQL)
        sub_rows = cur.fetchall()
        cur.execute(CUSTOMERS_SQL)
        cust_rows = cur.fetchall()
        cur.execute(COAS_SQL)
        coa_rows = cur.fetchall()
    ds = build_dataset(order_rows=order_rows, submission_rows=sub_rows, customer_rows=cust_rows,
                       coa_rows=coa_rows, sla_records=_sla_records(db, now), synced_at=synced_at)
    with _lock:
        _cache["ds"] = (time.monotonic(), ds)
    return ds


def clear_cache() -> None:
    with _lock:
        _cache.clear()
```

Before running, verify the IS column names against the IS DB:
- `order_submissions.order_id` is text or int;
- `is_retest`, `retest_of_order_id`, `is_transfer` exist;
- `published_coa_results.order_number`, `is_blend`, `is_blend_overall` exist.

Check with `docker exec -i -e PGPASSWORD=... terravex-postgres-1 psql -h host.docker.internal -U postgres -d accumark_integration -c "\d order_submissions"`. If `order_id` is already bigint, drop the regex filter and the cast.

- [ ] **Step 5: Run tests**

Run: `pytest tests/test_customer_insights_dataset.py -q` → 6 passed.
Then smoke the SQL on the local IS DB, which needs Plan 1's migration:

```bash
python -c "from customer_insights import sources; from integration_db import get_integration_db
with get_integration_db() as c, c.cursor() as cur:
    [cur.execute(q, *( [(list(sources.UNPAID_STATUSES),)] if '%s' in q else [] )) or print(len(cur.fetchall())) for q in (sources.WC_ORDERS_SQL, sources.SUBMISSIONS_SQL, sources.CUSTOMERS_SQL, sources.COAS_SQL)]"
```

Expected: four row counts, no exception.

- [ ] **Step 6: Commit**

```bash
git add backend/customer_insights/dataset.py backend/customer_insights/sources.py backend/tests/test_customer_insights_dataset.py
git commit -m "feat(customer-insights): dataset assembly and IS sources with 60s cache"
```

---

### Task 3: Metrics: summary and cohorts

**Files:**
- Create: `backend/customer_insights/metrics.py`
- Test: `backend/tests/test_customer_insights_metrics.py` (this task adds the fixture helper `ds(...)` and summary/cohort tests; later tasks append to this file)

**Interfaces:**
- Consumes: `Dataset`, `Order`, `Customer`, `Coa` (Task 2); Task 1 rules.
- Produces:
  - `scope(ds: Dataset, *, exclude_launch: bool) -> Dataset`, with excluded customers removed;
  - `summary(ds, *, start: datetime | None, end: datetime, tz: str) -> dict`;
  - `cohorts(ds, *, end: datetime, tz: str, max_months: int = 12) -> dict`;
  - helpers `money(d: Decimal) -> str` and `testing_dates(ds) -> dict[str, list[datetime]]`.

Shapes:

```python
summary -> {
  "kpis": {"active_customers": {"value": int, "prior": int}, "revenue": {"value": str, "prior": str},
           "paid_orders": {...int}, "aov": {...str}, "repeat_rate": {"value": float|None, "prior": float|None},
           "median_days_to_second": {"value": float|None, "prior": float|None}},
  "revenue_by_month": [{"month": "YYYY-MM", "new": str, "returning": str}],
  "concentration": {"top10_share": float, "top_decile_share": float, "repeat_share": float,
                    "median_ltv": str, "mean_ltv": str, "customers": int},
  "attach": [{"test": str, "new": float, "returning": float}],      # share of testing orders
  "first_order": [{"kind": "accutry50"|"other_coupon"|"with_addon"|"full_price", "customers": int, "repeat_rate": float|None}],
}
cohorts -> {"months": ["YYYY-MM", ...], "rows": [{"cohort": "YYYY-MM", "size": int, "cells": [float|None, ...]}]}
```

Here `cells[k]` = the share of the cohort with a testing order in cohort month + k + 1 (M1..), and `None` for months not yet reached.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_customer_insights_metrics.py
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from customer_insights import metrics
from customer_insights.dataset import Customer, Dataset, Order

TZ = "America/Los_Angeles"
T0 = datetime(2026, 3, 10, 18, tzinfo=timezone.utc)


def o(key, day, net="100", testing=True, tests=("HPLC",), coupons=(), oid=None, number=None,
      retest_of=None, categories=("testing",)):
    oid = oid or abs(hash((key, day))) % 10**9
    return Order(order_id=oid, order_number=number or str(oid), customer_key=key,
                 paid_at=T0 + timedelta(days=day), net=Decimal(net), discount=Decimal(0),
                 coupons=tuple(coupons), categories=tuple(categories), is_testing=testing,
                 samples=1 if testing else 0, tests=tuple(tests) if testing else (),
                 is_retest=retest_of is not None, retest_of_order_id=retest_of)


def ds(orders, coas=(), late=None, delivered=None):
    keys = {x.customer_key for x in orders}
    customers = {k: Customer(k, k.upper(), None, None, None) for k in keys}
    return Dataset(customers, tuple(sorted(orders, key=lambda x: x.paid_at)), tuple(coas),
                   late, delivered, None)


def test_summary_kpis_and_new_vs_returning() -> None:
    data = ds([o("wc:1", 0, "100"), o("wc:1", 25, "300"), o("wc:2", 26, "50", coupons=("accutry50",))])
    end = T0 + timedelta(days=100)
    out = metrics.summary(data, start=T0 - timedelta(days=1), end=end, tz=TZ)
    k = out["kpis"]
    assert k["active_customers"]["value"] == 2
    assert k["revenue"]["value"] == "450.00"
    assert k["paid_orders"]["value"] == 3
    assert k["aov"]["value"] == "150.00"
    assert k["repeat_rate"]["value"] == 0.5          # both matured (first order >= 60 d before end)
    assert k["median_days_to_second"]["value"] == 25.0
    months = {m["month"]: m for m in out["revenue_by_month"]}
    assert months["2026-03"] == {"month": "2026-03", "new": "100.00", "returning": "0.00"}
    assert months["2026-04"] == {"month": "2026-04", "new": "50.00", "returning": "300.00"}
    first = {r["kind"]: r for r in out["first_order"]}
    assert first["accutry50"]["customers"] == 1 and first["accutry50"]["repeat_rate"] == 0.0


def test_summary_empty_is_zeros_not_error() -> None:
    out = metrics.summary(ds([]), start=None, end=T0, tz=TZ)
    assert out["kpis"]["revenue"]["value"] == "0.00"
    assert out["kpis"]["repeat_rate"]["value"] is None
    assert out["concentration"]["customers"] == 0


def test_immature_customers_excluded_from_repeat_rate() -> None:
    data = ds([o("wc:1", 0), o("wc:1", 5)])
    out = metrics.summary(data, start=None, end=T0 + timedelta(days=30), tz=TZ)
    assert out["kpis"]["repeat_rate"]["value"] is None   # first order only 30 d before end


def test_cohorts_shares_and_future_cells() -> None:
    data = ds([o("wc:1", 0), o("wc:1", 35), o("wc:2", 2)])  # both cohort 2026-03; wc:1 back in April
    out = metrics.cohorts(data, end=T0 + timedelta(days=40), tz=TZ)
    (row,) = out["rows"]
    assert row["cohort"] == "2026-03" and row["size"] == 2
    assert row["cells"][0] == 0.5     # M1 = April
    assert row["cells"][1] is None    # May not reached yet


def test_non_testing_orders_ignored_for_reorders() -> None:
    data = ds([o("wc:1", 0), o("wc:1", 10, testing=False, categories=("additional_coa",))])
    out = metrics.summary(data, start=None, end=T0 + timedelta(days=100), tz=TZ)
    assert out["kpis"]["repeat_rate"]["value"] == 0.0
    assert out["kpis"]["paid_orders"]["value"] == 2
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_customer_insights_metrics.py -q` → FAIL (module missing).

- [ ] **Step 3: Implement** (`metrics.py`, first part)

```python
# backend/customer_insights/metrics.py
"""Pure Customer Insights builders. Everything takes (Dataset, as-of bounds, tz)."""
from __future__ import annotations

import statistics
from collections import Counter, defaultdict
from dataclasses import replace
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

from customer_insights import rules
from customer_insights.dataset import Dataset, Order

ZERO = Decimal("0.00")
ADDON_TESTS = ("Endotoxin", "Sterility", "Heavy metals", "Variance")


def money(d: Decimal) -> str:
    return str(Decimal(d).quantize(Decimal("0.01")))


def scope(ds: Dataset, *, exclude_launch: bool) -> Dataset:
    keep = [o for o in ds.orders if not rules.is_excluded(o.customer_key, exclude_launch=exclude_launch)]
    keys = {o.customer_key for o in keep}
    return replace(ds, orders=tuple(keep), customers={k: c for k, c in ds.customers.items() if k in keys})


def _upto(ds: Dataset, end: datetime) -> list[Order]:
    return [o for o in ds.orders if o.paid_at <= end]


def testing_dates(ds: Dataset, end: datetime | None = None) -> dict[str, list[datetime]]:
    out: dict[str, list[datetime]] = defaultdict(list)
    for o in ds.orders:
        if o.is_testing and (end is None or o.paid_at <= end):
            out[o.customer_key].append(o.paid_at)
    return out


def _repeat_stats(ds: Dataset, end: datetime) -> tuple[float | None, float | None]:
    dates = testing_dates(ds, end)
    mature = [d for d in dates.values() if (end - d[0]).days >= rules.MATURITY_DAYS]
    rate = round(sum(len(d) >= 2 for d in mature) / len(mature), 4) if mature else None
    seconds = [(d[1] - d[0]).total_seconds() / 86400 for d in dates.values() if len(d) >= 2]
    return rate, (round(statistics.median(seconds), 1) if seconds else None)


def _window(ds: Dataset, start: datetime | None, end: datetime) -> list[Order]:
    return [o for o in ds.orders if (start is None or o.paid_at >= start) and o.paid_at <= end]


def _kpis(ds: Dataset, start: datetime | None, end: datetime) -> dict[str, Any]:
    win = _window(ds, start, end)
    revenue = sum((o.net for o in win), ZERO)
    rate, median2 = _repeat_stats(ds, end)
    return {"active": len({o.customer_key for o in win}), "revenue": revenue, "orders": len(win),
            "aov": revenue / len(win) if win else ZERO, "repeat": rate, "median2": median2}


def summary(ds: Dataset, *, start: datetime | None, end: datetime, tz: str) -> dict[str, Any]:
    cur = _kpis(ds, start, end)
    prior = _kpis(ds, start - (end - start), start) if start else None

    def pair(k: str, fmt=lambda v: v) -> dict[str, Any]:
        return {"value": fmt(cur[k]), "prior": fmt(prior[k]) if prior else None}

    first_paid: dict[str, str] = {}
    for x in ds.orders:
        first_paid.setdefault(x.customer_key, rules.lab_month(x.paid_at, tz))
    by_month: dict[str, dict[str, Decimal]] = defaultdict(lambda: {"new": ZERO, "returning": ZERO})
    for x in _window(ds, start, end):
        m = rules.lab_month(x.paid_at, tz)
        by_month[m]["new" if first_paid[x.customer_key] == m else "returning"] += x.net

    paid_keys = {x.customer_key for x in _upto(ds, end)}  # customers WITH orders (not every wc_customers row)
    ltv = sorted((sum((x.net for x in _upto(ds, end) if x.customer_key == k), ZERO) for k in paid_keys), reverse=True)
    total = sum(ltv, ZERO)
    dates = testing_dates(ds, end)
    repeaters = {k for k, d in dates.items() if len(d) >= 2}
    repeat_rev = sum((x.net for x in _upto(ds, end) if x.customer_key in repeaters), ZERO)
    decile = max(1, len(ltv) // 10) if ltv else 0

    def share(part: Decimal) -> float:
        return round(float(part / total), 4) if total else 0.0

    testing = [x for x in _upto(ds, end) if x.is_testing]
    first_ids = {d[0] for d in dates.values()}
    attach = []
    for t in ADDON_TESTS + ("Additional COAs",):
        def has(x: Order) -> bool:
            return "additional_coa" in x.categories if t == "Additional COAs" else t in x.tests
        new = [x for x in testing if x.paid_at in first_ids]
        ret = [x for x in testing if x.paid_at not in first_ids]
        attach.append({"test": t,
                       "new": round(sum(map(has, new)) / len(new), 4) if new else 0.0,
                       "returning": round(sum(map(has, ret)) / len(ret), 4) if ret else 0.0})

    kinds: dict[str, list[bool]] = defaultdict(list)
    for k, d in dates.items():
        if (end - d[0]).days < rules.MATURITY_DAYS:
            continue
        first = next(x for x in testing if x.customer_key == k and x.paid_at == d[0])
        if "accutry50" in first.coupons:
            kind = "accutry50"
        elif first.coupons:
            kind = "other_coupon"
        elif any(t in first.tests for t in ADDON_TESTS):
            kind = "with_addon"
        else:
            kind = "full_price"
        kinds[kind].append(len(d) >= 2)

    return {
        "kpis": {
            "active_customers": pair("active"), "revenue": pair("revenue", money),
            "paid_orders": pair("orders"), "aov": pair("aov", money),
            "repeat_rate": pair("repeat"), "median_days_to_second": pair("median2"),
        },
        "revenue_by_month": [{"month": m, "new": money(v["new"]), "returning": money(v["returning"])}
                             for m, v in sorted(by_month.items())],
        "concentration": {
            "top10_share": share(sum(ltv[:10], ZERO)), "top_decile_share": share(sum(ltv[:decile], ZERO)),
            "repeat_share": share(repeat_rev), "customers": len(ltv),
            "median_ltv": money(Decimal(statistics.median(ltv)) if ltv else ZERO),
            "mean_ltv": money(total / len(ltv) if ltv else ZERO),
        },
        "attach": attach,
        "first_order": [{"kind": kind, "customers": len(kinds.get(kind, [])),
                         "repeat_rate": round(sum(kinds[kind]) / len(kinds[kind]), 4) if kinds.get(kind) else None}
                        for kind in ("accutry50", "other_coupon", "full_price", "with_addon")],
    }


def _month_add(ym: str, n: int) -> str:
    y, m = map(int, ym.split("-"))
    m += n
    return f"{y + (m - 1) // 12:04d}-{(m - 1) % 12 + 1:02d}"


def cohorts(ds: Dataset, *, end: datetime, tz: str, max_months: int = 12) -> dict[str, Any]:
    months_by_key: dict[str, set[str]] = defaultdict(set)
    first: dict[str, str] = {}
    for x in ds.orders:
        if x.is_testing and x.paid_at <= end:
            m = rules.lab_month(x.paid_at, tz)
            first.setdefault(x.customer_key, m)
            months_by_key[x.customer_key].add(m)
    now_m = rules.lab_month(end, tz)
    groups: dict[str, list[str]] = defaultdict(list)
    for k, m in first.items():
        groups[m].append(k)
    rows = []
    for cohort in sorted(groups):
        members = groups[cohort]
        cells: list[float | None] = []
        for k in range(1, max_months + 1):
            target = _month_add(cohort, k)
            if target > now_m:
                cells.append(None)
                continue
            cells.append(round(sum(target in months_by_key[c] for c in members) / len(members), 4))
        rows.append({"cohort": cohort, "size": len(members), "cells": cells})
    return {"months": [f"M{k}" for k in range(1, max_months + 1)], "rows": rows}
```

- [ ] **Step 4: Run tests**

Run: `pytest tests/test_customer_insights_metrics.py -q` → 5 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/customer_insights/metrics.py backend/tests/test_customer_insights_metrics.py
git commit -m "feat(customer-insights): summary and cohort builders"
```

---

### Task 4: Metrics: customer rows, at-risk, order rows

**Files:**
- Modify: `backend/customer_insights/metrics.py` (append)
- Test: `backend/tests/test_customer_insights_metrics.py` (append)

**Interfaces:**
- Produces:
  - `customer_rows(ds, *, start: datetime | None, end: datetime, tz: str) -> list[dict]`, where each row is `{key, name, email, company, period_spend: str, prior_spend: str, delta_pct: float|None, lifetime: str, orders: int, samples: int, usual_gap_days: float|None, last_order_at: str|None, top_tests: list[str], status: str, monthly: list[{"month": str, "spend": str}]}`;
  - `at_risk(ds, *, end: datetime, tz: str) -> list[dict]`: rows with status `at_risk`, plus `spend_12m: str` and `overdue: float`, sorted by `spend_12m` desc;
  - `order_rows(ds, *, start: datetime | None, end: datetime) -> list[dict]`: `{customer_key, order_id, order_number, paid_at, net, discount, coupons, categories, samples, tests}`.

`usual_gap_days` is `None` (rendered "n/a") for customers with fewer than 3 testing orders; the rules fallback of 60 still drives at-risk.

- [ ] **Step 1: Append the failing tests**

```python
def test_customer_rows_status_and_gap() -> None:
    weekly = [o("wc:1", d, "100") for d in (0, 7, 14, 21)]
    data = ds(weekly + [o("wc:2", 0, "125")])
    end = T0 + timedelta(days=60)
    rows = {r["key"]: r for r in metrics.customer_rows(data, start=end - timedelta(days=30), end=end, tz=TZ)}
    assert rows["wc:1"]["status"] == "at_risk"
    assert rows["wc:1"]["usual_gap_days"] == 7.0
    assert rows["wc:1"]["top_tests"] == ["HPLC"]
    assert rows["wc:2"]["status"] == "one_time"
    assert rows["wc:2"]["usual_gap_days"] is None


def test_new_customer_with_two_orders_is_not_at_risk_early() -> None:
    data = ds([o("wc:9", 0), o("wc:9", 3)])
    end = T0 + timedelta(days=20)
    (row,) = metrics.customer_rows(data, start=None, end=end, tz=TZ)
    assert row["status"] != "at_risk"   # 17 d since last < max(2*60, 21)


def test_at_risk_sorted_by_12m_spend() -> None:
    a = [o("wc:1", d, "100") for d in (0, 7, 14)]
    b = [o("wc:2", d, "900") for d in (0, 7, 14)]
    out = metrics.at_risk(ds(a + b), end=T0 + timedelta(days=200), tz=TZ)
    assert [r["key"] for r in out] == ["wc:2", "wc:1"]
    assert out[0]["spend_12m"] == "2700.00"


def test_order_rows_window() -> None:
    data = ds([o("wc:1", 0, oid=5, number="5"), o("wc:1", 50, oid=6, number="6")])
    rows = metrics.order_rows(data, start=T0 + timedelta(days=10), end=T0 + timedelta(days=100))
    assert [r["order_number"] for r in rows] == ["6"]
    assert rows[0]["net"] == "100.00"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_customer_insights_metrics.py -q` → 4 new failures (`AttributeError`).

- [ ] **Step 3: Implement** (append to `metrics.py`)

```python
def _spend(orders: list[Order], start: datetime | None, end: datetime) -> Decimal:
    return sum((o.net for o in orders if (start is None or o.paid_at >= start) and o.paid_at <= end), ZERO)


def _by_customer(ds: Dataset, end: datetime) -> dict[str, list[Order]]:
    out: dict[str, list[Order]] = defaultdict(list)
    for x in ds.orders:
        if x.paid_at <= end:
            out[x.customer_key].append(x)
    return out


def customer_rows(ds: Dataset, *, start: datetime | None, end: datetime, tz: str) -> list[dict[str, Any]]:
    rows = []
    span = (end - start) if start else timedelta(days=90)
    p_start = start or end - span
    for key, orders in _by_customer(ds, end).items():
        c = ds.customers.get(key)
        dates = [x.paid_at for x in orders if x.is_testing]
        period = _spend(orders, p_start, end)
        prior = _spend(orders, p_start - span, p_start)
        risk = rules.is_at_risk(dates, end)
        monthly: dict[str, Decimal] = defaultdict(lambda: ZERO)
        for x in orders:
            monthly[rules.lab_month(x.paid_at, tz)] += x.net
        tests = Counter(t for x in orders for t in x.tests)
        rows.append({
            "key": key, "name": c.name if c else key, "email": c.email if c else None,
            "company": c.company if c else None,
            "period_spend": money(period), "prior_spend": money(prior),
            "delta_pct": round(float((period - prior) / prior), 4) if prior else None,
            "lifetime": money(_spend(orders, None, end)), "orders": len(orders),
            "samples": sum(x.samples for x in orders),
            "usual_gap_days": round(rules.usual_gap_days(dates), 1) if len(dates) >= 3 else None,
            "last_order_at": max(dates).isoformat() if dates else None,
            "top_tests": [t for t, _ in tests.most_common(3)],
            "status": rules.spend_status(paid_orders=len(orders), at_risk=risk, period=period, prior=prior),
            "monthly": [{"month": m, "spend": money(v)} for m, v in sorted(monthly.items())],
        })
    return rows


def at_risk(ds: Dataset, *, end: datetime, tz: str) -> list[dict[str, Any]]:
    rows = [r for r in customer_rows(ds, start=end - timedelta(days=90), end=end, tz=tz) if r["status"] == "at_risk"]
    by = _by_customer(ds, end)
    for r in rows:
        r["spend_12m"] = money(_spend(by[r["key"]], end - timedelta(days=365), end))
        r["overdue"] = rules.overdue_ratio([x.paid_at for x in by[r["key"]] if x.is_testing], end)
    return sorted(rows, key=lambda r: Decimal(r["spend_12m"]), reverse=True)


def order_rows(ds: Dataset, *, start: datetime | None, end: datetime) -> list[dict[str, Any]]:
    return [{
        "customer_key": x.customer_key, "order_id": x.order_id, "order_number": x.order_number,
        "paid_at": x.paid_at.isoformat(), "net": money(x.net), "discount": money(x.discount),
        "coupons": list(x.coupons), "categories": list(x.categories), "samples": x.samples,
        "tests": sorted(set(x.tests)),
    } for x in _window(ds, start, end)]
```

- [ ] **Step 4: Run tests**

Run: `pytest tests/test_customer_insights_metrics.py -q` → 9 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/customer_insights/metrics.py backend/tests/test_customer_insights_metrics.py
git commit -m "feat(customer-insights): customer rows, at-risk and order rows"
```

---

### Task 5: Router: summary, cohorts, at-risk, list, orders

**Files:**
- Create: `backend/customer_insights/routes.py`
- Modify: `backend/main.py` (import + `app.include_router(customer_insights_router)` next to `app.include_router(priority_router)` at about line 621)
- Test: `backend/tests/test_customer_insights_routes.py`

**Interfaces:**
- Consumes: `sources.load_dataset`, Task 3/4 builders, `rules.resolve_period`, `scheduled_publish.lab_tz`.
- Produces: `GET /reports/customers/summary|cohorts|at-risk|list|orders`. Common query params:
  - `period: Literal["30d","90d","6m","1y","all"] = "90d"`
  - `start: date | None`, `end: date | None`
  - `exclude_launch_accounts: bool | None`. `None` means the route default: cohorts true, others false.

`list` adds `search`, `sort` (a field of the row; default `period_spend`), `dir` (`asc|desc`), `page` (1-based) and `page_size` (≤ 200), and returns `{rows, total, page, page_size}`. `orders` adds `format: Literal["json","csv"]`. Every response carries `tz` and `synced_at`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_customer_insights_routes.py
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from auth import get_current_user
from customer_insights import routes, sources
from customer_insights.dataset import Customer, Dataset, Order
from database import get_db

NOW = datetime(2026, 10, 5, 18, tzinfo=timezone.utc)


def _o(key, days_ago, net="100", oid=1):
    return Order(oid, str(oid), key, NOW - timedelta(days=days_ago), Decimal(net), Decimal(0),
                 ("accutry50",), ("testing",), True, 2, ("HPLC", "Endotoxin"), False, None)


DS = Dataset(
    {"wc:1": Customer("wc:1", "Halcyon", "ops@h.example", "Halcyon", 1),
     "email:g@x.com": Customer("email:g@x.com", "Jo", "g@x.com", None, None)},
    (_o("wc:1", 200, oid=1), _o("wc:1", 190, oid=2), _o("wc:1", 180, oid=3), _o("email:g@x.com", 10, "125", oid=4)),
    (), None, None, NOW,
)


@pytest.fixture()
def client(monkeypatch):
    import main

    monkeypatch.setattr(sources, "load_dataset", lambda db, now: DS)
    monkeypatch.setattr(routes, "_now", lambda: NOW)
    monkeypatch.setattr(routes, "_tz", lambda db: "America/Los_Angeles")
    main.app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    main.app.dependency_overrides[get_db] = lambda: None
    yield TestClient(main.app)
    main.app.dependency_overrides.clear()


def test_summary_serializes_nested_fields(client) -> None:
    body = client.get("/reports/customers/summary?period=1y").json()
    assert body["tz"] == "America/Los_Angeles"
    assert body["kpis"]["revenue"]["value"] == "425.00"
    assert {"month", "new", "returning"} <= set(body["revenue_by_month"][0])
    assert {"top10_share", "median_ltv"} <= set(body["concentration"])
    assert body["first_order"][0]["kind"] == "accutry50"


def test_list_paging_search_and_guest_key(client) -> None:
    body = client.get("/reports/customers/list?period=all&search=jo&page_size=1").json()
    assert body["total"] == 1
    (row,) = body["rows"]
    assert row["key"] == "email:g@x.com" and row["status"] == "one_time"
    assert row["monthly"][0]["spend"] == "125.00"


def test_at_risk_and_cohorts(client) -> None:
    risk = client.get("/reports/customers/at-risk").json()
    assert [r["key"] for r in risk["rows"]] == ["wc:1"]
    assert risk["rows"][0]["overdue"] > 1
    coh = client.get("/reports/customers/cohorts").json()
    assert coh["rows"][0]["size"] >= 1 and len(coh["rows"][0]["cells"]) == 12


def test_orders_csv(client) -> None:
    r = client.get("/reports/customers/orders?period=all&format=csv")
    assert r.headers["content-type"].startswith("text/csv")
    assert r.text.splitlines()[0].startswith("customer_key,order_id,order_number,paid_at,net")
    assert len(r.text.splitlines()) == 5


def test_bad_period_is_422(client) -> None:
    assert client.get("/reports/customers/summary?period=2w").status_code == 422
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_customer_insights_routes.py -q` → FAIL (404 / import error).

- [ ] **Step 3: Implement `routes.py`**

```python
# backend/customer_insights/routes.py
"""/reports/customers/* API (spec section 4). Shared by the UI and labmanager-mcp."""
from __future__ import annotations

import csv
import io
from datetime import date, datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import get_current_user
from customer_insights import metrics, rules, sources
from database import get_db

router = APIRouter(prefix="/reports/customers", tags=["customer-insights"])
Period = Literal["30d", "90d", "6m", "1y", "all"]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _tz(db: Session) -> str:
    import scheduled_publish as _sp
    return _sp.lab_tz(db)


class KpiInt(BaseModel):
    value: int
    prior: Optional[int] = None


class KpiMoney(BaseModel):
    value: str
    prior: Optional[str] = None


class KpiFloat(BaseModel):
    value: Optional[float] = None
    prior: Optional[float] = None


class Kpis(BaseModel):
    active_customers: KpiInt
    revenue: KpiMoney
    paid_orders: KpiInt
    aov: KpiMoney
    repeat_rate: KpiFloat
    median_days_to_second: KpiFloat


class MonthRevenue(BaseModel):
    month: str
    new: str
    returning: str


class Concentration(BaseModel):
    top10_share: float
    top_decile_share: float
    repeat_share: float
    median_ltv: str
    mean_ltv: str
    customers: int


class Attach(BaseModel):
    test: str
    new: float
    returning: float


class FirstOrder(BaseModel):
    kind: str
    customers: int
    repeat_rate: Optional[float] = None


class Meta(BaseModel):
    tz: str
    synced_at: Optional[str] = None


class SummaryResponse(Meta):
    kpis: Kpis
    revenue_by_month: list[MonthRevenue]
    concentration: Concentration
    attach: list[Attach]
    first_order: list[FirstOrder]


class CohortRow(BaseModel):
    cohort: str
    size: int
    cells: list[Optional[float]]


class CohortsResponse(Meta):
    months: list[str]
    rows: list[CohortRow]


class MonthSpend(BaseModel):
    month: str
    spend: str


class CustomerRow(BaseModel):
    key: str
    name: str
    email: Optional[str] = None
    company: Optional[str] = None
    period_spend: str
    prior_spend: str
    delta_pct: Optional[float] = None
    lifetime: str
    orders: int
    samples: int
    usual_gap_days: Optional[float] = None
    last_order_at: Optional[str] = None
    top_tests: list[str]
    status: str
    monthly: list[MonthSpend]


class AtRiskRow(CustomerRow):
    spend_12m: str
    overdue: float


class AtRiskResponse(Meta):
    rows: list[AtRiskRow]


class ListResponse(Meta):
    rows: list[CustomerRow]
    total: int
    page: int
    page_size: int


class OrderRow(BaseModel):
    customer_key: str
    order_id: int
    order_number: str
    paid_at: str
    net: str
    discount: str
    coupons: list[str]
    categories: list[str]
    samples: int
    tests: list[str]


class OrdersResponse(Meta):
    rows: list[OrderRow]
    total: int
    page: int
    page_size: int


def _ctx(db: Session, period: Optional[str], start: Optional[date], end: Optional[date], exclude: bool):
    now, tz = _now(), _tz(db)
    lo, hi = rules.resolve_period(period, start, end, now, tz)
    ds = metrics.scope(sources.load_dataset(db, now), exclude_launch=exclude)
    meta = {"tz": tz, "synced_at": ds.synced_at.isoformat() if ds.synced_at else None}
    return ds, lo, hi, tz, meta


@router.get("/summary", response_model=SummaryResponse)
def customers_summary(period: Period = "90d", start: Optional[date] = None, end: Optional[date] = None,
                      exclude_launch_accounts: bool = False, db: Session = Depends(get_db),
                      _u=Depends(get_current_user)):
    ds, lo, hi, tz, meta = _ctx(db, period, start, end, exclude_launch_accounts)
    return {**meta, **metrics.summary(ds, start=lo, end=hi, tz=tz)}


@router.get("/cohorts", response_model=CohortsResponse)
def customers_cohorts(exclude_launch_accounts: bool = True, db: Session = Depends(get_db),
                      _u=Depends(get_current_user)):
    ds, _lo, hi, tz, meta = _ctx(db, "all", None, None, exclude_launch_accounts)
    return {**meta, **metrics.cohorts(ds, end=hi, tz=tz)}


@router.get("/at-risk", response_model=AtRiskResponse)
def customers_at_risk(exclude_launch_accounts: bool = False, db: Session = Depends(get_db),
                      _u=Depends(get_current_user)):
    ds, _lo, hi, tz, meta = _ctx(db, "all", None, None, exclude_launch_accounts)
    return {**meta, "rows": metrics.at_risk(ds, end=hi, tz=tz)}


@router.get("/list", response_model=ListResponse)
def customers_list(period: Period = "90d", start: Optional[date] = None, end: Optional[date] = None,
                   exclude_launch_accounts: bool = False, search: str = "", sort: str = "period_spend",
                   dir: Literal["asc", "desc"] = "desc", page: int = Query(1, ge=1),
                   page_size: int = Query(50, ge=1, le=200), db: Session = Depends(get_db),
                   _u=Depends(get_current_user)):
    ds, lo, hi, tz, meta = _ctx(db, period, start, end, exclude_launch_accounts)
    rows = metrics.customer_rows(ds, start=lo, end=hi, tz=tz)
    q = search.strip().lower()
    if q:
        rows = [r for r in rows if q in " ".join(str(r.get(f) or "") for f in ("name", "email", "company", "key")).lower()]
    money_fields = {"period_spend", "prior_spend", "lifetime"}

    def keyf(r):
        v = r.get(sort)
        if sort in money_fields:
            return float(v)
        return (v is None, v if v is not None else 0)

    rows.sort(key=keyf, reverse=(dir == "desc"))
    total = len(rows)
    return {**meta, "rows": rows[(page - 1) * page_size: page * page_size], "total": total,
            "page": page, "page_size": page_size}


@router.get("/orders", response_model=OrdersResponse)
def customers_orders(period: Period = "all", start: Optional[date] = None, end: Optional[date] = None,
                     exclude_launch_accounts: bool = False, format: Literal["json", "csv"] = "json",
                     page: int = Query(1, ge=1), page_size: int = Query(500, ge=1, le=5000),
                     db: Session = Depends(get_db), _u=Depends(get_current_user)):
    ds, lo, hi, _tz_, meta = _ctx(db, period, start, end, exclude_launch_accounts)
    rows = metrics.order_rows(ds, start=lo, end=hi)
    if format == "csv":
        buf = io.StringIO()
        fields = list(OrderRow.model_fields)
        w = csv.DictWriter(buf, fieldnames=fields)
        w.writeheader()
        for r in rows:
            w.writerow({**r, "coupons": ";".join(r["coupons"]), "categories": ";".join(r["categories"]),
                        "tests": ";".join(r["tests"])})
        return Response(buf.getvalue(), media_type="text/csv",
                        headers={"Content-Disposition": "attachment; filename=customer-orders.csv"})
    return {**meta, "rows": rows[(page - 1) * page_size: page * page_size], "total": len(rows),
            "page": page, "page_size": page_size}
```

In `backend/main.py`:
- add `from customer_insights.routes import router as customer_insights_router` with the other router imports (lines 95–128);
- add `app.include_router(customer_insights_router)` after `app.include_router(priority_router)`.

- [ ] **Step 4: Run tests**

Run: `pytest tests/test_customer_insights_routes.py -q` → 5 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/customer_insights/routes.py backend/main.py backend/tests/test_customer_insights_routes.py
git commit -m "feat(customer-insights): /reports/customers summary, cohorts, at-risk, list, orders"
```

---

### Task 6: Frontend: API client, utils, Insights page, sidebar entry, list upgrade

**Files:**
- Modify: `src/lib/api.ts` (types + `getCustomerSummary`, `getCustomerCohorts`, `getCustomerAtRisk`, `getCustomerList`)
- Create: `src/components/customers/insights-utils.ts`, `src/components/customers/insights-utils.test.ts`
- Create: `src/components/customers/CustomerInsights.tsx`, `src/components/customers/CustomerInsights.test.tsx`
- Modify: `src/components/AccuMarkTools.tsx` (route `customer-insights`), `src/components/layout/AppSidebar.tsx` (sub-item after `customers`), and `src/components/layout/__tests__/AppSidebar.test.tsx` if it pins the AccuMark Tools order (stale test; update it)
- Modify: `src/components/CustomerStatusPage.tsx`:
  - `CustomerListView` (lines 105–420) reads `getCustomerList`;
  - adds columns Spend (period), Δ, Lifetime, Samples, Usual gap, Top tests, Status;
  - keeps the existing columns;
  - makes guest rows clickable by key (see Task 8 for detail routing).

**Interfaces:**
- Consumes: Task 5 routes.
- Produces:
  - TS types `CustomerSummary`, `CustomerCohorts`, `CustomerRow`, `AtRiskRow`, `CustomerListResponse`;
  - `fmtMoney(s: string): string`, `fmtPct(x: number | null): string`, `fmtDelta(x: number | null): {text: string; tone: 'up' | 'down' | 'flat'}`, `STATUS_LABEL: Record<string, string>`, `cohortTint(share: number | null): string`;
  - `CustomerInsights` component (the `customer-insights` sub-section).

- [ ] **Step 1: Write the failing util tests**

```ts
// src/components/customers/insights-utils.test.ts
import { describe, expect, it } from 'vitest'
import { cohortTint, fmtDelta, fmtMoney, fmtPct } from './insights-utils'

describe('insights utils', () => {
  it('formats money strings without float drift', () => {
    expect(fmtMoney('1070000.00')).toBe('$1.07M')
    expect(fmtMoney('84210.4')).toBe('$84,210')
    expect(fmtMoney('566.00')).toBe('$566')
    expect(fmtMoney('0.00')).toBe('$0')
  })
  it('formats shares and deltas', () => {
    expect(fmtPct(0.24)).toBe('24.0%')
    expect(fmtPct(null)).toBe('n/a')
    expect(fmtDelta(-0.71)).toEqual({ text: '▼ 71%', tone: 'down' })
    expect(fmtDelta(0.02)).toEqual({ text: '▲ 2%', tone: 'flat' })
    expect(fmtDelta(null)).toEqual({ text: 'n/a', tone: 'flat' })
  })
  it('tints cohort cells and flags low returns', () => {
    expect(cohortTint(null)).toBe('')
    expect(cohortTint(0.13)).toContain('red')
    expect(cohortTint(0.39)).toContain('emerald')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/customers/insights-utils.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement utils and API types**

```ts
// src/components/customers/insights-utils.ts
export function fmtMoney(s: string | null | undefined): string {
  const n = Number(s ?? 0)
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  return `$${Math.round(n).toLocaleString('en-US')}`
}

export const fmtPct = (x: number | null | undefined, dp = 1): string =>
  x == null ? 'n/a' : `${(x * 100).toFixed(dp)}%`

/** Period-over-period delta; within ±5% reads as flat (grey). */
export function fmtDelta(x: number | null | undefined): {
  text: string
  tone: 'up' | 'down' | 'flat'
} {
  if (x == null) return { text: 'n/a', tone: 'flat' }
  const pct = Math.round(Math.abs(x) * 100)
  const text = `${x >= 0 ? '▲' : '▼'} ${pct}%`
  if (Math.abs(x) < 0.05) return { text, tone: 'flat' }
  return { text, tone: x > 0 ? 'up' : 'down' }
}

export const STATUS_LABEL: Record<string, string> = {
  at_risk: 'At risk',
  dropping: 'Dropping',
  growing: 'Growing',
  steady: 'Steady',
  one_time: 'One-time',
}

export const STATUS_CLASS: Record<string, string> = {
  at_risk: 'bg-red-500/15 text-red-700 dark:text-red-300',
  dropping: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  growing: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  steady: 'bg-muted text-muted-foreground',
  one_time: 'bg-muted text-muted-foreground',
}

/** Cohort cell background: emerald scaled by share, red below 15%. */
export function cohortTint(share: number | null): string {
  if (share == null) return ''
  if (share < 0.15) return 'bg-red-500/30'
  const step = share >= 0.35 ? 50 : share >= 0.25 ? 40 : 30
  return `bg-emerald-500/${step}`
}
```

In `src/lib/api.ts`, add (near the reports section):

```ts
export interface KpiPair<T> { value: T; prior: T | null }
export interface CustomerSummary {
  tz: string
  synced_at: string | null
  kpis: {
    active_customers: KpiPair<number>
    revenue: KpiPair<string>
    paid_orders: KpiPair<number>
    aov: KpiPair<string>
    repeat_rate: KpiPair<number | null>
    median_days_to_second: KpiPair<number | null>
  }
  revenue_by_month: { month: string; new: string; returning: string }[]
  concentration: { top10_share: number; top_decile_share: number; repeat_share: number; median_ltv: string; mean_ltv: string; customers: number }
  attach: { test: string; new: number; returning: number }[]
  first_order: { kind: string; customers: number; repeat_rate: number | null }[]
}
export interface CustomerCohorts { tz: string; synced_at: string | null; months: string[]; rows: { cohort: string; size: number; cells: (number | null)[] }[] }
export interface CustomerRow {
  key: string; name: string; email: string | null; company: string | null
  period_spend: string; prior_spend: string; delta_pct: number | null; lifetime: string
  orders: number; samples: number; usual_gap_days: number | null; last_order_at: string | null
  top_tests: string[]; status: string; monthly: { month: string; spend: string }[]
}
export interface AtRiskRow extends CustomerRow { spend_12m: string; overdue: number }
export interface CustomerListResponse { tz: string; synced_at: string | null; rows: CustomerRow[]; total: number; page: number; page_size: number }
export type InsightsPeriod = '30d' | '90d' | '6m' | '1y' | 'all'

async function getReport<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]))
  const response = await fetch(`${API_BASE_URL()}${path}${qs.size ? `?${qs}` : ''}`, { headers: getBearerHeaders() })
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`)
  return response.json()
}
export const getCustomerSummary = (period: InsightsPeriod, excludeLaunch = false) =>
  getReport<CustomerSummary>('/reports/customers/summary', { period, exclude_launch_accounts: excludeLaunch })
export const getCustomerCohorts = (excludeLaunch = true) =>
  getReport<CustomerCohorts>('/reports/customers/cohorts', { exclude_launch_accounts: excludeLaunch })
export const getCustomerAtRisk = () => getReport<{ tz: string; synced_at: string | null; rows: AtRiskRow[] }>('/reports/customers/at-risk')
export const getCustomerList = (p: { period: InsightsPeriod; search?: string; sort?: string; dir?: 'asc' | 'desc'; page?: number; page_size?: number }) =>
  getReport<CustomerListResponse>('/reports/customers/list', p)
```

Run `npx prettier --write src/lib/api.ts src/components/customers/insights-utils.ts`.

- [ ] **Step 4: Run util tests**

Run: `npx vitest run src/components/customers/insights-utils.test.ts` → 3 passed.

- [ ] **Step 5: Write the failing page test**

```tsx
// src/components/customers/CustomerInsights.test.tsx
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cloneElement, type ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type * as Recharts from 'recharts'
import * as api from '@/lib/api'
import { CustomerInsights } from './CustomerInsights'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof api>('@/lib/api')
  return { ...actual, getCustomerSummary: vi.fn(), getCustomerCohorts: vi.fn(), getCustomerAtRisk: vi.fn() }
})
vi.mock('recharts', async importOriginal => {
  const actual = await importOriginal<typeof Recharts>()
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) =>
      cloneElement(children, { width: 800, height: 240 }),
  }
})

const k = <T,>(value: T, prior: T | null = null) => ({ value, prior })

function setup() {
  vi.mocked(api.getCustomerSummary).mockResolvedValue({
    tz: 'America/Los_Angeles', synced_at: '2026-10-05T18:00:00Z',
    kpis: { active_customers: k(412, 378), revenue: k('1070000.00', '1010000.00'), paid_orders: k(1893, 1705),
            aov: k('566.00', '590.00'), repeat_rate: k(0.24, 0.271), median_days_to_second: k(10, 10) },
    revenue_by_month: [{ month: '2026-09', new: '132000.00', returning: '234000.00' }],
    concentration: { top10_share: 0.41, top_decile_share: 0.858, repeat_share: 0.882, median_ltv: '125.00', mean_ltv: '1861.00', customers: 782 },
    attach: [{ test: 'Endotoxin', new: 0.12, returning: 0.68 }],
    first_order: [{ kind: 'accutry50', customers: 273, repeat_rate: 0.14 }],
  })
  vi.mocked(api.getCustomerCohorts).mockResolvedValue({
    tz: 'America/Los_Angeles', synced_at: null, months: ['M1', 'M2'],
    rows: [{ cohort: '2026-08', size: 163, cells: [0.129, null] }],
  })
  vi.mocked(api.getCustomerAtRisk).mockResolvedValue({
    tz: 'America/Los_Angeles', synced_at: null,
    rows: [{ key: 'wc:1', name: 'Halcyon Research Supply', email: 'ops@h.example', company: null,
             period_spend: '12400.00', prior_spend: '42000.00', delta_pct: -0.71, lifetime: '96110.00',
             orders: 31, samples: 142, usual_gap_days: 9, last_order_at: '2026-08-21T15:00:00Z',
             top_tests: ['HPLC'], status: 'at_risk', monthly: [], spend_12m: '84210.00', overdue: 5.2 }],
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><CustomerInsights onOpenCustomer={() => {}} /></QueryClientProvider>)
}

describe('CustomerInsights', () => {
  it('renders KPIs, cohort cell, at-risk row and freshness line', async () => {
    setup()
    expect(await screen.findByText('$1.07M')).toBeInTheDocument()
    expect(screen.getByText('24.0%')).toBeInTheDocument()
    expect(screen.getByText('12.9%')).toBeInTheDocument()
    expect(screen.getByText('Halcyon Research Supply')).toBeInTheDocument()
    expect(screen.getByText('5.2× gap')).toBeInTheDocument()
    expect(screen.getByText(/orders synced/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 6: Implement `CustomerInsights.tsx`**

Layout follows the comp `docs/superpowers/specs/assets/2026-10-05-customer-insights/overview.html`:
- header with a period picker (30D / 90D / 6M / 1Y / All);
- the subtitle carries tz and freshness ("orders synced N min ago" from `synced_at`);
- 6 KPI tiles with deltas;
- a revenue new-vs-returning stacked `BarChart`, with an "Exclude launch accounts" switch passed to `getCustomerSummary`;
- the cohort table using `cohortTint`;
- the at-risk table: overdue chip, a `Tooltip` content card with email, usual gap, last order and top tests, and a row click that calls `onOpenCustomer(row.key)`;
- the "Why customers stop" card, added in Task 9;
- three cards: first order vs repeat, attach rate, concentration.

Use the existing report idioms from `src/components/reports/AnalyteTrends.tsx`: tile classes, `th` styling, `Loader2` loading state and the `XCircle` error banner.

```tsx
// src/components/customers/CustomerInsights.tsx
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, XCircle } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts'
import { cn } from '@/lib/utils'
import { getCustomerAtRisk, getCustomerCohorts, getCustomerSummary, type InsightsPeriod } from '@/lib/api'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cohortTint, fmtDelta, fmtMoney, fmtPct } from './insights-utils'

const PERIODS: { key: InsightsPeriod; label: string }[] = [
  { key: '30d', label: '30D' }, { key: '90d', label: '90D' }, { key: '6m', label: '6M' },
  { key: '1y', label: '1Y' }, { key: 'all', label: 'All' },
]
const NEW = '#60a5fa'
const RETURNING = '#34d399'
const FIRST_ORDER_LABEL: Record<string, string> = {
  accutry50: 'accutry50 coupon', other_coupon: 'Other coupon', full_price: 'Full price', with_addon: 'With an add-on',
}

function minutesAgo(iso: string | null): string {
  if (!iso) return 'orders not synced yet'
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000))
  return `orders synced ${m < 1 ? 'just now' : `${m} min ago`}`
}

function Kpi({ label, value, delta }: { label: string; value: string; delta: ReturnType<typeof fmtDelta> }) {
  return (
    <div className="rounded-lg border border-border/50 bg-card/50 px-4 py-3">
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn('text-xs tabular-nums mt-0.5', delta.tone === 'up' ? 'text-emerald-600 dark:text-emerald-400' : delta.tone === 'down' ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground')}>
        {delta.text} vs prior
      </div>
    </div>
  )
}

const rel = (v: number, p: number | null) => (p ? (v - p) / p : null)

export function CustomerInsights({ onOpenCustomer }: { onOpenCustomer: (key: string) => void }) {
  const [period, setPeriod] = useState<InsightsPeriod>('90d')
  const [excludeLaunch, setExcludeLaunch] = useState(false)
  const summary = useQuery({ queryKey: ['customers', 'summary', period, excludeLaunch], queryFn: () => getCustomerSummary(period, excludeLaunch), staleTime: 60_000 })
  const cohorts = useQuery({ queryKey: ['customers', 'cohorts'], queryFn: () => getCustomerCohorts(true), staleTime: 60_000 })
  const risk = useQuery({ queryKey: ['customers', 'at-risk'], queryFn: getCustomerAtRisk, staleTime: 60_000 })
  const s = summary.data

  return (
    <div className="flex flex-col gap-4 p-4 h-full overflow-auto">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Customer Insights</h1>
          <p className="text-xs text-muted-foreground">
            Paid WooCommerce orders, net of refunds · internal and test accounts excluded
            {s && ` · lab time (${s.tz}) · ${minutesAgo(s.synced_at)}`}
          </p>
        </div>
        <div className="flex rounded-md border border-border/50 overflow-hidden">
          {PERIODS.map(p => (
            <button key={p.key} type="button" aria-pressed={period === p.key} onClick={() => setPeriod(p.key)}
              className={cn('px-3 py-1 text-xs font-medium cursor-pointer', period === p.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50')}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {summary.isLoading && <div className="flex justify-center py-20"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}
      {summary.error && (
        <div className="flex items-center gap-2 text-red-500 py-8 justify-center text-sm">
          <XCircle className="h-4 w-4" /> Failed to load customer insights
          <button type="button" className="underline" onClick={() => summary.refetch()}>Retry</button>
        </div>
      )}
      {s && s.concentration.customers === 0 && (
        <div className="py-16 text-center text-sm text-muted-foreground">No paid orders synced yet.</div>
      )}

      {s && s.concentration.customers > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Kpi label="Active customers" value={String(s.kpis.active_customers.value)} delta={fmtDelta(rel(s.kpis.active_customers.value, s.kpis.active_customers.prior))} />
            <Kpi label="Revenue" value={fmtMoney(s.kpis.revenue.value)} delta={fmtDelta(rel(Number(s.kpis.revenue.value), s.kpis.revenue.prior == null ? null : Number(s.kpis.revenue.prior)))} />
            <Kpi label="Paid orders" value={s.kpis.paid_orders.value.toLocaleString('en-US')} delta={fmtDelta(rel(s.kpis.paid_orders.value, s.kpis.paid_orders.prior))} />
            <Kpi label="Avg order value" value={fmtMoney(s.kpis.aov.value)} delta={fmtDelta(rel(Number(s.kpis.aov.value), s.kpis.aov.prior == null ? null : Number(s.kpis.aov.prior)))} />
            <Kpi label="Repeat rate" value={fmtPct(s.kpis.repeat_rate.value)} delta={fmtDelta(s.kpis.repeat_rate.value != null && s.kpis.repeat_rate.prior != null ? s.kpis.repeat_rate.value - s.kpis.repeat_rate.prior : null)} />
            <Kpi label="Median to 2nd order" value={s.kpis.median_days_to_second.value == null ? 'n/a' : `${s.kpis.median_days_to_second.value} d`} delta={{ text: 'all time', tone: 'flat' }} />
          </div>

          <div className="grid gap-3 xl:grid-cols-[1.45fr_1fr]">
            <section className="rounded-lg border border-border/50 bg-card/30 p-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium">Revenue by month: new vs returning customers</h2>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch checked={excludeLaunch} onCheckedChange={setExcludeLaunch} aria-label="Exclude launch accounts" />
                  Exclude launch accounts
                </label>
              </div>
              <div className="h-[230px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={s.revenue_by_month.map(m => ({ month: m.month, new: Number(m.new), returning: Number(m.returning) }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" opacity={0.5} vertical={false} />
                    <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#9ca3af' }} tickLine={false} axisLine={false} />
                    <YAxis tickFormatter={(v: number) => fmtMoney(String(v))} tick={{ fontSize: 10, fill: '#9ca3af' }} tickLine={false} axisLine={false} width={60} />
                    <ChartTooltip formatter={(v: number) => fmtMoney(String(v))} />
                    <Bar dataKey="returning" stackId="r" fill={RETURNING} name="Returning customers" />
                    <Bar dataKey="new" stackId="r" fill={NEW} name="New customers" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>

            <section className="rounded-lg border border-border/50 bg-card/30 p-3">
              <h2 className="text-sm font-medium">Re-order cohorts</h2>
              <p className="text-[11px] text-muted-foreground mb-2">Share of each first-order month's customers who ordered again N months later (launch accounts excluded)</p>
              <table className="w-full text-xs tabular-nums">
                <thead><tr className="text-muted-foreground"><th className="text-left font-medium py-1">Cohort</th><th className="font-medium">n</th>{cohorts.data?.months.slice(0, 6).map(m => <th key={m} className="font-medium">{m}</th>)}</tr></thead>
                <tbody>
                  {cohorts.data?.rows.map(r => (
                    <tr key={r.cohort}>
                      <td className="py-0.5">{r.cohort}</td><td className="text-center">{r.size}</td>
                      {r.cells.slice(0, 6).map((c, i) => <td key={i} className={cn('text-center rounded', cohortTint(c))}>{c == null ? '' : fmtPct(c, c < 0.2 ? 1 : 0)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          <section className="rounded-lg border border-border/50 bg-card/30 p-3">
            <h2 className="text-sm font-medium">At-risk customers <span className="ml-1 rounded-full bg-red-500/15 px-2 text-xs text-red-700 dark:text-red-300">{risk.data?.rows.length ?? 0} overdue</span></h2>
            <p className="text-[11px] text-muted-foreground mb-2">Overdue against their own usual re-order gap, ranked by 12-month spend</p>
            <table className="w-full text-sm tabular-nums">
              <thead><tr className="text-[11px] uppercase tracking-wider text-muted-foreground"><th className="text-left py-1 font-medium">Customer</th><th className="text-right font-medium">12-mo spend</th><th className="text-right font-medium">Orders</th><th className="text-right font-medium">Usual gap</th><th className="text-right font-medium">Last order</th><th className="text-right font-medium">Overdue</th></tr></thead>
              <tbody>
                {risk.data?.rows.map(r => (
                  <Tooltip key={r.key}>
                    <TooltipTrigger asChild>
                      <tr className="border-t border-border/20 hover:bg-muted/30 cursor-pointer" onClick={() => onOpenCustomer(r.key)}>
                        <td className="py-1.5 font-medium">{r.name}</td>
                        <td className="text-right">{fmtMoney(r.spend_12m)}</td>
                        <td className="text-right">{r.orders}</td>
                        <td className="text-right">{r.usual_gap_days == null ? 'n/a' : `${r.usual_gap_days} d`}</td>
                        <td className="text-right">{r.last_order_at ? new Date(r.last_order_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: s.tz }) : ''}</td>
                        <td className="text-right"><span className={cn('rounded-full px-2 text-xs font-semibold', r.overdue >= 3 ? 'bg-red-500/15 text-red-700 dark:text-red-300' : 'bg-amber-500/15 text-amber-700 dark:text-amber-300')}>{r.overdue}× gap</span></td>
                      </tr>
                    </TooltipTrigger>
                    <TooltipContent className="p-0 max-w-xs">
                      <div className="flex flex-col gap-1.5 p-3 text-xs font-mono">
                        <div className="font-semibold border-b border-primary-foreground/20 pb-1.5">{r.name}</div>
                        <div>{r.email ?? 'no email'}</div>
                        <div className="border-t border-primary-foreground/20 pt-1.5">Lifetime {fmtMoney(r.lifetime)} · {r.samples} samples</div>
                        <div>Top tests: {r.top_tests.join(', ') || 'n/a'}</div>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                ))}
              </tbody>
            </table>
          </section>

          <div className="grid gap-3 lg:grid-cols-3">
            <section className="rounded-lg border border-border/50 bg-card/30 p-3">
              <h2 className="text-sm font-medium">First order → comes back?</h2>
              <table className="w-full text-sm tabular-nums mt-2"><tbody>
                {s.first_order.map(f => <tr key={f.kind}><td className="py-1">{FIRST_ORDER_LABEL[f.kind] ?? f.kind}</td><td className="text-right text-muted-foreground">{f.customers}</td><td className="text-right font-medium">{fmtPct(f.repeat_rate, 0)}</td></tr>)}
              </tbody></table>
            </section>
            <section className="rounded-lg border border-border/50 bg-card/30 p-3">
              <h2 className="text-sm font-medium">Add-on attach rate</h2>
              <table className="w-full text-sm tabular-nums mt-2">
                <thead><tr className="text-[11px] text-muted-foreground"><th className="text-left font-medium">Add-on</th><th className="text-right font-medium">New</th><th className="text-right font-medium">Returning</th></tr></thead>
                <tbody>{s.attach.map(a => <tr key={a.test}><td className="py-1">{a.test}</td><td className="text-right">{fmtPct(a.new, 0)}</td><td className="text-right">{fmtPct(a.returning, 0)}</td></tr>)}</tbody>
              </table>
            </section>
            <section className="rounded-lg border border-border/50 bg-card/30 p-3 text-sm">
              <h2 className="font-medium">Revenue concentration</h2>
              <div className="mt-2 flex justify-between"><span>Top 10 customers</span><b>{fmtPct(s.concentration.top10_share, 0)}</b></div>
              <div className="flex justify-between"><span>Top 10%</span><b>{fmtPct(s.concentration.top_decile_share)}</b></div>
              <div className="flex justify-between"><span>Repeat customers' share</span><b>{fmtPct(s.concentration.repeat_share)}</b></div>
              <div className="flex justify-between"><span>Median / average LTV</span><b>{fmtMoney(s.concentration.median_ltv)} / {fmtMoney(s.concentration.mean_ltv)}</b></div>
            </section>
          </div>
        </>
      )}
    </div>
  )
}
```

Routing:
- In `AccuMarkTools.tsx`, add `case 'customer-insights': return <CustomerInsights onOpenCustomer={openCustomer} />`. Here `openCustomer(key)` uses the same UI-store navigation the customer list uses to open the detail view (`setActiveSubSection('customer-detail')` plus the selected customer). Read how `CustomerListView` opens a row (lines 428–485) and mirror it, passing the customer key (see Task 8 for key-based detail).
- In `AppSidebar.tsx`, add `{ id: 'customer-insights', label: 'Customer Insights' }` directly after `{ id: 'customers', label: 'Customers' }`.

List upgrade:
- In `CustomerListView`, add a `useQuery(['customers', 'list', period, search, sort, dir, page], () => getCustomerList(...))` alongside the existing `getExplorerCustomers` query.
- Render the new columns from the matching `CustomerRow`: join on `key === \`wc:${customer.id}\``, or for guests the email key. Keep the existing columns.
- Clicking a guest row opens the detail view by key (Task 8). Leave the existing explorer detail for registered customers.

- [ ] **Step 7: Run gates**

Run:
- `npx vitest run src/components/customers src/components/layout src/test/customer-status-page.test.tsx` → all pass. The sidebar test may need the new item added; that's a stale test, so update it.
- `npm run typecheck` → clean.
- `npx eslint src/components/customers src/lib/api.ts src/components/CustomerStatusPage.tsx src/components/AccuMarkTools.tsx src/components/layout/AppSidebar.tsx` → clean.
- `npx prettier --write` the same files.

- [ ] **Step 8: Commit**

```bash
git add src/lib/api.ts src/components/customers src/components/AccuMarkTools.tsx src/components/layout/AppSidebar.tsx src/components/layout/__tests__/AppSidebar.test.tsx src/components/CustomerStatusPage.tsx
git commit -m "feat(customer-insights): Insights page, sidebar entry and upgraded customer list"
```

---

### Task 7: SLA per-sample records (extract from sla_perf, additive)

**Files:**
- Modify: `backend/sla_perf.py` (extract the record-building loop at lines 287–345 into `sample_records(...)`; `build_sla_performance` calls it; output unchanged)
- Modify: `backend/main.py` (add `sla_sample_records(db, now) -> list[dict]` next to `_sla_perf_rows`, reusing `_sla_perf_rows(db)`)
- Test: `backend/tests/test_sla_perf_sample_records.py`

**Interfaces:**
- Produces:
  - `sla_perf.sample_records(*, samples, analyses, coas, tiers, groups, schedule, holidays, now, excluded_sample_ids=frozenset(), profiles=()) -> list[dict]`. The keys are exactly those of the current internal `records` entries: `pk, sid, client, order, status, received, ..., state, bh, target, tier, late, families, ...`.
  - `main.sla_sample_records(db: Session, now: datetime) -> list[dict]`
- Consumed by: `customer_insights/sources._sla_records` (already wired in Task 2; it starts returning data once these exist).

- [ ] **Step 1: Write the failing equivalence test**

```python
# backend/tests/test_sla_perf_sample_records.py
"""sample_records is the extracted loop: build_sla_performance output must not change."""
import inspect

import sla_perf


def test_sample_records_exists_and_build_uses_it() -> None:
    assert hasattr(sla_perf, "sample_records")
    params = inspect.signature(sla_perf.sample_records).parameters
    assert {"samples", "analyses", "coas", "tiers", "groups", "schedule", "holidays", "now"} <= set(params)
    assert "sample_records(" in inspect.getsource(sla_perf.build_sla_performance)
```

Then make an exact-output check part of this task:
1. Before refactoring, run the existing SLA performance tests: `pytest tests -q -k "sla_perf or sla_performance"`. Record the pass/fail set.
2. After refactoring, the same set must pass.

That test suite is the behavior lock; do not edit its expectations.

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_sla_perf_sample_records.py -q` → FAIL (`sample_records` missing).

- [ ] **Step 3: Refactor**

Move lines 287–345 of `build_sla_performance` (the loop that appends to `records`, together with the local helpers it needs, such as `bh(...)` and the `first_primary` mapping at 277–283) into:

```python
def sample_records(*, samples, analyses, coas, tiers, groups, schedule, holidays, now,
                   excluded_sample_ids=frozenset(), profiles=()) -> list[dict]:
    """Per-sample SLA records (one dict per sample in the series window).

    Extracted verbatim from build_sla_performance so Customer Insights can read
    per-sample delivered/late without re-deriving the SLA rules.
    """
    ...  # the moved code, returning `records`
```

In `build_sla_performance`, replace the moved block with:

```python
records = sample_records(samples=samples, analyses=analyses, coas=coas, tiers=tiers, groups=groups,
                         schedule=schedule, holidays=holidays, now=now,
                         excluded_sample_ids=excluded_sample_ids, profiles=profiles)
```

Keep every name that later code in `build_sla_performance` reads (if it reads helpers defined inside the moved block, compute them in both places or return them alongside). Moving code without changing it is the whole point.

In `main.py`, after `_sla_perf_rows`:

```python
def sla_sample_records(db: Session, now: datetime) -> list[dict]:
    """Per-sample SLA records for Customer Insights (delivered + late, keyed by order number)."""
    import sla_perf
    rows = _sla_perf_rows(db)
    return sla_perf.sample_records(**rows["inputs"], coas=rows["coas"], now=now,
                                   excluded_sample_ids=rows["test_ids"])
```

Check `_sla_perf_rows`'s return keys (`inputs`, `coas`, `test_ids`) at `main.py:11023` and match them exactly.

- [ ] **Step 4: Run tests**

Run: `pytest tests/test_sla_perf_sample_records.py -q` → PASS. Then rerun `pytest tests -q -k "sla_perf or sla_performance"` → the same set as Step 1.

- [ ] **Step 5: Commit**

```bash
git add backend/sla_perf.py backend/main.py backend/tests/test_sla_perf_sample_records.py
git commit -m "refactor(sla): extract sample_records for reuse (output unchanged)"
```

---

### Task 8: Customer dossier route and Dashboard tab

**Files:**
- Modify: `backend/customer_insights/metrics.py` (append `dossier`)
- Modify: `backend/customer_insights/routes.py` (append models + `GET /reports/customers/{customer_key}`, declared LAST so fixed paths win)
- Test: append to `backend/tests/test_customer_insights_metrics.py` and `backend/tests/test_customer_insights_routes.py`
- Modify: `src/lib/api.ts` (`CustomerDossier` type + `getCustomerDossier(key)`)
- Create: `src/components/customers/CustomerDashboard.tsx`, `src/components/customers/CustomerDashboard.test.tsx`
- Modify: `src/components/CustomerStatusPage.tsx`:
  - replace `<CustomerDashboardPlaceholder />` (line 810) with `<CustomerDashboard customerKey={...} />`;
  - delete the placeholder component (lines 1248–1259);
  - add Total, Discount, Coupon columns to `CustomerOrdersTab` from `dossier.orders` (match on order number);
  - let guest rows open the detail view: `CustomerDetailView` takes either a WC id or an `email:` key, and for an email key shows the Dashboard tab only.

**Interfaces:**
- Produces:
  - `metrics.dossier(ds, key: str, *, end: datetime, tz: str) -> dict | None` (`None` for an unknown key; the route returns 404).
  - Shape:
    ```
    {identity: {key, name, email, company, wc_id, since: iso},
     kpis: {lifetime: str, rank: int, customers: int, orders: int, avg_order: str, samples: int,
            samples_per_order: float, usual_gap_days: float|None, gap_iqr: [float, float]|None,
            nonconforming_rate: float|None, lab_nonconforming_rate: float|None,
            on_time_rate: float|None, lab_on_time_rate: float|None},
     status: str, days_since_last: float|None, overdue: float, spend_delta_pct: float|None,
     monthly: [{month, spend: str, samples: int}], order_dates: [iso],
     test_mix: [{test, share: float, all_share: float}],
     analytes: [{product, coas: int, pass_rate: float}],
     recent: [{order_number, paid_at, coas: int, failed: int, sla: "late"|"on_time"|None}],
     orders: [order_rows shape]}
    ```

- [ ] **Step 1: Append failing metric and route tests**

```python
# append to tests/test_customer_insights_metrics.py
from customer_insights.dataset import Coa


def test_dossier_shape_and_lab_comparisons() -> None:
    orders = [o("wc:1", d, "100", oid=10 + i, number=str(10 + i), tests=("HPLC", "Endotoxin"))
              for i, d in enumerate((0, 7, 14))]
    orders.append(o("wc:2", 1, "50", oid=20, number="20"))
    coas = [Coa("10", "P-1", "BPC-157", True, T0), Coa("11", "P-2", "BPC-157", False, T0),
            Coa("20", "P-3", "TB-500", True, T0)]
    data = ds(orders, coas=coas, late=frozenset({"11"}), delivered=frozenset({"10", "11", "20"}))
    d = metrics.dossier(data, "wc:1", end=T0 + timedelta(days=60), tz=TZ)
    assert d["kpis"]["lifetime"] == "300.00" and d["kpis"]["rank"] == 1
    assert d["kpis"]["nonconforming_rate"] == 0.5
    assert d["kpis"]["lab_nonconforming_rate"] == round(1 / 3, 4)
    assert d["kpis"]["on_time_rate"] == 0.5
    assert d["analytes"] == [{"product": "BPC-157", "coas": 2, "pass_rate": 0.5}]
    mix = {m["test"]: m for m in d["test_mix"]}
    assert mix["Endotoxin"]["share"] == 1.0
    assert d["recent"][0]["order_number"] == "12"
    assert metrics.dossier(data, "wc:404", end=T0, tz=TZ) is None


def test_dossier_without_sla_or_coas() -> None:
    d = metrics.dossier(ds([o("wc:1", 0)]), "wc:1", end=T0 + timedelta(days=1), tz=TZ)
    assert d["kpis"]["on_time_rate"] is None and d["kpis"]["nonconforming_rate"] is None
    assert d["recent"][0]["sla"] is None
```

```python
# append to tests/test_customer_insights_routes.py
def test_dossier_route_guest_key_and_404(client) -> None:
    body = client.get("/reports/customers/email:g@x.com").json()
    assert body["identity"]["key"] == "email:g@x.com"
    assert {"lifetime", "rank", "on_time_rate"} <= set(body["kpis"])
    assert body["orders"][0]["net"] == "125.00"
    assert client.get("/reports/customers/wc:999").status_code == 404
    # fixed routes still win over the key route
    assert client.get("/reports/customers/summary").status_code == 200
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_customer_insights_metrics.py tests/test_customer_insights_routes.py -q` → new tests FAIL.

- [ ] **Step 3: Implement `dossier`** (append to `metrics.py`)

```python
def _rate(num: int, den: int) -> float | None:
    return round(num / den, 4) if den else None


def dossier(ds: Dataset, key: str, *, end: datetime, tz: str) -> dict[str, Any] | None:
    by = _by_customer(ds, end)
    orders = by.get(key)
    if not orders:
        return None
    c = ds.customers.get(key)
    numbers = {x.order_number for x in orders}
    lifetimes = sorted(((k, _spend(v, None, end)) for k, v in by.items()), key=lambda kv: kv[1], reverse=True)
    rank = next(i for i, (k, _) in enumerate(lifetimes, 1) if k == key)
    dates = [x.paid_at for x in orders if x.is_testing]
    gaps = sorted((b - a).total_seconds() / 86400 for a, b in zip(dates, dates[1:]))
    iqr = [round(gaps[len(gaps) // 4], 1), round(gaps[(3 * len(gaps)) // 4], 1)] if len(gaps) >= 2 else None
    mine = [x for x in ds.coas if x.order_number in numbers]
    tests = Counter(t for x in orders for t in x.tests)
    all_tests = Counter(t for x in ds.orders if x.paid_at <= end for t in x.tests)
    samples = sum(x.samples for x in orders)
    all_samples = sum(x.samples for x in ds.orders if x.paid_at <= end)
    products: dict[str, list[bool]] = defaultdict(list)
    for x in mine:
        products[x.product].append(x.passed)

    def on_time(nums: set[str]) -> float | None:
        if ds.delivered_orders is None or ds.late_orders is None:
            return None
        delivered = nums & ds.delivered_orders
        return _rate(len(delivered - ds.late_orders), len(delivered))

    all_numbers = {x.order_number for x in ds.orders if x.paid_at <= end}
    monthly: dict[str, dict[str, Any]] = defaultdict(lambda: {"spend": ZERO, "samples": 0})
    for x in orders:
        m = monthly[rules.lab_month(x.paid_at, tz)]
        m["spend"] += x.net
        m["samples"] += x.samples
    period = _spend(orders, end - timedelta(days=90), end)
    prior = _spend(orders, end - timedelta(days=180), end - timedelta(days=90))
    risk = rules.is_at_risk(dates, end)

    def recent_row(x: Order) -> dict[str, Any]:
        cs = [y for y in mine if y.order_number == x.order_number]
        sla = None
        if ds.delivered_orders is not None and ds.late_orders is not None and x.order_number in ds.delivered_orders:
            sla = "late" if x.order_number in ds.late_orders else "on_time"
        return {"order_number": x.order_number, "paid_at": x.paid_at.isoformat(), "coas": len(cs),
                "failed": sum(not y.passed for y in cs), "sla": sla}

    return {
        "identity": {"key": key, "name": c.name if c else key, "email": c.email if c else None,
                     "company": c.company if c else None, "wc_id": c.wc_id if c else None,
                     "since": orders[0].paid_at.isoformat()},
        "kpis": {
            "lifetime": money(_spend(orders, None, end)), "rank": rank, "customers": len(lifetimes),
            "orders": len(orders), "avg_order": money(_spend(orders, None, end) / len(orders)),
            "samples": samples, "samples_per_order": round(samples / len(orders), 1),
            "usual_gap_days": round(rules.usual_gap_days(dates), 1) if len(dates) >= 3 else None,
            "gap_iqr": iqr,
            "nonconforming_rate": _rate(sum(not x.passed for x in mine), len(mine)),
            "lab_nonconforming_rate": _rate(sum(not x.passed for x in ds.coas), len(ds.coas)),
            "on_time_rate": on_time(numbers), "lab_on_time_rate": on_time(all_numbers),
        },
        "status": rules.spend_status(paid_orders=len(orders), at_risk=risk, period=period, prior=prior),
        "days_since_last": round((end - dates[-1]).total_seconds() / 86400, 1) if dates else None,
        "overdue": rules.overdue_ratio(dates, end),
        "spend_delta_pct": round(float((period - prior) / prior), 4) if prior else None,
        "monthly": [{"month": m, "spend": money(v["spend"]), "samples": v["samples"]} for m, v in sorted(monthly.items())],
        "order_dates": [d.isoformat() for d in dates],
        "test_mix": [{"test": t, "share": round(n / samples, 4) if samples else 0.0,
                      "all_share": round(all_tests[t] / all_samples, 4) if all_samples else 0.0}
                     for t, n in sorted(tests.items(), key=lambda kv: -kv[1])],
        "analytes": sorted(({"product": p, "coas": len(v), "pass_rate": round(sum(v) / len(v), 4)}
                            for p, v in products.items()), key=lambda r: -r["coas"])[:8],
        "recent": [recent_row(x) for x in sorted(orders, key=lambda x: x.paid_at, reverse=True)[:6]],
        "orders": order_rows(replace(ds, orders=tuple(orders)), start=None, end=end),
    }
```

- [ ] **Step 4: Implement the route** (append to `routes.py`, after every fixed route)

```python
class Identity(BaseModel):
    key: str
    name: str
    email: Optional[str] = None
    company: Optional[str] = None
    wc_id: Optional[int] = None
    since: str


class DossierKpis(BaseModel):
    lifetime: str
    rank: int
    customers: int
    orders: int
    avg_order: str
    samples: int
    samples_per_order: float
    usual_gap_days: Optional[float] = None
    gap_iqr: Optional[list[float]] = None
    nonconforming_rate: Optional[float] = None
    lab_nonconforming_rate: Optional[float] = None
    on_time_rate: Optional[float] = None
    lab_on_time_rate: Optional[float] = None


class MonthSpendSamples(BaseModel):
    month: str
    spend: str
    samples: int


class TestShare(BaseModel):
    test: str
    share: float
    all_share: float


class AnalyteRate(BaseModel):
    product: str
    coas: int
    pass_rate: float


class RecentOrder(BaseModel):
    order_number: str
    paid_at: str
    coas: int
    failed: int
    sla: Optional[str] = None


class DossierResponse(Meta):
    identity: Identity
    kpis: DossierKpis
    status: str
    days_since_last: Optional[float] = None
    overdue: float
    spend_delta_pct: Optional[float] = None
    monthly: list[MonthSpendSamples]
    order_dates: list[str]
    test_mix: list[TestShare]
    analytes: list[AnalyteRate]
    recent: list[RecentOrder]
    orders: list[OrderRow]


@router.get("/{customer_key}", response_model=DossierResponse)
def customer_dossier(customer_key: str, db: Session = Depends(get_db), _u=Depends(get_current_user)):
    ds, _lo, hi, tz, meta = _ctx(db, "all", None, None, False)
    d = metrics.dossier(ds, customer_key.strip().lower() if customer_key.startswith("email:") else customer_key,
                        end=hi, tz=tz)
    if d is None:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="customer not found")
    return {**meta, **d}
```

- [ ] **Step 5: Run backend tests**

Run: `pytest tests/test_customer_insights_metrics.py tests/test_customer_insights_routes.py -q` → all pass.

- [ ] **Step 6: Frontend dashboard tab**

Add the `CustomerDossier` type to `api.ts`, mirroring `DossierResponse` field-for-field. Then add:

```ts
export const getCustomerDossier = (key: string) =>
  getReport<CustomerDossier>(`/reports/customers/${encodeURIComponent(key)}`)
```

`CustomerDashboard.tsx` follows the comp `assets/2026-10-05-customer-insights/customer.html`:
- an at-risk banner when `status === 'at_risk'` ("No order in {days_since_last} days · usually orders every {usual_gap_days} days · {overdue}× overdue");
- 6 KPI tiles, where the non-conforming and on-time tiles show the lab average under them;
- a `ComposedChart` (Bar spend + Line samples by month);
- an order-rhythm strip as an inline SVG with one tick per `order_dates` entry, and the current silence shaded red when at risk;
- a "What they test" bar list (`share` vs `all_share`);
- a top analytes table, where clicking a product calls `onOpenAnalyte(product)`. The parent wires that to `setActiveSection('reports'); setActiveSubSection('dashboard')` (Analyte Trends);
- a "Their experience with us" table from `recent` (COA chip: failed > 0 → red "N fail" else "Pass"; SLA chip: late/on time/blank).

Every state is covered: loading, error with retry, and a 404 rendered as "No paid orders for this customer yet".

Test (`CustomerDashboard.test.tsx`, same mock pattern as Task 6):
- mock `getCustomerDossier` with an at-risk dossier;
- assert the banner text, `$96,110`, and `#3 of 782`;
- assert a "Retatrutide" row with `81%`;
- assert an SLA chip "late".

Assert also that with `on_time_rate: null` the On-time tile shows `n/a`.

- [ ] **Step 7: Wire into `CustomerStatusPage.tsx` and run gates**

- Replace the placeholder tab content. Derive `customerKey` as `wc:${customer.id}` for registered customers, or the `email:` key passed from a guest row.
- In `CustomerOrdersTab`, `useQuery(['customers', 'dossier', key], ...)`, then add Total, Discount and Coupon cells per order row by `order_number`.
- Run `npx vitest run src/components/customers src/test/customer-status-page.test.tsx`. The existing test asserts the placeholder text "Coming soon"; that's a stale test, so update it to the dashboard's loading state.
- Run `npm run typecheck`, then eslint and prettier on the touched files.

- [ ] **Step 8: Commit**

```bash
git add backend/customer_insights backend/tests src/lib/api.ts src/components/customers src/components/CustomerStatusPage.tsx src/test/customer-status-page.test.tsx
git commit -m "feat(customer-insights): customer dossier route and Dashboard tab"
```

---

### Task 9: Churn signals and the change feed

**Files:**
- Modify: `backend/customer_insights/metrics.py` (append `churn_signals`, `changes`)
- Modify: `backend/customer_insights/routes.py`. Add `GET /churn-signals` and `GET /changes`, declared BEFORE `/{customer_key}`.
- Test: append to the metrics and routes test files
- Modify: `src/lib/api.ts`, `src/components/customers/CustomerInsights.tsx` (the "Why customers stop?" card, plus its test assertion)

**Interfaces:**
- Produces:
  - `churn_signals(ds, *, end: datetime) -> dict`: `{window_days: 60, buckets: [{signal, group, orders: int, returned: float|None}]}`, where `signal` is one of `"sla" | "conformance" | "retest"` and `group` is one of `"on_time" | "late" | "all_pass" | "any_fail" | "no_retest" | "retest"`. An order counts only if it is a testing order paid at least 60 days before `end`. `returned` = share whose customer placed another testing order within 60 days after it. The SLA buckets are omitted when SLA is unavailable.
  - `changes(ds, *, since: datetime, end: datetime, tz: str) -> list[dict]`, each `{type, customer_key, name, detected_at: iso(end), detail: dict}`, with types `became_at_risk`, `spend_drop`, `first_reorder`, `returned`, `entered_top_decile`.

- [ ] **Step 1: Append failing tests**

```python
def test_churn_signals_buckets() -> None:
    a = [o("wc:1", 0, oid=1, number="1"), o("wc:1", 30, oid=2, number="2")]    # returned within 60
    b = [o("wc:2", 0, oid=3, number="3")]                                        # never returned
    coas = [Coa("1", "P", "X", True, T0), Coa("3", "P", "X", False, T0)]
    data = ds(a + b, coas=coas, late=frozenset({"3"}), delivered=frozenset({"1", "3"}))
    out = metrics.churn_signals(data, end=T0 + timedelta(days=200))
    b_ = {(x["signal"], x["group"]): x for x in out["buckets"]}
    assert b_[("conformance", "all_pass")]["returned"] == 1.0
    assert b_[("conformance", "any_fail")]["returned"] == 0.0
    assert b_[("sla", "late")]["orders"] == 1
    assert ("sla", "late") not in {(x["signal"], x["group"]) for x in metrics.churn_signals(ds(a + b), end=T0 + timedelta(days=200))["buckets"]}


def test_changes_feed_types() -> None:
    weekly = [o("wc:1", d, "100") for d in (0, 7, 14, 21)]
    second = [o("wc:2", 0), o("wc:2", 40)]
    data = ds(weekly + second)
    since, end = T0 + timedelta(days=30), T0 + timedelta(days=60)
    types = {(c["type"], c["customer_key"]) for c in metrics.changes(data, since=since, end=end, tz=TZ)}
    assert ("became_at_risk", "wc:1") in types
    assert ("first_reorder", "wc:2") in types
```

Route tests (append):

```python
def test_changes_and_churn_routes(client) -> None:
    r = client.get("/reports/customers/changes?since=2026-01-01T00:00:00Z").json()
    assert {"type", "customer_key", "name", "detected_at", "detail"} <= set(r["events"][0]) if r["events"] else True
    assert "buckets" in client.get("/reports/customers/churn-signals").json()
    assert client.get("/reports/customers/changes").status_code == 422   # since is required
```

- [ ] **Step 2: Run to verify failure**

Run the two test files → the new tests FAIL.

- [ ] **Step 3: Implement** (append to `metrics.py`)

```python
def churn_signals(ds: Dataset, *, end: datetime) -> dict[str, Any]:
    window = timedelta(days=rules.CHURN_WINDOW_DAYS)
    testing = [x for x in ds.orders if x.is_testing]
    retested = {x.retest_of_order_id for x in ds.orders if x.retest_of_order_id}
    by_key: dict[str, list[datetime]] = defaultdict(list)
    for x in testing:
        by_key[x.customer_key].append(x.paid_at)
    coa_by_order: dict[str, list[bool]] = defaultdict(list)
    for c in ds.coas:
        coa_by_order[c.order_number].append(c.passed)
    acc: dict[tuple[str, str], list[bool]] = defaultdict(list)
    for x in testing:
        if x.paid_at > end - window:
            continue
        came_back = any(x.paid_at < d <= x.paid_at + window for d in by_key[x.customer_key])
        if ds.delivered_orders is not None and ds.late_orders is not None and x.order_number in ds.delivered_orders:
            acc[("sla", "late" if x.order_number in ds.late_orders else "on_time")].append(came_back)
        if coa_by_order.get(x.order_number):
            acc[("conformance", "all_pass" if all(coa_by_order[x.order_number]) else "any_fail")].append(came_back)
        acc[("retest", "retest" if x.order_id in retested else "no_retest")].append(came_back)
    return {"window_days": rules.CHURN_WINDOW_DAYS,
            "buckets": [{"signal": s, "group": g, "orders": len(v), "returned": _rate(sum(v), len(v))}
                        for (s, g), v in sorted(acc.items())]}


def changes(ds: Dataset, *, since: datetime, end: datetime, tz: str) -> list[dict[str, Any]]:
    """Stateless diff: rule outputs at `since` vs `end`.
    ponytail: recomputes both instants; persist events if bots need an audit trail."""
    before = {r["key"]: r for r in customer_rows(ds, start=since - timedelta(days=90), end=since, tz=tz)}
    after = {r["key"]: r for r in customer_rows(ds, start=end - timedelta(days=90), end=end, tz=tz)}

    def decile(rows: dict[str, dict]) -> set[str]:
        ranked = sorted(rows.values(), key=lambda r: Decimal(r["lifetime"]), reverse=True)
        return {r["key"] for r in ranked[: max(1, len(ranked) // 10)]} if ranked else set()

    top_before, top_after = decile(before), decile(after)
    t_before = testing_dates(ds, since)
    t_after = testing_dates(ds, end)
    events = []

    def ev(kind: str, key: str, **detail: Any) -> None:
        events.append({"type": kind, "customer_key": key, "name": after[key]["name"],
                       "detected_at": end.isoformat(), "detail": detail})

    for key, r in after.items():
        prev = before.get(key)
        prev_status = prev["status"] if prev else None
        if r["status"] == "at_risk" and prev_status != "at_risk":
            ev("became_at_risk", key, usual_gap_days=r["usual_gap_days"], last_order_at=r["last_order_at"])
        if r["status"] == "dropping" and prev_status != "dropping":
            ev("spend_drop", key, period_spend=r["period_spend"], prior_spend=r["prior_spend"], delta_pct=r["delta_pct"])
        if len(t_before.get(key, [])) == 1 and len(t_after.get(key, [])) >= 2:
            ev("first_reorder", key, orders=len(t_after[key]))
        if prev_status == "at_risk" and r["status"] != "at_risk":
            ev("returned", key, last_order_at=r["last_order_at"])
        if key in top_after and key not in top_before:
            ev("entered_top_decile", key, lifetime=r["lifetime"])
    return events
```

In `routes.py` (before `/{customer_key}`):

```python
class SignalBucket(BaseModel):
    signal: str
    group: str
    orders: int
    returned: Optional[float] = None


class ChurnResponse(Meta):
    window_days: int
    buckets: list[SignalBucket]


class ChangeEvent(BaseModel):
    type: str
    customer_key: str
    name: str
    detected_at: str
    detail: dict


class ChangesResponse(Meta):
    since: str
    events: list[ChangeEvent]


@router.get("/churn-signals", response_model=ChurnResponse)
def customers_churn(db: Session = Depends(get_db), _u=Depends(get_current_user)):
    ds, _lo, hi, _tz_, meta = _ctx(db, "all", None, None, False)
    return {**meta, **metrics.churn_signals(ds, end=hi)}


@router.get("/changes", response_model=ChangesResponse)
def customers_changes(since: datetime, db: Session = Depends(get_db), _u=Depends(get_current_user)):
    ds, _lo, hi, tz, meta = _ctx(db, "all", None, None, False)
    since_utc = since if since.tzinfo else since.replace(tzinfo=timezone.utc)
    return {**meta, "since": since_utc.isoformat(), "events": metrics.changes(ds, since=since_utc, end=hi, tz=tz)}
```

Frontend: add `getCustomerChurnSignals()` and a "Why do customers stop?" card to `CustomerInsights.tsx`.
- One bar row per bucket (label map: `on_time` "COA on time", `late` "COA late (SLA missed)", `all_pass` "All COAs conforming", `any_fail` "Got a non-conforming COA", `no_retest` "No retest", `retest` "Needed a retest").
- Show `fmtPct(returned, 0)` and `n = orders`.
- Footnote: "Correlation, not proof. Share who ordered again within 60 days."
- Extend the page test to assert "Got a non-conforming COA".

- [ ] **Step 4: Run tests and gates**

Run:
- `pytest tests/test_customer_insights_metrics.py tests/test_customer_insights_routes.py -q` → pass.
- `npx vitest run src/components/customers` → pass.
- typecheck, eslint and prettier on the touched files.

- [ ] **Step 5: Commit**

```bash
git add backend/customer_insights backend/tests src/lib/api.ts src/components/customers
git commit -m "feat(customer-insights): churn signals and change feed for monitoring"
```

---

### Task 10: labmanager-mcp allowlist

**Repo:** `C:\Users\forre\OneDrive\Documents\GitHub\labmanager-mcp`. Use a fresh worktree off `origin/master`; the main checkout has uncommitted edits from another session.

**Files:**
- Modify: `src/labmanager_mcp/tools/reports.py` (the `REPORTS` dict)
- Test: `tests/test_tools_flagging_reports.py` (append)

**Interfaces:**
- Consumes: the Mk1 routes from Tasks 5, 8 and 9.
- Produces: report names `analyte-trends`, `customers-summary`, `customers-cohorts`, `customers-at-risk`, `customers-list`, `customers-orders`, `customers-churn-signals` and `customers-changes`, plus a `reports_customer(key)` tool for the dossier. The dossier path embeds the key, so it can't be a static allowlist entry; it is one more narrow tool.

- [ ] **Step 1: Write the failing test**

```python
def test_customer_reports_allowlisted_and_dossier_tool(fake_client) -> None:
    from labmanager_mcp.tools import reports

    for name, path in [("analyte-trends", "/reports/analyte-trends"),
                       ("customers-summary", "/reports/customers/summary"),
                       ("customers-changes", "/reports/customers/changes")]:
        assert reports.REPORTS[name][0] == path
    reports.get_customer(fake_client, "email:g@x.com")
    assert fake_client.calls[-1][0] == "/reports/customers/email%3Ag%40x.com"
```

Match the fixture name and `FakeClient` call recording to the existing tests in this file (`test_every_advertised_report_is_fetchable`); rename `fake_client` / `calls` to what they use.

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_tools_flagging_reports.py -q` → new test FAILS.

- [ ] **Step 3: Implement**

Add to `REPORTS`:

```python
    "analyte-trends": ("/reports/analyte-trends",
                       "every published primary COA with purity/identity/endo/sterility/HM verdicts"),
    "customers-summary": ("/reports/customers/summary",
                          "customer KPIs, revenue new vs returning, concentration, attach, first-order repeat; "
                          "params: period=30d|90d|6m|1y|all, exclude_launch_accounts"),
    "customers-cohorts": ("/reports/customers/cohorts", "re-order cohort grid by first-order month"),
    "customers-at-risk": ("/reports/customers/at-risk",
                          "customers overdue vs their own re-order gap, ranked by 12-month spend"),
    "customers-list": ("/reports/customers/list",
                       "paged customer rows; params: period, search, sort, dir, page, page_size"),
    "customers-orders": ("/reports/customers/orders",
                         "one row per paid order (net, coupons, samples, tests); params: period, page, page_size"),
    "customers-churn-signals": ("/reports/customers/churn-signals",
                                "60-day return rate split by SLA late, non-conforming COA, retest"),
    "customers-changes": ("/reports/customers/changes",
                          "MONITORING FEED. param since=<ISO time of your last run>. Events: became_at_risk, "
                          "spend_drop, first_reorder, returned, entered_top_decile. Poll daily; raise a flag "
                          "or post a digest for became_at_risk and spend_drop; use reports_customer for context."),
```

Add:

```python
from urllib.parse import quote


def get_customer(client, key: str) -> dict:
    """One customer's dossier. key is 'wc:<id>' or 'email:<address>' (from customers-list rows)."""
    if not (key.startswith("wc:") or key.startswith("email:")):
        raise ValueError("customer key must start with 'wc:' or 'email:'")
    return client.get_json(f"/reports/customers/{quote(key, safe='')}")
```

Register it as a tool `reports_customer(key: str)` next to `reports_get` (lines 69–86), following the same registration pattern and docstring style.

- [ ] **Step 4: Run tests**

Run: `pytest -q` → all pass, including the existing `test_report_paths_carry_no_api_prefix`.

- [ ] **Step 5: Commit** (in the labmanager-mcp worktree)

```bash
git add src/labmanager_mcp/tools/reports.py tests/test_tools_flagging_reports.py
git commit -m "feat(reports): customer insights + analyte-trends allowlist, reports_customer tool"
```

---

### Task 11: Stack e2e with screenshots

**Files:**
- Create: `e2e/customer-insights.spec.ts`
- Create: `docs/superpowers/e2e/2026-10-05-customer-insights/` (screenshots + `run-notes.txt`)

**Interfaces:**
- Consumes: a devbox stack with Mk1 and IS mounted on this branch and Plan 1's branch. Plan 1's migration must be applied (`docker compose -p accumark-<stack> exec -T integration-service alembic upgrade head`; stacks do not apply mounted migrations on their own). `wc_orders` must be backfilled from the stack's WordPress: `POST /admin/backfill-orders` on the stack IS.

- [ ] **Step 1: Write the spec** (mirrors `e2e/analyte-trends.spec.ts`: `authedPage`, `viewport` 1600×1000, and the API helper reading `accu_mk1_auth_token`)

```ts
import { test, expect } from './fixtures/auth'
import type { Page } from '@playwright/test'

const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8012'
const SHOTS = 'docs/superpowers/e2e/2026-10-05-customer-insights'
test.use({ viewport: { width: 1600, height: 1000 } })

async function api<T>(page: Page, path: string): Promise<T> {
  const token = await page.evaluate(() => window.localStorage.getItem('accu_mk1_auth_token'))
  const res = await page.request.get(`${BACKEND_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  expect(res.ok()).toBeTruthy()
  return (await res.json()) as T
}

test('insights page renders and matches the API', async ({ authedPage: page }) => {
  await page.goto('/#accumark-tools/customer-insights')
  await expect(page.getByRole('heading', { name: 'Customer Insights', level: 1 })).toBeVisible({ timeout: 20_000 })
  const s = await api<{ kpis: { paid_orders: { value: number } } }>(page, '/reports/customers/summary?period=90d')
  await expect(page.getByText(s.kpis.paid_orders.value.toLocaleString('en-US')).first()).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/01-insights.png`, fullPage: true })
})

test('customer dashboard tab opens from the at-risk list or the list', async ({ authedPage: page }) => {
  await page.goto('/#accumark-tools/customer-insights')
  const risk = await api<{ rows: { key: string; name: string }[] }>(page, '/reports/customers/at-risk')
  const list = await api<{ rows: { key: string; name: string }[] }>(page, '/reports/customers/list?period=all&page_size=1')
  const target = risk.rows[0] ?? list.rows[0]
  test.skip(!target, 'no customers with paid orders on this stack')
  if (risk.rows[0]) {
    await page.getByText(target.name, { exact: true }).first().click()
  } else {
    await page.goto('/#accumark-tools/customers')
    await page.getByText(target.name, { exact: true }).first().click()
    await page.getByRole('tab', { name: 'Dashboard' }).click()
  }
  await expect(page.getByText(/Lifetime spend/i)).toBeVisible({ timeout: 20_000 })
  await page.screenshot({ path: `${SHOTS}/02-customer-dashboard.png`, fullPage: true })
})

test('agent feed responds', async ({ authedPage: page }) => {
  await page.goto('/#accumark-tools/customer-insights')
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const r = await api<{ events: unknown[] }>(page, `/reports/customers/changes?since=${encodeURIComponent(since)}`)
  expect(Array.isArray(r.events)).toBeTruthy()
})
```

Confirm the hash route for AccuMark Tools sub-sections (`#accumark-tools/customer-insights`) against how `#reports/dashboard` worked for Analyte Trends. Use the section id from `AppSidebar.tsx`.

- [ ] **Step 2: Run on the stack**

Follow the `accumark-stack-platform` skill on the devbox:
- `create <name>`;
- worktrees for Mk1 and IS;
- `mount --mk1 --is`;
- the alembic upgrade;
- the backfill.

Then run `. /c/tmp/<name>-e2e.env && node node_modules/@playwright/test/cli.js test e2e/customer-insights.spec.ts --reporter=list` → 3 passed (or 2 + 1 skipped on an empty stack).

Look at both screenshots before committing. Golden stack data is dev data, so state in `run-notes.txt` that the money values there mean nothing.

- [ ] **Step 3: Commit**

```bash
git add e2e/customer-insights.spec.ts docs/superpowers/e2e/2026-10-05-customer-insights
git commit -m "test(e2e): customer insights stack run with screenshots"
```

---

### Task 12: Ship (each production step needs Handler sign-off)

- [ ] **Step 1:** Ship order: Plan 1 is already deployed and backfilled, and its acceptance passed.
- [ ] **Step 2: Fill the account lists** (read-only on prod IS):
  1. Find the two $0 January internal accounts and the five February launch accounts from the 2026-10-02 analysis: `SELECT customer_id, billing_email, min(date_paid_gmt), sum(total - refund_total) FROM wc_orders WHERE date_paid_gmt < '2026-03-01' GROUP BY 1, 2 ORDER BY 3`.
  2. Show the candidate list to the Handler. After confirmation, set `INTERNAL_CUSTOMER_KEYS` and `LAUNCH_ACCOUNT_KEYS` in `rules.py`.
  3. Add a test asserting both sets are non-empty and well-formed (`wc:` / `email:` prefixes).
- [ ] **Step 3: Acceptance on prod** (spec section 9; read-only).
  - Call each endpoint in-container like the Analyte Trends smoke: `docker exec -w /app -e PYTHONPATH=/app accu-mk1-backend python /tmp/x.py`, with a token from `auth.create_access_token`.
  - Compare with the 2026-10-02 baseline:
    - 782 customers;
    - September revenue $366.0K;
    - the repeat rate on the any-paid-order definition, 24.0%. Compute it once ad hoc for comparison; the endpoint reports the testing-order definition;
    - median 10 days to the second order;
    - top 10% = 85.8%.
  - Put the table in the PR.
- [ ] **Step 4:** PRs for Mk1 and labmanager-mcp with the e2e evidence, then merge.
- [ ] **Step 5:** Release and deploy Mk1 via `accumark-deploy` (version bump + CHANGELOG, path A from a master worktree, `REMOTE_HOST=100.120.92.93`, after hours preferred). Verify `/api/health` and the in-container route smoke.
- [ ] **Step 6:** Update labmanager-mcp on the bot host per its own deploy notes (never pull master on the bot host blindly; follow the documented procedure), then restart Hermes. Confirm with `reports_get('customers-changes', {since: ...})` from a bot session.
