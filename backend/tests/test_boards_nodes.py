"""Nodes and edges (spec §4.5 to §4.8, §7.3)."""
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
    from boards.models import Board, BoardGrant
    from boards import service
    from flags import seams

    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    for u in (ADMIN, EDITOR, VIEWER, OUTSIDER):
        s.add(User(id=u.id, email=u.email, hashed_password="x", role=u.role, is_active=True))
    s.add(User(id=13, email="gone@x.t", hashed_password="x", is_active=False))
    editors, viewers = UserGroup(slug="editors", name="Editors"), UserGroup(slug="viewers", name="Viewers")
    org, exec_ = Board(slug="org", name="Org"), Board(slug="exec", name="Exec", visibility="restricted")
    s.add_all([editors, viewers, org, exec_])
    s.flush()
    s.add_all([UserGroupMember(group_id=editors.id, user_id=EDITOR.id),
               UserGroupMember(group_id=viewers.id, user_id=VIEWER.id),
               BoardGrant(board_id=org.id, group_id=editors.id, can_edit=True),
               BoardGrant(board_id=org.id, group_id=viewers.id, can_edit=False),
               BoardGrant(board_id=exec_.id, group_id=editors.id, can_edit=True)])
    s.commit()
    monkeypatch.setattr(service, "RESTRICTED_BOARDS_ENABLED", True)
    seams.register_mk1_entities()  # `worksheet` resolves without any DB rows

    def _db():
        yield s

    saved = {k: app.dependency_overrides.get(k) for k in (get_db, get_current_user)}
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: EDITOR
    tc = TestClient(app)
    tc.db = s
    tc.as_user = lambda u: app.dependency_overrides.__setitem__(get_current_user, lambda: u)
    yield tc
    for k, v in saved.items():
        if v is None:
            app.dependency_overrides.pop(k, None)
        else:
            app.dependency_overrides[k] = v
    s.close()


def _node(client, slug="org", **body):
    body.setdefault("kind", "text")
    body.setdefault("label", body["kind"])
    r = client.post(f"/api/boards/{slug}/nodes", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def test_create_each_kind_with_validation(client):
    f = _node(client, kind="frame", label="Marketing")
    assert f["data"] == {"color": "slate"} and f["version"] == 1
    assert client.post("/api/boards/org/nodes", json={"kind": "frame", "data": {"color": "neon"}}).status_code == 400
    assert _node(client, kind="text", data={"size": "lg"})["data"] == {"size": "lg"}
    assert client.post("/api/boards/org/nodes", json={"kind": "text", "data": {"size": "xl"}}).status_code == 400
    assert _node(client, kind="note", data={"markdown": "# hi"})["data"] == {"markdown": "# hi"}
    assert client.post("/api/boards/org/nodes", json={"kind": "note", "data": {"markdown": "x" * 20001}}).status_code == 400
    link = _node(client, kind="link", label="Kinsta", data={"url": "https://my.kinsta.com/"})
    assert link["data"] == {"url": "https://my.kinsta.com/", "description": None}
    ent = _node(client, kind="entity", label="", entity_type="worksheet", entity_id="1")
    assert ent["label"] == "Worksheet 1"
    assert ent["context"]["label"] == "Worksheet 1" and ent["context"]["entity_type"] == "worksheet"
    assert client.post("/api/boards/org/nodes", json={"kind": "entity", "entity_type": "nope", "entity_id": "1"}).status_code == 400
    assert client.post("/api/boards/org/nodes", json={"kind": "entity", "entity_type": "board_node", "entity_id": "1"}).status_code == 400
    assert client.post("/api/boards/org/nodes", json={"kind": "entity", "entity_type": "worksheet"}).status_code == 400
    assert client.post("/api/boards/org/nodes", json={"kind": "text", "entity_type": "worksheet", "entity_id": "1"}).status_code == 400
    # Person display defaults are stored with the node, so old rows and new rows read alike.
    assert _node(client, kind="person", data={"user_id": EDITOR.id})["data"] == {
        "user_id": EDITOR.id, "show": "name", "show_title": True}
    assert _node(client, kind="person", data={"user_id": EDITOR.id, "show": "email", "show_title": False})["data"] == {
        "user_id": EDITOR.id, "show": "email", "show_title": False}
    assert client.post("/api/boards/org/nodes", json={"kind": "person", "data": {"user_id": EDITOR.id, "show": "initials"}}).status_code == 400
    assert client.post("/api/boards/org/nodes", json={"kind": "person", "data": {"user_id": EDITOR.id, "badge": True}}).status_code == 400
    assert client.post("/api/boards/org/nodes", json={"kind": "person", "data": {"user_id": 999}}).status_code == 400
    assert client.post("/api/boards/org/nodes", json={"kind": "person", "data": {"user_id": 13}}).status_code == 400
    assert client.post("/api/boards/org/nodes", json={"kind": "widget", "data": {"key": "sla"}}).status_code == 400
    assert client.post("/api/boards/org/nodes", json={"kind": "sticker"}).status_code == 400
    detail = client.get("/api/boards/org").json()
    assert detail["node_count"] == 7
    ctxs = [n["context"] for n in detail["nodes"] if n["kind"] == "entity"]
    assert ctxs and ctxs[0]["label"] == "Worksheet 1"


def test_edit_rights_on_nodes(client):
    client.as_user(VIEWER)
    assert client.post("/api/boards/org/nodes", json={"kind": "text"}).status_code == 403
    client.as_user(OUTSIDER)
    assert client.post("/api/boards/exec/nodes", json={"kind": "text"}).status_code == 404
    assert client.get("/api/boards/org").status_code == 200


def test_parent_rules(client):
    frame = _node(client, kind="frame")
    inner = _node(client, kind="frame", parent_id=frame["id"])
    text = _node(client, kind="text")
    assert client.post("/api/boards/org/nodes", json={"kind": "text", "parent_id": text["id"]}).status_code == 400
    assert client.post("/api/boards/org/nodes", json={"kind": "text", "parent_id": inner["id"]}).status_code == 400
    assert client.post("/api/boards/org/nodes", json={"kind": "text", "parent_id": 9999}).status_code == 404
    other = _node(client, slug="exec", kind="frame")
    assert client.post("/api/boards/org/nodes", json={"kind": "text", "parent_id": other["id"]}).status_code == 404
    r = client.patch(f"/api/boards/org/nodes/{frame['id']}", json={"parent_id": frame["id"], "version": 1})
    assert r.status_code == 400


def test_frame_with_children_cannot_be_nested(client):
    """I-1: a frame that already has (or is about to gain, within the same positions
    batch) a child cannot itself be moved under another frame."""
    F = _node(client, kind="frame", label="F")
    G = _node(client, kind="frame", label="G")
    child = _node(client, kind="text", parent_id=F["id"])

    # (a) PATCH F.parent_id=G when F has a child -> 400
    r = client.patch(f"/api/boards/org/nodes/{F['id']}", json={"parent_id": G["id"], "version": 1})
    assert r.status_code == 400

    # (b) positions batch [F into G] when F has a child -> 400
    r = client.patch("/api/boards/org/nodes/positions", json=[
        {"id": F["id"], "x": F["x"], "y": F["y"], "parent_id": G["id"], "version": 1}])
    assert r.status_code == 400

    # (c) positions batch [loose node into F2, F2 into G] -> 400 and nothing written,
    # even though F2 has no child in the DB yet (the re-parent is only pending in-batch).
    F2 = _node(client, kind="frame", label="F2")
    loose = _node(client, kind="text")
    r = client.patch("/api/boards/org/nodes/positions", json=[
        {"id": loose["id"], "x": loose["x"], "y": loose["y"], "parent_id": F2["id"], "version": 1},
        {"id": F2["id"], "x": F2["x"], "y": F2["y"], "parent_id": G["id"], "version": 1}])
    assert r.status_code == 400
    nodes = {n["id"]: n for n in client.get("/api/boards/org").json()["nodes"]}
    assert (nodes[loose["id"]]["parent_id"], nodes[loose["id"]]["version"]) == (None, 1)
    assert (nodes[F2["id"]]["parent_id"], nodes[F2["id"]]["version"]) == (None, 1)

    # (d) positions batch [F3 into G] when F3 has NO children -> 200
    F3 = _node(client, kind="frame", label="F3")
    r = client.patch("/api/boards/org/nodes/positions", json=[
        {"id": F3["id"], "x": F3["x"], "y": F3["y"], "parent_id": G["id"], "version": 1}])
    assert r.status_code == 200 and r.json()[0]["parent_id"] == G["id"]


def test_board_and_node_null_clears_fields(client):
    """M-4 / T6: an explicit null clears default_viewport (board) and w/h (node); it is
    not treated the same as the field being absent from the request."""
    r = client.patch("/api/boards/org", json={"default_viewport": {"x": 1, "y": 2, "zoom": 1}})
    assert r.status_code == 200 and r.json()["default_viewport"] == {"x": 1.0, "y": 2.0, "zoom": 1.0}
    r = client.patch("/api/boards/org", json={"default_viewport": None})
    assert r.status_code == 200 and r.json()["default_viewport"] is None

    n = _node(client, kind="text")
    r = client.patch(f"/api/boards/org/nodes/{n['id']}", json={"w": 50, "h": 20, "version": 1})
    assert r.status_code == 200 and (r.json()["w"], r.json()["h"]) == (50.0, 20.0)
    r = client.patch(f"/api/boards/org/nodes/{n['id']}", json={"w": None, "version": 2})
    assert r.status_code == 200
    assert (r.json()["w"], r.json()["h"]) == (None, 20.0)


def test_patch_version_conflict_and_revalidation(client):
    n = _node(client, kind="frame", label="A")
    r = client.patch(f"/api/boards/org/nodes/{n['id']}", json={"label": "B", "version": 7})
    assert r.status_code == 409
    assert r.json()["detail"]["current"]["version"] == 1 and r.json()["detail"]["current"]["label"] == "A"
    r = client.patch(f"/api/boards/org/nodes/{n['id']}", json={"label": "B", "data": {"color": "teal"}, "version": 1})
    assert r.status_code == 200 and (r.json()["label"], r.json()["version"], r.json()["updated_by"]) == ("B", 2, EDITOR.id)
    assert client.patch(f"/api/boards/org/nodes/{n['id']}", json={"data": {"color": "neon"}, "version": 2}).status_code == 400
    assert client.patch(f"/api/boards/org/nodes/{n['id']}", json={"kind": "text", "version": 2}).status_code == 422
    assert client.patch(f"/api/boards/org/nodes/{n['id']}", json={"label": "C"}).status_code == 422


def test_link_url_scheme_rejected_on_create_and_patch(client):
    """Review Focus 4."""
    for bad in ("javascript:alert(1)", "data:text/html,hi", "ftp://x", "https://", "kinsta.com"):
        assert client.post("/api/boards/org/nodes", json={"kind": "link", "data": {"url": bad}}).status_code == 400, bad
    n = _node(client, kind="link", data={"url": "https://accumarklabs.com"})
    r = client.patch(f"/api/boards/org/nodes/{n['id']}", json={"data": {"url": "javascript:alert(1)"}, "version": 1})
    assert r.status_code == 400
    assert client.get("/api/boards/org").json()["nodes"][0]["data"]["url"] == "https://accumarklabs.com"


def test_positions_bulk_is_all_or_nothing(client):
    """Review Focus 2."""
    a, b = _node(client, x=0, y=0), _node(client, x=0, y=0)
    r = client.patch("/api/boards/org/nodes/positions", json=[
        {"id": a["id"], "x": 10, "y": 10, "version": 1},
        {"id": b["id"], "x": 20, "y": 20, "version": 99}])
    assert r.status_code == 409 and r.json()["detail"]["stale_ids"] == [b["id"]]
    nodes = {n["id"]: n for n in client.get("/api/boards/org").json()["nodes"]}
    assert (nodes[a["id"]]["x"], nodes[b["id"]]["x"]) == (0.0, 0.0)
    r = client.patch("/api/boards/org/nodes/positions", json=[
        {"id": a["id"], "x": 10, "y": 10, "version": 1},
        {"id": b["id"], "x": 20, "y": 20, "version": 1}])
    assert r.status_code == 200
    assert sorted((n["x"], n["version"]) for n in r.json()) == [(10.0, 2), (20.0, 2)]
    assert client.patch("/api/boards/org/nodes/positions", json=[{"id": 9999, "x": 1, "y": 1, "version": 1}]).status_code == 404


def test_positions_can_reparent_into_a_frame(client):
    frame, text = _node(client, kind="frame", x=100, y=50), _node(client, x=130, y=60)
    r = client.patch("/api/boards/org/nodes/positions", json=[
        {"id": text["id"], "x": 30, "y": 10, "parent_id": frame["id"], "version": 1}])
    assert r.status_code == 200 and r.json()[0]["parent_id"] == frame["id"]
    r = client.patch("/api/boards/org/nodes/positions", json=[
        {"id": text["id"], "x": 130, "y": 60, "parent_id": None, "version": 2}])
    assert r.json()[0]["parent_id"] is None


def test_delete_frame_reparents_children_with_absolute_coords(client):
    """Review Focus 3."""
    frame = _node(client, kind="frame", x=100, y=50)
    child = _node(client, kind="text", parent_id=frame["id"], x=10, y=5)
    other = _node(client, kind="text", x=0, y=0)
    e = client.post("/api/boards/org/edges", json={"source_id": frame["id"], "target_id": other["id"]})
    assert e.status_code == 201
    assert client.delete(f"/api/boards/org/nodes/{frame['id']}").status_code == 204
    d = client.get("/api/boards/org").json()
    c = next(n for n in d["nodes"] if n["id"] == child["id"])
    assert (c["parent_id"], c["x"], c["y"]) == (None, 110.0, 55.0)
    assert c["version"] == 2, "M-3: reparenting a child on frame delete must bump its version"
    assert d["edges"] == []
    assert client.delete(f"/api/boards/org/nodes/{frame['id']}").status_code == 404
    client.as_user(VIEWER)
    assert client.delete(f"/api/boards/org/nodes/{child['id']}").status_code == 403


def test_edges(client):
    a, b = _node(client), _node(client)
    other = _node(client, slug="exec")
    r = client.post("/api/boards/org/edges", json={"source_id": a["id"], "target_id": b["id"], "kind": "reports_to"})
    assert r.status_code == 201 and r.json()["kind"] == "reports_to"
    eid = r.json()["id"]
    assert client.post("/api/boards/org/edges", json={"source_id": a["id"], "target_id": b["id"], "kind": "reports_to"}).status_code == 409
    assert client.post("/api/boards/org/edges", json={"source_id": a["id"], "target_id": a["id"]}).status_code == 400
    assert client.post("/api/boards/org/edges", json={"source_id": a["id"], "target_id": other["id"]}).status_code == 404
    assert client.post("/api/boards/org/edges", json={"source_id": a["id"], "target_id": b["id"], "kind": "teleport"}).status_code == 400
    r = client.patch(f"/api/boards/org/edges/{eid}", json={"kind": "next", "label": "then"})
    assert (r.json()["kind"], r.json()["label"]) == ("next", "then")
    assert client.patch(f"/api/boards/org/edges/{eid}", json={"kind": "teleport"}).status_code == 400
    client.as_user(VIEWER)
    assert client.delete(f"/api/boards/org/edges/{eid}").status_code == 403
    client.as_user(EDITOR)
    assert client.delete(f"/api/boards/org/edges/{eid}").status_code == 204
    assert client.delete(f"/api/boards/org/edges/{eid}").status_code == 404


def test_for_entity_lists_visible_boards_only(client):
    _node(client, slug="org", kind="entity", entity_type="worksheet", entity_id="1")
    _node(client, slug="exec", kind="entity", entity_type="worksheet", entity_id="1")
    client.as_user(OUTSIDER)
    r = client.get("/api/boards/for-entity", params={"entity_type": "worksheet", "entity_id": "1"})
    assert [x["board_slug"] for x in r.json()] == ["org"]
    client.as_user(EDITOR)
    r = client.get("/api/boards/for-entity", params={"entity_type": "worksheet", "entity_id": "1"})
    assert sorted(x["board_slug"] for x in r.json()) == ["exec", "org"]
