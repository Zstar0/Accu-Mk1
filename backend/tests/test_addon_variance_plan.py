"""resolve_variance_plan: the one resolver from services.variance to
replicate runs and vials per role, for the four add-on Variance tests
(plan 3 Task 1, rulings R2, R6, R8)."""
import pytest

from models import AnalysisProfile, LimsAnalysis, LimsSample, LimsSubSample, VialRole
from sub_samples.variance_tests import (
    RoleVariance, VariancePlan, is_bac_water_sample, is_retest_sample,
    replicate_anchor_vials, resolve_variance_plan,
)

ENDO, PCR, USP71, HM = ("endotoxin-usp85-lal", "rapid-sterility-pcr",
                        "sterility-usp71", "heavy_metals")
ALL_FOUR = {ENDO: True, PCR: True, USP71: True, HM: True}


def _role(db, code, eligible=True):
    r = VialRole(code=code, label=code.upper(), variance_eligible=eligible)
    db.add(r); db.flush()
    return r


def _prof(db, key, role, vials=1, analytical=None, dim="role", active=True):
    p = AnalysisProfile(
        key=key, name=f"T {key}", is_addon=True, vials_required=vials,
        analytical_vials=analytical, fulfillment_dim=dim,
        fulfillment_role=role, active=active,
    )
    db.add(p); db.flush()
    return p


@pytest.fixture
def cat(db_session):
    for code in ("endo85", "pcr", "usp71", "hm"):
        _role(db_session, code)
    _prof(db_session, ENDO, "endo85")
    _prof(db_session, PCR, "pcr")
    _prof(db_session, USP71, "usp71")
    _prof(db_session, HM, "hm", vials=2, analytical=1)
    return db_session


def _plan(db, services, **kw):
    kw.setdefault("native_born", True)
    kw.setdefault("bac_water", False)
    return resolve_variance_plan(db, services, **kw)


def _profile(db, key):
    return db.query(AnalysisProfile).filter_by(key=key).one()


def test_four_keys_resolve_to_roles_runs_and_vials(cat):
    plan = _plan(cat, {**ALL_FOUR, "variance": {ENDO: 3, PCR: 2, USP71: 2, HM: 2}})
    assert plan.errors == ()
    endo = plan.by_role["endo85"]
    assert endo == RoleVariance(ENDO, "endo85", 3, 1, 1)
    assert endo.replicate_runs == 2
    assert endo.replicate_vials == 2
    assert endo.pooled is False
    assert endo.run_label == "Vial"
    hm = plan.by_role["hm"]
    assert hm.replicate_vials == 2
    assert hm.pooled is True
    assert hm.run_label == "Digest"
    assert set(plan.by_role) == {"endo85", "pcr", "usp71", "hm"}
    assert plan.for_key(PCR) is plan.by_role["pcr"]
    assert plan.for_key("hplcpurity_identity") is None
    assert plan.error_for(ENDO) is None


def test_legacy_and_hplc_keys_are_ignored_here(cat):
    plan = _plan(cat, {"hplcpurity_identity": True, "variance": {
        "hplcpurity_identity": 3, "endotoxin": 2, "sterility_pcr": 2}})
    assert plan.by_role == {}
    assert plan.errors == ()


@pytest.mark.parametrize("n", [1, 11, 0, "3", True, 2.0])
def test_n_out_of_range_is_an_error(cat, n):
    plan = _plan(cat, {ENDO: True, "variance": {ENDO: n}})
    assert plan.by_role == {}
    assert len(plan.errors) == 1
    assert ENDO in plan.errors[0]
    assert "2 to 10" in plan.errors[0]
    assert plan.error_for(ENDO) == plan.errors[0]


def test_n_at_both_bounds_resolves(cat):
    plan = _plan(cat, {ENDO: True, PCR: True, "variance": {ENDO: 2, PCR: 10}})
    assert plan.errors == ()
    assert plan.by_role["pcr"].replicate_runs == 9


def test_test_not_on_sample_is_an_error(cat):
    plan = _plan(cat, {ENDO: True, "variance": {HM: 2}})
    assert plan.errors == ("Variance for heavy_metals: the test is not on this sample",)
    assert plan.by_role == {}


def _missing(db):
    db.delete(_profile(db, ENDO)); db.flush()


def _kind_dim(db):
    _profile(db, ENDO).fulfillment_dim = "kind"; db.flush()


def _roleless(db):
    _profile(db, ENDO).fulfillment_role = None; db.flush()


def _zero_vials(db):
    _profile(db, ENDO).vials_required = 0; db.flush()


@pytest.mark.parametrize("mutate", [_missing, _kind_dim, _roleless, _zero_vials],
                         ids=["missing", "kind_dim", "roleless", "zero_vials"])
def test_unknown_kind_dim_or_roleless_profile_is_an_error(cat, mutate):
    mutate(cat)
    plan = _plan(cat, {ENDO: True, "variance": {ENDO: 2}})
    assert plan.by_role == {}
    assert len(plan.errors) == 1
    assert plan.errors[0].startswith(f"Variance for {ENDO}: ")


def test_inactive_profile_still_resolves(cat):
    # Rule 5: a paid order still fulfils a retired profile (catalog_demand.py).
    _profile(cat, ENDO).active = False; cat.flush()
    plan = _plan(cat, {ENDO: True, "variance": {ENDO: 2}})
    assert plan.errors == ()
    assert plan.by_role["endo85"].n == 2


def test_role_named_like_a_legacy_bucket_is_an_error(cat):
    _role(cat, "endo")
    _profile(cat, ENDO).fulfillment_role = "endo"; cat.flush()
    plan = _plan(cat, {ENDO: True, "variance": {ENDO: 2}})
    assert plan.by_role == {}
    assert len(plan.errors) == 1
    assert "legacy bucket" in plan.errors[0]


def test_ineligible_role_is_an_error(cat):
    cat.query(VialRole).filter_by(code="endo85").one().variance_eligible = False
    cat.flush()
    plan = _plan(cat, {ENDO: True, "variance": {ENDO: 2}})
    assert plan.by_role == {}
    assert len(plan.errors) == 1
    assert "not variance-eligible" in plan.errors[0]


def test_missing_role_row_is_an_error(cat):
    _profile(cat, ENDO).fulfillment_role = "nope"; cat.flush()
    plan = _plan(cat, {ENDO: True, "variance": {ENDO: 2}})
    assert plan.by_role == {}
    assert len(plan.errors) == 1
    assert plan.errors[0].startswith(f"Variance for {ENDO}: ")


def test_two_keys_on_one_role_is_an_error(cat):
    _role(cat, "ster2")
    _profile(cat, PCR).fulfillment_role = "ster2"
    _profile(cat, USP71).fulfillment_role = "ster2"
    cat.flush()
    plan = _plan(cat, {PCR: True, USP71: True, "variance": {USP71: 2, PCR: 3}})
    assert plan.by_role == {}
    assert len(plan.errors) == 2
    assert PCR in plan.errors[0] and USP71 in plan.errors[1]  # key order
    assert plan.error_for(PCR) and plan.error_for(USP71)


def test_more_than_one_analytical_vial_per_run_is_an_error(cat):
    p = _profile(cat, USP71)
    p.vials_required = 2; p.analytical_vials = None; cat.flush()
    plan = _plan(cat, {USP71: True, "variance": {USP71: 2}})
    assert plan.by_role == {}
    assert len(plan.errors) == 1
    assert "one analytical vial per run" in plan.errors[0]


def test_snapshot_wins_over_live_catalog(cat):
    snap = {"profiles": [{"key": HM, "fulfillment_role": "hm",
                          "vials_required": 3, "analytical_vials": 1}]}
    plan = _plan(cat, {HM: True, "variance": {HM: 2}}, snapshot=snap)
    assert plan.errors == ()
    assert plan.by_role["hm"].vials_per_run == 3
    assert plan.by_role["hm"].replicate_vials == 3


def test_old_snapshot_without_analytical_vials_reads_live_split(cat):
    # Same fall-through as seeder._analytical_vials_for_role.
    snap = {"profiles": [{"key": HM, "fulfillment_role": "hm", "vials_required": 2}]}
    plan = _plan(cat, {HM: True, "variance": {HM: 2}}, snapshot=snap)
    assert plan.errors == ()
    assert plan.by_role["hm"].pooled is True


def test_not_native_born_is_an_error(cat):
    plan = _plan(cat, {ENDO: True, "hplcpurity_identity": True,
                       "variance": {ENDO: 2, "hplcpurity_identity": 3}},
                 native_born=False)
    assert plan.errors == (
        "Variance for endotoxin-usp85-lal: only a Mk1-native sample can run it in this version",)
    assert plan.by_role == {}


def test_bac_water_sample_is_an_error(cat):
    plan = _plan(cat, {ENDO: True, "bac_water_panel": True,
                       "variance": {ENDO: 2, "bac_water_panel": 3}},
                 bac_water=True)
    assert plan.errors == (
        "Variance for endotoxin-usp85-lal: it is not offered on a Bacteriostatic Water sample",)
    assert plan.by_role == {}


def test_bac_water_retest_is_a_note_not_an_error(cat):
    plan = _plan(cat, {ENDO: True, "variance": {ENDO: 2}},
                 bac_water=True, is_retest=True)
    assert plan.errors == ()
    assert len(plan.notes) == 1


@pytest.mark.parametrize("missing", ["native_born", "bac_water"])
def test_native_born_and_bac_water_are_required(cat, missing):
    kw = {"native_born": True, "bac_water": False}
    del kw[missing]
    with pytest.raises(TypeError):
        resolve_variance_plan(cat, {ENDO: True, "variance": {ENDO: 2}}, **kw)


def test_retest_notes_and_skips_every_four_key_entry(cat):
    plan = _plan(cat, {ENDO: True, HM: True, "variance": {ENDO: 2, HM: 11}},
                 is_retest=True)
    assert plan.by_role == {}
    assert plan.errors == ()
    assert len(plan.notes) == 2
    assert ENDO in plan.notes[0] and HM in plan.notes[1]
    assert all("not carried to a retest" in n for n in plan.notes)


@pytest.mark.parametrize("services", [None, {}, {"variance": True},
                                      {"variance": [1]}, {"variance": None}])
def test_none_or_malformed_map_is_empty(cat, services):
    assert _plan(cat, services) == VariancePlan({}, (), ())


def _parent(db, **over):
    p = LimsSample(sample_id="P-9101", external_lims_system="mk1", **over)
    db.add(p); db.flush()
    return p


def test_is_retest_sample_reuses_the_a_la_carte_rule(db_session):
    assert is_retest_sample(_parent(db_session)) is False
    p = LimsSample(sample_id="P-9102", external_lims_system="mk1",
                   catalog_snapshot={"retest": {}})
    db_session.add(p); db_session.flush()
    assert is_retest_sample(p) is True


def test_is_bac_water_sample_reads_the_matrix(db_session):
    assert is_bac_water_sample(_parent(db_session, sample_type_title="Bacteriostatic Water"))
    p = LimsSample(sample_id="P-9103", external_lims_system="mk1", sample_type_title="Peptide")
    db_session.add(p); db_session.flush()
    assert not is_bac_water_sample(p)


def _vial(db, parent, seq, kind, *, in_set=True, rows=(), role="hm"):
    v = LimsSubSample(
        sample_id=f"{parent.sample_id}-S{seq:02d}", vial_sequence=seq,
        parent_sample_pk=parent.id, external_lims_uid=f"uid-{parent.id}-{seq}",
        assignment_role=role, assignment_kind=kind, in_variance_set=in_set,
    )
    db.add(v); db.flush()
    for state, retested in rows:
        db.add(LimsAnalysis(
            lims_sub_sample_pk=v.id, analysis_service_id=1, keyword="HM-PB",
            title="Lead", review_state=state, retested=retested,
        ))
    db.flush()
    return v


def test_replicate_anchor_vials_skip_material_core_and_out_of_set(db_session):
    db = db_session
    parent = _parent(db)
    live = [("unassigned", False)]
    _vial(db, parent, 1, "core", rows=live)                     # core anchor
    _vial(db, parent, 2, "core")                                # core material
    v5 = _vial(db, parent, 5, "variance", rows=live)            # replicate anchor
    _vial(db, parent, 4, "variance")                            # material
    v3 = _vial(db, parent, 3, "variance", rows=[("rejected", False), ("verified", False)])
    _vial(db, parent, 6, "variance")                            # material
    _vial(db, parent, 7, "variance", in_set=False, rows=live)   # out of set
    _vial(db, parent, 8, "variance", rows=[("rejected", False), ("retracted", False),
                                           ("verified", True)])  # no live row
    _vial(db, parent, 9, "variance", rows=live, role="endo85")  # other role
    got = replicate_anchor_vials(db, parent.id, "hm")
    assert [v.id for v in got] == [v3.id, v5.id]
