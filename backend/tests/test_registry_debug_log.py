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


# ── v1.7.1: UTC-offset serialization + whitelist-gated sync glyph ─────────


def test_timestamps_carry_utc_offset(client, db):
    """Naive-UTC DB timestamps must serialize with an explicit +00:00 so the
    FE's `new Date()` renders true local time instead of raw UTC digits."""
    row = _seed_sample(db, status="sample_received")
    db.add(LimsSampleTransition(
        lims_sample_pk=row.id, verb="receive", from_status="sample_due",
        to_status="sample_received", source="mk1",
        occurred_at=datetime(2026, 7, 27, 18, 39, 24)))
    db.add(LimsWorkflowShadowEvaluation(
        lims_sample_pk=row.id, evaluated_at=datetime(2026, 7, 28, 4, 19, 48),
        trigger="seed", verb=None, from_status=None,
        to_status="sample_received", outcome="seeded", requirements_met=None,
        outcomes=[]))
    db.commit()
    out = client.get(f"/debug/sample-registry/{TEST_SAMPLE_ID}/log").json()
    assert out["transitions"]["rows"][0]["occurred_at"].endswith("+00:00")
    assert out["trajectory"]["rows"][0]["evaluated_at"].endswith("+00:00")
    shadow = main._build_shadow_block(db, row)
    assert shadow["latest"]["evaluated_at"].endswith("+00:00")


def test_log_in_sync_ignores_is_vocab_rows(client, db):
    """BW-0066 class: a newest `worksheet_assigned -> analyzing` row (IS
    order-progress vocab, deliberately whitelisted OUT of lims_samples.status
    by heal_sample_status) must not trip the log-vs-status glyph. The sync
    check compares against the newest row whose to_status is real sample
    review-state vocabulary; IS-vocab rows stay visible in the list."""
    row = _seed_sample(db, status="sample_received")
    db.add(LimsSampleTransition(
        lims_sample_pk=row.id, verb="receive", from_status="sample_due",
        to_status="sample_received", source="mk1",
        occurred_at=datetime(2026, 7, 27, 18, 39, 24)))
    db.add(LimsSampleTransition(
        lims_sample_pk=row.id, verb="worksheet_assigned", from_status=None,
        to_status="analyzing", source="senaite",
        occurred_at=datetime(2026, 7, 27, 19, 26, 58)))
    db.commit()
    out = client.get(f"/debug/sample-registry/{TEST_SAMPLE_ID}/log").json()
    tail = out["transitions"]
    assert [r["to_status"] for r in tail["rows"]] == [
        "analyzing", "sample_received"]           # row stays visible, newest first
    assert tail["latest_to_status"] == "sample_received"
    assert tail["log_in_sync"] is True            # was False before the gate


def test_log_in_sync_none_when_no_review_state_rows(client, db):
    """Only IS-vocab rows logged -> no verdict (None), not a false alarm."""
    row = _seed_sample(db, status="sample_received")
    db.add(LimsSampleTransition(
        lims_sample_pk=row.id, verb="worksheet_assigned", from_status=None,
        to_status="analyzing", source="senaite",
        occurred_at=datetime(2026, 7, 27, 19, 26, 58)))
    db.commit()
    out = client.get(f"/debug/sample-registry/{TEST_SAMPLE_ID}/log").json()
    assert out["transitions"]["latest_to_status"] is None
    assert out["transitions"]["log_in_sync"] is None
