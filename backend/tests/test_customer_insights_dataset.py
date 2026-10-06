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
