"""API tests for /sla-tiers (sub-project A, revised to tiers).

Exercise CRUD + the always-one-default invariant against the live accumark_mk1
DB. Self-restoring: the autouse fixture deletes test-created tiers and
re-promotes the original default after each test.

Run in the backend container:
    docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_sla_tiers.py -q'
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import auth
from database import engine
from main import app

app.dependency_overrides[auth.get_current_user] = lambda: {"id": 0, "username": "test"}
client = TestClient(app)


def _snapshot():
    with engine.connect() as c:
        return {
            r[0]: r[1]
            for r in c.execute(text("SELECT id, is_default FROM sla_tiers")).fetchall()
        }


@pytest.fixture(autouse=True)
def restore_sla_tiers():
    before = _snapshot()
    orig_default = next((i for i, d in before.items() if d), None)
    yield
    after = _snapshot()
    new_ids = [i for i in after if i not in before]
    with engine.begin() as c:
        if new_ids:
            c.execute(text("DELETE FROM sla_tiers WHERE id = ANY(:ids)"), {"ids": new_ids})
        if orig_default is not None:
            c.execute(text("UPDATE sla_tiers SET is_default = (id = :d)"), {"d": orig_default})


def test_list_returns_seeded_default():
    resp = client.get("/sla-tiers")
    assert resp.status_code == 200
    defaults = [r for r in resp.json() if r["is_default"]]
    assert len(defaults) == 1
    assert defaults[0]["target_minutes"] == 1440


def test_create_tier_returns_201():
    resp = client.post("/sla-tiers", json={"name": "Rush", "target_minutes": 240})
    assert resp.status_code == 201, resp.text
    assert resp.json()["name"] == "Rush"
    assert resp.json()["target_minutes"] == 240


def test_create_default_demotes_previous_default():
    resp = client.post(
        "/sla-tiers", json={"name": "New default", "target_minutes": 720, "is_default": True}
    )
    assert resp.status_code == 201, resp.text
    new_id = resp.json()["id"]
    defaults = [r for r in client.get("/sla-tiers").json() if r["is_default"]]
    assert len(defaults) == 1
    assert defaults[0]["id"] == new_id


def test_put_promote_to_default_demotes_previous():
    # Create a non-default tier, promote it via PUT, verify the old default demoted.
    new_id = client.post("/sla-tiers", json={"name": "Promote me", "target_minutes": 480}).json()["id"]
    resp = client.put(f"/sla-tiers/{new_id}", json={"is_default": True})
    assert resp.status_code == 200, resp.text
    defaults = [r for r in client.get("/sla-tiers").json() if r["is_default"]]
    assert len(defaults) == 1
    assert defaults[0]["id"] == new_id


def test_cannot_delete_default():
    default_id = next(r["id"] for r in client.get("/sla-tiers").json() if r["is_default"])
    assert client.delete(f"/sla-tiers/{default_id}").status_code == 409


def test_cannot_unset_only_default():
    default_id = next(r["id"] for r in client.get("/sla-tiers").json() if r["is_default"])
    assert client.put(f"/sla-tiers/{default_id}", json={"is_default": False}).status_code == 409


def test_delete_non_default_tier():
    created = client.post("/sla-tiers", json={"name": "Temp", "target_minutes": 30}).json()
    assert client.delete(f"/sla-tiers/{created['id']}").status_code == 200
