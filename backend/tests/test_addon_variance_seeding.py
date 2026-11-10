"""Add-on test Variance, Task 5: replicate vials seed host work only, and a
heavy metals replicate digest anchors on its own first vial.

Gate that keeps other inputs identical: a core (non-variance) vial counts
only core siblings for its anchor slot and never resolves a variance plan,
so a sample with no variance vial of a catalog role seeds exactly as today.
The characterization tests below pin that half.

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


def test_hand_set_variance_vial_without_purchase_is_one_digest(db_session):
    """No four-key entry: a variance hm vial keeps the plain cap (one run),
    and it no longer takes the core digest's anchor slot."""
    profs = _catalog(db_session)
    parent = _parent(db_session, "ZZT5-H4")
    v1, v2, c1 = _hm_vials(db_session, parent, profs,
                           ["variance", "variance", "core"], {HM_KEY: True})
    assert [_keywords(db_session, v) for v in (v1, v2, c1)] == [HM_ROWS, [], HM_ROWS]


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
