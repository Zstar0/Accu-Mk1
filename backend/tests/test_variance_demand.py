"""Variance demand derivation + vial-plan breakdown + lock guard.

Explicit-bucket model (2026-06-10-variance-bucket-assignment-design.md §2):
core demand = base; variance is a SEPARATE bucket target — the old max(base, n)
demand inflation (2026-06-10-variance-testing-addon-design.md §2) is retired.
"""
import pytest

from sub_samples import service as sub_service


BASE_SERVICES = {
    "hplcpurity_identity": True,
    "endotoxin": True,
    "sterility_pcr": True,
}


class TestDeriveVarianceDemand:
    def test_maps_keys_to_buckets_as_paid_replicates(self):
        # Purchased n = TOTAL vials tested per bucket; the first vial is part
        # of the core offering, so the variance bucket target is n - 1 paid
        # replicates (2026-06-10 PB-0077 product-semantics decision).
        out = sub_service.derive_variance_demand({
            **BASE_SERVICES,
            "variance": {"hplcpurity_identity": 3, "endotoxin": 2},
        })
        assert out == {"hplc": 2, "endo": 1, "ster": 0}

    def test_two_vial_set_targets_one_replicate(self):
        # The common product: "2-vial variance" = core vial + ONE paid replicate.
        out = sub_service.derive_variance_demand({
            **BASE_SERVICES,
            "variance": {"hplcpurity_identity": 2},
        })
        assert out == {"hplc": 1, "endo": 0, "ster": 0}

    def test_zero_without_variance(self):
        assert sub_service.derive_variance_demand(BASE_SERVICES) == {
            "hplc": 0, "endo": 0, "ster": 0,
        }

    def test_ignores_invalid_counts_via_normalize(self):
        out = sub_service.derive_variance_demand({
            **BASE_SERVICES,
            "variance": {"hplcpurity_identity": 1, "endotoxin": "junk"},
        })
        assert out == {"hplc": 0, "endo": 0, "ster": 0}

    def test_bw_variance_maps_to_hplc_bucket(self):
        # BW orders carry variance count under bac_water_panel, not hplcpurity_identity.
        # Both are chromatography (hplc bucket) and are mutually exclusive per order.
        # Handler decision 2026-06-17.
        services = {"variance": {"bac_water_panel": 3}}  # 3 total -> 2 paid replicates
        assert sub_service.derive_variance_demand(services)["hplc"] == 2

    def test_peptide_variance_still_maps_to_hplc_bucket(self):
        # Guard: peptide path unchanged after BW-aware extension.
        services = {"variance": {"hplcpurity_identity": 2}}
        assert sub_service.derive_variance_demand(services)["hplc"] == 1


class TestDeriveDemandCore:
    """Explicit-bucket model: derive_demand is CORE demand only. The old
    inflation assertions (test_variance_inflates_per_bucket expecting
    max(base, n)) are intentionally superseded."""

    def test_no_variance_unchanged(self):
        assert sub_service.derive_demand(BASE_SERVICES) == {
            "hplc": 1, "endo": 1, "ster": 1,
        }

    def test_variance_does_not_inflate_core_demand(self):
        out = sub_service.derive_demand({
            **BASE_SERVICES,
            "variance": {"hplcpurity_identity": 3, "endotoxin": 2},
        })
        assert out == {"hplc": 1, "endo": 1, "ster": 1}

    def test_unordered_service_stays_zero(self):
        # core demand is the lab baseline; a (contract-invalid) variance key
        # on an unordered service never creates core demand.
        out = sub_service.derive_demand({
            "sterility_pcr": True,
            "variance": {"sterility_pcr": 2, "hplcpurity_identity": 5},
        })
        assert out["ster"] == 1
        assert out["hplc"] == 0


class TestDeriveBaseDemand:
    def test_base_is_pre_variance(self):
        out = sub_service.derive_base_demand({
            **BASE_SERVICES,
            "variance": {"hplcpurity_identity": 5},
        })
        assert out == {"hplc": 1, "endo": 1, "ster": 1}


# ─── Fixtures for compute_vial_plan tests (ZZTEST throwaway parent) ──────────

from datetime import datetime

from sqlalchemy import text

from database import SessionLocal
from models import LimsSample


@pytest.fixture()
def zztest_vard_parent():
    """Committed ZZTEST parent with no sub-samples.

    compute_vial_plan commits when role changes occur; creating the row first
    (committed) means ensure_sample_row finds it immediately without going to
    SENAITE. No sub-samples → no role-change commits happen.
    """
    db = SessionLocal()
    row = LimsSample(sample_id="ZZTEST-VARD", peptide_name="ZZ", status="received")
    db.add(row)
    db.commit()
    yield row
    # teardown
    db.rollback()
    db.execute(text("DELETE FROM lims_samples WHERE sample_id = 'ZZTEST-VARD'"))
    db.commit()
    db.close()


class TestVialDemandResponses:
    def test_compute_vial_plan_carries_variance(self, zztest_vard_parent, monkeypatch):
        monkeypatch.setattr(
            sub_service, "fetch_sample_services",
            lambda sid: {"services": {**BASE_SERVICES,
                                      "variance": {"hplcpurity_identity": 3}},
                         "wp_order_number": "WP-1"},
        )
        db = SessionLocal()
        try:
            plan = sub_service.compute_vial_plan(db, "ZZTEST-VARD")
            # purchased 3 => 2 paid replicates on top of the core vial
            assert plan["variance"] == {"hplc": 2, "endo": 0, "ster": 0}
            # explicit-bucket model: demand is core/base — no max() inflation
            assert plan["demand"]["hplc"] == 1
            assert plan["base_demand"]["hplc"] == 1
        finally:
            db.rollback()
            db.close()

    def test_unreachable_plan_has_zero_variance(self, zztest_vard_parent, monkeypatch):
        monkeypatch.setattr(
            sub_service, "fetch_sample_services", lambda sid: None)
        db = SessionLocal()
        try:
            plan = sub_service.compute_vial_plan(db, "ZZTEST-VARD")
            assert plan["is_unreachable"] is True
            assert plan["variance"] == {"hplc": 0, "endo": 0, "ster": 0}
            assert plan["base_demand"] == {"hplc": 0, "endo": 0, "ster": 0}
        finally:
            db.rollback()
            db.close()


# ─── Task 2: lock_variance_set series-complete guard ─────────────────────────

from models import LimsAnalysis, LimsSubSample


@pytest.fixture()
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


@pytest.fixture()
def lock_fixture(db):
    """ZZTEST parent (in set) + 2 hplc vials (in set) each with one analysis
    row. Variance purchased for hplc (n=3) via injected fetch."""
    parent = LimsSample(sample_id="ZZTEST-VARLOCK", peptide_name="ZZ", status="received")
    db.add(parent)
    db.flush()
    vials, rows = [], []
    svc_id = db.execute(text("SELECT id FROM analysis_services LIMIT 1")).scalar_one()
    for i in (1, 2):
        v = LimsSubSample(
            sample_id=f"ZZTEST-VARLOCK-S0{i}",
            parent_sample_pk=parent.id,
            external_lims_uid=f"zz-uid-varlock-{i}",
            vial_sequence=i,
            received_at=datetime.utcnow(),
            assignment_role="hplc",
        )
        db.add(v)
        db.flush()
        r = LimsAnalysis(
            lims_sub_sample_pk=v.id,
            analysis_service_id=svc_id,
            keyword=f"ZZTEST-VARLOCK-KW{i}",
            title="ZZ",
            result_value="9",
            review_state="variance_verified",
        )
        db.add(r)
        vials.append(v)
        rows.append(r)
    db.commit()
    yield {"parent": parent, "vials": vials, "rows": rows}
    db.rollback()
    db.execute(text("DELETE FROM lims_analyses WHERE keyword LIKE 'ZZTEST-VARLOCK%'"))
    db.execute(text("DELETE FROM lims_sub_samples WHERE sample_id LIKE 'ZZTEST-VARLOCK%'"))
    db.execute(text("DELETE FROM lims_samples WHERE sample_id LIKE 'ZZTEST-VARLOCK%'"))
    db.execute(text("DELETE FROM audit_logs WHERE entity_id LIKE 'ZZTEST-VARLOCK%'"))
    db.commit()


VARIANCE_SERVICES = {"services": {**BASE_SERVICES, "variance": {"hplcpurity_identity": 3}}}


class TestLockSeriesGuard:
    def test_locks_when_all_rows_signed_off(self, db, lock_fixture, monkeypatch):
        monkeypatch.setattr(sub_service, "fetch_sample_services",
                            lambda sid: VARIANCE_SERVICES)
        parent = sub_service.lock_variance_set(db, "ZZTEST-VARLOCK", user_id=1)
        assert parent.variance_locked_at is not None
        # cleanup the lock so teardown deletes cleanly
        sub_service.unlock_variance_set(db, "ZZTEST-VARLOCK")

    def test_blocks_on_unfinished_row(self, db, lock_fixture, monkeypatch):
        monkeypatch.setattr(sub_service, "fetch_sample_services",
                            lambda sid: VARIANCE_SERVICES)
        row = lock_fixture["rows"][0]
        row.review_state = "to_be_verified"
        db.commit()
        with pytest.raises(sub_service.VarianceSeriesIncompleteError, match="ZZTEST-VARLOCK-S01"):
            sub_service.lock_variance_set(db, "ZZTEST-VARLOCK", user_id=1)

    def test_promoted_rows_count_as_done(self, db, lock_fixture, monkeypatch):
        monkeypatch.setattr(sub_service, "fetch_sample_services",
                            lambda sid: VARIANCE_SERVICES)
        row = lock_fixture["rows"][0]
        row.review_state = "promoted"
        db.commit()
        parent = sub_service.lock_variance_set(db, "ZZTEST-VARLOCK", user_id=1)
        assert parent.variance_locked_at is not None
        sub_service.unlock_variance_set(db, "ZZTEST-VARLOCK")

    def test_retested_rows_exempt(self, db, lock_fixture, monkeypatch):
        monkeypatch.setattr(sub_service, "fetch_sample_services",
                            lambda sid: VARIANCE_SERVICES)
        row = lock_fixture["rows"][0]
        row.review_state = "to_be_verified"
        row.retested = True  # superseded by a retest chain
        db.commit()
        parent = sub_service.lock_variance_set(db, "ZZTEST-VARLOCK", user_id=1)
        assert parent.variance_locked_at is not None
        sub_service.unlock_variance_set(db, "ZZTEST-VARLOCK")

    def test_no_variance_or_unreachable_skips_guard(self, db, lock_fixture, monkeypatch):
        row = lock_fixture["rows"][0]
        row.review_state = "to_be_verified"
        db.commit()
        # unreachable
        monkeypatch.setattr(sub_service, "fetch_sample_services", lambda sid: None)
        parent = sub_service.lock_variance_set(db, "ZZTEST-VARLOCK", user_id=1)
        assert parent.variance_locked_at is not None
        sub_service.unlock_variance_set(db, "ZZTEST-VARLOCK")
        # reachable, no variance purchased
        monkeypatch.setattr(sub_service, "fetch_sample_services",
                            lambda sid: {"services": dict(BASE_SERVICES)})
        parent = sub_service.lock_variance_set(db, "ZZTEST-VARLOCK", user_id=1)
        assert parent.variance_locked_at is not None
        sub_service.unlock_variance_set(db, "ZZTEST-VARLOCK")

    def test_excluded_vial_not_checked(self, db, lock_fixture, monkeypatch):
        monkeypatch.setattr(sub_service, "fetch_sample_services",
                            lambda sid: VARIANCE_SERVICES)
        vial = lock_fixture["vials"][0]
        row = lock_fixture["rows"][0]
        vial.in_variance_set = False
        row.review_state = "to_be_verified"
        db.commit()
        parent = sub_service.lock_variance_set(db, "ZZTEST-VARLOCK", user_id=1)
        assert parent.variance_locked_at is not None
        sub_service.unlock_variance_set(db, "ZZTEST-VARLOCK")


# ─── Lock/unlock activity logging ────────────────────────────────────────────

from sqlalchemy import select as _select
from models import AuditLog


class TestVarianceLockAudit:
    def test_lock_writes_audit_log(self, db, lock_fixture, monkeypatch):
        # user_id=1 is the seeded admin (variance_locked_by_user_id FK -> users).
        monkeypatch.setattr(sub_service, "fetch_sample_services",
                            lambda sid: VARIANCE_SERVICES)
        sub_service.lock_variance_set(db, "ZZTEST-VARLOCK", user_id=1)
        log = db.execute(
            _select(AuditLog).where(
                AuditLog.entity_type == "variance_set",
                AuditLog.entity_id == "ZZTEST-VARLOCK",
                AuditLog.operation == "variance_set_locked",
            )
        ).scalars().first()
        assert log is not None
        assert log.details.get("user_id") == 1
        # parent (in_variance_set) + 2 in-set sub-vials = 3
        assert log.details.get("selected_vials") == 3
        sub_service.unlock_variance_set(db, "ZZTEST-VARLOCK", user_id=1)

    def test_unlock_writes_audit_log(self, db, lock_fixture, monkeypatch):
        # unlock clears the FK column to NULL, so its user_id only lands in
        # AuditLog.details — any value is fine there (no FK).
        monkeypatch.setattr(sub_service, "fetch_sample_services",
                            lambda sid: VARIANCE_SERVICES)
        sub_service.lock_variance_set(db, "ZZTEST-VARLOCK", user_id=1)
        sub_service.unlock_variance_set(db, "ZZTEST-VARLOCK", user_id=9)
        log = db.execute(
            _select(AuditLog).where(
                AuditLog.entity_type == "variance_set",
                AuditLog.entity_id == "ZZTEST-VARLOCK",
                AuditLog.operation == "variance_set_unlocked",
            )
        ).scalars().first()
        assert log is not None
        assert log.details.get("user_id") == 9


# ─── Variance override storage + merge ───────────────────────────────────────

import json


@pytest.fixture()
def zztest_varov_parent(db):
    """Committed ZZTEST parent for variance-override tests."""
    from sqlalchemy import text
    row = LimsSample(sample_id="ZZTEST-VAROV", peptide_name="ZZ", status="received")
    db.add(row)
    db.commit()
    yield row
    db.rollback()
    db.execute(text("DELETE FROM lims_samples WHERE sample_id = 'ZZTEST-VAROV'"))
    db.commit()


class TestSetVarianceOverride:
    def test_stores_normalized_json(self, db, zztest_varov_parent):
        """Stores valid int>=2 entries; drops invalid."""
        result = sub_service.set_variance_override(
            db,
            "ZZTEST-VAROV",
            {"hplcpurity_identity": 3, "endotoxin": 1, "junk": "x"},
        )
        assert result == {"hplcpurity_identity": 3}
        db.refresh(zztest_varov_parent)
        stored = json.loads(zztest_varov_parent.variance_override)
        assert stored == {"hplcpurity_identity": 3}

    def test_clear_with_none_nulls_column(self, db, zztest_varov_parent):
        """Clearing with None nulls the column."""
        sub_service.set_variance_override(db, "ZZTEST-VAROV", {"hplcpurity_identity": 3})
        sub_service.set_variance_override(db, "ZZTEST-VAROV", None)
        db.refresh(zztest_varov_parent)
        assert zztest_varov_parent.variance_override is None

    def test_clear_with_empty_dict_nulls_column(self, db, zztest_varov_parent):
        """Clearing with {} also nulls the column."""
        sub_service.set_variance_override(db, "ZZTEST-VAROV", {"hplcpurity_identity": 3})
        sub_service.set_variance_override(db, "ZZTEST-VAROV", {})
        db.refresh(zztest_varov_parent)
        assert zztest_varov_parent.variance_override is None

    def test_raises_variance_locked_error_when_locked(self, db, zztest_varov_parent):
        """Blocked while variance set is locked."""
        zztest_varov_parent.variance_locked_at = datetime.utcnow()
        db.commit()
        with pytest.raises(sub_service.VarianceLockedError):
            sub_service.set_variance_override(db, "ZZTEST-VAROV", {"hplcpurity_identity": 3})
        # cleanup
        zztest_varov_parent.variance_locked_at = None
        db.commit()

    def test_raises_lookup_error_for_missing_sample(self, db):
        """LookupError for unknown sample."""
        with pytest.raises(LookupError, match="ZZTEST-MISSING"):
            sub_service.set_variance_override(db, "ZZTEST-MISSING", {"hplcpurity_identity": 3})


class TestApplyVarianceOverride:
    def test_merges_override_into_payload(self, db, zztest_varov_parent):
        """Override is merged into services['variance']."""
        sub_service.set_variance_override(
            db, "ZZTEST-VAROV", {"hplcpurity_identity": 4, "endotoxin": 2}
        )
        payload = {"services": {"hplcpurity_identity": True}}
        result = sub_service._apply_variance_override("ZZTEST-VAROV", payload)
        assert result["services"]["variance"] == {"hplcpurity_identity": 4, "endotoxin": 2}

    def test_no_override_payload_unchanged(self, db, zztest_varov_parent):
        """No override set → payload passes through unchanged."""
        payload = {"services": {"hplcpurity_identity": True}}
        result = sub_service._apply_variance_override("ZZTEST-VAROV", payload)
        assert "variance" not in result["services"]

    def test_none_payload_passes_through(self):
        """result=None passes through without error."""
        result = sub_service._apply_variance_override("ZZTEST-VAROV", None)
        assert result is None

    def test_chain_feeds_variance_target(self, db, zztest_varov_parent):
        """End-to-end chain: override set → _apply → variance bucket target.
        (Superseded test_chain_inflates_demand — core demand no longer inflates;
        the override now drives the separate variance target instead.)"""
        sub_service.set_variance_override(
            db, "ZZTEST-VAROV", {"hplcpurity_identity": 3}
        )
        raw = {"services": {"hplcpurity_identity": True, "endotoxin": True, "sterility_pcr": True}}
        merged = sub_service._apply_variance_override("ZZTEST-VAROV", raw)
        # purchased 3 (total vials) => 2 paid replicates on top of the core vial
        assert sub_service.derive_variance_demand(merged["services"]) == {
            "hplc": 2, "endo": 0, "ster": 0,
        }
        # core demand untouched by the override
        assert sub_service.derive_demand(merged["services"]) == {
            "hplc": 1, "endo": 1, "ster": 1,
        }


# ─── Plan 3 Task 2: demand carries the four add-on Variance roles ────────────
# Characterization first: with no four-key entry (or no plan) every demand
# function answers exactly as before this task.

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from database import Base
from models import AnalysisProfile, Department, VialRole

ENDO85_KEY, HM_KEY, PCR_KEY = "endotoxin-usp85-lal", "heavy_metals", "rapid-sterility-pcr"
FOUR_KEY_MAP = {"hplcpurity_identity": True,
                "variance": {"hplcpurity_identity": 3, ENDO85_KEY: 3, HM_KEY: 2}}


@pytest.mark.parametrize("services, expected", [
    ({**BASE_SERVICES, "variance": {"hplcpurity_identity": 3, "endotoxin": 2}},
     {"hplc": 2, "endo": 1, "ster": 0}),
    ({**BASE_SERVICES, "variance": {"hplcpurity_identity": 2}}, {"hplc": 1, "endo": 0, "ster": 0}),
    (BASE_SERVICES, {"hplc": 0, "endo": 0, "ster": 0}),
    ({**BASE_SERVICES, "variance": {"hplcpurity_identity": 1, "endotoxin": "junk"}},
     {"hplc": 0, "endo": 0, "ster": 0}),
    ({"variance": {"bac_water_panel": 3}}, {"hplc": 2, "endo": 0, "ster": 0}),
    (FOUR_KEY_MAP, {"hplc": 2, "endo": 0, "ster": 0}),
], ids=["hplc_endo", "two_vial", "none", "invalid", "bw", "four_key"])
def test_derive_variance_demand_without_plan_is_unchanged(services, expected):
    assert sub_service.derive_variance_demand(services) == expected


def test_variance_lock_required_legacy_answers_unchanged():
    assert sub_service.variance_lock_required({"variance": {"hplcpurity_identity": 3}}, None) is True
    assert sub_service.variance_lock_required({"variance": {"hplcpurity_identity": 3}},
                                              datetime.utcnow()) is False
    assert sub_service.variance_lock_required({"variance": {"hplcpurity_identity": 1}}, None) is False
    assert sub_service.variance_lock_required(BASE_SERVICES, None) is False
    assert sub_service.variance_lock_required(None, None) is False


@pytest.fixture()
def lite():
    """In-memory SQLite (StaticPool) so the catalog rows below never touch
    the shared dev Postgres."""
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()
        engine.dispose()


def _lite_catalog(db):
    """endo85 (one vial a run) and hm (two vials a run, one analytical),
    both variance-eligible roles in a department so auto-assign fills them."""
    dep = Department(name="ZZ Micro")
    db.add(dep)
    db.flush()
    for i, code in enumerate(("endo85", "hm"), 1):
        db.add(VialRole(code=code, label=code, department_id=dep.id, variance_eligible=True,
                        sort_order=100 + i, boxable=False, frozen=False, is_system=False))
    db.add(VialRole(code="xtra", label="Extra", department_id=None, variance_eligible=False,
                    sort_order=999, boxable=False, frozen=False, is_system=True))
    db.flush()
    db.add(AnalysisProfile(key=ENDO85_KEY, name="ZZ Endo 85", is_addon=True, vials_required=1,
                           fulfillment_dim="role", fulfillment_role="endo85", active=True))
    db.add(AnalysisProfile(key=HM_KEY, name="ZZ HM", is_addon=True, vials_required=2,
                           analytical_vials=1, fulfillment_dim="role", fulfillment_role="hm",
                           active=True))
    db.commit()


def _lite_parent(db, sample_id, n_subs, *, native=True):
    parent = LimsSample(sample_id=sample_id, external_lims_uid=f"{sample_id}-uid",
                        external_lims_system="mk1" if native else "senaite",
                        container_mode=True, status="received")
    db.add(parent)
    db.flush()
    for i in range(1, n_subs + 1):
        db.add(LimsSubSample(sample_id=f"{sample_id}-S{i:02d}", vial_sequence=i,
                             parent_sample_pk=parent.id,
                             external_lims_uid=f"{sample_id}-s{i:02d}-uid"))
    db.commit()
    return parent


@pytest.fixture()
def lite_client(lite):
    from unittest.mock import MagicMock
    from fastapi.testclient import TestClient
    from auth import get_current_user
    from database import get_db
    from main import app
    prev = dict(app.dependency_overrides)
    app.dependency_overrides[get_db] = lambda: lite
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(prev)


ALC_SERVICES = {ENDO85_KEY: True, HM_KEY: True}


def _get_vial_demand(client, monkeypatch, sample_id, services):
    monkeypatch.setattr(sub_service, "fetch_sample_services",
                        lambda sid: {"services": services, "wp_order_number": "WP-T2"})
    resp = client.get(f"/api/sub-samples/{sample_id}/vial-demand")
    assert resp.status_code == 200, resp.text
    return resp.json()


TODAY_VIAL_DEMAND = {
    "demand": {"hplc": 0, "endo": 0, "ster": 0, "endo85": 1, "hm": 2},
    "variance": {"hplc": 2, "endo": 0, "ster": 0},
    "base_demand": {"hplc": 0, "endo": 0, "ster": 0, "endo85": 1, "hm": 2},
    "wp_order_number": "WP-T2",
    "is_unreachable": False,
}


def test_vial_demand_route_without_four_key_entry_is_unchanged(lite, lite_client, monkeypatch):
    _lite_catalog(lite)
    _lite_parent(lite, "ZZT2-VD1", 0)
    body = _get_vial_demand(lite_client, monkeypatch, "ZZT2-VD1",
                            {**ALC_SERVICES, "variance": {"hplcpurity_identity": 3}})
    assert body == TODAY_VIAL_DEMAND


def test_vial_demand_route_four_key_entry_without_parent_row_is_unchanged(
        lite, lite_client, monkeypatch):
    # No lims_samples row: the route stays read-only and answers as today.
    _lite_catalog(lite)
    body = _get_vial_demand(lite_client, monkeypatch, "ZZT2-NOROW",
                            {**ALC_SERVICES, "variance": {"hplcpurity_identity": 3, ENDO85_KEY: 3}})
    assert body == TODAY_VIAL_DEMAND
    assert lite.query(LimsSample).filter_by(sample_id="ZZT2-NOROW").count() == 0


def test_vial_demand_route_four_key_entry_not_native_is_unchanged(lite, lite_client, monkeypatch):
    # The resolver refuses a non-native sample, so no role vials are added.
    _lite_catalog(lite)
    _lite_parent(lite, "ZZT2-VD2", 0, native=False)
    body = _get_vial_demand(lite_client, monkeypatch, "ZZT2-VD2",
                            {**ALC_SERVICES, "variance": {"hplcpurity_identity": 3, ENDO85_KEY: 3}})
    assert body == TODAY_VIAL_DEMAND


# ─── Task 2: the change ──────────────────────────────────────────────────────


def _resolve(db, services):
    from sub_samples.variance_tests import resolve_variance_plan
    return resolve_variance_plan(db, services, native_born=True, bac_water=False)


def test_derive_variance_demand_with_plan_adds_role_vials(lite):
    _lite_catalog(lite)
    services = {**FOUR_KEY_MAP, ENDO85_KEY: True, HM_KEY: True}
    plan = _resolve(lite, services)
    assert plan.errors == ()
    assert sub_service.derive_variance_demand(services, plan) == {
        "hplc": 2, "endo": 0, "ster": 0, "endo85": 2, "hm": 2}


def test_lock_required_for_four_key_only_map():
    assert sub_service.variance_lock_required({"variance": {PCR_KEY: 2}}, None) is True
    assert sub_service.variance_lock_required({"variance": {PCR_KEY: 2}}, datetime.utcnow()) is False
    # An entry that does not resolve still holds the certificate (Task 12 refuses the lock).
    assert sub_service.variance_lock_required({"variance": {PCR_KEY: 1}}, None) is True
    assert sub_service.variance_lock_required({}, None) is False


@pytest.fixture()
def no_seed(monkeypatch):
    import lims_analyses.seeder as seeder
    monkeypatch.setattr(seeder, "seed_analyses_for_vial", lambda *a, **k: None)


def _vial_plan(db, monkeypatch, sample_id, services):
    monkeypatch.setattr(sub_service, "fetch_sample_services",
                        lambda sid: {"services": services, "wp_order_number": "WP-T2"})
    return sub_service.compute_vial_plan(db, sample_id)


def _stored_kinds(db, parent):
    db.expire_all()
    out: dict = {}
    for s in db.query(LimsSubSample).filter_by(parent_sample_pk=parent.id):
        key = (s.assignment_role, s.assignment_kind)
        out[key] = out.get(key, 0) + 1
    return out


def test_vial_plan_reports_variance_tests_errors_and_vials(lite, no_seed, monkeypatch):
    _lite_catalog(lite)
    parent = _lite_parent(lite, "ZZT2-VP1", 7)
    plan = _vial_plan(lite, monkeypatch, "ZZT2-VP1",
                      {**ALC_SERVICES, "variance": {ENDO85_KEY: 3, HM_KEY: 2}})
    assert plan["variance"]["endo85"] == 2
    assert plan["variance"]["hm"] == 2
    assert plan["demand"]["endo85"] == 1
    assert plan["demand"]["hm"] == 2
    assert plan["variance_tests"]["hm"] == {
        "key": HM_KEY, "n": 2, "replicate_runs": 1, "replicate_vials": 2, "run_label": "Digest"}
    assert plan["variance_tests"]["endo85"] == {
        "key": ENDO85_KEY, "n": 3, "replicate_runs": 2, "replicate_vials": 2, "run_label": "Vial"}
    assert plan["variance_errors"] == []
    assert plan["variance_notes"] == []
    assert _stored_kinds(lite, parent) == {
        ("endo85", "core"): 1, ("endo85", "variance"): 2,
        ("hm", "core"): 2, ("hm", "variance"): 2,
    }


def test_vial_plan_surfaces_unfulfillable_entry(lite, no_seed, monkeypatch):
    _lite_catalog(lite)
    _lite_parent(lite, "ZZT2-VP2", 1)
    plan = _vial_plan(lite, monkeypatch, "ZZT2-VP2",
                      {ENDO85_KEY: True, "variance": {HM_KEY: 2}})
    assert plan["variance_errors"] == ["Variance for heavy_metals: the test is not on this sample"]
    assert "hm" not in plan["variance"]
    assert plan["variance_tests"] == {}


def test_vial_plan_without_four_key_entry_carries_empty_fields(lite, no_seed, monkeypatch):
    _lite_catalog(lite)
    _lite_parent(lite, "ZZT2-VP3", 1)
    plan = _vial_plan(lite, monkeypatch, "ZZT2-VP3",
                      {ENDO85_KEY: True, "variance": {"hplcpurity_identity": 3}})
    assert plan["variance"] == {"hplc": 2, "endo": 0, "ster": 0}
    assert (plan["variance_tests"], plan["variance_errors"], plan["variance_notes"]) == ({}, [], [])


def test_upgrade_that_changes_only_the_map_is_picked_up(lite, no_seed, monkeypatch):
    # The order service never forwards a map-only upgrade (added_keys == []):
    # Mk1 re-reads services.variance on every vial-plan call.
    _lite_catalog(lite)
    parent = _lite_parent(lite, "ZZT2-UP1", 2)
    first = _vial_plan(lite, monkeypatch, "ZZT2-UP1", {ENDO85_KEY: True, "variance": {ENDO85_KEY: 2}})
    assert first["variance"]["endo85"] == 1
    assert _stored_kinds(lite, parent) == {("endo85", "core"): 1, ("endo85", "variance"): 1}

    lite.add(LimsSubSample(sample_id="ZZT2-UP1-S03", vial_sequence=3, parent_sample_pk=parent.id,
                           external_lims_uid="ZZT2-UP1-s03-uid"))
    lite.commit()
    second = _vial_plan(lite, monkeypatch, "ZZT2-UP1", {ENDO85_KEY: True, "variance": {ENDO85_KEY: 3}})
    assert second["variance"]["endo85"] == 2
    assert _stored_kinds(lite, parent) == {("endo85", "core"): 1, ("endo85", "variance"): 2}


def test_upgrade_after_lock_assigns_nothing(lite, no_seed, monkeypatch):
    _lite_catalog(lite)
    parent = _lite_parent(lite, "ZZT2-UP2", 2)
    _vial_plan(lite, monkeypatch, "ZZT2-UP2", {ENDO85_KEY: True, "variance": {ENDO85_KEY: 2}})
    lite.add(LimsSubSample(sample_id="ZZT2-UP2-S03", vial_sequence=3, parent_sample_pk=parent.id,
                           external_lims_uid="ZZT2-UP2-s03-uid"))
    parent.variance_locked_at = datetime.utcnow()
    lite.commit()
    locked = _vial_plan(lite, monkeypatch, "ZZT2-UP2", {ENDO85_KEY: True, "variance": {ENDO85_KEY: 3}})
    assert locked["variance"]["endo85"] == 2
    assert locked["variance_tests"]["endo85"]["n"] == 3
    # Nothing assigned under a locked set; the certificate builder (Task 14)
    # then refuses until the lab unlocks and finishes the run.
    assert _stored_kinds(lite, parent) == {
        ("endo85", "core"): 1, ("endo85", "variance"): 1, (None, None): 1}


def test_vial_plan_response_declares_new_fields(lite, no_seed, monkeypatch):
    from sub_samples.schemas import VialPlanResponse
    _lite_catalog(lite)
    _lite_parent(lite, "ZZT2-VP4", 1)
    plan = _vial_plan(lite, monkeypatch, "ZZT2-VP4",
                      {ENDO85_KEY: True, "variance": {ENDO85_KEY: 2, HM_KEY: 2}})
    dumped = VialPlanResponse(**plan).model_dump()
    assert dumped["variance_tests"] == plan["variance_tests"]
    assert dumped["variance_tests"]["endo85"]["replicate_vials"] == 1
    assert dumped["variance_errors"] == ["Variance for heavy_metals: the test is not on this sample"]
    assert dumped["variance_notes"] == []
    assert dumped["variance"]["endo85"] == 1


def test_vial_demand_route_counts_four_key_replicate_vials(lite, lite_client, monkeypatch):
    _lite_catalog(lite)
    _lite_parent(lite, "ZZT2-VD3", 0)
    body = _get_vial_demand(lite_client, monkeypatch, "ZZT2-VD3",
                            {**ALC_SERVICES,
                             "variance": {"hplcpurity_identity": 3, ENDO85_KEY: 3, HM_KEY: 2}})
    assert body == {**TODAY_VIAL_DEMAND,
                    "variance": {"hplc": 2, "endo": 0, "ster": 0, "endo85": 2, "hm": 2}}
