"""Document spaces gate the annotations routes (spec 2026-10-06 sections 5.2 and 8.2).

USER (42) is outside the restricted space, OTHER (43) is a member, ADMIN sees everything.
Hidden must read exactly like missing for the resource the route names."""
import io
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))
from documents_comments_support import (  # noqa: E402
    ADMIN, AGENT_TOKEN, HTML, OTHER, OTHER_AGENT_TOKEN, PNG, USER, client, comment, publish)  # noqa: F401

MISSING = 999999
SCOPED_TOKEN = "s" * 40


@pytest.fixture
def world(client, monkeypatch):
    """A Leadership space granted to a group holding OTHER only, with one document in it
    carrying an admin comment and an admin attachment."""
    from documents.models import DocumentSpace, DocumentSpaceGrant
    from groups.models import UserGroup, UserGroupMember
    monkeypatch.setenv("MK1_DOCUMENT_AGENT_TOKENS",
                       f"jarvis:{AGENT_TOKEN},tars:{OTHER_AGENT_TOKEN},"
                       f"scoped:{SCOPED_TOKEN}:general+leadership")
    db = client.db
    g = UserGroup(slug="leaders", name="Leaders")
    sp = DocumentSpace(slug="leadership", name="Leadership", visibility="restricted")
    db.add_all([g, sp])
    db.flush()
    db.add_all([UserGroupMember(group_id=g.id, user_id=OTHER.id),
                DocumentSpaceGrant(space_id=sp.id, group_id=g.id)])
    db.commit()
    secret = publish(client, title="Q4 layoffs plan", space="leadership")
    open_doc = publish(client, title="Open handbook", html=HTML.replace("Audit", "Open"))
    client.as_user(ADMIN)
    client.read_as(ADMIN)
    c = comment(client, secret["id"])
    att = _upload(client, secret["id"])
    assert att.status_code == 201, att.text
    return {"secret": secret, "open": open_doc, "comment": c, "att": att.json()}


def _upload(client, doc_id, **kw):
    return client.post(f"/api/documents/{doc_id}/comment-attachments",
                       files={"file": ("shot.png", io.BytesIO(PNG), "image/png")}, **kw)


def _same_as_missing(hidden, missing, hidden_id):
    assert hidden.status_code == missing.status_code == 404, (hidden.text, missing.text)
    assert hidden.json() == {"detail": missing.json()["detail"].replace(str(MISSING), str(hidden_id))}
    assert "Q4 layoffs" not in hidden.text


def _as(client, u):
    client.as_user(u)
    client.read_as(u)


def _reads(client, doc_id, cid, aid, **kw):
    return {
        "list": (client.get(f"/api/documents/{doc_id}/comments", **kw), doc_id),
        "export": (client.get(f"/api/documents/{doc_id}/comments/export", **kw), doc_id),
        "one": (client.get(f"/api/documents/comments/{cid}", **kw), cid),
        "att": (client.get(f"/api/documents/comment-attachments/{aid}", **kw), aid),
    }


def test_outsider_reads_of_a_hidden_document_are_byte_identical_to_missing(client, world):
    s, c, a = world["secret"], world["comment"], world["att"]
    _as(client, USER)
    hidden = _reads(client, s["id"], c["id"], a["id"])
    missing = _reads(client, MISSING, MISSING, MISSING)
    for k in hidden:
        _same_as_missing(hidden[k][0], missing[k][0], hidden[k][1])
    idx = client.get("/api/documents/comments?status=all")
    assert idx.status_code == 200
    assert all(i["document_id"] != s["id"] for i in idx.json()["items"])
    assert "Q4 layoffs" not in idx.text


def test_outsider_writes_on_a_hidden_document_are_byte_identical_to_missing(client, world):
    s, c = world["secret"], world["comment"]
    _as(client, USER)
    body = {"kind": "comment", "body": "x"}
    _same_as_missing(client.post(f"/api/documents/{s['id']}/comments", json=body),
                     client.post(f"/api/documents/{MISSING}/comments", json=body), s["id"])
    _same_as_missing(_upload(client, s["id"]), _upload(client, MISSING), s["id"])
    for verb, suffix, kw in (("patch", "", {"json": {"body": "y"}}), ("delete", "", {}),
                             ("post", "/resolve", {}), ("post", "/reopen", {})):
        call = getattr(client, verb)
        _same_as_missing(call(f"/api/documents/comments/{c['id']}{suffix}", **kw),
                         call(f"/api/documents/comments/{MISSING}{suffix}", **kw), c["id"])
    from documents.models import DocumentComment
    client.db.expire_all()
    assert client.db.get(DocumentComment, c["id"]).status == "open"


def test_member_and_admin_still_see_everything(client, world):
    s, c, a = world["secret"], world["comment"], world["att"]
    for u in (OTHER, ADMIN):
        _as(client, u)
        for k, (r, _) in _reads(client, s["id"], c["id"], a["id"]).items():
            assert r.status_code == 200, (u.id, k, r.text)
        assert any(i["document_id"] == s["id"]
                   for i in client.get("/api/documents/comments").json()["items"])
    _as(client, OTHER)
    reply = comment(client, s["id"], body="ack", anchor=None, parent_id=c["id"])
    assert reply["parent_id"] == c["id"]
    assert client.post(f"/api/documents/comments/{c['id']}/resolve").status_code == 200


def test_open_document_comments_are_unaffected_for_the_outsider(client, world):
    _as(client, USER)
    mine = comment(client, world["open"]["id"])
    assert client.get(f"/api/documents/{world['open']['id']}/comments").status_code == 200
    assert client.post(f"/api/documents/comments/{mine['id']}/resolve").status_code == 200
    items = client.get("/api/documents/comments?status=all").json()["items"]
    assert [i["id"] for i in items] == [mine["id"]]


def test_agent_tokens_follow_their_allow_list(client, world):
    s, c = world["secret"], world["comment"]
    client.real_actor()
    general_only = {"X-Service-Token": AGENT_TOKEN}
    body = {"kind": "comment", "body": "from an agent"}
    _same_as_missing(client.post(f"/api/documents/{s['id']}/comments", json=body, headers=general_only),
                     client.post(f"/api/documents/{MISSING}/comments", json=body, headers=general_only),
                     s["id"])
    _same_as_missing(_upload(client, s["id"], headers=general_only),
                     _upload(client, MISSING, headers=general_only), s["id"])
    _same_as_missing(client.post(f"/api/documents/comments/{c['id']}/resolve", headers=general_only),
                     client.post(f"/api/documents/comments/{MISSING}/resolve", headers=general_only),
                     c["id"])
    scoped = {"X-Service-Token": SCOPED_TOKEN}
    r = client.post(f"/api/documents/{s['id']}/comments", json=body, headers=scoped)
    assert r.status_code == 201, r.text
    assert r.json()["author"] == "scoped"
    assert _upload(client, s["id"], headers=scoped).status_code == 201
    assert client.post(f"/api/documents/comments/{c['id']}/resolve", headers=scoped).status_code == 200
    # General documents stay open to the General-only agent.
    ok = client.post(f"/api/documents/{world['open']['id']}/comments", json=body, headers=general_only)
    assert ok.status_code == 201, ok.text


def test_content_edit_runs_the_gate_before_the_write(client, world):
    from main import app
    from documents.routes import require_document_admin_user
    draft = publish(client, code=world["secret"]["code"], html=HTML.replace("Audit", "draft"),
                    activate=False)
    new = HTML.replace("Audit", "edited")
    try:
        app.dependency_overrides[require_document_admin_user] = lambda: ADMIN
        assert client.put(f"/api/documents/{draft['id']}/content", json={"html": new}).status_code == 200
        # A future non-admin editor outside the space gets exactly what a missing id gets.
        app.dependency_overrides[require_document_admin_user] = lambda: USER
        _same_as_missing(client.put(f"/api/documents/{draft['id']}/content", json={"html": new + " "}),
                         client.put(f"/api/documents/{MISSING}/content", json={"html": new + " "}),
                         draft["id"])
    finally:
        app.dependency_overrides.pop(require_document_admin_user, None)
