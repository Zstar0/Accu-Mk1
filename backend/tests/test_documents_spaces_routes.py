# backend/tests/test_documents_spaces_routes.py
"""Space administration (spec 2026-10-06 section 8.1) and the General guards."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

HTML = ("<!doctype html><html><head><title>t</title><style>/* accumark-docs v1 */</style>"
        "</head><body><p>hi</p></body></html>")


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from main import app
    from auth import get_current_user
    from database import Base, get_db
    import models  # noqa: F401
    import groups.models  # noqa: F401
    import documents.models  # noqa: F401
    from documents import service, storage
    from documents.routes import _space_reader, require_document_writer
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    shared = sessionmaker(bind=engine)()
    service.seed_categories(shared)
    service.seed_spaces(shared)
    storage.set_storage_for_tests(storage.InMemoryDocumentStorage())
    from groups.models import UserGroup
    shared.add_all([UserGroup(slug="leaders", name="Leaders"), UserGroup(slug="dormant", name="D", is_active=False)])
    shared.commit()

    def _db():
        yield shared

    keys = (get_db, get_current_user, require_document_writer, _space_reader)
    saved = {k: app.dependency_overrides.get(k) for k in keys}
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=42, role="standard", email="t@x.t", is_active=True)
    app.dependency_overrides[_space_reader] = lambda: SimpleNamespace(id=42, role="standard", email="t@x.t", is_active=True)
    app.dependency_overrides[require_document_writer] = lambda: SimpleNamespace(id=1, role="admin", email="admin@x.t", is_active=True)
    tc = TestClient(app)
    tc.db = shared
    yield tc
    for k, v in saved.items():
        if v is None:
            app.dependency_overrides.pop(k, None)
        else:
            app.dependency_overrides[k] = v
    shared.close()


def _leaders_id(client):
    from groups.models import UserGroup
    return client.db.query(UserGroup).filter_by(slug="leaders").one().id


def test_list_shows_only_visible_spaces_general_first(client):
    r = client.post("/api/document-spaces", json={"slug": "Accounting", "name": "Accounting",
                                                  "visibility": "restricted", "sort_order": -5})
    assert r.status_code == 201 and r.json()["slug"] == "accounting"
    client.post("/api/document-spaces", json={"slug": "lab", "name": "Lab"})
    rows = client.get("/api/document-spaces").json()
    assert [s["slug"] for s in rows] == ["general", "lab"]  # outsider: restricted absent, General first
    assert all(s["can_write"] is False for s in rows)


def test_create_validation_and_slug_conflict(client):
    assert client.post("/api/document-spaces", json={"slug": "Bad Slug", "name": "x"}).status_code == 400
    assert client.post("/api/document-spaces", json={"slug": "ok", "name": "x", "visibility": "secret"}).status_code == 400
    assert client.post("/api/document-spaces", json={"slug": "ok", "name": "x"}).status_code == 201
    assert client.post("/api/document-spaces", json={"slug": "ok", "name": "y"}).status_code == 409


def test_general_guards(client):
    gid = client.get("/api/document-spaces").json()[0]["id"]
    assert client.put(f"/api/document-spaces/{gid}", json={"visibility": "restricted"}).status_code == 400
    assert client.put(f"/api/document-spaces/{gid}", json={"is_active": False}).status_code == 400
    assert client.delete(f"/api/document-spaces/{gid}").status_code == 400
    assert client.put(f"/api/document-spaces/{gid}", json={"name": "Everyone"}).status_code == 200


def test_update_grants_and_delete_when_empty(client):
    sp = client.post("/api/document-spaces", json={"slug": "leadership", "name": "L", "visibility": "restricted"}).json()
    sid = sp["id"]
    assert client.put(f"/api/document-spaces/{sid}", json={"slug": "other"}).status_code == 422  # unknown field
    g = client.put(f"/api/document-spaces/{sid}/grants", json={"group_ids": [_leaders_id(client)]})
    assert g.status_code == 200 and g.json()["group_ids"] == [_leaders_id(client)]
    assert client.get(f"/api/document-spaces/{sid}/grants").json()["group_ids"] == [_leaders_id(client)]
    from groups.models import UserGroup
    dormant = client.db.query(UserGroup).filter_by(slug="dormant").one().id
    assert client.put(f"/api/document-spaces/{sid}/grants", json={"group_ids": [dormant]}).status_code == 400
    assert client.put(f"/api/document-spaces/{sid}/grants", json={"group_ids": [999]}).status_code == 400
    # a document inside blocks delete
    d = client.post("/api/documents", json={"title": "x", "html": HTML, "category": "ART", "space": "leadership"})
    assert d.status_code == 201
    assert client.delete(f"/api/document-spaces/{sid}").status_code == 409
    client.post(f"/api/documents/{d.json()['id']}/retire")
    assert client.delete(f"/api/document-spaces/{sid}").status_code == 409  # retired still counts as held
    empty = client.post("/api/document-spaces", json={"slug": "temp", "name": "T"}).json()["id"]
    assert client.delete(f"/api/document-spaces/{empty}").status_code == 204


def test_agent_token_cannot_administer_spaces(client):
    from main import app
    from documents.routes import require_document_writer
    app.dependency_overrides.pop(require_document_writer, None)
    with patch.dict(os.environ, {"MK1_DOCUMENT_AGENT_TOKENS": "bot:" + "b" * 40}):
        h = {"X-Service-Token": "b" * 40}
        assert client.post("/api/document-spaces", json={"slug": "x", "name": "x"}, headers=h).status_code == 403


def test_agent_token_lists_its_allowlist(client):
    from main import app
    from auth import get_current_user
    from documents.routes import _space_reader, require_document_writer
    app.dependency_overrides.pop(require_document_writer, None)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(_space_reader, None)
    with patch.dict(os.environ, {"MK1_DOCUMENT_AGENT_TOKENS": "bot:" + "b" * 40 + ":general+lab"}):
        r = client.get("/api/document-spaces", headers={"X-Service-Token": "b" * 40})
        assert r.status_code == 200
        assert [s["slug"] for s in r.json()] == ["general"]  # lab does not exist yet; only real spaces listed
        assert r.json()[0]["can_write"] is True
