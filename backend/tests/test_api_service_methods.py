"""Service-side reverse read of method_services: GET /analysis-services/{id}/methods
plus the linked_method_count annotation on the list route. Closes the stale
legacy read on the services panel, which rendered the SENAITE-clone `methods`
JSON column (empty forever on native services under R0) instead of the link
table the Covered Services picker writes (FastAPI TestClient + in-memory
SQLite, get_db / get_current_user overridden — same idiom as
tests/test_manage_native_routes.py)."""
from __future__ import annotations

import pytest
from unittest.mock import MagicMock
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

import models  # noqa: F401
from main import app
from auth import get_current_user
from database import get_db, Base
from models import AnalysisService, HplcMethod, method_services


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(db_session):
    app.dependency_overrides[get_db] = lambda: db_session
    user = MagicMock(); user.id = 9; user.role = "admin"; user.email = "t@x"
    app.dependency_overrides[get_current_user] = lambda: user
    yield TestClient(app)
    app.dependency_overrides.clear()


def _svc(db, kw, title=None):
    s = AnalysisService(title=title or kw.title(), keyword=kw, origin="mk1",
                        active=True, variance_capable=False)
    db.add(s)
    db.flush()
    return s


def _method(db, name, *, code=None, technique=None, status="active",
            revision=1, active=True):
    m = HplcMethod(name=name, code=code, technique=technique, status=status,
                   revision=revision, active=active, origin="mk1")
    db.add(m)
    db.flush()
    return m


def _link(db, method, service, *, is_default=False):
    db.execute(method_services.insert().values(
        method_id=method.id, analysis_service_id=service.id, is_default=is_default))


def test_service_methods_lists_links_default_first(client, db_session):
    lead = _svc(db_session, "LEAD-PPM", "Lead")
    mp = _method(db_session, "MP-AES Standard Peptide Method", code="AM-ELEM-001",
                 technique="MP-AES")
    other = _method(db_session, "Alt Digest Method", code="AM-ELEM-002",
                    technique="ICP-MS")
    _link(db_session, other, lead)
    _link(db_session, mp, lead, is_default=True)
    db_session.commit()

    r = client.get(f"/analysis-services/{lead.id}/methods")
    assert r.status_code == 200
    rows = r.json()
    assert [x["method_id"] for x in rows] == [mp.id, other.id]  # default first
    assert rows[0] == {
        "method_id": mp.id, "name": "MP-AES Standard Peptide Method",
        "code": "AM-ELEM-001", "technique": "MP-AES", "revision": 1,
        "status": "active", "is_default": True,
    }
    assert rows[1]["is_default"] is False


def test_service_methods_empty_and_404(client, db_session):
    bare = _svc(db_session, "CADMIUM-PPM", "Cadmium")
    db_session.commit()
    assert client.get(f"/analysis-services/{bare.id}/methods").json() == []
    assert client.get("/analysis-services/999999/methods").status_code == 404


def test_service_methods_keeps_non_active_links_with_status(client, db_session):
    """A link held by a superseded/retired revision still renders — with its
    status — rather than vanishing (the panel badges it; hiding it would
    misread as 'no method covers this service')."""
    hg = _svc(db_session, "MERCURY-PPM", "Mercury")
    old = _method(db_session, "MP-AES Standard Peptide Method", code="AM-ELEM-001",
                  status="superseded", revision=1, active=False)
    _link(db_session, old, hg, is_default=True)
    db_session.commit()

    rows = client.get(f"/analysis-services/{hg.id}/methods").json()
    assert len(rows) == 1
    assert rows[0]["status"] == "superseded"
    assert rows[0]["is_default"] is True


def test_list_route_annotates_linked_method_count(client, db_session):
    lead = _svc(db_session, "LEAD-PPM", "Lead")
    bare = _svc(db_session, "ARSENIC-PPM", "Arsenic")
    m1 = _method(db_session, "MP-AES Standard Peptide Method", code="AM-ELEM-001")
    m2 = _method(db_session, "Alt Digest Method", code="AM-ELEM-002")
    _link(db_session, m1, lead, is_default=True)
    _link(db_session, m2, lead)
    db_session.commit()

    by_id = {s["id"]: s for s in client.get("/analysis-services").json()}
    assert by_id[lead.id]["linked_method_count"] == 2
    assert by_id[bare.id]["linked_method_count"] == 0
