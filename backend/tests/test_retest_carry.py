"""carry_results: verified results copied onto a retest sample as parent rows
linked (contribution_kind='carried') to the ORIGINAL vial's analysis."""
from datetime import datetime

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from database import Base
from lims_analyses.retest_carry import CARRIED, carry_results
from models import (AnalysisProfile, AnalysisService, LimsAnalysis, LimsAnalysisPromotion,
                    LimsAnalysisTransition, LimsSample, LimsSubSample)


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _world(db, *, vial_source=True, state="published"):
    hm = AnalysisProfile(key="heavy_metals", name="Heavy Metals", is_addon=True)
    arsenic = AnalysisService(title="Arsenic", keyword="ARSENIC-PPM", origin="mk1", unit="ug/g")
    lead = AnalysisService(title="Lead", keyword="LEAD-PPM", origin="mk1", unit="ug/g")
    db.add_all([hm, arsenic, lead])
    db.flush()
    hm.analysis_services.extend([arsenic, lead])
    original = LimsSample(sample_id="P-2799", external_lims_system="mk1", status="published",
                          catalog_snapshot={"profiles": [{"key": "heavy_metals", "profile_id": hm.id,
                                                          "service_ids": [arsenic.id, lead.id]}]})
    retest = LimsSample(sample_id="P-3017", external_lims_system="mk1", status="sample_due",
                        retest_of_sample_id="P-2799")
    db.add_all([original, retest])
    db.flush()
    vial = LimsSubSample(parent_sample_pk=original.id, external_lims_uid="vial-1", sample_id="P-2799-S02", vial_sequence=2)
    db.add(vial)
    db.flush()
    verified_at = datetime(2026, 9, 14, 23, 23, 40)
    parents = {}
    for svc, val in ((arsenic, "9.077"), (lead, "0.522")):
        parent_row = LimsAnalysis(lims_sample_pk=original.id, analysis_service_id=svc.id,
                                  keyword=svc.keyword, title=svc.title, provenance="canonical",
                                  review_state=state, result_value=val, result_unit="ug/g",
                                  analyst_user_id=5, verified_at=verified_at)
        db.add(parent_row)
        db.flush()
        parents[svc.keyword] = parent_row
        if vial_source:
            src = LimsAnalysis(lims_sub_sample_pk=vial.id, analysis_service_id=svc.id,
                               keyword=svc.keyword, title=svc.title, review_state="promoted",
                               result_value=val, result_unit="ug/g")
            db.add(src)
            db.flush()
            db.add(LimsAnalysisPromotion(parent_analysis_id=parent_row.id, source_analysis_id=src.id,
                                         contribution_kind="chosen"))
    db.commit()
    return original, retest, parents, vial


def _carried_rows(db, retest):
    return db.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == retest.id, LimsAnalysis.lims_sub_sample_pk.is_(None)
    ).order_by(LimsAnalysis.keyword)).scalars().all()


def test_carries_each_verified_row_linked_to_the_original_vial(db):
    original, retest, parents, vial = _world(db)
    out = carry_results(db, original=original, retest=retest, profile_keys=["heavy_metals"], user_id=9)
    db.commit()
    rows = _carried_rows(db, retest)
    assert [r.keyword for r in rows] == ["ARSENIC-PPM", "LEAD-PPM"]
    for r in rows:
        assert r.review_state == "verified" and r.published_at is None
        assert r.provenance == "canonical" and r.created_by_user_id == 9
        assert r.analyst_user_id == 5 and r.verified_at == datetime(2026, 9, 14, 23, 23, 40)
        assert r.result_unit == "ug/g"
        [link] = db.execute(select(LimsAnalysisPromotion).where(
            LimsAnalysisPromotion.parent_analysis_id == r.id)).scalars().all()
        assert link.contribution_kind == CARRIED
        src = db.get(LimsAnalysis, link.source_analysis_id)
        assert src.lims_sub_sample_pk == vial.id           # the ORIGINAL vial, not the parent row
        [t] = db.execute(select(LimsAnalysisTransition).where(
            LimsAnalysisTransition.analysis_id == r.id)).scalars().all()
        assert t.to_state == "verified" and t.details["carried_from"] == src.id
    assert {o["keyword"] for o in out} == {"ARSENIC-PPM", "LEAD-PPM"}
    assert all(o["source_vial_id"] == "P-2799-S02" and o["source_sample_id"] == "P-2799" for o in out)
    # No vial rows minted on the retest.
    assert db.execute(select(LimsSubSample).where(LimsSubSample.parent_sample_pk == retest.id)
                      ).scalars().all() == []


def test_legacy_parent_row_without_link_is_the_source_itself(db):
    original, retest, parents, _ = _world(db, vial_source=False)
    carry_results(db, original=original, retest=retest, profile_keys=["heavy_metals"], user_id=None)
    db.commit()
    for r in _carried_rows(db, retest):
        [link] = db.execute(select(LimsAnalysisPromotion).where(
            LimsAnalysisPromotion.parent_analysis_id == r.id)).scalars().all()
        assert link.source_analysis_id == parents[r.keyword].id


def test_carry_of_a_carried_row_links_to_the_ultimate_source(db):
    original, retest, parents, vial = _world(db)
    carry_results(db, original=original, retest=retest, profile_keys=["heavy_metals"], user_id=None)
    db.commit()
    third = LimsSample(sample_id="P-3050", external_lims_system="mk1", retest_of_sample_id="P-3017")
    db.add(third)
    db.commit()
    carry_results(db, original=retest, retest=third, profile_keys=["heavy_metals"], user_id=None)
    db.commit()
    for r in _carried_rows(db, third):
        [link] = db.execute(select(LimsAnalysisPromotion).where(
            LimsAnalysisPromotion.parent_analysis_id == r.id)).scalars().all()
        assert db.get(LimsAnalysis, link.source_analysis_id).lims_sub_sample_pk == vial.id


def test_is_idempotent(db):
    original, retest, _, _ = _world(db)
    carry_results(db, original=original, retest=retest, profile_keys=["heavy_metals"], user_id=None)
    db.commit()
    again = carry_results(db, original=original, retest=retest, profile_keys=["heavy_metals"], user_id=None)
    db.commit()
    assert again == []
    assert len(_carried_rows(db, retest)) == 2


def test_skips_rows_that_are_not_verified_or_published(db):
    original, retest, _, _ = _world(db, state="parent_to_verify")
    out = carry_results(db, original=original, retest=retest, profile_keys=["heavy_metals"], user_id=None)
    assert out == [] and _carried_rows(db, retest) == []


# I2: eligibility is per mk1 member, and a lab-withdrawn member rides as a
# rejected marker row so the retest COA's withdrawn check passes.

def test_profile_with_a_pending_member_is_not_carry_eligible(db):
    from lims_analyses.retest_carry import carry_eligible_profile_keys
    original, retest, parents, _ = _world(db)
    parents["LEAD-PPM"].review_state = "parent_to_verify"
    db.commit()
    assert carry_eligible_profile_keys(db, original) == set()
    assert carry_results(db, original=original, retest=retest, profile_keys=["heavy_metals"],
                         user_id=None) == []


def test_withdrawn_member_is_eligible_and_rides_as_a_rejected_marker(db):
    from coa.native_sections import _withdrawn_by_lab
    from lims_analyses.retest_carry import carry_eligible_profile_keys
    original, retest, parents, _ = _world(db)
    lead = parents["LEAD-PPM"]
    lead.review_state = "rejected"
    db.commit()
    assert carry_eligible_profile_keys(db, original) == {"heavy_metals"}
    out = carry_results(db, original=original, retest=retest, profile_keys=["heavy_metals"], user_id=9)
    db.commit()
    assert [o["keyword"] for o in out] == ["ARSENIC-PPM"]
    rows = {r.keyword: r for r in _carried_rows(db, retest)}
    assert rows["ARSENIC-PPM"].review_state == "verified"
    marker = rows["LEAD-PPM"]
    assert marker.review_state == "rejected" and marker.result_value is None
    assert marker.provenance == "canonical"
    assert db.execute(select(LimsAnalysisPromotion).where(
        LimsAnalysisPromotion.parent_analysis_id == marker.id)).scalars().all() == []
    [t] = db.execute(select(LimsAnalysisTransition).where(
        LimsAnalysisTransition.analysis_id == marker.id)).scalars().all()
    assert t.from_state is None and t.to_state == "rejected" and t.transition_kind == "auto"
    assert t.reason == "withdrawn on P-2799"
    assert _withdrawn_by_lab(db, retest.id, lead.analysis_service_id)
    # Idempotent: a second pass mints neither a carried row nor a second marker.
    assert carry_results(db, original=original, retest=retest, profile_keys=["heavy_metals"],
                         user_id=9) == []
    db.commit()
    assert len(_carried_rows(db, retest)) == 2


def test_never_seeded_member_does_not_block_the_carry(db):
    # e.g. HPLC-BLEND-* on a single-analyte sample: no row at any tier.
    from lims_analyses.retest_carry import carry_eligible_profile_keys
    original, _, _, _ = _world(db)
    hm = db.execute(select(AnalysisProfile)).scalars().one()
    extra = AnalysisService(title="Blend Total", keyword="HPLC-BLEND-TOTAL", origin="mk1")
    db.add(extra)
    db.flush()
    hm.analysis_services.append(extra)
    db.commit()
    assert carry_eligible_profile_keys(db, original) == {"heavy_metals"}
