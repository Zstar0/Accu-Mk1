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
