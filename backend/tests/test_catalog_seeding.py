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
