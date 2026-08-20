"""Rider seeding on legacy-host (hplc) vials — spec 2026-08-20-rider-vial-visibility.

The hplc branch of seed_analyses_for_vial historically returned the SENAITE
mirror's rows and never consulted custody edges, so a rider profile riding
`hplc` (the only legal legacy host) never got its member analyses on the host
vial (P-0158 evidence in the spec). The acceptance suite missed it by using an
hplc-ANALOG catalog role (test_catalog_bench_acceptance.py t13hplc).

SENAITE read is monkeypatched at "sub_samples.senaite.fetch_parent_analysis_keywords"
(same target as test_seeder_mirror.py).
"""
from __future__ import annotations

from datetime import datetime

import pytest
from sqlalchemy import create_engine, func
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from database import Base
from models import (
    AnalysisProfile,
    AnalysisService,
    Department,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
    VialProfileAssignment,
    VialRole,
    profile_ride_hosts,
)
from lims_analyses.seeder import seed_analyses_for_vial


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    from catalog.vial_roles_seed import seed_vial_roles
    seed_vial_roles(session)
    yield session
    session.close()


def _svc(db, keyword, origin="mk1", department_id=None):
    s = AnalysisService(title=keyword, keyword=keyword, origin=origin, unit="ppm",
                        department_id=department_id)
    db.add(s)
    db.flush()
    return s


def _profile(db, key, role, members, vials=0, rides=None):
    existing_role = db.query(VialRole).filter_by(code=role).one_or_none()
    if existing_role is None:
        max_sort = db.query(func.coalesce(func.max(VialRole.sort_order), 0)).scalar() or 0
        db.add(VialRole(code=role, label=role, department_id=None, boxable=False,
                        variance_eligible=False, sort_order=max_sort + 1,
                        frozen=False, is_system=False))
        db.flush()
    p = AnalysisProfile(key=key, name=key, is_addon=True, vials_required=vials,
                        fulfillment_role=role, fulfillment_dim="role", active=True)
    p.analysis_services = list(members)
    db.add(p)
    db.flush()
    for i, host in enumerate(rides or []):
        db.execute(profile_ride_hosts.insert().values(
            analysis_profile_id=p.id, host_role_code=host, priority=i))
    db.commit()
    return p


def _vial(db, order_key, role="hplc", kind="core", seq=1):
    parent = LimsSample(sample_id=order_key, external_lims_uid=f"{order_key}-uid")
    db.add(parent)
    db.flush()
    sub = LimsSubSample(sample_id=f"{order_key}-S{seq:02d}", vial_sequence=seq,
                        parent_sample_pk=parent.id, assignment_role=role,
                        assignment_kind=kind,
                        external_lims_uid=f"{order_key}-S{seq:02d}-uid")
    db.add(sub)
    db.commit()
    return parent, sub


def _rider_edge(db, sub, profile, relation="rider"):
    db.add(VialProfileAssignment(lims_sub_sample_pk=sub.id,
                                 analysis_profile_id=profile.id,
                                 relation=relation, assigned_at=datetime.utcnow()))
    db.commit()


def _seed_hplc(db, sub, parent, monkeypatch, keywords=()):
    monkeypatch.setattr("sub_samples.senaite.fetch_parent_analysis_keywords",
                        lambda sid: list(keywords))
    return seed_analyses_for_vial(
        db, sub_sample=sub, role="hplc",
        wp_services={"hplcpurity_identity": True},
        parent_sample_id=parent.sample_id, created_by_user_id=1, commit=True,
    )


def test_rider_edge_member_seeds_on_hplc_vial(db, monkeypatch):
    """A live rider custody edge on an hplc vial seeds the rider profile's
    member service alongside the (empty here) mirror."""
    fent_svc = _svc(db, "ZZR-FENT")
    fent = _profile(db, "zzr_fent", "zzrfent", [fent_svc], rides=["hplc"])
    parent, sub = _vial(db, "ZZR-0001")
    _rider_edge(db, sub, fent)

    rows = _seed_hplc(db, sub, parent, monkeypatch)

    assert [r.keyword for r in rows] == ["ZZR-FENT"]
    persisted = db.query(LimsAnalysis).filter_by(lims_sub_sample_pk=sub.id).all()
    assert [r.keyword for r in persisted] == ["ZZR-FENT"]
    assert persisted[0].review_state == "unassigned"
    assert persisted[0].analysis_service_id == fent_svc.id


def test_rider_seeding_composes_with_mirror(db, monkeypatch):
    """Mirror rows first (Analytical-department keyword), rider member after —
    both on the vial, no interference."""
    analytical = Department(name="Analytical")
    db.add(analytical)
    db.flush()
    _svc(db, "HPLC-PUR", department_id=analytical.id)
    fent_svc = _svc(db, "ZZR2-FENT")
    fent = _profile(db, "zzr2_fent", "zzr2fent", [fent_svc], rides=["hplc"])
    parent, sub = _vial(db, "ZZR2-0001")
    _rider_edge(db, sub, fent)

    rows = _seed_hplc(db, sub, parent, monkeypatch, keywords=["HPLC-PUR"])

    assert [r.keyword for r in rows] == ["HPLC-PUR", "ZZR2-FENT"]


def test_variance_vial_gets_no_rider_rows(db, monkeypatch):
    fent_svc = _svc(db, "ZZR3-FENT")
    fent = _profile(db, "zzr3_fent", "zzr3fent", [fent_svc], rides=["hplc"])
    parent, sub = _vial(db, "ZZR3-0001", kind="variance")
    _rider_edge(db, sub, fent)

    rows = _seed_hplc(db, sub, parent, monkeypatch)

    assert rows == []
    assert db.query(LimsAnalysis).filter_by(lims_sub_sample_pk=sub.id).count() == 0


def test_rider_seeding_is_idempotent(db, monkeypatch):
    fent_svc = _svc(db, "ZZR4-FENT")
    fent = _profile(db, "zzr4_fent", "zzr4fent", [fent_svc], rides=["hplc"])
    parent, sub = _vial(db, "ZZR4-0001")
    _rider_edge(db, sub, fent)

    first = _seed_hplc(db, sub, parent, monkeypatch)
    second = _seed_hplc(db, sub, parent, monkeypatch)

    assert len(first) == 1 and second == []
    assert db.query(LimsAnalysis).filter_by(lims_sub_sample_pk=sub.id).count() == 1


def test_rider_origin_gate_fails_closed(db, monkeypatch):
    """A rider profile with any non-mk1 member seeds nothing (per-profile
    origin gate, same as the catalog path)."""
    ok = _svc(db, "ZZR5-OK")
    foreign = _svc(db, "ZZR5-BAD", origin="senaite")
    fent = _profile(db, "zzr5_fent", "zzr5fent", [ok, foreign], rides=["hplc"])
    parent, sub = _vial(db, "ZZR5-0001")
    _rider_edge(db, sub, fent)

    rows = _seed_hplc(db, sub, parent, monkeypatch)

    assert rows == []


def test_host_edge_alone_adds_nothing_on_hplc(db, monkeypatch):
    """A host edge (the hplc anchor's own edge) must NOT trigger member
    seeding on the hplc branch — the mirror owns hplc host content."""
    host_svc = _svc(db, "ZZR6-HOST")
    anchor = _profile(db, "zzr6_anchor", "hplc", [host_svc], vials=1)
    parent, sub = _vial(db, "ZZR6-0001")
    _rider_edge(db, sub, anchor, relation="host")

    rows = _seed_hplc(db, sub, parent, monkeypatch)

    assert rows == []


# ─── rider-aware stale-row cleanup on role flip (S1b) ────────────────────────

def _stub_seeder(monkeypatch):
    monkeypatch.setattr("lims_analyses.seeder.seed_analyses_for_vial",
                        lambda *a, **k: [])


def _manual_row(db, sub, svc, result_value=None):
    row = LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
                       keyword=svc.keyword, title=svc.title,
                       review_state="unassigned", result_value=result_value)
    db.add(row)
    db.commit()
    return row


def test_flip_away_from_host_role_drops_pristine_rider_row(db, monkeypatch):
    """zzchost -> zzcother: the rider edge disappears (rider rides zzchost
    only), so its pristine row drops even though the department-keyed
    cleanup can't see it (test roles carry department_id=None)."""
    import sub_samples.service as sub_service
    _stub_seeder(monkeypatch)
    host_svc = _svc(db, "ZZC-HOST")
    other_svc = _svc(db, "ZZC-OTHER")
    rider_svc = _svc(db, "ZZC-RIDER")
    _profile(db, "zzc_host", "zzchost", [host_svc], vials=1)
    _profile(db, "zzc_other", "zzcother", [other_svc], vials=1)
    rider = _profile(db, "zzc_rider", "zzcrider", [rider_svc], rides=["zzchost"])
    parent, sub = _vial(db, "ZZC-0001", role=None, kind=None)
    wp = {"zzc_host": True, "zzc_other": True, "zzc_rider": True}

    sub_service.set_assignment_role(db, sub.sample_id, "zzchost", wp_services=wp, user_id=1)
    assert {e.relation for e in _edges(db, sub)} == {"host", "rider"}
    _manual_row(db, sub, rider_svc)  # what Task 1 would have seeded

    sub_service.set_assignment_role(db, sub.sample_id, "zzcother", wp_services=wp, user_id=1)

    kws = [r.keyword for r in db.query(LimsAnalysis).filter_by(lims_sub_sample_pk=sub.id).all()]
    assert "ZZC-RIDER" not in kws


def test_same_role_reassign_keeps_rider_row(db, monkeypatch):
    import sub_samples.service as sub_service
    _stub_seeder(monkeypatch)
    host_svc = _svc(db, "ZZC2-HOST")
    rider_svc = _svc(db, "ZZC2-RIDER")
    _profile(db, "zzc2_host", "zzc2host", [host_svc], vials=1)
    _profile(db, "zzc2_rider", "zzc2rider", [rider_svc], rides=["zzc2host"])
    parent, sub = _vial(db, "ZZC2-0001", role=None, kind=None)
    wp = {"zzc2_host": True, "zzc2_rider": True}

    sub_service.set_assignment_role(db, sub.sample_id, "zzc2host", wp_services=wp, user_id=1)
    _manual_row(db, sub, rider_svc)
    sub_service.set_assignment_role(db, sub.sample_id, "zzc2host", wp_services=wp, user_id=1)

    kws = [r.keyword for r in db.query(LimsAnalysis).filter_by(lims_sub_sample_pk=sub.id).all()]
    assert "ZZC2-RIDER" in kws


def test_worked_rider_row_is_never_dropped(db, monkeypatch):
    import sub_samples.service as sub_service
    _stub_seeder(monkeypatch)
    host_svc = _svc(db, "ZZC3-HOST")
    other_svc = _svc(db, "ZZC3-OTHER")
    rider_svc = _svc(db, "ZZC3-RIDER")
    _profile(db, "zzc3_host", "zzc3host", [host_svc], vials=1)
    _profile(db, "zzc3_other", "zzc3other", [other_svc], vials=1)
    _profile(db, "zzc3_rider", "zzc3rider", [rider_svc], rides=["zzc3host"])
    parent, sub = _vial(db, "ZZC3-0001", role=None, kind=None)
    wp = {"zzc3_host": True, "zzc3_other": True, "zzc3_rider": True}

    sub_service.set_assignment_role(db, sub.sample_id, "zzc3host", wp_services=wp, user_id=1)
    _manual_row(db, sub, rider_svc, result_value="0.5")  # worked

    sub_service.set_assignment_role(db, sub.sample_id, "zzc3other", wp_services=wp, user_id=1)

    kws = [r.keyword for r in db.query(LimsAnalysis).filter_by(lims_sub_sample_pk=sub.id).all()]
    assert "ZZC3-RIDER" in kws


def _edges(db, sub):
    from sub_samples.custody import current_custody
    return current_custody(db, sub.id)
