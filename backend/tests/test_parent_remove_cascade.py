"""Parent-remove cascade tests.

Design: when an analysis is REMOVED from a parent AR via Manage Analyses
(the explorer delete endpoint's non-native/IS-proxy branch), cascade_parent_
remove_from_vials hard-deletes the PRISTINE vial-tier mirror rows of that
service across the family:

  parent_sample_id → LimsSample → sub-samples → active lims_analyses rows
    whose keyword ∈ candidate set (analyte-bridge translated for blend parents)
  → delete_pristine_analysis per (vial, keyword) — pristine rows are deleted
    (with an analysis_removed event), rows with ANY activity are skipped.

Remove is a mistake-correction (the row vanishes); reject is the audited
"off the offering" path. Both protect bench work in progress.

Never raises — best-effort, mirrors the retest/reject/add cascades.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from database import Base
from lims_analyses.service import (
    apply_transition,
    cascade_parent_remove_from_vials,
    create_analysis,
)
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
    LimsSubSampleEvent,
)


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
    """Parent + two sub-samples + an AnalysisService. Returns (db, parent, sub1, sub2, svc)."""
    svc = AnalysisService(title="BPC-157 - Identity (HPLC)", keyword="ID_BPC157")
    db_mem.add(svc)
    db_mem.flush()

    parent = LimsSample(sample_id="P-REMCASC-001", external_lims_uid="uid-remcasc-001")
    db_mem.add(parent)
    db_mem.flush()

    sub1 = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid="mk1://remcasc-001-S01",
        sample_id="P-REMCASC-001-S01",
        vial_sequence=1,
    )
    sub2 = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid="mk1://remcasc-001-S05",
        sample_id="P-REMCASC-001-S05",
        vial_sequence=5,
    )
    db_mem.add_all([sub1, sub2])
    db_mem.commit()

    return db_mem, parent, sub1, sub2, svc


def _vial_row(db, sub, svc, keyword=None):
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
    def _boom(pid):
        raise AssertionError("fetch_parent_analyte_slots must not be called")
    monkeypatch.setattr("sub_samples.senaite.fetch_parent_analyte_slots", _boom)


# ─── Test 1: pristine mirrors deleted on all vials, with event ───────────────


def test_cascade_deletes_pristine_rows_on_all_vials(seed, monkeypatch):
    db, parent, sub1, sub2, svc = seed
    _no_slot_fetch(monkeypatch)

    r1 = _vial_row(db, sub1, svc)
    r2 = _vial_row(db, sub2, svc)
    r1_id, r2_id = r1.id, r2.id

    out = cascade_parent_remove_from_vials(
        db, parent_sample_id=parent.sample_id, keyword=svc.keyword, user_id=None,
    )

    assert out == {
        sub1.sample_id: ["ID_BPC157"],
        sub2.sample_id: ["ID_BPC157"],
    }
    assert db.get(LimsAnalysis, r1_id) is None
    assert db.get(LimsAnalysis, r2_id) is None

    events = db.execute(
        select(LimsSubSampleEvent).where(
            LimsSubSampleEvent.event == "analysis_removed"
        )
    ).scalars().all()
    assert {e.sub_sample_pk for e in events} == {sub1.id, sub2.id}


# ─── Test 2: rows with activity are skipped ──────────────────────────────────


def test_cascade_skips_rows_with_activity(seed, monkeypatch):
    db, parent, sub1, sub2, svc = seed
    _no_slot_fetch(monkeypatch)

    r_assigned = _vial_row(db, sub1, svc)
    apply_transition(db, analysis_id=r_assigned.id, kind="assign")

    r_tbv = _vial_row(db, sub2, svc)
    apply_transition(db, analysis_id=r_tbv.id, kind="assign")
    apply_transition(db, analysis_id=r_tbv.id, kind="submit", result_value="97.1")

    out = cascade_parent_remove_from_vials(
        db, parent_sample_id=parent.sample_id, keyword=svc.keyword, user_id=None,
    )

    assert out == {}
    db.refresh(r_assigned)
    db.refresh(r_tbv)
    assert r_assigned.review_state == "assigned"
    assert r_tbv.review_state == "to_be_verified"


# ─── Test 3: keyword isolation ───────────────────────────────────────────────


def test_cascade_only_touches_matching_keyword(seed, monkeypatch):
    db, parent, sub1, sub2, svc = seed
    _no_slot_fetch(monkeypatch)

    other_svc = AnalysisService(title="Peptide Purity (HPLC)", keyword="HPLC-PUR")
    db.add(other_svc)
    db.flush()

    target = _vial_row(db, sub1, svc)
    target_id = target.id
    bystander = _vial_row(db, sub1, other_svc)

    out = cascade_parent_remove_from_vials(
        db, parent_sample_id=parent.sample_id, keyword=svc.keyword, user_id=None,
    )

    assert out == {sub1.sample_id: ["ID_BPC157"]}
    assert db.get(LimsAnalysis, target_id) is None
    db.refresh(bystander)
    assert bystander.review_state == "unassigned"


# ─── Test 4: analyte-bridge translation (blend parents) ──────────────────────


def test_cascade_translates_generic_analyte_keyword(seed, monkeypatch):
    db, parent, sub1, sub2, svc = seed

    id_svc = AnalysisService(
        title="GHK-Cu - Identity (HPLC)", keyword="ID_GHKCU", peptide_id=7,
    )
    pur_svc = AnalysisService(
        title="GHK-Cu - Purity (HPLC)", keyword="PUR_GHKCU", peptide_id=7,
    )
    generic_svc = AnalysisService(title="Analyte 1 Purity", keyword="ANALYTE-1-PUR")
    db.add_all([id_svc, pur_svc, generic_svc])
    db.flush()

    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analyte_slots",
        lambda pid: {1: "GHK-Cu - Identity (HPLC)"},
    )

    translated = _vial_row(db, sub1, pur_svc)
    fallback = _vial_row(db, sub2, generic_svc)
    translated_id, fallback_id = translated.id, fallback.id

    out = cascade_parent_remove_from_vials(
        db, parent_sample_id=parent.sample_id, keyword="ANALYTE-1-PUR", user_id=None,
    )

    assert out == {
        sub1.sample_id: ["PUR_GHKCU"],
        sub2.sample_id: ["ANALYTE-1-PUR"],
    }
    assert db.get(LimsAnalysis, translated_id) is None
    assert db.get(LimsAnalysis, fallback_id) is None


# ─── Test 5: unknown parent → no-op ──────────────────────────────────────────


def test_cascade_no_op_when_parent_missing(seed, monkeypatch):
    db, parent, sub1, sub2, svc = seed
    _no_slot_fetch(monkeypatch)

    row = _vial_row(db, sub1, svc)
    out = cascade_parent_remove_from_vials(
        db, parent_sample_id="DOES-NOT-EXIST", keyword=svc.keyword, user_id=None,
    )
    assert out == {}
    db.refresh(row)
    assert row.review_state == "unassigned"


# ─── Test 6: slot-fetch failure degrades to generic keyword only ─────────────


def test_cascade_analyte_slot_fetch_failure_degrades_gracefully(seed, monkeypatch):
    db, parent, sub1, sub2, svc = seed

    generic_svc = AnalysisService(title="Analyte 1 Purity", keyword="ANALYTE-1-PUR")
    db.add(generic_svc)
    db.flush()

    def _boom(pid):
        raise RuntimeError("SENAITE down")
    monkeypatch.setattr("sub_samples.senaite.fetch_parent_analyte_slots", _boom)

    fallback = _vial_row(db, sub1, generic_svc)
    fallback_id = fallback.id

    out = cascade_parent_remove_from_vials(
        db, parent_sample_id=parent.sample_id, keyword="ANALYTE-1-PUR", user_id=None,
    )

    assert out == {sub1.sample_id: ["ANALYTE-1-PUR"]}
    assert db.get(LimsAnalysis, fallback_id) is None
