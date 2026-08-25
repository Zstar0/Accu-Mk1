"""Route-level tests for /api/sub-samples endpoints.

Focus: auth gating, schema validation, error handling, and happy-path responses.
The underlying service logic is covered separately; these tests verify FastAPI
wiring (dependency injection, status codes, JSON envelope).

Auth is mocked via app.dependency_overrides per the project pattern.
"""
from datetime import datetime
from unittest.mock import patch, MagicMock
import pytest
from sqlalchemy import select
from fastapi.testclient import TestClient
from main import app
from auth import get_current_user
from sub_samples.senaite import SecondaryFalloutError

client = TestClient(app)


@pytest.fixture(autouse=True)
def override_auth():
    """Override auth dependency for all tests. Each test can use the mocked user."""
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    yield
    app.dependency_overrides.pop(get_current_user, None)


def _mock_sub(sample_id="P-0134-S01", parent_id="P-0134", vial_seq=1, remarks=None):
    """Create a mock LimsSubSample for testing."""
    sub = MagicMock()
    sub.id = 1
    sub.sample_id = sample_id
    sub.vial_sequence = vial_seq
    sub.received_at = datetime.utcnow()
    sub.received_by_user_id = 1
    sub.photo_external_uid = f"/senaite/clients/client-8/{sample_id}"
    sub.remarks = remarks
    sub.assignment_role = None
    sub.assignment_kind = None
    sub.external_lims_uid = "a8c27e69bfa84ff1bf16a3e370a44456"  # legacy SENAITE uid
    sub.parent_sample = MagicMock(sample_id=parent_id)
    return sub


def test_create_sub_sample_201():
    """POST /api/sub-samples returns 201 with SubSampleResponse."""
    sub = _mock_sub()
    with patch("sub_samples.routes.service.create_sub_sample", return_value=sub):
        resp = client.post(
            "/api/sub-samples",
            json={"parent_sample_id": "P-0134", "photo_base64": "YWJj", "remarks": None},
        )
    assert resp.status_code == 201
    body = resp.json()
    assert body["sample_id"] == "P-0134-S01"
    assert body["parent_sample_id"] == "P-0134"
    assert body["vial_sequence"] == 1


def test_create_sub_sample_passes_decoded_photo_bytes_to_service():
    """POST decodes base64 photo and passes bytes to service."""
    sub = _mock_sub()
    with patch("sub_samples.routes.service.create_sub_sample", return_value=sub) as svc:
        client.post(
            "/api/sub-samples",
            json={"parent_sample_id": "P-0134", "photo_base64": "YWJj", "remarks": "first"},
        )
    kwargs = svc.call_args.kwargs
    assert kwargs["parent_sample_id"] == "P-0134"
    assert kwargs["photo_bytes"] == b"abc"  # base64 "YWJj" → b"abc"
    assert kwargs["remarks"] == "first"
    assert kwargs["user_id"] == 1


def test_create_sub_sample_rejects_invalid_base64():
    """POST with malformed base64 returns 400."""
    with patch("sub_samples.routes.service.create_sub_sample"):
        resp = client.post(
            "/api/sub-samples",
            json={"parent_sample_id": "P-0134", "photo_base64": "!!!invalid!!!", "remarks": None},
        )
    assert resp.status_code == 400
    assert "photo_base64" in resp.json()["detail"]


def test_create_sub_sample_502_on_secondary_fallout_with_orphan_info():
    """POST returns 502 with structured fallout error including orphan IDs."""
    fallout = SecondaryFalloutError(
        "test fallout",
        orphan_uid="ORPHAN_UID_ABC",
        orphan_sample_id="P-0136",
    )
    with patch("sub_samples.routes.service.create_sub_sample", side_effect=fallout):
        resp = client.post(
            "/api/sub-samples",
            json={"parent_sample_id": "P-0134", "photo_base64": "YWJj", "remarks": None},
        )
    assert resp.status_code == 502
    body = resp.json()
    assert body["detail"]["code"] == "secondary_fallout"
    assert body["detail"]["orphan_uid"] == "ORPHAN_UID_ABC"
    assert body["detail"]["orphan_sample_id"] == "P-0136"
    assert "test fallout" in body["detail"]["message"]


def test_create_sub_sample_502_on_generic_runtime_error():
    """POST with RuntimeError from service returns 502 with message."""
    with patch("sub_samples.routes.service.create_sub_sample",
               side_effect=RuntimeError("parent has no contact_uid")):
        resp = client.post(
            "/api/sub-samples",
            json={"parent_sample_id": "P-0134", "photo_base64": "YWJj", "remarks": None},
        )
    assert resp.status_code == 502
    assert "contact_uid" in resp.json()["detail"]


def test_list_sub_samples_with_children():
    """GET /api/sub-samples returns parent summary + children."""
    parent = MagicMock(
        sample_id="P-0134",
        external_lims_uid="UID",
        peptide_name="BPC-157",
        status="sample_received",
        last_synced_at=datetime.utcnow(),
    )
    s1 = _mock_sub("P-0134-S01", "P-0134", 1)
    s2 = _mock_sub("P-0134-S02", "P-0134", 2)
    with patch("sub_samples.routes.service.list_sub_samples", return_value=(parent, [s1, s2])):
        resp = client.get("/api/sub-samples?parent_sample_id=P-0134")
    assert resp.status_code == 200
    body = resp.json()
    assert body["parent"]["sample_id"] == "P-0134"
    assert body["parent"]["sub_sample_count"] == 2
    assert len(body["sub_samples"]) == 2
    assert body["sub_samples"][0]["vial_sequence"] == 1
    assert body["sub_samples"][1]["vial_sequence"] == 2


def test_list_sub_samples_empty_for_unknown_parent():
    """GET with unknown parent returns 200 with empty list."""
    with patch("sub_samples.routes.service.list_sub_samples", return_value=(None, [])):
        resp = client.get("/api/sub-samples?parent_sample_id=P-9999")
    assert resp.status_code == 200
    body = resp.json()
    assert body["parent"]["sample_id"] == "P-9999"
    assert body["parent"]["sub_sample_count"] == 0
    assert body["sub_samples"] == []
    assert body["parent"]["external_lims_uid"] is None


def test_list_sub_samples_missing_parent_query_param():
    """GET without parent_sample_id returns 422."""
    resp = client.get("/api/sub-samples")
    assert resp.status_code == 422


def test_update_sub_sample_200():
    """PATCH /api/sub-samples/{sample_id} returns 200 with updated response."""
    sub = _mock_sub(sample_id="P-0134-S01", remarks="updated")
    with patch("sub_samples.routes.service.update_sub_sample", return_value=sub):
        resp = client.patch(
            "/api/sub-samples/P-0134-S01",
            json={"photo_base64": None, "remarks": "updated"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["sample_id"] == "P-0134-S01"
    assert body["remarks"] == "updated"


def test_update_sub_sample_with_photo():
    """PATCH with photo_base64 decodes and passes to service."""
    sub = _mock_sub()
    with patch("sub_samples.routes.service.update_sub_sample", return_value=sub) as svc:
        client.patch(
            "/api/sub-samples/P-0134-S01",
            json={"photo_base64": "ZGVm", "remarks": None},
        )
    args = svc.call_args.args
    assert args[1] == "P-0134-S01"  # sample_id
    assert args[2] == b"def"  # photo_bytes (base64 "ZGVm" → b"def")
    assert args[3] == "vial.jpg"  # photo_filename


def test_update_sub_sample_no_changes():
    """PATCH with all None values is valid (no-op)."""
    sub = _mock_sub()
    with patch("sub_samples.routes.service.update_sub_sample", return_value=sub) as svc:
        resp = client.patch(
            "/api/sub-samples/P-0134-S01",
            json={"photo_base64": None, "remarks": None},
        )
    assert resp.status_code == 200
    args = svc.call_args.args
    assert args[1] == "P-0134-S01"  # sample_id
    assert args[2] is None  # photo_bytes
    assert args[3] is None  # photo_filename
    assert args[4] is None  # remarks


def test_update_sub_sample_502_on_runtime_error():
    """PATCH with RuntimeError returns 502."""
    with patch("sub_samples.routes.service.update_sub_sample",
               side_effect=RuntimeError("sample not found")):
        resp = client.patch(
            "/api/sub-samples/P-0134-S01",
            json={"photo_base64": None, "remarks": "new remarks"},
        )
    assert resp.status_code == 502
    assert "sample not found" in resp.json()["detail"]


def test_delete_sub_sample_204():
    """DELETE /api/sub-samples/{sample_id} returns 204 with empty body."""
    with patch("sub_samples.routes.service.delete_sub_sample", return_value=None):
        resp = client.delete("/api/sub-samples/P-0134-S01")
    assert resp.status_code == 204
    assert resp.text == ""


def test_delete_sub_sample_502_on_runtime_error():
    """DELETE with RuntimeError returns 502."""
    with patch("sub_samples.routes.service.delete_sub_sample",
               side_effect=RuntimeError("cannot delete")):
        resp = client.delete("/api/sub-samples/P-0134-S01")
    assert resp.status_code == 502
    assert "cannot delete" in resp.json()["detail"]


def test_vial_plan_returns_full_layout():
    """GET /api/sub-samples/{parent}/vial-plan returns demand + per-vial roles."""
    parent = MagicMock()
    parent.sample_id = "BW-0006"
    parent.assignment_role = "hplc"
    sub1 = _mock_sub("BW-0006-S01", "BW-0006", vial_seq=1)
    sub1.assignment_role = None
    sub2 = _mock_sub("BW-0006-S02", "BW-0006", vial_seq=2)
    sub2.assignment_role = None
    sub3 = _mock_sub("BW-0006-S03", "BW-0006", vial_seq=3)
    sub3.assignment_role = None

    with patch("sub_samples.routes.service.compute_vial_plan", return_value={
        "demand": {"hplc": 1, "endo": 1, "ster": 1},
        "wp_order_number": "3229",
        "vials": [
            {"sample_id": "BW-0006",     "is_parent": True,  "vial_sequence": 0, "assignment_role": "hplc"},
            {"sample_id": "BW-0006-S01", "is_parent": False, "vial_sequence": 1, "assignment_role": "endo"},
            {"sample_id": "BW-0006-S02", "is_parent": False, "vial_sequence": 2, "assignment_role": "ster"},
            {"sample_id": "BW-0006-S03", "is_parent": False, "vial_sequence": 3, "assignment_role": "ster"},
        ],
        "is_unreachable": False,
    }):
        resp = client.get("/api/sub-samples/BW-0006/vial-plan")
    assert resp.status_code == 200
    body = resp.json()
    assert body["demand"] == {"hplc": 1, "endo": 1, "ster": 1}
    assert body["wp_order_number"] == "3229"
    assert len(body["vials"]) == 4
    assert body["vials"][0]["is_parent"] is True
    assert body["vials"][1]["assignment_role"] == "endo"


def test_vial_plan_returns_503_envelope_when_is_unreachable():
    with patch("sub_samples.routes.service.compute_vial_plan", return_value={
        "demand": {"hplc": 0, "endo": 0, "ster": 0},
        "wp_order_number": None,
        "vials": [
            {"sample_id": "BW-0006", "is_parent": True, "vial_sequence": 0, "assignment_role": "hplc"},
        ],
        "is_unreachable": True,
    }):
        resp = client.get("/api/sub-samples/BW-0006/vial-plan")
    assert resp.status_code == 200  # body envelope, not http 503 — wizard banner-renders
    body = resp.json()
    assert body["is_unreachable"] is True
    assert body["demand"] == {"hplc": 0, "endo": 0, "ster": 0}


# ─── Task 8: vial-plan sections metadata ─────────────────────────────────────
#
# Sections is built INSIDE the real compute_vial_plan (role_registry + demand +
# the vials it's about to return + catalog fulfillment), so — unlike the two
# tests above, which mock compute_vial_plan wholesale to exercise the route
# layer only — these call the real function against a real (dev/test)
# Postgres session, mirroring test_variance_demand.py's SessionLocal + ZZTEST-
# prefixed throwaway-row idiom. Only the IS fetch is mocked (fixtures/mocking
# idiom named in the brief); set_assignment_role is stubbed too — the real one
# drives HPLC's live-SENAITE analyte mirror (mirror_parent_hplc_analyses),
# which is out of scope here (covered elsewhere) and would make these tests
# slow/flaky against a ZZTEST parent with no real SENAITE AR. compute_vial_plan
# already fails soft around that call (try/except + rollback, self-healing on
# the next GET) — the response's `vials` (and therefore `sections`, which is
# built from that same in-memory list, never a DB re-read) don't depend on the
# persist loop's success either way.
from database import SessionLocal
from models import AnalysisProfile, LimsSample, LimsSubSample, profile_ride_hosts
from sqlalchemy import text as sql_text
from sub_samples import service as sub_service


@pytest.fixture()
def real_db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def _ensure_catalog(db):
    """Idempotent — guarantees the Analytical/Microbiology/Heavy Metals
    departments and the five legacy vial_roles rows exist regardless of this
    DB's seed freshness (mirrors database.py:init_db's own startup order)."""
    from catalog.departments import backfill_departments
    from catalog.profile_seed import seed_profiles_from_registry
    from catalog.vial_roles_seed import seed_vial_roles
    backfill_departments(db)
    seed_vial_roles(db)
    seed_profiles_from_registry(db)
    db.commit()


def _mk_zztest_parent(db, sample_id, n_subs=0):
    """Committed ZZTEST parent (legacy, container_mode=False) with `n_subs`
    sub-samples (assignment_role starts NULL — auto-assign fills it)."""
    parent = LimsSample(sample_id=sample_id, peptide_name="ZZ", status="received")
    db.add(parent)
    db.flush()
    for i in range(1, n_subs + 1):
        db.add(LimsSubSample(
            sample_id=f"{sample_id}-S{i:02d}",
            parent_sample_pk=parent.id,
            external_lims_uid=f"zz-uid-{sample_id}-{i}",
            vial_sequence=i,
            received_at=datetime.utcnow(),
        ))
    db.commit()
    return parent


def _cleanup_zztest(db, sample_id):
    db.rollback()
    db.execute(sql_text("DELETE FROM lims_sub_samples WHERE sample_id LIKE :p"), {"p": f"{sample_id}%"})
    db.execute(sql_text("DELETE FROM lims_samples WHERE sample_id = :s"), {"s": sample_id})
    db.commit()


def _stub_set_assignment_role(db, sample_id, role, kind=None, user_id=None, wp_services=None):
    """Direct column write, skipping custody-edge/seeding machinery (out of
    scope here — see module comment above)."""
    sub = db.execute(
        select(LimsSubSample).where(LimsSubSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if sub is not None:
        sub.assignment_role = role
        sub.assignment_kind = kind
        db.commit()
    return {"sample_id": sample_id, "assignment_role": role}


class TestVialPlanSections:
    def test_sections_empty_when_is_unreachable(self, real_db, monkeypatch):
        _ensure_catalog(real_db)
        _mk_zztest_parent(real_db, "ZZTEST-SEC-UNRCH")
        monkeypatch.setattr(sub_service, "fetch_sample_services", lambda sid: None)
        try:
            plan = sub_service.compute_vial_plan(real_db, "ZZTEST-SEC-UNRCH")
            assert plan["is_unreachable"] is True
            assert plan["sections"] == []
        finally:
            _cleanup_zztest(real_db, "ZZTEST-SEC-UNRCH")

    def test_sections_legacy_order_carries_analytical_and_microbiology(self, real_db, monkeypatch):
        _ensure_catalog(real_db)
        _mk_zztest_parent(real_db, "ZZTEST-SEC-LEG", n_subs=3)
        services = {"hplcpurity_identity": True, "endotoxin": True, "sterility_pcr": True}
        monkeypatch.setattr(
            sub_service, "fetch_sample_services",
            lambda sid: {"services": services, "wp_order_number": "WP-SEC-1"},
        )
        monkeypatch.setattr(sub_service, "set_assignment_role", _stub_set_assignment_role)
        try:
            plan = sub_service.compute_vial_plan(real_db, "ZZTEST-SEC-LEG")
            sections = plan["sections"]
            # ordered by department sort_order
            assert [s["department_name"] for s in sections] == ["Analytical", "Microbiology"]
            analytical = sections[0]
            micro = sections[1]
            assert [r["code"] for r in analytical["roles"]] == ["hplc"]
            assert [r["code"] for r in micro["roles"]] == ["endo", "ster"]
            # today's role spot: hplc carries its host profile
            hplc_spot = analytical["roles"][0]
            assert any(
                p == {"id": p["id"], "key": "hplcpurity_identity",
                      "name": p["name"], "relation": "host"}
                for p in hplc_spot["profiles"]
            )
            # xtra never appears in sections anywhere
            assert all(r["code"] != "xtra" for s in sections for r in s["roles"])
        finally:
            _cleanup_zztest(real_db, "ZZTEST-SEC-LEG")

    def test_sections_hm_order_carries_heavy_metals_section(self, real_db, monkeypatch):
        _ensure_catalog(real_db)
        # Test-only profile key — PRODUCT_REGISTRY carries no real "heavy_metals"
        # product yet (spec 4's WP addon hasn't shipped), so this stands in for
        # it without depending on / colliding with a future real one.
        real_db.query(AnalysisProfile).filter_by(key="zztest_heavy_metals").delete()
        real_db.commit()
        real_db.add(AnalysisProfile(
            key="zztest_heavy_metals", name="ZZTEST Heavy Metals", is_addon=True,
            vials_required=1, fulfillment_role="hm", fulfillment_dim="role", active=True,
        ))
        real_db.commit()
        _mk_zztest_parent(real_db, "ZZTEST-SEC-HM", n_subs=1)
        services = {"zztest_heavy_metals": True}
        monkeypatch.setattr(
            sub_service, "fetch_sample_services",
            lambda sid: {"services": services, "wp_order_number": "WP-SEC-2"},
        )
        monkeypatch.setattr(sub_service, "set_assignment_role", _stub_set_assignment_role)
        try:
            plan = sub_service.compute_vial_plan(real_db, "ZZTEST-SEC-HM")
            sections = plan["sections"]
            hm_section = next((s for s in sections if s["department_name"] == "Heavy Metals"), None)
            assert hm_section is not None, sections
            assert [r["code"] for r in hm_section["roles"]] == ["hm"]
            hm_spot = hm_section["roles"][0]
            assert hm_spot["variance_eligible"] is False
            assert any(
                p["key"] == "zztest_heavy_metals" and p["relation"] == "host"
                for p in hm_spot["profiles"]
            )
        finally:
            _cleanup_zztest(real_db, "ZZTEST-SEC-HM")
            real_db.query(AnalysisProfile).filter_by(key="zztest_heavy_metals").delete()
            real_db.commit()

    def test_sections_rider_profile_appears_with_relation_rider_on_host_role(self, real_db, monkeypatch):
        _ensure_catalog(real_db)
        real_db.query(AnalysisProfile).filter_by(key="zztest_rides_hplc").delete()
        real_db.commit()
        rider = AnalysisProfile(
            key="zztest_rides_hplc", name="ZZTEST Rides HPLC", is_addon=True,
            vials_required=1, fulfillment_role="zztridehplc", fulfillment_dim="role", active=True,
        )
        real_db.add(rider)
        real_db.flush()
        real_db.execute(profile_ride_hosts.insert().values(
            analysis_profile_id=rider.id, host_role_code="hplc", priority=0,
        ))
        real_db.commit()
        _mk_zztest_parent(real_db, "ZZTEST-SEC-RIDE", n_subs=1)
        services = {"hplcpurity_identity": True, "zztest_rides_hplc": True}
        monkeypatch.setattr(
            sub_service, "fetch_sample_services",
            lambda sid: {"services": services, "wp_order_number": "WP-SEC-3"},
        )
        monkeypatch.setattr(sub_service, "set_assignment_role", _stub_set_assignment_role)
        try:
            plan = sub_service.compute_vial_plan(real_db, "ZZTEST-SEC-RIDE")
            sections = plan["sections"]
            analytical = next(s for s in sections if s["department_name"] == "Analytical")
            hplc_spot = next(r for r in analytical["roles"] if r["code"] == "hplc")
            relations = {(p["key"], p["relation"]) for p in hplc_spot["profiles"]}
            assert ("hplcpurity_identity", "host") in relations
            assert ("zztest_rides_hplc", "rider") in relations
            # the rider never self-mints its own role/section
            assert all(r["code"] != "zztridehplc" for s in sections for r in s["roles"])
        finally:
            _cleanup_zztest(real_db, "ZZTEST-SEC-RIDE")
            real_db.query(AnalysisProfile).filter_by(key="zztest_rides_hplc").delete()
            real_db.commit()

    def test_sections_locked_carries_real_sections_grouping_stored_roles(self, real_db, monkeypatch):
        """Fix round (review finding, overturns the initial 'sections: []
        on both early returns' reading): a variance-locked parent still
        gets REAL sections. _build_vial_plan_sections is a pure grouping
        read over demand/services/vials with no auto-assign precondition —
        a locked-but-assigned parent already has everything it needs (real
        demand, real services, _current_vials() reflecting the STORED
        roles), even though auto-assign itself is skipped (spec §5 lock
        guard, untouched by this task). Only the IS-unreachable early
        return (no services to resolve fulfillment against) carries
        sections: []."""
        _ensure_catalog(real_db)
        parent = _mk_zztest_parent(real_db, "ZZTEST-SEC-LOCKED", n_subs=2)
        subs = real_db.query(LimsSubSample).filter(
            LimsSubSample.sample_id.like("ZZTEST-SEC-LOCKED%")
        ).order_by(LimsSubSample.vial_sequence).all()
        subs[0].assignment_role = "hplc"
        subs[0].assignment_kind = "core"
        # subs[1] stays NULL — proves auto-assign did NOT run under the lock.
        parent.variance_locked_at = datetime.utcnow()
        real_db.commit()
        services = {"hplcpurity_identity": True}
        monkeypatch.setattr(
            sub_service, "fetch_sample_services",
            lambda sid: {"services": services, "wp_order_number": "WP-SEC-4"},
        )
        try:
            plan = sub_service.compute_vial_plan(real_db, "ZZTEST-SEC-LOCKED")
            assert plan["is_unreachable"] is False
            # auto-assign did NOT run: the unassigned sub is still NULL in
            # both the response's own vials list and the DB.
            vial_by_id = {v["sample_id"]: v for v in plan["vials"]}
            assert vial_by_id[subs[1].sample_id]["assignment_role"] is None
            real_db.refresh(subs[1])
            assert subs[1].assignment_role is None
            # sections is REAL, grouping the stored hplc assignment.
            sections = plan["sections"]
            analytical = next((s for s in sections if s["department_name"] == "Analytical"), None)
            assert analytical is not None, sections
            assert [r["code"] for r in analytical["roles"]] == ["hplc"]
            hplc_spot = analytical["roles"][0]
            assert any(
                p["key"] == "hplcpurity_identity" and p["relation"] == "host"
                for p in hplc_spot["profiles"]
            )
        finally:
            _cleanup_zztest(real_db, "ZZTEST-SEC-LOCKED")

    def test_sections_excludes_unknown_role_and_logs_error(self, real_db, monkeypatch, caplog):
        """Fail-closed judgment call from the brief: a code with demand > 0
        but NO vial_roles row (predates the catalog, or a bad WP payload
        minted a role the registry never learned) is logged and EXCLUDED —
        never synthesizes a placeholder department."""
        _ensure_catalog(real_db)
        real_db.query(AnalysisProfile).filter_by(key="zztest_ghost_role").delete()
        real_db.commit()
        real_db.add(AnalysisProfile(
            key="zztest_ghost_role", name="ZZTEST Ghost Role", is_addon=True,
            vials_required=1, fulfillment_role="zzghost", fulfillment_dim="role", active=True,
        ))
        real_db.commit()
        _mk_zztest_parent(real_db, "ZZTEST-SEC-GHOST", n_subs=1)
        services = {"zztest_ghost_role": True}
        monkeypatch.setattr(
            sub_service, "fetch_sample_services",
            lambda sid: {"services": services, "wp_order_number": "WP-SEC-5"},
        )
        monkeypatch.setattr(sub_service, "set_assignment_role", _stub_set_assignment_role)
        try:
            with caplog.at_level("ERROR"):
                plan = sub_service.compute_vial_plan(real_db, "ZZTEST-SEC-GHOST")
            # precondition: the ghost code really did reach the candidate set
            # (demand > 0) — otherwise this test would pass vacuously.
            assert plan["demand"].get("zzghost", 0) > 0
            assert any(
                "vial_plan_unknown_role" in r.message and "zzghost" in r.message
                for r in caplog.records
            )
            assert all(r["code"] != "zzghost" for s in plan["sections"] for r in s["roles"])
        finally:
            _cleanup_zztest(real_db, "ZZTEST-SEC-GHOST")
            real_db.query(AnalysisProfile).filter_by(key="zztest_ghost_role").delete()
            real_db.commit()

    def test_sections_survive_persist_loop_failure(self, real_db, monkeypatch):
        """The realistic outage path: SENAITE flaky -> set_assignment_role
        raises for every vial -> compute_vial_plan's existing try/except
        rolls back and logs, per vial (untouched by this task). Sections must
        still build correctly off the in-memory `assigned` list handed to it
        — the same invariant that makes `vials` self-healing on the next GET,
        proven here by asserting NOTHING actually persisted to the DB."""
        _ensure_catalog(real_db)
        _mk_zztest_parent(real_db, "ZZTEST-SEC-FAIL", n_subs=2)
        services = {"hplcpurity_identity": True, "endotoxin": True}
        monkeypatch.setattr(
            sub_service, "fetch_sample_services",
            lambda sid: {"services": services, "wp_order_number": "WP-SEC-6"},
        )

        def _raising_set_assignment_role(db, sample_id, role, kind=None, user_id=None, wp_services=None):
            raise RuntimeError("simulated live-SENAITE outage")

        monkeypatch.setattr(sub_service, "set_assignment_role", _raising_set_assignment_role)
        try:
            plan = sub_service.compute_vial_plan(real_db, "ZZTEST-SEC-FAIL")
            # demand hplc=1 (consumed by the pre-set parent), endo=1 (fills
            # the first sub); the second sub overflows to xtra.
            non_parent_roles = {v["assignment_role"] for v in plan["vials"] if not v["is_parent"]}
            assert non_parent_roles == {"endo", "xtra"}
            sections = plan["sections"]
            assert {s["department_name"] for s in sections} == {"Analytical", "Microbiology"}
            analytical = next(s for s in sections if s["department_name"] == "Analytical")
            micro = next(s for s in sections if s["department_name"] == "Microbiology")
            assert [r["code"] for r in analytical["roles"]] == ["hplc"]
            assert [r["code"] for r in micro["roles"]] == ["endo"]
            # nothing actually persisted — proves this exercised the real
            # failure/rollback path, not a no-op.
            subs = real_db.query(LimsSubSample).filter(
                LimsSubSample.sample_id.like("ZZTEST-SEC-FAIL%")
            ).all()
            assert all(s.assignment_role is None for s in subs)
        finally:
            _cleanup_zztest(real_db, "ZZTEST-SEC-FAIL")


def test_assignment_patch_subsample_to_endo():
    sub = _mock_sub("BW-0006-S01", "BW-0006", vial_seq=1)
    sub.assignment_role = "ster"
    with patch("sub_samples.routes.service.set_assignment_role") as fn:
        fn.return_value = {"sample_id": "BW-0006-S01", "assignment_role": "endo"}
        resp = client.patch(
            "/api/sub-samples/BW-0006-S01/assignment",
            json={"role": "endo"},
        )
    assert resp.status_code == 200
    assert resp.json() == {"sample_id": "BW-0006-S01", "assignment_role": "endo"}
    fn.assert_called_once()
    args, kwargs = fn.call_args
    assert kwargs.get("sample_id") or args[1] == "BW-0006-S01"
    assert kwargs.get("role") or args[2] == "endo"


def test_assignment_patch_subsample_null_resets():
    """null role on a sub-sample sets assignment_role=NULL (auto-assign on next plan call)."""
    with patch("sub_samples.routes.service.set_assignment_role") as fn:
        fn.return_value = {"sample_id": "BW-0006-S01", "assignment_role": None}
        resp = client.patch(
            "/api/sub-samples/BW-0006-S01/assignment",
            json={"role": None},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["assignment_role"] is None


def test_assignment_patch_parent_null_coerced_to_hplc():
    """null role on the parent AR is coerced to 'hplc' — preserves the
    'primary always HPLC' rule even after Reset-to-auto."""
    with patch("sub_samples.routes.service.set_assignment_role") as fn:
        fn.return_value = {"sample_id": "BW-0006", "assignment_role": "hplc"}
        resp = client.patch(
            "/api/sub-samples/BW-0006/assignment",
            json={"role": None},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["assignment_role"] == "hplc"


def test_aggregates_returns_count_and_parent_role_per_parent():
    """POST /aggregates returns vial_count and parent_role keyed by
    parent_sample_id. vial_count counts the sub-sample vials only (the parent
    is not a physical vial). Parents without sub-samples are omitted."""
    with patch("sub_samples.routes.service.aggregate_by_parent") as fn:
        fn.return_value = {
            # 1 endo + 2 ster sub-sample vials = 3 vials (parent not counted)
            "BW-0006": {"vial_count": 3, "parent_role": "hplc",
                        "variance": {"hplc": 2, "endo": 0, "ster": 0}},
            # PB-0099 NOT returned — not in lims_samples
            # P-0115 absent because it has no sub-samples (single-vial,
            # nothing to surface on the list)
        }
        resp = client.post(
            "/api/sub-samples/aggregates",
            json={"parent_sample_ids": ["BW-0006", "P-0115", "PB-0099"]},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert "aggregates" in body
    aggs = body["aggregates"]
    assert set(aggs.keys()) == {"BW-0006"}
    assert aggs["BW-0006"]["vial_count"] == 3
    assert aggs["BW-0006"]["parent_role"] == "hplc"
    assert aggs["BW-0006"]["variance"] == {"hplc": 2, "endo": 0, "ster": 0}
    assert "PB-0099" not in aggs
    assert "P-0115" not in aggs


def test_aggregates_rejects_empty_id_list():
    """min_length=1 on parent_sample_ids — empty list returns 422."""
    resp = client.post(
        "/api/sub-samples/aggregates",
        json={"parent_sample_ids": []},
    )
    assert resp.status_code == 422


def test_bulk_create_201_passes_decoded_photo_bytes_to_filename_helper():
    """POST /api/sub-samples/bulk returns 201.

    Regression guard: the route builds photo_filename via
    _filename_from_request(photo_bytes), which requires the decoded bytes. A
    call site that drops the argument raises TypeError before the service runs
    (500 on every bulk create). The service is mocked so this test isolates the
    route's photo-decode + filename wiring.
    """
    subs = [_mock_sub("P-0134-S01", vial_seq=1), _mock_sub("P-0134-S02", vial_seq=2)]
    with patch(
        "sub_samples.routes.service.create_sub_samples_bulk",
        return_value=(subs, None),
    ):
        resp = client.post(
            "/api/sub-samples/bulk",
            json={
                "parent_sample_id": "P-0134",
                "photo_base64": "YWJj",
                "count": 2,
                "remarks": None,
            },
        )
    assert resp.status_code == 201
    body = resp.json()
    assert body["requested"] == 2
    assert body["failed"] == 0
    assert len(body["created"]) == 2


def test_material_vial_annotation_on_list():
    """analytical_vials pooling: the list endpoint stamps material_for on a
    custody-only vial (capped role, zero live analyses) naming its sibling
    anchor. Live-DB rows (the annotation's profile/analyses reads are real
    queries); TEST-prefixed + cleaned up."""
    from datetime import datetime as _dt
    from sqlalchemy import delete
    from database import SessionLocal
    from lims_analyses.service import create_analysis
    from models import (
        AnalysisProfile, AnalysisService, LimsAnalysis, LimsSample,
        LimsSubSample,
    )

    db = SessionLocal()
    try:
        # Cleanup-first (self-restoring even after a prior crashed run).
        for pk_q in [
            delete(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk.in_(
                select(LimsSubSample.id).where(
                    LimsSubSample.sample_id.like("TEST-MATV%")))),
            delete(LimsSubSample).where(
                LimsSubSample.sample_id.like("TEST-MATV%")),
            delete(LimsSample).where(LimsSample.sample_id.like("TEST-MATV%")),
            delete(AnalysisProfile).where(
                AnalysisProfile.key == "zz_matvial_test"),
            delete(AnalysisService).where(
                AnalysisService.keyword == "ZZMAT-X"),
        ]:
            db.execute(pk_q)
        db.commit()

        svc = AnalysisService(title="ZZ Mat X", keyword="ZZMAT-X", origin="mk1")
        db.add(svc)
        db.flush()
        prof = AnalysisProfile(
            key="zz_matvial_test", name="ZZ MatVial Test", is_addon=True,
            vials_required=2, analytical_vials=1,
            fulfillment_role="zzmat", fulfillment_dim="role", active=True)
        parent = LimsSample(sample_id="TEST-MATV", external_lims_uid="uid-matv")
        db.add_all([prof, parent])
        db.flush()
        v1 = LimsSubSample(
            sample_id="TEST-MATV-S01", vial_sequence=1,
            parent_sample_pk=parent.id, external_lims_uid="mk1://matv1",
            assignment_role="zzmat", received_at=_dt.utcnow())
        v2 = LimsSubSample(
            sample_id="TEST-MATV-S02", vial_sequence=2,
            parent_sample_pk=parent.id, external_lims_uid="mk1://matv2",
            assignment_role="zzmat", received_at=_dt.utcnow())
        db.add_all([v1, v2])
        db.flush()
        create_analysis(db, host_kind="sub_sample", host_pk=v1.id,
                        analysis_service_id=svc.id, keyword="ZZMAT-X",
                        title="ZZ Mat X")
        db.commit()

        resp = client.get("/api/sub-samples?parent_sample_id=TEST-MATV")
        assert resp.status_code == 200
        by_id = {s["sample_id"]: s for s in resp.json()["sub_samples"]}
        assert by_id["TEST-MATV-S01"]["material_for"] is None
        assert by_id["TEST-MATV-S02"]["material_for"] == "TEST-MATV-S01"
    finally:
        db.rollback()
        for pk_q in [
            delete(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk.in_(
                select(LimsSubSample.id).where(
                    LimsSubSample.sample_id.like("TEST-MATV%")))),
            delete(LimsSubSample).where(
                LimsSubSample.sample_id.like("TEST-MATV%")),
            delete(LimsSample).where(LimsSample.sample_id.like("TEST-MATV%")),
            delete(AnalysisProfile).where(
                AnalysisProfile.key == "zz_matvial_test"),
            delete(AnalysisService).where(
                AnalysisService.keyword == "ZZMAT-X"),
        ]:
            db.execute(pk_q)
        db.commit()
        db.close()
