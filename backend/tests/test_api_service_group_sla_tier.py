"""Service groups carry an sla_tier_id (sub-project C). Self-restoring.

Creation via POST /service-groups is frozen (S2 Task 3 — group admin is
legacy, 410 always); the removed test_create_group_with_sla_tier asserted
that route returning 201, which is now permanently retired coverage (see
test_service_groups_freeze.py::test_create_service_group_is_gone for the
410). test_update_group_sla_tier_and_clear's setup is ported to insert a
ServiceGroup row directly via the db session instead of the dead route —
that test's actual assertions (PUT sets/clears sla_tier_id) are still live
behavior.

Run in container:
    docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_service_group_sla_tier.py -q'
"""
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import auth
from database import engine, SessionLocal
from main import app
from models import ServiceGroup

app.dependency_overrides[auth.get_current_user] = lambda: {"id": 0, "username": "test"}
client = TestClient(app)


def _default_tier_id():
    with engine.connect() as c:
        return c.execute(text("SELECT id FROM sla_tiers WHERE is_default")).scalar()


def _mk_group(name, sla_tier_id=None):
    """Insert a ServiceGroup row directly (creation route is frozen, S2 Task
    3). Suffixes name with a short uuid — this hits live PG's unique(name)
    constraint under concurrent sibling-agent runs otherwise."""
    db = SessionLocal()
    try:
        g = ServiceGroup(name=f"{name} {uuid.uuid4().hex[:8]}", sla_tier_id=sla_tier_id)
        db.add(g)
        db.commit()
        db.refresh(g)
        return g.id
    finally:
        db.close()


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


def test_update_group_sla_tier_and_clear():
    tid = _default_tier_id()
    gid = _mk_group("Grp X")
    assert client.put(f"/service-groups/{gid}", json={"sla_tier_id": tid}).json()["sla_tier_id"] == tid
    assert client.put(f"/service-groups/{gid}", json={"sla_tier_id": None}).json()["sla_tier_id"] is None
