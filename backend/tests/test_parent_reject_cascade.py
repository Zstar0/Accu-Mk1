"""Parent-reject cascade tests.

Design: when a PARENT analysis is rejected in SENAITE (service removed from
the offering), cascade_parent_reject_to_vials rejects the UNPOPULATED vial-tier
mirror rows of that service across the family:

  parent_sample_id → LimsSample → sub-samples → lims_analyses rows where
    keyword ∈ candidate set (analyte-bridge translated for blend parents)
    AND review_state ∈ {unassigned, assigned}
    AND result_value IS NULL
  → apply_transition(kind="reject") per row

Rows carrying results (assigned-with-result, to_be_verified, promoted, …) are
NEVER touched — rejecting submitted bench work is a human decision.

Never raises — best-effort, mirrors cascade_parent_retest_to_sources.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from lims_analyses.service import (
    apply_transition,
    cascade_parent_reject_to_vials,
    create_analysis,
)
from models import AnalysisService, LimsAnalysis, LimsSample, LimsSubSample


# ─── Fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture
def db_mem():
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
    """Parent LimsSample + two LimsSubSamples + an AnalysisService.

    Returns (db, parent, sub1, sub2, svc).
    """
    svc = AnalysisService(title="BPC-157 - Identity (HPLC)", keyword="ID_BPC157")
    db_mem.add(svc)
    db_mem.flush()

    parent = LimsSample(sample_id="P-REJCASC-001", external_lims_uid="uid-rejcasc-001")
    db_mem.add(parent)
    db_mem.flush()

    sub1 = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid="uid-rejcasc-001-S01",
        sample_id="P-REJCASC-001-S01",
        vial_sequence=1,
    )
    sub2 = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid="uid-rejcasc-001-S05",
        sample_id="P-REJCASC-001-S05",
        vial_sequence=5,
    )
    db_mem.add_all([sub1, sub2])
    db_mem.commit()

    return db_mem, parent, sub1, sub2, svc


def _vial_row(db, sub, svc, keyword=None):
    """Create an unassigned vial-tier mirror row."""
    return create_analysis(
        db,
        host_kind="sub_sample",
        host_pk=sub.id,
        analysis_service_id=svc.id,
        keyword=keyword or svc.keyword,
        title="TEST: " + (svc.title or svc.keyword),
        result_value=None,
    )


def _no_slot_fetch(monkeypatch):
    """Non-analyte keywords must never hit SENAITE for the slot map."""
    def _boom(pid):
        raise AssertionError("fetch_parent_analyte_slots must not be called")
    monkeypatch.setattr("sub_samples.senaite.fetch_parent_analyte_slots", _boom)


# ─── Test 1: rejects unpopulated mirrors across all vials ────────────────────


def test_cascade_rejects_unpopulated_rows_on_all_vials(seed, monkeypatch):
    db, parent, sub1, sub2, svc = seed
    _no_slot_fetch(monkeypatch)

    r1 = _vial_row(db, sub1, svc)                       # unassigned, no result
    r2 = _vial_row(db, sub2, svc)                       # unassigned, no result
    apply_transition(db, analysis_id=r2.id, kind="assign")  # assigned, no result

    rejected = cascade_parent_reject_to_vials(
        db, parent_sample_id=parent.sample_id, keyword=svc.keyword, user_id=None,
    )

    assert sorted(rejected) == sorted([r1.id, r2.id])
    db.refresh(r1)
    db.refresh(r2)
    assert r1.review_state == "rejected"
    assert r2.review_state == "rejected"


# ─── Test 2: populated / in-flight rows are never touched ────────────────────


def test_cascade_skips_rows_with_results(seed, monkeypatch):
    db, parent, sub1, sub2, svc = seed
    _no_slot_fetch(monkeypatch)

    # assigned WITH a saved result — populated, must be skipped
    r_assigned = _vial_row(db, sub1, svc)
    apply_transition(db, analysis_id=r_assigned.id, kind="assign")
    r_assigned.result_value = "98.7"
    db.commit()

    # to_be_verified — submitted bench work, must be skipped
    r_tbv = _vial_row(db, sub2, svc)
    apply_transition(db, analysis_id=r_tbv.id, kind="assign")
    apply_transition(db, analysis_id=r_tbv.id, kind="submit", result_value="97.1")

    rejected = cascade_parent_reject_to_vials(
        db, parent_sample_id=parent.sample_id, keyword=svc.keyword, user_id=None,
    )

    assert rejected == []
    db.refresh(r_assigned)
    db.refresh(r_tbv)
    assert r_assigned.review_state == "assigned"
    assert r_tbv.review_state == "to_be_verified"


# ─── Test 3: keyword mismatch / other services untouched ─────────────────────


def test_cascade_only_touches_matching_keyword(seed, monkeypatch):
    db, parent, sub1, sub2, svc = seed
    _no_slot_fetch(monkeypatch)

    other_svc = AnalysisService(title="Peptide Purity (HPLC)", keyword="HPLC-PUR")
    db.add(other_svc)
    db.flush()

    target = _vial_row(db, sub1, svc)
    bystander = _vial_row(db, sub1, other_svc)

    rejected = cascade_parent_reject_to_vials(
        db, parent_sample_id=parent.sample_id, keyword=svc.keyword, user_id=None,
    )

    assert rejected == [target.id]
    db.refresh(bystander)
    assert bystander.review_state == "unassigned"


# ─── Test 4: unknown parent → no-op ──────────────────────────────────────────


def test_cascade_no_op_when_parent_missing(seed, monkeypatch):
    db, parent, sub1, sub2, svc = seed
    _no_slot_fetch(monkeypatch)

    _vial_row(db, sub1, svc)
    rejected = cascade_parent_reject_to_vials(
        db, parent_sample_id="DOES-NOT-EXIST", keyword=svc.keyword, user_id=None,
    )
    assert rejected == []


# ─── Test 5: analyte-bridge translation (blend parents) ──────────────────────


def test_cascade_translates_generic_analyte_keyword(seed, monkeypatch):
    """Parent carries ANALYTE-1-PUR; the vial mirror carries the translated
    per-substance PUR_<X> row. The cascade must resolve slot 1 → identity
    title → peptide → PUR_<X> and reject that row. Generic fallback rows
    (keyword ANALYTE-1-PUR seeded when translation failed) are also caught."""
    db, parent, sub1, sub2, svc = seed

    id_svc = AnalysisService(
        title="GHK-Cu - Identity (HPLC)", keyword="ID_GHKCU", peptide_id=7,
    )
    pur_svc = AnalysisService(
        title="GHK-Cu - Purity (HPLC)", keyword="PUR_GHKCU", peptide_id=7,
    )
    generic_svc = AnalysisService(
        title="Analyte 1 Purity", keyword="ANALYTE-1-PUR",
    )
    db.add_all([id_svc, pur_svc, generic_svc])
    db.flush()

    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analyte_slots",
        lambda pid: {1: "GHK-Cu - Identity (HPLC)"},
    )

    translated = _vial_row(db, sub1, pur_svc)        # PUR_GHKCU mirror
    fallback = _vial_row(db, sub2, generic_svc)      # generic fallback mirror

    rejected = cascade_parent_reject_to_vials(
        db, parent_sample_id=parent.sample_id, keyword="ANALYTE-1-PUR", user_id=None,
    )

    assert sorted(rejected) == sorted([translated.id, fallback.id])
    db.refresh(translated)
    db.refresh(fallback)
    assert translated.review_state == "rejected"
    assert fallback.review_state == "rejected"


# ─── Test 6: slot-fetch failure degrades to generic keyword only ─────────────


def test_cascade_analyte_slot_fetch_failure_degrades_gracefully(seed, monkeypatch):
    """If the SENAITE slot read fails, the cascade must not raise — it falls
    back to the generic keyword so fallback-seeded rows still get rejected."""
    db, parent, sub1, sub2, svc = seed

    generic_svc = AnalysisService(title="Analyte 1 Purity", keyword="ANALYTE-1-PUR")
    db.add(generic_svc)
    db.flush()

    def _boom(pid):
        raise RuntimeError("SENAITE down")
    monkeypatch.setattr("sub_samples.senaite.fetch_parent_analyte_slots", _boom)

    fallback = _vial_row(db, sub1, generic_svc)

    rejected = cascade_parent_reject_to_vials(
        db, parent_sample_id=parent.sample_id, keyword="ANALYTE-1-PUR", user_id=None,
    )

    assert rejected == [fallback.id]
    db.refresh(fallback)
    assert fallback.review_state == "rejected"
