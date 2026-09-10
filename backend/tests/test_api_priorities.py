"""API tests for /priorities. Self-restoring: deletes rows it created."""
import types
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import auth
from database import engine
from main import app
from priority.schemas import KEY_RE, slugify

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


# --------------------------------------------------------------------------
# Fix round 1: regression cover for the ruled behaviours.
# --------------------------------------------------------------------------


@pytest.fixture
def _cleanup_customers():
    """Delete customer_priorities (and their audit rows) for ids we touch."""
    ids: list[int] = []
    yield ids
    with engine.begin() as c:
        for cid in ids:
            c.execute(text("DELETE FROM customer_priorities WHERE wp_customer_user_id = :i"), {"i": cid})
            c.execute(text("DELETE FROM priority_audit WHERE level = 'customer' AND entity_id = :i"),
                      {"i": str(cid)})


def _mk(_cleanup, name_prefix="Tmp", **over):
    """Create a temp priority, register it for cleanup, return its key."""
    body = {"name": f"{name_prefix} {uuid.uuid4().hex[:6]}", "rank": 5, "icon": "minus", "color": "zinc"}
    body.update(over)
    r = client.post("/priorities", json=body)
    assert r.status_code == 201, r.text
    key = r.json()["key"]
    _cleanup.append(key)
    return key


def test_slugify_never_mints_a_key_the_validator_rejects():
    # A digit-leading or non-Latin name used to produce a key AssignIn 422s on,
    # leaving the priority creatable but permanently unassignable.
    assert KEY_RE.match(slugify("2 Day Rush")) and slugify("2 Day Rush").startswith("p-2")
    assert KEY_RE.match(slugify("123"))
    assert KEY_RE.match(slugify("Прио"))
    assert KEY_RE.match(slugify("Super Ultra Extremely Rushed Priority"))
    assert len(slugify("Super Ultra Extremely Rushed Priority")) <= 20


def test_assign_works_when_get_current_user_returns_an_orm_object(_cleanup):
    """auth.get_current_user returns a User ORM instance in production, which has
    no .get(); the handler must not 500 on the user dereference."""
    key = _mk(_cleanup, "Orm")
    app.dependency_overrides[auth.get_current_user] = lambda: types.SimpleNamespace(id=0, username="test")
    try:
        r = client.put("/priorities/assign", json={"level": "sample", "id": "999999", "priority_key": key})
        assert r.status_code != 500, r.text
        assert r.status_code == 422, r.text  # unknown sample pk, i.e. we ran past the user read
    finally:
        app.dependency_overrides[auth.get_current_user] = lambda: {"id": 0, "username": "test"}


def test_default_marker_moves_and_moves_back(_cleanup):
    key = _mk(_cleanup, "Def")
    try:
        r = client.put(f"/priorities/default/{key}")
        assert r.status_code == 200, r.text
        assert r.json()["is_default"] is True
        by_key = {p["key"]: p for p in client.get("/priorities").json()}
        assert by_key["default"]["is_default"] is False
        assert sum(1 for p in by_key.values() if p["is_default"]) == 1
    finally:
        r = client.put("/priorities/default/default")
        assert r.status_code == 200, r.text
    by_key = {p["key"]: p for p in client.get("/priorities").json()}
    assert by_key["default"]["is_default"] is True and by_key[key]["is_default"] is False


def test_default_rejects_an_inactive_priority(_cleanup):
    key = _mk(_cleanup, "Inact")
    assert client.delete(f"/priorities/{key}").status_code == 200
    r = client.put(f"/priorities/default/{key}")
    assert r.status_code == 409, r.text


def test_patch_cannot_deactivate_the_default():
    r = client.patch("/priorities/default", json={"is_active": False})
    assert r.status_code == 409, r.text
    assert next(p for p in client.get("/priorities").json() if p["key"] == "default")["is_active"] is True


def test_patch_unknown_sla_tier_id_is_422(_cleanup):
    key = _mk(_cleanup, "Tier")
    r = client.patch(f"/priorities/{key}", json={"sla_tier_id": 999999})
    assert r.status_code == 422, r.text
    assert not any(row["priority"] == key for row in client.get("/sla-priority-tiers").json())


def test_bulk_rolls_back_every_item_when_one_key_is_unknown(_cleanup, _cleanup_customers):
    key = _mk(_cleanup, "Bulk")
    cid = 999001
    _cleanup_customers.append(cid)
    r = client.put("/priorities/assign/bulk", json={"items": [
        {"level": "customer", "id": str(cid), "priority_key": key},
        {"level": "customer", "id": "999002", "priority_key": "no-such-key"},
    ]})
    assert r.status_code == 422, r.text
    listed = {row["wp_customer_user_id"] for row in client.get("/priorities/customers").json()}
    assert cid not in listed and 999002 not in listed


def test_bulk_assign_then_clear_round_trips_through_customers(_cleanup, _cleanup_customers):
    key = _mk(_cleanup, "Cust")
    cid = 999001
    _cleanup_customers.append(cid)
    r = client.put("/priorities/assign/bulk", json={"items": [
        {"level": "customer", "id": str(cid), "priority_key": key, "note": "VIP"},
    ]})
    assert r.status_code == 200, r.text
    assert r.json()[0]["new_key"] == key

    row = next(x for x in client.get("/priorities/customers").json() if x["wp_customer_user_id"] == cid)
    assert row["priority_key"] == key and row["note"] == "VIP"

    # bulk audit rows carry source="bulk"
    with engine.begin() as c:
        src = c.execute(text("SELECT source FROM priority_audit WHERE level = 'customer' AND entity_id = :i"),
                        {"i": str(cid)}).scalars().all()
    assert src and set(src) == {"bulk"}

    r = client.put("/priorities/assign", json={"level": "customer", "id": str(cid), "priority_key": None})
    assert r.status_code == 200, r.text
    assert r.json()["old_key"] == key and r.json()["new_key"] is None
    assert cid not in {x["wp_customer_user_id"] for x in client.get("/priorities/customers").json()}
