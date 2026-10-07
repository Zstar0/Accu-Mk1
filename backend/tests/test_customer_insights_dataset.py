# backend/tests/test_customer_insights_dataset.py
from datetime import datetime, timezone
from decimal import Decimal

from customer_insights.dataset import build_dataset, norm_order_number, service_label

PAID = datetime(2026, 9, 10, 15, tzinfo=timezone.utc)


def order_row(id_, customer_id=1188, email="ops@h.example", total="100.00", refund="0.00",
              status="completed", paid=PAID, coupons=None, items=None, coupon_lines=None, discount="0.00"):
    # columns: id, order_number, customer_id, billing_email, status, total, discount_total,
    #          refund_total, coupon_codes, line_items, date_paid_gmt, coupon_lines
    return (id_, str(id_), customer_id, email, status, Decimal(total), Decimal(discount),
            Decimal(refund), coupons or [], items or [{"category": "testing"}], paid, coupon_lines or [])


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
               customers=[(1188, "ops@h.example", "Ops", "Team", "Halcyon", "none", None)])
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


def test_duplicate_submissions_last_row_wins() -> None:
    # Contract: sources.SUBMISSIONS_SQL emits one row per order (newest last/only);
    # if duplicates reach build_dataset anyway, the LAST one wins.
    ds = build([order_row(1)], [sub_row(1, [SAMPLE], is_transfer=True), sub_row(1, [SAMPLE, SAMPLE])])
    (o,) = ds.orders
    assert o.is_testing and o.samples == 2


def test_norm_order_number() -> None:
    for raw in ("WP-8642", "wp-8642", "#8642", " 8642 ", 8642):
        assert norm_order_number(raw) == "8642"
    assert norm_order_number("WP-") == ""


def test_sla_wp_prefix_joins_bare_order_numbers() -> None:
    sla = [{"order": "WP-1", "state": "delivered", "late": True}]
    ds = build([order_row(1)], sla=sla, coas=[("#1", "P-1", "BPC-157", "PASSED", PAID)])
    assert ds.orders[0].order_number == "1"
    assert "1" in ds.late_orders and "1" in ds.delivered_orders
    assert ds.coas[0].order_number == "1"


def test_retest_order_is_paid_not_testing_and_retested_ids_from_all_submissions() -> None:
    # Order 2 is a paid retest of 1; order 4 is a FREE retest of 3 (net 0, so not in ds.orders).
    ds = build([order_row(1), order_row(2), order_row(3), order_row(4, total="0.00")],
               [sub_row(1, [SAMPLE]), sub_row(2, [SAMPLE], is_retest=True, retest_of=1),
                sub_row(3, [SAMPLE]), sub_row("4", [SAMPLE], is_retest=True, retest_of="3"),
                sub_row(5, [SAMPLE])])
    by_id = {o.order_id: o for o in ds.orders}
    assert set(by_id) == {1, 2, 3}
    assert by_id[2].is_retest and not by_id[2].is_testing and by_id[2].samples == 0
    assert by_id[1].is_testing and by_id[3].is_testing
    assert ds.retested_order_ids == frozenset({1, 3})


def test_lines_coupons_and_rep() -> None:
    items = [
        {"name": "HPLC Identity, Purity & Quantity", "product_id": 2853, "qty": 2, "total": "300.00", "category": "testing"},
        {"name": "Sterility (PCR)", "product_id": 2856, "qty": 1, "total": "120.00", "category": "addon"},
        {"name": "Additional COA - Order #8134 / KLOW (Lot X)", "product_id": 3061, "qty": 1, "total": "25", "category": "additional_coa"},
        {"name": "Prepaid balance", "product_id": None, "qty": 1, "total": "-50.00", "category": "fee"},
    ]
    renamed = [{"name": "Rapid Sterility Screening (PCR) Addon", "product_id": 2856, "qty": 1, "total": "140", "category": "addon"}] * 2
    ds = build(
        [order_row(1, items=items, coupons=["AC15", "sc5"], discount="544.00", coupon_lines=[
            {"code": "AC15", "discount": "408.00", "type": "percent", "amount": 15},
            {"code": "sc5", "discount": "136.00", "type": "fixed_cart", "amount": "136"}]),
         order_row(2, items=renamed, coupons=["solo"], discount="20.00"),
         order_row(3, customer_id=1557, items=renamed, coupons=["ghost"],
                   coupon_lines=[{"code": "ghost", "discount": "102", "type": "percent", "amount": 15}])],
        customers=[(1188, "ops@h.example", "Ops", "Team", None, "1557", None),
                   (1557, "scott@lab.example", "Scott", None, None, "none", None),
                   (77, "x@y.example", "X", None, None, "999", None)])
    o1, o2, o3 = ds.orders
    assert [(ln.product, ln.qty, ln.total) for ln in o1.lines] == [
        ("HPLC Identity, Purity & Quantity", 2, Decimal("300.00")),
        ("Rapid Sterility Screening (PCR) Addon", 1, Decimal("120.00")),   # pid label = most common name
        ("Additional COAs", 1, Decimal("25.00")),
    ]  # fee line dropped
    assert [(c.code, c.discount, c.terms) for c in o1.coupon_lines] == [
        ("ac15", Decimal("408.00"), "15%"), ("sc5", Decimal("136.00"), "$136.00")]
    assert [(c.code, c.discount, c.terms) for c in o2.coupon_lines] == [("solo", Decimal("20.00"), None)]
    # WC kept a coupon line but the order's discount_total is 0: nothing was saved.
    assert [(c.code, c.discount) for c in o3.coupon_lines] == [("ghost", Decimal("0.00"))]
    assert ds.customers["wc:1188"].rep == "Scott"
    assert ds.customers["wc:1557"].rep is None
    assert ds.customers["wc:77"].rep == "Agent #999"


def test_coupon_covered_zero_orders_are_free_not_revenue() -> None:
    hplc = [{"name": "HPLC", "product_id": 2853, "qty": 1, "total": "0.00", "category": "testing"}]
    ds = build([order_row(1, total="0.00", coupons=["first-one-on-us"], discount="250.00", items=hplc),
                order_row(2, total="0.00", items=hplc),                        # free retest, no coupon
                order_row(3, total="100.00", refund="100.00", coupons=["x"])])  # fully refunded
    assert ds.orders == ()
    (f,) = ds.free_orders
    assert f.order_id == 1 and f.coupon_lines[0].discount == Decimal("250.00")


def test_rep_prefers_commissions_history_then_salesking() -> None:
    from customer_insights.dataset import current_agent
    hist = '[{"agent_id":1557,"from":"2026-07-01"},{"agent_id":0,"from":"2099-01-01"}]'
    assert current_agent(hist, "2026-10-06") == "1557"
    assert current_agent(hist, "2099-02-01") is None          # 0 = unassigned from then on
    assert current_agent([{"agent_id": 1557, "from": "2099-01-01"}], "2026-10-06") is None  # future only
    assert current_agent("not json", "2026-10-06") is None
    ds = build([order_row(1)], customers=[
        (1, "a@x", "A", None, None, "none", hist),        # history only
        (2, "b@x", "B", None, None, "1557", None),        # SalesKing only
        (3, "c@x", "C", None, None, "none", "[]"),        # neither
        (1557, "s@x", "Scott", None, None, "none", None)])
    assert [ds.customers[k].rep for k in ("wc:1", "wc:2", "wc:3")] == ["Scott", "Scott", None]


def test_line_subtotal_parsed_when_mirrored() -> None:
    items = [{"name": "HPLC", "product_id": 1, "qty": 2, "total": "170", "subtotal": "200", "category": "testing"},
             {"name": "HPLC", "product_id": 1, "qty": 1, "total": "100", "category": "testing"}]
    (o,) = build([order_row(1, total="270.00", items=items)]).orders
    assert [ln.subtotal for ln in o.lines] == [Decimal("200.00"), None]
