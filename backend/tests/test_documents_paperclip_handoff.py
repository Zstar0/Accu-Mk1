"""Agent draft -> readback -> Paperclip reference -> exact-revision render (contract).

Exercises the real registered /documents routes (in-memory DB and storage, no
network). The embed shell (src/components/documents/DocumentEmbed.tsx) renders a
reference only when id/code/revision/content_sha256 match and the fetched bytes
hash to content_sha256; these tests pin the server side of that contract.
"""
import hashlib
import importlib.util
import os
import sys
import urllib.error
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
from test_documents_routes import AGENT_ENV, HTML, JARVIS, _agent, _publish, client  # noqa: F401

_PUB = Path(__file__).resolve().parents[2] / ".claude/skills/mk1-publish-document/scripts/publish_document.py"
_spec = importlib.util.spec_from_file_location("publish_document", _PUB)
publisher = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(publisher)


def _draft(client, **kw):
    return _publish(client, headers=_agent(JARVIS), author="Requester Name",
                    source_session="paperclip-run-1", activate=False, **kw)


def test_agent_draft_readback_and_reference_pin_the_exact_bytes(client):
    with patch.dict(os.environ, AGENT_ENV):
        r = _draft(client)
        assert r.status_code == 201, r.text
        doc = r.json()
        assert doc["status"] == "draft" and doc["co_author"] == "jarvis"
        assert doc["author"] == "Requester Name"

        ref = publisher.paperclip_ref(doc)
        assert ref == {"provider": "accumk1", "objectType": "controlled_document",
                       "documentId": doc["id"], "code": doc["code"], "revision": 1,
                       "contentHash": doc["content_sha256"], "status": "draft",
                       "title": doc["title"], "spaceSlug": "general"}

        detail = client.get(f"/api/documents/{doc['id']}").json()
        assert (detail["code"], detail["revision"], detail["content_sha256"]) == (
            ref["code"], ref["revision"], ref["contentHash"])
        content = client.get(f"/api/documents/{doc['id']}/content")
        assert hashlib.sha256(content.content).hexdigest() == ref["contentHash"]
        assert content.headers["content-security-policy"] == "sandbox allow-scripts"
        assert content.headers["x-content-type-options"] == "nosniff"


def test_blind_retry_of_an_uncertain_create_never_mints_a_duplicate(client):
    with patch.dict(os.environ, AGENT_ENV):
        first = _draft(client).json()
        again = _draft(client)
        assert again.status_code == 409
        assert publisher.ALREADY_RE.search(again.text).groups() == (first["code"], "1")
        listed = client.get("/api/documents").json()
        assert [i["code"] for i in listed["items"]].count(first["code"]) == 1
        assert listed["total"] == 1


def test_revision_keeps_old_id_pinned_and_identical_revise_is_a_noop(client):
    with patch.dict(os.environ, AGENT_ENV):
        r1 = _draft(client).json()
        same = _publish(client, headers=_agent(JARVIS), code=r1["code"], html=HTML, activate=False)
        assert same.status_code == 200 and same.json()["id"] == r1["id"]
        r2 = _publish(client, headers=_agent(JARVIS), code=r1["code"],
                      html=HTML + "<!--r2-->", activate=False).json()
        assert r2["revision"] == 2 and r2["id"] != r1["id"]
        old = client.get(f"/api/documents/{r1['id']}/content")
        assert hashlib.sha256(old.content).hexdigest() == r1["content_sha256"]
        assert client.get(f"/api/documents/{r1['id']}").json()["revision"] == 1


def test_publisher_retries_a_transport_failure_once_with_the_identical_payload():
    calls = []

    def fake(base, token, payload):
        calls.append(payload)
        if len(calls) == 1:
            raise urllib.error.URLError("timed out")
        return {"id": 1}

    with patch.object(publisher, "post_document", fake):
        assert publisher.post_with_reconcile("http://x", "t", {"html": "<p>"}) == {"id": 1}
    assert calls == [{"html": "<p>"}, {"html": "<p>"}]


def test_publisher_does_not_retry_an_http_error():
    calls = []

    def fake(base, token, payload):
        calls.append(1)
        raise urllib.error.HTTPError("http://x", 500, "boom", {}, None)

    with patch.object(publisher, "post_document", fake):
        try:
            publisher.post_with_reconcile("http://x", "t", {})
        except urllib.error.HTTPError:
            pass
    assert calls == [1]
