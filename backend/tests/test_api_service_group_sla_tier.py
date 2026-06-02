"""Service groups carry an sla_tier_id (sub-project C). Self-restoring.

Run in container:
    docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_service_group_sla_tier.py -q'
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
def cleanup_groups():
    with engine.connect() as c:
        before = {r[0] for r in c.execute(text("SELECT id FROM service_groups")).fetchall()}
    yield
    with engine.begin() as c:
        after = {r[0] for r in c.execute(text("SELECT id FROM service_groups")).fetchall()}
        new = list(after - before)
        if new:
            c.execute(text("DELETE FROM service_groups WHERE id = ANY(:i)"), {"i": new})


def test_create_group_with_sla_tier():
    tid = _default_tier_id()
    resp = client.post(
        "/service-groups",
        json={"name": "Microbiology Test", "sla_tier_id": tid},
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["sla_tier_id"] == tid


def test_update_group_sla_tier_and_clear():
    tid = _default_tier_id()
    gid = client.post("/service-groups", json={"name": "Grp X"}).json()["id"]
    assert client.put(f"/service-groups/{gid}", json={"sla_tier_id": tid}).json()["sla_tier_id"] == tid
    assert client.put(f"/service-groups/{gid}", json={"sla_tier_id": None}).json()["sla_tier_id"] is None
