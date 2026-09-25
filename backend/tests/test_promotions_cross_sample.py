"""Promotion links whose source lives on ANOTHER sample (a carried result on a
retest) must name that sample, not render as an anonymous source."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from lims_analyses.service import list_promotions_for_parent
from models import AnalysisService, LimsAnalysis, LimsAnalysisPromotion, LimsSample, LimsSubSample


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def test_source_on_another_sample_reports_its_parent_and_vial(db):
    original = LimsSample(sample_id="P-2799", external_lims_system="mk1")
    retest = LimsSample(sample_id="P-3017", external_lims_system="mk1", retest_of_sample_id="P-2799")
    svc = AnalysisService(title="Arsenic", keyword="ARSENIC-PPM", origin="mk1")
    db.add_all([original, retest, svc])
    db.flush()
    vial = LimsSubSample(parent_sample_pk=original.id, external_lims_uid="P-2799-S02-uid", sample_id="P-2799-S02", vial_sequence=2)
    db.add(vial)
    db.flush()
    src = LimsAnalysis(lims_sub_sample_pk=vial.id, analysis_service_id=svc.id, keyword="ARSENIC-PPM",
                       title="Arsenic", review_state="promoted", result_value="9.077")
    carried = LimsAnalysis(lims_sample_pk=retest.id, analysis_service_id=svc.id, keyword="ARSENIC-PPM",
                           title="Arsenic", review_state="verified", result_value="9.077")
    db.add_all([src, carried])
    db.flush()
    db.add(LimsAnalysisPromotion(parent_analysis_id=carried.id, source_analysis_id=src.id,
                                 contribution_kind="carried"))
    db.commit()

    [info] = list_promotions_for_parent(db, "P-3017")
    [source] = info.sources
    assert source.contribution_kind == "carried"
    assert source.sample_id == "P-2799-S02"
    assert source.parent_sample_id == "P-2799"


def test_parent_hosted_source_reports_parent_only(db):
    original = LimsSample(sample_id="P-2700", external_lims_system="mk1")
    retest = LimsSample(sample_id="P-3018", external_lims_system="mk1", retest_of_sample_id="P-2700")
    svc = AnalysisService(title="Endotoxin", keyword="ENDO", origin="mk1")
    db.add_all([original, retest, svc])
    db.flush()
    src = LimsAnalysis(lims_sample_pk=original.id, analysis_service_id=svc.id, keyword="ENDO",
                       title="Endotoxin", review_state="published", result_value="2.5")
    carried = LimsAnalysis(lims_sample_pk=retest.id, analysis_service_id=svc.id, keyword="ENDO",
                           title="Endotoxin", review_state="verified", result_value="2.5")
    db.add_all([src, carried])
    db.flush()
    db.add(LimsAnalysisPromotion(parent_analysis_id=carried.id, source_analysis_id=src.id,
                                 contribution_kind="carried"))
    db.commit()

    [info] = list_promotions_for_parent(db, "P-3018")
    [source] = info.sources
    assert source.sample_id is None
    assert source.parent_sample_id == "P-2700"
