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
    hidden_put = w.c.put(f"/api/flags/comments/{cid}/reactions/%F0%9F%91%8D")
    missing_put = w.c.put("/api/flags/comments/999999/reactions/%F0%9F%91%8D")
    assert hidden_put.status_code == missing_put.status_code == 404
    assert hidden_put.json()["detail"] == f"comment {cid} not found"
    assert missing_put.json()["detail"] == "comment 999999 not found"

    hidden_delete = w.c.delete(f"/api/flags/comments/{cid}/reactions/%F0%9F%91%8D")
    missing_delete = w.c.delete("/api/flags/comments/999999/reactions/%F0%9F%91%8D")
    assert hidden_delete.status_code == missing_delete.status_code == 404
    assert hidden_delete.json()["detail"] == f"comment {cid} not found"
    assert missing_delete.json()["detail"] == "comment 999999 not found"

    hidden_att = w.c.get(f"/api/flags/attachments/{aid}")
    missing_att = w.c.get("/api/flags/attachments/999999")
    assert hidden_att.status_code == missing_att.status_code == 404
    assert hidden_att.json()["detail"] == f"attachment {aid} not found"
    assert missing_att.json()["detail"] == "attachment 999999 not found"

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


def _titles(c, path):
    r = c.get(path)
    assert r.status_code == 200, r.text
    body = r.json()
    rows = body["items"] if isinstance(body, dict) and "items" in body else body
    return sorted({(x.get("flag") or x)["title"] for x in rows})


def test_all_open_hides_secret_for_outsider(w):
    w.c.as_user(OUTSIDER)
    assert _titles(w.c, "/api/flags?tab=all_open") == [
        "General task", "Legacy sample flag", "Public node flag"]
    w.c.as_user(MEMBER)
    assert "Secret node flag" in _titles(w.c, "/api/flags?tab=all_open")
    w.c.as_user(ADMIN)
    assert "Secret child flag" in _titles(w.c, "/api/flags?tab=all_open")


def test_general_and_legacy_flags_unaffected(w):
    """Review Focus 4."""
    w.c.as_user(OUTSIDER)
    got = _titles(w.c, "/api/flags?tab=all_open")
    assert "General task" in got and "Legacy sample flag" in got


def test_orphan_anchor_is_admin_only(w):
    """Review Focus 5: the node row is gone, the flag remains."""
    w.s.delete(w.child)
    w.s.commit()
    w.c.as_user(MEMBER)
    assert "Secret child flag" not in _titles(w.c, "/api/flags?tab=all_open")
    assert w.c.get(f"/api/flags/{w.f_child.id}").status_code == 404
    w.c.as_user(ADMIN)
    assert "Secret child flag" in _titles(w.c, "/api/flags?tab=all_open")
    assert w.c.get(f"/api/flags/{w.f_child.id}").status_code == 200


def test_unread_summary_activity_search_are_filtered(w):
    from flags.models import FlagParticipant
    # A stale participant row (as if membership was revoked after watching) must not
    # bring the secret flag back through unread/activity.
    w.s.add(FlagParticipant(flag_id=w.f_secret.id, user_id=OUTSIDER.id, role="watcher", added_by=ADMIN.id))
    w.s.commit()
    w.c.as_user(ADMIN)
    assert w.c.post(f"/api/flags/{w.f_secret.id}/comments", json={"body": "Secret update"}).status_code == 201
    w.c.as_user(OUTSIDER)
    assert "Secret node flag" not in _titles(w.c, "/api/flags/unread")
    assert "Secret node flag" not in _titles(w.c, "/api/flags/activity")
    hits = w.c.get("/api/flags/search?q=Secret").json()
    assert hits == []
    w.c.as_user(MEMBER)
    assert [h["flag_id"] for h in w.c.get("/api/flags/search?q=Secret node").json()] == [w.f_secret.id]


def test_summary_counts_only_visible_assigned(w):
    from flags.models import FlagFlag
    # Assigned directly in the DB (a stale assignment after revocation); Task 4 blocks new ones.
    w.s.execute(FlagFlag.__table__.update().where(FlagFlag.id == w.f_secret.id)
                .values(assignee_id=OUTSIDER.id))
    w.s.commit()
    w.c.as_user(OUTSIDER)
    assert w.c.get("/api/flags/summary").json()["assigned_to_me"] == 0
    w.c.as_user(MEMBER)
    w.s.execute(FlagFlag.__table__.update().where(FlagFlag.id == w.f_secret.id)
                .values(assignee_id=MEMBER.id))
    w.s.commit()
    assert w.c.get("/api/flags/summary").json()["assigned_to_me"] == 1


def test_include_descendants_rollup_respects_viewer(w):
    q = f"/api/flags?tab=all_open&entity_type=board_node&entity_id={w.sec.id}&include_descendants=true"
    w.c.as_user(OUTSIDER)
    assert _titles(w.c, q) == []
    w.c.as_user(MEMBER)
    assert _titles(w.c, q) == ["Secret child flag", "Secret node flag"]


def test_list_without_user_fails_closed(w):
    from flags import service
    titles = sorted(f.title for f in service.list_flags(w.s, user_id=ADMIN.id, tab="all_open"))
    assert titles == ["General task", "Legacy sample flag"], "no user = scoped types hidden"


def test_digest_stats_pass_the_user(w):
    from datetime import datetime, timezone
    from flags.models import FlagParticipant
    from slack_notify.digest import compute_stats
    w.s.add(FlagParticipant(flag_id=w.f_secret.id, user_id=OUTSIDER.id, role="watcher", added_by=ADMIN.id))
    w.s.commit()
    w.c.as_user(ADMIN)
    w.c.post(f"/api/flags/{w.f_secret.id}/comments", json={"body": "ping"})
    stats = compute_stats(w.s, OUTSIDER.id, now=datetime.now(timezone.utc))
    assert stats["unread"] == 0
    stats = compute_stats(w.s, MEMBER.id, now=datetime.now(timezone.utc))
    assert stats["unread"] >= 0  # member path loads the User row and applies the clause without error
