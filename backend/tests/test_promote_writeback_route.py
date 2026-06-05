"""Task 2: fail-closed SENAITE write-back on promote.
Task 3: promotions read endpoint + parent activity events.

Tests (Task 2):
  1. Happy path: writeback succeeds → 201, parent row persisted, write-back
     called with correct parent_sample_id / keyword / result / remark.
  2. Write-back raises SenaiteWritebackError → 502, no parent-tier row left,
     source vial still in to_be_verified.
  3. Validation error (wrong-state source) → 400-family, write-back NOT called.

Tests (Task 3):
  4. GET /promotions returns keyword/sources/email for a promoted parent.
  5. GET /promotions?parent_sample_id=unknown → [].
  6. GET /samples/{sample_id}/activity includes analysis_promoted event.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch
from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from contextlib import contextmanager
from unittest.mock import MagicMock as _MagicMock

from auth import get_current_user
from database import Base, get_db
from lims_analyses import service as lims_service
from lims_analyses.senaite_writeback import SenaiteWritebackError
from main import app
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
    User,
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


# ─── Task 3: promotions read endpoint ─────────────────────────────────────────


@pytest.fixture
def promoted_fixture(route_client):
    """Seed a promoted state: parent LimsSample + sub + analysis already
    promoted to a parent-tier row via service.promote_to_parent.

    Returns (db, parent, sub, vial_analysis, parent_analysis, user).
    No write-back is involved — direct service call with commit=True.
    """
    db = route_client._test_session

    svc = AnalysisService(title="Sterility", keyword="STERILITY")
    db.add(svc)
    db.flush()

    # Seed a User so promoted_by_email resolves
    user = User(
        email="promoter@accumark.test",
        hashed_password="x",
        role="standard",
    )
    db.add(user)
    db.flush()

    parent = LimsSample(sample_id="PP-0001", external_lims_uid="uid-PP-0001")
    db.add(parent)
    db.flush()

    sub = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid="uid-PP-0001-S01",
        sample_id="PP-0001-S01",
        vial_sequence=1,
    )
    db.add(sub)
    db.flush()

    vial_analysis = LimsAnalysis(
        lims_sub_sample_pk=sub.id,
        analysis_service_id=svc.id,
        keyword="STERILITY",
        title="Sterility",
        review_state="to_be_verified",
        result_value="Pass",
    )
    db.add(vial_analysis)
    db.commit()
    db.refresh(vial_analysis)

    # Promote via service (commit=True, no SENAITE write-back)
    parent_analysis, _ = lims_service.promote_to_parent(
        db,
        keyword="STERILITY",
        result_value="Pass",
        result_unit=None,
        method_id=None,
        instrument_id=None,
        sources=[{"analysis_id": vial_analysis.id, "contribution_kind": "chosen"}],
        user_id=user.id,
        reason=None,
        commit=True,
    )

    return db, parent, sub, vial_analysis, parent_analysis, user


def test_list_promotions_returns_keyword_sources_email(route_client, promoted_fixture):
    """GET /api/lims-analyses/promotions?parent_sample_id=PP-0001 returns one
    ParentPromotionInfo with the keyword, vial source, and promoter email."""
    db, parent, sub, vial_analysis, parent_analysis, user = promoted_fixture

    resp = route_client.get(
        "/api/lims-analyses/promotions",
        params={"parent_sample_id": parent.sample_id},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert isinstance(body, list)
    assert len(body) == 1

    item = body[0]
    assert item["keyword"] == "STERILITY"
    assert item["parent_analysis_id"] == parent_analysis.id
    assert item["result_value"] == "Pass"
    assert item["promoted_by_email"] == user.email

    sources = item["sources"]
    assert len(sources) == 1
    assert sources[0]["sample_id"] == sub.sample_id
    assert sources[0]["contribution_kind"] == "chosen"


def test_list_promotions_unknown_sample_returns_empty(route_client):
    """GET /promotions?parent_sample_id=DOES-NOT-EXIST → [] (not 404)."""
    resp = route_client.get(
        "/api/lims-analyses/promotions",
        params={"parent_sample_id": "DOES-NOT-EXIST"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == []


def test_activity_includes_analysis_promoted_event(route_client, promoted_fixture):
    """GET /samples/{sample_id}/activity for the parent sample includes an
    analysis_promoted event sourced from lims_analysis_promotions."""
    db, parent, sub, vial_analysis, parent_analysis, user = promoted_fixture

    # Patch out the mk1_db calls (no Postgres in test env)
    fake_cursor = _MagicMock()
    fake_cursor.__enter__ = lambda s: s
    fake_cursor.__exit__ = _MagicMock(return_value=False)
    fake_cursor.execute = _MagicMock()
    fake_cursor.fetchall = _MagicMock(return_value=[])
    fake_cursor.fetchone = _MagicMock(return_value=None)

    @contextmanager
    def _fake_mk1_conn():
        conn = _MagicMock()
        conn.cursor = _MagicMock(return_value=fake_cursor)
        yield conn

    with (
        patch("mk1_db.ensure_sample_preps_table", return_value=None),
        patch("mk1_db.get_mk1_db", side_effect=_fake_mk1_conn),
    ):
        resp = route_client.get(f"/samples/{parent.sample_id}/activity")

    assert resp.status_code == 200, resp.text
    events = resp.json()["events"]
    promoted_events = [e for e in events if e["event"] == "analysis_promoted"]
    assert len(promoted_events) >= 1, f"No analysis_promoted event found; events={events}"

    ev = promoted_events[0]
    assert ev["source"] == "lims_analysis_promotions"
    assert "STERILITY" in ev["label"]
    assert ev["details"]["keyword"] == "STERILITY"
    assert ev["details"]["result_value"] == "Pass"
    assert "PP-0001-S01" in ev["label"]


# ─── parent-line-states endpoint ─────────────────────────────────────────────


def test_parent_line_states_best_effort_returns_200_empty_on_senaite_error(route_client):
    """GET /api/lims-analyses/parent-line-states → 200 {"states": {}} when
    list_parent_line_states raises SenaiteWritebackError (best-effort)."""
    from lims_analyses.senaite_writeback import SenaiteWritebackError as _SWE

    with patch(
        "lims_analyses.routes.list_parent_line_states",
        side_effect=_SWE("SENAITE down (test)"),
    ):
        resp = route_client.get(
            "/api/lims-analyses/parent-line-states",
            params={"parent_sample_id": "P-9999"},
        )

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"states": {}}


def test_parent_line_states_happy_path_returns_states(route_client):
    """GET /api/lims-analyses/parent-line-states → 200 {"states": <dict>} on success."""
    fake_states = {"STER-PCR": "verified", "ENDO-LAL": "to_be_verified"}

    with patch(
        "lims_analyses.routes.list_parent_line_states",
        return_value=fake_states,
    ):
        resp = route_client.get(
            "/api/lims-analyses/parent-line-states",
            params={"parent_sample_id": "P-0144"},
        )

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"states": fake_states}
