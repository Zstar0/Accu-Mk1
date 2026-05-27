"""API tests for the batch POST /sla/status endpoint (sub-project B).

    docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_sla_status.py -q'
"""
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlalchemy import event

import auth
from database import engine
from main import app

app.dependency_overrides[auth.get_current_user] = lambda: {"id": 0, "username": "test"}
client = TestClient(app)


def _iso_minutes_ago(minutes):
    return (datetime.utcnow() - timedelta(minutes=minutes)).isoformat()


def test_null_received_at_yields_null_status():
    resp = client.post("/sla/status", json={"items": [
        {"key": "a", "received_at": None, "target_minutes": 60, "business_hours_only": False},
    ]})
    assert resp.status_code == 200, resp.text
    item = resp.json()["items"][0]
    assert item["key"] == "a"
    assert item["status"] is None


def test_raw_path_elapsed_and_breach():
    resp = client.post("/sla/status", json={"items": [
        {"key": "k1", "received_at": _iso_minutes_ago(120), "target_minutes": 60, "business_hours_only": False},
    ]})
    item = resp.json()["items"][0]
    assert item["key"] == "k1"
    assert item["status"]["breached"] is True
    assert item["status"]["elapsed_minutes"] >= 119


def test_keys_echoed_and_correlated_not_by_order():
    resp = client.post("/sla/status", json={"items": [
        {"key": "uid-x", "received_at": None, "target_minutes": 60, "business_hours_only": False},
        {"key": "uid-y", "received_at": _iso_minutes_ago(10), "target_minutes": 60, "business_hours_only": False},
    ]})
    by_key = {i["key"]: i for i in resp.json()["items"]}
    assert set(by_key) == {"uid-x", "uid-y"}
    assert by_key["uid-x"]["status"] is None
    assert by_key["uid-y"]["status"] is not None


def test_business_hours_path_differs_from_raw():
    # A 3-day-old sample: raw elapsed is ~4320 min; business elapsed is far less
    # (weekends/after-hours excluded). Just assert business <= raw for a bh item.
    received = _iso_minutes_ago(3 * 24 * 60)
    resp = client.post("/sla/status", json={"items": [
        {"key": "raw", "received_at": received, "target_minutes": 60, "business_hours_only": False},
        {"key": "bh", "received_at": received, "target_minutes": 60, "business_hours_only": True},
    ]})
    by_key = {i["key"]: i["status"]["elapsed_minutes"] for i in resp.json()["items"]}
    assert by_key["bh"] <= by_key["raw"]


def test_loaded_once_query_count_is_constant_regardless_of_batch_size():
    # Count statements against config + holidays tables; must not scale with N.
    def _count_for(n):
        seen = {"hits": 0}

        def _listen(conn, cursor, statement, params, context, executemany):
            s = statement.lower()
            if "business_hours_config" in s or "lab_holidays" in s:
                seen["hits"] += 1

        event.listen(engine, "before_cursor_execute", _listen)
        try:
            items = [
                {"key": str(i), "received_at": _iso_minutes_ago(30), "target_minutes": 60, "business_hours_only": True}
                for i in range(n)
            ]
            client.post("/sla/status", json={"items": items})
        finally:
            event.remove(engine, "before_cursor_execute", _listen)
        return seen["hits"]

    assert _count_for(1) == _count_for(50)
