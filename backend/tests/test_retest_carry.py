"""carry_results: verified results copied onto a retest sample as parent rows
linked (contribution_kind='carried') to the ORIGINAL vial's analysis."""
from datetime import datetime

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from database import Base
from lims_analyses.retest_carry import CARRIED, carry_results
from models import (
    AnalysisProfile,
    AnalysisService,
    LimsAnalysis,
    LimsAnalysisPromotion,
    LimsAnalysisTransition,
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
    verified_at = datetime(2026, 9, 14, 23, 23, 40)  # noqa: DTZ001 (naive TIMESTAMP)
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
    original, retest, _parents, vial = _world(db)
    out = carry_results(db, original=original, retest=retest, profile_keys=["heavy_metals"], user_id=9)
    db.commit()
    rows = _carried_rows(db, retest)
    assert [r.keyword for r in rows] == ["ARSENIC-PPM", "LEAD-PPM"]
    for r in rows:
        assert r.review_state == "verified" and r.published_at is None
        assert r.provenance == "canonical" and r.created_by_user_id == 9
        assert r.analyst_user_id == 5 and r.verified_at == datetime(2026, 9, 14, 23, 23, 40)  # noqa: DTZ001
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
    original, retest, _parents, vial = _world(db)
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


def test_two_original_rows_sharing_one_source_both_carry_once(db):
    # M6: dedupe keys on the ORIGINAL parent row, not the shared source.
    original, retest, _parents, _ = _world(db)
    arsenic_link, lead_link = db.execute(select(LimsAnalysisPromotion).order_by(
        LimsAnalysisPromotion.id)).scalars().all()
    lead_link.source_analysis_id = arsenic_link.source_analysis_id
    db.commit()
    out = carry_results(db, original=original, retest=retest, profile_keys=["heavy_metals"], user_id=None)
    db.commit()
    assert sorted(o["keyword"] for o in out) == ["ARSENIC-PPM", "LEAD-PPM"]
    again = carry_results(db, original=original, retest=retest, profile_keys=["heavy_metals"], user_id=None)
    db.commit()
    assert again == [] and len(_carried_rows(db, retest)) == 2


# Pre-flip samples (P-3182, prod 2026-10-16): the snapshot key is the
# member-less alias hplcpurity_identity; the verified HPLC rows sit on the OLD
# per-peptide services, and the native twin hplc-purity-identity holds only
# the native trio + aggregates.

ENDO_KEY = "endotoxin-usp85-lal"
NATIVE_KWS = ("HPLC-IDENTITY", "HPLC-PURITY", "HPLC-QUANTITY", "HPLC-BLEND-PURITY", "HPLC-BLEND-TOTAL")


@pytest.fixture
def no_variance_override(monkeypatch):
    # order_seed reads the lab variance override through its own SessionLocal; keep it off any real DB.
    monkeypatch.setattr("sub_samples.service._apply_variance_override", lambda _sid, raw: raw)


def _p3182(db, *, pur_state="verified", canonical=True):
    import json
    alias = AnalysisProfile(key="hplcpurity_identity", name="HPLC Purity + Identity", is_addon=False,
                            active=True, vials_required=1, fulfillment_role="hplc")
    # As catalog/hplc_native_seed.py seeds it (inactive, role hplc).
    twin = AnalysisProfile(key="hplc-purity-identity", name="HPLC Purity + Identity", is_addon=False,
                           active=False, coa_archetype="legacy_hplc", vials_required=1,
                           fulfillment_role="hplc", fulfillment_dim="role")
    endo = AnalysisProfile(key=ENDO_KEY, name="Endotoxin USP85 LAL", is_addon=True, active=True,
                           coa_archetype="limit_table")
    native = [AnalysisService(title=kw.title(), keyword=kw, origin="mk1") for kw in NATIVE_KWS]
    old = {kw: AnalysisService(title=title, keyword=kw, origin="senaite") for kw, title in (
        ("HPLC-PUR", "Peptide Purity (HPLC)"), ("ID_KPV", "KPV - Identity (HPLC)"),
        ("PEPT-Total", "Peptide Total Quantity"))}
    lal = AnalysisService(title="Endotoxin USP85 LAL", keyword="ENDOTOXIN-USP85LAL", origin="mk1",
                          unit="EU/mL")
    from models import VialRole
    db.add_all([alias, twin, endo, lal, *native, *old.values(), VialRole(code="hplc", label="HPLC", sort_order=0)])
    db.flush()
    twin.analysis_services.extend(native)
    endo.analysis_services.append(lal)
    original = LimsSample(sample_id="P-3182", external_lims_system="senaite", status="published",
                          catalog_snapshot={"profiles": [
                              {"key": "hplcpurity_identity", "profile_id": alias.id, "service_ids": []},
                              {"key": ENDO_KEY, "profile_id": endo.id, "service_ids": [lal.id]}]})
    retest = LimsSample(sample_id="P-5182", external_lims_system="mk1", status="sample_due",
                        analytes=json.dumps([{"name": "KPV - Identity (HPLC)"}]))
    db.add_all([original, retest])
    db.flush()
    vial = LimsSubSample(parent_sample_pk=original.id, external_lims_uid="v1", sample_id="P-3182-S01",
                         vial_sequence=1)
    db.add(vial)
    db.flush()
    verified_at = datetime(2026, 10, 3, 14, 5, 0)  # noqa: DTZ001
    values = {"HPLC-PUR": "99.004", "ID_KPV": "KPV", "PEPT-Total": "35.02"}
    rows = {}
    for kw, svc in old.items():
        state = pur_state if kw == "HPLC-PUR" else "verified"
        if canonical:
            row = LimsAnalysis(lims_sample_pk=original.id, analysis_service_id=svc.id, keyword=kw,
                               title=svc.title, provenance="canonical", review_state=state,
                               result_value=values[kw],
                               verified_at=verified_at if state == "verified" else None)
            src = LimsAnalysis(lims_sub_sample_pk=vial.id, analysis_service_id=svc.id, keyword=kw,
                               title=svc.title, review_state="promoted", result_value=values[kw])
            db.add_all([row, src])
            db.flush()
            db.add(LimsAnalysisPromotion(parent_analysis_id=row.id, source_analysis_id=src.id,
                                         contribution_kind="chosen"))
            rows[kw] = (row, src)
        db.add(LimsAnalysis(lims_sample_pk=original.id, analysis_service_id=svc.id, keyword=kw,
                            title=svc.title, provenance="shadow", review_state="senaite_mirror",
                            mirror_review_state="verified", result_value=values[kw]))
    db.add(LimsAnalysis(lims_sample_pk=original.id, analysis_service_id=lal.id, keyword=lal.keyword,
                        title=lal.title, provenance="canonical", review_state="published",
                        result_value="0.25", result_unit="EU/mL",
                        verified_at=datetime(2026, 10, 1, 9, 0)))  # noqa: DTZ001
    db.commit()
    return original, retest, rows, native


def _options(db, sample_id, monkeypatch):
    from lims_analyses import retest_routes
    monkeypatch.setattr(retest_routes, "_fetch_retest_context", lambda _sid: None)
    body = retest_routes.retest_options(sample_id, db=db, _user=None)
    return {p["key"]: p for p in body["profiles"]}


def _legacy_spec(**over):
    d = {"retest_of_sample_id": "P-3182", "retest": [ENDO_KEY], "carry": ["hplcpurity_identity"],
         "fee": "free", "reason": "endo re-run", "requested_by_user_id": 9}
    d.update(over)
    return d


def _live_placeholders(db, sample):
    return sorted(r.keyword for r in db.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == sample.id, LimsAnalysis.provenance == "ordered",
        LimsAnalysis.review_state.notin_(("rejected", "retracted")))).scalars())


def test_legacy_alias_reads_verified_and_carry_eligible(db, monkeypatch):
    _p3182(db)
    by_key = _options(db, "P-3182", monkeypatch)
    hplc = by_key["hplcpurity_identity"]
    assert hplc["state_label"] == "Verified 10/3" and hplc["state"] == "verified"
    assert hplc["carry_eligible"] is True and hplc["carry_blocked_reason"] is None
    # Endotoxin unchanged.
    endo = by_key[ENDO_KEY]
    assert endo["state_label"] == "Verified 10/1" and endo["carry_eligible"] is True
    assert endo["carry_blocked_reason"] is None


def test_legacy_alias_carry_copies_the_canonical_rows_and_retires_twin_placeholders(
        db, no_variance_override):
    # Order A: the registration fallback seeds the FULL order dict (native HPLC key) first.
    from lims_analyses.order_seed import seed_parent_from_services
    from lims_analyses.retest_carry import apply_retest_spec
    _, retest, rows, _ = _p3182(db)
    full = {"hplc-purity-identity": True, ENDO_KEY: True}
    seed_parent_from_services(db, parent=retest, services=full, package=None,
                              source="registration_signal")
    db.commit()
    assert _live_placeholders(db, retest) == ["ENDOTOXIN-USP85LAL", "HPLC-IDENTITY", "HPLC-PURITY",
                                              "HPLC-QUANTITY"]
    out = apply_retest_spec(db, parent=retest, raw_spec=_legacy_spec(), services=full, package=None,
                            source="order_upsert")
    db.commit()
    assert out["applied"] is True and out["carried"] == 3
    carried = db.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == retest.id, LimsAnalysis.provenance == "canonical")).scalars().all()
    assert sorted(r.keyword for r in carried) == ["HPLC-PUR", "ID_KPV", "PEPT-Total"]
    for r in carried:
        src_parent, vial_row = rows[r.keyword]
        assert r.review_state == "verified" and r.result_value == src_parent.result_value
        assert r.analysis_service_id == src_parent.analysis_service_id and r.title == src_parent.title
        [link] = db.execute(select(LimsAnalysisPromotion).where(
            LimsAnalysisPromotion.parent_analysis_id == r.id)).scalars().all()
        assert link.contribution_kind == CARRIED and link.source_analysis_id == vial_row.id
    assert not db.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == retest.id, LimsAnalysis.provenance == "shadow")).scalars().all()
    # Native twin placeholders retired; the re-tested endotoxin keeps its own.
    assert _live_placeholders(db, retest) == ["ENDOTOXIN-USP85LAL"]


def test_late_fallback_seed_does_not_remint_twin_placeholders(db, no_variance_override):
    # Order B: apply first, then the registration fallback with the full dict.
    from lims_analyses.order_seed import seed_parent_from_services
    from lims_analyses.retest_carry import apply_retest_spec
    _, retest, _, _ = _p3182(db)
    apply_retest_spec(db, parent=retest, raw_spec=_legacy_spec(), services={ENDO_KEY: True},
                      package=None, source="order_upsert")
    db.commit()
    seed_parent_from_services(db, parent=retest, services={
        "hplc-purity-identity": True, "hplcpurity_identity": True, ENDO_KEY: True},
        package=None, source="registration_signal")
    db.commit()
    assert _live_placeholders(db, retest) == ["ENDOTOXIN-USP85LAL"]


def test_hplc_in_demand_keeps_twin_placeholders(db, no_variance_override):
    from lims_analyses.order_seed import seed_parent_from_services
    from lims_analyses.retest_carry import _retire_carried_placeholders
    original, retest, _, _ = _p3182(db)
    seed_parent_from_services(db, parent=retest, services={"hplc-purity-identity": True},
                              package=None, source="registration_signal")
    assert _retire_carried_placeholders(db, parent=retest, original=original,
                                        carry_keys=["hplcpurity_identity"],
                                        demand_keys=["hplc-purity-identity"], user_id=None) == 0


def test_pending_old_service_row_blocks_the_carry_with_a_reason(db, monkeypatch):
    from lims_analyses.retest_carry import parse_retest_spec, validate_retest_spec
    from lims_analyses.service import BadRequestError
    original, *_ = _p3182(db, pur_state="to_be_verified")
    hplc = _options(db, "P-3182", monkeypatch)["hplcpurity_identity"]
    assert hplc["carry_eligible"] is False
    assert hplc["carry_blocked_reason"] == "a result is still pending"
    with pytest.raises(BadRequestError, match="cannot carry unverified"):
        validate_retest_spec(db, original=original, spec=parse_retest_spec(_legacy_spec()))


def test_shadow_only_hplc_blocks_by_default(db, monkeypatch):
    _p3182(db, canonical=False)
    hplc = _options(db, "P-3182", monkeypatch)["hplcpurity_identity"]
    assert hplc["carry_eligible"] is False and hplc["state_label"] == "Not verified"
    assert hplc["carry_blocked_reason"] == "results only in SENAITE (never verified in Mk1)"


def test_shadow_only_gate_on_copies_shadow_values_into_canonical_rows(db, monkeypatch):
    from lims_analyses import retest_carry
    monkeypatch.setattr(retest_carry, "CARRY_SHADOW_ONLY_HPLC", True)
    original, retest, _, _ = _p3182(db, canonical=False)
    assert "hplcpurity_identity" in retest_carry.carry_eligible_profile_keys(db, original)
    out = carry_results(db, original=original, retest=retest, profile_keys=["hplcpurity_identity"],
                        user_id=None)
    db.commit()
    assert sorted((o["keyword"], o["result_value"]) for o in out) == [
        ("HPLC-PUR", "99.004"), ("ID_KPV", "KPV"), ("PEPT-Total", "35.02")]
    assert {(r.provenance, r.review_state) for r in _carried_rows(db, retest)} == {("canonical", "verified")}


def test_natively_benched_pre_flip_sample_carries_its_native_rows(db, monkeypatch):
    from lims_analyses.retest_carry import carry_eligible_profile_keys
    original, retest, _, native = _p3182(db, canonical=False)
    for svc, val in zip(native[:3], ("KPV", "99.1", "35.0")):
        db.add(LimsAnalysis(lims_sample_pk=original.id, analysis_service_id=svc.id, keyword=svc.keyword,
                            title=svc.title, provenance="canonical", review_state="verified",
                            result_value=val, slot=1,
                            verified_at=datetime(2026, 10, 2, 8, 0)))  # noqa: DTZ001
    db.commit()
    assert carry_eligible_profile_keys(db, original) == {"hplcpurity_identity", ENDO_KEY}
    assert _options(db, "P-3182", monkeypatch)["hplcpurity_identity"]["state_label"] == "Verified 10/2"
    out = carry_results(db, original=original, retest=retest, profile_keys=["hplcpurity_identity"],
                        user_id=None)
    assert sorted(o["keyword"] for o in out) == ["HPLC-IDENTITY", "HPLC-PURITY", "HPLC-QUANTITY"]


# Q4 (controller ruling 2026-10-16): re-testing (or adding) the member-less
# alias seeds and snapshots its member-bearing twin, so the native-born
# re-test gets native HPLC placeholders per slot.

def _peptides(db, *names):
    from models import Peptide
    rows = [Peptide(name=n, abbreviation=n) for n in names]
    db.add_all(rows)
    db.flush()
    return [p.id for p in rows]


def _hplc_rows(db, sample):
    return sorted((r.keyword, r.slot, r.peptide_id) for r in db.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == sample.id, LimsAnalysis.provenance == "ordered",
        LimsAnalysis.review_state.notin_(("rejected", "retracted")),
        LimsAnalysis.keyword.like("HPLC-%"))).scalars())


def test_alias_retest_seeds_the_twin_trio_in_the_original_slot(db, no_variance_override):
    from lims_analyses.retest_carry import apply_retest_spec
    _, retest, _, _ = _p3182(db)
    [kpv] = _peptides(db, "KPV")
    spec = _legacy_spec(retest=["hplcpurity_identity"], carry=[ENDO_KEY])
    out = apply_retest_spec(db, parent=retest, raw_spec=spec, services={"hplcpurity_identity": True,
                            ENDO_KEY: True}, package=None, source="order_upsert")
    db.commit()
    assert out["applied"] is True and out["carried"] == 1          # the endotoxin row
    assert _hplc_rows(db, retest) == [("HPLC-IDENTITY", 1, kpv), ("HPLC-PURITY", 1, kpv),
                                      ("HPLC-QUANTITY", 1, kpv)]
    # Snapshot freezes the twin; the stored spec keeps the alias as sent.
    assert [p["key"] for p in retest.catalog_snapshot["profiles"]] == ["hplc-purity-identity"]
    assert retest.catalog_snapshot["retest"]["retest"] == ["hplcpurity_identity"]
    assert out["demand_keys"] == ["hplcpurity_identity"]


def test_alias_retest_on_a_blend_seeds_per_slot_and_the_aggregates(db, no_variance_override):
    import json

    from lims_analyses.retest_carry import apply_retest_spec
    _, retest, _, _ = _p3182(db)
    kpv, bpc = _peptides(db, "KPV", "BPC-157")
    retest.analytes = json.dumps([{"name": "KPV - Identity (HPLC)"}, {"name": "BPC-157 - Identity (HPLC)"}])
    db.commit()
    apply_retest_spec(db, parent=retest, raw_spec=_legacy_spec(retest=["hplcpurity_identity"], carry=[ENDO_KEY]),
                      services={}, package=None, source="order_upsert")
    db.commit()
    assert _hplc_rows(db, retest) == [
        ("HPLC-BLEND-PURITY", None, None), ("HPLC-BLEND-TOTAL", None, None),
        ("HPLC-IDENTITY", 1, kpv), ("HPLC-IDENTITY", 2, bpc), ("HPLC-PURITY", 1, kpv),
        ("HPLC-PURITY", 2, bpc), ("HPLC-QUANTITY", 1, kpv), ("HPLC-QUANTITY", 2, bpc)]


def test_alias_retest_variance_rides_the_seeded_hplc_key(db):
    from catalog.hplc_keys import hplc_primary_count
    from lims_analyses.retest_carry import (
        _demand_services,
        _seed_keys,
        parse_retest_spec,
    )
    from sub_samples.service import (
        derive_variance_demand,
        normalize_variance_entitlement,
    )
    _p3182(db)
    spec = parse_retest_spec(_legacy_spec(retest=["hplcpurity_identity"], carry=[ENDO_KEY],
                                          add={"profiles": [], "variance_points": 3}))
    demand = _demand_services(spec, {"hplcpurity_identity": True}, _seed_keys(db))
    assert demand == {"hplc-purity-identity": True, "variance": {"hplc-purity-identity": 3},
                      "samplevariance": True}
    assert hplc_primary_count(normalize_variance_entitlement(demand)) == 3
    assert derive_variance_demand(demand)["hplc"] == 2


def test_alias_and_twin_spellings_count_as_one_profile(db):
    from lims_analyses.retest_carry import parse_retest_spec, validate_retest_spec
    from lims_analyses.service import BadRequestError
    original, *_ = _p3182(db)
    with pytest.raises(BadRequestError, match="both retested and carried"):
        parse_retest_spec(_legacy_spec(retest=["hplc-purity-identity"], carry=["hplcpurity_identity"]))
    with pytest.raises(BadRequestError, match="already on the original"):
        validate_retest_spec(db, original=original, spec=parse_retest_spec(_legacy_spec(
            carry=[], add={"profiles": ["hplc-purity-identity"]})))
