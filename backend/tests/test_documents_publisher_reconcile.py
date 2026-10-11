"""Exercise the committed publisher against real document routes with a lost response.

The transport seam deliberately drops the first response after the route commits.
Missing reconciliation in the shipped helper must fail, not skip this regression.
"""
import importlib.util
import io
import json
import os
import sys
import urllib.error
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.dirname(__file__))
from test_documents_routes import AGENT_ENV, HTML, JARVIS, client  # noqa: F401

_PUB = str(
    Path(__file__).resolve().parents[2] / ".claude/skills/mk1-publish-document/scripts/publish_document.py")
_spec = importlib.util.spec_from_file_location("publisher_reconcile", _PUB)
pub = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pub)
assert hasattr(pub, "reconcile"), "committed publisher must implement reconciliation"


def _lossy(client, lose_first=True):
    calls = []

    def post(base, token, payload):
        r = client.post("/api/documents", json=payload, headers={"X-Service-Token": token})
        calls.append(r.status_code)
        if lose_first and len(calls) == 1:
            raise TimeoutError("response lost after the server committed")
        if r.status_code >= 400:
            raise urllib.error.HTTPError("http://x/api/documents", r.status_code, "err", {}, io.BytesIO(r.content))
        return r.json()
    return post, calls


def _run(client, tmp_path, capsys, session="paperclip-run-1", lose_first=True):
    page = tmp_path / "p.html"
    page.write_text(HTML, encoding="utf-8")
    argv = [str(page), "--title", "Audit", "--category", "ART", "--draft", "--author", "Requester Name",
            "--base-url", "http://x", "--paperclip-ref"] + (["--session", session] if session else [])
    post, calls = _lossy(client, lose_first)
    env = {**AGENT_ENV, "MK1_DOCUMENT_AGENT_TOKEN": JARVIS}
    with patch.dict(os.environ, env), patch.object(pub, "post_document", post):
        code = pub.main(argv)
    return code, capsys.readouterr().out.strip().splitlines(), calls


def test_lost_response_then_409_reconciles_to_the_created_draft(client, tmp_path, capsys):
    code, out, calls = _run(client, tmp_path, capsys)
    assert code == 0 and calls == [201, 409]
    ref = json.loads(out[-1])
    listed = client.get("/api/documents").json()
    assert listed["total"] == 1
    doc = client.get(f"/api/documents/{ref['documentId']}").json()
    assert (ref["code"], ref["revision"], ref["contentHash"], ref["status"]) == (
        doc["code"], 1, doc["content_sha256"], "draft")
    assert doc["author"] == "Requester Name" and doc["co_author"] == "jarvis"


def test_lost_response_against_another_sessions_document_is_unknown_not_new(client, tmp_path, capsys):
    _run(client, tmp_path, capsys, session="paperclip-run-1")
    code, out, calls = _run(client, tmp_path, capsys, session="paperclip-run-2")
    assert code == 5 and calls == [409, 409]
    result = json.loads(out[-1])
    assert result["outcome"] == "unknown" and "source_session" in result["reason"]
    assert result["candidate"]["revision"] == 1
    assert client.get("/api/documents").json()["total"] == 1


def test_no_session_is_never_reconciled(client, tmp_path, capsys):
    code, out, _ = _run(client, tmp_path, capsys, session=None)
    assert code == 5 and json.loads(out[-1])["outcome"] == "unknown"
    assert client.get("/api/documents").json()["total"] == 1


def test_first_attempt_409_stays_already_published(client, tmp_path, capsys):
    _run(client, tmp_path, capsys)
    code, out, calls = _run(client, tmp_path, capsys, lose_first=False)
    assert code == 4 and calls == [409]
    assert "already_published" in json.loads(out[-1])


def test_code_regex_matches_the_backend_grammar():
    for code in ["ART-0007", "SOP-QA-0001", "9X-A-B-C", "A1-0"]:
        assert pub.ALREADY_RE.search(f"already published as {code} r3").groups() == (code, "3")
    assert pub.ALREADY_RE.search("already published as art-0007 r1") is None
