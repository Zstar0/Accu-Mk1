"""Task 2: fail-closed SENAITE write-back on promote.

Tests:
  1. Happy path: writeback succeeds → 201, parent row persisted, write-back
     called with correct parent_sample_id / keyword / result / remark.
  2. Write-back raises SenaiteWritebackError → 502, no parent-tier row left,
     source vial still in to_be_verified.
  3. Validation error (wrong-state source) → 400-family, write-back NOT called.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch
from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from auth import get_current_user
from database import Base, get_db
from lims_analyses.senaite_writeback import SenaiteWritebackError
from main import app
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
)


# ─── Shared fixture ───────────────────────────────────────────────────────────


@pytest.fixture
def route_client():
    """In-memory SQLite TestClient.

    Uses StaticPool so the same underlying connection is shared between the
    test thread and the ASGI handler thread — in-memory tables stay visible
    across the boundary.  Snapshot/restore pattern for dependency_overrides
    copied verbatim from test_analysis_service_result_type.py.
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
    app.dependency_overrides[get_current_user] = lambda: MagicMock(
        id=1, email="qa@accumark.test"
    )
    tc = TestClient(app)
    tc._test_session = shared_session
    yield tc
    # Restore — bare pop caused a regression once; always restore the prior value.
    if prev_db is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev_db
    if prev_user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = prev_user
    shared_session.close()


@pytest.fixture
def promote_fixture(route_client):
    """Seed: parent LimsSample + LimsSubSample + to_be_verified LimsAnalysis.

    Returns (db, parent, sub, analysis, promote_payload).
    """
    db = route_client._test_session

    svc = AnalysisService(title="Purity (HPLC)", keyword="PURITY-HPLC")
    db.add(svc)
    db.flush()

    parent = LimsSample(sample_id="P-0001", external_lims_uid="uid-P-0001")
    db.add(parent)
    db.flush()

    sub = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid="uid-P-0001-S01",
        sample_id="P-0001-S01",
        vial_sequence=1,
    )
    db.add(sub)
    db.flush()

    analysis = LimsAnalysis(
        lims_sub_sample_pk=sub.id,
        analysis_service_id=svc.id,
        keyword="PURITY-HPLC",
        title="Purity (HPLC)",
        review_state="to_be_verified",
        result_value="98.55",
    )
    db.add(analysis)
    db.commit()
    db.refresh(analysis)

    payload = {
        "keyword": "PURITY-HPLC",
        "result_value": "98.55",
        "sources": [{"analysis_id": analysis.id, "contribution_kind": "chosen"}],
    }
    return db, parent, sub, analysis, payload


# ─── Test 1: happy path ───────────────────────────────────────────────────────


def test_promote_writeback_success(route_client, promote_fixture):
    """writeback_promotion succeeds → 201; parent row exists; write-back
    was called with correct parent_sample_id, keyword, result, and remark
    containing the vial id and user email."""
    db, parent, sub, analysis, payload = promote_fixture

    calls = []

    def _fake_writeback(parent_sample_id, keyword, result_value, remark):
        calls.append({
            "parent_sample_id": parent_sample_id,
            "keyword": keyword,
            "result_value": result_value,
            "remark": remark,
        })
        return "senaite-uid-fake"

    with patch("lims_analyses.routes.senaite_writeback.writeback_promotion",
               side_effect=_fake_writeback):
        resp = route_client.post("/api/lims-analyses/promote", json=payload)

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["parent"]["review_state"] == "verified"
    assert body["parent"]["lims_sample_pk"] == parent.id

    # Write-back was called exactly once
    assert len(calls) == 1
    call = calls[0]
    assert call["parent_sample_id"] == parent.sample_id       # "P-0001"
    assert call["keyword"] == "PURITY-HPLC"
    assert call["result_value"] == "98.55"
    remark = call["remark"]
    # Remark must mention the source vial and the user email
    assert sub.sample_id in remark                             # "P-0001-S01"
    assert "qa@accumark.test" in remark
    assert date.today().isoformat() in remark

    # Parent-tier row persisted
    parent_row = db.get(LimsAnalysis, body["parent"]["id"])
    assert parent_row is not None
    assert parent_row.lims_sample_pk == parent.id


# ─── Test 2: write-back fails → 502, rollback ─────────────────────────────────


def test_promote_writeback_failure_returns_502_and_rolls_back(
    route_client, promote_fixture
):
    """writeback_promotion raises SenaiteWritebackError → 502; no parent-tier
    row persisted for (parent, keyword); source vial still to_be_verified."""
    db, parent, sub, analysis, payload = promote_fixture

    def _failing_writeback(parent_sample_id, keyword, result_value, remark):
        raise SenaiteWritebackError("SENAITE timed out (test)")

    with patch("lims_analyses.routes.senaite_writeback.writeback_promotion",
               side_effect=_failing_writeback):
        resp = route_client.post("/api/lims-analyses/promote", json=payload)

    assert resp.status_code == 502, resp.text
    assert "SENAITE write-back failed" in resp.json()["detail"]

    # No parent-tier row left in the DB
    parent_rows = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == parent.id,
            LimsAnalysis.keyword == "PURITY-HPLC",
        )
    ).scalars().all()
    assert len(parent_rows) == 0, (
        f"Expected 0 parent-tier rows but found {len(parent_rows)}"
    )

    # Source vial still in to_be_verified (rollback didn't corrupt it)
    db.expire(analysis)
    db.refresh(analysis)
    assert analysis.review_state == "to_be_verified"


# ─── Test 3: validation error → 400-family, write-back not called ─────────────


def test_promote_wrong_state_source_never_calls_writeback(
    route_client, promote_fixture
):
    """Source analysis in 'unassigned' state → BadRequestError → 400; the
    write-back is never invoked because the service raises before we reach it."""
    db, parent, sub, analysis, payload = promote_fixture

    # Force the source into 'unassigned' so service raises BadRequestError
    analysis.review_state = "unassigned"
    db.commit()

    call_count = [0]

    def _should_not_be_called(*args, **kwargs):
        call_count[0] += 1
        return "uid"

    with patch("lims_analyses.routes.senaite_writeback.writeback_promotion",
               side_effect=_should_not_be_called):
        resp = route_client.post("/api/lims-analyses/promote", json=payload)

    assert resp.status_code in (400, 409, 422), resp.text
    assert call_count[0] == 0, "writeback_promotion should NOT have been called"
