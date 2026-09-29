"""apply_retest_spec: the S2S-side orchestration of a retest sample."""
import json

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from database import Base
from lims_analyses.parent_placeholders import PROVENANCE_ORDERED
from lims_analyses.retest_carry import apply_retest_spec
from models import (
    AnalysisProfile,
    AnalysisService,
    LimsAnalysis,
    LimsAnalysisPromotion,
    LimsSample,
    LimsSubSample,
    LimsSubSampleEvent,
    VialRole,
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


def _catalog(db):
    hplc = AnalysisProfile(key="hplcpurity_identity", name="HPLC", is_addon=False,
                           vials_required=1, fulfillment_role="hplc", fulfillment_dim="role", active=True)
    hm = AnalysisProfile(key="heavy_metals", name="Heavy Metals", is_addon=True,
                         vials_required=2, fulfillment_role="hm", fulfillment_dim="role", active=True)
    endo = AnalysisProfile(key="endotoxin-usp85-lal", name="Endotoxin", is_addon=True,
                           vials_required=1, fulfillment_role="endo85", fulfillment_dim="role", active=True)
    pur = AnalysisService(title="Peptide Purity", keyword="HPLC-PURITY", origin="mk1")
    arsenic = AnalysisService(title="Arsenic", keyword="ARSENIC-PPM", origin="mk1", unit="ug/g")
    lal = AnalysisService(title="Endotoxin", keyword="ENDOTOXIN-USP85LAL", origin="mk1", unit="EU/mL")
    db.add_all([hplc, hm, endo, pur, arsenic, lal,
                VialRole(code="hplc", label="HPLC", sort_order=0),
                VialRole(code="hm", label="Heavy Metals", sort_order=1),
                VialRole(code="endo85", label="Endotoxin", sort_order=2)])
    db.flush()
    hplc.analysis_services.append(pur)
    hm.analysis_services.append(arsenic)
    endo.analysis_services.append(lal)
    db.flush()
    return {"hplc": hplc, "hm": hm, "endo": endo, "pur": pur, "arsenic": arsenic, "lal": lal}


def _original(db, cat):
    original = LimsSample(sample_id="P-2799", external_lims_system="mk1", status="published",
                          catalog_snapshot={"profiles": [
                              {"key": "hplcpurity_identity", "profile_id": cat["hplc"].id, "service_ids": [cat["pur"].id]},
                              {"key": "heavy_metals", "profile_id": cat["hm"].id, "service_ids": [cat["arsenic"].id]},
                          ]})
    db.add(original)
    db.flush()
    vial = LimsSubSample(parent_sample_pk=original.id, external_lims_uid="vial-1", sample_id="P-2799-S02", vial_sequence=2)
    db.add(vial)
    db.flush()
    src = LimsAnalysis(lims_sub_sample_pk=vial.id, analysis_service_id=cat["arsenic"].id,
                       keyword="ARSENIC-PPM", title="Arsenic", review_state="promoted", result_value="9.077")
    parent_row = LimsAnalysis(lims_sample_pk=original.id, analysis_service_id=cat["arsenic"].id,
                              keyword="ARSENIC-PPM", title="Arsenic", provenance="canonical",
                              review_state="published", result_value="9.077", result_unit="ug/g")
    db.add_all([src, parent_row])
    db.flush()
    db.add(LimsAnalysisPromotion(parent_analysis_id=parent_row.id, source_analysis_id=src.id,
                                 contribution_kind="chosen"))
    hplc_row = LimsAnalysis(lims_sample_pk=original.id, analysis_service_id=cat["pur"].id,
                            keyword="HPLC-PURITY", title="Peptide Purity", provenance="canonical",
                            review_state="published", result_value="99.4")
    db.add(hplc_row)
    db.commit()
    return original


def _retest(db):
    # native-born (external_lims_system="mk1") HPLC placeholders need a resolvable
    # analyte slot to mint identity/purity/quantity rows (lims_analyses.hplc_native).
    row = LimsSample(sample_id="P-3017", external_lims_system="mk1", status="sample_due",
                     analytes=json.dumps([{"name": "BPC-157 - Identity (HPLC)"}]))
    db.add(row)
    db.commit()
    return row


SERVICES = {"hplcpurity_identity": True, "heavy_metals": True, "endotoxin-usp85-lal": True}


def _spec(**over):
    d = {"retest_of_sample_id": "P-2799", "retest": ["hplcpurity_identity"], "carry": ["heavy_metals"],
         "add": {"profiles": ["endotoxin-usp85-lal"], "variance_points": 0, "additional_vials": 1},
         "auto_checkin": False, "fee": "free", "reason": "re-run purity, add endo",
         "requested_by_user_id": 9, "requested_at": "2026-09-24T15:00:00Z"}
    d.update(over)
    return d


def _events(db, sample, name):
    return db.execute(select(LimsSubSampleEvent).where(
        LimsSubSampleEvent.lims_sample_pk == sample.id, LimsSubSampleEvent.event == name)).scalars().all()


def _placeholder_keywords(db, sample):
    return sorted(r.keyword for r in db.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == sample.id, LimsAnalysis.provenance == PROVENANCE_ORDERED)).scalars())


def test_applies_lineage_demand_snapshot_carry_and_events(db):
    cat = _catalog(db)
    original = _original(db, cat)
    retest = _retest(db)
    out = apply_retest_spec(db, parent=retest, raw_spec=_spec(), services=SERVICES, package=None,
                            source="test")
    db.commit()
    assert out["applied"] is True and out["carried"] == 1 and out["missing"] == []
    assert set(out["demand_keys"]) == {"hplcpurity_identity", "endotoxin-usp85-lal"}
    db.refresh(retest)
    assert retest.is_retest is True and retest.retest_of_sample_id == "P-2799"
    # Demand = retest + add; the carried profile has NO placeholder.
    assert _placeholder_keywords(db, retest) == ["ENDOTOXIN-USP85LAL", "HPLC-PURITY"]
    assert [p["key"] for p in retest.catalog_snapshot["profiles"]] == ["hplcpurity_identity", "endotoxin-usp85-lal"]
    assert retest.catalog_snapshot["retest"]["carry"] == ["heavy_metals"]
    assert retest.catalog_snapshot["retest"]["add"]["profiles"] == ["endotoxin-usp85-lal"]
    # Carried HM row, verified, linked to the original vial.
    [hm] = [r for r in db.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == retest.id, LimsAnalysis.provenance == "canonical")).scalars()]
    assert hm.keyword == "ARSENIC-PPM" and hm.review_state == "verified"
    # Events.
    [created] = _events(db, retest, "retest_created")
    assert created.details["original"] == "P-2799" and created.details["fee"] == "free"
    assert created.details["add"] == ["endotoxin-usp85-lal"]
    [carried] = _events(db, retest, "analysis_carried")
    assert carried.details["source_vial_id"] == "P-2799-S02" and carried.details["result_value"] == "9.077"
    assert _events(db, retest, "retest_spec_warning") == []
    [back] = _events(db, original, "retested_as")
    assert back.details["sample_id"] == "P-3017" and back.details["retest"] == ["hplcpurity_identity"]


def test_missing_profile_is_dropped_with_a_warning_not_a_failure(db):
    cat = _catalog(db)
    _original(db, cat)
    retest = _retest(db)
    out = apply_retest_spec(db, parent=retest, raw_spec=_spec(retest=["hplcpurity_identity", "rapid-sterility-pcr"]),
                            services=SERVICES, package=None, source="test")
    db.commit()
    assert out["applied"] is True and out["missing"] == ["rapid-sterility-pcr"]
    [warn] = _events(db, retest, "retest_spec_warning")
    assert warn.details["reason"] == "profiles_missing_on_original"
    assert retest.catalog_snapshot["retest"]["missing"] == ["rapid-sterility-pcr"]


def test_invalid_spec_seeds_everything_and_warns(db):
    cat = _catalog(db)
    _original(db, cat)
    retest = _retest(db)
    out = apply_retest_spec(db, parent=retest, raw_spec=_spec(fee="gratis"), services=SERVICES,
                            package=None, source="test")
    db.commit()
    assert out["applied"] is False
    # Fallback: normal seed over the full services dict, nothing carried, lineage untouched.
    assert _placeholder_keywords(db, retest) == ["ARSENIC-PPM", "ENDOTOXIN-USP85LAL", "HPLC-PURITY"]
    assert "retest" not in (retest.catalog_snapshot or {})
    assert retest.is_retest is False
    [warn] = _events(db, retest, "retest_spec_warning")
    assert "fee" in warn.details["message"]


def test_original_missing_seeds_everything_and_warns(db):
    _catalog(db)
    retest = _retest(db)
    out = apply_retest_spec(db, parent=retest, raw_spec=_spec(), services=SERVICES, package=None,
                            source="test")
    db.commit()
    assert out["applied"] is False
    [warn] = _events(db, retest, "retest_spec_warning")
    assert warn.details["reason"] == "original_missing"


def test_reapply_is_idempotent(db):
    cat = _catalog(db)
    _original(db, cat)
    retest = _retest(db)
    apply_retest_spec(db, parent=retest, raw_spec=_spec(), services=SERVICES, package=None, source="test")
    db.commit()
    again = apply_retest_spec(db, parent=retest, raw_spec=_spec(), services=SERVICES, package=None, source="test")
    db.commit()
    assert again["applied"] is True and again["carried"] == 0
    assert len(_events(db, retest, "retest_created")) == 1
    assert len(_events(db, retest, "analysis_carried")) == 1
    assert _placeholder_keywords(db, retest) == ["ENDOTOXIN-USP85LAL", "HPLC-PURITY"]


def test_variance_add_seeds_the_variance_service_key(db):
    cat = _catalog(db)
    _original(db, cat)
    retest = _retest(db)
    out = apply_retest_spec(db, parent=retest,
                            raw_spec=_spec(add={"profiles": [], "variance_points": 3, "additional_vials": 0}),
                            services={"hplcpurity_identity": True, "heavy_metals": True},
                            package=None, source="test")
    db.commit()
    assert out["applied"] is True
    assert retest.catalog_snapshot["retest"]["add"]["variance_points"] == 3


def _live_ordered_keywords(db, sample):
    return sorted(r.keyword for r in db.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == sample.id, LimsAnalysis.provenance == PROVENANCE_ORDERED,
        LimsAnalysis.review_state.notin_(("rejected", "retracted")))).scalars())


def test_registration_seed_first_is_corrected_on_the_first_pass(db):
    """C2: the registration fallback seeds the FULL services dict (carried HM
    included) and stamps the snapshot before the order upsert runs
    apply_retest_spec. The first pass must retire the carried placeholder and
    rewrite snapshot.profiles to the demand set."""
    from lims_analyses.order_seed import seed_parent_from_services
    cat = _catalog(db)
    _original(db, cat)
    retest = _retest(db)
    seed_parent_from_services(db, parent=retest, services={**SERVICES, "heavy_metals": {"carry": True}},
                              package=None, source="registration_signal")
    db.commit()
    assert "ARSENIC-PPM" in _live_ordered_keywords(db, retest)
    assert retest.catalog_snapshot.get("resolved_at")

    apply_retest_spec(db, parent=retest, raw_spec=_spec(), services=SERVICES, package=None, source="test")
    db.commit()
    db.refresh(retest)
    assert _live_ordered_keywords(db, retest) == ["ENDOTOXIN-USP85LAL", "HPLC-PURITY"]
    assert [p["key"] for p in retest.catalog_snapshot["profiles"]] == ["hplcpurity_identity", "endotoxin-usp85-lal"]
    assert retest.catalog_snapshot.get("resolved_at")          # other snapshot keys kept
    assert retest.catalog_snapshot["retest"]["carry"] == ["heavy_metals"]
    [rejected] = db.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == retest.id, LimsAnalysis.provenance == PROVENANCE_ORDERED,
        LimsAnalysis.keyword == "ARSENIC-PPM")).scalars().all()
    assert rejected.review_state == "rejected"
    [hm] = db.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == retest.id, LimsAnalysis.provenance == "canonical")).scalars().all()
    assert hm.keyword == "ARSENIC-PPM" and hm.review_state == "verified"


def test_fallback_warning_is_written_once_across_re_pushes(db):
    # M1: every order-upsert re-push re-runs the fallback; one warning only.
    cat = _catalog(db)
    _original(db, cat)
    retest = _retest(db)
    for _ in range(3):
        apply_retest_spec(db, parent=retest, raw_spec=_spec(fee="gratis"), services=SERVICES,
                          package=None, source="test")
        db.commit()
    assert len(_events(db, retest, "retest_spec_warning")) == 1


def test_registration_seed_after_apply_is_restricted_to_demand(db):
    """Round-2 ruling: the registration fallback firing AFTER the order upsert
    must not re-mint the carried profile's placeholder or touch the snapshot."""
    from lims_analyses.order_seed import seed_parent_from_services
    cat = _catalog(db)
    _original(db, cat)
    retest = _retest(db)
    apply_retest_spec(db, parent=retest, raw_spec=_spec(), services=SERVICES, package=None, source="test")
    db.commit()
    profiles_before = [p["key"] for p in retest.catalog_snapshot["profiles"]]
    seed_parent_from_services(db, parent=retest, services={**SERVICES, "heavy_metals": {"carry": True}},
                              package=None, source="registration_signal")
    db.commit()
    db.refresh(retest)
    assert "ARSENIC-PPM" not in _live_ordered_keywords(db, retest)
    assert _live_ordered_keywords(db, retest) == ["ENDOTOXIN-USP85LAL", "HPLC-PURITY"]
    assert [p["key"] for p in retest.catalog_snapshot["profiles"]] == profiles_before


@pytest.mark.parametrize("hplc_key", ["hplcpurity_identity", "hplc-purity-identity"])
def test_demand_services_emits_the_wp_variance_wire_shape(hplc_key):
    # Round 5: the WP/IS wire is services["variance"] = {<hplc key>: points}
    # plus services["samplevariance"] = True (prod PB-1000). No varianceMap.
    from lims_analyses.retest_carry import _demand_services, parse_retest_spec
    from sub_samples.service import normalize_variance_entitlement
    spec = parse_retest_spec(_spec(retest=[hplc_key], carry=[],
                                   add={"profiles": [], "variance_points": 4, "additional_vials": 0}))
    demand = _demand_services(spec, {hplc_key: True, "heavy_metals": True})
    assert demand == {hplc_key: True, "variance": {hplc_key: 4}, "samplevariance": True}
    assert normalize_variance_entitlement(demand) == {hplc_key: 4}


def test_late_seed_keeps_the_variance_keys_on_a_variance_retest(db):
    # Round 5: _retest_demand_only must never strip variance/samplevariance.
    from lims_analyses import order_seed
    retest = _retest(db)
    retest.catalog_snapshot = {"profiles": [], "retest": {
        "retest": ["hplc-purity-identity"], "add": {"profiles": [], "variance_points": 3}}}
    kept = order_seed._retest_demand_only(retest, {
        "hplc-purity-identity": True, "heavy_metals": True,
        "variance": {"hplc-purity-identity": 3}, "samplevariance": True})
    assert kept == {"hplc-purity-identity": True, "variance": {"hplc-purity-identity": 3},
                    "samplevariance": True}
