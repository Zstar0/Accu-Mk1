"""Tests for the registry status heal cluster (2026-07-14 inbox-desync fix).

Three mechanisms diagnosed against prod (memory: inbox mk1 read-source
desync):

  RC1 — the Mk1 receive/publish hooks recorded transitions but never wrote
        `lims_samples.status`, and the IS event sync's dup-guard then
        suppressed its own heal ("dup rows never heal") because the mk1 log
        row already explained the transition. Fix: `heal_sample_status` +
        the hooks' bg writer heals in the same never-fail session.
  RC2 — rows received before the 1.4.0 cold-start cursor only ever got
        is_seed log rows (seed never heals). Fix: the sweep script heals
        from the transition log itself (latest whitelisted to_status per
        sample), zero SENAITE load.
  RC3 — IS event `new_status` can carry WP order-progress vocabulary
        ('analyzing', from worksheet_assigned) that is NOT a SENAITE
        review_state; healing it poisons a column every read surface
        compares against SENAITE vocabulary. Fix: whitelist gate on every
        heal path.

House pattern: TEST-prefixed rows, FK-safe cleanup (transitions before
samples), real session via SessionLocal (same as test_sample_transition_log).
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from sqlalchemy import delete

from database import SessionLocal
from models import LimsSample, LimsSampleTransition
from workflow.sample_log import (
    SAMPLE_REVIEW_STATE_WHITELIST,
    heal_sample_status,
    record_sample_transition,
)
from workflow.is_event_stream import _heal_status

T1 = "TEST-HEAL-1"
T2 = "TEST-HEAL-2"
ALL_TEST_IDS = [T1, T2]


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.rollback()
    # FK-safe cleanup
    pks = [r.id for r in s.query(LimsSample).filter(
        LimsSample.sample_id.in_(ALL_TEST_IDS)).all()]
    if pks:
        s.execute(delete(LimsSampleTransition).where(
            LimsSampleTransition.lims_sample_pk.in_(pks)))
        s.execute(delete(LimsSample).where(LimsSample.id.in_(pks)))
        s.commit()
    s.close()


def _seed(db, sample_id=T1, status="sample_due") -> LimsSample:
    row = LimsSample(sample_id=sample_id, sample_type="x", status=status)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


# ── whitelist ────────────────────────────────────────────────────────────

def test_whitelist_carries_senaite_vocab_not_is_progress_vocab():
    # Canonical SENAITE/workflow-catalog sample states are in...
    for s in ("sample_due", "sample_received", "to_be_verified", "verified",
              "published", "waiting_for_addon_results",
              "ready_for_initial_review", "cancelled", "invalid"):
        assert s in SAMPLE_REVIEW_STATE_WHITELIST, s
    # ...and the IS order-progress vocabulary is NOT (RC3).
    for s in ("analyzing", "under_review", "complete", "order_submitted"):
        assert s not in SAMPLE_REVIEW_STATE_WHITELIST, s


# ── heal_sample_status unit ──────────────────────────────────────────────

def test_heal_writes_whitelisted_status(db):
    _seed(db, status="sample_due")
    assert heal_sample_status(db, T1, "sample_received") is True
    db.flush()
    row = db.query(LimsSample).filter_by(sample_id=T1).one()
    assert row.status == "sample_received"


def test_heal_rejects_non_whitelisted_status(db):
    _seed(db, status="sample_received")
    assert heal_sample_status(db, T1, "analyzing") is False
    row = db.query(LimsSample).filter_by(sample_id=T1).one()
    assert row.status == "sample_received"


def test_heal_noops_on_missing_row_and_same_status(db):
    assert heal_sample_status(db, "TEST-HEAL-MISSING", "sample_received") is False
    _seed(db, status="sample_received")
    assert heal_sample_status(db, T1, "sample_received") is False


# ── RC3: the event-sync heal is whitelist-gated ──────────────────────────

def test_event_sync_heal_skips_is_vocabulary(db):
    row = _seed(db, status="sample_received")
    stats = {"healed": 0, "errors": 0}
    _heal_status(db, row.id, "analyzing", datetime.utcnow(), stats)
    db.flush()
    assert stats["healed"] == 0
    assert db.query(LimsSample).filter_by(sample_id=T1).one().status == "sample_received"


def test_event_sync_heal_still_writes_senaite_vocabulary(db):
    row = _seed(db, status="sample_due")
    stats = {"healed": 0, "errors": 0}
    _heal_status(db, row.id, "sample_received", datetime.utcnow(), stats)
    db.flush()
    assert stats["healed"] == 1
    assert db.query(LimsSample).filter_by(sample_id=T1).one().status == "sample_received"


# ── RC2: sweep heals from the transition log ─────────────────────────────

def _log(db, sample_id, to_status, occurred_at, source="is_seed", verb=None):
    ok = record_sample_transition(
        db, sample_id=sample_id, to_status=to_status, source=source,
        verb=verb, occurred_at=occurred_at,
        # distinct event ids defeat the recorder's dedup for test setup
        is_event_id=f"test:{sample_id}:{to_status}:{occurred_at.timestamp()}",
    )
    assert ok is True
    db.commit()


def test_sweep_heals_stale_status_from_latest_whitelisted_transition(db):
    from scripts.heal_sample_status_from_transitions import sweep
    _seed(db, T1, status="sample_due")
    base = datetime.utcnow() - timedelta(days=2)
    _log(db, T1, "sample_received", base, verb="receive")
    # a LATER non-whitelisted event must not win (RC3 interplay)
    _log(db, T1, "analyzing", base + timedelta(hours=2), verb="worksheet_assigned")

    stats = sweep(db, apply=False)
    assert stats["would_heal"] == 1
    assert db.query(LimsSample).filter_by(sample_id=T1).one().status == "sample_due"

    stats = sweep(db, apply=True)
    db.commit()
    assert stats["healed"] == 1
    assert db.query(LimsSample).filter_by(sample_id=T1).one().status == "sample_received"


def test_sweep_untouched_without_transitions_or_when_in_sync(db):
    from scripts.heal_sample_status_from_transitions import sweep
    _seed(db, T1, status="sample_due")                      # no transitions
    row2 = _seed(db, T2, status="sample_received")          # already in sync
    _log(db, T2, "sample_received", datetime.utcnow() - timedelta(days=1), verb="receive")

    stats = sweep(db, apply=True)
    db.commit()
    assert db.query(LimsSample).filter_by(sample_id=T1).one().status == "sample_due"
    assert db.query(LimsSample).filter_by(sample_id=T2).one().status == "sample_received"
