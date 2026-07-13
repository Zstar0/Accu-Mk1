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


def _seed_cursor(db, dt: datetime | None = None) -> None:
    """Pre-seed the sync cursor so a test can exercise steady-state
    incremental-pull behavior directly, bypassing the cold-start tick (see
    module COLD-START SEMANTICS: a missing cursor row means sync_once
    initializes-and-returns on its own, without ever calling _fetch_events)."""
    db.add(LimsWorkflowSyncState(
        name=CURSOR_NAME,
        cursor_created_at=dt or (datetime.now(timezone.utc) - timedelta(hours=1)),
    ))
    db.commit()


# ═══════════════════════════════════════════════════════════════════════════
# (a) fresh insert + cursor advance
# ═══════════════════════════════════════════════════════════════════════════


def test_fresh_event_inserts_and_advances_cursor(db):
    sample = _seed_sample(db, "A")
    _seed_cursor(db)
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
    assert stats == {"fetched": 1, "inserted": 1, "dup": 0, "no_sample": 0, "healed": 0, "errors": 0}

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
    _seed_cursor(db)
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

    assert second == {"fetched": 1, "inserted": 0, "dup": 1, "no_sample": 0, "healed": 0, "errors": 0}
    count = db.query(LimsSampleTransition).filter_by(lims_sample_pk=sample.id).count()
    assert count == 1


# ═══════════════════════════════════════════════════════════════════════════
# (c) event matching an mk1 row within +-5 min → dup via the window rule
# ═══════════════════════════════════════════════════════════════════════════


def test_event_within_mk1_window_counts_as_dup(db):
    sample = _seed_sample(db, "C")
    _seed_cursor(db)
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

    assert stats == {"fetched": 1, "inserted": 0, "dup": 1, "no_sample": 0, "healed": 0, "errors": 0}
    rows = db.query(LimsSampleTransition).filter_by(lims_sample_pk=sample.id).all()
    assert len(rows) == 1
    assert rows[0].source == "mk1"


# ═══════════════════════════════════════════════════════════════════════════
# (d) unknown sample_id → no_sample (cursor still advances — "seen", not
# "successfully inserted")
# ═══════════════════════════════════════════════════════════════════════════


def test_unknown_sample_counts_as_no_sample_but_advances_cursor(db):
    _seed_cursor(db)
    created_at = datetime.now(timezone.utc)
    event = _fake_event(
        sample_id="TEST-WST5-GHOST", transition="receive",
        new_status="sample_received", event_id="TEST-WST5-EVT-D",
        created_at=created_at, ev_id="uuid-d",
    )

    with patch.object(is_event_stream, "_fetch_events", return_value=[event]):
        stats = is_event_stream.sync_once(SessionLocal)

    assert stats == {"fetched": 1, "inserted": 0, "dup": 0, "no_sample": 1, "healed": 0, "errors": 0}
    scoped_count = db.query(LimsSampleTransition).filter(
        LimsSampleTransition.lims_sample_pk.in_(
            select(LimsSample.id).where(LimsSample.sample_id.like("TEST-WST5-%"))
        )
    ).count()
    assert scoped_count == 0  # no row possible (no sample pk)

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
    assert stats == {"fetched": 0, "inserted": 0, "dup": 0, "no_sample": 0, "healed": 0, "errors": 1}

    cursor = _get_cursor(db)
    assert cursor is not None
    assert cursor.cursor_created_at == seeded_at


# ═══════════════════════════════════════════════════════════════════════════
# (f) per-event error isolation: one bad event in a batch doesn't sink the
# other events, and the cursor still advances past the whole batch (same
# "seen, not necessarily inserted" cursor semantics as the no_sample case)
# ═══════════════════════════════════════════════════════════════════════════


def test_per_event_error_is_isolated_and_cursor_still_advances(db):
    sample = _seed_sample(db, "F")
    _seed_cursor(db)
    base = datetime.now(timezone.utc)
    events = [
        _fake_event(
            sample_id=sample.sample_id, transition="receive",
            new_status="sample_received", event_id=f"TEST-WST5-EVT-F{i}",
            created_at=base + timedelta(seconds=i), ev_id=f"uuid-f{i}",
        )
        for i in range(3)
    ]
    last_created_at = events[-1]["created_at"]

    with patch.object(is_event_stream, "_fetch_events", return_value=events), \
         patch.object(is_event_stream, "record_sample_transition",
                       side_effect=[True, RuntimeError("boom"), True]) as recorder:
        stats = is_event_stream.sync_once(SessionLocal)

    assert recorder.call_count == 3
    # healed=1: the first insert heals sample_due -> sample_received; the
    # third inserts but the status is already current (no second heal).
    assert stats == {"fetched": 3, "inserted": 2, "dup": 0, "no_sample": 0, "healed": 1, "errors": 1}

    cursor = _get_cursor(db)
    assert cursor is not None
    assert cursor.cursor_created_at == last_created_at


# ═══════════════════════════════════════════════════════════════════════════
# empty batch: fetched=0 is a legitimate steady-state result, not an error
# (with a cursor already established — the cold-start tick is covered
# separately below)
# ═══════════════════════════════════════════════════════════════════════════


def test_empty_batch_is_a_noop(db):
    seeded_at = datetime.now(timezone.utc) - timedelta(hours=1)
    _seed_cursor(db, seeded_at)

    with patch.object(is_event_stream, "_fetch_events", return_value=[]) as fetch:
        stats = is_event_stream.sync_once(SessionLocal)

    fetch.assert_called_once()
    assert stats == {"fetched": 0, "inserted": 0, "dup": 0, "no_sample": 0,
                     "healed": 0, "errors": 0}
    cursor = _get_cursor(db)
    assert cursor is not None
    assert cursor.cursor_created_at == seeded_at


# ═══════════════════════════════════════════════════════════════════════════
# cold start: no cursor row yet → sync_once initializes the cursor to now
# and returns without ever calling _fetch_events (no epoch-walk of IS
# history — that history belongs to the seed backfill script instead)
# ═══════════════════════════════════════════════════════════════════════════


def test_cold_start_initializes_cursor_to_now_without_fetching(db):
    assert _get_cursor(db) is None
    before = datetime.now(timezone.utc)

    with patch.object(is_event_stream, "_fetch_events") as fetch:
        stats = is_event_stream.sync_once(SessionLocal)

    after = datetime.now(timezone.utc)
    fetch.assert_not_called()
    assert stats == {"fetched": 0, "inserted": 0, "dup": 0, "no_sample": 0,
                     "healed": 0, "errors": 0}

    cursor = _get_cursor(db)
    assert cursor is not None
    assert before <= cursor.cursor_created_at <= after


# ═══════════════════════════════════════════════════════════════════════════
# maybe_start — only the disabled-via-env branch (never test the real loop
# with real sleeps)
# ═══════════════════════════════════════════════════════════════════════════


def test_maybe_start_noop_when_disabled(monkeypatch):
    monkeypatch.setenv("MK1_IS_EVENT_SYNC_ENABLED", "0")
    assert is_event_stream.maybe_start(app=None) is None


# ═══════════════════════════════════════════════════════════════════════════
# log-and-heal — a freshly-inserted senaite row mirrors the status column
# in the same batch; dups and stale catch-up events never touch it
# ═══════════════════════════════════════════════════════════════════════════


def test_inserted_event_heals_status(db):
    sample = _seed_sample(db, "H1", status="sample_received")
    # Model default stamps last_synced_at=now at creation; the event's
    # second-truncated timestamp would tie with it and trip the
    # anti-regression guard. Steady state is a snapshot from a while ago.
    sample.last_synced_at = datetime.utcnow() - timedelta(hours=1)
    db.commit()
    _seed_cursor(db)
    created_at = datetime.now(timezone.utc)
    event = _fake_event(
        sample_id=sample.sample_id, transition="submit",
        new_status="to_be_verified", event_id="TEST-WST5-EVT-H1",
        created_at=created_at, event_timestamp=int(created_at.timestamp()),
        ev_id="uuid-h1",
    )

    with patch.object(is_event_stream, "_fetch_events", return_value=[event]):
        stats = is_event_stream.sync_once(SessionLocal)

    assert stats["inserted"] == 1
    assert stats["healed"] == 1
    db.expire_all()
    assert db.get(LimsSample, sample.id).status == "to_be_verified"


def test_dup_event_does_not_heal(db):
    sample = _seed_sample(db, "H2", status="sample_received")
    _seed_cursor(db)
    # Pre-record the same is_event_id so the sync sees a dedup skip, then
    # force the status column stale — a dup must NOT heal it.
    record_sample_transition(
        db, sample_id=sample.sample_id, to_status="to_be_verified",
        source="senaite", verb="submit",
        occurred_at=datetime.utcnow() - timedelta(minutes=5),
        is_event_id="TEST-WST5-EVT-H2",
    )
    db.commit()
    sample.status = "sample_received"
    db.commit()

    created_at = datetime.now(timezone.utc)
    event = _fake_event(
        sample_id=sample.sample_id, transition="submit",
        new_status="to_be_verified", event_id="TEST-WST5-EVT-H2",
        created_at=created_at, event_timestamp=int(created_at.timestamp()),
        ev_id="uuid-h2",
    )

    with patch.object(is_event_stream, "_fetch_events", return_value=[event]):
        stats = is_event_stream.sync_once(SessionLocal)

    assert stats["dup"] == 1
    assert stats["healed"] == 0
    db.expire_all()
    assert db.get(LimsSample, sample.id).status == "sample_received"


def test_stale_event_does_not_regress_fresher_reconcile(db):
    # Sample was reconciled from a fresh SENAITE snapshot moments ago
    # (status=verified); a 3h-old backlog event must land in the LOG but
    # never regress the status column.
    sample = _seed_sample(db, "H3", status="verified")
    sample.last_synced_at = datetime.utcnow()
    db.commit()
    _seed_cursor(db)

    created_at = datetime.now(timezone.utc)
    stale_ts = int((created_at - timedelta(hours=3)).timestamp())
    event = _fake_event(
        sample_id=sample.sample_id, transition="submit",
        new_status="to_be_verified", event_id="TEST-WST5-EVT-H3",
        created_at=created_at, event_timestamp=stale_ts, ev_id="uuid-h3",
    )

    with patch.object(is_event_stream, "_fetch_events", return_value=[event]):
        stats = is_event_stream.sync_once(SessionLocal)

    assert stats["inserted"] == 1
    assert stats["healed"] == 0
    db.expire_all()
    assert db.get(LimsSample, sample.id).status == "verified"
