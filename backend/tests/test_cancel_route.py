"""Route-level tests for POST /api/samples/{sample_id}/cancel.

route_client fixture copied from tests/test_analysis_service_routes.py (it is
a local fixture there, not in conftest.py).
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from main import app
from auth import get_current_user
from database import get_db, Base
from models import (
    LimsSample, LimsSubSampleEvent, LimsWorkflowShadowEvaluation,
    LimsWorkflowState, LimsWorkflowTransition, Settings,
)


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


def _prep(db, authority="mk1", status="sample_received", code=None):
    from workflow.catalog import clear_sample_state_cache
    from workflow.seeds import seed_workflow_catalog
    clear_sample_state_cache()
    seed_workflow_catalog(db)
    db.add(Settings(key="registry_read_source", value=json.dumps({"sample_status": authority})))
    row = LimsSample(sample_id="P-CX-1", status=status, native_status=status,
                     external_lims_uid="U-CX-1", verification_code=code)
    db.add(row)
    db.commit()
    return row


def test_dry_run_previews_without_writing(route_client):
    db = route_client._test_session
    row = _prep(db, status="published", code="ABCD-EFGH")
    r = route_client.post("/api/samples/P-CX-1/cancel", json={"reason": "customer asked", "dry_run": True})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["dry_run"] is True and body["published_coa_still_live"] is True
    assert body["from_status"] == "published"
    db.expire_all()
    assert row.status == "published"


def test_requires_confirm(route_client):
    db = route_client._test_session
    _prep(db)
    r = route_client.post("/api/samples/P-CX-1/cancel", json={"reason": "customer asked"})
    assert r.status_code == 412
    assert "cancelled_rows" in r.json()["detail"]


def test_cancel_writes_status_event_and_tees(route_client):
    db = route_client._test_session
    row = _prep(db)
    with patch("workflow.cancel_routes.SessionLocal", lambda: sessionmaker(bind=db.get_bind())()), \
         patch("workflow.senaite_tee.tee_now", return_value="done") as tn:
        r = route_client.post("/api/samples/P-CX-1/cancel",
                              json={"reason": "customer asked", "confirm": True})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "cancelled"
    db.expire_all()
    assert row.status == "cancelled" and row.native_status == "cancelled"
    ev = db.execute(select(LimsSubSampleEvent).where(LimsSubSampleEvent.lims_sample_pk == row.id)).scalar_one()
    assert ev.event == "sample_cancelled" and ev.details["reason"] == "customer asked"
    assert tn.call_count == 1


def test_already_cancelled_is_409(route_client):
    db = route_client._test_session
    _prep(db, status="cancelled")
    r = route_client.post("/api/samples/P-CX-1/cancel", json={"reason": "again", "confirm": True})
    assert r.status_code == 409


def test_short_reason_is_422(route_client):
    db = route_client._test_session
    _prep(db)
    r = route_client.post("/api/samples/P-CX-1/cancel", json={"reason": "no", "confirm": True})
    assert r.status_code == 422


def test_senaite_mode_moves_native_only(route_client):
    db = route_client._test_session
    row = _prep(db, authority="senaite")
    with patch("workflow.cancel_routes.SessionLocal", lambda: sessionmaker(bind=db.get_bind())()), \
         patch("workflow.senaite_tee.tee_now", return_value="done"):
        r = route_client.post("/api/samples/P-CX-1/cancel",
                              json={"reason": "customer asked", "confirm": True})
    assert r.status_code == 200
    # Response `status` must report the engine's view (native_status), not
    # the SENAITE-mirrored column, which stays "sample_received" until the
    # tee lands (ruling 3).
    assert r.json()["status"] == "cancelled"
    db.expire_all()
    assert row.native_status == "cancelled" and row.status == "sample_received"


def _seeded_cancel_edge(db):
    return db.execute(
        select(LimsWorkflowTransition)
        .join(LimsWorkflowState, LimsWorkflowTransition.from_state_id == LimsWorkflowState.id)
        .where(LimsWorkflowTransition.entity_scope == "sample",
               LimsWorkflowTransition.verb == "cancel",
               LimsWorkflowState.slug == "sample_received")
    ).scalars().one()


def test_no_edge_is_409_and_records_refusal(route_client):
    db = route_client._test_session
    row = _prep(db)
    edge = _seeded_cancel_edge(db)
    edge.is_active = False
    db.commit()
    r = route_client.post("/api/samples/P-CX-1/cancel",
                          json={"reason": "customer asked", "confirm": True})
    assert r.status_code == 409
    db.expire_all()
    # The _find_edge pre-check raises 409 before execute_verb ever runs, so
    # no LimsWorkflowShadowEvaluation row is written for this path — assert
    # the sample stays armed at its prior native_status/status instead.
    evals = db.execute(
        select(LimsWorkflowShadowEvaluation).where(
            LimsWorkflowShadowEvaluation.lims_sample_pk == row.id,
            LimsWorkflowShadowEvaluation.verb == "cancel",
        )
    ).scalars().all()
    assert evals == []
    assert row.native_status == "sample_received"
    assert row.status == "sample_received"


def test_requirements_unmet_is_412_and_persists_refusal(route_client):
    db = route_client._test_session
    row = _prep(db)
    edge = _seeded_cancel_edge(db)
    edge.requirements = [{"kind": "field_present", "value": "client_sample_id", "note": "test"}]
    db.commit()
    r = route_client.post("/api/samples/P-CX-1/cancel",
                          json={"reason": "customer asked", "confirm": True})
    assert r.status_code == 412
    reqs = r.json()["detail"]["requirements"]
    assert reqs and reqs[0]["met"] is False
    db.expire_all()
    evals = db.execute(
        select(LimsWorkflowShadowEvaluation).where(
            LimsWorkflowShadowEvaluation.lims_sample_pk == row.id,
            LimsWorkflowShadowEvaluation.verb == "cancel",
        )
    ).scalars().all()
    assert len(evals) == 1 and evals[0].outcome == "requirements_unmet"

    # Repeat: identical refusal dedups (_record returns None) but must still
    # answer 412 with the latest outcomes, and must not grow the audit trail.
    r2 = route_client.post("/api/samples/P-CX-1/cancel",
                           json={"reason": "customer asked", "confirm": True})
    assert r2.status_code == 412
    assert r2.json()["detail"]["requirements"]
    db.expire_all()
    evals2 = db.execute(
        select(LimsWorkflowShadowEvaluation).where(
            LimsWorkflowShadowEvaluation.lims_sample_pk == row.id,
            LimsWorkflowShadowEvaluation.verb == "cancel",
        )
    ).scalars().all()
    assert len(evals2) == 1


def test_cancel_from_published_keeps_coa_live(route_client):
    db = route_client._test_session
    row = _prep(db, status="published", code="ABCD-EFGH")
    with patch("workflow.cancel_routes.SessionLocal", lambda: sessionmaker(bind=db.get_bind())()), \
         patch("workflow.senaite_tee.tee_now", return_value="senaite_only"):
        r = route_client.post("/api/samples/P-CX-1/cancel",
                              json={"reason": "customer asked", "confirm": True})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "cancelled"
    assert body["from_status"] == "published"
    assert body["published_coa_still_live"] is True
    db.expire_all()
    assert row.native_status == "cancelled"
    ev = db.execute(select(LimsSubSampleEvent).where(LimsSubSampleEvent.lims_sample_pk == row.id)).scalar_one()
    assert ev.details["published_coa"] is True
