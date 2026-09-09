# backend/tests/test_workflow_status_write.py
"""mk1 authority: execute_verb writes lims_samples.status + a source='mk1'
ledger row. senaite authority: status untouched (today)."""
import json

from sqlalchemy import select

from models import LimsSample, LimsSampleTransition, Settings


def _seeded(db, authority):
    from workflow.catalog import clear_sample_state_cache
    from workflow.seeds import seed_workflow_catalog
    clear_sample_state_cache()
    seed_workflow_catalog(db)
    db.add(Settings(key="registry_read_source",
                    value=json.dumps({"sample_status": authority})))
    row = LimsSample(sample_id="P-SW-1", status="sample_due", native_status="sample_due")
    db.add(row)
    db.flush()
    return row


def test_mk1_mode_writes_status_and_ledger(db_session):
    from workflow.engine import execute_verb
    row = _seeded(db_session, "mk1")
    ev = execute_verb(db_session, row, "receive", trigger="receive", actor_user_id=7)
    assert ev.outcome == "advanced"
    assert row.native_status == "sample_received"
    assert row.status == "sample_received"
    t = db_session.execute(select(LimsSampleTransition).where(
        LimsSampleTransition.lims_sample_pk == row.id)).scalars().all()
    assert [(x.source, x.verb, x.from_status, x.to_status, x.actor_user_id) for x in t] == [
        ("mk1", "receive", "sample_due", "sample_received", 7)]


def test_senaite_mode_leaves_status_alone(db_session):
    from workflow.engine import execute_verb
    row = _seeded(db_session, "senaite")
    ev = execute_verb(db_session, row, "receive", trigger="receive")
    assert ev.outcome == "advanced"
    assert row.native_status == "sample_received"
    assert row.status == "sample_due"
    assert db_session.execute(select(LimsSampleTransition)).scalars().all() == []


def test_refusal_never_writes_status(db_session):
    from workflow.engine import execute_verb
    row = _seeded(db_session, "mk1")
    ev = execute_verb(db_session, row, "publish", trigger="publish")   # no edge from sample_due
    assert ev.outcome == "no_edge"
    assert row.status == "sample_due"


def test_ledger_from_status_is_the_engine_pre_advance_state_even_if_status_was_healed_first(db_session):
    """Receive path: the heal writes status before the engine runs. The ledger
    row must still say sample_due -> sample_received (the engine's own frm),
    not sample_received -> sample_received."""
    from workflow.engine import execute_verb
    row = _seeded(db_session, "mk1")            # status = native_status = sample_due
    row.status = "sample_received"              # the heal already ran
    db_session.flush()
    ev = execute_verb(db_session, row, "receive", trigger="receive", actor_user_id=7)
    assert ev.outcome == "advanced"
    t = db_session.execute(select(LimsSampleTransition).where(
        LimsSampleTransition.lims_sample_pk == row.id)).scalar_one()
    assert (t.from_status, t.to_status, t.source) == ("sample_due", "sample_received", "mk1")
    assert row.status == "sample_received" and row.native_status == "sample_received"
