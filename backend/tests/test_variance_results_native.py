"""_fetch_mk1_results_for_host attributes native identity rows to the row's
own peptide (COALESCE) so the variance-set verdict agrees with the COA."""
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
    assert out["HPLC-IDENTITY"]["conforms"] is True
    assert out["HPLC-IDENTITY"]["kind"] == "categorical"


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
    assert out["HPLC-IDENTITY"]["conforms"] is False
