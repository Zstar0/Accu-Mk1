"""Catalog-driven seeding for catalog roles (spec 3, task 2).

role_implies_seeding stays legacy-only when called without `db` (the five
ROLE_TO_WP_KEYS roles resolve from the hand-synced map, unchanged). Any role
NOT in that map is a catalog role: with `db` supplied, it resolves from
Analysis Profile membership (fulfillment_dim='role', fulfillment_role=<role>).
seed_analyses_for_vial follows the same split — endo/ster/xtra/hplc are
untouched; catalog roles (first tenant: "hm") seed from ordered profile
members, fail-closed on any non-mk1-origin member.
"""
from __future__ import annotations


def _add_profile_members(db, prof, svcs):
    """Ordered junction rows (analysis_profile_members.sort_order). Same
    idiom as test_native_sections.py's _mk_native_profile."""
    from models import analysis_profile_members
    for i, svc in enumerate(svcs):
        db.execute(analysis_profile_members.insert().values(
            analysis_profile_id=prof.id, analysis_service_id=svc.id, sort_order=i,
        ))
    db.flush()


def _mk_catalog(db):
    """Heavy Metals profile: 4 mk1-origin member services, ordered."""
    from models import AnalysisProfile, AnalysisService
    svcs = []
    for i, kw in enumerate(["HM-PB", "HM-AS", "HM-CD", "HM-HG"]):
        s = AnalysisService(title=kw, keyword=kw, origin="mk1", unit="ppm")
        db.add(s); db.flush(); svcs.append(s)
    p = AnalysisProfile(key="heavy_metals", name="Heavy Metals", is_addon=True,
                        vials_required=1, fulfillment_role="hm",
                        fulfillment_dim="role", active=True)
    db.add(p); db.flush()
    _add_profile_members(db, p, svcs)
    db.commit()
    return p, svcs


def _mk_parent_and_vial(db, *, role):
    """Throwaway parent + vial (flush only), same shape as
    test_seeder_mirror.py's _throwaway_vial / _mk_isolated_vial."""
    from models import LimsSample, LimsSubSample
    parent = LimsSample(sample_id="ZZTEST-HM", external_lims_uid="zz-uid-hm")
    db.add(parent); db.flush()
    v = LimsSubSample(
        sample_id="ZZTEST-HM-S01",
        vial_sequence=0,
        parent_sample_pk=parent.id,
        external_lims_uid="zz-vuid-hm",
        assignment_role=role,
    )
    db.add(v); db.flush()
    return v


def test_role_implies_seeding_catalog_role(db_session):
    from lims_analyses.seeder import role_implies_seeding
    _mk_catalog(db_session)
    assert role_implies_seeding("hm", {"heavy_metals": True}, db=db_session)
    assert not role_implies_seeding("hm", {"heavy_metals": False}, db=db_session)
    assert not role_implies_seeding("hm", {"endotoxin": True}, db=db_session)


def test_role_implies_seeding_legacy_unchanged_without_db():
    from lims_analyses.seeder import role_implies_seeding
    assert role_implies_seeding("endo", {"endotoxin": True})
    assert not role_implies_seeding("xtra", {"endotoxin": True})


def test_hm_vial_seeds_exactly_profile_members(db_session):
    from lims_analyses.seeder import seed_analyses_for_vial
    from models import LimsAnalysis
    p, svcs = _mk_catalog(db_session)
    sub = _mk_parent_and_vial(db_session, role="hm")
    created = seed_analyses_for_vial(
        db_session, sub_sample=sub, role="hm",
        wp_services={"heavy_metals": True}, commit=True)
    rows = db_session.query(LimsAnalysis).filter_by(lims_sub_sample_pk=sub.id).all()
    assert sorted(r.keyword for r in rows) == ["HM-AS", "HM-CD", "HM-HG", "HM-PB"]
    # Order is load-bearing (models.py:322-328: sort_order on the junction row
    # IS the row order); _mk_catalog seeds members HM-PB/HM-AS/HM-CD/HM-HG at
    # sort_order 0..3, so the profile-membership order must survive verbatim
    # into insertion order. A stray sorted()/set() anywhere in the catalog
    # path would pass the sorted() assertion above but fail this one.
    assert [r.keyword for r in created] == ["HM-PB", "HM-AS", "HM-CD", "HM-HG"]


def test_hm_vial_seeding_idempotent(db_session):
    from lims_analyses.seeder import seed_analyses_for_vial
    p, svcs = _mk_catalog(db_session)
    sub = _mk_parent_and_vial(db_session, role="hm")
    seed_analyses_for_vial(db_session, sub_sample=sub, role="hm",
                           wp_services={"heavy_metals": True}, commit=True)
    again = seed_analyses_for_vial(db_session, sub_sample=sub, role="hm",
                                   wp_services={"heavy_metals": True}, commit=True)
    assert again == []  # existing_kw skip, mirrors the endo/ster idiom


def test_hm_never_seeds_on_hplc_vial(db_session, monkeypatch):
    """Behavioral regression pin, not just a static-map fact: an hplc-role
    vial, whose wp_services requests BOTH the HM catalog profile and HPLC,
    still seeds only its mirrored HPLC analyte and never any HM-* row.

    "hplc" is in ROLE_TO_WP_KEYS but deliberately NOT in ROLE_TO_KEYWORDS (it
    mirrors instead of whitelisting) — so the only thing keeping it out of
    the catalog branch in seed_analyses_for_vial is the unconditional
    `return` inside the `if role == "hplc":` block running BEFORE the
    `if role not in ROLE_TO_KEYWORDS:` catalog check. If those two blocks
    were ever reordered, this test would fail: the catalog branch would
    short-circuit on "no matching catalog members for role=hplc" and return
    [] WITHOUT ever calling the real mirror, so the expected PUR_X mirror row
    would go missing below — a stronger, order-sensitive assertion than
    "hm never appears," which the reordered code would also satisfy.
    """
    from lims_analyses.seeder import ROLE_TO_KEYWORDS, seed_analyses_for_vial
    from models import AnalysisService, Department

    _mk_catalog(db_session)  # heavy_metals profile, fulfillment_role="hm"

    # Analytical-department service the HPLC mirror should pick up (same
    # idiom as test_seeder_mirror.py's allow-list section).
    analytical = Department(name="Analytical")
    db_session.add(analytical)
    db_session.commit()
    db_session.add(AnalysisService(
        title="Purity X", keyword="PUR_X", origin="mk1", department_id=analytical.id,
    ))
    db_session.commit()

    sub = _mk_parent_and_vial(db_session, role="hplc")
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analysis_keywords",
        lambda _sid: ["PUR_X"],
    )

    created = seed_analyses_for_vial(
        db_session, sub_sample=sub, role="hplc",
        wp_services={"heavy_metals": True, "hplcpurity_identity": True},
        parent_sample_id="ZZTEST-HM", commit=False,
    )
    kws = {r.keyword for r in created}
    assert kws == {"PUR_X"}                           # the real hplc mirror ran
    assert not any(k.startswith("HM-") for k in kws)   # never HM catalog leakage

    assert "hm" not in ROLE_TO_KEYWORDS  # secondary: static-map fact, kept as documentation


def test_catalog_seeding_fails_closed_on_non_native_member(db_session):
    """A profile with any non-mk1-origin member seeds nothing (mirrors
    spec-2's all-native section rule) rather than seeding the mk1 subset."""
    from lims_analyses.seeder import seed_analyses_for_vial
    from models import AnalysisProfile, AnalysisService, LimsAnalysis
    native = AnalysisService(title="HM-PB", keyword="HM-PB", origin="mk1", unit="ppm")
    foreign = AnalysisService(title="HM-AS", keyword="HM-AS", origin="senaite", unit="ppm")
    db_session.add_all([native, foreign]); db_session.flush()
    p = AnalysisProfile(key="heavy_metals", name="Heavy Metals", is_addon=True,
                        vials_required=1, fulfillment_role="hm",
                        fulfillment_dim="role", active=True)
    db_session.add(p); db_session.flush()
    _add_profile_members(db_session, p, [native, foreign])
    db_session.commit()
    sub = _mk_parent_and_vial(db_session, role="hm")
    created = seed_analyses_for_vial(
        db_session, sub_sample=sub, role="hm",
        wp_services={"heavy_metals": True}, commit=True)
    assert created == []
    rows = db_session.query(LimsAnalysis).filter_by(lims_sub_sample_pk=sub.id).all()
    assert rows == []


# ─────────────────────────────────────────────────────────────────────────
# Task 6: edge-driven rider-union seeding (spec 4). Custody edges
# (vial_profile_assignments, current = superseded_at IS NULL) are the
# source of truth once they exist for a vial: seeding reads the edges
# instead of re-deriving membership from wp_services. All fixtures below
# use TEST-ONLY profile keys / roles (zz*) distinct from the "hm" fixtures
# above so nothing collides if these tests are ever combined in one DB.
# ─────────────────────────────────────────────────────────────────────────


def _mk_edge(db, sub, prof, relation):
    from models import VialProfileAssignment
    e = VialProfileAssignment(
        lims_sub_sample_pk=sub.id, analysis_profile_id=prof.id, relation=relation,
    )
    db.add(e)
    db.flush()
    return e


def test_host_vial_seeds_union_of_host_and_rider_members(db_session, caplog):
    """Host profile (2 members) + rider profile (2 members), both attached
    to the vial via current custody edges -> the vial seeds the UNION of
    both profiles' members, HOST first then RIDER, each in profile-member
    sort_order. Members are deliberately added out of alphabetical order so
    a stray sorted()/set() in the edge path would fail this ordering
    assertion even while passing a looser set-equality check."""
    import logging
    from lims_analyses.seeder import seed_analyses_for_vial
    from models import AnalysisProfile, AnalysisService, LimsAnalysis

    host_b = AnalysisService(title="ZZ-HOST-B", keyword="ZZ-HOST-B", origin="mk1", unit="ppm")
    host_a = AnalysisService(title="ZZ-HOST-A", keyword="ZZ-HOST-A", origin="mk1", unit="ppm")
    rider_b = AnalysisService(title="ZZ-RIDE-B", keyword="ZZ-RIDE-B", origin="mk1", unit="ppm")
    rider_a = AnalysisService(title="ZZ-RIDE-A", keyword="ZZ-RIDE-A", origin="mk1", unit="ppm")
    db_session.add_all([host_b, host_a, rider_b, rider_a]); db_session.flush()

    host = AnalysisProfile(key="zz_host", name="ZZ Host", is_addon=False,
                           vials_required=1, fulfillment_role="zz",
                           fulfillment_dim="role", active=True)
    rider = AnalysisProfile(key="zz_rider", name="ZZ Rider", is_addon=True,
                            vials_required=1, fulfillment_role="zz_rider_role",
                            fulfillment_dim="role", active=True)
    db_session.add_all([host, rider]); db_session.flush()
    _add_profile_members(db_session, host, [host_b, host_a])   # sort_order 0,1
    _add_profile_members(db_session, rider, [rider_b, rider_a])  # sort_order 0,1
    db_session.commit()

    sub = _mk_parent_and_vial(db_session, role="zz")
    _mk_edge(db_session, sub, host, "host")
    _mk_edge(db_session, sub, rider, "rider")
    db_session.commit()

    with caplog.at_level(logging.INFO):
        created = seed_analyses_for_vial(
            db_session, sub_sample=sub, role="zz",
            wp_services={"zz_host": True}, commit=True)

    assert [r.keyword for r in created] == [
        "ZZ-HOST-B", "ZZ-HOST-A", "ZZ-RIDE-B", "ZZ-RIDE-A",
    ]
    rows = db_session.query(LimsAnalysis).filter_by(lims_sub_sample_pk=sub.id).all()
    assert sorted(r.keyword for r in rows) == [
        "ZZ-HOST-A", "ZZ-HOST-B", "ZZ-RIDE-A", "ZZ-RIDE-B",
    ]
    assert caplog.text.count("catalog_seeded") == 4


def test_seeding_reads_edges_not_rederivation(db_session):
    """Edges are pinned to a rider profile even though wp_services would,
    if re-derived fresh right now, resolve a DIFFERENT rider anchoring the
    same role -> seeded analyses follow the EDGES, not wp_services. The
    display and the audit trail cannot disagree."""
    from lims_analyses.seeder import seed_analyses_for_vial
    from models import AnalysisProfile, AnalysisService

    svc_host = AnalysisService(title="ZZ2-HOST", keyword="ZZ2-HOST", origin="mk1", unit="ppm")
    svc_rider_old = AnalysisService(title="ZZ2-RIDER-OLD", keyword="ZZ2-RIDER-OLD", origin="mk1", unit="ppm")
    svc_rider_new = AnalysisService(title="ZZ2-RIDER-NEW", keyword="ZZ2-RIDER-NEW", origin="mk1", unit="ppm")
    db_session.add_all([svc_host, svc_rider_old, svc_rider_new]); db_session.flush()

    host = AnalysisProfile(key="zz2_host", name="ZZ2 Host", is_addon=False,
                           vials_required=1, fulfillment_role="zz2",
                           fulfillment_dim="role", active=True)
    rider_old = AnalysisProfile(key="zz2_rider_old", name="ZZ2 Rider Old", is_addon=True,
                                vials_required=1, fulfillment_role="zz2_rider_old_role",
                                fulfillment_dim="role", active=True)
    # Same fulfillment_role as the host ("zz2") -- if seeding mistakenly fell
    # back to the wp_services predicate instead of reading edges, THIS is
    # the profile it would pick up instead of rider_old.
    rider_new = AnalysisProfile(key="zz2_rider_new", name="ZZ2 Rider New", is_addon=True,
                                vials_required=1, fulfillment_role="zz2",
                                fulfillment_dim="role", active=True)
    db_session.add_all([host, rider_old, rider_new]); db_session.flush()
    _add_profile_members(db_session, host, [svc_host])
    _add_profile_members(db_session, rider_old, [svc_rider_old])
    _add_profile_members(db_session, rider_new, [svc_rider_new])
    db_session.commit()

    sub = _mk_parent_and_vial(db_session, role="zz2")
    # Edges pinned to the OLD rider at custody-write time.
    _mk_edge(db_session, sub, host, "host")
    _mk_edge(db_session, sub, rider_old, "rider")
    db_session.commit()

    # wp_services NOW would resolve the NEW rider instead (e.g. customer
    # changed their cart after the vial was already assigned) — seeding must
    # ignore this and follow the edges pinned above.
    created = seed_analyses_for_vial(
        db_session, sub_sample=sub, role="zz2",
        wp_services={"zz2_host": True, "zz2_rider_new": True}, commit=True)

    kws = {r.keyword for r in created}
    assert kws == {"ZZ2-HOST", "ZZ2-RIDER-OLD"}
    assert "ZZ2-RIDER-NEW" not in kws


def test_no_edges_falls_back_with_warning(db_session, caplog):
    """Catalog-role vial with zero current custody edges -> seeding falls
    back to the legacy fulfilling-profiles predicate (identical result to
    the pre-task-6 behavior) AND logs catalog_seed_no_custody_fallback."""
    import logging
    from lims_analyses.seeder import seed_analyses_for_vial
    from models import LimsAnalysis

    _mk_catalog(db_session)  # heavy_metals profile, fulfillment_role="hm", no edges written
    sub = _mk_parent_and_vial(db_session, role="hm")

    with caplog.at_level(logging.WARNING):
        created = seed_analyses_for_vial(
            db_session, sub_sample=sub, role="hm",
            wp_services={"heavy_metals": True}, commit=True)

    assert sorted(r.keyword for r in created) == ["HM-AS", "HM-CD", "HM-HG", "HM-PB"]
    assert "catalog_seed_no_custody_fallback" in caplog.text
    rows = db_session.query(LimsAnalysis).filter_by(lims_sub_sample_pk=sub.id).all()
    assert sorted(r.keyword for r in rows) == ["HM-AS", "HM-CD", "HM-HG", "HM-PB"]


def test_rider_members_fail_closed_on_non_native(db_session, caplog):
    """Rider profile has a senaite-origin member -> that PROFILE is skipped
    (catalog_seed_skipped_non_native, whole profile, not just the bad
    member), while the host profile still seeds — the SAME per-profile
    fail-closed origin gate as the legacy (non-edge) path."""
    import logging
    from lims_analyses.seeder import seed_analyses_for_vial
    from models import AnalysisProfile, AnalysisService, LimsAnalysis

    svc_host = AnalysisService(title="ZZ3-HOST", keyword="ZZ3-HOST", origin="mk1", unit="ppm")
    svc_rider_native = AnalysisService(title="ZZ3-RIDER-OK", keyword="ZZ3-RIDER-OK", origin="mk1", unit="ppm")
    svc_rider_foreign = AnalysisService(title="ZZ3-RIDER-BAD", keyword="ZZ3-RIDER-BAD", origin="senaite", unit="ppm")
    db_session.add_all([svc_host, svc_rider_native, svc_rider_foreign]); db_session.flush()

    host = AnalysisProfile(key="zz3_host", name="ZZ3 Host", is_addon=False,
                           vials_required=1, fulfillment_role="zz3",
                           fulfillment_dim="role", active=True)
    rider = AnalysisProfile(key="zz3_rider", name="ZZ3 Rider", is_addon=True,
                            vials_required=1, fulfillment_role="zz3_rider_role",
                            fulfillment_dim="role", active=True)
    db_session.add_all([host, rider]); db_session.flush()
    _add_profile_members(db_session, host, [svc_host])
    _add_profile_members(db_session, rider, [svc_rider_native, svc_rider_foreign])
    db_session.commit()

    sub = _mk_parent_and_vial(db_session, role="zz3")
    _mk_edge(db_session, sub, host, "host")
    _mk_edge(db_session, sub, rider, "rider")
    db_session.commit()

    with caplog.at_level(logging.WARNING):
        created = seed_analyses_for_vial(
            db_session, sub_sample=sub, role="zz3",
            wp_services={"zz3_host": True}, commit=True)

    kws = {r.keyword for r in created}
    assert kws == {"ZZ3-HOST"}
    assert "ZZ3-RIDER-OK" not in kws  # whole rider profile skipped, not just the bad sibling
    assert "catalog_seed_skipped_non_native" in caplog.text
    rows = db_session.query(LimsAnalysis).filter_by(lims_sub_sample_pk=sub.id).all()
    assert [r.keyword for r in rows] == ["ZZ3-HOST"]


def test_set_assignment_role_wires_real_edge_driven_seeding(db_session, caplog):
    """End-to-end through the REAL production wiring (set_assignment_role ->
    write_custody_edges -> db.flush() -> seed_analyses_for_vial), not a
    hand-built VialProfileAssignment row + a direct seed_analyses_for_vial
    call like the four tests above. Proves the `sub_sample=sub_sample`
    threading added at the catalog-branch call site in seed_analyses_for_vial
    actually reaches _catalog_members_for_role inside the real transaction.

    The rider profile anchors a DIFFERENT fulfillment_role ("zz4_rider_role")
    than the vial's assigned role ("hm") and rides "hm" via
    profile_ride_hosts — resolve_catalog_fulfillment attaches it as a RIDER
    on "hm", but the legacy wp_services predicate (fulfillment_role == role)
    could NEVER produce a "zz4_rider_role"-anchored profile for role "hm".
    So the rider's member landing in lims_analyses is only possible if the
    real custody-write -> custody-read path is actually wired end to end —
    not a fallback-predicate coincidence. The absence of
    catalog_seed_no_custody_fallback in the log confirms the edge path (not
    the fallback) is what ran."""
    import logging
    from models import (
        AnalysisProfile, AnalysisService, LimsAnalysis, LimsSample,
        LimsSubSample, profile_ride_hosts,
    )
    import sub_samples.service as svc

    svc_host = AnalysisService(title="ZZ4-HOST", keyword="ZZ4-HOST", origin="mk1", unit="ppm")
    svc_rider = AnalysisService(title="ZZ4-RIDER", keyword="ZZ4-RIDER", origin="mk1", unit="ppm")
    db_session.add_all([svc_host, svc_rider]); db_session.flush()

    host = AnalysisProfile(key="zz4_host", name="ZZ4 Host", is_addon=False,
                           vials_required=1, fulfillment_role="hm",
                           fulfillment_dim="role", active=True)
    rider = AnalysisProfile(key="zz4_rider", name="ZZ4 Rider", is_addon=True,
                            vials_required=1, fulfillment_role="zz4_rider_role",
                            fulfillment_dim="role", active=True)
    db_session.add_all([host, rider]); db_session.flush()
    _add_profile_members(db_session, host, [svc_host])
    _add_profile_members(db_session, rider, [svc_rider])
    db_session.execute(profile_ride_hosts.insert().values(
        analysis_profile_id=rider.id, host_role_code="hm", priority=0,
    ))
    db_session.commit()

    parent = LimsSample(sample_id="ZZ4-0001", external_lims_uid="zz4-uid")
    db_session.add(parent); db_session.flush()
    sub = LimsSubSample(
        sample_id="ZZ4-0001-S01", vial_sequence=1, parent_sample_pk=parent.id,
        external_lims_uid="zz4-0001-s01-uid",
    )
    db_session.add(sub); db_session.commit()

    with caplog.at_level(logging.WARNING):
        result = svc.set_assignment_role(
            db_session, sub.sample_id, "hm",
            wp_services={"zz4_host": True, "zz4_rider": True}, user_id=11,
        )

    assert result["assignment_role"] == "hm"
    rows = db_session.query(LimsAnalysis).filter_by(lims_sub_sample_pk=sub.id).all()
    kws = {r.keyword for r in rows}
    assert kws == {"ZZ4-HOST", "ZZ4-RIDER"}
    assert "catalog_seed_no_custody_fallback" not in caplog.text
