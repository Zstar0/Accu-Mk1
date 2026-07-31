"""Task 13 (spec 4, catalog-driven bench): the spec's headline proofs.

Three things, TESTS ONLY — no production code touched here:

1. The acceptance test (spec verbatim): "new department + new profile via
   API only -> assignment page shows the new section and spot with zero
   code changes." Authors a department + profile + member service through
   the live routes only, then proves every downstream site (demand, vial-
   plan sections, worksheet-inbox lane, box-label summary, custody edge,
   seeding) picks the new catalog row up with no code change of its own.
2. Role-coverage loud-failure (spec's Layer-5 mitigation): a novel/invalid
   role must never silently drop — it refuses loudly at every site.
3. Ride headline cases (spec Testing section), test-only analogs of the
   spec's four bullets: fent alone / fent+HPLC-analog / fent+endo-analog /
   vacuum-chain — demand counts + custody edge relations + seeded unions.

TEST-ONLY keys/roles throughout (zz_*/t13*), per the branch's standing
ledger rule — the real seeded catalog (hplc/endo/ster/xtra/hm + the five
legacy profiles) is never read or written by any test in this file.

Fixture idiom: `client`/`db_session` pair copied from test_ride_lists.py /
test_custody_edges.py (StaticPool in-memory SQLite + get_db/get_current_user
overrides) — `client` for the API-only authoring steps and the inbox-route
loud-failure case; the bare `db_session` (same StaticPool engine, no
TestClient) for the direct function-level assertions everywhere else.
"""
from __future__ import annotations

from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import create_engine, func
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

import main
from main import app
from auth import get_current_user
from database import get_db, Base
from models import (
    AnalysisProfile,
    AnalysisService,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
    VialRole,
    profile_ride_hosts,
)
from sub_samples import service as sub_service
from sub_samples.catalog_demand import resolve_catalog_fulfillment
from sub_samples.custody import current_custody
from catalog.roles import inbox_lanes
from boxes.service import next_box


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()


@pytest.fixture
def client(db_session):
    def _override_get_db():
        yield db_session

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(
        id=1, email="qa@accumark.test"
    )
    tc = TestClient(app)
    yield tc
    if prev_db is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev_db
    if prev_user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = prev_user


# ─── Shared helpers (Steps 2-3; Step 1 authors through the API only) ───────


def _mk_profile(db, key, role, *, vials=1, rides=None, members=None):
    """Mint (if needed) a VialRole for `role` and create + commit an
    AnalysisProfile with fulfillment_role=role, an optional priority-ordered
    ride list (profile_ride_hosts) and optional ordered mk1-origin member
    services (analysis_profile_members). Mint CALL ORDER controls the
    minted role's sort_order, which controls rider-resolution tie-breaking
    across a test (see test_ride_lists.py's identical helper/precondition
    idiom, reused here for the vacuum-chain case)."""
    existing_role = db.query(VialRole).filter_by(code=role).one_or_none()
    if existing_role is None:
        max_sort = db.query(func.coalesce(func.max(VialRole.sort_order), 0)).scalar() or 0
        db.add(VialRole(
            code=role, label=role, department_id=None,
            boxable=False, variance_eligible=False,
            sort_order=max_sort + 1, frozen=False, is_system=False,
        ))
        db.flush()
    p = AnalysisProfile(
        key=key, name=key, is_addon=True, vials_required=vials,
        fulfillment_role=role, fulfillment_dim="role", active=True,
    )
    db.add(p)
    db.flush()
    if rides:
        for i, host in enumerate(rides):
            db.execute(profile_ride_hosts.insert().values(
                analysis_profile_id=p.id, host_role_code=host, priority=i))
    if members:
        from models import analysis_profile_members
        for i, svc in enumerate(members):
            db.execute(analysis_profile_members.insert().values(
                analysis_profile_id=p.id, analysis_service_id=svc.id, sort_order=i))
    db.commit()
    return p


def _mk_service(db, keyword):
    s = AnalysisService(title=keyword, keyword=keyword, origin="mk1")
    db.add(s)
    db.flush()
    return s


def _mk_vial(db, sample_id):
    """Throwaway committed parent + single vial, assignment_role starts
    NULL (set_assignment_role fills it) — mirrors test_catalog_seeding.py's
    test_set_assignment_role_wires_real_edge_driven_seeding construction."""
    parent = LimsSample(sample_id=f"{sample_id}-P", external_lims_uid=f"{sample_id}-p-uid")
    db.add(parent)
    db.flush()
    sub = LimsSubSample(
        sample_id=sample_id, vial_sequence=1, parent_sample_pk=parent.id,
        external_lims_uid=f"{sample_id}-uid",
    )
    db.add(sub)
    db.commit()
    return sub


# ─── Step 1: the acceptance test ───────────────────────────────────────────


class TestManagerAuthorsLabFollows:
    """Spec verbatim: "new department + new profile via API only ->
    assignment page shows the new section and spot with zero code
    changes."""

    def test_manager_authors_lab_follows(self, client, db_session):
        # ── Author via the API only: department, profile (auto-mints the
        # 'zz_acc' role in that department), one mk1-origin member service ──
        dep_resp = client.post("/departments", json={"name": "ZZ Bench"})
        assert dep_resp.status_code == 201, dep_resp.text
        dep = dep_resp.json()

        prof_resp = client.post("/analysis-profiles", json={
            "key": "zz_accept", "name": "ZZ Acceptance", "is_addon": True,
            "fulfillment_dim": "role", "fulfillment_role": "zz_acc",
            "role_department_id": dep["id"], "vials_required": 1,
        })
        assert prof_resp.status_code == 201, prof_resp.text
        prof = prof_resp.json()
        assert prof["fulfillment_role"] == "zz_acc"

        role_row = db_session.query(VialRole).filter_by(code="zz_acc").one()
        assert role_row.department_id == dep["id"]
        assert role_row.boxable is False  # auto-mint safe default (feeds Step 2)

        svc_resp = client.post("/analysis-services", json={
            "title": "ZZ Acceptance Test Service", "keyword": "ZZ-ACCEPT-SVC",
        })
        assert svc_resp.status_code == 201, svc_resp.text
        svc = svc_resp.json()
        assert svc["origin"] == "mk1"

        members_resp = client.put(
            f"/analysis-profiles/{prof['id']}/members",
            json={"analysis_service_ids": [svc["id"]]},
        )
        assert members_resp.status_code == 200
        assert members_resp.json()["count"] == 1

        # ── Simulate an order for the new profile through
        # resolve_catalog_fulfillment ──────────────────────────────────────
        fulfillment = resolve_catalog_fulfillment(db_session, {"zz_accept": 1})
        assert fulfillment["zz_acc"].demand == 1
        assert fulfillment["zz_acc"].host_profile_ids == [prof["id"]]
        assert fulfillment["zz_acc"].rider_profile_ids == []
        assert fulfillment["hplc"].demand == 0
        assert fulfillment["endo"].demand == 0
        assert fulfillment["ster"].demand == 0

        # ── Vial-plan sections: ZZ Bench department + zz_acc spot, the
        # profile as host — zero code changes, a pure catalog read ─────────
        demand = {role: rf.demand for role, rf in fulfillment.items()}
        sections = sub_service._build_vial_plan_sections(
            db_session, demand, [], {"zz_accept": 1})
        zz_section = next(
            (s for s in sections if s["department_name"] == "ZZ Bench"), None)
        assert zz_section is not None, sections
        assert [r["code"] for r in zz_section["roles"]] == ["zz_acc"]
        zz_spot = zz_section["roles"][0]
        assert any(
            p["key"] == "zz_accept" and p["relation"] == "host"
            for p in zz_spot["profiles"]
        ), zz_spot

        # ── Lane map: the slugified 'zz_bench' lane carries the new code ───
        lanes = inbox_lanes(db_session)
        assert "zz_bench" in lanes
        assert lanes["zz_bench"].department_name == "ZZ Bench"
        assert "zz_acc" in lanes["zz_bench"].role_codes

        # ── Box-label summary counts the vial (real route; order fetch + IS
        # services fetch mocked — same idiom as test_order_box_label_
        # summary.py) ───────────────────────────────────────────────────────
        order_row = {
            "order_number": "WP-ZZACC",
            "created_at": datetime(2026, 7, 31, 12, 0, 0),
            "sample_results": {"1": {"senaite_id": "P-ZZACC-01"}},
        }
        services_by_sid = {"P-ZZACC-01": {"services": {"zz_accept": True}}}
        with patch.object(main, "_fetch_order_submission_row", return_value=order_row), \
             patch("sub_samples.service.fetch_sample_services",
                   side_effect=lambda sid: services_by_sid.get(sid)):
            summary_resp = client.get("/orders/WP-ZZACC/box-label-summary")
        assert summary_resp.status_code == 200, summary_resp.text
        assert summary_resp.json()["counts"]["zz_acc"] == 1

        # ── set_assignment_role writes the custody edge; seeding seeds the
        # member service — the real production wiring, one call ───────────
        parent = LimsSample(sample_id="ZZACC-0001", external_lims_uid="zzacc-0001-uid")
        db_session.add(parent)
        db_session.flush()
        sub = LimsSubSample(
            sample_id="ZZACC-0001-S01", vial_sequence=1, parent_sample_pk=parent.id,
            external_lims_uid="zzacc-0001-s01-uid",
        )
        db_session.add(sub)
        db_session.commit()

        result = sub_service.set_assignment_role(
            db_session, sub.sample_id, "zz_acc",
            wp_services={"zz_accept": True}, user_id=7,
        )
        assert result["assignment_role"] == "zz_acc"

        edges = current_custody(db_session, sub.id)
        assert len(edges) == 1
        assert edges[0].relation == "host"
        assert edges[0].analysis_profile_id == prof["id"]

        rows = db_session.query(LimsAnalysis).filter_by(lims_sub_sample_pk=sub.id).all()
        assert [r.keyword for r in rows] == ["ZZ-ACCEPT-SVC"]


# ─── Step 2: role-coverage loud-failure ────────────────────────────────────


class TestRoleCoverageLoudFailure:
    """Spec's Layer-5 mitigation: a novel/invalid role must never silently
    drop through demand -> assign -> lane -> box-label — it refuses loudly
    at the site that can't resolve it."""

    def test_unknown_role_code_raises_on_set_assignment_role(self, db_session):
        with pytest.raises(ValueError, match="Invalid role"):
            sub_service.set_assignment_role(
                db_session, "ZZ13-COVER-NOPE", "zz13_ghost_role")

    def test_unboxable_role_raises_on_next_box(self, db_session):
        db_session.add(VialRole(
            code="zz13unbx", label="ZZ13 Unboxable", department_id=None,
            boxable=False, variance_eligible=False, sort_order=1,
            frozen=False, is_system=False,
        ))
        db_session.commit()
        with pytest.raises(ValueError, match="not boxable"):
            next_box(db_session, "WP-ZZ13COVER", "zz13unbx", user_id=1)

    def test_unknown_lane_key_400s_on_inbox_route(self, client):
        r = client.get("/worksheets/inbox", params={"role": "zz13_nonexistent_lane"})
        assert r.status_code == 400


# ─── Step 3: ride headline cases (spec Testing section) ────────────────────


class TestRideHeadlineCases:
    """Test-only analogs of the spec's four Testing-section bullets. Every
    profile/role here is TEST-ONLY (t13*) — none rides or anchors the real
    hplc/endo/ster buckets."""

    def test_fent_alone_mints_own_spot_seeded_from_own_members(self, db_session):
        """Fent alone -> one 'fent' vial, own spot, seeded from fent's
        members (no host on its ride list is live, so it self-mints)."""
        fent_svc = _mk_service(db_session, "T13-FENT-SVC")
        fent = _mk_profile(db_session, "t13_fent", "t13fent", vials=1,
                            rides=["t13hplc"], members=[fent_svc])

        fulfillment = resolve_catalog_fulfillment(db_session, {"t13_fent": True})
        assert fulfillment["t13fent"].demand == 1
        assert fulfillment["t13fent"].host_profile_ids == [fent.id]
        assert fulfillment["t13fent"].rider_profile_ids == []
        assert "t13hplc" not in fulfillment  # host never ordered, never fabricated

        sub = _mk_vial(db_session, "ZZ13-FENT-S01")
        result = sub_service.set_assignment_role(
            db_session, sub.sample_id, "t13fent",
            wp_services={"t13_fent": True}, user_id=1,
        )
        assert result["assignment_role"] == "t13fent"

        edges = current_custody(db_session, sub.id)
        assert len(edges) == 1
        assert edges[0].relation == "host"
        assert edges[0].analysis_profile_id == fent.id

        rows = db_session.query(LimsAnalysis).filter_by(lims_sub_sample_pk=sub.id).all()
        assert [r.keyword for r in rows] == ["T13-FENT-SVC"]

    def test_fent_plus_hplc_analog_rider_attaches_edges_and_seeding_union(self, db_session):
        """Fent + an HPLC-analog host ordered together -> one host vial,
        fent attached as rider; edge rows host+rider; seeding = union
        (host members first, then rider members)."""
        host_svc = _mk_service(db_session, "T13-HOST-SVC")
        rider_svc = _mk_service(db_session, "T13-RIDER-SVC")
        host = _mk_profile(db_session, "t13_hplc_host", "t13hplc", vials=1,
                            members=[host_svc])
        fent = _mk_profile(db_session, "t13_fent2", "t13fent2", vials=1,
                            rides=["t13hplc"], members=[rider_svc])

        fulfillment = resolve_catalog_fulfillment(
            db_session, {"t13_hplc_host": True, "t13_fent2": True})
        assert fulfillment["t13hplc"].demand == 1
        assert fulfillment["t13hplc"].host_profile_ids == [host.id]
        assert fulfillment["t13hplc"].rider_profile_ids == [fent.id]
        assert "t13fent2" not in fulfillment  # rider attached, never self-minted

        sub = _mk_vial(db_session, "ZZ13-RIDE-S01")
        sub_service.set_assignment_role(
            db_session, sub.sample_id, "t13hplc",
            wp_services={"t13_hplc_host": True, "t13_fent2": True}, user_id=1,
        )

        edges = current_custody(db_session, sub.id)
        relations = {(e.analysis_profile_id, e.relation) for e in edges}
        assert relations == {(host.id, "host"), (fent.id, "rider")}

        rows = db_session.query(LimsAnalysis).filter_by(lims_sub_sample_pk=sub.id).all()
        assert [r.keyword for r in rows] == ["T13-HOST-SVC", "T13-RIDER-SVC"]  # host, then rider

    def test_fent_plus_endo_analog_never_share_two_separate_vials(self, db_session):
        """Fent + a TEST endo-analog, neither on the other's ride list (no
        host on the list) -> two separate vials, never sharing — the spec's
        'sensitive tests never share by construction' property, proven with
        a TEST anchor role rather than the real endo bucket."""
        fent_svc = _mk_service(db_session, "T13-FENT3-SVC")
        endo_svc = _mk_service(db_session, "T13-ENDOA-SVC")
        fent = _mk_profile(db_session, "t13_fent3", "t13fent3", vials=1,
                            rides=["t13hplc3"], members=[fent_svc])
        endo_analog = _mk_profile(db_session, "t13_endo_analog", "t13endoa", vials=1,
                                   members=[endo_svc])

        fulfillment = resolve_catalog_fulfillment(
            db_session, {"t13_fent3": True, "t13_endo_analog": True})
        assert fulfillment["t13fent3"].demand == 1  # self-mint, host absent
        assert fulfillment["t13fent3"].host_profile_ids == [fent.id]
        assert fulfillment["t13fent3"].rider_profile_ids == []
        assert fulfillment["t13endoa"].demand == 1  # independent anchor
        assert fulfillment["t13endoa"].host_profile_ids == [endo_analog.id]
        assert fulfillment["t13endoa"].rider_profile_ids == []
        assert "t13hplc3" not in fulfillment  # host never ordered, never fabricated

        fent_vial = _mk_vial(db_session, "ZZ13-FENT3-S01")
        endo_vial = _mk_vial(db_session, "ZZ13-ENDOA-S01")
        sub_service.set_assignment_role(
            db_session, fent_vial.sample_id, "t13fent3",
            wp_services={"t13_fent3": True, "t13_endo_analog": True}, user_id=1,
        )
        sub_service.set_assignment_role(
            db_session, endo_vial.sample_id, "t13endoa",
            wp_services={"t13_fent3": True, "t13_endo_analog": True}, user_id=1,
        )

        fent_edges = current_custody(db_session, fent_vial.id)
        endo_edges = current_custody(db_session, endo_vial.id)
        assert [(e.analysis_profile_id, e.relation) for e in fent_edges] == [(fent.id, "host")]
        assert [(e.analysis_profile_id, e.relation) for e in endo_edges] == [(endo_analog.id, "host")]

        fent_rows = db_session.query(LimsAnalysis).filter_by(lims_sub_sample_pk=fent_vial.id).all()
        endo_rows = db_session.query(LimsAnalysis).filter_by(lims_sub_sample_pk=endo_vial.id).all()
        assert [r.keyword for r in fent_rows] == ["T13-FENT3-SVC"]
        assert [r.keyword for r in endo_rows] == ["T13-ENDOA-SVC"]  # never cross-contaminated

    def test_vacuum_chain_attaches_to_earlier_self_mint(self, db_session):
        """Vacuum rides [hplc-analog, fent-analog]; the hplc-analog host is
        absent, fent is ordered standalone (self-mints its own vial) ->
        vacuum attaches to fent's vial: ONE fent vial hosting vacuum, edge
        rows host(fent)+rider(vacuum), seeding = union."""
        fent_svc = _mk_service(db_session, "T13-VFENT-SVC")
        vac_svc = _mk_service(db_session, "T13-VAC-SVC")
        # Mint order matters: fent's own role (t13vfent) must sort before
        # vacuum's (t13vvac) so the rider-resolution loop sees fent's
        # self-mint land in `result` before vacuum's turn — same precondition
        # as test_ride_lists.py's test_rider_chain_attaches_to_earlier_self_mint.
        fent = _mk_profile(db_session, "t13_vfent", "t13vfent", vials=1,
                            rides=["t13vhplc"], members=[fent_svc])
        vacuum = _mk_profile(db_session, "t13_vacuum", "t13vvac", vials=1,
                              rides=["t13vhplc", "t13vfent"], members=[vac_svc])

        fent_sort = db_session.query(VialRole).filter_by(code="t13vfent").one().sort_order
        vac_sort = db_session.query(VialRole).filter_by(code="t13vvac").one().sort_order
        assert fent_sort < vac_sort  # named precondition, not just a comment

        fulfillment = resolve_catalog_fulfillment(
            db_session, {"t13_vfent": True, "t13_vacuum": True})
        assert fulfillment["t13vfent"].demand == 1  # ONE vial, not two
        assert fulfillment["t13vfent"].host_profile_ids == [fent.id]
        assert fulfillment["t13vfent"].rider_profile_ids == [vacuum.id]
        assert "t13vvac" not in fulfillment  # vacuum never self-minted its own role
        assert "t13vhplc" not in fulfillment  # absent host never fabricated

        sub = _mk_vial(db_session, "ZZ13-VAC-S01")
        sub_service.set_assignment_role(
            db_session, sub.sample_id, "t13vfent",
            wp_services={"t13_vfent": True, "t13_vacuum": True}, user_id=1,
        )

        edges = current_custody(db_session, sub.id)
        relations = {(e.analysis_profile_id, e.relation) for e in edges}
        assert relations == {(fent.id, "host"), (vacuum.id, "rider")}

        rows = db_session.query(LimsAnalysis).filter_by(lims_sub_sample_pk=sub.id).all()
        assert [r.keyword for r in rows] == ["T13-VFENT-SVC", "T13-VAC-SVC"]  # host, then rider
