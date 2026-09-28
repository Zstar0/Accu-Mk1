"""Flag visibility enforcement (spec §6.3): the anchor decides who may read, write, or be
pulled into a flag. Fixture: one company board, one restricted board granted to `exec`,
users admin / member / outsider, and four flags (general, legacy sample, public node,
secret node)."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ADMIN = SimpleNamespace(id=1, role="admin", email="a@x.t", is_active=True)
MEMBER = SimpleNamespace(id=10, role="standard", email="m@x.t", is_active=True)
OUTSIDER = SimpleNamespace(id=12, role="standard", email="o@x.t", is_active=True)
PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 32


@pytest.fixture
def w(monkeypatch):
    from fastapi.testclient import TestClient
    from main import app
    from auth import get_current_user
    from database import Base, get_db
    import models  # noqa: F401
    import groups.models  # noqa: F401
    import boards.models  # noqa: F401
    import flags.models  # noqa: F401
    from boards.models import Board, BoardGrant, BoardNode
    from groups.models import UserGroup, UserGroupMember
    from models import User
    from flags import seams, service, types_service

    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    for u in (ADMIN, MEMBER, OUTSIDER):
        s.add(User(id=u.id, email=u.email, hashed_password="x", role=u.role, is_active=True))
    types_service.seed_builtins(s)
    seams.register_mk1_entities()
    seams.set_attachment_storage_for_tests(seams.InMemoryAttachmentStorage())
    g = UserGroup(slug="exec", name="Exec")
    org = Board(slug="org", name="Org")
    exec_ = Board(slug="exec", name="Exec", visibility="restricted")
    s.add_all([g, org, exec_])
    s.flush()
    s.add_all([UserGroupMember(group_id=g.id, user_id=MEMBER.id),
               BoardGrant(board_id=exec_.id, group_id=g.id, can_edit=True)])
    pub = BoardNode(board_id=org.id, kind="frame", label="Public")
    sec = BoardNode(board_id=exec_.id, kind="frame", label="Secret")
    s.add_all([pub, sec])
    s.flush()
    child = BoardNode(board_id=exec_.id, kind="text", label="Child", parent_id=sec.id)
    s.add(child)
    s.commit()

    def mk(**kw):
        return service.create_flag(s, user=ADMIN, type="task", **kw)
    f_general = mk(entity_type=None, entity_id=None, title="General task")
    f_sample = mk(entity_type="sample", entity_id="P-1", title="Legacy sample flag")
    f_public = mk(entity_type="board_node", entity_id=str(pub.id), title="Public node flag")
    f_secret = mk(entity_type="board_node", entity_id=str(sec.id), title="Secret node flag")
    f_child = mk(entity_type="board_node", entity_id=str(child.id), title="Secret child flag")

    def _db():
        yield s

    saved = {k: app.dependency_overrides.get(k) for k in (get_db, get_current_user)}
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: OUTSIDER
    tc = TestClient(app)
    tc.as_user = lambda u: app.dependency_overrides.__setitem__(get_current_user, lambda: u)
    yield SimpleNamespace(c=tc, s=s, g=g, org=org, exec_=exec_, pub=pub, sec=sec, child=child,
                          f_general=f_general, f_sample=f_sample, f_public=f_public,
                          f_secret=f_secret, f_child=f_child)
    for k, v in saved.items():
        if v is None:
            app.dependency_overrides.pop(k, None)
        else:
            app.dependency_overrides[k] = v
    s.close()


def test_invisible_and_missing_are_indistinguishable(w):
    """Review Focus 1."""
    w.c.as_user(OUTSIDER)
    hidden = w.c.get(f"/api/flags/{w.f_secret.id}")
    missing = w.c.get("/api/flags/999999")
    assert hidden.status_code == missing.status_code == 404
    assert hidden.json()["detail"] == f"flag {w.f_secret.id} not found"
    assert missing.json()["detail"] == "flag 999999 not found"
    w.c.as_user(MEMBER)
    assert w.c.get(f"/api/flags/{w.f_secret.id}").status_code == 200
    w.c.as_user(ADMIN)
    assert w.c.get(f"/api/flags/{w.f_secret.id}").status_code == 200
    w.c.as_user(OUTSIDER)
    for fid in (w.f_general.id, w.f_sample.id, w.f_public.id):
        assert w.c.get(f"/api/flags/{fid}").status_code == 200


def test_per_flag_writes_are_404_for_outsider(w):
    w.c.as_user(OUTSIDER)
    fid = w.f_secret.id
    assert w.c.post(f"/api/flags/{fid}/comments", json={"body": "hi"}).status_code == 404
    assert w.c.post(f"/api/flags/{fid}/assign", json={"assignee_id": OUTSIDER.id}).status_code == 404
    assert w.c.post(f"/api/flags/{fid}/status", json={"to_status": "in_progress"}).status_code == 404
    assert w.c.put(f"/api/flags/{fid}/due", json={"due_at": "2026-12-01T00:00:00"}).status_code == 404
    assert w.c.post(f"/api/flags/{fid}/watchers", json={"user_id": OUTSIDER.id}).status_code == 404
    assert w.c.delete(f"/api/flags/{fid}/watchers/{OUTSIDER.id}").status_code == 404
    assert w.c.post(f"/api/flags/{fid}/links/entities",
                    json={"entity_type": "sample", "entity_id": "P-1"}).status_code == 404
    assert w.c.post(f"/api/flags/{fid}/links/flags", json={"flag_id": w.f_general.id}).status_code == 404
    assert w.c.post(f"/api/flags/{w.f_general.id}/links/flags", json={"flag_id": fid}).status_code == 404
    assert w.c.post(f"/api/flags/{fid}/read").status_code == 404
    assert w.c.post(f"/api/flags/{fid}/attachments",
                    files={"file": ("a.png", PNG, "image/png")}).status_code == 404
    w.c.as_user(MEMBER)
    assert w.c.post(f"/api/flags/{fid}/comments", json={"body": "hi"}).status_code == 201
    assert w.c.post(f"/api/flags/{fid}/read").status_code == 204


def test_reactions_and_attachments_follow_the_flag(w):
    w.c.as_user(ADMIN)
    cid = w.c.post(f"/api/flags/{w.f_secret.id}/comments", json={"body": "note"}).json()["id"]
    att = w.c.post(f"/api/flags/{w.f_secret.id}/attachments",
                   files={"file": ("a.png", PNG, "image/png")})
    assert att.status_code == 201, att.text
    aid = att.json()["id"]
    w.c.as_user(OUTSIDER)
    assert w.c.put(f"/api/flags/comments/{cid}/reactions/%F0%9F%91%8D").status_code == 404
    assert w.c.get(f"/api/flags/attachments/{aid}").status_code == 404
    w.c.as_user(MEMBER)
    assert w.c.put(f"/api/flags/comments/{cid}/reactions/%F0%9F%91%8D").status_code == 200
    assert w.c.get(f"/api/flags/attachments/{aid}").status_code == 200


def test_flag_link_needs_both_ends_visible(w):
    w.c.as_user(MEMBER)
    assert w.c.post(f"/api/flags/{w.f_public.id}/links/flags",
                    json={"flag_id": w.f_secret.id}).status_code == 201
    w.c.as_user(OUTSIDER)
    assert w.c.post(f"/api/flags/{w.f_general.id}/links/flags",
                    json={"flag_id": w.f_secret.id}).status_code == 404
