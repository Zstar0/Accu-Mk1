"""API tests for business-hours config + holidays (sub-project B).

Self-restoring against the live accumark_mk1 DB.
    docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_business_hours.py -q'
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import auth
from database import engine
from main import app

app.dependency_overrides[auth.get_current_user] = lambda: {"id": 0, "username": "test"}
client = TestClient(app)


@pytest.fixture(autouse=True)
def restore_config():
    with engine.connect() as c:
        before = c.execute(text("SELECT open_time, close_time, timezone, working_days FROM business_hours_config WHERE id=1")).fetchone()
    yield
    if before is not None:
        with engine.begin() as c:
            c.execute(
                text("UPDATE business_hours_config SET open_time=:o, close_time=:cl, timezone=:tz, working_days=:wd WHERE id=1"),
                {"o": before[0], "cl": before[1], "tz": before[2], "wd": __import__("json").dumps(list(before[3]))},
            )


def test_get_returns_seeded_config():
    resp = client.get("/business-hours-config")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["timezone"] == "America/Los_Angeles"
    assert body["working_days"] == [0, 1, 2, 3, 4]
    assert body["open_time"].startswith("09:00")
    assert body["close_time"].startswith("17:00")


def test_put_updates_config():
    resp = client.put("/business-hours-config", json={
        "open_time": "08:30", "close_time": "16:30",
        "timezone": "America/New_York", "working_days": [0, 1, 2, 3, 4, 5],
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["open_time"].startswith("08:30")
    assert body["timezone"] == "America/New_York"
    assert body["working_days"] == [0, 1, 2, 3, 4, 5]


def test_put_rejects_unknown_timezone():
    resp = client.put("/business-hours-config", json={
        "open_time": "09:00", "close_time": "17:00", "timezone": "Mars/Olympus", "working_days": [0, 1, 2, 3, 4],
    })
    assert resp.status_code == 422


def test_put_rejects_close_before_open():
    resp = client.put("/business-hours-config", json={
        "open_time": "17:00", "close_time": "09:00", "timezone": "America/Los_Angeles", "working_days": [0, 1, 2, 3, 4],
    })
    assert resp.status_code == 422


def test_put_rejects_out_of_range_working_days():
    resp = client.put("/business-hours-config", json={
        "open_time": "09:00", "close_time": "17:00", "timezone": "America/Los_Angeles", "working_days": [0, 7],
    })
    assert resp.status_code == 422
