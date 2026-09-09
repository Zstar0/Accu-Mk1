# backend/tests/test_senaite_tee_retry_job.py
from datetime import datetime, timedelta, timezone
from unittest.mock import patch, call

from sqlalchemy import select

from models import LimsSample, LimsSenaiteTeeRetry

T0 = datetime(2026, 9, 9, 12, 0, tzinfo=timezone.utc)


def _queued(db, sid, verb, status="verified", attempts=1, due=T0):
    row = LimsSample(sample_id=sid, status=status, external_lims_uid=f"U-{sid}")
    db.add(row)
    db.flush()
    q = LimsSenaiteTeeRetry(lims_sample_pk=row.id, verb=verb,
                            expected_state={"verify": "verified", "publish": "published", "cancel": "cancelled"}[verb],
                            attempts=attempts, next_attempt_at=due, status="pending")
    db.add(q)
    db.flush()
    return row, q


def test_due_row_retried_and_done(db_session):
    from workflow.senaite_tee import run_retries
    row, q = _queued(db_session, "P-RJ-1", "verify")
    with patch("workflow.senaite_tee._ar_transition") as tr, \
         patch("workflow.senaite_tee.read_back_state", return_value="verified"):
        stats = run_retries(db_session, now=T0 + timedelta(minutes=1))
    assert stats["done"] == 1 and q.status == "done"
    tr.assert_called_once_with("U-P-RJ-1", "verify")


def test_not_due_row_untouched(db_session):
    from workflow.senaite_tee import run_retries
    _, q = _queued(db_session, "P-RJ-2", "verify", due=T0 + timedelta(hours=1))
    with patch("workflow.senaite_tee._ar_transition") as tr:
        stats = run_retries(db_session, now=T0)
    tr.assert_not_called()
    assert stats["retried"] == 0 and q.status == "pending"


def test_publish_refused_because_unverified_issues_verify_first(db_session):
    from workflow.senaite_tee import run_retries
    row, q = _queued(db_session, "P-RJ-3", "publish", status="published")
    # SENAITE: to_be_verified -> (verify) -> verified -> (publish) -> published
    states = iter(["to_be_verified", "verified", "published"])
    with patch("workflow.senaite_tee._ar_transition") as tr, \
         patch("workflow.senaite_tee.read_back_state", side_effect=lambda s: next(states)):
        stats = run_retries(db_session, now=T0)
    assert tr.call_args_list == [call("U-P-RJ-3", "verify"), call("U-P-RJ-3", "publish")]
    assert stats["done"] == 1 and q.status == "done"


def test_backoff_and_give_up(db_session):
    from workflow.senaite_tee import run_retries, BACKOFF_MINUTES
    row, q = _queued(db_session, "P-RJ-4", "verify", attempts=1)
    with patch("workflow.senaite_tee._ar_transition"), \
         patch("workflow.senaite_tee.read_back_state", return_value="sample_received"):
        run_retries(db_session, now=T0)
    assert q.status == "pending" and q.attempts == 2
    assert q.next_attempt_at == T0 + timedelta(minutes=BACKOFF_MINUTES[1])
    q.attempts = 7
    q.next_attempt_at = T0
    db_session.flush()
    with patch("workflow.senaite_tee._ar_transition"), \
         patch("workflow.senaite_tee.read_back_state", return_value="sample_received"):
        stats = run_retries(db_session, now=T0)
    assert q.status == "gave_up" and stats["gave_up"] == 1


def test_superseded_by_later_native_state(db_session):
    from workflow.senaite_tee import run_retries
    row, q = _queued(db_session, "P-RJ-5", "verify", status="cancelled")   # native moved on
    row.native_status = "cancelled"
    db_session.flush()
    with patch("workflow.senaite_tee._ar_transition") as tr:
        stats = run_retries(db_session, now=T0)
    tr.assert_not_called()
    assert q.status == "done" and stats["superseded"] == 1


def test_summary_reports_gave_up_count(db_session):
    from workflow.senaite_tee import gave_up_count
    _, q = _queued(db_session, "P-RJ-6", "verify")
    q.status = "gave_up"
    db_session.flush()
    assert gave_up_count(db_session) == 1


def test_mirror_lagging_but_native_reached_target_is_retried(db_session):
    """senaite authority: lims_samples.status is SENAITE's mirror and lags;
    the engine's native_status is the truth the retry must respect."""
    from workflow.senaite_tee import run_retries
    row, q = _queued(db_session, "P-RJ-7", "publish", status="to_be_verified")
    row.native_status = "published"
    db_session.flush()
    with patch("workflow.senaite_tee._ar_transition") as tr, \
         patch("workflow.senaite_tee.read_back_state", return_value="published"):
        stats = run_retries(db_session, now=T0)
    assert stats["retried"] == 1 and stats["superseded"] == 0 and q.status == "done"
    assert tr.call_count >= 1


def test_native_status_moved_on_is_superseded(db_session):
    from workflow.senaite_tee import run_retries
    row, q = _queued(db_session, "P-RJ-8", "verify", status="verified")
    row.native_status = "cancelled"
    db_session.flush()
    with patch("workflow.senaite_tee._ar_transition") as tr:
        stats = run_retries(db_session, now=T0)
    tr.assert_not_called()
    assert q.status == "done" and stats["superseded"] == 1 and "cancelled" in (q.last_error or "")


def test_one_failing_row_does_not_poison_the_batch(db_session):
    """Per-row savepoint: a row whose processing fails INSIDE A FLUSH is
    isolated to that row's SAVEPOINT; the next row in the batch still gets
    processed and completed, and the failure is counted as an error rather
    than corrupting the session for every later row.

    A plain `RuntimeError` from a mock never touches the session (nothing
    was ever flushed), so it can't discriminate a fixed run_retries from an
    unfixed one — both just catch it and move on. The failure mode this
    guards against is a failed *statement*: on Postgres that aborts the
    whole transaction until rolled back; here it's reproduced
    dialect-independently by colliding on `LimsSenaiteTeeRetry.id` inside
    `_attempt`'s flush, which SQLite also rejects.
    """
    from workflow import senaite_tee as tee
    row1, q1 = _queued(db_session, "P-RJ-9", "verify", due=T0)
    row2, q2 = _queued(db_session, "P-RJ-10", "verify", due=T0 + timedelta(seconds=1))

    calls = {"n": 0}

    def _boom_then_ok(db, sample, row, *, now):
        calls["n"] += 1
        if calls["n"] == 1:
            # Duplicate primary key -> IntegrityError raised INSIDE flush,
            # not a bare Python exception — this is what actually leaves a
            # real (non-nested) session unusable for the next row.
            db.add(LimsSenaiteTeeRetry(id=q2.id, lims_sample_pk=row1.id, verb="verify",
                                       expected_state="verified", attempts=1,
                                       next_attempt_at=T0, status="pending"))
            db.flush()
        return "done"

    # both rows must be in the due batch (row1 first, row2 second) — "now"
    # has to be >= row2's due timestamp, not just row1's.
    with patch("workflow.senaite_tee._attempt", side_effect=_boom_then_ok) as at:
        stats = tee.run_retries(db_session, now=T0 + timedelta(seconds=1))
    assert stats["errors"] == 1 and stats["retried"] == 2
    assert at.call_count == 2


def test_cancel_retry_past_assignment_is_senaite_only_without_posting(db_session):
    """The read-back gate lives in the retry job too: an AR SENAITE will never
    cancel is marked senaite_only instead of being re-POSTed to `gave_up`."""
    from workflow.senaite_tee import run_retries
    row, q = _queued(db_session, "P-RJ-11", "cancel", status="cancelled")
    with patch("workflow.senaite_tee._ar_transition") as tr, \
         patch("workflow.senaite_tee.read_back_state", return_value="to_be_verified"):
        run_retries(db_session, now=T0)
    tr.assert_not_called()
    assert q.status == "senaite_only"


def test_cancel_retry_refused_at_200_is_senaite_only_not_pending(db_session):
    """Still cancellable by state, but SENAITE refuses at 200 (an analysis is
    already assigned) — terminal, and the attempt counter does not advance."""
    from workflow.senaite_tee import run_retries
    row, q = _queued(db_session, "P-RJ-12", "cancel", status="cancelled", attempts=1)
    with patch("workflow.senaite_tee._ar_transition") as tr, \
         patch("workflow.senaite_tee.read_back_state", return_value="sample_received"):
        run_retries(db_session, now=T0)
    tr.assert_called_once_with("U-P-RJ-12", "cancel")
    assert q.status == "senaite_only" and q.attempts == 1


def test_naive_scheduler_clock_is_normalised_to_utc(db_session):
    """main.py builds the scheduler with a naive `datetime.utcnow` clock; the
    retry row's next_attempt_at is TIMESTAMPTZ, so the tee must normalise
    before it compares or writes."""
    from workflow.senaite_tee import _now, run_retries
    naive = datetime(2026, 9, 9, 12, 1)
    assert _now(naive).tzinfo is timezone.utc
    row, q = _queued(db_session, "P-RJ-13", "verify", due=T0)
    with patch("workflow.senaite_tee._ar_transition") as tr, \
         patch("workflow.senaite_tee.read_back_state", return_value="sample_received"):
        stats = run_retries(db_session, now=naive)
    tr.assert_called_once_with("U-P-RJ-13", "verify")
    assert stats["retried"] == 1
    assert q.next_attempt_at.tzinfo is not None


def test_row_for_sample_without_senaite_uid_settles_senaite_only(db_session):
    """Native-born sample (no SENAITE AR): the job must not burn attempts into
    gave_up — nothing can ever complete the row — it settles as senaite_only
    without touching SENAITE."""
    from workflow.senaite_tee import run_retries
    sample, q = _queued(db_session, "S-NOUID", "publish", status="published")  # not superseded
    sample.external_lims_uid = ""
    db_session.flush()
    with patch("workflow.senaite_tee._ar_transition") as tr,          patch("workflow.senaite_tee.read_back_state") as rb:
        run_retries(db_session, now=T0)
    db_session.refresh(q)
    assert q.status == "senaite_only"
    assert "no SENAITE uid" in (q.last_error or "")
    tr.assert_not_called()
    rb.assert_not_called()
