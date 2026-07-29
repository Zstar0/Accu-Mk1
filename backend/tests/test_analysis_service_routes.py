"""Route-level tests for POST/PATCH/DELETE /analysis-services.

test_analysis_service_crud.py covers validate_new_keyword and
assert_keyword_editable directly. This file covers behavior that only lives
in the route handlers themselves and has no other coverage in the suite:
- DELETE's origin guard (senaite-origin rows are never deletable here)
- DELETE's referenced-row guard (409, deactivate instead)
- PATCH's local_overrides bookkeeping on a senaite-origin row

Fixture mirrors test_variance_capable_endpoint.py.
"""
from __future__ import annotations

import pytest
from unittest.mock import MagicMock
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from main import app
from auth import get_current_user
from database import get_db, Base
from models import AnalysisService, LimsAnalysis, LimsSample


@pytest.fixture
def route_client():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    shared_session = Session()

    def _override_get_db():
        yield shared_session

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    tc = TestClient(app)
    tc._test_session = shared_session
    yield tc
    if prev_db is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev_db
    if prev_user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = prev_user
    shared_session.close()


def test_create_then_delete_native_service(route_client):
    resp = route_client.post(
        "/analysis-services", json={"title": "Lead", "keyword": "HM-PB", "unit": "ppm"}
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["origin"] == "mk1"

    resp = route_client.delete(f"/analysis-services/{body['id']}")
    assert resp.status_code == 204

    db = route_client._test_session
    assert db.get(AnalysisService, body["id"]) is None


def test_delete_senaite_origin_service_rejected(route_client):
    """SENAITE-origin rows are never deletable through this route — only
    Mk1-native rows can be. Deactivate a SENAITE-origin row instead."""
    db = route_client._test_session
    svc = AnalysisService(title="Endo", keyword="ENDO-LAL", origin="senaite", senaite_id="s-1")
    db.add(svc)
    db.commit()

    resp = route_client.delete(f"/analysis-services/{svc.id}")
    assert resp.status_code == 400

    # Row must still exist — the guard rejected before any delete happened.
    assert db.get(AnalysisService, svc.id) is not None


def test_delete_referenced_service_rejected(route_client):
    db = route_client._test_session
    svc = AnalysisService(title="Lead", keyword="HM-PB", origin="mk1")
    parent = LimsSample(sample_id="P-0001")
    db.add_all([svc, parent])
    db.commit()
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id,
                         keyword="HM-PB", title="Lead", review_state="unassigned"))
    db.commit()

    resp = route_client.delete(f"/analysis-services/{svc.id}")
    assert resp.status_code == 409
    assert db.get(AnalysisService, svc.id) is not None


def test_patch_senaite_origin_records_sync_owned_field_in_local_overrides(route_client):
    """PATCHing a sync-owned field (title) on a senaite-origin row must record
    it in local_overrides so the next sync leaves it alone. A non-sync-owned
    field (variance_capable) must NOT be recorded."""
    db = route_client._test_session
    svc = AnalysisService(title="Endo", keyword="ENDO-LAL", origin="senaite", senaite_id="s-1")
    db.add(svc)
    db.commit()

    resp = route_client.patch(
        f"/analysis-services/{svc.id}", json={"title": "Endo (renamed by lab)"}
    )
    assert resp.status_code == 200
    assert resp.json()["local_overrides"] == ["title"]

    resp = route_client.patch(
        f"/analysis-services/{svc.id}", json={"variance_capable": True}
    )
    assert resp.status_code == 200
    assert resp.json()["local_overrides"] == ["title"]
    assert resp.json()["variance_capable"] is True


def test_patch_mk1_origin_does_not_populate_local_overrides(route_client):
    """local_overrides is a SENAITE-sync bookkeeping mechanism; an Mk1-native
    row has no sync to protect against, so it must stay unset."""
    db = route_client._test_session
    svc = AnalysisService(title="Lead", keyword="HM-PB", origin="mk1")
    db.add(svc)
    db.commit()

    resp = route_client.patch(f"/analysis-services/{svc.id}", json={"title": "Lead 2"})
    assert resp.status_code == 200
    assert resp.json()["local_overrides"] is None
