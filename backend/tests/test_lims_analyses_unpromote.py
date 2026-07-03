"""Unlock (un-promote): parent-tier retract + group source revert.

Spec: docs/superpowers/specs/2026-07-03-vial-unlock-unpromote-design.md
"""
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from database import Base
from lims_analyses import service
from models import (
    AnalysisService, LimsAnalysis, LimsAnalysisPromotion,
    LimsAnalysisTransition, LimsSample, LimsSubSample,
)


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _seed_promoted_group(db, n_sources=2):
    """Parent sample + n vials, each with a to_be_verified analysis, promoted
    through the REAL promote_to_parent so state/links match production."""
    svc = AnalysisService(title="Purity (HPLC)", keyword="PURITY-HPLC")
    db.add(svc); db.flush()
    parent = LimsSample(sample_id="P-0001", external_lims_uid="uid-P-0001")
    db.add(parent); db.flush()
    sources = []
    for i in range(1, n_sources + 1):
        sub = LimsSubSample(parent_sample_pk=parent.id, sample_id=f"P-0001-S{i:02d}",
                            external_lims_uid=f"uid-s{i}", vial_sequence=i)
        db.add(sub); db.flush()
        a = LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
                         keyword="PURITY-HPLC", title="Purity (HPLC)",
                         review_state="to_be_verified", result_value=f"98.{i}")
        db.add(a); db.flush()
        sources.append(a)
    kind = "aggregated_in" if n_sources > 1 else "chosen"
    parent_row, _ = service.promote_to_parent(
        db, keyword="PURITY-HPLC", result_value="98.5", result_unit="%",
        method_id=None, instrument_id=None,
        sources=[{"analysis_id": a.id, "contribution_kind": kind} for a in sources],
        user_id=1, reason="test promote",
    )
    return parent, parent_row, sources


def test_unpromote_reverts_group_and_retracts_parent(db):
    parent, parent_row, sources = _seed_promoted_group(db, n_sources=2)
    got_parent, reverted = service.unpromote_parent_analysis(
        db, parent_analysis_id=parent_row.id, reason="purity/quantity swap", user_id=7)
    assert got_parent.review_state == "retracted"
    assert got_parent.verified_at is None
    assert sorted(reverted) == sorted(a.id for a in sources)
    for a in sources:
        db.refresh(a)
        assert a.review_state == "to_be_verified"
    # Links preserved (audit history), parent audit row written with the reason
    links = db.execute(select(LimsAnalysisPromotion).where(
        LimsAnalysisPromotion.parent_analysis_id == parent_row.id)).scalars().all()
    assert len(links) == 2
    parent_audit = db.execute(select(LimsAnalysisTransition).where(
        LimsAnalysisTransition.analysis_id == parent_row.id,
        LimsAnalysisTransition.transition_kind == "unpromote")).scalars().all()
    assert len(parent_audit) == 1 and "purity/quantity swap" in parent_audit[0].reason


def test_unpromote_blank_reason_rejected(db):
    _, parent_row, _ = _seed_promoted_group(db, 1)
    with pytest.raises(service.BadRequestError):
        service.unpromote_parent_analysis(db, parent_analysis_id=parent_row.id,
                                          reason="  ", user_id=1)


def test_unpromote_published_parent_blocked(db):
    _, parent_row, _ = _seed_promoted_group(db, 1)
    parent_row.review_state = "published"
    db.commit()
    with pytest.raises(service.InvalidTransitionError):
        service.unpromote_parent_analysis(db, parent_analysis_id=parent_row.id,
                                          reason="x", user_id=1)


def test_unpromote_rejects_vial_tier_target(db):
    _, _, sources = _seed_promoted_group(db, 1)
    with pytest.raises(service.BadRequestError):
        service.unpromote_parent_analysis(db, parent_analysis_id=sources[0].id,
                                          reason="x", user_id=1)


def test_unpromote_then_repromote_round_trip(db):
    _, parent_row, sources = _seed_promoted_group(db, 1)
    service.unpromote_parent_analysis(db, parent_analysis_id=parent_row.id,
                                      reason="redo", user_id=1)
    # Source is back in to_be_verified and the unique parent slot is vacated —
    # a fresh promote succeeds.
    new_parent, _ = service.promote_to_parent(
        db, keyword="PURITY-HPLC", result_value="97.9", result_unit="%",
        method_id=None, instrument_id=None,
        sources=[{"analysis_id": sources[0].id, "contribution_kind": "chosen"}],
        user_id=1, reason="re-promote after unlock",
    )
    assert new_parent.review_state == "verified"
    assert new_parent.id != parent_row.id
