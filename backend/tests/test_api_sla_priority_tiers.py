"""API tests for /sla-priority-tiers (sparse priority -> tier map).

Self-restoring: deletes priority rows created during the test. Run in container:
    docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_sla_priority_tiers.py -q'
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import auth
from database import engine
from main import app

app.dependency_overrides[auth.get_current_user] = lambda: {"id": 0, "username": "test"}
client = TestClient(app)


def _default_tier_id():
    with engine.connect() as c:
        return c.execute(text("SELECT id FROM sla_tiers WHERE is_default")).scalar()


@pytest.fixture(autouse=True)
def cleanup_priority_rows():
    with engine.connect() as c:
        before = {r[0] for r in c.execute(text("SELECT priority FROM sla_priority_tiers")).fetchall()}
    yield
    with engine.begin() as c:
        after = {r[0] for r in c.execute(text("SELECT priority FROM sla_priority_tiers")).fetchall()}
        new = list(after - before)
        if new:
            c.execute(text("DELETE FROM sla_priority_tiers WHERE priority = ANY(:p)"), {"p": new})


def test_list_empty_or_returns_rows():
    resp = client.get("/sla-priority-tiers")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


def test_upsert_then_list_contains_mapping():
    tid = _default_tier_id()
    resp = client.put("/sla-priority-tiers/expedited", json={"sla_tier_id": tid})
    assert resp.status_code == 200, resp.text
    rows = {r["priority"]: r["sla_tier_id"] for r in client.get("/sla-priority-tiers").json()}
    assert rows.get("expedited") == tid


def test_upsert_is_idempotent_update():
    tid = _default_tier_id()
    client.put("/sla-priority-tiers/high", json={"sla_tier_id": tid})
    resp = client.put("/sla-priority-tiers/high", json={"sla_tier_id": tid})
    assert resp.status_code == 200
    assert resp.json()["sla_tier_id"] == tid


def test_invalid_priority_rejected():
    tid = _default_tier_id()
    assert client.put("/sla-priority-tiers/bogus", json={"sla_tier_id": tid}).status_code == 422


def test_delete_removes_override():
    tid = _default_tier_id()
    client.put("/sla-priority-tiers/expedited", json={"sla_tier_id": tid})
    assert client.delete("/sla-priority-tiers/expedited").status_code == 200
    rows = {r["priority"] for r in client.get("/sla-priority-tiers").json()}
    assert "expedited" not in rows
