"""Variance-verified lifecycle — state machine, service guards, entitlement gate.

Spec: docs/superpowers/specs/2026-06-10-variance-testing-addon-design.md §3-§4.
Service-layer tests run against the LIVE accumark_mk1 DB: ZZTEST-* fixtures,
explicit teardown (lims_analysis_transitions cascades via FK).
"""
import pytest

from sub_samples import service as sub_service
from lims_analyses.state_machine import (
    STATES,
    TRANSITION_KINDS,
    TERMINAL_STATES,
    TIER_PARENT,
    TIER_VIAL,
    InvalidTransitionError,
    TierMismatchError,
    allowed_kinds,
    is_terminal,
    next_state,
)


class TestVarianceVerifyStateMachine:
    def test_state_and_kind_registered(self):
        assert "variance_verified" in STATES
        assert "variance_verify" in TRANSITION_KINDS

    def test_variance_verified_is_not_terminal(self):
        assert "variance_verified" not in TERMINAL_STATES
        assert is_terminal("variance_verified") is False

    def test_to_be_verified_variance_verify_yields_variance_verified(self):
        assert next_state("to_be_verified", "variance_verify", tier=TIER_VIAL) == "variance_verified"

    def test_variance_verify_blocked_at_parent_tier(self):
        with pytest.raises(TierMismatchError):
            next_state("to_be_verified", "variance_verify", tier=TIER_PARENT)

    @pytest.mark.parametrize("from_state", [
        "unassigned", "assigned", "verified", "promoted", "variance_verified", "retracted",
    ])
    def test_variance_verify_illegal_from_other_states(self, from_state):
        with pytest.raises(InvalidTransitionError):
            next_state(from_state, "variance_verify", tier=TIER_VIAL)

    def test_allowed_kinds_from_to_be_verified_at_vial_tier(self):
        kinds = allowed_kinds("to_be_verified", tier=TIER_VIAL)
        assert "variance_verify" in kinds
        assert "verify" not in kinds  # vial verify stays removed

    def test_generic_verify_still_blocked_at_vial_tier(self):
        # variance_verify must NOT re-open the generic verify hole
        with pytest.raises(TierMismatchError):
            next_state("to_be_verified", "verify", tier=TIER_VIAL)


# ─── Service-layer tests (live DB, ZZTEST-VARV fixtures) ─────────────────────

from datetime import datetime

from sqlalchemy import text

from database import SessionLocal
from lims_analyses import service
from models import LimsAnalysis, LimsSample, LimsSubSample


@pytest.fixture()
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


@pytest.fixture()
def variance_fixture(db):
    """ZZTEST parent + hplc vial + one to_be_verified analysis with a result.
    Committed (apply_transition commits), torn down by id."""
    parent = LimsSample(sample_id="ZZTEST-VARV", peptide_name="ZZ Test", status="received")
    db.add(parent)
    db.flush()
    vial = LimsSubSample(
        sample_id="ZZTEST-VARV-S01",
        parent_sample_pk=parent.id,
        vial_sequence=1,
        received_at=datetime.utcnow(),
        assignment_role="hplc",
        external_lims_uid="zz-uid-varv-s01",
        assignment_kind="variance",
    )
    db.add(vial)
    db.flush()
    svc_id = db.execute(text("SELECT id FROM analysis_services LIMIT 1")).scalar_one()
    row = LimsAnalysis(
        lims_sub_sample_pk=vial.id,
        analysis_service_id=svc_id,
        keyword="ZZTEST-VARV-KW",
        title="ZZ Variance Test",
        result_value="99",
        review_state="to_be_verified",
    )
    db.add(row)
    db.commit()
    yield {"parent": parent, "vial": vial, "row": row}
    db.rollback()
    db.execute(text(
        "DELETE FROM lims_analyses WHERE keyword LIKE 'ZZTEST-VARV%'"))
    db.execute(text(
        "DELETE FROM lims_sub_samples WHERE sample_id LIKE 'ZZTEST-VARV%'"))
    db.execute(text(
        "DELETE FROM lims_samples WHERE sample_id LIKE 'ZZTEST-VARV%'"))
    db.commit()


class TestVarianceVerifyService:
    def test_happy_path_sets_state_timestamp_and_audit(self, db, variance_fixture):
        row = variance_fixture["row"]
        out = service.apply_transition(
            db, analysis_id=row.id, kind="variance_verify", user_id=None,
            reason="senior sign-off",
        )
        assert out.review_state == "variance_verified"
        assert out.verified_at is not None
        kinds = db.execute(text(
            "SELECT transition_kind FROM lims_analysis_transitions "
            "WHERE analysis_id=:a ORDER BY id DESC LIMIT 1"), {"a": row.id}).scalar_one()
        assert kinds == "variance_verify"

    def test_requires_result_value(self, db, variance_fixture):
        row = variance_fixture["row"]
        row.result_value = None
        db.commit()
        with pytest.raises(service.BadRequestError):
            service.apply_transition(db, analysis_id=row.id, kind="variance_verify")

    def test_rejected_on_parent_hosted_row(self, db, variance_fixture):
        parent = variance_fixture["parent"]
        svc_id = db.execute(text("SELECT id FROM analysis_services LIMIT 1")).scalar_one()
        prow = LimsAnalysis(
            lims_sample_pk=parent.id,
            analysis_service_id=svc_id,
            keyword="ZZTEST-VARV-PARENT",
            title="ZZ Parent Row",
            result_value="1",
            review_state="to_be_verified",
        )
        db.add(prow)
        db.commit()
        with pytest.raises(service.BadRequestError, match="sub-sample"):
            service.apply_transition(db, analysis_id=prow.id, kind="variance_verify")

    def test_retest_legal_from_variance_verified(self, db, variance_fixture):
        row = variance_fixture["row"]
        service.apply_transition(db, analysis_id=row.id, kind="variance_verify")
        new_row = service.apply_transition(db, analysis_id=row.id, kind="retest")
        assert new_row.retest_of_id == row.id
        assert new_row.review_state == "unassigned"
        db.refresh(row)
        assert row.retested is True
        assert row.review_state == "variance_verified"  # original keeps its state


@pytest.mark.skip(reason="superseded: variance_verify gates on assignment_kind, not entitlement (2026-06-10 variance-bucket-assignment)")
class TestVarianceEntitlementGate:
    def _fetch(self, services):
        return lambda parent_sample_id: services

    def test_passes_when_variance_purchased_for_role(self, db, variance_fixture):
        row = variance_fixture["row"]
        service.ensure_variance_entitlement(
            db, analysis_id=row.id,
            fetch_services=self._fetch({"variance": {"hplcpurity_identity": 3}}),
        )  # no raise

    def test_rejects_when_not_purchased(self, db, variance_fixture):
        row = variance_fixture["row"]
        with pytest.raises(service.BadRequestError, match="not purchased"):
            service.ensure_variance_entitlement(
                db, analysis_id=row.id,
                fetch_services=self._fetch({"variance": {}}),
            )

    def test_rejects_when_count_below_two(self, db, variance_fixture):
        row = variance_fixture["row"]
        with pytest.raises(service.BadRequestError, match="not purchased"):
            service.ensure_variance_entitlement(
                db, analysis_id=row.id,
                fetch_services=self._fetch({"variance": {"hplcpurity_identity": 1}}),
            )

    def test_fail_closed_when_services_unreachable(self, db, variance_fixture):
        row = variance_fixture["row"]
        with pytest.raises(service.BadRequestError, match="could not be verified"):
            service.ensure_variance_entitlement(
                db, analysis_id=row.id, fetch_services=self._fetch(None),
            )

    def test_rejects_role_without_variance_service(self, db, variance_fixture):
        vial = variance_fixture["vial"]
        vial.assignment_role = "xtra"
        db.commit()
        row = variance_fixture["row"]
        with pytest.raises(service.BadRequestError, match="no variance service"):
            service.ensure_variance_entitlement(
                db, analysis_id=row.id,
                fetch_services=self._fetch({"variance": {"hplcpurity_identity": 3}}),
            )

    def test_endo_role_maps_to_endotoxin_key(self, db, variance_fixture):
        vial = variance_fixture["vial"]
        vial.assignment_role = "endo"
        db.commit()
        row = variance_fixture["row"]
        service.ensure_variance_entitlement(
            db, analysis_id=row.id,
            fetch_services=self._fetch({"variance": {"endotoxin": 2}}),
        )  # no raise


class TestVarianceEntitlementNormalize:
    def test_filters_to_valid_counts(self):
        out = sub_service.normalize_variance_entitlement({
            "variance": {"hplcpurity_identity": 3, "endotoxin": 1,
                         "sterility_pcr": "junk", "future_test": 2},
        })
        assert out == {"hplcpurity_identity": 3, "future_test": 2}

    def test_empty_when_absent(self):
        assert sub_service.normalize_variance_entitlement({}) == {}
        assert sub_service.normalize_variance_entitlement({"variance": None}) == {}
