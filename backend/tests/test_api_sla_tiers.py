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


# ── amber_threshold_percent (sub-project D2) ──────────────────────────────


def test_get_includes_amber_threshold_percent_with_default_20():
    rows = client.get("/sla-tiers").json()
    assert rows, "expected at least the seeded default tier"
    for r in rows:
        assert "amber_threshold_percent" in r
        assert 1 <= r["amber_threshold_percent"] <= 100


def test_create_accepts_custom_amber_threshold():
    resp = client.post(
        "/sla-tiers",
        json={"name": "Custom amber", "target_minutes": 480, "amber_threshold_percent": 33},
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["amber_threshold_percent"] == 33


def test_create_default_omits_amber_falls_back_to_20():
    resp = client.post("/sla-tiers", json={"name": "Default amber", "target_minutes": 240})
    assert resp.status_code == 201, resp.text
    assert resp.json()["amber_threshold_percent"] == 20


def test_put_can_update_amber_threshold_without_touching_other_fields():
    new_id = client.post(
        "/sla-tiers", json={"name": "PUT amber", "target_minutes": 720}
    ).json()["id"]
    resp = client.put(f"/sla-tiers/{new_id}", json={"amber_threshold_percent": 50})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["amber_threshold_percent"] == 50
    assert body["name"] == "PUT amber"
    assert body["target_minutes"] == 720


def test_create_rejects_amber_threshold_below_1():
    resp = client.post(
        "/sla-tiers",
        json={"name": "Bad amber low", "target_minutes": 240, "amber_threshold_percent": 0},
    )
    assert resp.status_code == 422


def test_create_rejects_amber_threshold_above_100():
    resp = client.post(
        "/sla-tiers",
        json={"name": "Bad amber high", "target_minutes": 240, "amber_threshold_percent": 101},
    )
    assert resp.status_code == 422


def test_put_rejects_amber_threshold_out_of_range():
    new_id = client.post(
        "/sla-tiers", json={"name": "Range PUT", "target_minutes": 240}
    ).json()["id"]
    assert client.put(f"/sla-tiers/{new_id}", json={"amber_threshold_percent": 0}).status_code == 422
    assert client.put(f"/sla-tiers/{new_id}", json={"amber_threshold_percent": 101}).status_code == 422


def test_amber_threshold_boundaries_1_and_100_accepted():
    # 1 (lower bound)
    r1 = client.post(
        "/sla-tiers",
        json={"name": "Min amber", "target_minutes": 60, "amber_threshold_percent": 1},
    )
    assert r1.status_code == 201, r1.text
    assert r1.json()["amber_threshold_percent"] == 1
    # 100 (upper bound)
    r100 = client.post(
        "/sla-tiers",
        json={"name": "Max amber", "target_minutes": 60, "amber_threshold_percent": 100},
    )
    assert r100.status_code == 201, r100.text
    assert r100.json()["amber_threshold_percent"] == 100
