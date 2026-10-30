# backend/tests/test_documents_comment_export.py
"""Agent-facing export (spec §6.3) and the cross-document index (spec §6.2)."""
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(__file__))
from documents_comments_support import (  # noqa: E402
    AGENT_TOKEN, HTML, client, comment, publish)  # noqa: F401


def _stamp(db, comment_id, when):
    from documents.models import DocumentComment
    row = db.get(DocumentComment, comment_id)
    row.created_at = when
    db.commit()


def test_export_golden(client):
    r1 = publish(client)
    labelled = comment(client, r1["id"], body="Which \"before\"? Name the behaviour.",
                       label="clarify-this",
                       anchor={"originalText": "still behaves as before",
                               "htmlAnchor": {"selector": "body > p:nth-of-type(1)", "tagName": "p"},
                               "elementContext": {"tag": "p", "heading": 'h2 "Rulings"',
                                                  "path": "body > p"}})
    _stamp(client.db, labelled["id"], datetime(2026, 10, 3, 14, 2))
    client.real_actor()
    reply = client.post(f"/api/documents/{r1['id']}/comments", headers={"X-Service-Token": AGENT_TOKEN},
                        json={"kind": "comment", "parent_id": labelled["id"],
                              "body": "Meaning the pre-09-17 behaviour. Will state it."}).json()
    _stamp(client.db, reply["id"], datetime(2026, 10, 3, 14, 10))
    client.as_user(__import__("documents_comments_support").USER)
    r2 = publish(client, code=r1["code"], html=HTML.replace("Audit", "Audit v2"))
    sugg = comment(client, r2["id"], kind="suggestion", body="",
                   suggested_text="the lab's calendar day",
                   anchor={"originalText": "50% of spec"})
    _stamp(client.db, sugg["id"], datetime(2026, 10, 3, 14, 5))
    glob = comment(client, r2["id"], body="Section 4 has no owner named.", anchor=None)
    _stamp(client.db, glob["id"], datetime(2026, 10, 3, 14, 7))
    done = comment(client, r2["id"], body="resolved one", anchor=None)
    client.post(f"/api/documents/comments/{done['id']}/resolve")

    r = client.get(f"/api/documents/{r2['id']}/comments/export")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/markdown")
    assert r.text == (
        f'# Comments on {r1["code"]} "Audit"\n'
        "Latest revision: r2 (active). 3 open.\n"
        "\n"
        "## 1. ❓ Clarify this — Tess Tech, on r1, 2026-10-03 14:02\n"
        '> "still behaves as before"\n'
        'Where: h2 "Rulings" › body > p\n'
        'Which "before"? Name the behaviour.\n'
        "Agent tip: This passage is ambiguous. Rewrite it so a new technician reads it one way.\n"
        "Replies:\n"
        "- jarvis, 2026-10-03 14:10: Meaning the pre-09-17 behaviour. Will state it.\n"
        "\n"
        "## 2. Suggestion — Tess Tech, on r2, 2026-10-03 14:05\n"
        '> "50% of spec"\n'
        "Replace with:\n"
        '> "the lab\'s calendar day"\n'
        "\n"
        "## 3. Global — Tess Tech, on r2, 2026-10-03 14:07\n"
        "Section 4 has no owner named.\n"
        "\n"
        "---\n"
        "Address each item. Post the next revision with `documents_revise`. Then resolve what you "
        "handled with `documents_comment_resolve`, or answer with `documents_comment_reply` where "
        "you disagree. Do not edit comments you did not write.\n")
    assert "## 4." in client.get(f"/api/documents/{r2['id']}/comments/export?status=all").text


def test_export_lists_attachment_tokens(client):
    import io
    from documents_comments_support import PNG
    doc = publish(client)
    aid = client.post(f"/api/documents/{doc['id']}/comment-attachments",
                      files={"file": ("a.png", io.BytesIO(PNG), "image/png")}).json()["id"]
    comment(client, doc["id"], body=f"look {{attachment:{aid}}}", anchor=None)
    text = client.get(f"/api/documents/{doc['id']}/comments/export").text
    assert f"Attachments: {{attachment:{aid}}}" in text


def test_index_lists_open_comments_across_documents_with_filters(client):
    a = publish(client)
    b = publish(client, title="SOP one", html=HTML.replace("Audit", "SOP"), category="SOP")
    ca = comment(client, a["id"], body="on art", anchor=None)
    client.real_actor()
    cb = client.post(f"/api/documents/{b['id']}/comments", headers={"X-Service-Token": AGENT_TOKEN},
                     json={"kind": "comment", "body": "on sop by jarvis"}).json()
    r = client.get("/api/documents/comments")
    assert r.status_code == 200  # 422 means /documents/{doc_id} swallowed the literal path
    rows = r.json()["items"]
    assert [x["id"] for x in rows] == [cb["id"], ca["id"]]  # newest first
    assert rows[0]["code"] == b["code"] and rows[0]["title"] == "SOP one" and rows[0]["author"] == "jarvis"
    assert rows[0]["document_id"] == b["id"]
    assert [x["id"] for x in client.get("/api/documents/comments?author_agent=jarvis").json()["items"]] == [cb["id"]]
    assert [x["id"] for x in client.get("/api/documents/comments?code_prefix=ART").json()["items"]] == [ca["id"]]
    client.post(f"/api/documents/comments/{ca['id']}/resolve", headers={"X-Service-Token": AGENT_TOKEN})
    assert [x["id"] for x in client.get("/api/documents/comments").json()["items"]] == [cb["id"]]
    assert [x["id"] for x in client.get("/api/documents/comments?status=resolved").json()["items"]] == [ca["id"]]
