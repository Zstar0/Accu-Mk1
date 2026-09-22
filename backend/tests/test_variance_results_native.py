"""_fetch_mk1_results_for_host attributes native identity rows to the row's
own peptide (COALESCE) so the variance-set verdict agrees with the COA."""
import json

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from models import AnalysisService, LimsAnalysis, LimsSample, LimsSubSample, Peptide
from sub_samples.service import _fetch_mk1_results_for_host


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def test_native_identity_conforms_via_row_peptide(db):
    pep = Peptide(name="BPC-157", abbreviation="BPC157", active=True)
    svc = AnalysisService(title="HPLC Identity", keyword="HPLC-IDENTITY", origin="mk1")
    parent = LimsSample(sample_id="P-5200", external_lims_system="mk1", external_lims_uid=None,
                        sample_type_title="Peptide")
    db.add_all([pep, svc, parent]); db.flush()
    sub = LimsSubSample(parent_sample_pk=parent.id, sample_id="P-5200-S01",
                        external_lims_uid="mk1://p5200v1", vial_sequence=1)
    db.add(sub); db.flush()
    db.add(LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
                        keyword="HPLC-IDENTITY", title="BPC-157 - Identity (HPLC)",
                        result_value="Conforms", review_state="to_be_verified",
                        peptide_id=pep.id, slot=1))
    db.flush()
    out = _fetch_mk1_results_for_host(db, host_kind="sub_sample", host_pk=sub.id)
    assert out["ANALYTE-1-ID"]["conforms"] is True
    assert out["ANALYTE-1-ID"]["kind"] == "categorical"


def test_native_identity_does_not_conform(db):
    pep = Peptide(name="BPC-157", abbreviation="BPC157", active=True)
    svc = AnalysisService(title="HPLC Identity", keyword="HPLC-IDENTITY", origin="mk1")
    parent = LimsSample(sample_id="P-5201", external_lims_system="mk1", external_lims_uid=None,
                        sample_type_title="Peptide")
    db.add_all([pep, svc, parent]); db.flush()
    sub = LimsSubSample(parent_sample_pk=parent.id, sample_id="P-5201-S01",
                        external_lims_uid="mk1://p5201v1", vial_sequence=1)
    db.add(sub); db.flush()
    db.add(LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
                        keyword="HPLC-IDENTITY", title="BPC-157 - Identity (HPLC)",
                        result_value="Does Not Conform", review_state="to_be_verified",
                        peptide_id=pep.id, slot=1))
    db.flush()
    out = _fetch_mk1_results_for_host(db, host_kind="sub_sample", host_pk=sub.id)
    assert out["ANALYTE-1-ID"]["conforms"] is False


def test_native_identity_name_value_conforms_via_coalesced_row_peptide(db):
    """I-2 (final review 2026-09-12): discriminates the COALESCE join at
    sub_samples/service.py::_fetch_mk1_results_for_host. result_value is the
    peptide NAME (not a pass/fail token), peptide_id lives on the ROW, and
    the generic service carries no peptide_id -- conforms can only be True
    if peptide_by_analysis resolves via the row's peptide_id (the COALESCE),
    which feeds identity_conforms' name-match arm (sub_samples/variance.py:76-79)."""
    pep = Peptide(name="BPC-157", abbreviation="BPC157", active=True)
    svc = AnalysisService(title="HPLC Identity", keyword="HPLC-IDENTITY", origin="mk1")
    parent = LimsSample(sample_id="P-5202", external_lims_system="mk1", external_lims_uid=None,
                        sample_type_title="Peptide")
    db.add_all([pep, svc, parent]); db.flush()
    sub = LimsSubSample(parent_sample_pk=parent.id, sample_id="P-5202-S01",
                        external_lims_uid="mk1://p5202v1", vial_sequence=1)
    db.add(sub); db.flush()
    db.add(LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
                        keyword="HPLC-IDENTITY", title="BPC-157 - Identity (HPLC)",
                        result_value="BPC-157", review_state="to_be_verified",
                        peptide_id=pep.id, slot=1))
    db.flush()
    out = _fetch_mk1_results_for_host(db, host_kind="sub_sample", host_pk=sub.id)
    assert out["ANALYTE-1-ID"]["conforms"] is True


def test_native_identity_name_value_without_row_peptide_does_not_conform(db):
    """Sibling of the above with peptide_id=None on the row: the COALESCE
    has nothing to fall back to (the generic service has no peptide_id
    either), peptide_by_analysis resolves to None, and identity_conforms'
    name-match arm can never fire -- conforms is False."""
    pep = Peptide(name="BPC-157", abbreviation="BPC157", active=True)
    svc = AnalysisService(title="HPLC Identity", keyword="HPLC-IDENTITY", origin="mk1")
    parent = LimsSample(sample_id="P-5203", external_lims_system="mk1", external_lims_uid=None,
                        sample_type_title="Peptide")
    db.add_all([pep, svc, parent]); db.flush()
    sub = LimsSubSample(parent_sample_pk=parent.id, sample_id="P-5203-S01",
                        external_lims_uid="mk1://p5203v1", vial_sequence=1)
    db.add(sub); db.flush()
    db.add(LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
                        keyword="HPLC-IDENTITY", title="BPC-157 - Identity (HPLC)",
                        result_value="BPC-157", review_state="to_be_verified",
                        peptide_id=None, slot=1))
    db.flush()
    out = _fetch_mk1_results_for_host(db, host_kind="sub_sample", host_pk=sub.id)
    assert out["ANALYTE-1-ID"]["conforms"] is False


def test_native_blend_results_do_not_collide(db):
    """A native blend's two occupied slots share the generic HPLC-PURITY
    keyword -- without the per-slot wire_keyword re-key, slot 2's result
    would overwrite slot 1's under one raw-keyword dict key (Task 4)."""
    pep1 = Peptide(name="BPC-157", abbreviation="BPC157", active=True)
    pep2 = Peptide(name="TB-500", abbreviation="TB500", active=True)
    svc = AnalysisService(title="HPLC Purity", keyword="HPLC-PURITY", origin="mk1")
    parent = LimsSample(sample_id="P-5300", external_lims_system="mk1", external_lims_uid=None,
                        sample_type_title="Peptide")
    db.add_all([pep1, pep2, svc, parent]); db.flush()
    parent.analytes = json.dumps([
        {"name": pep1.name, "peptide_id": pep1.id},
        {"name": pep2.name, "peptide_id": pep2.id},
    ])
    sub = LimsSubSample(parent_sample_pk=parent.id, sample_id="P-5300-S01",
                        external_lims_uid="mk1://p5300v1", vial_sequence=1)
    db.add(sub); db.flush()
    db.add(LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
                        keyword="HPLC-PURITY", title="BPC-157 - Purity (HPLC)",
                        result_value="98", review_state="to_be_verified",
                        peptide_id=pep1.id, slot=1))
    db.add(LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
                        keyword="HPLC-PURITY", title="TB-500 - Purity (HPLC)",
                        result_value="96", review_state="to_be_verified",
                        peptide_id=pep2.id, slot=2))
    db.flush()
    out = _fetch_mk1_results_for_host(db, host_kind="sub_sample", host_pk=sub.id)
    assert out["ANALYTE-1-PUR"]["value"] == "98"
    assert out["ANALYTE-2-PUR"]["value"] == "96"
    assert "HPLC-PURITY" not in out
