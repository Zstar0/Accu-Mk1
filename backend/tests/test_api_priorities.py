"""API tests for /priorities. Self-restoring: deletes rows it created."""
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import auth
from database import engine
from main import app

app.dependency_overrides[auth.get_current_user] = lambda: {"id": 0, "username": "test"}
client = TestClient(app)


@pytest.fixture(autouse=True)
def _cleanup():
    created: list[str] = []
    yield created
    with engine.begin() as c:
        for key in created:
            c.execute(text("DELETE FROM sla_priority_tiers WHERE priority = :k"), {"k": key})
            c.execute(text("DELETE FROM priority_audit WHERE new_key = :k OR old_key = :k"), {"k": key})
            c.execute(text("DELETE FROM priorities WHERE key = :k"), {"k": key})


def test_list_has_seeded_default_first_by_rank_desc():
    r = client.get("/priorities"); assert r.status_code == 200
    keys = [p["key"] for p in r.json()]
    assert keys.index("expedited") < keys.index("high") < keys.index("default")


def test_create_patch_map_and_deactivate(_cleanup):
    name = f"Rush {uuid.uuid4().hex[:6]}"
    r = client.post("/priorities", json={"name": name, "rank": 30, "icon": "flame", "color": "red", "pulse": True})
    assert r.status_code == 201, r.text
    key = r.json()["key"]; _cleanup.append(key)
    assert key.startswith("rush-") and r.json()["sla_tier_id"] is None

    tier_id = client.get("/sla-tiers").json()[0]["id"]
    r = client.patch(f"/priorities/{key}", json={"sla_tier_id": tier_id, "rank": 35})
    assert r.status_code == 200 and r.json()["sla_tier_id"] == tier_id and r.json()["rank"] == 35
    assert any(row["priority"] == key for row in client.get("/sla-priority-tiers").json())

    r = client.patch(f"/priorities/{key}", json={"sla_tier_id": None})
    assert r.json()["sla_tier_id"] is None

    r = client.delete(f"/priorities/{key}"); assert r.status_code == 200
    assert next(p for p in client.get("/priorities").json() if p["key"] == key)["is_active"] is False


def test_bad_icon_rejected_and_default_undeletable():
    r = client.post("/priorities", json={"name": "x", "rank": 1, "icon": "star", "color": "red"})
    assert r.status_code == 422
    assert client.delete("/priorities/default").status_code == 409


def test_assign_rejects_unknown_level():
    r = client.put("/priorities/assign", json={"level": "planet", "id": "1", "priority_key": "high"})
    assert r.status_code == 422


def test_resolve_unknown_pk_returns_default():
    r = client.post("/priorities/resolve", json={"sample_pks": [999999]})
    assert r.status_code == 200
    assert r.json()["samples"]["999999"]["key"] == "default"


def test_customers_seen_is_bounded():
    r = client.get("/priorities/customers/seen", params={"q": ""})
    assert r.status_code == 200 and len(r.json()) <= 25
