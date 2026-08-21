"""GET /s2s/catalog/service-keys — the IS catalog-registry feed.

Ships EVERY analysis_profiles.key, active or not, ON PURPOSE (IS
catalog-registry spec 2026-08-03: the registry answers "is this key real?",
never "is this key sellable?" — sale gating is WordPress's job, and
analysis_profiles.active means retired-from-the-bench, with fulfilment of
already-sold orders continuing). A future reader "fixing" this into an
active-only filter turns a bench checkbox into a money-path order rejector.

Fixture idiom copied from test_coa_sections_endpoint.py (StaticPool
in-memory SQLite + get_db override; ACCUMK1_INTERNAL_SERVICE_TOKEN set
per-test via patch.dict for run-order determinism).
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

SVC_TOKEN = "test-internal-token"
SVC_TOKEN_HEADER = {"X-Service-Token": SVC_TOKEN}
URL = "/s2s/catalog/service-keys"


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


def _mk_profile(db, key, *, active=True):
    from models import AnalysisProfile
    db.add(AnalysisProfile(key=key, name=key.title(), is_addon=True, active=active))
    db.flush()


def test_requires_service_token(client, db_session):
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.get(URL)
    assert r.status_code == 401


def test_wrong_token_rejected(client, db_session):
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.get(URL, headers={"X-Service-Token": "nope"})
    assert r.status_code == 401


def test_returns_all_keys_sorted_including_inactive(client, db_session):
    _mk_profile(db_session, "heavy_metals", active=True)
    _mk_profile(db_session, "sterility_usp71", active=False)   # deactivated: MUST still ship
    _mk_profile(db_session, "endotoxin", active=True)
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.get(URL, headers=SVC_TOKEN_HEADER)
    assert r.status_code == 200
    body = r.json()
    assert body["keys"] == ["endotoxin", "heavy_metals", "sterility_usp71"]
    assert body["generated_at"].endswith("Z")


def test_empty_catalog_returns_empty_list(client, db_session):
    # Mk1 reports honestly; the IS side is what treats an empty list as a
    # suspect sync (never-shrink) — that guard lives there, not here.
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.get(URL, headers=SVC_TOKEN_HEADER)
    assert r.status_code == 200
    assert r.json()["keys"] == []
