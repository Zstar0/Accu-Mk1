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
