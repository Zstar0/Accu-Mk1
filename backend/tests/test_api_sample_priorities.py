"""API tests for POST /sample-priorities/lookup (sub-project D2).

Self-restoring against the live accumark_mk1 DB.
    docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_sample_priorities.py -q'
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import auth
from database import engine
from main import app

app.dependency_overrides[auth.get_current_user] = lambda: {"id": 0, "username": "test"}
client = TestClient(app)


@pytest.fixture
def cleanup_priorities():
    created = []
    yield created
    if created:
        with engine.begin() as c:
            c.execute(text("DELETE FROM sample_priorities WHERE sample_uid = ANY(:uids)"), {"uids": created})


def _seed(uid: str, priority: str = "high"):
    with engine.begin() as c:
        c.execute(
            text(
                "INSERT INTO sample_priorities (sample_uid, priority, updated_at) "
                "VALUES (:u, :p, NOW()) "
                "ON CONFLICT (sample_uid) DO UPDATE SET priority=:p, updated_at=NOW()"
            ),
            {"u": uid, "p": priority},
        )


def test_empty_sample_uids_returns_422():
    resp = client.post("/sample-priorities/lookup", json={"sample_uids": []})
    assert resp.status_code == 422


def test_over_cap_returns_422():
    resp = client.post(
        "/sample-priorities/lookup",
        json={"sample_uids": [f"u-{i}" for i in range(501)]},
    )
    assert resp.status_code == 422
    assert "max" in resp.text.lower() or "500" in resp.text


def test_at_cap_500_uids_accepted(cleanup_priorities):
    uid = "d2-cap-test-001"
    _seed(uid, "expedited")
    cleanup_priorities.append(uid)
    payload = [f"d2-cap-noise-{i}" for i in range(499)] + [uid]
    resp = client.post("/sample-priorities/lookup", json={"sample_uids": payload})
    assert resp.status_code == 200, resp.text
    items = {i["sample_uid"]: i["priority"] for i in resp.json()["items"]}
    assert items == {uid: "expedited"}  # sparse: only present rows


def test_mixed_present_and_absent_returns_only_present(cleanup_priorities):
    uid_a, uid_b = "d2-mix-a", "d2-mix-b"
    _seed(uid_a, "high")
    _seed(uid_b, "expedited")
    cleanup_priorities.extend([uid_a, uid_b])
    resp = client.post(
        "/sample-priorities/lookup",
        json={"sample_uids": [uid_a, "absent-1", uid_b, "absent-2"]},
    )
    assert resp.status_code == 200, resp.text
    items = {i["sample_uid"]: i["priority"] for i in resp.json()["items"]}
    assert items == {uid_a: "high", uid_b: "expedited"}


def test_order_not_guaranteed_assert_as_set(cleanup_priorities):
    uids = [f"d2-order-{i}" for i in range(5)]
    for u in uids:
        _seed(u, "high")
        cleanup_priorities.append(u)
    resp = client.post("/sample-priorities/lookup", json={"sample_uids": list(reversed(uids))})
    assert resp.status_code == 200, resp.text
    assert set(i["sample_uid"] for i in resp.json()["items"]) == set(uids)


def test_requires_auth():
    # Drop the override for this single test.
    app.dependency_overrides.pop(auth.get_current_user, None)
    try:
        resp = client.post("/sample-priorities/lookup", json={"sample_uids": ["any"]})
        assert resp.status_code in (401, 403)
    finally:
        app.dependency_overrides[auth.get_current_user] = lambda: {"id": 0, "username": "test"}
