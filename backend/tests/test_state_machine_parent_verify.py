"""parent_to_verify: the native second-sign-off state (spec 2026-08-04)."""
import pytest
from lims_analyses.state_machine import (
    TIER_PARENT, TIER_VIAL, TierMismatchError, next_state, tier_of,
)


def test_parent_hosted_parent_to_verify_is_parent_tier():
    assert tier_of(lims_sample_pk=1, lims_sub_sample_pk=None,
                   review_state="parent_to_verify") == TIER_PARENT


def test_parent_hosted_to_be_verified_stays_vial_tier():
    """The variance parent-acting-as-vial shape is untouched."""
    assert tier_of(lims_sample_pk=1, lims_sub_sample_pk=None,
                   review_state="to_be_verified") == TIER_VIAL


def test_verify_legal_at_parent_tier_from_parent_to_verify():
    assert next_state("parent_to_verify", "verify", tier=TIER_PARENT) == "verified"


def test_retract_and_auto_from_parent_to_verify():
    assert next_state("parent_to_verify", "retract", tier=TIER_PARENT) == "retracted"
    assert next_state("parent_to_verify", "auto", tier=TIER_PARENT) == "parent_to_verify"


def test_verify_still_blocked_at_vial_tier():
    with pytest.raises(TierMismatchError):
        next_state("to_be_verified", "verify", tier=TIER_VIAL)


@pytest.mark.parametrize("kind", ["submit", "retest", "reject", "assign", "variance_verify"])
def test_other_kinds_blocked_at_parent_tier_from_parent_to_verify(kind):
    with pytest.raises(Exception):
        next_state("parent_to_verify", kind, tier=TIER_PARENT)
