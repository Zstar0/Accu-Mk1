"""Per-revision provenance (documents/provenance.py): creator from the credential,
requester verified only when Mk1 resolved the login, source always the caller's claim
over HTTP. Real FastAPI document routes, in-memory SQLite and storage."""
import os
import sys
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
from test_documents_routes import (AGENT_ENV, HTML, JARVIS, SVC, TARS, _agent, _as_admin,  # noqa: F401
                                   _publish, _read_as, _restricted_world, client)

ISSUE = {"source_system": "paperclip", "source_record_type": "issue",
         "source_record_id": "6f1c2a9e-0b7d-4c1e-9a55-3f2d8e7b1c00", "source_record_label": "ACC-111",
         "source_run_id": "run-7d1f0c2e"}


def _admin_row(client):
    """User 1 as a real row and the writer, as require_document_writer returns it in prod."""
    import models
    from main import app
    from documents.routes import require_document_writer
    user = models.User(id=1, email="admin@x.t", hashed_password="x", role="admin",
                       first_name="Ada", last_name="Admin")
    client.db.add(user)
    client.db.commit()
    app.dependency_overrides[require_document_writer] = lambda: user


def _detail(client, doc_id):
    return client.get(f"/api/documents/{doc_id}").json()


def _doc_count(client):
    from sqlalchemy import func, select
    from documents.models import Document
    return client.db.execute(select(func.count()).select_from(Document)).scalar_one()


# --- creator and requester --------------------------------------------------------------

def test_admin_login_is_the_verified_creator_and_requester(client):
    _admin_row(client)
    p = _publish(client, author=None).json()["provenance"]
    assert p["creator"] == {"kind": "user", "id": "1", "label": "Ada Admin", "verified": True}
    assert p["requested_by"] == {"label": "Ada Admin", "user_id": 1, "verified": True}
    assert p["source"] is None and p["version"] == 1
    # Its own name in any case still counts as itself.
    p = _publish(client, author=" ada admin ", html=HTML + "<!--2-->").json()["provenance"]
    assert p["requested_by"]["verified"] is True


def test_a_login_naming_someone_else_is_only_a_supplied_requester(client):
    _admin_row(client)
    p = _publish(client, author="Forrest Parker").json()["provenance"]
    assert p["creator"]["kind"] == "user"
    assert p["requested_by"] == {"label": "Forrest Parker", "user_id": None, "verified": False}


def test_agent_token_is_the_creator_and_its_source_is_only_reported(client):
    with patch.dict(os.environ, AGENT_ENV):
        r = _publish(client, headers=_agent(JARVIS), author="Forrest Parker", provenance=ISSUE)
    assert r.status_code == 201, r.text
    p = r.json()["provenance"]
    assert p["creator"] == {"kind": "agent", "id": "jarvis", "label": "jarvis", "verified": True}
    assert p["requested_by"] == {"label": "Forrest Parker", "user_id": None, "verified": False}
    assert p["source"] == {"system": "paperclip", "system_label": "Paperclip", "verified": False,
                           "record_type": "issue", "record_id": ISSUE["source_record_id"],
                           "record_label": "ACC-111", "run_id": "run-7d1f0c2e"}


def test_internal_service_token_is_a_service_writer_never_an_agent(client):
    with patch.dict(os.environ, AGENT_ENV):
        r = _publish(client, headers=SVC, author="Forrest Parker")
    doc = r.json()
    assert doc["co_author"] is None
    assert doc["provenance"]["creator"] == {"kind": "service", "id": "internal-token",
                                            "label": "Internal service token", "verified": True}


# --- forged claims ------------------------------------------------------------------------

def test_forged_identity_fields_in_the_body_are_ignored(client):
    forged = {"creator_kind": "user", "creator_ref": "1", "requested_by_user_id": 1,
              "created_by_user_id": 1, "co_author": "tars", "source_verified": True}
    with patch.dict(os.environ, AGENT_ENV):
        r = _publish(client, headers=_agent(JARVIS), author="Ada Admin", **forged)
    p = r.json()["provenance"]
    assert p["creator"]["kind"] == "agent" and p["creator"]["id"] == "jarvis"
    assert p["requested_by"] == {"label": "Ada Admin", "user_id": None, "verified": False}
    assert p["source"] is None


def test_provenance_object_refuses_verification_company_and_creator_keys(client):
    with patch.dict(os.environ, AGENT_ENV):
        for extra in ({"verified": True}, {"company": "acme"}, {"creator": "forrest"},
                      {"requested_by_user_id": 1}):
            r = _publish(client, headers=_agent(JARVIS), provenance={**ISSUE, **extra})
            assert r.status_code == 422, (extra, r.text)
    assert _doc_count(client) == 0


def test_source_fields_are_validated_and_errors_never_echo_the_value(client):
    bad = [{"source_system": "evil-corp"},
           {**ISSUE, "source_record_label": "https://x.example/?token=abc"},
           {**ISSUE, "source_run_id": "run 1"},
           {**ISSUE, "source_record_id": "x" * 101},
           {"source_system": "paperclip", "source_record_id": "abc"}]  # id without a type
    with patch.dict(os.environ, AGENT_ENV):
        for prov in bad:
            r = _publish(client, headers=_agent(JARVIS), provenance=prov)
            assert r.status_code == 400, (prov, r.text)
            assert "token=abc" not in r.text and "evil-corp" not in r.text
    assert _doc_count(client) == 0


def test_one_agent_through_different_channels_is_not_one_source(client):
    with patch.dict(os.environ, AGENT_ENV):
        a = _publish(client, headers=_agent(JARVIS), provenance=ISSUE).json()
        b = _publish(client, headers=_agent(JARVIS), html=HTML + "<!--slack-->",
                     provenance={"source_system": "slack", "source_run_id": "1728.0001"}).json()
        c = _publish(client, headers=_agent(JARVIS), html=HTML + "<!--bare-->").json()
    assert a["provenance"]["source"]["system"] == "paperclip"
    assert b["provenance"]["source"]["system"] == "slack"
    assert c["provenance"]["source"] is None  # a Jarvis token alone implies no channel


# --- revisions and edits ------------------------------------------------------------------

def test_each_revision_keeps_its_own_provenance_and_patches_do_not_rewrite_it(client):
    with patch.dict(os.environ, AGENT_ENV):
        r1 = _publish(client, headers=_agent(JARVIS), author="Forrest Parker", provenance=ISSUE,
                      activate=False).json()
        # Identical bytes from another agent and another source: no new row, nothing rewritten.
        same = _publish(client, headers=_agent(TARS), code=r1["code"], activate=False,
                        provenance={"source_system": "slack"})
        assert same.status_code == 200 and same.json()["provenance"] == r1["provenance"]
    _admin_row(client)
    r2 = _publish(client, code=r1["code"], html=HTML + "<!--r2-->", author=None, activate=False).json()
    assert r2["supersedes_id"] == r1["id"]
    assert r2["provenance"]["creator"]["label"] == "Ada Admin"
    assert r2["provenance"]["source"] is None
    patched = client.patch(f"/api/documents/{r1['id']}",
                           json={"title": "Renamed", "updated_by": "Someone Else"}).json()
    assert patched["title"] == "Renamed" and patched["provenance"] == r1["provenance"]
    revs = {r["revision"]: r["provenance"] for r in _detail(client, r2["id"])["revisions"]}
    assert revs[1] == r1["provenance"] and revs[2]["creator"]["kind"] == "user"


def test_an_in_place_draft_edit_says_who_rewrote_the_bytes(client):
    from main import app
    from documents.routes import require_document_admin_user
    with patch.dict(os.environ, AGENT_ENV):
        draft = _publish(client, headers=_agent(JARVIS), author="Forrest Parker", activate=False).json()
    _admin_row(client)
    app.dependency_overrides[require_document_admin_user] = lambda: SimpleNamespace(
        id=1, role="admin", email="admin@x.t")
    try:
        r = client.put(f"/api/documents/{draft['id']}/content", json={"html": HTML + "<!--edit-->"})
    finally:
        app.dependency_overrides.pop(require_document_admin_user, None)
    assert r.status_code == 200, r.text
    p = r.json()["provenance"]
    assert p["creator"]["id"] == "jarvis"  # still who created the revision
    assert p["content_edited"]["by"] == "Ada Admin" and p["content_edited"]["at"]


# --- legacy rows and visibility -----------------------------------------------------------

def test_rows_from_before_provenance_are_never_read_as_verified(client):
    from documents.models import Document
    with patch.dict(os.environ, AGENT_ENV):
        doc = _publish(client, headers=SVC, author="Someone", source_session="jarvis via paperclip").json()
    row = client.db.get(Document, doc["id"])
    row.creator_kind = row.creator_ref = None
    client.db.commit()
    p = _detail(client, doc["id"])["provenance"]
    # Nothing is parsed out of source_session, and a supplied author stays supplied.
    assert p["creator"] == {"kind": "unknown", "id": None,
                            "label": "unknown (recorded before provenance)", "verified": False}
    assert p["requested_by"]["verified"] is False and p["source"] is None
    row.co_author = "jarvis"  # co_author was only ever set from an agent token
    client.db.commit()
    assert _detail(client, doc["id"])["provenance"]["creator"]["kind"] == "agent"


def test_a_hidden_documents_provenance_is_not_readable(client):
    _restricted_world(client)
    _read_as(client, 42)  # outsider
    listed = client.get("/api/documents").json()
    assert all(i["space_slug"] != "leadership" for i in listed["items"])
    hidden_id = 1
    r = client.get(f"/api/documents/{hidden_id}")
    assert r.status_code == 404 and "provenance" not in r.text


def test_ai_review_is_a_verified_in_process_origin(client):
    from customer_review import document
    from test_customer_review_document import REVIEW
    _admin_row(client)
    doc_id, _ = document.publish(client.db, review=REVIEW, customer_key="wc:1", customer_name="Acme",
                                 author="Ada Admin", run_id=17, model="m", lookups=1, cost_usd=0.1,
                                 metric_cards=[], code=None, requested_by_user_id=1)
    p = _detail(client, doc_id)["provenance"]
    assert p["creator"] == {"kind": "service", "id": "ai-review", "label": "AccuMk1 AI review",
                            "verified": True}
    assert p["requested_by"] == {"label": "Ada Admin", "user_id": 1, "verified": True}
    assert p["source"]["system"] == "accumk1" and p["source"]["verified"] is True
    assert (p["source"]["record_type"], p["source"]["record_id"]) == ("ai_review_run", "17")
