"""Publish route under mk1 authority: native publish verb runs BEFORE the
SENAITE tee, and a refused SENAITE publish becomes a retry row."""
import json
from unittest.mock import patch

from sqlalchemy import select

from models import (
    AnalysisService, LimsAnalysis, LimsSample, LimsSampleTransition,
    LimsSenaiteTeeRetry, Settings,
)


def test_refused_senaite_publish_enqueues_retry(db_session):
    from workflow.catalog import clear_sample_state_cache
    from workflow.seeds import seed_workflow_catalog
    clear_sample_state_cache()
    seed_workflow_catalog(db_session)
    db_session.add(Settings(key="registry_read_source", value=json.dumps({"sample_status": "mk1"})))
    row = LimsSample(sample_id="P-PUB-1", status="verified", native_status="verified",
                     external_lims_uid="U-PUB-1")
    db_session.add(row)
    db_session.flush()
    # Deviation from the brief's verbatim test (see task-9-report.md): the
    # seeded verified->published edge gates on all_analyses_in_state, which
    # fails closed for a sample with zero live parent lines
    # (test_all_analyses_in_state_empty_set_is_unmet, test_workflow_engine.py)
    # — without a satisfying line the native publish can never advance and
    # the row.status assertion below cannot be met. One canonical, verified
    # parent line makes the gate satisfiable, matching how every real sample
    # reaching 'verified' actually looks.
    svc = AnalysisService(title="TEST: publish gate", keyword="TEST-PUB-KW")
    db_session.add(svc)
    db_session.flush()
    db_session.add(LimsAnalysis(lims_sample_pk=row.id, analysis_service_id=svc.id,
                                keyword=svc.keyword, title=svc.title,
                                provenance="canonical", review_state="verified"))
    db_session.flush()
    from workflow.senaite_tee import enqueue_retry
    from main import _after_publish_native   # the helper Task 9 extracts
    with patch("workflow.senaite_tee.read_back_state", return_value="to_be_verified"):
        _after_publish_native(db_session, sample_id="P-PUB-1", pre_publish_status="verified",
                              actor_user_id=1, senaite_actual_state="to_be_verified")
    assert row.status == "published"
    q = db_session.execute(select(LimsSenaiteTeeRetry)).scalar_one()
    assert q.verb == "publish" and q.status == "pending"
    # Single-writer (Item A): the engine (execute_verb) is the ONLY ledger
    # writer under mk1 authority — _after_publish_native must not also call
    # record_sample_transition directly, or this sample would carry two
    # identical publish rows. FAILS before Item A (2 rows), passes after.
    rows = db_session.execute(select(LimsSampleTransition).where(
        LimsSampleTransition.lims_sample_pk == row.id,
        LimsSampleTransition.verb == "publish")).scalars().all()
    assert len(rows) == 1


def test_confirmed_senaite_publish_writes_status_and_no_retry(db_session):
    from workflow.catalog import clear_sample_state_cache
    from workflow.seeds import seed_workflow_catalog
    clear_sample_state_cache()
    seed_workflow_catalog(db_session)
    db_session.add(Settings(key="registry_read_source", value=json.dumps({"sample_status": "mk1"})))
    row = LimsSample(sample_id="P-PUB-2", status="verified", native_status="verified",
                     external_lims_uid="U-PUB-2")
    db_session.add(row)
    db_session.flush()
    # one verified analysis line so the seeded publish edge's all-analyses gate is met
    # (mirrors the setup in test_refused_senaite_publish_enqueues_retry above)
    svc = AnalysisService(title="TEST: publish gate", keyword="TEST-PUB-KW-2")
    db_session.add(svc)
    db_session.flush()
    db_session.add(LimsAnalysis(lims_sample_pk=row.id, analysis_service_id=svc.id,
                                keyword=svc.keyword, title=svc.title,
                                provenance="canonical", review_state="verified"))
    db_session.flush()
    from main import _after_publish_native
    _after_publish_native(db_session, sample_id="P-PUB-2", pre_publish_status="verified",
                          actor_user_id=1, senaite_actual_state="published")
    assert row.status == "published"
    assert db_session.execute(select(LimsSenaiteTeeRetry)).scalars().all() == []
    rows = db_session.execute(select(LimsSampleTransition).where(
        LimsSampleTransition.lims_sample_pk == row.id, LimsSampleTransition.verb == "publish")).scalars().all()
    assert len(rows) == 1 and rows[0].source == "mk1"     # single writer (Item A)
