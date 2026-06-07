"""Sub-sample activity log — writers + endpoint aggregation tests.

Section B writers (service unit tests):
  - set_assignment_role  → LimsSubSampleEvent(event='role_assigned')
  - update_sub_sample    → LimsSubSampleEvent(event='remarks_updated')
  - delete_pristine_analysis → LimsSubSampleEvent(event='analysis_removed')

Section A + B endpoint tests (TestClient):
  - Seeded analysis (initial-insert transition) → 'analysis_added' event
  - A workflow transition                        → 'analysis_transition' event
  - A vial-side promotion                        → 'analysis_promoted_to_parent' event
  - A role change                                → 'role_assigned' event
  - An analysis_removed event                    → 'analysis_removed' event
  - All present, reverse-chronological, user-attributed
"""
from __future__ import annotations

import pytest
from datetime import datetime
from unittest.mock import MagicMock, patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

# Import all models so they are registered with Base before create_all() runs.
from models import (
    User,
    AnalysisService,
    LimsSample,
    LimsSubSample,
    LimsAnalysis,
    LimsAnalysisTransition,
    LimsAnalysisPromotion,
    LimsSubSampleEvent,
)


# ─── Service-layer writer tests (use the shared db_session fixture) ──────────


def _make_parent(db):
    """Minimal LimsSample row for FK references."""
    parent = LimsSample(
        sample_id="P-TEST-001",
        external_lims_uid="SENAITE-PARENT",
    )
    db.add(parent)
    db.flush()
    return parent


def _make_sub(db, parent, sample_id="P-TEST-001-S01"):
    """Minimal LimsSubSample row."""
    sub = LimsSubSample(
        sample_id=sample_id,
        parent_sample_pk=parent.id,
        vial_sequence=1,
        external_lims_uid="SENAITE-SUB",
    )
    db.add(sub)
    db.flush()
    return sub


# ── role_assigned ────────────────────────────────────────────────────────────


def test_set_assignment_role_writes_event(db_session):
    """set_assignment_role writes a role_assigned event row with from/to details."""
    from sub_samples.service import set_assignment_role

    parent = _make_parent(db_session)
    sub = _make_sub(db_session, parent)
    sub.assignment_role = "hplc"
    db_session.flush()

    # Patch the downstream seeder and SENAITE calls so the test is pure-DB
    with (
        patch("sub_samples.service._fetch_wp_services_for_parent", return_value={}),
        patch("sub_samples.service.seed_analyses_for_vial", return_value=None, create=True),
    ):
        set_assignment_role(db_session, "P-TEST-001-S01", "endo", user_id=42)

    events = db_session.query(LimsSubSampleEvent).filter_by(sub_sample_pk=sub.id).all()
    assert len(events) == 1
    ev = events[0]
    assert ev.event == "role_assigned"
    assert ev.details == {"from": "hplc", "to": "endo"}
    assert ev.user_id == 42


def test_set_assignment_role_event_null_user(db_session):
    """user_id defaults to None when not supplied."""
    from sub_samples.service import set_assignment_role

    parent = _make_parent(db_session)
    sub = _make_sub(db_session, parent)

    with (
        patch("sub_samples.service._fetch_wp_services_for_parent", return_value={}),
        patch("sub_samples.service.seed_analyses_for_vial", return_value=None, create=True),
    ):
        set_assignment_role(db_session, "P-TEST-001-S01", "ster")

    ev = db_session.query(LimsSubSampleEvent).filter_by(sub_sample_pk=sub.id).one()
    assert ev.user_id is None


# ── remarks_updated ──────────────────────────────────────────────────────────


def test_update_sub_sample_writes_remarks_event(db_session):
    """update_sub_sample writes a remarks_updated event when remarks is passed."""
    from sub_samples.service import update_sub_sample

    parent = _make_parent(db_session)
    sub = _make_sub(db_session, parent)

    with (
        patch("sub_samples.native.is_native_vial", return_value=True),
        patch("sub_samples.senaite.upload_photo"),
    ):
        # Need a parent_sample relationship for last_synced_at update
        update_sub_sample(
            db_session,
            "P-TEST-001-S01",
            photo_bytes=None,
            photo_filename=None,
            remarks="Looks good",
            user_id=7,
        )

    events = db_session.query(LimsSubSampleEvent).filter_by(sub_sample_pk=sub.id).all()
    assert len(events) == 1
    ev = events[0]
    assert ev.event == "remarks_updated"
    assert ev.details == {"preview": "Looks good"}
    assert ev.user_id == 7


def test_update_sub_sample_no_event_when_remarks_none(db_session):
    """No event written when remarks param is None (photo-only update)."""
    from sub_samples.service import update_sub_sample

    parent = _make_parent(db_session)
    sub = _make_sub(db_session, parent)

    with (
        patch("sub_samples.native.is_native_vial", return_value=True),
        patch("sub_samples.senaite.upload_photo"),
    ):
        update_sub_sample(
            db_session,
            "P-TEST-001-S01",
            photo_bytes=None,
            photo_filename=None,
            remarks=None,
            user_id=7,
        )

    count = db_session.query(LimsSubSampleEvent).filter_by(sub_sample_pk=sub.id).count()
    assert count == 0


def test_update_sub_sample_truncates_preview_at_120(db_session):
    """Long remarks are truncated to 120 chars in the event details."""
    from sub_samples.service import update_sub_sample

    parent = _make_parent(db_session)
    _make_sub(db_session, parent)
    long_remarks = "x" * 200

    with (
        patch("sub_samples.native.is_native_vial", return_value=True),
        patch("sub_samples.senaite.upload_photo"),
    ):
        update_sub_sample(
            db_session,
            "P-TEST-001-S01",
            photo_bytes=None,
            photo_filename=None,
            remarks=long_remarks,
        )

    ev = db_session.query(LimsSubSampleEvent).one()
    assert len(ev.details["preview"]) == 120


# ── analysis_removed ─────────────────────────────────────────────────────────


def test_delete_pristine_analysis_writes_event(db_session):
    """delete_pristine_analysis writes an analysis_removed event before hard-delete."""
    from lims_analyses.service import delete_pristine_analysis

    parent = _make_parent(db_session)
    sub = _make_sub(db_session, parent)

    # analysis_service_id and title are NOT NULL on lims_analyses
    svc = AnalysisService(title="Sterility PCR", keyword="STER-PCR")
    db_session.add(svc)
    db_session.flush()

    # Seed a pristine (unassigned, null result) analysis
    analysis = LimsAnalysis(
        lims_sub_sample_pk=sub.id,
        analysis_service_id=svc.id,
        keyword="STER-PCR",
        title="Sterility PCR",
        review_state="unassigned",
        result_value=None,
        retested=False,
    )
    db_session.add(analysis)
    db_session.commit()

    delete_pristine_analysis(db_session, sub_sample_pk=sub.id, keyword="STER-PCR", user_id=5)

    # Analysis row is gone
    remaining = db_session.query(LimsAnalysis).filter_by(keyword="STER-PCR").all()
    assert len(remaining) == 0

    # Event row persists
    ev = db_session.query(LimsSubSampleEvent).filter_by(sub_sample_pk=sub.id).one()
    assert ev.event == "analysis_removed"
    assert ev.details == {"keyword": "STER-PCR"}
    assert ev.user_id == 5


# ─── Endpoint aggregation tests (TestClient) ─────────────────────────────────


@pytest.fixture
def activity_client():
    """TestClient with a single-connection in-memory SQLite engine.

    Patches out the mk1_db block (sample_preps) and the integration DB block
    so the test is self-contained and only exercises the sub-sample A+B path.
    """
    from database import Base, get_db
    from auth import get_current_user
    from main import app
    from fastapi.testclient import TestClient

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
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1, email="tester@lab.com")

    # Patch out the two external-DB side-paths in get_sample_activity.
    # ensure_sample_preps_table and get_mk1_db are imported inside the function
    # body, so we patch them on the mk1_db module (not on main).
    # get_integration_db is a module-level import on main.
    with (
        patch("mk1_db.ensure_sample_preps_table"),
        patch("mk1_db.get_mk1_db") as mock_mk1_db,
        patch("main.get_integration_db") as mock_int_db,
    ):
        # mk1_db: context manager returning a cursor with no rows
        mk1_conn = MagicMock()
        mk1_conn.__enter__ = MagicMock(return_value=mk1_conn)
        mk1_conn.__exit__ = MagicMock(return_value=False)
        mk1_cursor = MagicMock()
        mk1_cursor.__enter__ = MagicMock(return_value=mk1_cursor)
        mk1_cursor.__exit__ = MagicMock(return_value=False)
        mk1_cursor.fetchall.return_value = []
        mk1_conn.cursor.return_value = mk1_cursor
        mock_mk1_db.return_value = mk1_conn

        # int_db: same pattern, raises so the except-pass branch handles it
        mock_int_db.side_effect = Exception("no integration db in tests")

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


def _seed_activity_scenario(db):
    """Set up a sub-sample with one analysis, transitions, promotion, and events."""

    user = User(email="lab@test.com", hashed_password="x", role="standard")
    db.add(user)
    db.flush()

    # analysis_service_id is NOT NULL on lims_analyses; seed a minimal service row.
    svc = AnalysisService(title="HPLC Purity", keyword="HPLC-PUR")
    db.add(svc)
    db.flush()

    parent = LimsSample(sample_id="P-0144", external_lims_uid="SENAITE-PARENT")
    db.add(parent)
    db.flush()

    sub = LimsSubSample(
        sample_id="P-0144-S01",
        parent_sample_pk=parent.id,
        vial_sequence=1,
        external_lims_uid="SENAITE-SUB",
    )
    db.add(sub)
    db.flush()

    analysis = LimsAnalysis(
        lims_sub_sample_pk=sub.id,
        analysis_service_id=svc.id,
        keyword="HPLC-PUR",
        title="HPLC Purity",
        review_state="unassigned",
    )
    db.add(analysis)
    db.flush()

    # Section A1a: initial-insert transition (analysis_added)
    t_seed = LimsAnalysisTransition(
        analysis_id=analysis.id,
        from_state=None,
        to_state="unassigned",
        transition_kind="auto",
        user_id=user.id,
        reason="initial insert",
        occurred_at=datetime(2026, 6, 1, 10, 0, 0),
    )
    db.add(t_seed)

    # Section A1b: a real workflow transition (analysis_transition)
    t_submit = LimsAnalysisTransition(
        analysis_id=analysis.id,
        from_state="unassigned",
        to_state="to_be_verified",
        transition_kind="submit",
        user_id=user.id,
        reason=None,
        occurred_at=datetime(2026, 6, 2, 9, 0, 0),
    )
    db.add(t_submit)

    # Section A2: vial-side promotion — needs a parent-tier analysis row
    parent_analysis = LimsAnalysis(
        lims_sample_pk=parent.id,
        analysis_service_id=svc.id,
        keyword="HPLC-PUR",
        title="HPLC Purity",
        review_state="verified",
    )
    db.add(parent_analysis)
    db.flush()

    promo = LimsAnalysisPromotion(
        parent_analysis_id=parent_analysis.id,
        source_analysis_id=analysis.id,
        contribution_kind="chosen",
        promoted_by_user_id=user.id,
        promoted_at=datetime(2026, 6, 3, 8, 0, 0),
    )
    db.add(promo)

    # Section B: role_assigned event
    ev_role = LimsSubSampleEvent(
        sub_sample_pk=sub.id,
        event="role_assigned",
        details={"from": None, "to": "hplc"},
        user_id=user.id,
        created_at=datetime(2026, 5, 31, 14, 0, 0),
    )
    db.add(ev_role)

    # Section B: analysis_removed event
    ev_removed = LimsSubSampleEvent(
        sub_sample_pk=sub.id,
        event="analysis_removed",
        details={"keyword": "STER-PCR"},
        user_id=user.id,
        created_at=datetime(2026, 5, 30, 12, 0, 0),
    )
    db.add(ev_removed)

    db.commit()
    return sub, user


def test_activity_endpoint_returns_sub_sample_events(activity_client):
    """GET /samples/{id}/activity covers all sub-sample event types."""
    db = activity_client._test_session
    sub, user = _seed_activity_scenario(db)

    resp = activity_client.get("/samples/P-0144-S01/activity")
    assert resp.status_code == 200
    body = resp.json()

    events = body["events"]
    event_names = {e["event"] for e in events}

    assert "analysis_added" in event_names, "seeded analysis (initial-insert) must appear"
    assert "analysis_transition" in event_names, "workflow transition must appear"
    assert "analysis_promoted_to_parent" in event_names, "vial-side promotion must appear"
    assert "role_assigned" in event_names, "role change event must appear"
    assert "analysis_removed" in event_names, "analysis_removed event must appear"


def test_activity_endpoint_reverse_chronological(activity_client):
    """Events are returned in reverse-chronological order."""
    db = activity_client._test_session
    _seed_activity_scenario(db)

    resp = activity_client.get("/samples/P-0144-S01/activity")
    events = resp.json()["events"]

    timestamps = [e["timestamp"] for e in events if e["timestamp"]]
    assert timestamps == sorted(timestamps, reverse=True), (
        "events must be reverse-chronological"
    )


def test_activity_endpoint_user_attributed(activity_client):
    """Events that have a user_id include the actor email in details."""
    db = activity_client._test_session
    _seed_activity_scenario(db)

    resp = activity_client.get("/samples/P-0144-S01/activity")
    events = resp.json()["events"]

    # Every event from our seed scenario has user_id set
    # Check at least the role_assigned event has 'by' attributed
    role_events = [e for e in events if e["event"] == "role_assigned"]
    assert len(role_events) == 1
    assert role_events[0]["details"]["by"] == "lab@test.com"


def test_activity_endpoint_no_sub_sample_events_for_parent(activity_client):
    """Sub-sample blocks do not run for a parent sample_id."""
    db = activity_client._test_session
    # Seed only parent (no sub-sample with this sample_id)
    parent = LimsSample(sample_id="P-PARENT-ONLY", external_lims_uid="SENAITE-PARENT2")
    db.add(parent)
    db.commit()

    resp = activity_client.get("/samples/P-PARENT-ONLY/activity")
    assert resp.status_code == 200
    events = resp.json()["events"]
    sub_sources = [e for e in events if e["source"] in (
        "lims_analysis_transitions", "lims_analysis_promotions", "lims_sub_sample_events"
    )]
    assert len(sub_sources) == 0, "sub-sample blocks must not run for a parent id"


def test_activity_endpoint_analysis_added_label(activity_client):
    """Initial-insert transition produces label='Analysis added: {keyword}'."""
    db = activity_client._test_session
    _seed_activity_scenario(db)

    resp = activity_client.get("/samples/P-0144-S01/activity")
    events = resp.json()["events"]

    added = [e for e in events if e["event"] == "analysis_added"]
    assert len(added) == 1
    assert added[0]["label"] == "Analysis added: HPLC-PUR"


def test_activity_endpoint_promotion_label(activity_client):
    """Vial-side promotion produces label='Promoted {keyword} to parent'."""
    db = activity_client._test_session
    _seed_activity_scenario(db)

    resp = activity_client.get("/samples/P-0144-S01/activity")
    events = resp.json()["events"]

    promos = [e for e in events if e["event"] == "analysis_promoted_to_parent"]
    assert len(promos) == 1
    assert promos[0]["label"] == "Promoted HPLC-PUR to parent"


def test_activity_endpoint_worksheet_assigned_label(activity_client):
    """A worksheet_assigned event (written by stamp_for_item) surfaces in the
    activity endpoint with label='Added to worksheet ...'."""
    from lims_analyses.worksheet_analyst import stamp_for_item

    db = activity_client._test_session
    sub, user = _seed_activity_scenario(db)

    # The seed gives the sub external_lims_uid="SENAITE-SUB". Stamp all live
    # analyses on the vial (group None) — writes one worksheet_assigned event.
    stamp_for_item(
        db,
        sample_uid=sub.external_lims_uid,
        service_group_id=None,
        analyst_user_id=user.id,
        acting_user_id=user.id,
        worksheet_id=42,
        worksheet_title="HPLC Bench A",
    )
    db.commit()

    resp = activity_client.get("/samples/P-0144-S01/activity")
    assert resp.status_code == 200
    events = resp.json()["events"]

    assigned = [e for e in events if e["event"] == "worksheet_assigned"]
    assert len(assigned) == 1
    assert assigned[0]["label"].startswith("Added to worksheet")
    assert "HPLC Bench A" in assigned[0]["label"]
