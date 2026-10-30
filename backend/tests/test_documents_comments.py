# backend/tests/test_documents_comments.py
"""Comment lifecycle (spec §4.1, §5, §6.1, §6.2)."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from documents_comments_support import (  # noqa: E402
    ADMIN, AGENT_TOKEN, HTML, INTERNAL_TOKEN, OTHER, OTHER_AGENT_TOKEN, USER, client, comment,
    publish)  # noqa: F401

def test_create_lists_with_stable_numbers_and_author_display(client):
    doc = publish(client)
    a = comment(client, doc["id"])
    b = comment(client, doc["id"], body="second", anchor=None)
    assert (a["number"], b["number"]) == (1, 2)
    assert a["author"] == "Tess Tech" and a["author_user_id"] == 42 and a["author_agent"] is None
    assert a["anchor"] == {"originalText": "still behaves as before"} and b["anchor"] is None
    r = client.get(f"/api/documents/{doc['id']}/comments")
    assert r.status_code == 200
    body = r.json()
    assert [c["number"] for c in body["items"]] == [1, 2]
    assert (body["code"], body["latest_revision"], body["open_count"]) == (doc["code"], 1, 2)

def test_numbers_survive_resolve_and_delete(client):
    doc = publish(client)
    a = comment(client, doc["id"])
    b = comment(client, doc["id"], body="b")
    c = comment(client, doc["id"], body="c")
    assert client.post(f"/api/documents/comments/{a['id']}/resolve").status_code == 200
    assert client.delete(f"/api/documents/comments/{b['id']}").status_code == 204
    items = client.get(f"/api/documents/{doc['id']}/comments?status=all").json()["items"]
    assert [(i["id"], i["number"], i["status"]) for i in items] == [
        (a["id"], 1, "resolved"), (c["id"], 3, "open")]
    assert [i["number"] for i in client.get(f"/api/documents/{doc['id']}/comments").json()["items"]] == [3]

def test_comments_follow_the_code_across_revisions(client):
    r1 = publish(client)
    a = comment(client, r1["id"])
    r2 = publish(client, code=r1["code"], html=HTML.replace("Audit", "Audit v2"))
    assert r2["revision"] == 2
    b = comment(client, r2["id"], body="on r2")
    items = client.get(f"/api/documents/{r2['id']}/comments").json()["items"]
    assert [(i["id"], i["revision"]) for i in items] == [(a["id"], 1), (b["id"], 2)]
    # viewing r1 shows the same list; the anchors re-resolve client-side
    assert [i["id"] for i in client.get(f"/api/documents/{r1['id']}/comments").json()["items"]] == [a["id"], b["id"]]

def test_replies_nest_one_level_and_inherit_nothing(client):
    doc = publish(client)
    a = comment(client, doc["id"])
    reply = comment(client, doc["id"], parent_id=a["id"], body="because", anchor={"originalText": "ignored"})
    assert reply["parent_id"] == a["id"] and reply["anchor"] is None and reply["number"] is None
    r = client.post(f"/api/documents/{doc['id']}/comments",
                    json={"kind": "comment", "body": "deeper", "parent_id": reply["id"]})
    assert r.status_code == 400 and "replies cannot have replies" in r.text
    items = client.get(f"/api/documents/{doc['id']}/comments").json()["items"]
    assert [x["id"] for x in items[0]["replies"]] == [reply["id"]]
    r = client.post(f"/api/documents/comments/{reply['id']}/resolve")
    assert r.status_code == 400 and "top-level" in r.text

def test_suggestion_needs_replacement_and_comment_may_not_carry_one(client):
    doc = publish(client)
    s = comment(client, doc["id"], kind="suggestion", suggested_text="behaves as it did before 09-17",
                body="")
    assert s["kind"] == "suggestion" and s["suggested_text"].startswith("behaves")
    r = client.post(f"/api/documents/{doc['id']}/comments",
                    json={"kind": "suggestion", "body": "x", "anchor": {"originalText": "before"}})
    assert r.status_code == 400 and "suggested_text" in r.text
    r = client.post(f"/api/documents/{doc['id']}/comments",
                    json={"kind": "comment", "body": "x", "suggested_text": "y"})
    assert r.status_code == 400
    r = client.post(f"/api/documents/{doc['id']}/comments", json={"kind": "redline", "body": "x"})
    assert r.status_code == 400

def test_label_only_comment_is_allowed_and_unknown_label_is_400(client):
    doc = publish(client)
    c = comment(client, doc["id"], body="", label="verify-this")
    assert c["label"] == "verify-this" and c["body"] == ""
    r = client.post(f"/api/documents/{doc['id']}/comments", json={"kind": "comment", "body": "", "label": "needs-tests"})
    assert r.status_code == 400 and "label" in r.text
    r = client.post(f"/api/documents/{doc['id']}/comments", json={"kind": "comment", "body": ""})
    assert r.status_code == 400 and "body or a label" in r.text

def test_quote_only_anchor_is_verified_against_the_revision(client):
    doc = publish(client)
    r = client.post(f"/api/documents/{doc['id']}/comments",
                    json={"kind": "comment", "body": "x", "anchor": {"originalText": "words not in the doc"}})
    assert r.status_code == 400
    assert r.json()["detail"] == f'quote not found in {doc["code"]} r1: "words not in the doc"'
    # entities and nbsp in the source do not defeat a quote of the rendered text
    comment(client, doc["id"], anchor={"originalText": "Cd & Pb limits use 50% of spec"})
    # a DOM-anchored quote is trusted (it came from a real Range)
    comment(client, doc["id"], anchor={"originalText": "not verified", "htmlAnchor": {"selector": "p", "tagName": "p"}})

def test_anchor_caps_surface_as_400(client):
    doc = publish(client)
    r = client.post(f"/api/documents/{doc['id']}/comments",
                    json={"kind": "comment", "body": "x", "anchor": {"originalText": "q" * 401}})
    assert r.status_code == 400 and "400" in r.text

def test_missing_document_is_404(client):
    r = client.post("/api/documents/9999/comments", json={"kind": "comment", "body": "x"})
    assert r.status_code == 404

def test_edit_and_delete_are_author_or_admin(client):
    doc = publish(client)
    a = comment(client, doc["id"])
    client.as_user(OTHER)
    assert client.patch(f"/api/documents/comments/{a['id']}", json={"body": "hijack"}).status_code == 403
    assert client.delete(f"/api/documents/comments/{a['id']}").status_code == 403
    # anyone may resolve
    assert client.post(f"/api/documents/comments/{a['id']}/resolve").status_code == 200
    got = client.get(f"/api/documents/comments/{a['id']}").json()
    assert got["status"] == "resolved" and got["resolved_by"] == "Olu"
    assert client.post(f"/api/documents/comments/{a['id']}/reopen").status_code == 200
    client.as_user(USER)
    r = client.patch(f"/api/documents/comments/{a['id']}", json={"body": "clarified"})
    assert r.status_code == 200 and r.json()["body"] == "clarified" and r.json()["edited_at"]
    client.as_user(ADMIN)
    assert client.delete(f"/api/documents/comments/{a['id']}").status_code == 204
    assert client.get(f"/api/documents/comments/{a['id']}").status_code == 404

def test_agent_token_names_the_author_and_internal_token_is_refused(client):
    doc = publish(client)
    client.real_actor()
    r = client.post(f"/api/documents/{doc['id']}/comments", headers={"X-Service-Token": AGENT_TOKEN},
                    json={"kind": "comment", "body": "from jarvis", "author_user_id": 1})
    assert r.status_code == 201, r.text
    assert (r.json()["author"], r.json()["author_agent"], r.json()["author_user_id"]) == ("jarvis", "jarvis", None)
    r = client.post(f"/api/documents/{doc['id']}/comments", headers={"X-Service-Token": INTERNAL_TOKEN},
                    json={"kind": "comment", "body": "nameless"})
    assert r.status_code == 403 and "named author" in r.text
    r = client.post(f"/api/documents/{doc['id']}/comments", headers={"X-Service-Token": "wrong"},
                    json={"kind": "comment", "body": "x"})
    assert r.status_code == 401
    r = client.post(f"/api/documents/{doc['id']}/comments", json={"kind": "comment", "body": "x"})
    assert r.status_code == 401  # no credential at all

def test_agent_may_edit_only_its_own_comment(client):
    doc = publish(client)
    client.real_actor()
    mine = client.post(f"/api/documents/{doc['id']}/comments", headers={"X-Service-Token": AGENT_TOKEN},
                       json={"kind": "comment", "body": "mine"}).json()
    r = client.patch(f"/api/documents/comments/{mine['id']}", headers={"X-Service-Token": OTHER_AGENT_TOKEN},
                     json={"body": "stolen"})
    assert r.status_code == 403
    r = client.patch(f"/api/documents/comments/{mine['id']}", headers={"X-Service-Token": AGENT_TOKEN},
                     json={"body": "edited"})
    assert r.status_code == 200

def test_open_comment_count_rides_document_detail_and_list(client):
    doc = publish(client)
    comment(client, doc["id"])
    comment(client, doc["id"], body="b")
    resolved = comment(client, doc["id"], body="c")
    client.post(f"/api/documents/comments/{resolved['id']}/resolve")
    assert client.get(f"/api/documents/{doc['id']}").json()["open_comment_count"] == 2
    items = client.get("/api/documents").json()["items"]
    assert [i["open_comment_count"] for i in items if i["code"] == doc["code"]] == [2]


def test_nested_revisions_carry_the_codes_open_comment_count(client):
    doc = publish(client)
    publish(client, code=doc["code"], html=HTML.replace("Audit", "draft"), activate=False)
    comment(client, doc["id"])
    detail = client.get(f"/api/documents/{doc['id']}").json()
    assert detail["open_comment_count"] == 1
    assert [r["open_comment_count"] for r in detail["revisions"]] == [1, 1]

def test_discarding_a_draft_takes_its_comments(client):
    r1 = publish(client)
    draft = publish(client, code=r1["code"], html=HTML.replace("Audit", "draft"), activate=False)
    on_draft = comment(client, draft["id"], anchor=None)
    on_r1 = comment(client, r1["id"], anchor=None)
    r = client.delete(f"/api/documents/{draft['id']}?code={draft['code']}&revision=2")
    assert r.status_code == 200, r.text
    ids = [i["id"] for i in client.get(f"/api/documents/{r1['id']}/comments").json()["items"]]
    assert ids == [on_r1["id"]] and on_draft["id"] not in ids

def test_reply_has_no_number_and_code_number_is_unique(client):
    import pytest
    from sqlalchemy.exc import IntegrityError
    from documents.models import DocumentComment
    doc = publish(client)
    a = comment(client, doc["id"])
    reply = comment(client, doc["id"], parent_id=a["id"], body="r")
    assert reply["number"] is None
    client.db.add(DocumentComment(code=doc["code"], document_id=doc["id"], number=a["number"],
                                  body="dup", author_user_id=42))
    with pytest.raises(IntegrityError):
        client.db.commit()
    client.db.rollback()


def test_a_deleted_top_number_is_never_reused(client):
    doc = publish(client)
    comment(client, doc["id"])
    comment(client, doc["id"], body="b")
    c = comment(client, doc["id"], body="c")
    assert client.delete(f"/api/documents/comments/{c['id']}").status_code == 204
    assert comment(client, doc["id"], body="d")["number"] == 4
    draft = publish(client, code=doc["code"], html=HTML.replace("Audit", "draft"), activate=False)
    e = comment(client, draft["id"], body="e", anchor=None)
    assert e["number"] == 5
    client.delete(f"/api/documents/{draft['id']}?code={draft['code']}&revision=2")
    assert comment(client, doc["id"], body="f", anchor=None)["number"] == 6


def test_patch_cannot_empty_a_comment_and_noop_is_not_an_edit(client):
    doc = publish(client)
    a = comment(client, doc["id"])
    r = client.patch(f"/api/documents/comments/{a['id']}", json={"body": ""})
    assert r.status_code == 400 and "body or a label" in r.text
    r = client.patch(f"/api/documents/comments/{a['id']}", json={})
    assert r.status_code == 200 and r.json()["edited_at"] is None
