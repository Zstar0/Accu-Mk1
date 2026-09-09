"""SENAITE tee: AR-level transition + read-back; refusals become retry rows."""
from datetime import datetime, timezone

from sqlalchemy import select

from models import LimsSample


def test_retry_row_roundtrip(db_session):
    from models import LimsSenaiteTeeRetry
    row = LimsSample(sample_id="P-TEE-0", status="verified", external_lims_uid="U-TEE-0")
    db_session.add(row)
    db_session.flush()
    r = LimsSenaiteTeeRetry(lims_sample_pk=row.id, verb="publish", expected_state="published",
                            next_attempt_at=datetime.now(timezone.utc))
    db_session.add(r)
    db_session.flush()
    got = db_session.execute(select(LimsSenaiteTeeRetry)).scalar_one()
    assert (got.status, got.attempts, got.verb) == ("pending", 0, "publish")


from unittest.mock import patch


def _sample(db, sid="P-TEE-1", status="verified", uid="U-TEE-1"):
    row = LimsSample(sample_id=sid, status=status, external_lims_uid=uid)
    db.add(row)
    db.flush()
    return row


def test_tee_done_when_read_back_matches(db_session):
    from workflow import senaite_tee as tee
    from models import LimsSenaiteTeeRetry
    row = _sample(db_session)
    with patch("workflow.senaite_tee._ar_transition") as tr, \
         patch("workflow.senaite_tee.read_back_state", return_value="published"):
        assert tee.tee_now(db_session, row, "publish") == "done"
    tr.assert_called_once_with("U-TEE-1", "publish")
    assert db_session.execute(select(LimsSenaiteTeeRetry)).scalars().all() == []


def test_tee_enqueues_on_silent_refusal(db_session):
    from workflow import senaite_tee as tee
    from models import LimsSenaiteTeeRetry
    row = _sample(db_session, sid="P-TEE-2", uid="U-TEE-2")
    with patch("workflow.senaite_tee._ar_transition"), \
         patch("workflow.senaite_tee.read_back_state", return_value="to_be_verified"):
        assert tee.tee_now(db_session, row, "publish") == "pending"
    q = db_session.execute(select(LimsSenaiteTeeRetry)).scalar_one()
    assert (q.verb, q.expected_state, q.status, q.attempts) == ("publish", "published", "pending", 1)
    assert "to_be_verified" in (q.last_error or "")
    # a second refusal does not mint a second pending row
    with patch("workflow.senaite_tee._ar_transition"), \
         patch("workflow.senaite_tee.read_back_state", return_value="to_be_verified"):
        tee.tee_now(db_session, row, "publish")
    assert len(db_session.execute(select(LimsSenaiteTeeRetry)).scalars().all()) == 1


def test_tee_enqueues_on_transport_error(db_session):
    from workflow import senaite_tee as tee
    from models import LimsSenaiteTeeRetry
    row = _sample(db_session, sid="P-TEE-3", uid="U-TEE-3")
    with patch("workflow.senaite_tee._ar_transition", side_effect=RuntimeError("boom")):
        assert tee.tee_now(db_session, row, "verify") == "pending"
    q = db_session.execute(select(LimsSenaiteTeeRetry)).scalar_one()
    assert q.verb == "verify" and "boom" in q.last_error


def test_cancel_after_verification_is_senaite_only(db_session):
    from workflow import senaite_tee as tee
    from models import LimsSenaiteTeeRetry
    row = _sample(db_session, sid="P-TEE-4", uid="U-TEE-4")
    with patch("workflow.senaite_tee._ar_transition") as tr, \
         patch("workflow.senaite_tee.read_back_state", return_value="published"):
        assert tee.tee_now(db_session, row, "cancel") == "senaite_only"
    tr.assert_not_called()
    q = db_session.execute(select(LimsSenaiteTeeRetry)).scalar_one()
    assert q.status == "senaite_only" and q.verb == "cancel"


def test_no_uid_is_skipped(db_session):
    from workflow import senaite_tee as tee
    row = _sample(db_session, sid="P-TEE-5", uid=None)
    assert tee.tee_now(db_session, row, "verify") == "skipped"
