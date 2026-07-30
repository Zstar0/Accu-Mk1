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
import asyncio
import logging
import os
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

import main
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


# ── _maybe_emit_regular_coa_child fail-closed attach ──────────────────
# test_regular_coa_child.py's own coverage of this function is broken in this
# venv (pytest-asyncio isn't installed — pytest refuses to even call the
# `async def` test bodies: "async def functions are not natively supported").
# These reuse that file's SimpleNamespace + fake-httpx-client idiom verbatim,
# but drive the coroutine directly via asyncio.run() in a plain `def` test so
# they don't depend on the missing plugin.


class _FakeClient:
    """Mirrors test_regular_coa_child.py's fake httpx client: records any
    POST so a test can assert none fired, or inspect the body that did."""

    def __init__(self, captured):
        self._captured = captured

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, json=None):
        self._captured["url"] = url
        self._captured["body"] = json
        return SimpleNamespace(raise_for_status=lambda: None)


def _patch_coabuilder(monkeypatch, captured):
    monkeypatch.setattr(main, "COA_BUILDER_URL", "http://coabuilder.test")
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda *a, **k: _FakeClient(captured))


def _variance_parent(sample_id):
    """A variance-sample parent stub — customer_remarks fields only, matching
    what _maybe_emit_regular_coa_child actually reads off parent_row."""
    return SimpleNamespace(
        sample_id=sample_id,
        customer_remarks_include=False,
        customer_remarks=None,
    )


def test_regular_child_aborts_before_post_on_native_sections_failure(db_session, monkeypatch, caplog):
    """Fail-closed: if build_native_sections raises, the regular-child's own
    COABuilder POST must never fire — no section-less certificate emitted."""
    monkeypatch.setattr(
        "coa.variance_series.build_variance_replicates",
        lambda db, parent: {"PEP": [{"vial_sequence": 2}]},  # variance sample
    )
    captured = {}
    _patch_coabuilder(monkeypatch, captured)
    parent = _variance_parent("P-X")
    with patch("coa.native_sections.build_native_sections",
               side_effect=NativeSectionsError("boom-detail")):
        with caplog.at_level(logging.ERROR):
            asyncio.run(main._maybe_emit_regular_coa_child(
                db_session, "P-X", parent, {"generation_id": "GEN-1"}
            ))
    assert captured == {}  # POST never fired
    assert any("boom-detail" in r.message for r in caplog.records)


def test_regular_child_attaches_native_sections_before_post(db_session, monkeypatch):
    """Success path: native_sections is attached to the child body BEFORE the
    COABuilder POST fires, and carries the exact built document."""
    monkeypatch.setattr(
        "coa.variance_series.build_variance_replicates",
        lambda db, parent: {"PEP": [{"vial_sequence": 2}]},  # variance sample
    )
    captured = {}
    _patch_coabuilder(monkeypatch, captured)
    parent = _variance_parent("P-Y")
    doc = {
        "sample_id": "P-Y",
        "ordered_profiles": ["HM"],
        "sections": [{"profile_key": "HM", "title": "Heavy Metals", "rows": []}],
    }
    with patch("coa.native_sections.build_native_sections", return_value=doc):
        asyncio.run(main._maybe_emit_regular_coa_child(
            db_session, "P-Y", parent, {"generation_id": "GEN-2"}
        ))
    assert captured["url"].endswith("/process/P-Y")
    assert captured["body"]["native_sections"] == doc
