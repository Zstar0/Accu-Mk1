"""POST /s2s/lims-samples/shipping — bulk update, per-sample received-lock
(logistics capture Slice A, 2026-08-27).

Fixture idiom copied from test_s2s_catalog_keys.py (itself copied from
test_coa_sections_endpoint.py): StaticPool in-memory SQLite + get_db
override, ACCUMK1_INTERNAL_SERVICE_TOKEN patched in per-test via
patch.dict for run-order determinism. test_registry_signal.py's own S2S
test (test_s2s_endpoint_rejects_missing_token) never touches the DB — it's
rejected before reaching it — so it has no get_db-override example to copy
for this DB-touching endpoint; test_s2s_catalog_keys.py is the closer,
currently-idiomatic analog for an s2s route that both authenticates AND
reads/writes rows.
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
from models import LimsSample

SVC_TOKEN = "test-svc-token"
HDR = {"X-Service-Token": SVC_TOKEN}
URL = "/s2s/lims-samples/shipping"
BODY = {
    "samples": ["P-9200", "P-9201", "P-9299"],
    "shipping_carrier": "FedEx",
    "tracking_number": "999912345678",
    "tracking_url": "https://www.fedex.com/fedextrack/?trknbr=999912345678",
}


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


def test_rejects_without_service_token(client, db_session):
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.post(URL, json=BODY)
    assert r.status_code in (401, 403)


def test_updates_unreceived_locks_received_reports_missing(client, db_session):
    db_session.add(LimsSample(sample_id="P-9200", status="sample_due"))
    db_session.add(LimsSample(sample_id="P-9201", status="sample_received",
                               shipping_carrier="UPS", tracking_number="OLD",
                               tracking_url="https://old/OLD"))
    db_session.commit()
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.post(URL, json=BODY, headers=HDR)
    assert r.status_code == 200
    out = r.json()
    assert out["updated"] == ["P-9200"]
    assert out["locked"] == ["P-9201"]
    assert out["missing"] == ["P-9299"]
    fresh = db_session.query(LimsSample).filter_by(sample_id="P-9200").one()
    assert fresh.shipping_carrier == "FedEx"
    assert fresh.tracking_number == "999912345678"
    locked = db_session.query(LimsSample).filter_by(sample_id="P-9201").one()
    assert locked.tracking_number == "OLD"  # received rows keep arrival tracking


def test_idempotent_resave_same_values(client, db_session):
    db_session.add(LimsSample(sample_id="P-9200", status="sample_due"))
    db_session.commit()
    one = {**BODY, "samples": ["P-9200"]}
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r1 = client.post(URL, json=one, headers=HDR)
        r2 = client.post(URL, json=one, headers=HDR)
    assert r1.status_code == r2.status_code == 200
    assert r2.json()["updated"] == ["P-9200"]


def test_oversize_values_are_truncated_to_column_lengths(client, db_session):
    """No server-side length guard would 500 on Postgres for admin-configured
    values exceeding shipping_carrier VARCHAR(100) / tracking_url VARCHAR(500)
    (SQLite in these tests can't catch that) — the endpoint must slice
    defensively before assignment rather than rely on the DB to enforce it."""
    db_session.add(LimsSample(sample_id="P-9200", status="sample_due"))
    db_session.commit()
    oversize = {
        "samples": ["P-9200"],
        "shipping_carrier": "C" * 150,
        "tracking_number": "T" * 140,
        "tracking_url": "https://example.com/" + ("u" * 500),
    }
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.post(URL, json=oversize, headers=HDR)
    assert r.status_code == 200
    assert r.json()["updated"] == ["P-9200"]
    fresh = db_session.query(LimsSample).filter_by(sample_id="P-9200").one()
    assert fresh.shipping_carrier == "C" * 100
    assert len(fresh.shipping_carrier) == 100
    assert fresh.tracking_number == "T" * 120
    assert len(fresh.tracking_number) == 120
    assert fresh.tracking_url == oversize["tracking_url"][:500]
    assert len(fresh.tracking_url) == 500
