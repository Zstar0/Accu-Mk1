"""support_plain.audit: one row per attempt, no message text, duplicate window."""
from datetime import datetime, timedelta, timezone

from models import SupportAction
from support_plain import audit


def _rec(db, body="hello", outcome="ok", action="reply"):
    return audit.record(db, user_id=7, plain_user_id="u_1", customer_key="wc:1", thread_id="th_1", action=action,
                        args={"status": "done"}, body=body, outcome=outcome)


def test_record_stores_hash_and_length_never_text(db_session):
    row = _rec(db_session, body="secret words")
    assert row.body_sha256 == audit.body_hash("secret words") and row.body_len == 12
    assert "secret" not in repr({c.name: getattr(row, c.name) for c in SupportAction.__table__.columns})


def test_non_text_action_has_null_body_fields(db_session):
    row = _rec(db_session, body=None, action="status")
    assert row.body_sha256 is None and row.body_len is None and row.args == {"status": "done"}


def test_duplicate_within_window_only_for_sent_rows(db_session):
    assert not audit.is_duplicate(db_session, user_id=7, thread_id="th_1", action="reply", body="hello")
    _rec(db_session, outcome="error")
    assert not audit.is_duplicate(db_session, user_id=7, thread_id="th_1", action="reply", body="hello")
    _rec(db_session)
    assert audit.is_duplicate(db_session, user_id=7, thread_id="th_1", action="reply", body="hello")
    assert not audit.is_duplicate(db_session, user_id=7, thread_id="th_1", action="note", body="hello")
    assert not audit.is_duplicate(db_session, user_id=8, thread_id="th_1", action="reply", body="hello")
    later = datetime.now(timezone.utc) + timedelta(seconds=61)
    assert not audit.is_duplicate(db_session, user_id=7, thread_id="th_1", action="reply", body="hello", now=later)


def test_confirmed_after_timeout_counts_as_sent(db_session):
    _rec(db_session, outcome="confirmed_after_timeout")
    assert audit.is_duplicate(db_session, user_id=7, thread_id="th_1", action="reply", body="hello")
