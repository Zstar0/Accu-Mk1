"""Admin registry-debug endpoint: gate, non-mutation, linkage, errors."""
import pytest
from datetime import datetime
from unittest.mock import patch
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from database import Base, get_db
from models import LimsSample
import main
from auth import require_admin, get_current_user


@pytest.fixture
def client():
    # StaticPool + check_same_thread=False (per test_activity_family_fanout.py
    # convention): plain sqlite:///:memory: defaults to SingletonThreadPool,
    # which binds a fresh in-memory DB per thread. TestClient dispatches the
    # ASGI app on a different thread than this fixture, so the tables created
    # here below would be invisible to the request ("no such table") without
    # a pool shared across threads.
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    def _get_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    main.app.dependency_overrides[get_db] = _get_db
    main.app.dependency_overrides[require_admin] = lambda: {"email": "a@x", "role": "admin"}
    c = TestClient(main.app)
    c._Session = Session
    yield c
    main.app.dependency_overrides.clear()


def _meta(**over):
    m = {"uid": "AR_UID", "ClientID": "c", "getClientTitle": "acme@x.com",
         "ClientSampleID": "CS-1", "review_state": "sample_received"}
    m.update(over)
    return m


def _seed(client, **kw):
    db = client._Session()
    row = LimsSample(sample_id="P-1", external_lims_uid="AR_UID",
                     last_synced_at=datetime(2026, 1, 1), **kw)
    db.add(row)
    db.commit()
    db.close()


def test_requires_admin():
    # No override → real require_admin → unauthenticated request rejected.
    from database import Base as B
    eng = create_engine("sqlite:///:memory:"); B.metadata.create_all(eng)
    c = TestClient(main.app)
    r = c.get("/debug/sample-registry/P-1")
    assert r.status_code in (401, 403)


def test_refresh_requires_admin():
    # No override → real require_admin → unauthenticated request rejected.
    from database import Base as B
    eng = create_engine("sqlite:///:memory:"); B.metadata.create_all(eng)
    c = TestClient(main.app)
    r = c.post("/debug/sample-registry/P-1/refresh")
    assert r.status_code in (401, 403)


def test_missing_row_returns_exists_false(client):
    with patch.object(main.senaite, "fetch_parent_metadata", side_effect=RuntimeError("no AR")):
        r = client.get("/debug/sample-registry/NOPE")
    assert r.status_code == 200
    assert r.json()["load"]["exists"] is False


def test_get_does_not_mutate_last_synced_at(client):
    _seed(client)
    with patch.object(main.senaite, "fetch_parent_metadata", return_value=_meta()), \
         patch.object(main.senaite, "fetch_secondaries", return_value=[]):
        client.get("/debug/sample-registry/P-1")
    db = client._Session()
    row = db.query(LimsSample).filter_by(sample_id="P-1").one()
    assert row.last_synced_at == datetime(2026, 1, 1)   # untouched — the anti-reconcile guarantee
    db.close()


def test_linkage_mismatch_flagged(client):
    _seed(client)   # stored uid = AR_UID
    with patch.object(main.senaite, "fetch_parent_metadata", return_value=_meta(uid="DIFFERENT_UID")), \
         patch.object(main.senaite, "fetch_secondaries", return_value=[]):
        r = client.get("/debug/sample-registry/P-1")
    assert r.json()["linkage"]["status"] == "mismatch"


def test_senaite_error_returns_row_half(client):
    _seed(client)
    with patch.object(main.senaite, "fetch_parent_metadata", side_effect=RuntimeError("senaite down")):
        r = client.get("/debug/sample-registry/P-1")
    body = r.json()
    assert body["load"]["exists"] is True
    assert body["senaite_error"] is not None
    assert body["fields"] == []


def test_origin_inference(client):
    _seed(client, native_id="aP-0001")   # native_id + senaite system → creation-signal
    with patch.object(main.senaite, "fetch_parent_metadata", return_value=_meta()), \
         patch.object(main.senaite, "fetch_secondaries", return_value=[]):
        r = client.get("/debug/sample-registry/P-1")
    assert r.json()["origin"] == "creation-signal"


def test_refresh_mutates_and_rediffs(client):
    _seed(client)   # last_synced_at = 2026-01-01
    fresh = _meta(ClientSampleID="CS-UPDATED")
    with patch.object(main.senaite, "fetch_parent_metadata", return_value=fresh), \
         patch.object(main.senaite, "fetch_secondaries", return_value=[]):
        r = client.post("/debug/sample-registry/P-1/refresh")
    assert r.status_code == 200
    # after a forced refresh the row now matches SENAITE → no drift on that field
    body = r.json()
    csid = next(f for f in body["fields"] if f["field"] == "client_sample_id")
    assert csid["status"] == "agree"
    db = client._Session()
    row = db.query(LimsSample).filter_by(sample_id="P-1").one()
    assert row.last_synced_at != datetime(2026, 1, 1)   # mutated, as intended
    assert row.client_sample_id == "CS-UPDATED"
    db.close()


def test_refresh_missing_row_is_noop_exists_false(client):
    with patch.object(main.senaite, "fetch_parent_metadata", side_effect=RuntimeError("x")):
        r = client.post("/debug/sample-registry/NOPE/refresh")
    assert r.status_code == 200
    assert r.json()["load"]["exists"] is False
