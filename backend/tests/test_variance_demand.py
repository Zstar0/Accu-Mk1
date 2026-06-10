"""Variance addon Phase 2 — demand inflation + vial-plan breakdown + lock guard.

Spec: docs/superpowers/specs/2026-06-10-variance-testing-addon-design.md §2, §5.
"""
import pytest

from sub_samples import service as sub_service


BASE_SERVICES = {
    "hplcpurity_identity": True,
    "endotoxin": True,
    "sterility_pcr": True,
}


class TestDeriveVarianceDemand:
    def test_maps_keys_to_buckets(self):
        out = sub_service.derive_variance_demand({
            **BASE_SERVICES,
            "variance": {"hplcpurity_identity": 3, "endotoxin": 2},
        })
        assert out == {"hplc": 3, "endo": 2, "ster": 0}

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

    def test_bucket_key_map_matches_lifecycle_gate(self):
        # The demand map and the variance_verify gate must agree on
        # role/bucket -> WP service key, or check-in demand and the sign-off
        # gate drift apart.
        from lims_analyses.service import _ROLE_VARIANCE_KEYS
        assert sub_service.VARIANCE_BUCKET_KEYS == _ROLE_VARIANCE_KEYS


class TestDeriveDemandInflation:
    def test_no_variance_unchanged(self):
        assert sub_service.derive_demand(BASE_SERVICES) == {
            "hplc": 1, "endo": 1, "ster": 2,
        }

    def test_variance_inflates_per_bucket(self):
        out = sub_service.derive_demand({
            **BASE_SERVICES,
            "variance": {"hplcpurity_identity": 3, "endotoxin": 2},
        })
        assert out == {"hplc": 3, "endo": 2, "ster": 2}

    def test_max_semantics_never_shrinks(self):
        # ster base is 2; a variance n=2 must not change it, and an unordered
        # service must stay 0 even if a (contract-invalid) variance key shows up.
        out = sub_service.derive_demand({
            "sterility_pcr": True,
            "variance": {"sterility_pcr": 2, "hplcpurity_identity": 5},
        })
        assert out["ster"] == 2
        assert out["hplc"] == 0  # base 0: variance never creates demand for an unordered service


class TestDeriveBaseDemand:
    def test_base_is_pre_variance(self):
        out = sub_service.derive_base_demand({
            **BASE_SERVICES,
            "variance": {"hplcpurity_identity": 5},
        })
        assert out == {"hplc": 1, "endo": 1, "ster": 2}


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
            assert plan["variance"] == {"hplc": 3, "endo": 0, "ster": 0}
            assert plan["demand"]["hplc"] == 3
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
