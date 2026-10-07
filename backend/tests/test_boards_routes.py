"""Boards HTTP surface: boards, grants, for-entity (spec §7.2)."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ADMIN = SimpleNamespace(id=1, role="admin", email="admin@x.t", is_active=True)
EDITOR = SimpleNamespace(id=10, role="standard", email="e@x.t", is_active=True)
VIEWER = SimpleNamespace(id=11, role="standard", email="v@x.t", is_active=True)
OUTSIDER = SimpleNamespace(id=12, role="standard", email="o@x.t", is_active=True)


@pytest.fixture
def client(monkeypatch):
    from fastapi.testclient import TestClient
    from main import app
    from auth import get_current_user
    from database import Base, get_db
    import models  # noqa: F401
    import groups.models  # noqa: F401
    import boards.models  # noqa: F401
    import flags.models  # noqa: F401
    from models import User
    from groups.models import UserGroup, UserGroupMember
    from boards import service

    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    for u in (ADMIN, EDITOR, VIEWER, OUTSIDER):
        s.add(User(id=u.id, email=u.email, hashed_password="x", role=u.role, is_active=True))
    editors, viewers = UserGroup(slug="editors", name="Editors"), UserGroup(slug="viewers", name="Viewers")
    s.add_all([editors, viewers])
    s.flush()
    s.add_all([UserGroupMember(group_id=editors.id, user_id=EDITOR.id),
               UserGroupMember(group_id=viewers.id, user_id=VIEWER.id)])
    s.commit()
    monkeypatch.setattr(service, "RESTRICTED_BOARDS_ENABLED", True)

    def _db():
        yield s

    saved = {k: app.dependency_overrides.get(k) for k in (get_db, get_current_user)}
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: OUTSIDER
    tc = TestClient(app)
    tc.db, tc.editors, tc.viewers = s, editors.id, viewers.id
    tc.as_user = lambda u: app.dependency_overrides.__setitem__(get_current_user, lambda: u)
    yield tc
    for k, v in saved.items():
        if v is None:
            app.dependency_overrides.pop(k, None)
        else:
            app.dependency_overrides[k] = v
    s.close()


def _board(client, slug, visibility="company", grants=()):
    client.as_user(ADMIN)
    r = client.post("/api/boards", json={"slug": slug, "name": slug.title(), "kind": "map",
                                         "visibility": visibility})
    assert r.status_code == 201, r.text
    if grants:
        g = client.put(f"/api/boards/{slug}/grants", json=list(grants))
        assert g.status_code == 200, g.text
    client.as_user(OUTSIDER)
    return r.json()


def test_list_and_get_follow_visibility(client):
    _board(client, "org")
    _board(client, "exec", "restricted", [{"group_id": client.editors, "can_edit": True},
                                          {"group_id": client.viewers, "can_edit": False}])
    client.as_user(OUTSIDER)
    assert [b["slug"] for b in client.get("/api/boards").json()] == ["org"]
    assert client.get("/api/boards/exec").status_code == 404
    assert client.get("/api/boards/org").status_code == 200
    client.as_user(VIEWER)
    rows = {b["slug"]: b for b in client.get("/api/boards").json()}
    assert set(rows) == {"exec", "org"}
    assert rows["exec"]["can_edit"] is False and rows["org"]["can_edit"] is False
    d = client.get("/api/boards/exec").json()
    assert d["nodes"] == [] and d["edges"] == []
    assert sorted(g["group_slug"] for g in d["grants"]) == ["editors", "viewers"]
    client.as_user(EDITOR)
    assert client.get("/api/boards/exec").json()["can_edit"] is True
    client.as_user(ADMIN)
    assert len(client.get("/api/boards").json()) == 2


def test_create_rules(client):
    from boards import service
    client.as_user(OUTSIDER)
    assert client.post("/api/boards", json={"slug": "xx", "name": "X"}).status_code == 403
    client.as_user(ADMIN)
    assert client.post("/api/boards", json={"slug": "Bad Slug", "name": "X"}).status_code == 400
    assert client.post("/api/boards", json={"slug": "xx", "name": "X", "kind": "poster"}).status_code == 400
    assert client.post("/api/boards", json={"slug": "xx", "name": "X", "visibility": "secret"}).status_code == 400
    r = client.post("/api/boards", json={"slug": "xx", "name": "X"})
    assert r.status_code == 201 and r.json()["kind"] == "custom" and r.json()["created_by"] == ADMIN.id
    assert client.post("/api/boards", json={"slug": "xx", "name": "X2"}).status_code == 409
    service.RESTRICTED_BOARDS_ENABLED = False
    r = client.post("/api/boards", json={"slug": "yy", "name": "Y", "visibility": "restricted"})
    assert r.status_code == 400 and "not enabled" in r.json()["detail"]


def test_patch_rights_and_visibility_is_admin_only(client):
    _board(client, "exec", "restricted", [{"group_id": client.editors, "can_edit": True},
                                          {"group_id": client.viewers, "can_edit": False}])
    client.as_user(OUTSIDER)
    assert client.patch("/api/boards/exec", json={"name": "N"}).status_code == 404
    client.as_user(VIEWER)
    assert client.patch("/api/boards/exec", json={"name": "N"}).status_code == 403
    client.as_user(EDITOR)
    r = client.patch("/api/boards/exec", json={"name": "Exec map", "kind": "org",
                                               "default_viewport": {"x": 1, "y": 2, "zoom": 0.5}})
    assert r.status_code == 200 and r.json()["kind"] == "org"
    assert r.json()["default_viewport"] == {"x": 1.0, "y": 2.0, "zoom": 0.5}
    assert client.patch("/api/boards/exec", json={"default_viewport": {"x": 0, "y": 0, "zoom": 9}}).status_code == 422
    assert client.patch("/api/boards/exec", json={"visibility": "company"}).status_code == 403
    client.as_user(ADMIN)
    assert client.patch("/api/boards/exec", json={"visibility": "company"}).json()["visibility"] == "company"
    assert client.patch("/api/boards/exec", json={"slug": "other"}).status_code == 422


def test_grants_replace(client):
    _board(client, "org")
    client.as_user(OUTSIDER)
    assert client.put("/api/boards/org/grants", json=[]).status_code == 403
    client.as_user(ADMIN)
    assert client.put("/api/boards/org/grants", json=[{"group_id": 999, "can_edit": True}]).status_code == 400
    r = client.put("/api/boards/org/grants", json=[{"group_id": client.editors, "can_edit": True}])
    assert [g["group_slug"] for g in r.json()] == ["editors"]
    r = client.put("/api/boards/org/grants", json=[{"group_id": client.viewers, "can_edit": False}])
    assert [g["group_slug"] for g in r.json()] == ["viewers"]
    client.as_user(EDITOR)
    assert client.get("/api/boards/org").json()["can_edit"] is False


def test_delete_is_admin_only(client):
    _board(client, "org")
    client.as_user(EDITOR)
    assert client.delete("/api/boards/org").status_code == 403
    client.as_user(ADMIN)
    assert client.delete("/api/boards/org").status_code == 204
    assert client.get("/api/boards/org").status_code == 404
    assert client.delete("/api/boards/org").status_code == 404


def test_for_entity_is_empty_without_nodes(client):
    _board(client, "org")
    client.as_user(OUTSIDER)
    r = client.get("/api/boards/for-entity", params={"entity_type": "document", "entity_id": "SOP-0001"})
    assert r.status_code == 200 and r.json() == []


def test_restricted_boards_are_enabled_by_default():
    from boards import service
    assert service.RESTRICTED_BOARDS_ENABLED is True, "slice 2 wires flag visibility; the lock is off"
