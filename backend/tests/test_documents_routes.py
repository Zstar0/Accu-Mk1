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

# Carries the theme marker so the server leaves the bytes alone (theming has its own tests).
HTML = "<!doctype html><html><head><title>t</title><style>/* accumark-docs v1 */</style></head><body><p>hi</p></body></html>"
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
    service.seed_spaces(shared)
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


def test_a_revision_may_omit_title_over_http(client):
    """The 422 the MCP hit on 2026-09-18 came from the request schema, so the
    proof has to go through the route, not just the service."""
    with patch.dict(os.environ, SVC_ENV):
        first = _publish(client, headers=SVC, title="Waste Disposal", description="d1").json()
        r = client.post("/api/documents", headers=SVC,
                        json={"code": first["code"], "html": HTML + "<!--2-->", "author": "Forrest"})
        assert r.status_code == 201, r.text
        assert (r.json()["revision"], r.json()["title"], r.json()["description"]) == (2, "Waste Disposal", "d1")
        # a NEW document without a title is still refused
        r = client.post("/api/documents", headers=SVC, json={"html": HTML + "<!--3-->", "category": "ART"})
        assert r.status_code == 400 and "title is required" in r.text


# --- spaces: agent allow-list parsing (spec 2026-10-06 section 7.1) ----------------------

def test_agent_tokens_third_segment():
    """Review Focus 4: the optional third segment parses into a slug set; absent = general;
    an unknown slug still parses (it is only a string here)."""
    from documents.routes import AgentWriter, _agent_tokens, _match_agent
    tok_a, tok_b, tok_c = "a" * 40, "b" * 40, "c" * 40
    env = {"MK1_DOCUMENT_AGENT_TOKENS":
           f"jarvis:{tok_a}:general+analytical, tars:{tok_b}, codex:{tok_c}:not-yet-a-space"}
    with patch.dict(os.environ, env):
        parsed = _agent_tokens()
        assert parsed["jarvis"] == (tok_a, frozenset({"general", "analytical"}))
        assert parsed["tars"] == (tok_b, frozenset({"general"}))
        assert parsed["codex"] == (tok_c, frozenset({"not-yet-a-space"}))
        who = _match_agent(tok_a)
        assert who == AgentWriter("jarvis", frozenset({"general", "analytical"}))
        assert _match_agent("x" * 40) is None
    with patch.dict(os.environ, {"MK1_DOCUMENT_AGENT_TOKENS": f"bad:{tok_a}:Not A Slug"}):
        assert _agent_tokens() == {}  # malformed segment drops the whole entry


def test_doc_out_carries_space_fields(client):
    _as_admin(client)
    d = _publish(client).json()
    assert (d["space_slug"], d["space_name"]) == ("general", "General")
    assert d["space_id"] is not None


# --- spaces: route gates (spec 2026-10-06 sections 5, 8.2) --------------------------------

def _restricted_world(client):
    """A restricted space 'leadership' granted to group 'leaders'; user 10 is a member,
    the fixture's default user (42) is an outsider. Returns (space, secret_doc_json)."""
    from documents.models import DocumentSpace, DocumentSpaceGrant
    from groups.models import UserGroup, UserGroupMember
    db = client.db
    g = UserGroup(slug="leaders", name="Leaders")
    sp = DocumentSpace(slug="leadership", name="Leadership", visibility="restricted")
    db.add_all([g, sp])
    db.flush()
    db.add_all([UserGroupMember(group_id=g.id, user_id=10),
                DocumentSpaceGrant(space_id=sp.id, group_id=g.id)])
    db.commit()
    _as_admin(client)
    secret = _publish(client, title="Q4 plan", space="leadership").json()
    assert secret["space_slug"] == "leadership"
    return sp, secret


def _read_as(client, user_id, role="standard"):
    from main import app
    from auth import get_current_user
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=user_id, role=role, email=f"u{user_id}@x.t", is_active=True)


def test_hidden_document_is_404_identical_to_missing_on_every_read(client):
    sp, secret = _restricted_world(client)
    missing = client.get("/api/documents/999999")
    for path in (f"/api/documents/{secret['id']}", f"/api/documents/{secret['id']}/content"):
        r = client.get(path)
        assert r.status_code == 404, path
    assert client.get(f"/api/documents/{secret['id']}").json() == \
        {"detail": f"document {secret['id']} not found"}
    assert missing.json() == {"detail": "document 999999 not found"}
    lst = client.get("/api/documents").json()
    assert all(i["id"] != secret["id"] for i in lst["items"]) and lst["total"] == 0
    assert client.get("/api/documents?q=Q4").json()["total"] == 0
    _read_as(client, 10)
    assert client.get(f"/api/documents/{secret['id']}").status_code == 200
    assert client.get("/api/documents").json()["total"] == 1
    _read_as(client, 1, "admin")
    assert client.get(f"/api/documents/{secret['id']}/content").status_code == 200


def test_list_for_hidden_space_is_empty(client):
    """Review Focus 5: a direct space filter the caller cannot see is an empty list, not an error."""
    sp, secret = _restricted_world(client)
    r = client.get(f"/api/documents?space_id={sp.id}")
    assert r.status_code == 200 and r.json()["total"] == 0 and r.json()["items"] == []
    assert client.get("/api/documents?space_id=424242").json()["total"] == 0


def test_writes_on_a_hidden_document_are_404(client):
    """A standard member of nothing cannot even learn the id exists through a write."""
    sp, secret = _restricted_world(client)
    from main import app
    from documents.routes import require_document_writer
    # writer = a non-admin "admin" override would be wrong; use the internal token path
    # with a reader that cannot see the doc: the gate runs on the READ identity for
    # bearer writers, so simulate an admin bearer that IS allowed, then an agent token
    # whose allow-list excludes the space.
    app.dependency_overrides.pop(require_document_writer, None)
    with patch.dict(os.environ, {"MK1_DOCUMENT_AGENT_TOKENS": "bot:" + "b" * 40}):
        h = {"X-Service-Token": "b" * 40}
        assert client.post(f"/api/documents/{secret['id']}/retire", headers=h).status_code == 404
        assert client.patch(f"/api/documents/{secret['id']}", json={"title": "x"}, headers=h).status_code == 404
        r = client.post("/api/documents", json={"code": secret["code"], "html": HTML + "<!--2-->",
                                                "category": "ART"}, headers=h)
        assert r.status_code == 404


def test_agent_write_outside_allowlist(client):
    """Review Focus 4: a new document into a space not on the list is 400 naming only the slug."""
    from main import app
    from documents.routes import require_document_writer
    app.dependency_overrides.pop(require_document_writer, None)
    with patch.dict(os.environ, {"MK1_DOCUMENT_AGENT_TOKENS": "bot:" + "b" * 40 + ":general"}):
        h = {"X-Service-Token": "b" * 40}
        from documents.models import DocumentSpace
        client.db.add(DocumentSpace(slug="accounting", name="Accounting", visibility="restricted"))
        client.db.commit()
        r = client.post("/api/documents", json={"title": "Ledger", "html": HTML, "category": "ART",
                                                "author": "F", "space": "accounting"}, headers=h)
        assert r.status_code == 400
        assert r.json()["detail"] == "space 'accounting' is not allowed for this agent"
        ok = client.post("/api/documents", json={"title": "Note", "html": HTML, "category": "ART",
                                                 "author": "F"}, headers=h)
        assert ok.status_code == 201 and ok.json()["space_slug"] == "general"


def test_admin_moves_a_code_and_agents_cannot(client):
    sp, secret = _restricted_world(client)
    from documents.models import DocumentSpace
    lab = DocumentSpace(slug="lab", name="Lab")
    client.db.add(lab)
    client.db.commit()
    _read_as(client, 1, "admin")
    _as_admin(client)
    # a second revision so the move has to carry two rows
    client.post("/api/documents", json={"code": secret["code"], "html": HTML + "<!--2-->", "category": "ART"})
    r = client.patch(f"/api/documents/{secret['id']}", json={"space_id": lab.id})
    assert r.status_code == 200 and r.json()["space_slug"] == "lab"
    detail = client.get(f"/api/documents/{secret['id']}").json()
    assert {rev["space_slug"] for rev in detail["revisions"]} == {"lab"}
    from main import app
    from documents.routes import require_document_writer
    app.dependency_overrides.pop(require_document_writer, None)
    with patch.dict(os.environ, {"MK1_DOCUMENT_AGENT_TOKENS": "bot:" + "b" * 40 + ":lab"}):
        r = client.patch(f"/api/documents/{secret['id']}", json={"space_id": sp.id},
                         headers={"X-Service-Token": "b" * 40})
        assert r.status_code == 403


def test_publish_into_space_by_slug_and_id(client):
    _as_admin(client)
    from documents.models import DocumentSpace
    lab = DocumentSpace(slug="lab", name="Lab")
    client.db.add(lab)
    client.db.commit()
    assert _publish(client, space="lab").json()["space_slug"] == "lab"
    assert _publish(client, html=HTML + "<!--x-->", space_id=lab.id).json()["space_slug"] == "lab"
    assert _publish(client, html=HTML + "<!--y-->", space="nope").status_code == 404
