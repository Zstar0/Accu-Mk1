"""Add-on test Variance, Task 5: replicate vials seed host work only, and a
heavy metals replicate digest anchors on its own first vial.

Gates that keep other inputs identical (fix round 1 ruling):
- the kind-scoped anchor count and the raised cap apply only when the
  sample's VariancePlan covers the role; with no plan (no purchase, or the
  lookup failed and services is `{}`) the anchor rule is exactly the base
  rule, whatever the vial's kind;
- host-work-only applies only to a variance vial on one of the four test
  roles (`variance_test_roles`); any other variance vial seeds as at base.
The tests marked "base" below assert behaviour captured on the base checkout.

In-memory SQLite (conftest `db_session`), so nothing touches the dev
Postgres. The resolver acts only on the four real keys, so the catalog here
uses `heavy_metals` and `endotoxin-usp85-lal`.
"""
from __future__ import annotations

from lims_analyses.seeder import seed_analyses_for_vial
from models import (
    AnalysisProfile, AnalysisService, Department, LimsAnalysis, LimsSample,
    LimsSubSample, VialProfileAssignment, VialRole, analysis_profile_members,
)

HM_KEY = "heavy_metals"
ENDO85_KEY = "endotoxin-usp85-lal"
RIDER_KEY = "zz_t5_rider"
OTHER_KEY = "zz_t5_other"  # a catalog role that is not one of the four tests


def _profile(db, key, role, keywords, *, vials_required=1, analytical_vials=None):
    prof = AnalysisProfile(key=key, name=key, is_addon=True, vials_required=vials_required,
                           analytical_vials=analytical_vials, fulfillment_dim="role",
                           fulfillment_role=role, active=True)
    db.add(prof)
    db.flush()
    for i, kw in enumerate(keywords):
        svc = AnalysisService(title=kw, keyword=kw, origin="mk1", unit="ppm")
        db.add(svc)
        db.flush()
        db.execute(analysis_profile_members.insert().values(
            analysis_profile_id=prof.id, analysis_service_id=svc.id, sort_order=i))
    return prof


def _catalog(db):
    """hm: two vials a run, one analytical (one digest). endo85: one vial a
    run. A rider profile on its own role. Both test roles variance-eligible."""
    dep = Department(name="ZZ T5 Micro")
    db.add(dep)
    db.flush()
    for i, code in enumerate(("hm", "endo85"), 1):
        db.add(VialRole(code=code, label=code, department_id=dep.id, variance_eligible=True,
                        sort_order=100 + i, boxable=False, frozen=False, is_system=False))
    profs = {
        "hm": _profile(db, HM_KEY, "hm", ["HM-PB", "HM-AS", "HM-CD", "HM-HG"],
                       vials_required=2, analytical_vials=1),
        "endo85": _profile(db, ENDO85_KEY, "endo85", ["ENDO85-EU"]),
        "rider": _profile(db, RIDER_KEY, "zz_t5_role", ["ZZ-RIDE"]),
        "other": _profile(db, OTHER_KEY, "zz_t5_other", ["ZZ-OTHER"]),
    }
    db.commit()
    return profs


def _parent(db, sample_id):
    parent = LimsSample(sample_id=sample_id, external_lims_uid=f"{sample_id}-uid",
                        external_lims_system="mk1")
    db.add(parent)
    db.flush()
    return parent


def _vial(db, parent, seq, role, kind, *edges):
    """A vial with the given kind and current custody edges ((profile, relation))."""
    v = LimsSubSample(sample_id=f"{parent.sample_id}-S{seq:02d}", vial_sequence=seq,
                      parent_sample_pk=parent.id, external_lims_uid=f"{parent.sample_id}-v{seq}",
                      assignment_role=role, assignment_kind=kind,
                      in_variance_set=(seq == 1 or kind == "variance"))
    db.add(v)
    db.flush()
    for prof, relation in edges:
        db.add(VialProfileAssignment(lims_sub_sample_pk=v.id, analysis_profile_id=prof.id,
                                     relation=relation))
    db.flush()
    return v


def _seed(db, vial, services):
    return seed_analyses_for_vial(db, sub_sample=vial, role=vial.assignment_role,
                                  wp_services=services, commit=True)


def _keywords(db, vial):
    return sorted(r.keyword for r in db.query(LimsAnalysis).filter_by(
        lims_sub_sample_pk=vial.id).all())


def _hm_vials(db, parent, profs, kinds, services):
    """Create and seed one hm vial per kind, in order (assignment order)."""
    vials = []
    for i, kind in enumerate(kinds, 1):
        v = _vial(db, parent, i, "hm", kind, (profs["hm"], "host"))
        _seed(db, v, services)
        vials.append(v)
    return vials


HM_ROWS = ["HM-AS", "HM-CD", "HM-HG", "HM-PB"]
HM_N2 = {HM_KEY: True, "variance": {HM_KEY: 2}}


# ── characterization (passes before and after the change) ──────────────────

def test_core_hm_anchor_split_unchanged(db_session):
    """Two core hm vials, one with a NULL kind and one with kind core: the
    first carries the four metal rows, the second is material only."""
    profs = _catalog(db_session)
    parent = _parent(db_session, "ZZT5-C1")
    first, second = _hm_vials(db_session, parent, profs, [None, "core"], {HM_KEY: True})
    assert _keywords(db_session, first) == HM_ROWS
    assert _keywords(db_session, second) == []


def test_core_vial_seeds_host_and_rider_work(db_session):
    """A core endo85 vial holding a host edge and a rider edge seeds both."""
    profs = _catalog(db_session)
    parent = _parent(db_session, "ZZT5-C2")
    core = _vial(db_session, parent, 1, "endo85", "core",
                 (profs["endo85"], "host"), (profs["rider"], "rider"))
    _seed(db_session, core, {ENDO85_KEY: True, RIDER_KEY: True,
                             "variance": {ENDO85_KEY: 2}})
    assert _keywords(db_session, core) == ["ENDO85-EU", "ZZ-RIDE"]


# ── replicate digests and host-only replicates (fail before the change) ────

def test_hm_replicate_digest_anchors_its_own_first_vial(db_session):
    profs = _catalog(db_session)
    parent = _parent(db_session, "ZZT5-H1")
    c1, c2, v1, v2 = _hm_vials(db_session, parent, profs,
                               ["core", "core", "variance", "variance"], HM_N2)
    assert _keywords(db_session, c1) == HM_ROWS
    assert _keywords(db_session, v1) == HM_ROWS
    assert _keywords(db_session, c2) == []
    assert _keywords(db_session, v2) == []


def test_hm_variance_vial_first_does_not_steal_core_anchor(db_session):
    profs = _catalog(db_session)
    parent = _parent(db_session, "ZZT5-H2")
    v1, v2, c1, c2 = _hm_vials(db_session, parent, profs,
                               ["variance", "variance", "core", "core"], HM_N2)
    assert _keywords(db_session, v1) == HM_ROWS
    assert _keywords(db_session, c1) == HM_ROWS
    assert _keywords(db_session, v2) == []
    assert _keywords(db_session, c2) == []


def test_hm_three_runs_anchor_two_replicate_digests(db_session):
    """n=3 is two replicate digests: exactly two of the four variance vials
    anchor. Anchors go by assignment order (the first two assigned), not by
    a digest pairing; the rule only caps the count."""
    profs = _catalog(db_session)
    parent = _parent(db_session, "ZZT5-H3")
    vials = _hm_vials(db_session, parent, profs, ["variance"] * 4,
                      {HM_KEY: True, "variance": {HM_KEY: 3}})
    assert [_keywords(db_session, v) for v in vials] == [HM_ROWS, HM_ROWS, [], []]


def test_hand_set_variance_after_core_without_purchase_seeds_as_base(db_session):
    """Base, shape (a): no four-key entry; core anchors, then a hand-set
    variance hm vial is material (kind-blind count, plain cap)."""
    profs = _catalog(db_session)
    parent = _parent(db_session, "ZZT5-H4")
    vials = _hm_vials(db_session, parent, profs, ["core", "variance"], {HM_KEY: True})
    assert [_keywords(db_session, v) for v in vials] == [HM_ROWS, []]


def test_hand_set_variance_before_core_without_purchase_seeds_as_base(db_session):
    """Base, shape (b): no four-key entry; a hand-set variance hm vial
    anchors first, then the core vial is material."""
    profs = _catalog(db_session)
    parent = _parent(db_session, "ZZT5-H5")
    vials = _hm_vials(db_session, parent, profs, ["variance", "core"], {HM_KEY: True})
    assert [_keywords(db_session, v) for v in vials] == [HM_ROWS, []]


def test_lookup_outage_keeps_plain_cap_and_warns(db_session, caplog):
    """The order is hm n=3, but the seeder sees services `{}` (lookup
    failed): no plan, so the base rule holds (one anchor across kinds) and
    one seeder.variance_plan_unknown warning per variance vial that reaches
    the cap logic. The cap is never raised without a plan."""
    import logging
    profs = _catalog(db_session)
    parent = _parent(db_session, "ZZT5-H6")
    with caplog.at_level(logging.WARNING, logger="lims_analyses.seeder"):
        vials = _hm_vials(db_session, parent, profs, ["variance"] * 4, {})
    assert [_keywords(db_session, v) for v in vials] == [HM_ROWS, [], [], []]
    warns = [r.getMessage() for r in caplog.records
             if "seeder.variance_plan_unknown" in r.getMessage()]
    assert len(warns) == 4
    assert "sample=ZZT5-H6 role=hm sub=ZZT5-H6-S01" in warns[0]


def test_variance_vial_on_other_role_seeds_rider_work_as_base(db_session):
    """Base, shape (c) on a role that is not one of the four tests: a
    variance vial with a host and a rider edge seeds both."""
    profs = _catalog(db_session)
    parent = _parent(db_session, "ZZT5-R3")
    rep = _vial(db_session, parent, 2, "zz_t5_other", "variance",
                (profs["other"], "host"), (profs["rider"], "rider"))
    _seed(db_session, rep, {OTHER_KEY: True, RIDER_KEY: True})
    assert _keywords(db_session, rep) == ["ZZ-OTHER", "ZZ-RIDE"]


def test_hplc_variance_with_hplc_rider_seeds_as_base(db_session, monkeypatch):
    """Base, HPLC Variance byte for byte: an HPLC Variance order with a
    rider that rides the hplc vial (fentanyl-like). The core hplc vial gets
    the mirror rows plus the rider row; the variance hplc vial gets the
    mirror rows only (_seed_rider_members skips replicates)."""
    from catalog.departments import ANALYTICAL_DEPARTMENT
    from models import profile_ride_hosts

    dep = Department(name=ANALYTICAL_DEPARTMENT)
    db_session.add(dep)
    db_session.flush()
    for kw in ("HPLC-PUR", "HPLC-ID"):
        db_session.add(AnalysisService(title=kw, keyword=kw, origin="senaite",
                                       unit="%", department_id=dep.id))
    fent = _profile(db_session, "zz_t5_fent", "zz_t5_fent", ["ZZ-FENT"])
    db_session.execute(profile_ride_hosts.insert().values(
        analysis_profile_id=fent.id, host_role_code="hplc", priority=0))
    db_session.commit()
    monkeypatch.setattr("sub_samples.senaite.fetch_parent_analysis_keywords",
                        lambda sid: ["HPLC-PUR", "HPLC-ID"])
    parent = LimsSample(sample_id="ZZT5-HP1", external_lims_uid="ZZT5-HP1-uid")
    db_session.add(parent)
    db_session.flush()
    services = {"hplcpurity_identity": True, "zz_t5_fent": True,
                "variance": {"hplcpurity_identity": 3}}
    core = _vial(db_session, parent, 1, "hplc", "core", (fent, "rider"))
    rep = _vial(db_session, parent, 2, "hplc", "variance", (fent, "rider"))
    for v in (core, rep):
        seed_analyses_for_vial(db_session, sub_sample=v, role="hplc", wp_services=services,
                               parent_sample_id=parent.sample_id, commit=True)
    assert _keywords(db_session, core) == ["HPLC-ID", "HPLC-PUR", "ZZ-FENT"]
    assert _keywords(db_session, rep) == ["HPLC-ID", "HPLC-PUR"]


def test_variance_vial_seeds_no_rider_work(db_session):
    """Same edges as test_core_vial_seeds_host_and_rider_work, on a
    replicate: only the host members are seeded."""
    profs = _catalog(db_session)
    parent = _parent(db_session, "ZZT5-R1")
    rep = _vial(db_session, parent, 2, "endo85", "variance",
                (profs["endo85"], "host"), (profs["rider"], "rider"))
    _seed(db_session, rep, {ENDO85_KEY: True, RIDER_KEY: True,
                            "variance": {ENDO85_KEY: 2}})
    assert _keywords(db_session, rep) == ["ENDO85-EU"]


def test_variance_vial_with_only_rider_edges_seeds_nothing(db_session):
    profs = _catalog(db_session)
    parent = _parent(db_session, "ZZT5-R2")
    rep = _vial(db_session, parent, 2, "endo85", "variance", (profs["rider"], "rider"))
    assert _seed(db_session, rep, {ENDO85_KEY: True, RIDER_KEY: True}) == []
    assert _keywords(db_session, rep) == []
