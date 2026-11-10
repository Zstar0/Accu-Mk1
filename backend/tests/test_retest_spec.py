"""parse_retest_spec / validate_retest_spec: the shape and rules from spec
2026-09-23-mk1-native-retest-design.md sections 2 and 3.1."""
import json

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from lims_analyses.retest_carry import (
    RetestSpec,
    carry_eligible_profile_keys,
    dropped_profile_keys,
    parse_retest_spec,
    validate_retest_spec,
)
from lims_analyses.service import BadRequestError
from models import AnalysisProfile, AnalysisService, LimsAnalysis, LimsSample


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _raw(**over):
    d = {
        "retest_of_sample_id": "P-2799",
        "retest": ["hplcpurity_identity"],
        "carry": ["heavy_metals"],
        "add": {"profiles": [], "variance_points": 0, "additional_vials": 0},
        "auto_checkin": True,
        "fee": "paid",
        "reason": "customer asked for a re-run",
        "requested_by_user_id": 9,
        "requested_at": "2026-09-24T15:00:00Z",
    }
    d.update(over)
    return d


def _original(db, *, keys=("hplcpurity_identity", "heavy_metals"), hm_state="published"):
    """Original sample with a snapshot over `keys`; HM has one parent row in hm_state."""
    hplc = AnalysisProfile(key="hplcpurity_identity", name="HPLC", is_addon=False)
    hm = AnalysisProfile(key="heavy_metals", name="Heavy Metals", is_addon=True)
    endo = AnalysisProfile(key="endotoxin-usp85-lal", name="Endotoxin", is_addon=True)
    arsenic = AnalysisService(title="Arsenic", keyword="ARSENIC-PPM", origin="mk1")
    db.add_all([hplc, hm, endo, arsenic])
    db.flush()
    hm.analysis_services.append(arsenic)
    original = LimsSample(sample_id="P-2799", external_lims_system="mk1", status="published",
                          catalog_snapshot={"profiles": [{"key": k, "profile_id": 0, "service_ids": []}
                                                         for k in keys]})
    db.add(original)
    db.flush()
    if "heavy_metals" in keys:
        db.add(LimsAnalysis(lims_sample_pk=original.id, analysis_service_id=arsenic.id,
                            keyword="ARSENIC-PPM", title="Arsenic", provenance="canonical",
                            review_state=hm_state, result_value="9.077"))
    db.commit()
    return original


# -- parse ----

def test_parse_happy_path_normalizes_to_tuples():
    spec = parse_retest_spec(_raw())
    assert isinstance(spec, RetestSpec)
    assert spec.retest == ("hplcpurity_identity",)
    assert spec.carry == ("heavy_metals",)
    assert spec.add_profiles == ()
    assert spec.variance_points == 0
    assert spec.fee == "paid"
    assert spec.auto_checkin is True


def test_parse_add_block_optional():
    spec = parse_retest_spec(_raw(add=None))
    assert spec.add_profiles == () and spec.variance_points == 0 and spec.additional_vials == 0


def test_parse_drop_defaults_to_empty_tuple():
    spec = parse_retest_spec(_raw())
    assert spec.drop == ()


def test_as_dict_includes_drop():
    spec = parse_retest_spec(_raw(drop=["endotoxin-usp85-lal"]))
    assert spec.as_dict()["drop"] == ["endotoxin-usp85-lal"]


@pytest.mark.parametrize("bad", [
    {"fee": "gratis"},
    {"reason": ""},
    {"retest": ["hplcpurity_identity"], "carry": ["hplcpurity_identity"]},
    {"retest": ["hplcpurity_identity"], "drop": ["hplcpurity_identity"]},
    {"carry": ["heavy_metals"], "drop": ["heavy_metals"]},
    {"retest": [], "add": {"profiles": [], "variance_points": 0, "additional_vials": 0}},
    {"add": {"profiles": [], "variance_points": 1, "additional_vials": 0}},
    {"add": {"profiles": [], "variance_points": 11, "additional_vials": 0}},
    {"retest": ["heavy_metals"], "carry": [],
     "add": {"profiles": [], "variance_points": 3, "additional_vials": 0}},   # variance without HPLC retest
    {"retest_of_sample_id": ""},
])
def test_parse_rejects_bad_shapes(bad):
    with pytest.raises(BadRequestError):
        parse_retest_spec(_raw(**bad))


# -- validate -

def test_carry_eligible_reads_verified_or_published_parent_rows(db):
    original = _original(db, hm_state="published")
    assert carry_eligible_profile_keys(db, original) == {"heavy_metals"}


def test_carry_of_unverified_profile_is_rejected(db):
    original = _original(db, hm_state="parent_to_verify")
    spec = parse_retest_spec(_raw())
    with pytest.raises(BadRequestError, match="heavy_metals"):
        validate_retest_spec(db, original=original, spec=spec)


def test_add_must_be_absent_from_original(db):
    original = _original(db)
    spec = parse_retest_spec(_raw(add={"profiles": ["heavy_metals"], "variance_points": 0,
                                       "additional_vials": 0}, carry=[]))
    with pytest.raises(BadRequestError, match="heavy_metals"):
        validate_retest_spec(db, original=original, spec=spec)


def test_add_of_unknown_profile_is_rejected(db):
    original = _original(db)
    spec = parse_retest_spec(_raw(add={"profiles": ["no-such-profile"], "variance_points": 0,
                                       "additional_vials": 0}))
    with pytest.raises(BadRequestError, match="no-such-profile"):
        validate_retest_spec(db, original=original, spec=spec)


def test_spec_sample_must_match_original(db):
    original = _original(db)
    spec = parse_retest_spec(_raw(retest_of_sample_id="P-0001"))
    with pytest.raises(BadRequestError):
        validate_retest_spec(db, original=original, spec=spec)


def test_keys_missing_from_snapshot_are_returned_not_raised(db):
    original = _original(db)
    spec = parse_retest_spec(_raw(retest=["hplcpurity_identity", "rapid-sterility-pcr"]))
    missing = validate_retest_spec(db, original=original, spec=spec)
    assert missing == ["rapid-sterility-pcr"]


def test_valid_spec_returns_no_missing(db):
    original = _original(db)
    assert validate_retest_spec(db, original=original, spec=parse_retest_spec(_raw())) == []


def test_profile_omitted_from_retest_and_carry_is_recorded_as_drop_not_raised(db):
    original = _original(db)          # snapshot = hplcpurity_identity + heavy_metals
    spec = parse_retest_spec(_raw(retest=["hplcpurity_identity"], carry=[]))
    assert validate_retest_spec(db, original=original, spec=spec) == []
    assert dropped_profile_keys(original, spec) == ["heavy_metals"]


def test_dropped_profile_keys_ignores_a_stale_client_drop_list(db):
    # 1.29 client omits `drop` entirely; the server fills in the omission
    # regardless of what (if anything) the client sent under `drop`.
    original = _original(db)
    spec = parse_retest_spec(_raw(retest=["hplcpurity_identity"], carry=[], drop=[]))
    assert dropped_profile_keys(original, spec) == ["heavy_metals"]


def test_drop_of_profile_not_on_original_is_rejected(db):
    original = _original(db)
    spec = parse_retest_spec(_raw(retest=["hplcpurity_identity"], carry=[],
                                  drop=["heavy_metals", "endotoxin-usp85-lal"]))
    with pytest.raises(BadRequestError, match="endotoxin-usp85-lal"):
        validate_retest_spec(db, original=original, spec=spec)


def test_drop_of_original_profile_is_accepted(db):
    original = _original(db)
    spec = parse_retest_spec(_raw(retest=["hplcpurity_identity"], carry=[], drop=["heavy_metals"]))
    assert validate_retest_spec(db, original=original, spec=spec) == []


@pytest.mark.parametrize("hplc_key", ["hplcpurity_identity", "hplc-purity-identity"])
def test_variance_accepts_either_hplc_profile_key(hplc_key):
    # Round 3: legacy samples snapshot hplcpurity_identity, native-born ones
    # (P-5000, PB-1000) hplc-purity-identity; either satisfies the variance rule.
    spec = parse_retest_spec(_raw(retest=[hplc_key],
                                  add={"profiles": [], "variance_points": 3, "additional_vials": 0}))
    assert spec.variance_points == 3


# -- add-on test Variance (Task 17): a test that ran with Variance is not retested ----

ENDO = "endotoxin-usp85-lal"
VARIANCE_REFUSAL = (f"{ENDO} ran with Variance on P-2799; "
                    "retesting a Variance test is not supported in this version")


def _variance_original(db, *, endo_replicate=True, override=None):
    """Original over HPLC, heavy metals and endotoxin (role endo85). With
    endo_replicate, one signed-off endotoxin replicate anchor vial."""
    from models import LimsSubSample
    original = _original(db, keys=("hplcpurity_identity", "heavy_metals", ENDO))
    profiles = {p.key: p for p in db.query(AnalysisProfile).all()}
    profiles[ENDO].fulfillment_role = "endo85"
    profiles["heavy_metals"].fulfillment_role = "hm"
    lal = AnalysisService(title="Endotoxin", keyword="ENDOTOXIN-USP85LAL", origin="mk1")
    db.add(lal)
    db.flush()
    profiles[ENDO].analysis_services.append(lal)
    original.variance_override = override
    for seq, kind in ((1, "core"), (2, "variance")):
        if kind == "variance" and not endo_replicate:
            continue
        vial = LimsSubSample(sample_id=f"P-2799-S{seq:02d}", parent_sample_pk=original.id,
                             external_lims_uid=f"p2799-v{seq}", vial_sequence=seq,
                             assignment_role="endo85", assignment_kind=kind, in_variance_set=True)
        db.add(vial)
        db.flush()
        db.add(LimsAnalysis(lims_sub_sample_pk=vial.id, analysis_service_id=lal.id,
                            keyword="ENDOTOXIN-USP85LAL", title="Endotoxin", result_value="0.5",
                            review_state="promoted" if kind == "core" else "variance_verified"))
    db.commit()
    return original


def test_retest_of_endotoxin_that_ran_variance_is_refused(db):
    original = _variance_original(db)
    spec = parse_retest_spec(_raw(retest=[ENDO], carry=["heavy_metals"]))
    with pytest.raises(BadRequestError, match="ran with Variance") as exc:
        validate_retest_spec(db, original=original, spec=spec)
    assert str(exc.value) == VARIANCE_REFUSAL


def test_retest_of_endotoxin_refused_on_override_alone(db):
    # No replicate vial yet; the lab override names the key.
    original = _variance_original(db, endo_replicate=False, override=json.dumps({ENDO: 3}))
    spec = parse_retest_spec(_raw(retest=[ENDO], carry=[]))
    with pytest.raises(BadRequestError) as exc:
        validate_retest_spec(db, original=original, spec=spec)
    assert str(exc.value) == VARIANCE_REFUSAL


def test_retest_of_other_test_on_a_variance_sample_is_allowed(db):
    original = _variance_original(db)
    spec = parse_retest_spec(_raw(retest=["heavy_metals"], carry=[]))
    assert validate_retest_spec(db, original=original, spec=spec) == []


def test_retest_of_endotoxin_without_variance_unchanged(db):
    original = _variance_original(db, endo_replicate=False)
    spec = parse_retest_spec(_raw(retest=[ENDO], carry=["heavy_metals"]))
    assert validate_retest_spec(db, original=original, spec=spec) == []


def test_hplc_variance_retest_unchanged(db):
    # Characterization (passes on the base): an original that ran HPLC
    # Variance (an hplc replicate anchor and an HPLC override) retests HPLC
    # with variance points exactly as before.
    from models import LimsSubSample
    original = _original(db)
    original.variance_override = json.dumps({"hplcpurity_identity": 3})
    pur = AnalysisService(title="Purity", keyword="HPLC-PURITY", origin="mk1")
    db.add(pur)
    db.flush()
    vial = LimsSubSample(sample_id="P-2799-S02", parent_sample_pk=original.id,
                         external_lims_uid="p2799-h2", vial_sequence=2,
                         assignment_role="hplc", assignment_kind="variance", in_variance_set=True)
    db.add(vial)
    db.flush()
    db.add(LimsAnalysis(lims_sub_sample_pk=vial.id, analysis_service_id=pur.id,
                        keyword="HPLC-PURITY", title="Purity", result_value="99.1",
                        review_state="variance_verified"))
    db.commit()
    spec = parse_retest_spec(_raw(retest=["hplcpurity_identity"], carry=["heavy_metals"],
                                  add={"profiles": [], "variance_points": 3, "additional_vials": 0}))
    assert validate_retest_spec(db, original=original, spec=spec) == []


def test_apply_retest_spec_falls_back_with_warning_event(db):
    from sqlalchemy import select

    from lims_analyses.retest_carry import apply_retest_spec
    from models import LimsSubSampleEvent
    from sub_samples.service import variance_plan_for_parent
    from sub_samples.variance_tests import is_retest_sample

    _variance_original(db)
    # Prod shape: the registration signal stamps retest_of_sample_id
    # (RetestOfSampleId) before the order upsert calls apply_retest_spec.
    retest = LimsSample(sample_id="P-3017", external_lims_system="mk1", status="sample_due",
                        retest_of_sample_id="P-2799")
    db.add(retest)
    db.commit()
    services = {ENDO: True, "samplevariance": True, "variance": {ENDO: 3}}
    out = apply_retest_spec(db, parent=retest, raw_spec=_raw(retest=[ENDO], carry=[]),
                            services=services, package=None, source="test")
    db.commit()
    assert out["applied"] is False
    warns = db.execute(select(LimsSubSampleEvent).where(
        LimsSubSampleEvent.lims_sample_pk == retest.id,
        LimsSubSampleEvent.event == "retest_spec_warning")).scalars().all()
    assert len(warns) == 1
    assert warns[0].details["reason"] == "invalid_spec"
    assert warns[0].details["message"] == VARIANCE_REFUSAL
    # Pinned so a change is deliberate (see the Task 17 report): the fallback
    # keeps the signal's lineage, so the sample still reads as a retest and
    # its four-key entry is a note, not a replicate plan.
    assert is_retest_sample(retest) is True
    plan = variance_plan_for_parent(db, retest, services)
    assert plan.by_role == {}
    assert plan.notes == (f"Variance for {ENDO} is not carried to a retest in this version",)
