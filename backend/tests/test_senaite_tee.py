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


def test_repeated_cancel_tee_reuses_the_senaite_only_row(db_session):
    from workflow import senaite_tee as tee
    from models import LimsSenaiteTeeRetry
    row = _sample(db_session, sid="P-TEE-7", uid="U-TEE-7", status="published")
    with patch("workflow.senaite_tee._ar_transition"), \
         patch("workflow.senaite_tee.read_back_state", return_value="published"):
        assert tee.tee_now(db_session, row, "cancel") == "senaite_only"
        assert tee.tee_now(db_session, row, "cancel") == "senaite_only"
    rows = db_session.execute(select(LimsSenaiteTeeRetry)).scalars().all()
    assert len(rows) == 1 and rows[0].status == "senaite_only"


def test_refusal_after_gave_up_revives_the_same_row(db_session):
    from workflow import senaite_tee as tee
    from models import LimsSenaiteTeeRetry
    row = _sample(db_session, sid="P-TEE-8", uid="U-TEE-8", status="verified")
    q = LimsSenaiteTeeRetry(lims_sample_pk=row.id, verb="verify", expected_state="verified",
                            attempts=8, next_attempt_at=datetime.now(timezone.utc), status="gave_up")
    db_session.add(q)
    db_session.flush()
    with patch("workflow.senaite_tee._ar_transition"), \
         patch("workflow.senaite_tee.read_back_state", return_value="to_be_verified"):
        assert tee.tee_now(db_session, row, "verify") == "pending"
    rows = db_session.execute(select(LimsSenaiteTeeRetry)).scalars().all()
    assert len(rows) == 1 and rows[0].id == q.id
    assert rows[0].status == "pending" and rows[0].attempts == 1


def test_already_cancelled_fast_path_resolves_an_earlier_pending_row(db_session):
    from workflow import senaite_tee as tee
    from models import LimsSenaiteTeeRetry
    row = _sample(db_session, sid="P-TEE-9", uid="U-TEE-9", status="cancelled")
    q = LimsSenaiteTeeRetry(lims_sample_pk=row.id, verb="cancel", expected_state="cancelled",
                            attempts=1, next_attempt_at=datetime.now(timezone.utc), status="pending")
    db_session.add(q)
    db_session.flush()
    with patch("workflow.senaite_tee._ar_transition") as tr, \
         patch("workflow.senaite_tee.read_back_state", return_value="cancelled"):
        assert tee.tee_now(db_session, row, "cancel") == "done"
    tr.assert_not_called()
    assert q.status == "done"


def test_tee_now_never_raises_on_bookkeeping_failure(db_session):
    from workflow import senaite_tee as tee
    row = _sample(db_session, sid="P-TEE-10", uid="U-TEE-10", status="verified")
    with patch("workflow.senaite_tee._ar_transition"), \
         patch("workflow.senaite_tee.read_back_state", return_value="sample_received"), \
         patch("workflow.senaite_tee.enqueue_retry", side_effect=RuntimeError("db down")):
        assert tee.tee_now(db_session, row, "verify") == "error"


def test_tee_advances_only_for_senaite_representable_states(db_session):
    from workflow import engine
    from models import LimsWorkflowShadowEvaluation
    row = _sample(db_session, sid="P-TEE-6", uid="U-TEE-6", status="verified")
    fired = [
        LimsWorkflowShadowEvaluation(lims_sample_pk=row.id, trigger="t", verb="submit",
                                     from_status="sample_received", to_status="to_be_verified",
                                     outcome="advanced", requirements_met=True, outcomes=[]),
        LimsWorkflowShadowEvaluation(lims_sample_pk=row.id, trigger="t", verb="verify",
                                     from_status="to_be_verified", to_status="verified",
                                     outcome="advanced", requirements_met=True, outcomes=[]),
    ]
    with patch("workflow.senaite_tee.tee_now") as tn:
        engine.tee_advances(db_session, row, fired)
    tn.assert_called_once_with(db_session, row, "verify")


def test_cancel_refused_at_200_is_senaite_only_not_a_retry(db_session):
    """SENAITE's guard_cancel allows cancel only while every analysis is
    unassigned/registered, so a `sample_received` AR whose vials are already
    on a worksheet answers 200 and stays put. Mk1 has cancelled its own rows
    already and no retry changes SENAITE's analysis states — the row is a
    documented senaite_only divergence, never a pending retry."""
    from workflow import senaite_tee as tee
    from models import LimsSenaiteTeeRetry
    row = _sample(db_session, sid="P-TEE-11", uid="U-TEE-11", status="cancelled")
    with patch("workflow.senaite_tee._ar_transition") as tr, \
         patch("workflow.senaite_tee.read_back_state", return_value="sample_received"):
        assert tee.tee_now(db_session, row, "cancel") == "senaite_only"
    tr.assert_called_once_with("U-TEE-11", "cancel")
    q = db_session.execute(select(LimsSenaiteTeeRetry)).scalar_one()
    assert (q.verb, q.status, q.attempts) == ("cancel", "senaite_only", 0)
    assert "sample_received" in (q.last_error or "")


def test_cancel_from_to_be_verified_is_senaite_only_without_posting(db_session):
    """`to_be_verified` has no `cancel` exit in senaite_sample_workflow at all
    — don't even spend the POST."""
    from workflow import senaite_tee as tee
    from models import LimsSenaiteTeeRetry
    row = _sample(db_session, sid="P-TEE-12", uid="U-TEE-12", status="cancelled")
    with patch("workflow.senaite_tee._ar_transition") as tr, \
         patch("workflow.senaite_tee.read_back_state", return_value="to_be_verified"):
        assert tee.tee_now(db_session, row, "cancel") == "senaite_only"
    tr.assert_not_called()
    q = db_session.execute(select(LimsSenaiteTeeRetry)).scalar_one()
    assert (q.verb, q.status) == ("cancel", "senaite_only")


def test_cancel_transport_error_is_senaite_only_never_pending(db_session):
    """Mk1 OWNS cancel (Handler ruling 2026-09-09): once Accu-Mk1 has
    cancelled the sample, SENAITE is not kept in sync. A transport failure is
    therefore terminal like a guard refusal -- recorded as senaite_only, never
    a pending retry that could age into a false `senaite_tee_gave_up`
    stranding for a cancellation the lab made on purpose."""
    from workflow import senaite_tee as tee
    from models import LimsSenaiteTeeRetry
    row = _sample(db_session, sid="P-TEE-13", uid="U-TEE-13", status="cancelled")
    with patch("workflow.senaite_tee._ar_transition", side_effect=ConnectionError("down")), \
         patch("workflow.senaite_tee.read_back_state", return_value="sample_received"):
        assert tee.tee_now(db_session, row, "cancel") == "senaite_only"
    q = db_session.execute(select(LimsSenaiteTeeRetry)).scalar_one()
    assert q.status == "senaite_only" and "ConnectionError" in (q.last_error or "")
    assert q.attempts == 0            # nothing queued, nothing to age


def test_verify_transport_error_still_retries(db_session):
    """The cancel rule is cancel-only: verify/publish still queue a retry on a
    transport failure (the tee is how SENAITE catches up for those verbs)."""
    from workflow import senaite_tee as tee
    from models import LimsSenaiteTeeRetry
    row = _sample(db_session, sid="P-TEE-14", uid="U-TEE-14", status="verified")
    with patch("workflow.senaite_tee._ar_transition", side_effect=ConnectionError("down")), \
         patch("workflow.senaite_tee.read_back_state", return_value="to_be_verified"):
        assert tee.tee_now(db_session, row, "verify") == "pending"
    q = db_session.execute(select(LimsSenaiteTeeRetry)).scalar_one()
    assert (q.verb, q.status) == ("verify", "pending")
