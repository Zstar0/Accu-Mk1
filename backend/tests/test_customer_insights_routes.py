from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from auth import get_current_user
from customer_insights import routes, sources
from customer_insights.dataset import CouponLine, Customer, Dataset, Line, Order
from database import get_db

NOW = datetime(2026, 10, 5, 18, tzinfo=timezone.utc)


def _o(key, days_ago, net="100", oid=1):
    return Order(oid, str(oid), key, NOW - timedelta(days=days_ago), Decimal(net), Decimal(0),
                 ("accutry50",), ("testing",), True, 2, ("HPLC", "Endotoxin"), False, None,
                 (Line("HPLC", 2, Decimal(net)),), (CouponLine("accutry50", Decimal("50.00"), "50%"),))


DS = Dataset(
    {"wc:1": Customer("wc:1", "Halcyon", "ops@h.example", "Halcyon", 1, "Scott"),
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


def test_orders_json_and_at_risk_fields_survive(client) -> None:
    body = client.get("/reports/customers/orders?period=all").json()
    assert body["total"] == 4 and body["rows"][0]["coupons"] == ["accutry50"]
    assert {"customer_key", "net", "tests", "categories"} <= set(body["rows"][0])
    risk = client.get("/reports/customers/at-risk").json()["rows"][0]
    assert {"spend_12m", "overdue", "monthly", "top_tests"} <= set(risk)


def test_dossier_route_guest_key_and_404(client) -> None:
    body = client.get("/reports/customers/email:g@x.com").json()
    assert body["identity"]["key"] == "email:g@x.com"
    assert {"lifetime", "rank", "on_time_rate"} <= set(body["kpis"])
    assert body["orders"][0]["net"] == "125.00"
    assert client.get("/reports/customers/wc:999").status_code == 404
    # fixed routes still win over the key route
    assert client.get("/reports/customers/summary").status_code == 200


def test_dossier_route_nested_fields_survive(client) -> None:
    body = client.get("/reports/customers/wc:1").json()
    assert body["tz"] == "America/Los_Angeles"
    assert body["identity"] == {"key": "wc:1", "name": "Halcyon", "email": "ops@h.example",
                                "company": "Halcyon", "wc_id": 1, "rep": "Scott", "since": body["identity"]["since"]}
    assert body["kpis"]["gap_iqr"] == [10.0, 10.0] and body["kpis"]["usual_gap_days"] == 10.0
    assert {"lab_nonconforming_rate", "lab_on_time_rate", "samples_per_order"} <= set(body["kpis"])
    assert body["status"] == "at_risk" and body["overdue"] > 1
    assert set(body["monthly"][0]) == {"month", "spend", "samples"}
    assert set(body["test_mix"][0]) == {"test", "share", "all_share"}
    assert set(body["recent"][0]) == {"order_number", "paid_at", "coas", "failed", "sla"}
    assert body["recent"][0]["sla"] is None
    assert len(body["order_dates"]) == 3 and body["orders"][0]["coupons"] == ["accutry50"]
    assert {"days_since_last", "spend_delta_pct", "analytes"} <= set(body)
    # guest keys match case-insensitively
    assert client.get("/reports/customers/email:G@X.com").status_code == 200


def test_changes_and_churn_routes(client) -> None:
    r = client.get("/reports/customers/changes?since=2026-01-01T00:00:00Z")
    assert r.status_code == 200
    body = r.json()
    assert body["since"].startswith("2026-01-01")
    assert body["events"], "fixture should yield at least one event"
    assert {"type", "customer_key", "name", "detected_at", "detail"} <= set(body["events"][0])
    assert isinstance(body["events"][0]["detail"], dict)
    # naive since is treated as UTC
    assert client.get("/reports/customers/changes?since=2026-01-01T00:00:00").status_code == 200
    churn = client.get("/reports/customers/churn-signals")
    assert churn.status_code == 200      # not swallowed by /{customer_key} (would 404)
    assert "buckets" in churn.json() and churn.json()["window_days"] == 60
    assert client.get("/reports/customers/changes").status_code == 422   # since is required


def test_from_to_aliases_filter_the_window(client) -> None:
    base = "/reports/customers/orders?period=all"
    assert client.get(base).json()["total"] == 4
    assert client.get(base + "&from=2026-08-01&to=2026-08-31").json()["total"] == 0
    assert client.get(base + "&from=2026-09-20&to=2026-09-30").json()["total"] == 1
    assert client.get(base + "&start=2026-09-20&end=2026-09-30").json()["total"] == 1
    summ = client.get("/reports/customers/summary?from=2026-08-01&to=2026-08-31").json()
    assert summ["kpis"]["revenue"]["value"] == "0.00"
    lst = client.get("/reports/customers/list?from=2026-09-20&to=2026-09-30").json()
    assert {r["key"]: r["period_spend"] for r in lst["rows"]}["email:g@x.com"] == "125.00"


def test_list_sort_allowlist_and_nulls_last(client) -> None:
    for bad in ("monthly", "top_tests", "nope"):
        assert client.get(f"/reports/customers/list?period=all&sort={bad}").status_code == 422
    for d in ("asc", "desc"):   # wc:1 usual_gap_days = 10.0, guest = None
        rows = client.get(f"/reports/customers/list?period=all&sort=usual_gap_days&dir={d}").json()["rows"]
        assert [r["key"] for r in rows] == ["wc:1", "email:g@x.com"]
    rows = client.get("/reports/customers/list?period=all&sort=lifetime&dir=asc").json()["rows"]
    assert [r["key"] for r in rows] == ["email:g@x.com", "wc:1"]


def test_changes_since_in_the_future_is_422(client) -> None:
    assert client.get("/reports/customers/changes?since=2026-10-06T00:00:00Z").status_code == 422
    assert client.get("/reports/customers/changes?since=2026-10-06T00:00:00").status_code == 422
    assert client.get("/reports/customers/changes?since=2026-10-05T17:00:00Z").status_code == 200


def test_pricing_coupon_and_rep_keys_survive_response_models(client) -> None:
    summary = client.get("/reports/customers/summary?period=all").json()
    assert summary["product_prices"][0] == {"product": "HPLC", "units": 8, "avg_price": "53.12",
                                            "revenue": "425.00", "customers": 2, "free_units": 0,
                                            "list_price": None, "discount_pct": None}
    rows = client.get("/reports/customers/list?period=all&search=scott").json()["rows"]
    assert [r["rep"] for r in rows] == ["Scott"]
    d = client.get("/reports/customers/wc:1").json()
    assert d["identity"]["rep"] == "Scott"
    assert d["test_prices"][0]["lab_avg_price"] == "53.12" and d["free_tests"] == 0
    assert d["coupons"][0] == {"code": "accutry50", "orders": 3, "discount": "150.00", "terms": "50%",
                               "last_used": (NOW - timedelta(days=180)).isoformat()}


def test_dossier_sla_section_survives_response_model(client, monkeypatch) -> None:
    from dataclasses import replace

    from customer_insights.dataset import SlaRec

    recs = (SlaRec("1", "delivered", 30.0, 24.0, True, {"hplc": 6.0, "ster": 29.0}, {"hplc": 24.0, "ster": 24.0}),)
    monkeypatch.setattr(sources, "load_dataset", lambda db, now: replace(DS, sla=recs))
    d = client.get("/reports/customers/wc:1").json()
    assert d["sla"]["customer"]["late"] == 1 and d["sla"]["lab"]["delivered"] == 1
    ster = next(f for f in d["sla"]["families"] if f["key"] == "ster")
    assert ster["name"] == "Sterility" and ster["held_up"] == 1 and ster["over_target_rate"] == 1.0
