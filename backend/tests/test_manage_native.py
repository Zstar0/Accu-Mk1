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
    AnalysisProfile, AnalysisService, LimsAnalysis, LimsAnalysisTransition,
    LimsSample, LimsSubSample, LimsSubSampleEvent, VialProfileAssignment,
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
