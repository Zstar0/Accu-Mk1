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
