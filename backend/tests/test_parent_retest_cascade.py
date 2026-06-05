"""Parent-retest cascade tests.

Design: when a PARENT-tier analysis (promoted from vials) is retested in SENAITE,
cascade_parent_retest_to_sources walks the chain:
  parent_sample_id → LimsSample → active parent-tier LimsAnalysis (keyword match)
  → LimsAnalysisPromotion source rows → apply_transition(kind="retest") per source

Tests (≥5):
  1. Chain-complete cascade: creates vial retest row + flags source as retested.
  2. Source already retested → skipped (no duplicate).
  3. Missing promotion link (no promotions for parent) → no-op (empty list).
  4. Multi-source (aggregated_in) promotion → all eligible sources cascade.
  5. Missing parent_sample_id (parent sample not in DB) → no-op (empty list).
  + bonus: source in wrong state (unassigned) → skipped.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from database import Base
from lims_analyses.service import (
    apply_transition,
    cascade_parent_retest_to_sources,
    create_analysis,
    promote_to_parent,
)
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsAnalysisPromotion,
    LimsSample,
    LimsSubSample,
)


# ─── Fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture
def db_mem():
    """In-memory SQLite session for cascade unit tests."""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def seed(db_mem):
    """Seed a parent LimsSample, one LimsSubSample, and an AnalysisService.

    Returns (db, parent, sub, svc).
    """
    svc = AnalysisService(title="Purity (HPLC)", keyword="PURITY-HPLC")
    db_mem.add(svc)
    db_mem.flush()

    parent = LimsSample(sample_id="P-CASCADE-001", external_lims_uid="uid-cascade-001")
    db_mem.add(parent)
    db_mem.flush()

    sub = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid="uid-cascade-001-S01",
        sample_id="P-CASCADE-001-S01",
        vial_sequence=1,
    )
    db_mem.add(sub)
    db_mem.commit()

    return db_mem, parent, sub, svc


def _make_vial_tbv(db, sub, svc, result="98.55"):
    """Create a vial-tier analysis and walk it to to_be_verified."""
    row = create_analysis(
        db,
        host_kind="sub_sample",
        host_pk=sub.id,
        analysis_service_id=svc.id,
        keyword=svc.keyword,
        title="TEST: " + (svc.title or svc.keyword),
        result_value=None,
    )
    apply_transition(db, analysis_id=row.id, kind="assign")
    apply_transition(db, analysis_id=row.id, kind="submit", result_value=result)
    db.refresh(row)
    assert row.review_state == "to_be_verified"
    return row


def _promote_single(db, vial, svc, result="98.55"):
    """Promote a single vial to a parent-tier row (chosen)."""
    parent_row, _ = promote_to_parent(
        db,
        keyword=svc.keyword,
        result_value=result,
        result_unit=None,
        method_id=None,
        instrument_id=None,
        sources=[{"analysis_id": vial.id, "contribution_kind": "chosen"}],
        user_id=None,
        reason=None,
        commit=True,
    )
    return parent_row


# ─── Test 1: chain-complete cascade ──────────────────────────────────────────


def test_cascade_creates_vial_retest_row(seed):
    """Full chain: promote a vial to parent, then cascade → new vial retest row."""
    db, parent, sub, svc = seed

    vial = _make_vial_tbv(db, sub, svc)
    vial_id = vial.id
    _promote_single(db, vial, svc)

    new_ids = cascade_parent_retest_to_sources(
        db,
        parent_sample_id=parent.sample_id,
        keyword=svc.keyword,
        user_id=None,
    )

    assert len(new_ids) == 1, f"expected 1 new id, got {new_ids}"

    new_row = db.get(LimsAnalysis, new_ids[0])
    assert new_row is not None
    assert new_row.retest_of_id == vial_id
    assert new_row.review_state == "unassigned"
    assert new_row.result_value is None

    # Source flagged as retested
    db.refresh(vial)
    assert vial.retested is True


# ─── Test 2: source already retested → skipped ───────────────────────────────


def test_cascade_skips_already_retested_source(seed):
    """If the source vial was already retested, cascade returns empty list."""
    db, parent, sub, svc = seed

    vial = _make_vial_tbv(db, sub, svc)
    _promote_single(db, vial, svc)

    # Manually retest the source BEFORE the cascade
    apply_transition(db, analysis_id=vial.id, kind="retest")

    new_ids = cascade_parent_retest_to_sources(
        db,
        parent_sample_id=parent.sample_id,
        keyword=svc.keyword,
        user_id=None,
    )

    assert new_ids == [], (
        "cascade must skip sources that are already retested; "
        f"got {new_ids}"
    )


# ─── Test 3: no promotions for parent → no-op ────────────────────────────────


def test_cascade_no_op_when_no_promotions(seed):
    """If the parent analysis has no promotion links, cascade returns []."""
    db, parent, sub, svc = seed

    # Insert a parent-tier row directly (NOT via promote_to_parent → no promo rows)
    parent_row = LimsAnalysis(
        lims_sample_pk=parent.id,
        lims_sub_sample_pk=None,
        analysis_service_id=svc.id,
        keyword=svc.keyword,
        title="TEST: direct parent (no promotions)",
        review_state="verified",
        result_value="99.00",
        retest_of_id=None,
    )
    db.add(parent_row)
    db.commit()

    new_ids = cascade_parent_retest_to_sources(
        db,
        parent_sample_id=parent.sample_id,
        keyword=svc.keyword,
        user_id=None,
    )

    assert new_ids == []


# ─── Test 4: multi-source (aggregated_in) cascade ────────────────────────────


def test_cascade_multi_source_promotes_all(seed):
    """Two aggregated_in sources → both eligible → cascade creates two retest rows."""
    db, parent, sub, svc = seed

    # Need a second sub-sample under the same parent
    sub2 = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid="uid-cascade-001-S02",
        sample_id="P-CASCADE-001-S02",
        vial_sequence=2,
    )
    db.add(sub2)
    db.commit()

    vial1 = _make_vial_tbv(db, sub, svc, result="97.00")
    vial2 = _make_vial_tbv(db, sub2, svc, result="98.00")

    # Aggregate both vials into one parent row
    parent_row, _ = promote_to_parent(
        db,
        keyword=svc.keyword,
        result_value="97.50",
        result_unit=None,
        method_id=None,
        instrument_id=None,
        sources=[
            {"analysis_id": vial1.id, "contribution_kind": "aggregated_in"},
            {"analysis_id": vial2.id, "contribution_kind": "aggregated_in"},
        ],
        user_id=None,
        reason=None,
        commit=True,
    )

    new_ids = cascade_parent_retest_to_sources(
        db,
        parent_sample_id=parent.sample_id,
        keyword=svc.keyword,
        user_id=None,
    )

    assert len(new_ids) == 2, f"expected 2 new retest rows, got {new_ids}"

    # Both originals are flagged
    db.refresh(vial1)
    db.refresh(vial2)
    assert vial1.retested is True
    assert vial2.retested is True

    # New rows point back to their originals
    new_of_ids = {db.get(LimsAnalysis, nid).retest_of_id for nid in new_ids}
    assert new_of_ids == {vial1.id, vial2.id}


# ─── Test 5: unknown parent_sample_id → no-op ────────────────────────────────


def test_cascade_no_op_when_parent_sample_missing(seed):
    """When parent_sample_id is not in lims_samples, cascade returns [] without raising."""
    db, parent, sub, svc = seed

    vial = _make_vial_tbv(db, sub, svc)
    _promote_single(db, vial, svc)

    new_ids = cascade_parent_retest_to_sources(
        db,
        parent_sample_id="DOES-NOT-EXIST-SAMPLE",
        keyword=svc.keyword,
        user_id=None,
    )

    assert new_ids == []


# ─── Bonus: source in unassigned state → skipped ─────────────────────────────


def test_cascade_skips_source_in_ineligible_state(seed):
    """Source vial in 'unassigned' is not retest-eligible → skipped."""
    db, parent, sub, svc = seed

    # Create a vial but deliberately keep it in 'unassigned' — simulate via
    # direct INSERT so we can promote it (promotion validates to_be_verified,
    # so we bypass the state check and insert a promo row manually).
    raw_vial = LimsAnalysis(
        lims_sub_sample_pk=sub.id,
        analysis_service_id=svc.id,
        keyword=svc.keyword,
        title="TEST: unassigned vial",
        review_state="unassigned",
        result_value=None,
        retest_of_id=None,
    )
    db.add(raw_vial)
    db.flush()

    # Insert parent row directly
    parent_row = LimsAnalysis(
        lims_sample_pk=parent.id,
        lims_sub_sample_pk=None,
        analysis_service_id=svc.id,
        keyword=svc.keyword,
        title="TEST: parent for unassigned source",
        review_state="verified",
        result_value="98.00",
        retest_of_id=None,
    )
    db.add(parent_row)
    db.flush()

    # Wire up a promotion link manually
    prom = LimsAnalysisPromotion(
        parent_analysis_id=parent_row.id,
        source_analysis_id=raw_vial.id,
        contribution_kind="chosen",
        promoted_by_user_id=None,
    )
    db.add(prom)
    db.commit()

    new_ids = cascade_parent_retest_to_sources(
        db,
        parent_sample_id=parent.sample_id,
        keyword=svc.keyword,
        user_id=None,
    )

    assert new_ids == [], (
        "source in 'unassigned' must be skipped; "
        f"got {new_ids}"
    )
