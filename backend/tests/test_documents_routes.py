"""Documents library HTTP surface (spec §5, §9)."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

HTML = "<!doctype html><html><head><title>t</title></head><body><p>hi</p></body></html>"
SVC = {"X-Service-Token": "test-token"}
SVC_ENV = {"ACCUMK1_INTERNAL_SERVICE_TOKEN": "test-token"}


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from main import app
    from auth import get_current_user
    from database import Base, get_db
    import models  # noqa: F401
    import documents.models  # noqa: F401
    from documents import service, storage
    from documents.routes import require_document_writer

    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    shared = sessionmaker(bind=engine)()
    service.seed_categories(shared)
    storage.set_storage_for_tests(storage.InMemoryDocumentStorage())

    def _db():
        yield shared

    keys = (get_db, get_current_user, require_document_writer)
    saved = {k: app.dependency_overrides.get(k) for k in keys}
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=42, role="standard", email="t@x.t")
    tc = TestClient(app)
    tc.db = shared
    yield tc
    for k, v in saved.items():
        if v is None:
            app.dependency_overrides.pop(k, None)
        else:
            app.dependency_overrides[k] = v
    shared.close()


def _as_admin(client):
    from main import app
    from documents.routes import require_document_writer
    app.dependency_overrides[require_document_writer] = lambda: SimpleNamespace(
        id=1, role="admin", email="admin@x.t")


def _publish(client, headers=None, **over):
    body = {"title": "Audit", "html": HTML, "category": "ART", "author": "Claude Code",
            "source_session": "sess-1"}
    body.update(over)
    return client.post("/api/documents", json=body, headers=headers or {})


# --- auth matrix ----------------------------------------------------------------------

def test_reads_require_login(client):
    from main import app
    from auth import get_current_user
    saved = app.dependency_overrides.pop(get_current_user)
    try:
        assert client.get("/api/documents").status_code == 401
        assert client.get("/api/document-categories").status_code == 401
    finally:
        app.dependency_overrides[get_current_user] = saved


def test_standard_user_cannot_write(client):
    assert _publish(client).status_code == 401  # no admin bearer, no service token
    assert client.post("/api/document-categories",
                       json={"name": "X", "code_prefix": "XX"}).status_code == 401


def test_service_token_can_publish(client):
    with patch.dict(os.environ, SVC_ENV):
        assert _publish(client, headers=SVC, category="nope").status_code == 404
        bad = client.post("/api/documents", json={"title": "A", "html": HTML, "category": "ART"},
                          headers={"X-Service-Token": "wrong"})
        assert bad.status_code == 401
        r = client.post("/api/documents", json={"title": "A", "html": HTML, "category": "ART"},
                        headers=SVC)
    assert r.status_code == 201, r.text
    assert r.json()["created_by_user_id"] is None


def test_writer_dependency_unit_matrix(client):
    """The real dependency, called directly (no HTTP): service token, missing
    token, standard bearer (403), admin bearer."""
    from fastapi import HTTPException
    from auth import create_access_token
    from documents.routes import require_document_writer
    from models import User
    db = client.db
    std = User(email="std@x.t", hashed_password="x", role="standard")
    adm = User(email="adm@x.t", hashed_password="x", role="admin")
    db.add_all([std, adm])
    db.commit()
    with patch.dict(os.environ, SVC_ENV):
        assert require_document_writer(x_service_token="test-token", token=None, db=db) is None
        with pytest.raises(HTTPException) as e:
            require_document_writer(x_service_token="wrong", token=None, db=db)
        assert e.value.status_code == 401
    with pytest.raises(HTTPException) as e:
        require_document_writer(x_service_token=None, token=None, db=db)
    assert e.value.status_code == 401
    with pytest.raises(HTTPException) as e:
        require_document_writer(x_service_token=None,
                                token=create_access_token({"sub": str(std.id)}), db=db)
    assert e.value.status_code == 403
    who = require_document_writer(x_service_token=None,
                                  token=create_access_token({"sub": str(adm.id)}), db=db)
    assert who.id == adm.id


def test_http_maps_integrity_error_to_409():
    """A lost (code, revision) unique race is a conflict the caller can retry, not
    an opaque 500."""
    from sqlalchemy.exc import IntegrityError
    from documents.routes import _http
    e = _http(IntegrityError("stmt", {}, Exception("dup")))
    assert e.status_code == 409
    assert "retry" in e.detail


# --- documents ---------------------------------------------------------------------------

def test_publish_read_content_and_list(client):
    _as_admin(client)
    r = _publish(client, description="short desc")
    assert r.status_code == 201, r.text
    d = r.json()
    assert (d["code"], d["revision"], d["status"], d["category_prefix"], d["revision_count"]) == \
        ("ART-0001", 1, "active", "ART", 1)
    assert d["created_by_user_id"] == 1

    c = client.get(f"/api/documents/{d['id']}/content")
    assert c.status_code == 200
    assert c.headers["content-type"].startswith("text/html")
    assert c.headers["content-security-policy"] == "sandbox allow-scripts"
    assert c.headers["x-content-type-options"] == "nosniff"
    assert 'filename="ART-0001-r1.html"' in c.headers["content-disposition"]
    assert c.text == HTML

    lst = client.get("/api/documents").json()
    assert lst["total"] == 1 and lst["items"][0]["id"] == d["id"]
    assert client.get("/api/documents?q=zzz").json()["total"] == 0
    assert client.get("/api/documents?status=retired").json()["total"] == 0
    assert client.get("/api/documents?status=bogus").status_code == 400
    assert client.get("/api/documents?sort=bogus").status_code == 400

    detail = client.get(f"/api/documents/{d['id']}").json()
    assert [r_["revision"] for r_ in detail["revisions"]] == [1]
    assert client.get("/api/documents/9999").status_code == 404


def test_republish_same_code_dedupes_then_revises(client):
    _as_admin(client)
    d1 = _publish(client).json()
    same = _publish(client, code=d1["code"], title="renamed")
    assert same.status_code == 200 and same.json()["id"] == d1["id"]
    assert same.json()["title"] == "renamed"
    d2 = _publish(client, code=d1["code"], html=HTML + "<!--2-->", category=None)
    assert d2.status_code == 201 and d2.json()["revision"] == 2
    assert client.get(f"/api/documents/{d1['id']}").json()["status"] == "retired"


def test_lifecycle_and_patch_routes(client):
    _as_admin(client)
    d = _publish(client, activate=False).json()
    assert d["status"] == "draft"
    assert client.post(f"/api/documents/{d['id']}/retire").status_code == 409
    a = client.post(f"/api/documents/{d['id']}/activate")
    assert a.status_code == 200 and a.json()["status"] == "active"
    assert client.post(f"/api/documents/{d['id']}/activate").status_code == 409
    p = client.patch(f"/api/documents/{d['id']}",
                     json={"title": "New title", "effective_date": "2026-01-02"})
    assert p.status_code == 200 and p.json()["title"] == "New title"
    assert p.json()["effective_date"] == "2026-01-02"
    assert client.patch(f"/api/documents/{d['id']}", json={"title": " "}).status_code == 400
    r = client.post(f"/api/documents/{d['id']}/retire")
    assert r.status_code == 200 and r.json()["status"] == "retired"


def test_publish_validation(client):
    _as_admin(client)
    assert _publish(client, html="not html").status_code == 400
    assert _publish(client, title="").status_code == 400
    assert _publish(client, category=None).status_code == 400
    assert _publish(client, code="SOP-0001").status_code == 400  # prefix mismatch


# --- categories --------------------------------------------------------------------------

def test_categories_crud_and_delete_guard(client):
    _as_admin(client)
    cats = client.get("/api/document-categories").json()
    assert [c["code_prefix"] for c in cats] == ["ART", "SOP"]
    c = client.post("/api/document-categories",
                    json={"name": "Validation", "code_prefix": "val", "description": "d"})
    assert c.status_code == 201 and c.json()["code_prefix"] == "VAL"
    cid = c.json()["id"]
    assert client.post("/api/document-categories",
                       json={"name": "Validation", "code_prefix": "VX"}).status_code == 409
    u = client.put(f"/api/document-categories/{cid}", json={"active": False, "sort_order": 5})
    assert u.status_code == 200 and u.json()["active"] is False
    assert client.get("/api/document-categories?active_only=true").json()[-1]["code_prefix"] == "SOP"
    assert client.delete(f"/api/document-categories/{cid}").status_code == 204
    art = cats[0]["id"]
    _publish(client)
    assert client.delete(f"/api/document-categories/{art}").status_code == 409
    assert client.get("/api/document-categories").json()[0]["document_count"] == 1


# --- per-agent scoped tokens ------------------------------------------------------------
# The internal service token also unlocks /s2s/orders/upsert, /s2s/lims-samples and a dozen
# more. It must never sit on a bot host, so agents get their own documents-only tokens, and
# the token (not the request body) names the agent.

JARVIS = "j" * 40
TARS = "t" * 40
AGENT_ENV = {"MK1_DOCUMENT_AGENT_TOKENS": f"jarvis:{JARVIS}, tars:{TARS}",
             "ACCUMK1_INTERNAL_SERVICE_TOKEN": "test-token"}


def _agent(tok):
    return {"X-Service-Token": tok}


def test_agent_token_publishes_and_the_token_names_the_co_author(client):
    with patch.dict(os.environ, AGENT_ENV):
        r = _publish(client, headers=_agent(JARVIS), author="Forrest Parker")
        assert r.status_code == 201, r.text
        assert r.json()["author"] == "Forrest Parker"
        assert r.json()["co_author"] == "jarvis"
        r2 = _publish(client, headers=_agent(TARS), title="Other", html=HTML + "<!--2-->")
        assert r2.json()["co_author"] == "tars"


def test_the_request_body_cannot_choose_the_co_author(client):
    with patch.dict(os.environ, AGENT_ENV):
        r = _publish(client, headers=_agent(JARVIS), co_author="tars")
        assert r.json()["co_author"] == "jarvis"


def test_internal_token_still_works_and_has_no_co_author(client):
    with patch.dict(os.environ, AGENT_ENV):
        r = _publish(client, headers=SVC)
        assert r.status_code == 201
        assert r.json()["co_author"] is None


def test_agent_token_is_documents_only(client):
    """The whole point: it must open nothing the internal token opens."""
    with patch.dict(os.environ, AGENT_ENV):
        assert client.get("/s2s/catalog/service-keys", headers=_agent(JARVIS)).status_code == 401
        assert client.get("/peptide-requests", headers=_agent(JARVIS)).status_code == 401


def test_agents_cannot_delete_or_manage_categories(client):
    """Handler ruling: bots archive, never delete. Enforced here, not only by
    which tools the MCP happens to register."""
    with patch.dict(os.environ, AGENT_ENV):
        d = _publish(client, headers=_agent(JARVIS), activate=False).json()
        url = f"/api/documents/{d['id']}?code={d['code']}&revision={d['revision']}"
        assert client.delete(url, headers=_agent(JARVIS)).status_code == 403
        assert client.post("/api/document-categories", headers=_agent(JARVIS),
                           json={"name": "X", "code_prefix": "XX"}).status_code == 403
        # ...while archiving is allowed, and the internal token can still delete
        assert client.delete(url, headers=SVC).status_code == 200
        a = _publish(client, headers=_agent(JARVIS), title="Live", html=HTML + "<!--3-->").json()
        assert client.post(f"/api/documents/{a['id']}/retire",
                           headers=_agent(JARVIS)).json()["status"] == "retired"


def test_agent_patch_records_who_and_through_which_agent(client):
    with patch.dict(os.environ, AGENT_ENV):
        d = _publish(client, headers=_agent(JARVIS)).json()
        r = client.patch(f"/api/documents/{d['id']}", headers=_agent(TARS),
                         json={"title": "Renamed", "updated_by": "Forrest Parker"})
        assert r.json()["updated_by"] == "Forrest Parker via tars"
        r = client.patch(f"/api/documents/{d['id']}", headers=_agent(TARS),
                         json={"title": "Again"})
        assert r.json()["updated_by"] == "tars"


@pytest.mark.parametrize("env_value", [
    "jarvis:short",                 # too short to be a real secret
    "JARVIS!:" + "x" * 40,          # bad agent name
    "no-colon-here",
    "",
])
def test_malformed_agent_entries_open_nothing(client, env_value):
    env = {"MK1_DOCUMENT_AGENT_TOKENS": env_value,
           "ACCUMK1_INTERNAL_SERVICE_TOKEN": "test-token"}
    with patch.dict(os.environ, env):
        for tok in ("short", "x" * 40, "no-colon-here"):
            assert _publish(client, headers=_agent(tok)).status_code == 401


def test_unknown_token_is_401_with_agents_configured(client):
    with patch.dict(os.environ, AGENT_ENV):
        assert _publish(client, headers=_agent("z" * 40)).status_code == 401

