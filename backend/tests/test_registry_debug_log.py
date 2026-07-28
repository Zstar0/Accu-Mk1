"""Registry-inspect /log endpoint: full transition + shadow-trajectory
histories (2026-07-27 parity-convergence spec). Live-dev-DB idiom from
test_registry_debug_transitions.py."""
from __future__ import annotations

from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

import main
from auth import require_admin
from database import SessionLocal
from models import LimsSample, LimsSampleTransition, LimsWorkflowShadowEvaluation

TEST_SAMPLE_ID = "TEST-RDLOG-PARENT"


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def client():
    prev = dict(main.app.dependency_overrides)
    main.app.dependency_overrides[require_admin] = (
        lambda: SimpleNamespace(id=1, role="admin", email="admin@test"))
    tc = TestClient(main.app)
    yield tc
    main.app.dependency_overrides.clear()
    main.app.dependency_overrides.update(prev)


@pytest.fixture(autouse=True)
def cleanup(db):
    def _wipe():
        pk = db.execute(
            LimsSample.__table__.select().where(
                LimsSample.sample_id == TEST_SAMPLE_ID)
        ).first()
        if pk is not None:
            db.execute(delete(LimsWorkflowShadowEvaluation).where(
                LimsWorkflowShadowEvaluation.lims_sample_pk == pk.id))
            db.execute(delete(LimsSampleTransition).where(
                LimsSampleTransition.lims_sample_pk == pk.id))
            db.execute(delete(LimsSample).where(LimsSample.id == pk.id))
            db.commit()
    _wipe()
    yield
    _wipe()


def _seed_sample(db, status="verified") -> LimsSample:
    row = LimsSample(sample_id=TEST_SAMPLE_ID, status=status,
                     external_lims_system="senaite")
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def test_log_returns_all_transitions_newest_first(client, db):
    row = _seed_sample(db)
    t0 = datetime(2026, 7, 1, 12, 0, 0)
    for i in range(7):  # > the overview's limit of 5
        db.add(LimsSampleTransition(
            lims_sample_pk=row.id, verb=f"v{i}", from_status="a",
            to_status="b", source="mk1", occurred_at=t0 + timedelta(hours=i)))
    db.commit()
    out = client.get(f"/debug/sample-registry/{TEST_SAMPLE_ID}/log").json()
    assert out["exists"] is True
    assert len(out["transitions"]["rows"]) == 7
    assert [r["verb"] for r in out["transitions"]["rows"]] == [
        "v6", "v5", "v4", "v3", "v2", "v1", "v0"]
    assert out["transitions"]["error"] is None


def test_log_trajectory_full_outcomes_met_and_unmet(client, db):
    row = _seed_sample(db)
    db.add(LimsWorkflowShadowEvaluation(
        lims_sample_pk=row.id, evaluated_at=datetime(2026, 7, 2, 8, 0),
        trigger="receive", verb="receive", from_status="sample_due",
        to_status="sample_received", outcome="advanced", requirements_met=True,
        outcomes=[{"kind": "all_analyses_in_state", "value": "verified",
                   "met": True, "detail": None}]))
    db.add(LimsWorkflowShadowEvaluation(
        lims_sample_pk=row.id, evaluated_at=datetime(2026, 7, 2, 9, 0),
        trigger="publish", verb="publish", from_status="sample_received",
        to_status=None, outcome="requirements_unmet", requirements_met=False,
        outcomes=[{"kind": "coa_published", "value": None,
                   "met": False, "detail": "no attestation"}]))
    db.commit()
    out = client.get(f"/debug/sample-registry/{TEST_SAMPLE_ID}/log").json()
    rows = out["trajectory"]["rows"]
    assert [r["trigger"] for r in rows] == ["publish", "receive"]  # newest first
    assert rows[1]["outcomes"][0]["met"] is True   # met rows included
    assert rows[0]["outcomes"][0]["met"] is False
    assert rows[0]["requirements_met"] is False
    assert out["trajectory"]["error"] is None


def test_log_unknown_sample_exists_false(client):
    out = client.get("/debug/sample-registry/TEST-RDLOG-NOPE/log").json()
    assert out["exists"] is False
    assert out["transitions"]["rows"] == []
    assert out["trajectory"]["rows"] == []


def test_log_admin_gate(db):
    tc = TestClient(main.app)  # no require_admin override
    assert tc.get(
        f"/debug/sample-registry/{TEST_SAMPLE_ID}/log").status_code in (401, 403)


def test_trajectory_query_exception_returns_error_surface(db):
    """Independent-failure posture: a DB error inside the trajectory block
    surfaces as trajectory.error, never an exception. Tightly-scoped patch
    (test_registry_debug_transitions.py idiom) so cleanup runs unpatched."""
    from unittest.mock import patch
    row = _seed_sample(db)
    with patch.object(db, "execute", side_effect=RuntimeError("boom")):
        out = main._build_shadow_trajectory(db, row)
    assert out["rows"] == [] and "boom" in out["error"]


def test_overview_transitions_still_capped_at_5(client, db):
    """The limit param must default to today's behavior on the overview route."""
    row = _seed_sample(db)
    t0 = datetime(2026, 7, 1, 12, 0, 0)
    for i in range(7):
        db.add(LimsSampleTransition(
            lims_sample_pk=row.id, verb=f"v{i}", from_status="a",
            to_status="b", source="mk1", occurred_at=t0 + timedelta(hours=i)))
    db.commit()
    tail = main._build_sample_transitions(db, row)
    assert len(tail["rows"]) == 5
