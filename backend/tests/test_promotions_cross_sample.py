"""Promotion links whose source lives on ANOTHER sample (a carried result on a
retest) must name that sample, not render as an anonymous source."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from lims_analyses.service import list_promotions_for_parent
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsAnalysisPromotion,
    LimsSample,
    LimsSubSample,
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


# C1 (final review): source-side readers must ignore 'carried' links. A carried
# link's source is the ORIGINAL vial's analysis, so anything that walks
# source -> parent from the original must land on the original's own parent row.

def _carried_world(db):
    original = LimsSample(sample_id="P-2801", external_lims_system="mk1")
    retest = LimsSample(sample_id="P-3021", external_lims_system="mk1", retest_of_sample_id="P-2801")
    svc = AnalysisService(title="Arsenic", keyword="ARSENIC-PPM", origin="mk1")
    db.add_all([original, retest, svc])
    db.flush()
    vial = LimsSubSample(parent_sample_pk=original.id, external_lims_uid="P-2801-S02-uid",
                         sample_id="P-2801-S02", vial_sequence=2)
    db.add(vial)
    db.flush()
    src = LimsAnalysis(lims_sub_sample_pk=vial.id, analysis_service_id=svc.id, keyword="ARSENIC-PPM",
                       title="Arsenic", review_state="promoted", result_value="9.077")
    own = LimsAnalysis(lims_sample_pk=original.id, analysis_service_id=svc.id, keyword="ARSENIC-PPM",
                       title="Arsenic", provenance="canonical", review_state="verified",
                       result_value="9.077")
    db.add_all([src, own])
    db.flush()
    db.add(LimsAnalysisPromotion(parent_analysis_id=own.id, source_analysis_id=src.id,
                                 contribution_kind="chosen"))
    db.flush()
    carried = LimsAnalysis(lims_sample_pk=retest.id, analysis_service_id=svc.id, keyword="ARSENIC-PPM",
                           title="Arsenic", provenance="canonical", review_state="verified",
                           result_value="9.077")
    db.add(carried)
    db.flush()
    # The carried link is the NEWEST link on the source (highest id).
    db.add(LimsAnalysisPromotion(parent_analysis_id=carried.id, source_analysis_id=src.id,
                                 contribution_kind="carried"))
    db.commit()
    return original, retest, src, own, carried


def test_source_retest_on_original_retracts_own_parent_not_the_carried_row(db):
    from lims_analyses.service import vial_source_retest
    _, _, src, own, carried = _carried_world(db)
    vial_source_retest(db, analysis_id=src.id, user_id=None)
    db.commit()
    db.refresh(own)
    db.refresh(carried)
    assert own.review_state == "retracted" and own.result_value is None
    assert carried.review_state == "verified" and carried.result_value == "9.077"


def test_removal_tier_with_a_carried_link_does_not_raise(db):
    from lims_analyses.service import classify_removal_impact
    _, _, src, _, _ = _carried_world(db)
    impact = classify_removal_impact(db, parent_sample_id="P-2801", keyword="ARSENIC-PPM")
    assert [e["analysis_id"] for e in impact["blocked"]] == [src.id]


def test_force_retract_on_original_leaves_the_carried_row_and_link(db):
    from lims_analyses.service import force_retract_analysis
    _, _, src, own, carried = _carried_world(db)
    force_retract_analysis(db, analysis_id=src.id, user_id=None)
    db.commit()
    db.refresh(own)
    db.refresh(carried)
    assert own.review_state == "retracted"
    assert carried.review_state == "verified"
    kinds = [p.contribution_kind for p in db.query(LimsAnalysisPromotion).all()]
    assert kinds == ["carried"]


def test_parent_retest_of_a_carried_row_never_retests_the_original_vial(db):
    """Parent-side mirror of C1: retesting the carried row on the RETEST
    sample must not follow the carried link down into the original's vial."""
    from lims_analyses.service import parent_retest
    _, _, src, own, carried = _carried_world(db)
    parent_retest(db, sample_id="P-3021", keyword="ARSENIC-PPM", user_id=None)
    db.commit()
    db.refresh(src)
    db.refresh(own)
    assert src.retested is False
    assert own.review_state == "verified"
    assert db.query(LimsAnalysis).filter(LimsAnalysis.retest_of_id == src.id).count() == 0
    # Pending ruling: with the cascade filtered this is a no-op on the retest's
    # carried row (it stays verified; parent_retest returns ([], 'verified')).
    db.refresh(carried)
    assert carried.review_state == "verified"
