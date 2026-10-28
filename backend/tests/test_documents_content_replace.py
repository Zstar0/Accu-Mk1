"""Draft in-place content replace (spec 2026-10-03 §10.3)."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from documents_comments_support import (  # noqa: E402
    ADMIN, AGENT_TOKEN, HTML, INTERNAL_TOKEN, USER, client, publish)  # noqa: F401

NEW = HTML.replace("Dedupe on an EXPLICIT code", "Dedupe on an explicit code")


def _as_admin_bearer(client):
    from main import app
    from documents.routes import require_document_admin_user
    app.dependency_overrides[require_document_admin_user] = lambda: ADMIN


def _put(client, doc_id, html=NEW):
    return client.put(f"/api/documents/{doc_id}/content", json={"html": html})


def test_replaces_a_draft_in_place_and_drops_the_old_blob(client):
    r1 = publish(client)
    draft = publish(client, code=r1["code"], html=HTML.replace("Audit", "draft"), activate=False)
    _as_admin_bearer(client)
    from documents.models import Document
    from documents.storage import DocumentNotFound, get_storage
    old_key = client.db.get(Document, draft["id"]).storage_key
    r = _put(client, draft["id"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["id"], body["revision"], body["status"]) == (draft["id"], 2, "draft")
    assert body["updated_by"] == "admin@x.t" and body["content_sha256"] != draft["content_sha256"]
    row = client.db.get(Document, draft["id"])
    assert row.storage_key != old_key and row.size_bytes == len(NEW.encode())
    assert get_storage().fetch(row.storage_key) == NEW.encode()
    try:
        get_storage().fetch(old_key)
        assert False, "old blob should be gone"
    except DocumentNotFound:
        pass
    assert client.get(f"/api/documents/{draft['id']}/content").text == NEW


def test_identical_bytes_are_a_no_op(client):
    r1 = publish(client)
    draft = publish(client, code=r1["code"], html=HTML.replace("Audit", "draft"), activate=False)
    _as_admin_bearer(client)
    before = client.get(f"/api/documents/{draft['id']}").json()
    r = _put(client, draft["id"], HTML.replace("Audit", "draft"))
    assert r.status_code == 200
    after = client.get(f"/api/documents/{draft['id']}").json()
    assert after["content_sha256"] == before["content_sha256"] and after["updated_at"] == before["updated_at"]


def test_active_and_superseded_drafts_are_409_and_missing_is_404(client):
    r1 = publish(client)
    _as_admin_bearer(client)
    r = _put(client, r1["id"])
    assert r.status_code == 409 and "new revision" in r.text
    d2 = publish(client, code=r1["code"], html=HTML.replace("Audit", "d2"), activate=False)
    d3 = publish(client, code=r1["code"], html=HTML.replace("Audit", "d3"), activate=False)
    assert d3["supersedes_id"] == d2["id"]
    assert _put(client, d2["id"]).status_code == 409
    assert _put(client, d3["id"]).status_code == 200
    assert _put(client, 9999).status_code == 404


def test_validation_still_applies(client):
    r1 = publish(client)
    draft = publish(client, code=r1["code"], html=HTML.replace("Audit", "draft"), activate=False)
    _as_admin_bearer(client)
    assert _put(client, draft["id"], "not html").status_code == 400


def test_only_an_admin_bearer_may_replace_content(client):
    r1 = publish(client)
    draft = publish(client, code=r1["code"], html=HTML.replace("Audit", "draft"), activate=False)
    from main import app
    from documents.routes import require_document_admin_user
    app.dependency_overrides.pop(require_document_admin_user, None)
    assert client.put(f"/api/documents/{draft['id']}/content", json={"html": NEW},
                      headers={"X-Service-Token": AGENT_TOKEN}).status_code == 403
    assert client.put(f"/api/documents/{draft['id']}/content", json={"html": NEW},
                      headers={"X-Service-Token": INTERNAL_TOKEN}).status_code == 403
    assert client.put(f"/api/documents/{draft['id']}/content", json={"html": NEW}).status_code == 401
    # a standard-role bearer: patch the name the dependency resolves at call time
    import documents.routes as routes_mod
    saved = routes_mod.get_current_user
    routes_mod.get_current_user = lambda token, db: USER
    try:
        r = client.put(f"/api/documents/{draft['id']}/content", json={"html": NEW},
                       headers={"Authorization": "Bearer anything"})
        assert r.status_code == 403
    finally:
        routes_mod.get_current_user = saved


def test_expected_sha256_mismatch_is_409_before_any_write(client):
    r1 = publish(client)
    draft = publish(client, code=r1["code"], html=HTML.replace("Audit", "draft"), activate=False)
    _as_admin_bearer(client)
    from documents.models import Document
    old_key = client.db.get(Document, draft["id"]).storage_key
    r = client.put(f"/api/documents/{draft['id']}/content",
                   json={"html": NEW, "expected_sha256": "0" * 64})
    assert r.status_code == 409 and "changed since you opened it" in r.text
    row = client.db.get(Document, draft["id"])
    assert (row.storage_key, row.content_sha256) == (old_key, draft["content_sha256"])
    r = client.put(f"/api/documents/{draft['id']}/content",
                   json={"html": NEW, "expected_sha256": draft["content_sha256"]})
    assert r.status_code == 200, r.text
    assert r.json()["content_sha256"] != draft["content_sha256"]


def test_a_retried_put_with_the_old_sha_and_identical_bytes_is_a_no_op(client):
    r1 = publish(client)
    draft = publish(client, code=r1["code"], html=HTML.replace("Audit", "draft"), activate=False)
    _as_admin_bearer(client)
    body = {"html": NEW, "expected_sha256": draft["content_sha256"]}
    first = client.put(f"/api/documents/{draft['id']}/content", json=body)
    assert first.status_code == 200, first.text
    # The client never saw the first response and retries with the same body.
    retry = client.put(f"/api/documents/{draft['id']}/content", json=body)
    assert retry.status_code == 200, retry.text
    assert retry.json()["content_sha256"] == first.json()["content_sha256"]
