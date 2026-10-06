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
