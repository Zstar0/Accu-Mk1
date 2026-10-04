"""Comment attachments (spec §4.2): sniffed, capped, linked by token, swept when orphaned."""
import io
import os
import sys
from datetime import datetime, timedelta

import pytest

sys.path.insert(0, os.path.dirname(__file__))
from documents_comments_support import (  # noqa: E402
    GIF, JPEG, NOT_IMAGE, PNG, WEBP, client, comment, publish)  # noqa: F401


def _upload(client, doc_id, data=PNG, name="shot.png"):
    return client.post(f"/api/documents/{doc_id}/comment-attachments",
                       files={"file": (name, io.BytesIO(data), "application/octet-stream")})


@pytest.mark.parametrize("data, ct", [(PNG, "image/png"), (JPEG, "image/jpeg"),
                                      (GIF, "image/gif"), (WEBP, "image/webp")])
def test_magic_bytes_decide_the_type_not_the_client(client, data, ct):
    doc = publish(client)
    r = _upload(client, doc["id"], data)
    assert r.status_code == 201, r.text
    assert r.json()["content_type"] == ct and r.json()["size_bytes"] == len(data)


def test_non_image_and_oversize_are_400(client, monkeypatch):
    doc = publish(client)
    assert _upload(client, doc["id"], NOT_IMAGE, "x.pdf").status_code == 400
    from documents import comments
    monkeypatch.setattr(comments, "MAX_ATTACHMENT_BYTES", 10)
    assert _upload(client, doc["id"], PNG).status_code == 400
    assert _upload(client, doc["id"], b"", "e.png").status_code == 400


def test_served_authenticated_inline_nosniff(client):
    doc = publish(client)
    aid = _upload(client, doc["id"]).json()["id"]
    r = client.get(f"/api/documents/comment-attachments/{aid}")
    assert r.status_code == 200 and r.content == PNG
    assert r.headers["content-type"].startswith("image/png")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["content-disposition"] == 'inline; filename="shot.png"'
    assert "private" in r.headers["cache-control"]
    assert client.get("/api/documents/comment-attachments/9999").status_code == 404


def test_body_token_links_the_upload_and_the_card_lists_it(client):
    doc = publish(client)
    aid = _upload(client, doc["id"]).json()["id"]
    c = comment(client, doc["id"], body=f"see {{attachment:{aid}}}")
    assert [a["id"] for a in c["attachments"]] == [aid]
    from documents.models import DocumentCommentAttachment
    assert client.db.get(DocumentCommentAttachment, aid).comment_id == c["id"]


def test_token_for_another_code_is_not_claimed(client):
    a = publish(client)
    from documents_comments_support import HTML
    b = publish(client, title="Other", html=HTML.replace("Audit", "Other"))
    aid = _upload(client, b["id"]).json()["id"]
    c = comment(client, a["id"], body=f"{{attachment:{aid}}}")
    assert c["attachments"] == []
    from documents.models import DocumentCommentAttachment
    assert client.db.get(DocumentCommentAttachment, aid).comment_id is None


def test_patch_relinks_and_delete_removes_rows_and_blobs(client):
    doc = publish(client)
    aid = _upload(client, doc["id"]).json()["id"]
    c = comment(client, doc["id"], body="no token yet")
    r = client.patch(f"/api/documents/comments/{c['id']}", json={"body": f"now {{attachment:{aid}}}"})
    assert [a["id"] for a in r.json()["attachments"]] == [aid]
    assert client.delete(f"/api/documents/comments/{c['id']}").status_code == 204
    assert client.get(f"/api/documents/comment-attachments/{aid}").status_code == 404
    from flags import seams
    from documents.models import DocumentCommentAttachment
    assert client.db.query(DocumentCommentAttachment).count() == 0


def test_gc_sweeps_only_unlinked_rows_past_the_cutoff(client):
    doc = publish(client)
    old = _upload(client, doc["id"]).json()["id"]
    fresh = _upload(client, doc["id"]).json()["id"]
    linked = _upload(client, doc["id"]).json()["id"]
    comment(client, doc["id"], body=f"{{attachment:{linked}}}")
    from documents.models import DocumentCommentAttachment
    row = client.db.get(DocumentCommentAttachment, old)
    row.created_at = datetime.utcnow() - timedelta(hours=30)
    client.db.commit()
    from documents.comment_attachments_gc import gc_orphaned_comment_attachments
    removed = gc_orphaned_comment_attachments(client.db, now=datetime.utcnow())
    assert removed == 1
    left = {a.id for a in client.db.query(DocumentCommentAttachment)}
    assert left == {fresh, linked}


def test_agent_uploads_are_stamped_with_the_agent(client):
    doc = publish(client)
    client.real_actor()
    from documents_comments_support import AGENT_TOKEN
    r = client.post(f"/api/documents/{doc['id']}/comment-attachments",
                    headers={"X-Service-Token": AGENT_TOKEN},
                    files={"file": ("a.png", io.BytesIO(PNG), "image/png")})
    assert r.status_code == 201
    from documents.models import DocumentCommentAttachment
    row = client.db.get(DocumentCommentAttachment, r.json()["id"])
    assert (row.uploaded_by_agent, row.uploaded_by_user_id) == ("jarvis", None)
    assert row.storage_key.startswith(f"documents/{doc['code']}/")
