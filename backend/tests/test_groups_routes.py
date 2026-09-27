"""Groups HTTP surface (spec §7.1)."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ADMIN = SimpleNamespace(id=1, role="admin", email="admin@x.t", is_active=True)
STAFF = SimpleNamespace(id=42, role="standard", email="t@x.t", is_active=True)


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from main import app
    from auth import get_current_user
    from database import Base, get_db
    import models  # noqa: F401
    import groups.models  # noqa: F401
    import boards.models  # noqa: F401
    from models import User

    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    shared = sessionmaker(bind=engine)()
    for uid, email in ((1, "admin@x.t"), (42, "t@x.t"), (43, "u@x.t")):
        shared.add(User(id=uid, email=email, hashed_password="x",
                        role="admin" if uid == 1 else "standard", is_active=True))
    shared.add(User(id=44, email="gone@x.t", hashed_password="x", is_active=False))
    shared.commit()

    def _db():
        yield shared

    saved = {k: app.dependency_overrides.get(k) for k in (get_db, get_current_user)}
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: STAFF
    tc = TestClient(app)
    tc.db = shared
    tc.as_user = lambda u: app.dependency_overrides.__setitem__(get_current_user, lambda: u)
    yield tc
    for k, v in saved.items():
        if v is None:
            app.dependency_overrides.pop(k, None)
        else:
            app.dependency_overrides[k] = v
    shared.close()


def _mk(client, slug="exec", name="Exec"):
    client.as_user(ADMIN)
    r = client.post("/api/groups", json={"slug": slug, "name": name})
    assert r.status_code == 201, r.text
    client.as_user(STAFF)
    return r.json()


def test_standard_user_can_list_but_not_write(client):
    _mk(client)
    r = client.get("/api/groups")
    assert r.status_code == 200
    assert [g["slug"] for g in r.json()] == ["exec"]
    assert set(r.json()[0]) == {"id", "slug", "name", "description", "is_active",
                                "member_count", "created_at"}
    assert client.post("/api/groups", json={"slug": "x", "name": "X"}).status_code == 403
    assert client.put("/api/groups/1", json={"name": "Y"}).status_code == 403
    assert client.delete("/api/groups/1").status_code == 403
    assert client.get("/api/groups/1/members").status_code == 403
    assert client.put("/api/groups/1/members", json={"user_ids": [42]}).status_code == 403


def test_slug_rules(client):
    client.as_user(ADMIN)
    assert client.post("/api/groups", json={"slug": "Exec", "name": "E"}).status_code == 400
    assert client.post("/api/groups", json={"slug": "e", "name": "E"}).status_code == 400
    assert client.post("/api/groups", json={"slug": "exec team", "name": "E"}).status_code == 400
    assert client.post("/api/groups", json={"slug": "exec", "name": "E"}).status_code == 201
    assert client.post("/api/groups", json={"slug": "exec", "name": "E2"}).status_code == 409


def test_update_keeps_slug_immutable(client):
    g = _mk(client)
    client.as_user(ADMIN)
    r = client.put(f"/api/groups/{g['id']}", json={"name": "Executive", "description": "d"})
    assert r.status_code == 200 and r.json()["name"] == "Executive"
    assert client.put(f"/api/groups/{g['id']}", json={"slug": "other"}).status_code == 400
    assert client.put(f"/api/groups/{g['id']}", json={"slug": "exec"}).status_code == 200
    assert client.put("/api/groups/999", json={"name": "x"}).status_code == 404


def test_members_replace_and_validation(client):
    g = _mk(client)
    client.as_user(ADMIN)
    assert client.get(f"/api/groups/{g['id']}/members").json() == {"group_id": g["id"], "user_ids": []}
    r = client.put(f"/api/groups/{g['id']}/members", json={"user_ids": [42, 43, 42]})
    assert r.status_code == 200 and r.json()["user_ids"] == [42, 43]
    r = client.put(f"/api/groups/{g['id']}/members", json={"user_ids": [43]})
    assert r.json()["user_ids"] == [43]
    assert client.put(f"/api/groups/{g['id']}/members", json={"user_ids": [999]}).status_code == 400
    assert client.put(f"/api/groups/{g['id']}/members", json={"user_ids": [44]}).status_code == 400
    assert client.get("/api/groups").json()[0]["member_count"] == 1


def test_mine_lists_the_callers_groups(client):
    g = _mk(client)
    client.as_user(ADMIN)
    client.put(f"/api/groups/{g['id']}/members", json={"user_ids": [42]})
    client.as_user(STAFF)
    assert client.get("/api/groups/mine").json() == [{"id": g["id"], "slug": "exec", "name": "Exec"}]
    client.as_user(SimpleNamespace(id=43, role="standard", email="u@x.t", is_active=True))
    assert client.get("/api/groups/mine").json() == []


def test_inactive_groups_hidden_from_list_but_readable_by_admin(client):
    g = _mk(client)
    client.as_user(ADMIN)
    client.put(f"/api/groups/{g['id']}", json={"is_active": False})
    client.as_user(STAFF)
    assert client.get("/api/groups").json() == []
    client.as_user(ADMIN)
    assert [x["slug"] for x in client.get("/api/groups?include_inactive=true").json()] == ["exec"]


def test_delete_only_when_unused(client):
    g = _mk(client)
    client.as_user(ADMIN)
    client.put(f"/api/groups/{g['id']}/members", json={"user_ids": [42]})
    assert client.delete(f"/api/groups/{g['id']}").status_code == 409
    client.put(f"/api/groups/{g['id']}/members", json={"user_ids": []})
    assert client.delete(f"/api/groups/{g['id']}").status_code == 204
    assert client.delete(f"/api/groups/{g['id']}").status_code == 404
