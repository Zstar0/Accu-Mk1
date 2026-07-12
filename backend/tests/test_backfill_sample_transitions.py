"""Tests for Task 6: the one-time historical seed backfill
(scripts/backfill_sample_transitions_from_is.py) — copies IS
`sample_status_events` history into the native sample-transition log with
source='is_seed' (spec §6.5).

`backfill()` is exercised directly against a live session (via SessionLocal,
same house pattern as test_is_event_stream_sync.py / test_sample_transition_
log.py); the IS-side query is never hit for real — `_fetch_events` is the
deliberate test seam, patched in every test. Unlike Task 5's tests (which
fabricate exactly one page per mocked call), most tests here patch
`_fetch_events` with `_fake_fetch(pool)`: a small in-memory stand-in that
mirrors the REAL query's paging contract (`created_at ASC`, strictly greater
than the cursor, capped at batch_size) over a fixed pool of fabricated event
dicts. That lets multi-page pagination, checkpoint resume, and --limit
truncation be exercised through the real backfill() loop instead of hand-
sequencing one page per call.

House pattern: TEST-prefixed sample_ids (`TEST-WST6-`), explicit FK-safe
cleanup (LimsSampleTransition before LimsSample). No shared singleton row to
wipe here (unlike Task 5's cursor row) — the checkpoint is a plain file
under `tmp_path`, already test-isolated.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from sqlalchemy import delete, select

from database import SessionLocal
from models import LimsSample, LimsSampleTransition
from scripts import backfill_sample_transitions_from_is as bf
from workflow.sample_log import record_sample_transition


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
            select(LimsSample.id).where(LimsSample.sample_id.like("TEST-WST6-%"))
        )
    ))
    db.execute(delete(LimsSample).where(LimsSample.sample_id.like("TEST-WST6-%")))
    db.commit()


@pytest.fixture(autouse=True)
def cleanup(db):
    _wipe(db)
    yield
    _wipe(db)


@pytest.fixture
def checkpoint_path(tmp_path) -> str:
    """A fresh, non-existent checkpoint path — every test starts as a clean
    first-run unless it explicitly pre-seeds one (resume tests)."""
    return str(tmp_path / "ckpt.json")


def _seed_sample(db, suffix: str, status: str = "sample_due") -> LimsSample:
    row = LimsSample(sample_id=f"TEST-WST6-{suffix}", sample_type="x", status=status)
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


def _fake_fetch(pool: list[dict]):
    """Build a `_fetch_events(cursor_dt, batch_size)`-shaped stand-in over a
    FIXED pool of fabricated events, honoring the real query's paging
    contract: `created_at ASC`, strictly greater than cursor, capped at
    batch_size."""
    def _fetch(cursor_dt, batch_size):
        matches = sorted(
            (e for e in pool if e["created_at"] > cursor_dt),
            key=lambda e: e["created_at"],
        )
        return matches[:batch_size]
    return _fetch


# ═══════════════════════════════════════════════════════════════════════════
# checkpoint round trip
# ═══════════════════════════════════════════════════════════════════════════


def test_checkpoint_round_trip(tmp_path):
    p = str(tmp_path / "ckpt.json")
    assert bf.load_checkpoint(p) == bf.EPOCH  # missing file -> fresh run

    dt = datetime(2026, 7, 1, 12, 30, tzinfo=timezone.utc)
    bf.save_checkpoint(p, dt)
    assert bf.load_checkpoint(p) == dt

    (tmp_path / "ckpt.json").write_text("garbage")
    assert bf.load_checkpoint(p) == bf.EPOCH  # corrupt file -> fresh run


# ═══════════════════════════════════════════════════════════════════════════
# (a) dry-run: writes nothing, counts would_insert / dup via existence checks
# ═══════════════════════════════════════════════════════════════════════════


def test_dry_run_writes_nothing_and_counts_would_insert(db, checkpoint_path):
    sample = _seed_sample(db, "A")
    created_at = datetime.now(timezone.utc)
    pool = [_fake_event(
        sample_id=sample.sample_id, transition="receive",
        new_status="sample_received", event_id="TEST-WST6-EVT-A",
        created_at=created_at, event_timestamp=int(created_at.timestamp()),
    )]

    with patch.object(bf, "_fetch_events", side_effect=_fake_fetch(pool)) as fetch:
        stats = bf.backfill(SessionLocal, batch_size=100, checkpoint_path=checkpoint_path,
                            dry_run=True, limit=None)

    fetch.assert_called_once()
    assert stats == {"fetched": 1, "inserted": 0, "dup": 0, "no_sample": 0,
                      "would_insert": 1, "errors": 0}
    assert db.query(LimsSampleTransition).filter_by(lims_sample_pk=sample.id).count() == 0
    assert not os.path.exists(checkpoint_path)  # dry-run: NO checkpoint written


def test_dry_run_counts_dup_for_already_seeded_event_id(db, checkpoint_path):
    """Dry-run's would_insert/dup preview must mirror the real run's actual
    outcome: an is_event_id that already exists (from a prior real seed)
    previews as dup, not would_insert."""
    sample = _seed_sample(db, "B")
    assert record_sample_transition(
        db, sample_id=sample.sample_id, to_status="sample_received",
        source="is_seed", is_event_id="TEST-WST6-EVT-B",
    ) is True
    db.commit()

    created_at = datetime.now(timezone.utc)
    pool = [_fake_event(
        sample_id=sample.sample_id, transition="receive",
        new_status="sample_received", event_id="TEST-WST6-EVT-B",
        created_at=created_at,
    )]

    with patch.object(bf, "_fetch_events", side_effect=_fake_fetch(pool)):
        stats = bf.backfill(SessionLocal, batch_size=100, checkpoint_path=checkpoint_path,
                            dry_run=True, limit=None)

    assert stats["would_insert"] == 0
    assert stats["dup"] == 1
    assert db.query(LimsSampleTransition).filter_by(lims_sample_pk=sample.id).count() == 1


def test_dry_run_leaves_existing_checkpoint_untouched(db, checkpoint_path):
    sample = _seed_sample(db, "I")
    seeded_at = datetime.now(timezone.utc) - timedelta(hours=2)
    bf.save_checkpoint(checkpoint_path, seeded_at)
    mtime_before = os.stat(checkpoint_path).st_mtime_ns

    created_at = datetime.now(timezone.utc)
    pool = [_fake_event(
        sample_id=sample.sample_id, transition="receive",
        new_status="sample_received", event_id="TEST-WST6-EVT-I",
        created_at=created_at,
    )]
    with patch.object(bf, "_fetch_events", side_effect=_fake_fetch(pool)):
        bf.backfill(SessionLocal, batch_size=100, checkpoint_path=checkpoint_path,
                   dry_run=True, limit=None)

    assert os.stat(checkpoint_path).st_mtime_ns == mtime_before
    assert bf.load_checkpoint(checkpoint_path) == seeded_at


# ═══════════════════════════════════════════════════════════════════════════
# (b) real run inserts source='is_seed' with expected fields
# ═══════════════════════════════════════════════════════════════════════════


def test_real_run_inserts_source_is_seed_with_expected_fields(db, checkpoint_path):
    sample = _seed_sample(db, "C")
    created_at = datetime.now(timezone.utc)
    ts = int(created_at.timestamp())
    pool = [_fake_event(
        sample_id=sample.sample_id, transition="receive",
        new_status="sample_received", event_id="TEST-WST6-EVT-C",
        created_at=created_at, event_timestamp=ts,
    )]

    with patch.object(bf, "_fetch_events", side_effect=_fake_fetch(pool)):
        stats = bf.backfill(SessionLocal, batch_size=100, checkpoint_path=checkpoint_path,
                            dry_run=False, limit=None)

    assert stats == {"fetched": 1, "inserted": 1, "dup": 0, "no_sample": 0,
                      "would_insert": 0, "errors": 0}

    row = db.query(LimsSampleTransition).filter_by(lims_sample_pk=sample.id).one()
    assert row.source == "is_seed"
    assert row.verb == "receive"
    assert row.to_status == "sample_received"
    assert row.is_event_id == "TEST-WST6-EVT-C"
    assert row.occurred_at == datetime.utcfromtimestamp(ts)

    assert bf.load_checkpoint(checkpoint_path) == created_at


# ═══════════════════════════════════════════════════════════════════════════
# (c) re-run (checkpoint reset to re-scan the same window) -> all dup
# ═══════════════════════════════════════════════════════════════════════════


def test_rerun_from_scratch_is_all_dup(db, checkpoint_path):
    sample = _seed_sample(db, "D")
    created_at = datetime.now(timezone.utc)
    pool = [_fake_event(
        sample_id=sample.sample_id, transition="receive",
        new_status="sample_received", event_id="TEST-WST6-EVT-D",
        created_at=created_at,
    )]

    with patch.object(bf, "_fetch_events", side_effect=_fake_fetch(pool)):
        first = bf.backfill(SessionLocal, batch_size=100, checkpoint_path=checkpoint_path,
                            dry_run=False, limit=None)
    assert first["inserted"] == 1

    # No-overlap pagination (unlike Task 5's incremental sync) means an
    # UNMODIFIED checkpoint naturally fetches zero new rows next run — the
    # cursor already sits strictly past this event. "Re-run" here means the
    # documented resume-gotcha scenario: an operator deletes the checkpoint
    # to deliberately re-scan (same idiom as test_backfill_parent_analysis_
    # shadows.py's idempotent-rerun test re-seeding its checkpoint).
    os.remove(checkpoint_path)
    with patch.object(bf, "_fetch_events", side_effect=_fake_fetch(pool)):
        second = bf.backfill(SessionLocal, batch_size=100, checkpoint_path=checkpoint_path,
                             dry_run=False, limit=None)

    assert second == {"fetched": 1, "inserted": 0, "dup": 1, "no_sample": 0,
                       "would_insert": 0, "errors": 0}
    count = db.query(LimsSampleTransition).filter_by(lims_sample_pk=sample.id).count()
    assert count == 1


# ═══════════════════════════════════════════════════════════════════════════
# (d) checkpoint resume skips earlier pages
# ═══════════════════════════════════════════════════════════════════════════


def test_checkpoint_resume_skips_earlier_pages(db, checkpoint_path):
    sample = _seed_sample(db, "E")
    base = datetime.now(timezone.utc)
    older = base - timedelta(hours=1)
    newer = base

    pool = [
        _fake_event(sample_id=sample.sample_id, transition="receive",
                    new_status="sample_received", event_id="TEST-WST6-EVT-E-OLD",
                    created_at=older, ev_id="uuid-e-old"),
        _fake_event(sample_id=sample.sample_id, transition="publish",
                    new_status="published", event_id="TEST-WST6-EVT-E-NEW",
                    created_at=newer, ev_id="uuid-e-new"),
    ]

    # Pre-seed the checkpoint AFTER the older event, simulating a prior run
    # that already got that far.
    bf.save_checkpoint(checkpoint_path, older)

    with patch.object(bf, "_fetch_events", side_effect=_fake_fetch(pool)) as fetch:
        stats = bf.backfill(SessionLocal, batch_size=100, checkpoint_path=checkpoint_path,
                            dry_run=False, limit=None)

    # Only the NEWER event (strictly after the checkpoint) is fetched/inserted.
    assert stats == {"fetched": 1, "inserted": 1, "dup": 0, "no_sample": 0,
                      "would_insert": 0, "errors": 0}
    rows = db.query(LimsSampleTransition).filter_by(lims_sample_pk=sample.id).all()
    assert len(rows) == 1
    assert rows[0].is_event_id == "TEST-WST6-EVT-E-NEW"

    # The first _fetch_events call received the pre-seeded cursor, not epoch.
    first_call_cursor = fetch.call_args_list[0].args[0]
    assert first_call_cursor == older


def test_multi_page_single_invocation_advances_cursor_between_pages(db, checkpoint_path):
    sample = _seed_sample(db, "K")
    base = datetime.now(timezone.utc)
    pool = [
        _fake_event(sample_id=sample.sample_id, transition="receive",
                    new_status="sample_received", event_id=f"TEST-WST6-EVT-K{i}",
                    created_at=base + timedelta(seconds=i), ev_id=f"uuid-k{i}")
        for i in range(5)
    ]

    with patch.object(bf, "_fetch_events", side_effect=_fake_fetch(pool)) as fetch:
        stats = bf.backfill(SessionLocal, batch_size=2, checkpoint_path=checkpoint_path,
                            dry_run=False, limit=None)

    # 5 events at page size 2: pages of (2, 2, 1) -> 3 _fetch_events calls
    # inside ONE backfill() invocation, cursor advancing between each.
    assert fetch.call_count == 3
    assert stats == {"fetched": 5, "inserted": 5, "dup": 0, "no_sample": 0,
                      "would_insert": 0, "errors": 0}
    rows = db.query(LimsSampleTransition).filter_by(lims_sample_pk=sample.id).all()
    assert len(rows) == 5
    assert bf.load_checkpoint(checkpoint_path) == pool[-1]["created_at"]


# ═══════════════════════════════════════════════════════════════════════════
# (e) unknown samples counted as no_sample (cursor still advances)
# ═══════════════════════════════════════════════════════════════════════════


def test_unknown_sample_counted_as_no_sample(db, checkpoint_path):
    created_at = datetime.now(timezone.utc)
    pool = [_fake_event(
        sample_id="TEST-WST6-GHOST", transition="receive",
        new_status="sample_received", event_id="TEST-WST6-EVT-F",
        created_at=created_at,
    )]

    with patch.object(bf, "_fetch_events", side_effect=_fake_fetch(pool)):
        stats = bf.backfill(SessionLocal, batch_size=100, checkpoint_path=checkpoint_path,
                            dry_run=False, limit=None)

    assert stats == {"fetched": 1, "inserted": 0, "dup": 0, "no_sample": 1,
                      "would_insert": 0, "errors": 0}
    scoped_count = db.query(LimsSampleTransition).filter(
        LimsSampleTransition.lims_sample_pk.in_(
            select(LimsSample.id).where(LimsSample.sample_id.like("TEST-WST6-%"))
        )
    ).count()
    assert scoped_count == 0
    assert bf.load_checkpoint(checkpoint_path) == created_at  # "seen", cursor advances


# ═══════════════════════════════════════════════════════════════════════════
# dedup nuance: source='is_seed' never applies the senaite ±5min window rule
# ═══════════════════════════════════════════════════════════════════════════


def test_is_seed_does_not_dedup_within_senaite_window(db, checkpoint_path):
    sample = _seed_sample(db, "G")
    now = datetime.utcnow()
    assert record_sample_transition(
        db, sample_id=sample.sample_id, verb="receive",
        to_status="sample_received", source="mk1", occurred_at=now,
    ) is True
    db.commit()

    created_at = datetime.now(timezone.utc)
    event_ts = int((now + timedelta(minutes=2)).timestamp())
    pool = [_fake_event(
        sample_id=sample.sample_id, transition="receive",
        new_status="sample_received", event_id="TEST-WST6-EVT-G",
        created_at=created_at, event_timestamp=event_ts,
    )]

    with patch.object(bf, "_fetch_events", side_effect=_fake_fetch(pool)):
        stats = bf.backfill(SessionLocal, batch_size=100, checkpoint_path=checkpoint_path,
                            dry_run=False, limit=None)

    # Unlike source='senaite', 'is_seed' skips the mk1-window dedup check
    # entirely (workflow/sample_log.py::_explained) — this inserts even
    # though it lands 2 minutes from the existing mk1 row for the same verb.
    assert stats["inserted"] == 1
    assert stats["dup"] == 0
    rows = db.query(LimsSampleTransition).filter_by(lims_sample_pk=sample.id).all()
    assert len(rows) == 2
    assert {r.source for r in rows} == {"mk1", "is_seed"}


# ═══════════════════════════════════════════════════════════════════════════
# --limit caps events PROCESSED, checkpoint reflects only the processed slice
# ═══════════════════════════════════════════════════════════════════════════


def test_limit_caps_events_processed_and_checkpoint_reflects_partial_page(db, checkpoint_path):
    sample = _seed_sample(db, "H")
    base = datetime.now(timezone.utc)
    pool = [
        _fake_event(sample_id=sample.sample_id, transition="receive",
                    new_status="sample_received", event_id=f"TEST-WST6-EVT-H{i}",
                    created_at=base + timedelta(seconds=i), ev_id=f"uuid-h{i}")
        for i in range(3)
    ]

    with patch.object(bf, "_fetch_events", side_effect=_fake_fetch(pool)):
        stats = bf.backfill(SessionLocal, batch_size=100, checkpoint_path=checkpoint_path,
                            dry_run=False, limit=1)

    assert stats["fetched"] == 3  # the whole page was fetched...
    assert stats["inserted"] == 1  # ...but only 1 event was PROCESSED (limit)
    rows = db.query(LimsSampleTransition).filter_by(lims_sample_pk=sample.id).all()
    assert len(rows) == 1
    assert rows[0].is_event_id == "TEST-WST6-EVT-H0"

    # Checkpoint reflects only the processed event, not the whole fetched
    # page — the un-processed tail (H1, H2) must be re-fetchable next run.
    assert bf.load_checkpoint(checkpoint_path) == pool[0]["created_at"]

    with patch.object(bf, "_fetch_events", side_effect=_fake_fetch(pool)):
        stats2 = bf.backfill(SessionLocal, batch_size=100, checkpoint_path=checkpoint_path,
                             dry_run=False, limit=None)

    assert stats2["fetched"] == 2
    assert stats2["inserted"] == 2
    rows = db.query(LimsSampleTransition).filter_by(lims_sample_pk=sample.id).all()
    assert len(rows) == 3


def _commit_failing_factory(real_factory):
    """A db_factory wrapper whose returned session's commit() raises once —
    exercises the page-commit-failure path (stats discarded, one error
    tallied, run stops) without needing a real DB outage. The row is still
    flushed via record_sample_transition's begin_nested() savepoint before
    commit() is reached, so this also proves Session.close() rolls back the
    uncommitted work — nothing durable survives a failed page commit."""
    def factory():
        session = real_factory()
        session.commit = lambda: (_ for _ in ()).throw(RuntimeError("connection lost"))
        return session
    return factory


def test_page_commit_failure_discards_page_stats_and_stops(db, checkpoint_path):
    sample = _seed_sample(db, "L")
    created_at = datetime.now(timezone.utc)
    pool = [_fake_event(
        sample_id=sample.sample_id, transition="receive",
        new_status="sample_received", event_id="TEST-WST6-EVT-L",
        created_at=created_at,
    )]

    with patch.object(bf, "_fetch_events", side_effect=_fake_fetch(pool)):
        stats = bf.backfill(_commit_failing_factory(SessionLocal), batch_size=100,
                            checkpoint_path=checkpoint_path, dry_run=False, limit=None)

    assert stats == {"fetched": 1, "inserted": 0, "dup": 0, "no_sample": 0,
                      "would_insert": 0, "errors": 1}
    # Nothing durable: close() rolled back the flushed-but-uncommitted insert.
    assert db.query(LimsSampleTransition).filter_by(lims_sample_pk=sample.id).count() == 0
    # No checkpoint write either — the page never actually landed.
    assert not os.path.exists(checkpoint_path)


# ═══════════════════════════════════════════════════════════════════════════
# fetch failure: errors counted, cursor NOT advanced
# ═══════════════════════════════════════════════════════════════════════════


def test_fetch_failure_counts_error_and_does_not_move_cursor(db, checkpoint_path):
    seeded_at = datetime.now(timezone.utc) - timedelta(hours=1)
    bf.save_checkpoint(checkpoint_path, seeded_at)

    with patch.object(bf, "_fetch_events", side_effect=RuntimeError("boom")) as fetch:
        stats = bf.backfill(SessionLocal, batch_size=100, checkpoint_path=checkpoint_path,
                            dry_run=False, limit=None)

    fetch.assert_called_once()
    assert stats == {"fetched": 0, "inserted": 0, "dup": 0, "no_sample": 0,
                      "would_insert": 0, "errors": 1}
    assert bf.load_checkpoint(checkpoint_path) == seeded_at


def test_empty_pool_is_a_noop(db, checkpoint_path):
    with patch.object(bf, "_fetch_events", side_effect=_fake_fetch([])):
        stats = bf.backfill(SessionLocal, batch_size=100, checkpoint_path=checkpoint_path,
                            dry_run=False, limit=None)

    assert stats == {"fetched": 0, "inserted": 0, "dup": 0, "no_sample": 0,
                      "would_insert": 0, "errors": 0}
    assert not os.path.exists(checkpoint_path)


# ═══════════════════════════════════════════════════════════════════════════
# main() — CLI stats line + exit code
# ═══════════════════════════════════════════════════════════════════════════


def test_main_prints_stats_json_and_exit_code_zero(db, checkpoint_path, capsys):
    sample = _seed_sample(db, "J")
    created_at = datetime.now(timezone.utc)
    pool = [_fake_event(
        sample_id=sample.sample_id, transition="receive",
        new_status="sample_received", event_id="TEST-WST6-EVT-J",
        created_at=created_at,
    )]

    with patch.object(bf, "_fetch_events", side_effect=_fake_fetch(pool)):
        rc = bf.main(["--checkpoint", checkpoint_path, "--sleep", "0"])

    assert rc == 0
    stats = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert stats["inserted"] == 1
    assert stats["errors"] == 0


def test_main_exit_code_reflects_errors(db, checkpoint_path, capsys):
    with patch.object(bf, "_fetch_events", side_effect=RuntimeError("boom")):
        rc = bf.main(["--checkpoint", checkpoint_path, "--sleep", "0"])

    assert rc == 1
    stats = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert stats["errors"] == 1
