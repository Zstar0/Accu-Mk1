"""API tests for /sla-priority-tiers (sparse priority -> tier map).

Self-restoring: snapshots row IDs before and deletes any new rows after. The
multi-tier follow-on means multiple rows can share a priority (one global +
one per group), so the legacy "track priorities" approach over-deletes if any
new row reuses a priority that already existed. Tracking IDs is unambiguous.

Run in container:
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


def _make_temp_service_group() -> int:
    """Insert a uniquely-named service group and return its id. The autouse
    cleanup fixture removes test-created groups after the test completes.
    `color` + timestamps are NOT NULL in the real schema, so we supply them."""
    with engine.begin() as c:
        return c.execute(
            text(
                "INSERT INTO service_groups (name, color, sort_order, created_at, updated_at) "
                "VALUES (:n, '#888', 999, NOW(), NOW()) RETURNING id"
            ),
            {"n": f"_test_grp_{__import__('uuid').uuid4().hex[:8]}"},
        ).scalar()


@pytest.fixture(autouse=True)
def cleanup_rows():
    with engine.connect() as c:
        before_priority_ids = {
            r[0]
            for r in c.execute(text("SELECT id FROM sla_priority_tiers")).fetchall()
        }
        before_group_ids = {
            r[0] for r in c.execute(text("SELECT id FROM service_groups")).fetchall()
        }
    yield
    with engine.begin() as c:
        # Delete priority overrides created during the test (by id, so we don't
        # touch a co-priority row that existed before).
        c.execute(
            text(
                "DELETE FROM sla_priority_tiers WHERE id NOT IN "
                "(SELECT unnest(CAST(:ids AS INTEGER[])))"
            ),
            {"ids": list(before_priority_ids) or [0]},
        )
        # Delete test-created service groups (CASCADE removes any lingering
        # per-group priority rows, but the step above usually already did).
        c.execute(
            text(
                "DELETE FROM service_groups WHERE id NOT IN "
                "(SELECT unnest(CAST(:ids AS INTEGER[])))"
            ),
            {"ids": list(before_group_ids) or [0]},
        )


def test_list_empty_or_returns_rows():
    resp = client.get("/sla-priority-tiers")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)
    # Every row should now expose id + service_group_id (may be null).
    for row in resp.json():
        assert "id" in row
        assert "service_group_id" in row


def test_upsert_then_list_contains_mapping():
    tid = _default_tier_id()
    resp = client.put("/sla-priority-tiers/expedited", json={"sla_tier_id": tid})
    assert resp.status_code == 200, resp.text
    assert resp.json()["service_group_id"] is None
    rows = {
        (r["priority"], r["service_group_id"]): r["sla_tier_id"]
        for r in client.get("/sla-priority-tiers").json()
    }
    assert rows.get(("expedited", None)) == tid


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
    rows = {(r["priority"], r["service_group_id"]) for r in client.get("/sla-priority-tiers").json()}
    assert ("expedited", None) not in rows


# ─── Multi-tier follow-on: per-(priority, group) overrides ───────────────────


def test_upsert_per_group_creates_distinct_row_from_global():
    tid = _default_tier_id()
    gid = _make_temp_service_group()
    # Global override for expedited.
    r_global = client.put("/sla-priority-tiers/expedited", json={"sla_tier_id": tid})
    assert r_global.status_code == 200
    # Per-group override for the same priority. Must coexist as a separate row.
    r_group = client.put(
        "/sla-priority-tiers/expedited",
        json={"sla_tier_id": tid, "service_group_id": gid},
    )
    assert r_group.status_code == 200, r_group.text
    assert r_group.json()["service_group_id"] == gid
    assert r_group.json()["id"] != r_global.json()["id"]
    # Both rows must surface from list.
    rows = {(r["priority"], r["service_group_id"]) for r in client.get("/sla-priority-tiers").json()}
    assert ("expedited", None) in rows
    assert ("expedited", gid) in rows


def test_upsert_per_group_is_idempotent_per_group():
    tid = _default_tier_id()
    gid = _make_temp_service_group()
    client.put(
        "/sla-priority-tiers/high",
        json={"sla_tier_id": tid, "service_group_id": gid},
    )
    r = client.put(
        "/sla-priority-tiers/high",
        json={"sla_tier_id": tid, "service_group_id": gid},
    )
    assert r.status_code == 200
    # No duplicate rows for (high, gid).
    matches = [
        x for x in client.get("/sla-priority-tiers").json()
        if x["priority"] == "high" and x["service_group_id"] == gid
    ]
    assert len(matches) == 1


def test_upsert_per_group_rejects_unknown_group():
    tid = _default_tier_id()
    r = client.put(
        "/sla-priority-tiers/expedited",
        json={"sla_tier_id": tid, "service_group_id": 999_999},
    )
    assert r.status_code == 404


def test_delete_per_group_only_removes_that_group_row():
    tid = _default_tier_id()
    gid = _make_temp_service_group()
    client.put("/sla-priority-tiers/expedited", json={"sla_tier_id": tid})
    client.put(
        "/sla-priority-tiers/expedited",
        json={"sla_tier_id": tid, "service_group_id": gid},
    )
    # Delete only the per-group row.
    r = client.delete(f"/sla-priority-tiers/expedited?service_group_id={gid}")
    assert r.status_code == 200, r.text
    rows = {(x["priority"], x["service_group_id"]) for x in client.get("/sla-priority-tiers").json()}
    assert ("expedited", None) in rows  # global survives
    assert ("expedited", gid) not in rows  # per-group gone


def test_delete_global_does_not_touch_per_group_row():
    tid = _default_tier_id()
    gid = _make_temp_service_group()
    client.put("/sla-priority-tiers/expedited", json={"sla_tier_id": tid})
    client.put(
        "/sla-priority-tiers/expedited",
        json={"sla_tier_id": tid, "service_group_id": gid},
    )
    # Delete the GLOBAL row (no query param).
    assert client.delete("/sla-priority-tiers/expedited").status_code == 200
    rows = {(x["priority"], x["service_group_id"]) for x in client.get("/sla-priority-tiers").json()}
    assert ("expedited", None) not in rows  # global gone
    assert ("expedited", gid) in rows  # per-group survives


def test_delete_missing_per_group_returns_404():
    gid = _make_temp_service_group()
    r = client.delete(f"/sla-priority-tiers/expedited?service_group_id={gid}")
    assert r.status_code == 404


def test_service_group_cascade_deletes_per_group_rows():
    tid = _default_tier_id()
    gid = _make_temp_service_group()
    client.put(
        "/sla-priority-tiers/expedited",
        json={"sla_tier_id": tid, "service_group_id": gid},
    )
    # Drop the group; FK ON DELETE CASCADE removes the priority override.
    with engine.begin() as c:
        c.execute(text("DELETE FROM service_groups WHERE id = :g"), {"g": gid})
    rows = {(x["priority"], x["service_group_id"]) for x in client.get("/sla-priority-tiers").json()}
    assert ("expedited", gid) not in rows
