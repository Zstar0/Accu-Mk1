"""Variance-verified lifecycle — state machine, service guards, entitlement gate.

Spec: docs/superpowers/specs/2026-06-10-variance-testing-addon-design.md §3-§4.
Service-layer tests run against the LIVE accumark_mk1 DB: ZZTEST-* fixtures,
explicit teardown (lims_analysis_transitions cascades via FK).
"""
import pytest

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
