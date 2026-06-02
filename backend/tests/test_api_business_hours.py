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


import datetime as _dt


@pytest.fixture
def cleanup_holidays():
    created = []
    yield created
    if created:
        with engine.begin() as c:
            c.execute(text("DELETE FROM lab_holidays WHERE holiday_date::text = ANY(:ds)"), {"ds": created})


def test_list_holidays_for_current_year_includes_federal():
    y = _dt.date.today().year
    resp = client.get(f"/lab-holidays?year={y}")
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert any(r["source"] == "federal" for r in rows)
    # ordered by date
    dates = [r["holiday_date"] for r in rows]
    assert dates == sorted(dates)


def test_create_custom_holiday(cleanup_holidays):
    d = "2031-11-28"
    cleanup_holidays.append(d)
    resp = client.post("/lab-holidays", json={"holiday_date": d, "name": "Day after Thanksgiving"})
    assert resp.status_code == 201, resp.text
    assert resp.json()["source"] == "custom"
    assert resp.json()["name"] == "Day after Thanksgiving"


def test_create_duplicate_returns_409(cleanup_holidays):
    d = "2031-12-31"
    cleanup_holidays.append(d)
    assert client.post("/lab-holidays", json={"holiday_date": d, "name": "NYE"}).status_code == 201
    assert client.post("/lab-holidays", json={"holiday_date": d, "name": "NYE again"}).status_code == 409


def test_delete_holiday(cleanup_holidays):
    d = "2031-07-05"
    cleanup_holidays.append(d)
    client.post("/lab-holidays", json={"holiday_date": d, "name": "Extra"})
    resp = client.delete(f"/lab-holidays/{d}")
    assert resp.status_code == 200, resp.text
    # gone now
    assert client.delete(f"/lab-holidays/{d}").status_code == 404


def test_delete_missing_returns_404():
    assert client.delete("/lab-holidays/2031-01-15").status_code == 404


def test_generate_federal_for_year():
    year = 2098
    with engine.begin() as c:
        c.execute(text("DELETE FROM lab_holidays WHERE EXTRACT(year FROM holiday_date)=:y"), {"y": year})
    try:
        resp = client.post(f"/lab-holidays/generate-federal?year={year}")
        assert resp.status_code == 200, resp.text
        assert resp.json()["added"] == 11
        # second call adds nothing (idempotent)
        assert client.post(f"/lab-holidays/generate-federal?year={year}").json()["added"] == 0
    finally:
        with engine.begin() as c:
            c.execute(text("DELETE FROM lab_holidays WHERE EXTRACT(year FROM holiday_date)=:y"), {"y": year})


def test_delete_federal_holiday_then_restore():
    """Deleting a federal row is the lab's opt-out for a holiday it works.
    Self-restoring: re-inserts the row in a finally block."""
    y = _dt.date.today().year
    with engine.connect() as c:
        row = c.execute(text(
            "SELECT holiday_date, name FROM lab_holidays WHERE source='federal' "
            "AND EXTRACT(year FROM holiday_date)=:y ORDER BY holiday_date LIMIT 1"
        ), {"y": y}).fetchone()
    assert row is not None
    hdate, hname = row[0], row[1]
    try:
        resp = client.delete(f"/lab-holidays/{hdate}")
        assert resp.status_code == 200, resp.text
        listing = client.get(f"/lab-holidays?year={y}").json()
        assert all(r["holiday_date"] != str(hdate) for r in listing)
    finally:
        with engine.begin() as c:
            c.execute(text(
                "INSERT INTO lab_holidays (holiday_date, name, source, created_at) "
                "VALUES (:d, :n, 'federal', NOW()) ON CONFLICT (holiday_date) DO NOTHING"
            ), {"d": hdate, "n": hname})
