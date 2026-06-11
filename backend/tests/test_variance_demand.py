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

    def test_bucket_key_map_matches_lifecycle_gate(self):
        # The demand map and the variance_verify gate must agree on
        # role/bucket -> WP service key, or check-in demand and the sign-off
        # gate drift apart.
        from lims_analyses.service import _ROLE_VARIANCE_KEYS
        assert sub_service.VARIANCE_BUCKET_KEYS == _ROLE_VARIANCE_KEYS


class TestDeriveDemandCore:
    """Explicit-bucket model: derive_demand is CORE demand only. The old
    inflation assertions (test_variance_inflates_per_bucket expecting
    max(base, n)) are intentionally superseded."""

    def test_no_variance_unchanged(self):
        assert sub_service.derive_demand(BASE_SERVICES) == {
            "hplc": 1, "endo": 1, "ster": 2,
        }

    def test_variance_does_not_inflate_core_demand(self):
        out = sub_service.derive_demand({
            **BASE_SERVICES,
            "variance": {"hplcpurity_identity": 3, "endotoxin": 2},
        })
        assert out == {"hplc": 1, "endo": 1, "ster": 2}

    def test_unordered_service_stays_zero(self):
        # core demand is the lab baseline; a (contract-invalid) variance key
        # on an unordered service never creates core demand.
        out = sub_service.derive_demand({
            "sterility_pcr": True,
            "variance": {"sterility_pcr": 2, "hplcpurity_identity": 5},
        })
        assert out["ster"] == 2
        assert out["hplc"] == 0


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
            "hplc": 1, "endo": 1, "ster": 2,
        }
