"""Tests for lims_analyses/manage_native.py (native Manage Analyses slice).

Self-contained in-memory SQLite (same idiom as test_parent_placeholders.py):
models.py registers everything on Base.metadata before create_all().
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

import models  # noqa: F401
from database import Base
from models import (
    AnalysisProfile, AnalysisService, LimsAnalysis, LimsAnalysisPromotion,
    LimsAnalysisTransition, LimsSample, LimsSubSample, LimsSubSampleEvent,
    VialProfileAssignment,
)
from lims_analyses.parent_placeholders import PROVENANCE_ORDERED
from lims_analyses import manage_native as mn


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def parent(db):
    p = LimsSample(sample_id="MN-PARENT", sample_type="x", status="received",
                   external_lims_system="senaite")
    db.add(p); db.commit(); db.refresh(p)
    return p


def _svc(db, *, keyword, title, origin="mk1"):
    s = AnalysisService(title=title, keyword=keyword, origin=origin)
    db.add(s); db.commit(); db.refresh(s)
    return s


def _profile(db, *, key, name, members, role, active=True, dim="role"):
    p = AnalysisProfile(key=key, name=name, is_addon=True, coa_archetype="limit_table",
                        fulfillment_role=role, fulfillment_dim=dim, vials_required=1,
                        active=active)
    for m in members:
        p.analysis_services.append(m)
    db.add(p); db.commit(); db.refresh(p)
    return p


def _vial(db, parent, *, sid, seq, role):
    v = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid=f"mk1://{sid}",
                      sample_id=sid, vial_sequence=seq, assignment_role=role)
    db.add(v); db.commit(); db.refresh(v)
    return v


@pytest.fixture
def moisture(db):
    kf = _svc(db, keyword="MOISTURE-KF", title="Residual Moisture")
    return _profile(db, key="moisture", name="Residual Moisture", members=[kf], role="kf")


@pytest.fixture
def heavy_metals(db):
    m = [_svc(db, keyword=k, title=t) for k, t in
         (("LEAD-PPM", "Lead"), ("ARSENIC-PPM", "Arsenic"),
          ("CADMIUM-PPM", "Cadmium"), ("MERCURY-PPM", "Mercury"))]
    return _profile(db, key="heavy_metals", name="Heavy Metals", members=m, role="hm")


# ── native_profiles_for_parent ────────────────────────────────────────────────

def test_lists_only_all_mk1_active_profiles_with_on_sample_and_hosts(db, parent, moisture, heavy_metals):
    legacy = _svc(db, keyword="ENDO-LAL", title="Endotoxin", origin="senaite")
    _profile(db, key="endotoxin", name="Endotoxin", members=[legacy], role="endo")
    _profile(db, key="dead", name="Dead", members=[_svc(db, keyword="D", title="D")], role="hm", active=False)
    _vial(db, parent, sid="MN-PARENT-S04", seq=4, role="kf")

    out = mn.native_profiles_for_parent(db, parent=parent)
    keys = {p["key"] for p in out}
    assert keys == {"moisture", "heavy_metals"}
    m = next(p for p in out if p["key"] == "moisture")
    assert m["on_sample"] == "none"
    assert m["host_vials"] == ["MN-PARENT-S04"]
    assert m["members"] == [{"service_id": moisture.analysis_services[0].id,
                             "keyword": "MOISTURE-KF", "title": "Residual Moisture"}]
    hm = next(p for p in out if p["key"] == "heavy_metals")
    assert hm["host_vials"] == []


def test_on_sample_partial_and_full(db, parent, heavy_metals):
    lead, arsenic = heavy_metals.analysis_services[0], heavy_metals.analysis_services[1]
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=lead.id, keyword="LEAD-PPM",
                        title="Lead", review_state="unassigned", provenance=PROVENANCE_ORDERED))
    db.commit()
    assert mn.native_profiles_for_parent(db, parent=parent)[0]["on_sample"] == "partial"
    for s in heavy_metals.analysis_services[1:]:
        db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=s.id, keyword=s.keyword,
                            title=s.title, review_state="unassigned", provenance=PROVENANCE_ORDERED))
    db.commit()
    assert mn.native_profiles_for_parent(db, parent=parent)[0]["on_sample"] == "full"


def test_rejected_placeholder_does_not_count_as_on_sample(db, parent, moisture):
    kf = moisture.analysis_services[0]
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=kf.id, keyword="MOISTURE-KF",
                        title="Residual Moisture", review_state="rejected", provenance=PROVENANCE_ORDERED))
    db.commit()
    assert mn.native_profiles_for_parent(db, parent=parent)[0]["on_sample"] == "none"


# ── placeholder_profile_keys ──────────────────────────────────────────────────

def test_placeholder_profile_keys_maps_live_ordered_rows_to_profile_keys(db, parent, moisture, heavy_metals):
    kf = moisture.analysis_services[0]
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=kf.id, keyword="MOISTURE-KF",
                        title="Residual Moisture", review_state="unassigned", provenance=PROVENANCE_ORDERED))
    db.commit()
    assert mn.placeholder_profile_keys(db, parent) == {"moisture": True}


def test_placeholder_profile_keys_ignores_rejected_and_canonical(db, parent, moisture):
    kf = moisture.analysis_services[0]
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=kf.id, keyword="MOISTURE-KF",
                        title="Residual Moisture", review_state="rejected", provenance=PROVENANCE_ORDERED))
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=kf.id, keyword="MOISTURE-KF",
                        title="Residual Moisture", review_state="verified", provenance="canonical"))
    db.commit()
    assert mn.placeholder_profile_keys(db, parent) == {}


# ── add_profile_to_parent ─────────────────────────────────────────────────────

def test_add_with_host_vial_mints_placeholder_edge_and_vial_row(db, parent, moisture):
    v = _vial(db, parent, sid="MN-PARENT-S04", seq=4, role="kf")
    res = mn.add_profile_to_parent(db, parent=parent, profile=moisture, user_id=5)
    db.commit()
    assert res["placeholders_created"] == 1 and res["no_host_vial"] is False
    assert res["hosts"] == [{"vial_id": "MN-PARENT-S04", "edge_created": True, "vial_rows_created": 1}]
    kf = moisture.analysis_services[0]
    ph = db.execute(select(LimsAnalysis).where(LimsAnalysis.lims_sample_pk == parent.id,
                                               LimsAnalysis.provenance == PROVENANCE_ORDERED)).scalars().all()
    assert [r.analysis_service_id for r in ph] == [kf.id]
    vr = db.execute(select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == v.id)).scalars().all()
    assert [(r.analysis_service_id, r.review_state) for r in vr] == [(kf.id, "unassigned")]
    edges = db.execute(select(VialProfileAssignment).where(
        VialProfileAssignment.lims_sub_sample_pk == v.id)).scalars().all()
    assert [(e.analysis_profile_id, e.relation, e.assigned_by_id, e.superseded_at) for e in edges] == \
        [(moisture.id, "host", 5, None)]
    ev = db.execute(select(LimsSubSampleEvent).where(LimsSubSampleEvent.lims_sample_pk == parent.id)).scalars().one()
    assert ev.event == "native_profile_added" and ev.details["profile_key"] == "moisture" and ev.user_id == 5
    tr = db.execute(select(LimsAnalysisTransition).where(LimsAnalysisTransition.analysis_id == ph[0].id)).scalars().one()
    assert tr.reason == "manage_analyses:add profile=moisture"


def test_add_without_host_vial_is_placeholder_only(db, parent, moisture):
    _vial(db, parent, sid="MN-PARENT-S01", seq=1, role="hplc")
    res = mn.add_profile_to_parent(db, parent=parent, profile=moisture, user_id=None)
    db.commit()
    assert res["placeholders_created"] == 1 and res["no_host_vial"] is True and res["hosts"] == []
    assert db.query(VialProfileAssignment).count() == 0
    assert db.query(LimsAnalysis).filter(LimsAnalysis.lims_sub_sample_pk.isnot(None)).count() == 0


def test_add_is_idempotent_and_partial_mints_only_missing(db, parent, heavy_metals):
    v = _vial(db, parent, sid="MN-PARENT-S02", seq=2, role="hm")
    lead = heavy_metals.analysis_services[0]
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=lead.id, keyword="LEAD-PPM",
                        title="Lead", review_state="unassigned", provenance=PROVENANCE_ORDERED))
    db.commit()
    res = mn.add_profile_to_parent(db, parent=parent, profile=heavy_metals, user_id=1)
    db.commit()
    assert res["placeholders_created"] == 3 and res["placeholders_existing"] == 1
    assert res["hosts"][0]["vial_rows_created"] == 4
    # second run: everything exists
    with pytest.raises(mn.ProfileAlreadyOnSampleError):
        mn.add_profile_to_parent(db, parent=parent, profile=heavy_metals, user_id=1)
    assert db.query(VialProfileAssignment).filter_by(lims_sub_sample_pk=v.id).count() == 1


def test_add_seeds_every_matching_role_vial(db, parent, heavy_metals):
    _vial(db, parent, sid="MN-PARENT-S02", seq=2, role="hm")
    _vial(db, parent, sid="MN-PARENT-S03", seq=3, role="hm")
    res = mn.add_profile_to_parent(db, parent=parent, profile=heavy_metals, user_id=1)
    db.commit()
    assert [h["vial_id"] for h in res["hosts"]] == ["MN-PARENT-S02", "MN-PARENT-S03"]
    assert all(h["vial_rows_created"] == 4 for h in res["hosts"])


def test_add_rejects_inactive_non_native_and_empty(db, parent):
    mk1 = _svc(db, keyword="A", title="A")
    sen = _svc(db, keyword="B", title="B", origin="senaite")
    inactive = _profile(db, key="i", name="I", members=[mk1], role="hm", active=False)
    mixed = _profile(db, key="m", name="M", members=[mk1, sen], role="hm")
    empty = _profile(db, key="e", name="E", members=[], role="hm")
    with pytest.raises(mn.ProfileInactiveError):
        mn.add_profile_to_parent(db, parent=parent, profile=inactive, user_id=1)
    with pytest.raises(mn.ProfileNotNativeError):
        mn.add_profile_to_parent(db, parent=parent, profile=mixed, user_id=1)
    with pytest.raises(mn.ProfileHasNoMembersError):
        mn.add_profile_to_parent(db, parent=parent, profile=empty, user_id=1)
    assert db.query(LimsAnalysis).count() == 0


# ── role-flip union hook ──────────────────────────────────────────────────────
# NOTE: the brief's literal test text uses role 'kf' (the `moisture` fixture's
# fulfillment_role) but seed_vial_roles only seeds hplc/endo/ster/hm/xtra —
# 'kf' is not a catalog-registered role, so set_assignment_role(..., 'kf', ...)
# would raise ValueError: Invalid role. Per the brief's fallback instruction,
# both tests below use role 'hm' + the `heavy_metals` fixture instead; the
# assertions are adapted for its 4 members rather than moisture's 1 (the
# assertion is about the union, not the specific role).

def test_role_flip_seeds_a_lab_added_profile_with_no_prior_host_vial(db, parent, heavy_metals, monkeypatch):
    """Ruling A: placeholder first, vial later. When the vial gets role 'hm',
    set_assignment_role must union the placeholder-derived key {'heavy_metals'}
    into its services map (the WP order doesn't carry it) so the custody edge
    is written and the members seed."""
    import sub_samples.service as svc
    from catalog.vial_roles_seed import seed_vial_roles
    seed_vial_roles(db)  # role gate is catalog-driven
    mn.add_profile_to_parent(db, parent=parent, profile=heavy_metals, user_id=1)
    db.commit()
    v = _vial(db, parent, sid="MN-PARENT-S04", seq=4, role=None)
    monkeypatch.setattr(svc, "_fetch_wp_services_for_parent", lambda sid: {"hplcpurity_identity": True})

    svc.set_assignment_role(db, v.sample_id, "hm", user_id=1)

    member_ids = [m.id for m in heavy_metals.analysis_services]
    rows = db.execute(select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == v.id)).scalars().all()
    assert [r.analysis_service_id for r in rows] == member_ids
    edges = db.execute(select(VialProfileAssignment).where(
        VialProfileAssignment.lims_sub_sample_pk == v.id,
        VialProfileAssignment.superseded_at.is_(None))).scalars().all()
    assert [(e.analysis_profile_id, e.relation) for e in edges] == [(heavy_metals.id, "host")]


def test_role_flip_without_placeholders_is_unchanged(db, parent, monkeypatch):
    import sub_samples.service as svc
    from catalog.vial_roles_seed import seed_vial_roles
    seed_vial_roles(db)
    v = _vial(db, parent, sid="MN-PARENT-S04", seq=4, role=None)
    monkeypatch.setattr(svc, "_fetch_wp_services_for_parent", lambda sid: {"hplcpurity_identity": True})
    svc.set_assignment_role(db, v.sample_id, "hm", user_id=1)
    assert db.query(LimsAnalysis).filter(LimsAnalysis.lims_sub_sample_pk == v.id).count() == 0
    assert db.query(VialProfileAssignment).count() == 0


def test_role_flip_union_merges_wp_ordered_and_placeholder_derived_profiles(db, parent, heavy_metals, monkeypatch):
    """Merge, not replace (review fix round 1): a WP-ordered profile — a REAL
    key present in the fetched services map, unlike the earlier tests' inert
    'hplcpurity_identity' — and a lab-added placeholder profile share the
    SAME role ('hm'), so the union is observable in what actually seeds and
    gets a custody edge. Proves the implementation merges both sources
    rather than one substituting for the other."""
    import sub_samples.service as svc
    from catalog.vial_roles_seed import seed_vial_roles
    seed_vial_roles(db)
    selenium = _svc(db, keyword="SELENIUM-PPM", title="Selenium")
    hm_extra = _profile(db, key="hm_extra", name="HM Extra", members=[selenium], role="hm")

    # heavy_metals is lab-added: placeholder only, no host vial exists yet.
    mn.add_profile_to_parent(db, parent=parent, profile=heavy_metals, user_id=1)
    db.commit()
    v = _vial(db, parent, sid="MN-PARENT-S04", seq=4, role=None)
    # hm_extra arrives through the WP order — a real, resolvable profile key.
    monkeypatch.setattr(svc, "_fetch_wp_services_for_parent", lambda sid: {"hm_extra": True})

    svc.set_assignment_role(db, v.sample_id, "hm", user_id=1)

    hm_member_ids = {m.id for m in heavy_metals.analysis_services}
    rows = db.execute(select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == v.id)).scalars().all()
    assert len(rows) == 5
    assert {r.analysis_service_id for r in rows} == hm_member_ids | {selenium.id}
    edges = db.execute(select(VialProfileAssignment).where(
        VialProfileAssignment.lims_sub_sample_pk == v.id,
        VialProfileAssignment.superseded_at.is_(None))).scalars().all()
    assert {(e.analysis_profile_id, e.relation) for e in edges} == {
        (heavy_metals.id, "host"), (hm_extra.id, "host"),
    }


def test_role_flip_placeholder_wins_over_wp_false_on_same_key(db, parent, heavy_metals, monkeypatch):
    """Precedence (review fix round 1): a live 'ordered' placeholder is the
    parent's current truth of what's on the sample. When the WP-fetched
    services map disagrees on the SAME key (stale/false), the
    placeholder-derived value still wins and the profile seeds."""
    import sub_samples.service as svc
    from catalog.vial_roles_seed import seed_vial_roles
    seed_vial_roles(db)
    mn.add_profile_to_parent(db, parent=parent, profile=heavy_metals, user_id=1)
    db.commit()
    v = _vial(db, parent, sid="MN-PARENT-S04", seq=4, role=None)
    monkeypatch.setattr(svc, "_fetch_wp_services_for_parent", lambda sid: {"heavy_metals": False})

    svc.set_assignment_role(db, v.sample_id, "hm", user_id=1)

    member_ids = [m.id for m in heavy_metals.analysis_services]
    rows = db.execute(select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == v.id)).scalars().all()
    assert [r.analysis_service_id for r in rows] == member_ids
    edges = db.execute(select(VialProfileAssignment).where(
        VialProfileAssignment.lims_sub_sample_pk == v.id,
        VialProfileAssignment.superseded_at.is_(None))).scalars().all()
    assert [(e.analysis_profile_id, e.relation) for e in edges] == [(heavy_metals.id, "host")]


# ── remove_parent_native_analysis ─────────────────────────────────────────────

def _placeholder_of(db, parent, svc_id):
    return db.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == parent.id, LimsAnalysis.analysis_service_id == svc_id,
        LimsAnalysis.provenance == PROVENANCE_ORDERED,
        LimsAnalysis.review_state.notin_(("rejected", "retracted")))).scalars().one()


def test_remove_pristine_deletes_vial_rows_soft_rejects_placeholder_supersedes_edge(db, parent, moisture):
    v = _vial(db, parent, sid="MN-PARENT-S04", seq=4, role="kf")
    mn.add_profile_to_parent(db, parent=parent, profile=moisture, user_id=1)
    db.commit()
    kf = moisture.analysis_services[0]
    ph = _placeholder_of(db, parent, kf.id)

    res = mn.remove_parent_native_analysis(db, parent=parent, analysis_id=ph.id, confirm=False, user_id=2)

    assert res == {"analysis_id": ph.id, "keyword": "MOISTURE-KF", "analysis_service_id": kf.id,
                   "vial_rows_deleted": 1, "vial_rows_rejected": 0, "edges_superseded": 1}
    db.refresh(ph)
    assert ph.review_state == "rejected"
    tr = db.execute(select(LimsAnalysisTransition).where(
        LimsAnalysisTransition.analysis_id == ph.id).order_by(LimsAnalysisTransition.id)).scalars().all()
    assert [t.transition_kind for t in tr] == ["auto", "reject"]
    assert tr[-1].reason == "manage_analyses:remove" and tr[-1].details == {"changed": {}}
    assert db.query(LimsAnalysis).filter(LimsAnalysis.lims_sub_sample_pk == v.id).count() == 0
    edge = db.execute(select(VialProfileAssignment).where(
        VialProfileAssignment.lims_sub_sample_pk == v.id)).scalars().one()
    assert edge.superseded_at is not None
    evs = [e.event for e in db.execute(select(LimsSubSampleEvent).where(
        LimsSubSampleEvent.lims_sample_pk == parent.id)).scalars().all()]
    assert "native_analysis_removed" in evs
    # re-add works: the rejected placeholder does not block, a fresh one mints
    res2 = mn.add_profile_to_parent(db, parent=parent, profile=moisture, user_id=1)
    db.commit()
    assert res2["placeholders_created"] == 1


def test_remove_worked_vial_row_requires_confirm_then_rejects(db, parent, moisture):
    v = _vial(db, parent, sid="MN-PARENT-S04", seq=4, role="kf")
    mn.add_profile_to_parent(db, parent=parent, profile=moisture, user_id=1)
    db.commit()
    kf = moisture.analysis_services[0]
    ph = _placeholder_of(db, parent, kf.id)
    vr = db.execute(select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == v.id)).scalars().one()
    vr.result_value = "0.42"; vr.review_state = "to_be_verified"; db.commit()

    with pytest.raises(mn.RemovalNeedsConfirm) as ei:
        mn.remove_parent_native_analysis(db, parent=parent, analysis_id=ph.id, confirm=False, user_id=2)
    assert [r["sample_id"] for r in ei.value.impact["worked_unverified"]] == ["MN-PARENT-S04"]
    db.refresh(ph); assert ph.review_state == "unassigned"  # nothing changed

    res = mn.remove_parent_native_analysis(db, parent=parent, analysis_id=ph.id, confirm=True, user_id=2)
    assert res["vial_rows_rejected"] == 1 and res["vial_rows_deleted"] == 0
    db.refresh(vr); assert vr.review_state == "rejected"
    db.refresh(ph); assert ph.review_state == "rejected"


def test_remove_blocked_when_a_live_canonical_row_exists(db, parent, moisture):
    mn.add_profile_to_parent(db, parent=parent, profile=moisture, user_id=1)
    db.commit()
    kf = moisture.analysis_services[0]
    ph = _placeholder_of(db, parent, kf.id)
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=kf.id, keyword="MOISTURE-KF",
                        title="Residual Moisture", review_state="verified", provenance="canonical"))
    db.commit()
    with pytest.raises(mn.PromotedResultExistsError):
        mn.remove_parent_native_analysis(db, parent=parent, analysis_id=ph.id, confirm=True, user_id=2)


def test_remove_only_supersedes_edge_when_no_member_row_remains(db, parent, heavy_metals):
    v = _vial(db, parent, sid="MN-PARENT-S02", seq=2, role="hm")
    mn.add_profile_to_parent(db, parent=parent, profile=heavy_metals, user_id=1)
    db.commit()
    lead = heavy_metals.analysis_services[0]
    ph = _placeholder_of(db, parent, lead.id)
    res = mn.remove_parent_native_analysis(db, parent=parent, analysis_id=ph.id, confirm=False, user_id=2)
    assert res["edges_superseded"] == 0  # 3 members still live on the vial
    edge = db.execute(select(VialProfileAssignment).where(
        VialProfileAssignment.lims_sub_sample_pk == v.id)).scalars().one()
    assert edge.superseded_at is None


def test_remove_rejects_non_placeholder_targets(db, parent, moisture):
    kf = moisture.analysis_services[0]
    can = LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=kf.id, keyword="MOISTURE-KF",
                       title="Residual Moisture", review_state="verified", provenance="canonical")
    db.add(can); db.commit()
    from lims_analyses.service import NotFoundError
    with pytest.raises(NotFoundError):
        mn.remove_parent_native_analysis(db, parent=parent, analysis_id=can.id, confirm=False, user_id=2)
    with pytest.raises(NotFoundError):
        mn.remove_parent_native_analysis(db, parent=parent, analysis_id=999999, confirm=False, user_id=2)


def test_remove_treats_retest_child_as_worked_not_pristine(db, parent, moisture):
    """Fix round 1: a retest child (retest_of_id set) is never pristine — it
    belongs to a worked lineage. Both the OLD root and the NEW child must be
    classified worked_unverified, so confirm=False 412s and confirm=True
    rejects both via apply_transition rather than the pristine loop
    mis-targeting the root through delete_pristine_analysis's keyword lookup
    (which filters retest_of_id IS NULL and would otherwise resolve to the
    worked root, raising a misleading BadRequestError)."""
    v = _vial(db, parent, sid="MN-PARENT-S04", seq=4, role="kf")
    mn.add_profile_to_parent(db, parent=parent, profile=moisture, user_id=1)
    db.commit()
    kf = moisture.analysis_services[0]
    ph = _placeholder_of(db, parent, kf.id)
    old = db.execute(select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == v.id)).scalars().one()
    old.result_value = "0.9"; old.review_state = "to_be_verified"; old.retested = True
    db.commit()
    new = LimsAnalysis(lims_sub_sample_pk=v.id, analysis_service_id=kf.id, keyword="MOISTURE-KF",
                       title="Residual Moisture", review_state="unassigned", provenance="canonical",
                       retest_of_id=old.id)
    db.add(new); db.commit()

    with pytest.raises(mn.RemovalNeedsConfirm) as ei:
        mn.remove_parent_native_analysis(db, parent=parent, analysis_id=ph.id, confirm=False, user_id=2)
    assert ei.value.impact["pristine"] == []
    assert {r["analysis_id"] for r in ei.value.impact["worked_unverified"]} == {old.id, new.id}

    res = mn.remove_parent_native_analysis(db, parent=parent, analysis_id=ph.id, confirm=True, user_id=2)
    assert res["vial_rows_rejected"] == 2 and res["vial_rows_deleted"] == 0
    db.refresh(old); db.refresh(new); db.refresh(ph)
    assert old.review_state == "rejected"
    assert new.review_state == "rejected"
    assert ph.review_state == "rejected"
    edge = db.execute(select(VialProfileAssignment).where(
        VialProfileAssignment.lims_sub_sample_pk == v.id)).scalars().one()
    assert edge.superseded_at is not None


def _stale_cul_de_sac(db, parent, moisture, v, *, canonical_state):
    """P-0157 UAT shape: vial row promoted+retested, a parent canonical row
    for the same service, a promotion link between them, and a rejected
    retest child hanging off the vial row (retest_of_id set). Returns the
    vial row (the promotion source)."""
    kf = moisture.analysis_services[0]
    vr = db.execute(select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == v.id)).scalars().one()
    vr.result_value = "12"; vr.review_state = "promoted"; vr.retested = True
    canonical = LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=kf.id, keyword="MOISTURE-KF",
                             title="Residual Moisture", review_state=canonical_state, provenance="canonical")
    db.add(canonical); db.flush()
    db.add(LimsAnalysisPromotion(parent_analysis_id=canonical.id, source_analysis_id=vr.id,
                                 contribution_kind="result"))
    child = LimsAnalysis(lims_sub_sample_pk=v.id, analysis_service_id=kf.id, keyword="MOISTURE-KF",
                         title="Residual Moisture", review_state="rejected", provenance="canonical",
                         retest_of_id=vr.id)
    db.add(child)
    db.commit()
    return vr


def test_stale_promotion_link_does_not_block_remove(db, parent, moisture):
    """Un-promote (parent retest cascade) retracted the parent canonical but
    left the promotion link and the source's 'promoted'+retested state
    intact. The link is dead — it must not block removal."""
    v = _vial(db, parent, sid="MN-PARENT-S04", seq=4, role="kf")
    mn.add_profile_to_parent(db, parent=parent, profile=moisture, user_id=1)
    db.commit()
    kf = moisture.analysis_services[0]
    ph = _placeholder_of(db, parent, kf.id)
    vr = _stale_cul_de_sac(db, parent, moisture, v, canonical_state="retracted")

    with pytest.raises(mn.RemovalNeedsConfirm) as ei:
        mn.remove_parent_native_analysis(db, parent=parent, analysis_id=ph.id, confirm=False, user_id=2)
    assert ei.value.impact["blocked"] == []
    assert ei.value.impact["pristine"] == []
    assert [r["analysis_id"] for r in ei.value.impact["worked_unverified"]] == [vr.id]


def test_confirm_clears_promoted_cul_de_sac(db, parent, moisture):
    v = _vial(db, parent, sid="MN-PARENT-S04", seq=4, role="kf")
    mn.add_profile_to_parent(db, parent=parent, profile=moisture, user_id=1)
    db.commit()
    kf = moisture.analysis_services[0]
    ph = _placeholder_of(db, parent, kf.id)
    vr = _stale_cul_de_sac(db, parent, moisture, v, canonical_state="retracted")

    res = mn.remove_parent_native_analysis(db, parent=parent, analysis_id=ph.id, confirm=True, user_id=2)

    assert res["vial_rows_rejected"] == 1 and res["vial_rows_deleted"] == 0
    db.refresh(vr)
    assert vr.review_state == "rejected"
    assert db.query(LimsAnalysisPromotion).count() == 0
    tr = db.execute(select(LimsAnalysisTransition).where(
        LimsAnalysisTransition.analysis_id == vr.id).order_by(LimsAnalysisTransition.id)).scalars().all()
    assert tr[-1].transition_kind == "reject"
    assert tr[-1].reason == "manage_analyses:remove"
    db.refresh(ph)
    assert ph.review_state == "rejected"
    edge = db.execute(select(VialProfileAssignment).where(
        VialProfileAssignment.lims_sub_sample_pk == v.id)).scalars().one()
    assert edge.superseded_at is not None


def test_live_promotion_link_still_blocks(db, parent, moisture):
    """Same shape, but the parent canonical is still live (parent_to_verify):
    the parent-tier live-canonical check 409s before classify is even
    reached. Separately assert _classify_vial_rows itself buckets the row
    as blocked (defence-in-depth, per the docstring)."""
    v = _vial(db, parent, sid="MN-PARENT-S04", seq=4, role="kf")
    mn.add_profile_to_parent(db, parent=parent, profile=moisture, user_id=1)
    db.commit()
    kf = moisture.analysis_services[0]
    ph = _placeholder_of(db, parent, kf.id)
    vr = _stale_cul_de_sac(db, parent, moisture, v, canonical_state="parent_to_verify")

    with pytest.raises(mn.PromotedResultExistsError):
        mn.remove_parent_native_analysis(db, parent=parent, analysis_id=ph.id, confirm=True, user_id=2)

    impact = mn._classify_vial_rows(db, parent, kf.id)
    assert [r["analysis_id"] for r in impact["blocked"]] == [vr.id]


def test_force_retract_default_reason_unchanged(db, parent, moisture):
    """No reason passed -> the else/worked-branch default string, unchanged."""
    from lims_analyses.service import force_retract_analysis

    v = _vial(db, parent, sid="MN-PARENT-S04", seq=4, role="kf")
    mn.add_profile_to_parent(db, parent=parent, profile=moisture, user_id=1)
    db.commit()
    vr = db.execute(select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == v.id)).scalars().one()
    vr.result_value = "0.42"; vr.review_state = "to_be_verified"
    db.commit()

    force_retract_analysis(db, analysis_id=vr.id, user_id=None)

    db.refresh(vr)
    assert vr.review_state == "rejected"
    tr = db.execute(select(LimsAnalysisTransition).where(
        LimsAnalysisTransition.analysis_id == vr.id).order_by(LimsAnalysisTransition.id)).scalars().all()
    assert tr[-1].transition_kind == "reject"
    assert tr[-1].reason == "wrong-variant Replace: result discarded"


# ── resync_parent_from_order ──────────────────────────────────────────────────

def test_resync_mints_missing_placeholders_edges_and_vial_rows(db, parent, moisture, monkeypatch):
    v = _vial(db, parent, sid="MN-PARENT-S04", seq=4, role="kf")
    monkeypatch.setattr(mn, "fetch_sample_services",
                        lambda sid: {"services": {"moisture": True, "hplcpurity_identity": True}, "package": None})
    res = mn.resync_parent_from_order(db, parent=parent, user_id=3)
    db.commit()
    assert res == {"placeholders_created": 1, "edges_created": 1, "vial_rows_created": 1}
    assert db.query(VialProfileAssignment).filter_by(lims_sub_sample_pk=v.id, superseded_at=None).count() == 1
    ev = [e for e in db.execute(select(LimsSubSampleEvent).where(
        LimsSubSampleEvent.lims_sample_pk == parent.id)).scalars().all() if e.event == "native_resync"]
    assert len(ev) == 1 and ev[0].details == res
    # second run is a no-op
    res2 = mn.resync_parent_from_order(db, parent=parent, user_id=3)
    db.commit()
    assert res2 == {"placeholders_created": 0, "edges_created": 0, "vial_rows_created": 0}


def test_resync_never_supersedes_lab_added_edges(db, parent, moisture, heavy_metals, monkeypatch):
    v = _vial(db, parent, sid="MN-PARENT-S02", seq=2, role="hm")
    mn.add_profile_to_parent(db, parent=parent, profile=heavy_metals, user_id=1)  # lab-added
    db.commit()
    monkeypatch.setattr(mn, "fetch_sample_services", lambda sid: {"services": {"moisture": True}, "package": None})
    mn.resync_parent_from_order(db, parent=parent, user_id=3)
    db.commit()
    edges = db.execute(select(VialProfileAssignment).where(
        VialProfileAssignment.lims_sub_sample_pk == v.id)).scalars().all()
    assert [(e.analysis_profile_id, e.superseded_at) for e in edges] == [(heavy_metals.id, None)]


def test_resync_is_unavailable_when_is_fails_and_writes_nothing(db, parent, moisture, monkeypatch):
    def boom(sid):
        raise RuntimeError("IS down")
    monkeypatch.setattr(mn, "fetch_sample_services", boom)
    with pytest.raises(mn.OrderServicesUnavailable):
        mn.resync_parent_from_order(db, parent=parent, user_id=3)
    monkeypatch.setattr(mn, "fetch_sample_services", lambda sid: None)
    with pytest.raises(mn.OrderServicesUnavailable):
        mn.resync_parent_from_order(db, parent=parent, user_id=3)
    assert db.query(LimsAnalysis).count() == 0 and db.query(LimsSubSampleEvent).count() == 0


# ── ensure_parent_placeholder ─────────────────────────────────────────────────

def test_ensure_parent_placeholder_mints_once_and_skips_live_rows(db, parent, moisture):
    kf = moisture.analysis_services[0]
    row = mn.ensure_parent_placeholder(db, parent=parent, service=kf, user_id=4, reason="manage_analyses:vial_add")
    db.commit()
    assert row is not None and row.provenance == PROVENANCE_ORDERED and row.review_state == "unassigned"
    tr = db.execute(select(LimsAnalysisTransition).where(LimsAnalysisTransition.analysis_id == row.id)).scalars().one()
    assert tr.reason == "manage_analyses:vial_add" and tr.user_id == 4
    assert mn.ensure_parent_placeholder(db, parent=parent, service=kf, user_id=4, reason="x") is None
    # a live canonical also counts as present
    row.review_state = "rejected"; db.commit()
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=kf.id, keyword="MOISTURE-KF",
                        title="Residual Moisture", review_state="verified", provenance="canonical")); db.commit()
    assert mn.ensure_parent_placeholder(db, parent=parent, service=kf, user_id=4, reason="x") is None


def test_ensure_parent_placeholder_refuses_non_native(db, parent):
    sen = _svc(db, keyword="ENDO-LAL", title="Endotoxin", origin="senaite")
    with pytest.raises(mn.ProfileNotNativeError):
        mn.ensure_parent_placeholder(db, parent=parent, service=sen, user_id=None, reason="x")
