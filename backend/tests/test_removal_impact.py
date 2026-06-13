"""Removal-impact classification tests (Phase 1 — tiered retract-on-remove).

classify_removal_impact buckets the vial-tier rows a parent-service removal
would touch into pristine / worked_unverified / blocked, driving the
confirmation modal and the delete-vs-reject decision. reject_vials_for_parent_keyword
audited-clears the worked_unverified bucket via the state-machine 'reject'.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from lims_analyses.service import (
    apply_transition,
    create_analysis,
    classify_removal_impact,
)
from models import AnalysisService, LimsAnalysis, LimsSample, LimsSubSample


@pytest.fixture
def db_mem():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def seed(db_mem):
    svc = AnalysisService(title="BPC-157 - Identity (HPLC)", keyword="ID_BPC157")
    db_mem.add(svc)
    db_mem.flush()
    parent = LimsSample(sample_id="P-IMP-001", external_lims_uid="uid-imp-001")
    db_mem.add(parent)
    db_mem.flush()
    sub1 = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid="uid-imp-001-S01",
        sample_id="P-IMP-001-S01",
        vial_sequence=1,
    )
    sub2 = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid="uid-imp-001-S02",
        sample_id="P-IMP-001-S02",
        vial_sequence=2,
    )
    db_mem.add_all([sub1, sub2])
    db_mem.commit()
    return db_mem, parent, sub1, sub2, svc


def _row(db, sub, svc):
    return create_analysis(
        db,
        host_kind="sub_sample",
        host_pk=sub.id,
        analysis_service_id=svc.id,
        keyword=svc.keyword,
        title=svc.title or svc.keyword,
        result_value=None,
    )


def _no_slot(monkeypatch):
    """Non-analyte keyword must never hit SENAITE for the slot map."""
    def _boom(pid):
        raise AssertionError("fetch_parent_analyte_slots must not be called")
    monkeypatch.setattr("sub_samples.senaite.fetch_parent_analyte_slots", _boom)


def test_classifies_pristine_worked_and_blocked(seed, monkeypatch):
    db, parent, sub1, sub2, svc = seed
    _no_slot(monkeypatch)
    _row(db, sub1, svc)  # unassigned, no result -> pristine
    worked = _row(db, sub2, svc)
    apply_transition(db, analysis_id=worked.id, kind="assign")
    apply_transition(db, analysis_id=worked.id, kind="submit", result_value="99.1")

    impact = classify_removal_impact(
        db, parent_sample_id=parent.sample_id, keyword=svc.keyword
    )

    assert [r["sample_id"] for r in impact["pristine"]] == ["P-IMP-001-S01"]
    assert [r["sample_id"] for r in impact["worked_unverified"]] == ["P-IMP-001-S02"]
    assert impact["blocked"] == []


def test_verified_row_is_blocked(seed, monkeypatch):
    db, parent, sub1, sub2, svc = seed
    _no_slot(monkeypatch)
    r = _row(db, sub1, svc)
    apply_transition(db, analysis_id=r.id, kind="assign")
    apply_transition(db, analysis_id=r.id, kind="submit", result_value="99.1")
    # Vial-tier rows never self-verify (they reach 'verified' by promotion); set
    # the terminal state directly — classify only reads review_state.
    r.review_state = "verified"
    db.commit()

    impact = classify_removal_impact(
        db, parent_sample_id=parent.sample_id, keyword=svc.keyword
    )
    assert [r["sample_id"] for r in impact["blocked"]] == ["P-IMP-001-S01"]
    assert impact["pristine"] == []
    assert impact["worked_unverified"] == []
