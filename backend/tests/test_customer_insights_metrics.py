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


def test_concentration_pins_lifetime_values() -> None:
    # lifetime nets: wc:1 = 400 (repeater), wc:2 = 100, wc:3 = 100; total 600
    data = ds([o("wc:1", 0, "100"), o("wc:1", 20, "300"), o("wc:2", 1, "100"), o("wc:3", 2, "100")])
    c = metrics.summary(data, start=None, end=T0 + timedelta(days=100), tz=TZ)["concentration"]
    assert c["customers"] == 3
    assert c["top10_share"] == 1.0
    assert c["top_decile_share"] == 0.6667   # max(1, 3 // 10) = 1 customer: 400 / 600
    assert c["repeat_share"] == 0.6667
    assert c["median_ltv"] == "100.00"
    assert c["mean_ltv"] == "200.00"


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
