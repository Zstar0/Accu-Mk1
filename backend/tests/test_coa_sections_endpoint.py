"""S2S coa-sections endpoint + fail-closed attach semantics (spec 2, Task 4).

GET /samples/{sample_id}/coa-sections is consumed server-to-server by
integration-service on the additional-COA path (Task 9). Unlike
/variance-payload (best-effort overlay), this endpoint is FAIL-CLOSED: any
assembly failure from build_native_sections is a 502, and the caller must not
generate a certificate. 404 = sample unknown to Mk1.

ACCUMK1_INTERNAL_SERVICE_TOKEN isn't reliably present in the ambient test
environment — test_e2e_peptide_request.py sets it via a bare (uncleaned)
os.environ.setdefault at module import time, which leaks into later-sorted
modules in a full-suite run but is absent when this file runs alone (see
test_registry_signal.py's docstring for the same gap against
test_variance_payload_endpoint.py). Setting it explicitly per-test via
patch.dict keeps this file deterministic regardless of run order.

Fixture idiom copied from test_native_promote.py's `client`/`db_session`
(StaticPool in-memory SQLite + get_db override — sync route handlers run in a
TestClient worker thread, so a plain sqlite3 connection would raise "objects
created in a different thread").

Endpoint import is local (matches the ambient main.py convention: every
neighboring S2S handler — get_sample_variance_payload, etc. — imports its
builder module inside the function body, not at module top). Patch target is
therefore coa.native_sections.build_native_sections, not main.build_native_sections
(patch where the name is looked up).
"""
import os
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from main import app
from database import get_db, Base
from coa.native_sections import NativeSectionsError

SVC_TOKEN = "test-internal-token"
SVC_TOKEN_HEADER = {"X-Service-Token": SVC_TOKEN}


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()


@pytest.fixture
def client(db_session):
    def _override_get_db():
        yield db_session

    prev_db = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = _override_get_db
    tc = TestClient(app)
    yield tc
    if prev_db is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev_db


def test_coa_sections_endpoint_requires_token(client, db_session):
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.get("/samples/P-1/coa-sections")
    assert r.status_code == 401


def test_coa_sections_endpoint_404_unknown_sample(client, db_session):
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.get("/samples/NOPE/coa-sections", headers=SVC_TOKEN_HEADER)
    assert r.status_code == 404


def test_coa_sections_endpoint_returns_document(client, db_session):
    from models import LimsSample
    db_session.add(LimsSample(sample_id="P-8001"))
    db_session.commit()
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}), \
         patch("coa.native_sections.build_native_sections",
               return_value={"sample_id": "P-8001", "ordered_profiles": [], "sections": []}):
        r = client.get("/samples/P-8001/coa-sections", headers=SVC_TOKEN_HEADER)
    assert r.status_code == 200
    assert r.json() == {"sample_id": "P-8001", "ordered_profiles": [], "sections": []}


def test_coa_sections_endpoint_502_on_builder_failure(client, db_session):
    from models import LimsSample
    db_session.add(LimsSample(sample_id="P-8002"))
    db_session.commit()
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}), \
         patch("coa.native_sections.build_native_sections",
               side_effect=NativeSectionsError("order lookup failed")):
        r = client.get("/samples/P-8002/coa-sections", headers=SVC_TOKEN_HEADER)
    assert r.status_code == 502
    assert "order lookup failed" in r.json()["detail"]
