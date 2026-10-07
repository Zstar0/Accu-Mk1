# backend/tests/test_customer_insights_metrics.py
from datetime import datetime, timedelta, timezone
from dataclasses import replace
from decimal import Decimal

from customer_insights import metrics
from customer_insights.dataset import Coa, CouponLine, Customer, Dataset, Line, Order, build_dataset

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


def test_dossier_lab_nonconforming_ignores_out_of_scope_coas() -> None:
    data = ds([o("wc:1", 0, oid=10, number="10")],
              coas=[Coa("10", "P-1", "BPC-157", True, T0), Coa("999", "P-9", "BPC-157", False, T0)])
    d = metrics.dossier(data, "wc:1", end=T0 + timedelta(days=1), tz=TZ)
    assert d["kpis"]["lab_nonconforming_rate"] == 0.0   # order 999 is not in scope


def test_dossier_without_sla_or_coas() -> None:
    d = metrics.dossier(ds([o("wc:1", 0)]), "wc:1", end=T0 + timedelta(days=1), tz=TZ)
    assert d["kpis"]["on_time_rate"] is None and d["kpis"]["nonconforming_rate"] is None
    assert d["recent"][0]["sla"] is None


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


def test_scope_drops_registered_test_account_by_email() -> None:
    data = ds([o("wc:9", 0, "5000"), o("wc:1", 1, "100")])
    customers = dict(data.customers)
    customers["wc:9"] = Customer("wc:9", "T", "Forrest@ValenceAnalytical.com", None, 9)
    data = replace(data, customers=customers)
    scoped = metrics.scope(data, exclude_launch=False)
    assert [x.customer_key for x in scoped.orders] == ["wc:1"]
    assert set(scoped.customers) == {"wc:1"}
    out = metrics.summary(scoped, start=T0 - timedelta(days=1), end=T0 + timedelta(days=100), tz=TZ)
    assert out["kpis"]["active_customers"]["value"] == 1
    assert out["kpis"]["revenue"]["value"] == "100.00"


# --- F1: retests are paid orders, never testing orders (built through build_dataset) ---
def _raw(oid, day, total="100.00", cid=1):
    return (oid, str(oid), cid, f"c{cid}@x.example", "completed", Decimal(total), Decimal(0), Decimal(0),
            [], [{"category": "testing"}], T0 + timedelta(days=day), [])


def _sub(oid, retest_of=None):
    return (oid, [{"services": {"hplcpurity&identity": True}}], retest_of is not None, retest_of, False, {})


def _built(orders, subs, sla=None):
    return build_dataset(order_rows=orders, submission_rows=subs, customer_rows=(), coa_rows=(),
                         sla_records=sla, synced_at=None)


def test_paid_retest_is_not_a_reorder() -> None:
    data = _built([_raw(1, 0), _raw(2, 20)], [_sub(1), _sub(2, retest_of=1)])
    end = T0 + timedelta(days=100)
    k = metrics.summary(data, start=None, end=end, tz=TZ)["kpis"]
    assert k["paid_orders"]["value"] == 2 and k["revenue"]["value"] == "200.00"
    assert k["repeat_rate"]["value"] == 0.0 and k["median_days_to_second"]["value"] is None
    (row,) = metrics.customer_rows(data, start=None, end=end, tz=TZ)
    assert row["samples"] == 1
    events = metrics.changes(data, since=T0 + timedelta(days=10), end=end, tz=TZ)
    assert not [e for e in events if e["type"] == "first_reorder"]


def test_retest_does_not_mark_at_risk_customer_returned() -> None:
    data = _built([_raw(1, 0), _raw(2, 7), _raw(3, 14), _raw(4, 70)],
                  [_sub(1), _sub(2), _sub(3), _sub(4, retest_of=3)])
    since, end = T0 + timedelta(days=60), T0 + timedelta(days=80)
    events = metrics.changes(data, since=since, end=end, tz=TZ)
    assert not [e for e in events if e["type"] == "returned"]
    (row,) = metrics.customer_rows(data, start=end - timedelta(days=90), end=end, tz=TZ)
    assert row["status"] == "at_risk"


def test_churn_retest_buckets_count_free_retests_and_skip_immature() -> None:
    orders = [_raw(1, 0, cid=1), _raw(2, 20, cid=1),                 # 2 = paid retest of 1
              _raw(3, 0, cid=2), _raw(4, 5, total="0.00", cid=2),    # 4 = FREE retest of 3 (not in ds.orders)
              _raw(5, 0, cid=3), _raw(6, 30, cid=3),                 # 3 came back once
              _raw(7, 190, cid=4)]                                   # inside the last 60 days: immature
    subs = [_sub(1), _sub(2, retest_of=1), _sub(3), _sub(4, retest_of=3), _sub(5), _sub(6), _sub(7)]
    sla = [{"order": "1", "state": "delivered", "late": True},
           {"order": "5", "state": "delivered", "late": False},
           {"order": "7", "state": "delivered", "late": False}]
    out = metrics.churn_signals(_built(orders, subs, sla=sla), end=T0 + timedelta(days=200))
    b = {(x["signal"], x["group"]): x for x in out["buckets"]}
    assert (b[("retest", "retest")]["orders"], b[("retest", "retest")]["returned"]) == (2, 0.0)
    assert (b[("retest", "no_retest")]["orders"], b[("retest", "no_retest")]["returned"]) == (2, 0.5)
    assert (b[("sla", "late")]["orders"], b[("sla", "late")]["returned"]) == (1, 0.0)
    assert (b[("sla", "on_time")]["orders"], b[("sla", "on_time")]["returned"]) == (1, 1.0)   # 7 is immature


def test_product_prices_and_coupon_use() -> None:
    hplc = Line("HPLC", 2, Decimal("270.00"))
    a = replace(o("wc:1", 0, oid=1), lines=(hplc, Line("Endotoxin", 1, Decimal("100.00"))),
                coupon_lines=(CouponLine("ac15", Decimal("40.00"), "15%"),))
    b = replace(o("wc:1", 10, oid=2), lines=(Line("HPLC", 1, Decimal("150.00")),),
                coupon_lines=(CouponLine("ac15", Decimal("20.00"), "20%"), CouponLine("sc5", Decimal("5.00"), None)))
    c = replace(o("wc:2", 5, oid=3), lines=(Line("HPLC", 1, Decimal("200.00")), Line("Free", 0, Decimal("0"))))
    data = ds([a, b, c])
    end = T0 + timedelta(days=30)
    prices = metrics.summary(data, start=T0 - timedelta(days=1), end=end, tz=TZ)["product_prices"]
    assert prices == [
        {"product": "HPLC", "units": 4, "avg_price": "155.00", "revenue": "620.00", "customers": 2},
        {"product": "Endotoxin", "units": 1, "avg_price": "100.00", "revenue": "100.00", "customers": 1},
    ]  # qty 0 lines skipped
    d = metrics.dossier(data, "wc:1", end=end, tz=TZ)
    assert d["test_prices"][0] == {"product": "HPLC", "units": 3, "avg_price": "140.00", "revenue": "420.00",
                                   "customers": 1, "lab_avg_price": "155.00"}
    assert d["coupons"] == [
        {"code": "ac15", "orders": 2, "discount": "60.00", "terms": "20%", "last_used": b.paid_at.isoformat()},
        {"code": "sc5", "orders": 1, "discount": "5.00", "terms": None, "last_used": b.paid_at.isoformat()},
    ]


def test_free_coupon_orders_count_for_pricing_and_coupons_not_revenue() -> None:
    paid = replace(o("wc:1", 0, "300", oid=1), lines=(Line("HPLC", 1, Decimal("300.00")),))
    free = replace(o("wc:1", 5, "0", oid=2), lines=(Line("HPLC", 1, Decimal("0.00")),),
                   coupon_lines=(CouponLine("first-one-on-us", Decimal("250.00"), "$250.00"),))
    data = replace(ds([paid]), free_orders=(free,))
    end = T0 + timedelta(days=30)
    out = metrics.summary(data, start=T0 - timedelta(days=1), end=end, tz=TZ)
    assert out["kpis"]["revenue"]["value"] == "300.00" and out["kpis"]["paid_orders"]["value"] == 1
    assert out["product_prices"][0] == {"product": "HPLC", "units": 2, "avg_price": "150.00",
                                        "revenue": "300.00", "customers": 1}
    d = metrics.dossier(data, "wc:1", end=end, tz=TZ)
    assert d["kpis"]["orders"] == 1
    assert [c["code"] for c in d["coupons"]] == ["first-one-on-us"]
    assert d["test_prices"][0]["avg_price"] == "150.00"
    assert metrics.scope(data, exclude_launch=False).free_orders == (free,)
