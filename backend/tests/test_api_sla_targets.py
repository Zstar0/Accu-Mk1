"""API tests for /sla-targets (sub-project A).

Exercise CRUD + the always-one-default invariant against the live accumark_mk1
DB. The flush-before-insert ordering in _demote_other_defaults can only be
verified against a real Postgres (the partial unique index uq_sla_single_default
is non-deferrable), which is why these are integration tests, not unit tests.

They mutate sla_targets, so the autouse fixture snapshots the table and restores
it (deletes test-created rows, re-promotes the original default) after each
test. Run in the backend container:
    docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_sla_targets.py -q'
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import auth
from database import engine
from main import app

# The endpoints bind get_current_user only as a gate (_current_user is unused),
# so a dummy override is enough to exercise the routes without a real JWT.
app.dependency_overrides[auth.get_current_user] = lambda: {"id": 0, "username": "test"}
client = TestClient(app)


def _snapshot():
    with engine.connect() as c:
        return {
            r[0]: r[1]
            for r in c.execute(
                text("SELECT id, is_default FROM sla_targets")
            ).fetchall()
        }


@pytest.fixture(autouse=True)
def restore_sla_targets():
    before = _snapshot()
    orig_default = next((i for i, d in before.items() if d), None)
    yield
    after = _snapshot()
    new_ids = [i for i in after if i not in before]
    with engine.begin() as c:
        if new_ids:
            c.execute(
                text("DELETE FROM sla_targets WHERE id = ANY(:ids)"),
                {"ids": new_ids},
            )
        if orig_default is not None:
            # One statement → Postgres tolerates the transient multi-true state
            # and lands on exactly one default (the original seed).
            c.execute(
                text("UPDATE sla_targets SET is_default = (id = :d)"),
                {"d": orig_default},
            )


def test_list_returns_seeded_default():
    resp = client.get("/sla-targets")
    assert resp.status_code == 200
    defaults = [r for r in resp.json() if r["is_default"]]
    assert len(defaults) == 1
    assert defaults[0]["target_minutes"] == 1440


def test_create_target_returns_201():
    resp = client.post(
        "/sla-targets",
        json={"analysis_service_id": None, "priority": "high", "target_minutes": 240},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["priority"] == "high"
    assert body["target_minutes"] == 240


def test_create_rejects_invalid_priority():
    resp = client.post("/sla-targets", json={"priority": "hihg", "target_minutes": 60})
    assert resp.status_code == 422


def test_create_default_demotes_previous_default():
    # The crux: _demote_other_defaults must flush the demotion UPDATE before the
    # INSERT, or the non-deferrable uq_sla_single_default rejects a 2nd default.
    resp = client.post(
        "/sla-targets",
        json={"priority": None, "analysis_service_id": None,
              "target_minutes": 720, "is_default": True},
    )
    assert resp.status_code == 201, resp.text
    new_id = resp.json()["id"]
    defaults = [r for r in client.get("/sla-targets").json() if r["is_default"]]
    assert len(defaults) == 1
    assert defaults[0]["id"] == new_id


def test_cannot_delete_default():
    default_id = next(r["id"] for r in client.get("/sla-targets").json() if r["is_default"])
    resp = client.delete(f"/sla-targets/{default_id}")
    assert resp.status_code == 409


def test_cannot_unset_only_default():
    default_id = next(r["id"] for r in client.get("/sla-targets").json() if r["is_default"])
    resp = client.put(f"/sla-targets/{default_id}", json={"is_default": False})
    assert resp.status_code == 409


def test_delete_non_default_target():
    created = client.post(
        "/sla-targets", json={"priority": "expedited", "target_minutes": 30}
    ).json()
    resp = client.delete(f"/sla-targets/{created['id']}")
    assert resp.status_code == 200


def test_resolve_unmatched_falls_back_to_default():
    # A service id that surely has no specific row → the catch-all default.
    resp = client.get(
        "/sla-targets/resolve", params={"service_id": 987654, "priority": "normal"}
    )
    assert resp.status_code == 200
    assert resp.json()["is_default"] is True
