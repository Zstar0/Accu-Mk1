"""parse_retest_spec / validate_retest_spec: the shape and rules from spec
2026-09-23-mk1-native-retest-design.md sections 2 and 3.1."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from lims_analyses.retest_carry import (
    RetestSpec,
    carry_eligible_profile_keys,
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


@pytest.mark.parametrize("bad", [
    {"fee": "gratis"},
    {"reason": ""},
    {"retest": ["hplcpurity_identity"], "carry": ["hplcpurity_identity"]},
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


def test_every_snapshot_profile_must_be_retested_or_carried(db):
    original = _original(db)          # snapshot = hplcpurity_identity + heavy_metals
    spec = parse_retest_spec(_raw(retest=["hplcpurity_identity"], carry=[]))
    with pytest.raises(BadRequestError, match="heavy_metals"):
        validate_retest_spec(db, original=original, spec=spec)


@pytest.mark.parametrize("hplc_key", ["hplcpurity_identity", "hplc-purity-identity"])
def test_variance_accepts_either_hplc_profile_key(hplc_key):
    # Round 3: legacy samples snapshot hplcpurity_identity, native-born ones
    # (P-5000, PB-1000) hplc-purity-identity; either satisfies the variance rule.
    spec = parse_retest_spec(_raw(retest=[hplc_key],
                                  add={"profiles": [], "variance_points": 3, "additional_vials": 0}))
    assert spec.variance_points == 3
