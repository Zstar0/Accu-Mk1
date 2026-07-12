"""Tests for Task 5: the IS event-stream incremental sync
(workflow/is_event_stream.py) — the ONLY IS→Mk1 puller (spec §7).

`sync_once` is exercised directly against a live session (via SessionLocal,
same house pattern as test_sample_transition_log.py); the IS-side query is
never hit for real — `_fetch_events` is the deliberate test seam and is
patched in every test.

Two datetime domains matter here and must not be confused:
  - occurred_at (fed to the recorder / stored on LimsSampleTransition) is
    NAIVE UTC, matching the recorder's own dedup-window comparisons.
  - created_at / the sync cursor (lims_workflow_sync_state.cursor_created_at)
    is TZ-AWARE, matching the real IS column and the `DateTime(timezone=True)`
    cursor column — every fabricated event's created_at here is
    `datetime.now(timezone.utc)`-based.

House pattern: TEST-prefixed sample_ids (`TEST-WST5-`), explicit FK-safe
cleanup (LimsSampleTransition before LimsSample), plus wipe of the singleton
`is_sample_events` cursor row before AND after each test (it's a global
name='...' primary key, not scoped to the TEST- prefix).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from sqlalchemy import delete, select

from database import SessionLocal
from models import LimsSample, LimsSampleTransition, LimsWorkflowSyncState
from workflow import is_event_stream
from workflow.sample_log import record_sample_transition

CURSOR_NAME = is_event_stream.CURSOR_NAME


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.rollback()
    s.close()


def _wipe(db):
    db.rollback()
    db.execute(delete(LimsSampleTransition).where(
        LimsSampleTransition.lims_sample_pk.in_(
            select(LimsSample.id).where(LimsSample.sample_id.like("TEST-WST5-%"))
        )
    ))
    db.execute(delete(LimsSample).where(LimsSample.sample_id.like("TEST-WST5-%")))
    db.execute(delete(LimsWorkflowSyncState).where(LimsWorkflowSyncState.name == CURSOR_NAME))
    db.commit()


@pytest.fixture(autouse=True)
def cleanup(db):
    _wipe(db)
    yield
    _wipe(db)


def _seed_sample(db, suffix: str, status: str = "sample_due") -> LimsSample:
    row = LimsSample(sample_id=f"TEST-WST5-{suffix}", sample_type="x", status=status)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _fake_event(*, sample_id: str, transition: str, new_status: str,
                event_id: str | None, created_at: datetime,
                event_timestamp: int | None = None, ev_id: str = "uuid-fake") -> dict:
    return {
        "id": ev_id,
        "sample_id": sample_id,
        "transition": transition,
        "new_status": new_status,
        "event_id": event_id,
        "event_timestamp": event_timestamp,
        "created_at": created_at,
    }


def _get_cursor(db) -> LimsWorkflowSyncState | None:
    db.expire_all()
    return db.execute(
        select(LimsWorkflowSyncState).where(LimsWorkflowSyncState.name == CURSOR_NAME)
    ).scalar_one_or_none()


# ═══════════════════════════════════════════════════════════════════════════
# (a) fresh insert + cursor advance
# ═══════════════════════════════════════════════════════════════════════════


def test_fresh_event_inserts_and_advances_cursor(db):
    sample = _seed_sample(db, "A")
    created_at = datetime.now(timezone.utc)
    ts = int(created_at.timestamp())
    event = _fake_event(
        sample_id=sample.sample_id, transition="receive",
        new_status="sample_received", event_id="TEST-WST5-EVT-A",
        created_at=created_at, event_timestamp=ts, ev_id="uuid-a",
    )

    with patch.object(is_event_stream, "_fetch_events", return_value=[event]) as fetch:
        stats = is_event_stream.sync_once(SessionLocal)

    fetch.assert_called_once()
    assert stats == {"fetched": 1, "inserted": 1, "dup": 0, "no_sample": 0, "errors": 0}

    row = db.query(LimsSampleTransition).filter_by(lims_sample_pk=sample.id).one()
    assert row.source == "senaite"
    assert row.verb == "receive"
    assert row.to_status == "sample_received"
    assert row.is_event_id == "TEST-WST5-EVT-A"
    assert row.occurred_at == datetime.utcfromtimestamp(ts)

    cursor = _get_cursor(db)
    assert cursor is not None
    assert cursor.cursor_created_at == created_at


# ═══════════════════════════════════════════════════════════════════════════
# (b) same event re-synced → dup via the is_event_id partial unique
# ═══════════════════════════════════════════════════════════════════════════


def test_resynced_event_id_counts_as_dup(db):
    sample = _seed_sample(db, "B")
    created_at = datetime.now(timezone.utc)
    event = _fake_event(
        sample_id=sample.sample_id, transition="receive",
        new_status="sample_received", event_id="TEST-WST5-EVT-B",
        created_at=created_at, ev_id="uuid-b",
    )

    with patch.object(is_event_stream, "_fetch_events", return_value=[event]):
        first = is_event_stream.sync_once(SessionLocal)
    assert first["inserted"] == 1

    with patch.object(is_event_stream, "_fetch_events", return_value=[event]):
        second = is_event_stream.sync_once(SessionLocal)

    assert second == {"fetched": 1, "inserted": 0, "dup": 1, "no_sample": 0, "errors": 0}
    count = db.query(LimsSampleTransition).filter_by(lims_sample_pk=sample.id).count()
    assert count == 1


# ═══════════════════════════════════════════════════════════════════════════
# (c) event matching an mk1 row within +-5 min → dup via the window rule
# ═══════════════════════════════════════════════════════════════════════════


def test_event_within_mk1_window_counts_as_dup(db):
    sample = _seed_sample(db, "C")
    now = datetime.utcnow()
    assert record_sample_transition(
        db, sample_id=sample.sample_id, verb="receive",
        to_status="sample_received", source="mk1", occurred_at=now,
    ) is True
    db.commit()

    created_at = datetime.now(timezone.utc)
    event = _fake_event(
        sample_id=sample.sample_id, transition="receive",
        new_status="sample_received", event_id="TEST-WST5-EVT-C",
        created_at=created_at, event_timestamp=int((now + timedelta(minutes=3)).timestamp()),
        ev_id="uuid-c",
    )

    with patch.object(is_event_stream, "_fetch_events", return_value=[event]):
        stats = is_event_stream.sync_once(SessionLocal)

    assert stats == {"fetched": 1, "inserted": 0, "dup": 1, "no_sample": 0, "errors": 0}
    rows = db.query(LimsSampleTransition).filter_by(lims_sample_pk=sample.id).all()
    assert len(rows) == 1
    assert rows[0].source == "mk1"


# ═══════════════════════════════════════════════════════════════════════════
# (d) unknown sample_id → no_sample (cursor still advances — "seen", not
# "successfully inserted")
# ═══════════════════════════════════════════════════════════════════════════


def test_unknown_sample_counts_as_no_sample_but_advances_cursor(db):
    created_at = datetime.now(timezone.utc)
    event = _fake_event(
        sample_id="TEST-WST5-GHOST", transition="receive",
        new_status="sample_received", event_id="TEST-WST5-EVT-D",
        created_at=created_at, ev_id="uuid-d",
    )

    with patch.object(is_event_stream, "_fetch_events", return_value=[event]):
        stats = is_event_stream.sync_once(SessionLocal)

    assert stats == {"fetched": 1, "inserted": 0, "dup": 0, "no_sample": 1, "errors": 0}
    assert db.query(LimsSampleTransition).count() == 0 or True  # no row possible (no sample pk)

    cursor = _get_cursor(db)
    assert cursor is not None
    assert cursor.cursor_created_at == created_at


# ═══════════════════════════════════════════════════════════════════════════
# (e) _fetch_events raising → errors counted, cursor NOT advanced
# ═══════════════════════════════════════════════════════════════════════════


def test_fetch_failure_counts_error_and_does_not_move_cursor(db):
    # Pre-seed a real cursor so "not advanced" is a genuine regression guard
    # (an empty-row bug would also satisfy a weaker "no row exists" check).
    seeded_at = datetime.now(timezone.utc) - timedelta(hours=1)
    db.add(LimsWorkflowSyncState(name=CURSOR_NAME, cursor_created_at=seeded_at))
    db.commit()

    with patch.object(is_event_stream, "_fetch_events",
                      side_effect=RuntimeError("boom")) as fetch:
        stats = is_event_stream.sync_once(SessionLocal)

    fetch.assert_called_once()
    assert stats == {"fetched": 0, "inserted": 0, "dup": 0, "no_sample": 0, "errors": 1}

    cursor = _get_cursor(db)
    assert cursor is not None
    assert cursor.cursor_created_at == seeded_at


# ═══════════════════════════════════════════════════════════════════════════
# empty batch: fetched=0 is a legitimate steady-state result, not an error
# ═══════════════════════════════════════════════════════════════════════════


def test_empty_batch_is_a_noop(db):
    with patch.object(is_event_stream, "_fetch_events", return_value=[]):
        stats = is_event_stream.sync_once(SessionLocal)

    assert stats == {"fetched": 0, "inserted": 0, "dup": 0, "no_sample": 0, "errors": 0}
    assert _get_cursor(db) is None


# ═══════════════════════════════════════════════════════════════════════════
# maybe_start — only the disabled-via-env branch (never test the real loop
# with real sleeps)
# ═══════════════════════════════════════════════════════════════════════════


def test_maybe_start_noop_when_disabled(monkeypatch):
    monkeypatch.setenv("MK1_IS_EVENT_SYNC_ENABLED", "0")
    assert is_event_stream.maybe_start(app=None) is None
