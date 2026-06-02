"""Integration tests for variance-set service helpers.

Uses subvial stack DB. Picks a parent that has ≥2 sub-samples
already in lims_sub_samples; manipulates variance flags, locks, unlocks.
"""
import pytest
from sqlalchemy import select

from database import SessionLocal
from models import LimsSample, LimsSubSample
from sub_samples.service import (
    VarianceLockedError, VarianceTooFewVialsError,
    set_variance_membership, lock_variance_set, unlock_variance_set, get_variance_set,
)


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def parent_with_subs(db):
    """Pick a parent that has ≥2 sub-samples for testing."""
    parents = db.execute(select(LimsSample)).scalars().all()
    eligible = [p for p in parents if len(p.sub_samples) >= 2]
    if not eligible:
        pytest.skip("no parent with >=2 sub-samples available in subvial DB")
    return eligible[0]


def test_get_variance_set_includes_parent_and_subs(db, parent_with_subs):
    result = get_variance_set(db, parent_with_subs.sample_id)
    assert result is not None
    assert len(result["vials"]) == len(parent_with_subs.sub_samples) + 1
    assert result["vials"][0]["is_parent"] is True
    assert all(v.get("in_variance_set") in (True, False) for v in result["vials"])


def test_set_variance_membership_flips_flag(db, parent_with_subs):
    sub = parent_with_subs.sub_samples[0]
    original = sub.in_variance_set
    out = set_variance_membership(db, sub.sample_id, in_set=not original, reason="test toggle")
    assert out["in_variance_set"] != original
    # restore
    set_variance_membership(db, sub.sample_id, in_set=original, reason=None)


def test_lock_requires_two_selected(db, parent_with_subs):
    """Force all-but-parent out of variance, expect lock to fail (n=1)."""
    # Ensure parent stays in, all subs out
    parent_with_subs.in_variance_set = True
    db.commit()
    for s in parent_with_subs.sub_samples:
        set_variance_membership(db, s.sample_id, in_set=False, reason="lock-test exclude")
    db.refresh(parent_with_subs)
    try:
        with pytest.raises(VarianceTooFewVialsError):
            lock_variance_set(db, parent_with_subs.sample_id, user_id=2)
    finally:
        # restore — put all subs back in variance
        for s in parent_with_subs.sub_samples:
            set_variance_membership(db, s.sample_id, in_set=True, reason=None)


def test_lock_and_unlock_round_trip(db, parent_with_subs):
    parent = parent_with_subs
    # Ensure at least 2 selected (parent + first sub)
    parent.in_variance_set = True
    parent.sub_samples[0].in_variance_set = True
    db.commit()

    locked = lock_variance_set(db, parent.sample_id, user_id=2)
    assert locked.variance_locked_at is not None
    assert locked.variance_locked_by_user_id == 2

    # PATCH on locked family raises
    with pytest.raises(VarianceLockedError):
        set_variance_membership(
            db, parent.sub_samples[0].sample_id, in_set=False, reason="should fail"
        )

    unlocked = unlock_variance_set(db, parent.sample_id)
    assert unlocked.variance_locked_at is None
    assert unlocked.variance_locked_by_user_id is None
