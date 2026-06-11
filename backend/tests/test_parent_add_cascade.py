"""Parent-add cascade tests.

Design: when an analysis service is ADDED to a parent AR via Manage Analyses
(the explorer add endpoint's non-native/IS-proxy branch), cascade_parent_add_
to_vials re-runs the idempotent seeder for every non-xtra vial of the family:

  parent_sample_id → LimsSample → sub-samples with a real role
  → seed_analyses_for_vial(role, wp_services, parent_sample_id) per vial

The seeder skips existing keywords, so only the newly-added service lands
(as an unassigned row). HPLC vials mirror the parent's CURRENT active set
(micro keywords stay excluded by the mirror predicate); endo/ster vials
re-seed their fixed whitelist (no-op when already seeded).

Never raises — best-effort, mirrors the retest/reject cascades. WP profile
fetch failure or a SENAITE read error on one vial must not kill the rest.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from lims_analyses.service import cascade_parent_add_to_vials
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
    ServiceGroup,
    service_group_members,
)


WP_ALL = {"hplcpurity_identity": True, "endotoxin": True, "sterility_pcr": True}


# ─── Fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture
def db_mem():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def seed(db_mem):
    """Parent + catalog (HPLC-PUR, PEPT-Total, HPLC-ID, ENDO-LAL with
    Microbiology group membership) + two hplc vials pre-seeded with the
    original two keywords. Returns (db, parent, sub1, sub5)."""
    svc_pur = AnalysisService(title="Peptide Purity (HPLC)", keyword="HPLC-PUR")
    svc_tot = AnalysisService(title="Peptide Total Quantity", keyword="PEPT-Total")
    svc_id = AnalysisService(title="Peptide Identity (HPLC)", keyword="HPLC-ID")
    svc_endo = AnalysisService(title="Endotoxin", keyword="ENDO-LAL")
    db_mem.add_all([svc_pur, svc_tot, svc_id, svc_endo])
    db_mem.flush()

    micro = ServiceGroup(name="Microbiology")
    db_mem.add(micro)
    db_mem.flush()
    db_mem.execute(service_group_members.insert().values(
        service_group_id=micro.id, analysis_service_id=svc_endo.id,
    ))

    parent = LimsSample(sample_id="P-ADDCASC-001", external_lims_uid="uid-addcasc-001")
    db_mem.add(parent)
    db_mem.flush()

    sub1 = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid="mk1://addcasc-001-S01",
        sample_id="P-ADDCASC-001-S01",
        vial_sequence=1,
        assignment_role="hplc",
        assignment_kind="core",
    )
    sub5 = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid="mk1://addcasc-001-S05",
        sample_id="P-ADDCASC-001-S05",
        vial_sequence=5,
        assignment_role="hplc",
        assignment_kind="variance",
    )
    db_mem.add_all([sub1, sub5])
    db_mem.flush()

    for sub in (sub1, sub5):
        for svc in (svc_pur, svc_tot):
            db_mem.add(LimsAnalysis(
                lims_sub_sample_pk=sub.id,
                analysis_service_id=svc.id,
                keyword=svc.keyword,
                title=svc.title,
                review_state="unassigned",
            ))
    db_mem.commit()

    return db_mem, parent, sub1, sub5


def _patch_env(monkeypatch, *, parent_keywords, wp=WP_ALL):
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analysis_keywords",
        lambda pid: list(parent_keywords),
    )
    monkeypatch.setattr(
        "sub_samples.service._fetch_wp_services_for_parent",
        lambda pid: dict(wp) if wp is not None else None,
    )


def _vial_keywords(db, sub):
    rows = db.query(LimsAnalysis).filter(
        LimsAnalysis.lims_sub_sample_pk == sub.id
    ).all()
    return sorted(r.keyword for r in rows)


# ─── Test 1: new parent keyword lands on every hplc vial ─────────────────────


def test_cascade_seeds_new_keyword_on_all_hplc_vials(seed, monkeypatch):
    db, parent, sub1, sub5 = seed
    _patch_env(monkeypatch, parent_keywords=["HPLC-PUR", "PEPT-Total", "HPLC-ID"])

    out = cascade_parent_add_to_vials(
        db, parent_sample_id=parent.sample_id, user_id=None,
    )

    assert out == {
        sub1.sample_id: ["HPLC-ID"],
        sub5.sample_id: ["HPLC-ID"],
    }
    assert _vial_keywords(db, sub1) == ["HPLC-ID", "HPLC-PUR", "PEPT-Total"]
    assert _vial_keywords(db, sub5) == ["HPLC-ID", "HPLC-PUR", "PEPT-Total"]

    new_row = db.query(LimsAnalysis).filter(
        LimsAnalysis.lims_sub_sample_pk == sub1.id,
        LimsAnalysis.keyword == "HPLC-ID",
    ).one()
    assert new_row.review_state == "unassigned"
    assert new_row.result_value is None


# ─── Test 2: idempotent — nothing new → empty map ────────────────────────────


def test_cascade_noop_when_parent_set_unchanged(seed, monkeypatch):
    db, parent, sub1, sub5 = seed
    _patch_env(monkeypatch, parent_keywords=["HPLC-PUR", "PEPT-Total"])

    out = cascade_parent_add_to_vials(
        db, parent_sample_id=parent.sample_id, user_id=None,
    )

    assert out == {}
    assert _vial_keywords(db, sub1) == ["HPLC-PUR", "PEPT-Total"]


# ─── Test 3: xtra / role-less vials are skipped ──────────────────────────────


def test_cascade_skips_xtra_and_unassigned_vials(seed, monkeypatch):
    db, parent, sub1, sub5 = seed
    sub_x = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid="mk1://addcasc-001-S06",
        sample_id="P-ADDCASC-001-S06",
        vial_sequence=6,
        assignment_role="xtra",
    )
    sub_none = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid="mk1://addcasc-001-S07",
        sample_id="P-ADDCASC-001-S07",
        vial_sequence=7,
        assignment_role=None,
    )
    db.add_all([sub_x, sub_none])
    db.commit()

    _patch_env(monkeypatch, parent_keywords=["HPLC-PUR", "PEPT-Total", "HPLC-ID"])
    out = cascade_parent_add_to_vials(
        db, parent_sample_id=parent.sample_id, user_id=None,
    )

    assert set(out) == {sub1.sample_id, sub5.sample_id}
    assert _vial_keywords(db, sub_x) == []
    assert _vial_keywords(db, sub_none) == []


# ─── Test 4: micro keyword added on parent does NOT land on hplc vials ───────


def test_cascade_micro_keyword_excluded_from_hplc_mirror(seed, monkeypatch):
    db, parent, sub1, sub5 = seed
    _patch_env(monkeypatch, parent_keywords=["HPLC-PUR", "PEPT-Total", "ENDO-LAL"])

    out = cascade_parent_add_to_vials(
        db, parent_sample_id=parent.sample_id, user_id=None,
    )

    assert out == {}
    assert _vial_keywords(db, sub1) == ["HPLC-PUR", "PEPT-Total"]


# ─── Test 5: unknown parent → no-op ──────────────────────────────────────────


def test_cascade_no_op_when_parent_missing(seed, monkeypatch):
    db, parent, sub1, sub5 = seed
    _patch_env(monkeypatch, parent_keywords=["HPLC-PUR", "PEPT-Total", "HPLC-ID"])

    out = cascade_parent_add_to_vials(
        db, parent_sample_id="DOES-NOT-EXIST", user_id=None,
    )
    assert out == {}


# ─── Test 6: SENAITE read failure never raises ───────────────────────────────


def test_cascade_senaite_failure_does_not_raise(seed, monkeypatch):
    db, parent, sub1, sub5 = seed

    def _boom(pid):
        raise RuntimeError("SENAITE down")
    monkeypatch.setattr("sub_samples.senaite.fetch_parent_analysis_keywords", _boom)
    monkeypatch.setattr(
        "sub_samples.service._fetch_wp_services_for_parent", lambda pid: dict(WP_ALL),
    )

    out = cascade_parent_add_to_vials(
        db, parent_sample_id=parent.sample_id, user_id=None,
    )
    assert out == {}
    assert _vial_keywords(db, sub1) == ["HPLC-PUR", "PEPT-Total"]


# ─── Test 7: WP profile unavailable → no-op, no raise ────────────────────────


def test_cascade_wp_fetch_failure_does_not_raise(seed, monkeypatch):
    db, parent, sub1, sub5 = seed
    _patch_env(
        monkeypatch,
        parent_keywords=["HPLC-PUR", "PEPT-Total", "HPLC-ID"],
        wp=None,  # IS unreachable / no profile
    )

    out = cascade_parent_add_to_vials(
        db, parent_sample_id=parent.sample_id, user_id=None,
    )
    assert out == {}
