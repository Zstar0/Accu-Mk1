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
                                "company": "Halcyon", "wc_id": 1, "since": body["identity"]["since"]}
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
