"""A stopped cascade records WHY (spec §6.1); nothing-to-fire records nothing."""
from sqlalchemy import select

from models import LimsSample, LimsWorkflowShadowEvaluation


def _seeded(db):
    from workflow.catalog import clear_sample_state_cache
    from workflow.seeds import seed_workflow_catalog
    clear_sample_state_cache()
    seed_workflow_catalog(db)


def _evals(db, row):
    return db.execute(select(LimsWorkflowShadowEvaluation).where(
        LimsWorkflowShadowEvaluation.lims_sample_pk == row.id
    ).order_by(LimsWorkflowShadowEvaluation.id)).scalars().all()


def test_unmet_auto_fire_edge_records_one_refusal(db_session):
    from workflow.engine import evaluate_cascades
    _seeded(db_session)
    # sample_received -> to_be_verified is auto_fire with an all_analyses_in_state
    # requirement; a sample with NO analyses cannot meet it.
    row = LimsSample(sample_id="P-CR-1", status="sample_received", native_status="sample_received")
    db_session.add(row)
    db_session.flush()
    fired = evaluate_cascades(db_session, row, trigger="test")
    assert fired == []
    evs = _evals(db_session, row)
    assert len(evs) == 1
    assert evs[0].outcome == "requirements_unmet" and evs[0].verb == "submit"
    assert evs[0].from_status == "sample_received" and evs[0].to_status == "sample_received"
    assert evs[0].outcomes  # the requirement outcomes travel with the row
    # identical second run dedups (existing _record rule)
    evaluate_cascades(db_session, row, trigger="test")
    assert len(_evals(db_session, row)) == 1


def test_nothing_to_fire_records_nothing(db_session):
    from workflow.engine import evaluate_cascades
    _seeded(db_session)
    row = LimsSample(sample_id="P-CR-2", status="published", native_status="published")
    db_session.add(row)
    db_session.flush()
    assert evaluate_cascades(db_session, row, trigger="test") == []
    assert _evals(db_session, row) == []
