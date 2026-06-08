"""Unit tests for the lims_analyses pure state machine.

No DB — these exercise the allowed-transitions table in isolation.
"""

from __future__ import annotations

import pytest

from lims_analyses.state_machine import (
    STATES, TERMINAL_STATES, TRANSITION_KINDS,
    allowed_kinds, next_state, is_terminal,
    InvalidTransitionError, UnknownStateError, UnknownKindError,
)


# ── basic membership ─────────────────────────────────────────────────────────


def test_states_set_is_complete():
    assert STATES == {
        "unassigned", "assigned", "to_be_verified",
        "verified", "published", "promoted", "rejected", "retracted",
    }


def test_terminal_states():
    assert TERMINAL_STATES == {"published", "rejected"}
    assert is_terminal("published")
    assert is_terminal("rejected")
    assert not is_terminal("verified")
    assert not is_terminal("retracted")  # retracted is recoverable via retest


def test_transition_kinds_set():
    assert TRANSITION_KINDS == {
        "assign", "submit", "verify", "retract", "reject",
        "retest", "publish", "reset", "auto",
    }


# ── happy-path transitions ───────────────────────────────────────────────────


def test_unassigned_to_assigned_via_assign():
    assert next_state("unassigned", "assign") == "assigned"


def test_assigned_to_to_be_verified_via_submit():
    assert next_state("assigned", "submit") == "to_be_verified"


def test_unassigned_to_to_be_verified_via_submit_autoedit_shortcut():
    # The autoEdit path in AnalysisTable submits directly without an
    # intermediate 'assign'.
    assert next_state("unassigned", "submit") == "to_be_verified"


def test_to_be_verified_to_verified_via_verify():
    assert next_state("to_be_verified", "verify") == "verified"


def test_verified_to_published_via_publish():
    assert next_state("verified", "publish") == "published"


def test_assigned_to_unassigned_via_reset():
    assert next_state("assigned", "reset") == "unassigned"


# ── retraction + rejection paths ─────────────────────────────────────────────


def test_to_be_verified_to_retracted_via_retract():
    assert next_state("to_be_verified", "retract") == "retracted"


def test_verified_to_retracted_via_retract_admin_path():
    assert next_state("verified", "retract") == "retracted"


@pytest.mark.parametrize("from_state", ["unassigned", "assigned", "to_be_verified"])
def test_reject_from_each_pre_terminal_state(from_state):
    assert next_state(from_state, "reject") == "rejected"


# ── disallowed transitions ───────────────────────────────────────────────────


def test_cannot_verify_from_unassigned():
    with pytest.raises(InvalidTransitionError):
        next_state("unassigned", "verify")


def test_cannot_publish_from_to_be_verified():
    with pytest.raises(InvalidTransitionError):
        next_state("to_be_verified", "publish")


def test_cannot_transition_out_of_published():
    for kind in TRANSITION_KINDS:
        if kind == "auto":
            continue  # 'auto' is reserved; not in the allowed table
        with pytest.raises(InvalidTransitionError):
            next_state("published", kind)


def test_cannot_transition_out_of_rejected():
    for kind in TRANSITION_KINDS:
        if kind == "auto":
            continue
        with pytest.raises(InvalidTransitionError):
            next_state("rejected", kind)


def test_unknown_state_raises():
    with pytest.raises(UnknownStateError):
        next_state("not_a_state", "verify")


def test_unknown_kind_raises():
    with pytest.raises(UnknownKindError):
        next_state("unassigned", "fly_to_the_moon")


# ── allowed_kinds() introspection (drives UI dropdowns) ──────────────────────


def test_allowed_kinds_from_unassigned():
    assert allowed_kinds("unassigned") == {"assign", "submit", "reject"}


def test_allowed_kinds_from_to_be_verified():
    assert allowed_kinds("to_be_verified") == {"verify", "retract", "reject"}


def test_allowed_kinds_from_verified():
    assert allowed_kinds("verified") == {"publish", "retract"}


def test_allowed_kinds_from_published_is_empty():
    assert allowed_kinds("published") == set()


def test_allowed_kinds_unknown_state_raises():
    with pytest.raises(UnknownStateError):
        allowed_kinds("not_a_state")


# ── tier discrimination ─────────────────────────────────────────────────────


from lims_analyses.state_machine import (
    TIER_PARENT, TIER_VIAL, TIERS,
    TierMismatchError, UnknownTierError,
    tier_allows, tier_of,
)


def test_tier_of_sub_sample_attached_is_vial():
    assert tier_of(
        lims_sample_pk=None, lims_sub_sample_pk=1, review_state="unassigned"
    ) == TIER_VIAL


def test_tier_of_parent_attached_in_run_states_is_vial():
    # Parent acting as a vial in a variance set.
    for s in ("unassigned", "assigned", "to_be_verified"):
        assert tier_of(
            lims_sample_pk=1, lims_sub_sample_pk=None, review_state=s
        ) == TIER_VIAL


def test_tier_of_parent_attached_in_canonical_states_is_parent():
    for s in ("verified", "published", "retracted"):
        assert tier_of(
            lims_sample_pk=1, lims_sub_sample_pk=None, review_state=s
        ) == TIER_PARENT


def test_tier_of_rejects_both_or_neither_host():
    with pytest.raises(ValueError):
        tier_of(lims_sample_pk=None, lims_sub_sample_pk=None,
                review_state="unassigned")
    with pytest.raises(ValueError):
        tier_of(lims_sample_pk=1, lims_sub_sample_pk=1,
                review_state="unassigned")


def test_tier_allows_vial_can_assign_submit_but_not_publish():
    assert tier_allows(TIER_VIAL, "assign")
    assert tier_allows(TIER_VIAL, "submit")
    assert not tier_allows(TIER_VIAL, "publish")


def test_tier_allows_parent_can_publish_but_not_assign_submit():
    assert tier_allows(TIER_PARENT, "publish")
    assert tier_allows(TIER_PARENT, "retract")
    assert not tier_allows(TIER_PARENT, "assign")
    assert not tier_allows(TIER_PARENT, "submit")


def test_next_state_with_tier_raises_tier_mismatch_on_disallowed_kind():
    # publish from 'verified' is valid state-machine-wise, but illegal at vial
    with pytest.raises(TierMismatchError):
        next_state("verified", "publish", tier=TIER_VIAL)


def test_next_state_with_tier_allows_legal_kind():
    assert next_state("verified", "publish", tier=TIER_PARENT) == "published"


def test_allowed_kinds_filtered_by_tier():
    # Sub-sample (vial) tier no longer self-verifies — verification is the
    # promote act; the vial moves to_be_verified -> promoted. So 'verify' is
    # gone from the vial-tier kinds. parent-tier shares only retract here.
    assert allowed_kinds("to_be_verified", tier=TIER_VIAL) == {
        "retract", "reject",
    }
    assert allowed_kinds("to_be_verified", tier=TIER_PARENT) == {"retract"}


def test_unknown_tier_raises():
    with pytest.raises(UnknownTierError):
        tier_allows("not_a_tier", "publish")


def test_promoted_is_a_known_nonterminal_state():
    from lims_analyses.state_machine import STATES, is_terminal
    assert "promoted" in STATES
    assert is_terminal("promoted") is False


def test_verify_not_allowed_on_vial_tier():
    from lims_analyses.state_machine import (
        next_state, TIER_VIAL, TierMismatchError,
    )
    with pytest.raises(TierMismatchError):
        next_state("to_be_verified", "verify", tier=TIER_VIAL)
