"""POST /s2s/orders/upsert — idempotent order upsert from the integration
service (order-entity Task 3, 2026-08-28). Fixture idiom copied from
test_s2s_shipping_update.py: StaticPool in-memory SQLite + get_db override,
ACCUMK1_INTERNAL_SERVICE_TOKEN patched in per-test via patch.dict, auth via
X-Service-Token header against require_internal_service_token.
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
from models import LimsOrder, LimsSample

SVC_TOKEN = "test-svc-token"
HDR = {"X-Service-Token": SVC_TOKEN}
URL = "/s2s/orders/upsert"


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
    body = {"orders": [{
        "wp_order_id": 6344, "order_number": "WP-6344",
        "status": "order-submitted",
        "customer": {"user_id": 3181, "name": "Jane Doe", "email": "j@x.com"},
        "billing": {"city": "Austin", "state": "TX", "country": "US"},
        "shipping": None,
        "wp_created_at": "2026-08-19T23:02:46Z",
        "wp_paid_at": "2026-08-20T00:10:22Z",
        "samples": [],
    }]}
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.post(URL, json=body)
    assert r.status_code in (401, 403)


def test_upsert_insert_then_update(client, db_session):
    body = {"orders": [{
        "wp_order_id": 6344, "order_number": "WP-6344",
        "status": "order-submitted",
        "customer": {"user_id": 3181, "name": "Jane Doe", "email": "j@x.com"},
        "billing": {"city": "Austin", "state": "TX", "country": "US"},
        "shipping": None,
        "wp_created_at": "2026-08-19T23:02:46Z",
        "wp_paid_at": "2026-08-20T00:10:22Z",
        "samples": [],
    }]}
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.post(URL, json=body, headers=HDR)
        assert r.status_code == 200 and r.json()["upserted"] == 1
        body["orders"][0]["status"] = "sample-received"
        r2 = client.post(URL, json=body, headers=HDR)
    assert r2.status_code == 200
    rows = db_session.query(LimsOrder).filter_by(wp_order_id=6344).all()
    assert len(rows) == 1 and rows[0].status == "sample-received"


def test_upsert_stamps_line_items_and_reports_missing(client, db_session):
    db_session.add(LimsSample(sample_id="P-2289", client_order_number="WP-6344"))
    db_session.commit()
    body = {"orders": [{
        "wp_order_id": 6344, "order_number": "WP-6344", "status": None,
        "customer": None, "billing": None, "shipping": None,
        "wp_created_at": None, "wp_paid_at": None,
        "samples": [
            {"senaite_sample_id": "P-2289", "line_item_ids": [13049, 13052]},
            {"senaite_sample_id": "P-9999", "line_item_ids": [1]},
        ],
    }]}
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.post(URL, json=body, headers=HDR)
    assert r.json() == {"upserted": 1, "samples_stamped": 1, "samples_missing": 1}
    row = db_session.query(LimsSample).filter_by(sample_id="P-2289").one()
    assert row.wc_line_item_ids == [13049, 13052]
