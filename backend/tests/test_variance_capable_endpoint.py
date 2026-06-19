"""Endpoint tests for PATCH /analysis-services/{id}/variance-capable.

Fixtures mirror test_analysis_service_result_type.py exactly.
"""
from __future__ import annotations

import pytest
from unittest.mock import MagicMock, patch
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from main import app
from auth import get_current_user
from database import get_db, Base
from models import AnalysisService


@pytest.fixture
def route_client():
    """TestClient with a single-connection in-memory SQLite engine.

    Uses StaticPool so every session (test thread + ASGI handler thread) shares
    the exact same underlying connection, which keeps in-memory tables visible
    across the boundary.  check_same_thread=False allows the ASGI worker thread
    to use the connection created in the test thread.
    """
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


def test_set_variance_capable_toggles_and_serializes(route_client):
    """PATCH with True flips the flag and round-trips it in the response."""
    db = route_client._test_session
    svc = AnalysisService(title="HPLC Purity", keyword="HPLC-PUR", variance_capable=False)
    db.add(svc)
    db.commit()
    db.refresh(svc)
    assert svc.variance_capable is False

    resp = route_client.patch(
        f"/analysis-services/{svc.id}/variance-capable",
        json={"variance_capable": True},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["variance_capable"] is True

    # Verify DB row was updated
    db.refresh(svc)
    assert svc.variance_capable is True


def test_sync_does_not_clobber_variance_capable(route_client, monkeypatch):
    """Drive the real POST /analysis-services/sync endpoint with httpx.get
    mocked to return an EXISTING service row (so the sync's existing-row
    branch runs) and assert variance_capable survives the sync pass."""
    import main

    db = route_client._test_session
    svc = AnalysisService(
        title="HPLC Purity",
        keyword="HPLC-PUR",
        variance_capable=True,
        senaite_id="senaite-abc-123",
    )
    db.add(svc)
    db.commit()
    db.refresh(svc)
    assert svc.variance_capable is True

    # SENAITE must be "configured" for the endpoint to run its body.
    monkeypatch.setattr(main, "SENAITE_URL", "http://senaite.test")

    # SENAITE search payload for the SAME senaite_id -> hits the existing-row
    # branch, which back-fills category + runs _apply_service_result_type.
    service_payload = {
        "items": [
            {
                "id": "senaite-abc-123",
                "title": "HPLC Purity (renamed in SENAITE)",
                "getKeyword": "HPLC-PUR",
                "Category": "Analytics",
                "ResultType": "numeric",
            }
        ]
    }
    category_payload = {"items": []}

    def _fake_get(url, *args, **kwargs):
        portal_type = (kwargs.get("params") or {}).get("portal_type")
        resp = MagicMock()
        resp.raise_for_status = MagicMock()
        resp.json = MagicMock(
            return_value=category_payload
            if portal_type == "AnalysisCategory"
            else service_payload
        )
        return resp

    with patch("httpx.get", side_effect=_fake_get):
        resp = route_client.post("/analysis-services/sync")

    assert resp.status_code == 200

    # Existing row was touched by the sync (category back-filled) but the
    # Mk1-owned variance_capable flag must be preserved.
    db.refresh(svc)
    assert svc.category == "Analytics"
    assert svc.variance_capable is True


def test_variance_capable_404_when_missing(route_client):
    """PATCH against a nonexistent service returns 404."""
    resp = route_client.patch(
        "/analysis-services/99999/variance-capable",
        json={"variance_capable": True},
    )
    assert resp.status_code == 404
