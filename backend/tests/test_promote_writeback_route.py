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
    assert body["parent"]["review_state"] == "parent_to_verify"  # Task 3: promote submits, verify signs off
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


# ─── Test 1b: per-substance keyword translates to parent ANALYTE-{slot} ───────


def test_promote_per_substance_writes_back_under_parent_keyword(
    route_client, promote_fixture, monkeypatch
):
    """Promoting a PUR_BPC157 vial row must write back under the PARENT keyword
    (ANALYTE-2-PUR), NOT the per-substance vial keyword (PUR_BPC157), and the
    parent-tier row must be keyed ANALYTE-2-PUR.

    Slot resolution is made deterministic by monkeypatching
    service.resolve_parent_analyte_target.
    """
    db, parent, sub, analysis, _payload = promote_fixture

    # Re-key the seeded vial analysis to a per-substance keyword.
    analysis.keyword = "PUR_BPC157"
    analysis.title = "BPC-157 - Purity (HPLC)"
    db.commit()
    db.refresh(analysis)

    payload = {
        "keyword": "PUR_BPC157",
        "result_value": "98.55",
        "sources": [{"analysis_id": analysis.id, "contribution_kind": "chosen"}],
    }

    # Deterministic parent-slot resolution: PUR_BPC157 → ANALYTE-2-PUR.
    def _fake_resolve(db_, *, vial_keyword, parent_sample_id):
        assert vial_keyword == "PUR_BPC157"
        return ("ANALYTE-2-PUR", 4242, "Analyte 2 (Purity)")

    monkeypatch.setattr(
        "lims_analyses.service.resolve_parent_analyte_target", _fake_resolve
    )

    captured = {}

    def _fake_writeback(parent_sample_id, keyword, result_value, remark):
        captured["parent_sample_id"] = parent_sample_id
        captured["keyword"] = keyword
        captured["result_value"] = result_value
        return "senaite-uid-fake"

    with patch("lims_analyses.routes.senaite_writeback.writeback_promotion",
               side_effect=_fake_writeback):
        resp = route_client.post("/api/lims-analyses/promote", json=payload)

    assert resp.status_code == 201, resp.text

    # Write-back used the PARENT keyword, not the per-substance vial keyword.
    assert captured["keyword"] == "ANALYTE-2-PUR"
    assert captured["keyword"] != "PUR_BPC157"
    assert captured["parent_sample_id"] == parent.sample_id  # "P-0001"

    # Parent-tier row is keyed under the parent ANALYTE-{slot} keyword.
    parent_row = db.get(LimsAnalysis, resp.json()["parent"]["id"])
    assert parent_row is not None
    assert parent_row.keyword == "ANALYTE-2-PUR"


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


# ─── Promote divergence (Handler ruling 2026-08-30) ──────────────────────────
# A LOCKED SENAITE parent line (verified/published) must NOT block the native
# promote: post read-independence nothing reads that line for certificates —
# the canonical row is the authority. The route logs, records a
# 'senaite_line_diverged' audit event, and proceeds. Generic write-back
# failures still 502 (pinned above).


def test_promote_diverges_when_senaite_line_locked(route_client, promote_fixture):
    from lims_analyses.senaite_writeback import SenaiteParentLineLocked
    from models import LimsSubSampleEvent
    db, parent, sub, analysis, payload = promote_fixture

    def _locked_writeback(parent_sample_id, keyword, result_value, remark):
        raise SenaiteParentLineLocked(
            uid="uid-locked", state="verified",
            message=f"Analysis {keyword} on {parent_sample_id} is locked in SENAITE",
        )

    with patch("lims_analyses.routes.senaite_writeback.writeback_promotion",
               side_effect=_locked_writeback):
        resp = route_client.post("/api/lims-analyses/promote", json=payload)

    assert resp.status_code == 201, resp.text
    assert resp.json()["parent"]["review_state"] == "parent_to_verify"

    # Parent-tier row persisted despite the locked SENAITE line
    parent_rows = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == parent.id,
            LimsAnalysis.keyword == "PURITY-HPLC",
        )
    ).scalars().all()
    assert len(parent_rows) == 1

    # Audit event written, naming the divergence
    events = db.execute(
        select(LimsSubSampleEvent).where(
            LimsSubSampleEvent.lims_sample_pk == parent.id,
            LimsSubSampleEvent.event == "senaite_line_diverged",
        )
    ).scalars().all()
    assert len(events) == 1
    d = events[0].details
    assert d["keyword"] == "PURITY-HPLC"
    assert d["senaite_state"] == "verified"
    assert d["senaite_uid"] == "uid-locked"


# ─── parent-line-states, source=mk1 (native lock map, 1.12.2) ────────────────
# The FE's isLockedByParent gate read SENAITE line states — post divergence
# (1.12.1) a SENAITE line stays verified forever, so a retested keyword's
# vial rows stayed locked with no Promote (Handler's PB-0486 Endo dead end).
# In mk1 mode the map is served natively: the canonical tier owns any
# keyword it has EVER held (live canonical state locks; live canonical gone
# → unlocked, even though the shadow still mirrors SENAITE's verified);
# keywords with no canonical history fall back to live shadow rows so
# legacy vials keep their lock. Zero SENAITE reads on this branch.


def _parent_tier_row(db, parent, svc, keyword, **kw):
    row = LimsAnalysis(
        lims_sample_pk=parent.id,
        analysis_service_id=svc.id,
        keyword=keyword,
        title=keyword,
        **kw,
    )
    db.add(row)
    db.commit()
    return row


@pytest.fixture
def line_states_parent(route_client):
    db = route_client._test_session
    svc = AnalysisService(title="Endotoxin", keyword="ENDO")
    db.add(svc)
    parent = LimsSample(sample_id="P-0002", external_lims_uid="uid-P-0002")
    db.add(parent)
    db.commit()
    return db, parent, svc


def _get_states_mk1(route_client):
    with patch(
        "lims_analyses.routes.list_parent_line_states",
        side_effect=AssertionError("SENAITE read on mk1 branch"),
    ):
        resp = route_client.get(
            "/api/lims-analyses/parent-line-states",
            params={"parent_sample_id": "P-0002", "source": "mk1"},
        )
    assert resp.status_code == 200, resp.text
    return resp.json()["states"]


def test_parent_line_states_mk1_native_map_zero_senaite(route_client, line_states_parent):
    db, parent, svc = line_states_parent
    # Live canonical verified → locks its keyword.
    _parent_tier_row(db, parent, svc, "ENDO",
                     provenance="canonical", review_state="verified")
    # Shadow-only keyword (no canonical history) → mirror state locks (legacy).
    _parent_tier_row(db, parent, svc, "STER-PCR",
                     provenance="shadow", review_state="senaite_mirror",
                     mirror_review_state="verified")
    # Parent-hosted canonical mid-run (TIER_VIAL under tier_of) → excluded.
    _parent_tier_row(db, parent, svc, "VAR-RUN",
                     provenance="canonical", review_state="to_be_verified")
    states = _get_states_mk1(route_client)
    assert states.get("ENDO") == "verified"
    assert states.get("STER-PCR") == "verified"
    assert "VAR-RUN" not in states


def test_parent_line_states_mk1_retracted_canonical_unlocks_despite_shadow(
    route_client, line_states_parent
):
    """THE PB-0486 case: verified-parent retest retracts the canonical row;
    the shadow keeps mirroring SENAITE's eternal verified. Canonical history
    owns the keyword → absent from the map → vial unlocked to re-promote."""
    db, parent, svc = line_states_parent
    _parent_tier_row(db, parent, svc, "ENDO",
                     provenance="canonical", review_state="retracted")
    _parent_tier_row(db, parent, svc, "ENDO",
                     provenance="shadow", review_state="senaite_mirror",
                     mirror_review_state="verified")
    states = _get_states_mk1(route_client)
    assert "ENDO" not in states


def test_parent_line_states_mk1_retested_published_canonical_unlocks(
    route_client, line_states_parent
):
    """#156 published-parent retest marks the canonical row retested=True
    (value stays citable) — retest in flight, vial must be promotable."""
    db, parent, svc = line_states_parent
    _parent_tier_row(db, parent, svc, "ENDO",
                     provenance="canonical", review_state="published",
                     retested=True)
    states = _get_states_mk1(route_client)
    assert "ENDO" not in states
