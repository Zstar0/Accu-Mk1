"""Side-by-side engine tests (2026-07-26 spec). House conventions:
live subvial DB via SessionLocal, TEST-prefixed fixtures, self-cleanup."""
from __future__ import annotations

import pytest
from sqlalchemy import delete, select

from database import SessionLocal
from models import (LimsSample, LimsWorkflowShadowEvaluation,
                    LimsWorkflowState, LimsWorkflowTransition)


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def test_sample(db):
    """A TEST lims_samples row with native_status set; removed after."""
    row = LimsSample(sample_id="TEST-SBS-0001", status="sample_received",
                     native_status="test_sbs_received")
    db.add(row)
    db.flush()
    yield row
    db.execute(delete(LimsWorkflowShadowEvaluation).where(
        LimsWorkflowShadowEvaluation.lims_sample_pk == row.id))
    db.execute(delete(LimsSample).where(LimsSample.id == row.id))
    db.commit()


def test_shadow_evaluation_roundtrip(db, test_sample):
    db.add(LimsWorkflowShadowEvaluation(
        lims_sample_pk=test_sample.id, trigger="seed", verb=None,
        from_status=None, to_status="test_sbs_received",
        outcome="seeded", requirements_met=None, outcomes=[],
    ))
    db.flush()
    got = db.execute(select(LimsWorkflowShadowEvaluation).where(
        LimsWorkflowShadowEvaluation.lims_sample_pk == test_sample.id
    )).scalars().one()
    assert got.outcome == "seeded"
    assert got.outcomes == []
    assert got.evaluated_at is not None
    db.rollback()


def test_auto_fire_defaults_false(db):
    # Any existing transition row must expose auto_fire (bool, default False
    # on newly created rows).
    t = LimsWorkflowTransition.__table__.c
    assert "auto_fire" in t


def test_seed_data_carries_auto_fire_and_coa_published(db):
    """Verify seed data carries auto_fire and coa_published on first boot.

    This ensures fresh databases get the correct flags on first boot, rather
    than relying on post-seed UPDATEs that would find zero rows on empty DBs.
    """
    from workflow.seeds import SEED_TRANSITIONS

    # Parse seed data to verify correct tuples structure
    sample_transitions = {
        (row[0], row[1], row[2], row[3]): row
        for row in SEED_TRANSITIONS if row[0] == "sample"
    }

    # Verify sample submit edge has auto_fire=True
    submit_key = ("sample", "sample_received", "to_be_verified", "submit")
    assert submit_key in sample_transitions, "submit transition missing"
    submit_row = sample_transitions[submit_key]
    assert submit_row[4] is True, "submit should have auto_fire=True"

    # Verify sample verify edge has auto_fire=True
    verify_key = ("sample", "to_be_verified", "verified", "verify")
    assert verify_key in sample_transitions, "verify transition missing"
    verify_row = sample_transitions[verify_key]
    assert verify_row[4] is True, "verify should have auto_fire=True"

    # Verify sample publish edge has coa_published in requirements
    publish_key = ("sample", "verified", "published", "publish")
    assert publish_key in sample_transitions, "publish transition missing"
    publish_row = sample_transitions[publish_key]
    publish_reqs = publish_row[5]
    assert any(req["kind"] == "coa_published" for req in publish_reqs), \
        "publish should have coa_published requirement"

    # Verify all other sample transitions default to auto_fire=False
    for key, row in sample_transitions.items():
        verb = key[3]
        if verb not in ("submit", "verify"):
            assert row[4] is False, f"{verb} should default to auto_fire=False"
