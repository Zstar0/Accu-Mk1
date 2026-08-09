"""Amendment audit (spec 2026-08-07): before/after capture on
lims_analysis_transitions.details, plus the activity-log blend.

Fixtures follow tests/test_parent_placeholders.py: self-contained in-memory
SQLite; models import registers everything on Base.metadata before
create_all().
"""
from __future__ import annotations

from datetime import datetime

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

import models  # noqa: F401 — registers models on Base.metadata
from database import Base
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsAnalysisTransition,
    LimsSample,
    LimsSubSample,
    User,
)


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    try:
        yield s
    finally:
        s.close()


def test_details_column_round_trips_a_dict(db):
    """The column exists in the SQLite fixture engine (JSON variant) and
    stores/returns a nested dict unchanged."""
    parent = LimsSample(sample_id="AA-P1", sample_type="x", status="received")
    db.add(parent)
    db.commit()
    svc = AnalysisService(title="T", keyword="KW", origin="mk1")
    db.add(svc)
    db.commit()
    row = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword="KW", title="T",
    )
    db.add(row)
    db.commit()

    payload = {"changed": {"result_value": {"before": None, "after": "1.0"}}}
    db.add(LimsAnalysisTransition(
        analysis_id=row.id, from_state=None, to_state="unassigned",
        transition_kind="auto", details=payload,
    ))
    db.commit()

    stored = db.execute(select(LimsAnalysisTransition)).scalars().one()
    assert stored.details == payload


def test_details_is_nullable(db):
    """Grandfathered rows carry NULL — the model must not default it."""
    parent = LimsSample(sample_id="AA-P2", sample_type="x", status="received")
    db.add(parent)
    db.commit()
    svc = AnalysisService(title="T2", keyword="KW2", origin="mk1")
    db.add(svc)
    db.commit()
    row = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword="KW2", title="T2",
    )
    db.add(row)
    db.commit()
    db.add(LimsAnalysisTransition(
        analysis_id=row.id, from_state=None, to_state="unassigned",
        transition_kind="auto",
    ))
    db.commit()
    assert db.execute(select(LimsAnalysisTransition)).scalars().one().details is None


from lims_analyses.service import apply_transition


@pytest.fixture
def vial_row(db):
    """A vial-tier analysis in 'unassigned', ready for bench transitions."""
    parent = LimsSample(sample_id="AA-P3", sample_type="x", status="received")
    db.add(parent)
    db.commit()
    vial = LimsSubSample(
        parent_sample_pk=parent.id, external_lims_uid="u1",
        sample_id="AA-P3-S01", vial_sequence=1,
    )
    db.add(vial)
    db.commit()
    svc = AnalysisService(title="Sterility USP<71>", keyword="STERILITY_USP71", origin="mk1")
    db.add(svc)
    db.commit()
    row = LimsAnalysis(
        lims_sub_sample_pk=vial.id, analysis_service_id=svc.id,
        keyword="STERILITY_USP71", title="Sterility USP<71>",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _transitions_for(db, analysis_id):
    return db.execute(
        select(LimsAnalysisTransition)
        .where(LimsAnalysisTransition.analysis_id == analysis_id)
        .order_by(LimsAnalysisTransition.id)
    ).scalars().all()


def test_submit_captures_first_entry(db, vial_row):
    apply_transition(db, analysis_id=vial_row.id, kind="submit",
                     result_value="0.92", user_id=1)
    t = _transitions_for(db, vial_row.id)[-1]
    assert t.details["changed"]["result_value"] == {"before": None, "after": "0.92"}


def test_self_edge_correction_captures_before_and_after(db, vial_row):
    """THE §7.5.2 test: in-place correction keeps the prior value."""
    apply_transition(db, analysis_id=vial_row.id, kind="submit",
                     result_value="0.92", user_id=1)
    apply_transition(db, analysis_id=vial_row.id, kind="submit",
                     result_value="0.95", user_id=1)
    t = _transitions_for(db, vial_row.id)[-1]
    assert t.from_state == "to_be_verified" and t.to_state == "to_be_verified"
    assert t.details["changed"]["result_value"] == {"before": "0.92", "after": "0.95"}


def test_pure_state_move_writes_empty_changed_not_null(db, vial_row):
    apply_transition(db, analysis_id=vial_row.id, kind="assign", user_id=1)
    t = _transitions_for(db, vial_row.id)[-1]
    assert t.details == {"changed": {}}


def test_reset_captures_cleared_fields(db, vial_row):
    apply_transition(db, analysis_id=vial_row.id, kind="assign", user_id=1)
    vial_row.result_value = "draft"   # draft value, as the bench UI writes it
    vial_row.method_id = None
    db.commit()
    apply_transition(db, analysis_id=vial_row.id, kind="reset", user_id=1)
    t = _transitions_for(db, vial_row.id)[-1]
    assert t.details["changed"]["result_value"] == {"before": "draft", "after": None}


def test_retest_flags_old_row_and_seeds_new(db, vial_row):
    apply_transition(db, analysis_id=vial_row.id, kind="submit",
                     result_value="0.92", user_id=1)
    new_row = apply_transition(db, analysis_id=vial_row.id, kind="retest", user_id=1)
    old_last = _transitions_for(db, vial_row.id)[-1]
    assert old_last.details["changed"]["retested"] == {"before": False, "after": True}
    new_first = _transitions_for(db, new_row.id)[0]
    assert new_first.details == {"changed": {}}
