"""Publish route under mk1 authority: native publish verb runs BEFORE the
SENAITE tee, and a refused SENAITE publish becomes a retry row."""
import json
from unittest.mock import patch

import pytest

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


# ── Route-level: the native publish must run on EVERY SENAITE outcome ────────
# Item 3 (final review): _after_publish_native used to sit INSIDE the
# `if senaite_uid:` try, after the silent-refusal 502 and inside the
# transport-error 502 — so on either error path the COA went live on
# IS/WordPress with no native verb, no ledger row and no retry row, and the
# stranded detector could not see it. The route is driven directly (not
# through TestClient) so the request session stays this test's sqlite one;
# `run_in_threadpool` is patched to run inline for the same reason — a real
# threadpool hands a `:memory:` engine a different connection.


class _Resp:
    def __init__(self, payload=None, status_code=200):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = ""

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


def _client_factory(*, uid, transition_state="", transition_error=None):
    """httpx.AsyncClient stand-in, routing by URL: IS publish-coa, SENAITE
    search (uid resolve), SENAITE update (transition) and the AR re-read."""
    class _Client:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, **kw):
            if "/search" in url:
                return _Resp({"items": [{"uid": uid}]})
            return _Resp({"items": [{"review_state": transition_state}]})

        async def post(self, url, **kw):
            if "publish-coa" in url:
                # verification_code None keeps the VerificationCode POST and
                # its registry mirror out of the picture entirely.
                return _Resp({"success": True, "message": "COA published",
                              "verification_code": None})
            if transition_error is not None:
                raise transition_error
            return _Resp({"items": [{"review_state": transition_state}]})

    return _Client


def _publishable_sample(db, sid, uid, kw):
    from workflow.catalog import clear_sample_state_cache
    from workflow.seeds import seed_workflow_catalog
    clear_sample_state_cache()
    seed_workflow_catalog(db)
    db.add(Settings(key="registry_read_source", value=json.dumps({"sample_status": "mk1"})))
    row = LimsSample(sample_id=sid, status="verified", native_status="verified",
                     external_lims_uid=uid)
    db.add(row)
    db.flush()
    # one verified canonical line so the seeded publish edge's all-analyses
    # gate is satisfiable (same rationale as the two helper tests above)
    svc = AnalysisService(title="TEST: publish gate", keyword=kw)
    db.add(svc)
    db.flush()
    db.add(LimsAnalysis(lims_sample_pk=row.id, analysis_service_id=svc.id,
                        keyword=svc.keyword, title=svc.title,
                        provenance="canonical", review_state="verified"))
    db.flush()
    return row


def _run_publish(db, sample_id, client_cls, senaite_url="http://senaite.test"):
    import asyncio
    from types import SimpleNamespace
    import main

    async def _inline(fn, *a, **kw):
        return fn(*a, **kw)

    with patch("main.SENAITE_URL", senaite_url), \
         patch("main._get_senaite_auth", return_value=None), \
         patch("httpx.AsyncClient", client_cls), \
         patch("fastapi.concurrency.run_in_threadpool", new=_inline), \
         patch("workflow.senaite_tee.read_back_state", return_value="to_be_verified"):
        return asyncio.run(main.publish_sample_coa(
            sample_id, current_user=SimpleNamespace(id=1), db=db))


def _assert_native_publish_landed(db, row):
    ledger = db.execute(select(LimsSampleTransition).where(
        LimsSampleTransition.lims_sample_pk == row.id,
        LimsSampleTransition.verb == "publish")).scalars().all()
    assert len(ledger) == 1
    assert row.status == "published"
    q = db.execute(select(LimsSenaiteTeeRetry)).scalar_one()
    assert (q.verb, q.status) == ("publish", "pending")


def test_publish_route_transport_error_still_runs_the_native_publish(db_session):
    """SENAITE times out on the transition POST: the user still gets the 502
    (byte-identical detail), but the native publish + retry row are committed
    first, so the sample is not silently stranded."""
    from fastapi import HTTPException
    row = _publishable_sample(db_session, "P-PUB-3", "U-PUB-3", "TEST-PUB-KW-3")
    cls = _client_factory(uid="U-PUB-3", transition_error=ConnectionError("timed out"))
    with pytest.raises(HTTPException) as exc:
        _run_publish(db_session, "P-PUB-3", cls)
    assert exc.value.status_code == 502
    assert exc.value.detail.startswith("COA published in system but SENAITE transition failed:")
    _assert_native_publish_landed(db_session, row)


def test_publish_route_silent_refusal_still_runs_the_native_publish(db_session):
    """Silent refusal: SENAITE answers 200 and the AR re-reads as `verified`
    (an unaccepted, non-pre-publish state), so the route raises its 502 — but
    only after the native publish and the retry row landed.

    NOTE the review's `to_be_verified` example is NOT this path: that state is
    in `accepted_states` (the documented partial-publish flow) and returns
    success, so it can never produce the 502 this test pins.
    """
    from fastapi import HTTPException
    row = _publishable_sample(db_session, "P-PUB-4", "U-PUB-4", "TEST-PUB-KW-4")
    cls = _client_factory(uid="U-PUB-4", transition_state="verified")
    with pytest.raises(HTTPException) as exc:
        _run_publish(db_session, "P-PUB-4", cls)
    assert exc.value.status_code == 502
    assert "silently rejected the 'publish' transition" in exc.value.detail
    _assert_native_publish_landed(db_session, row)


def test_publish_route_without_a_senaite_uid_still_runs_the_native_publish(db_session):
    """No SENAITE row at all (SENAITE_URL unset): the whole `if senaite_uid:`
    block is skipped, the user gets the normal success body — and the native
    publish still runs, with an empty read-back state, so the tee's publish
    retry row is minted rather than the sample silently going unrecorded."""
    row = _publishable_sample(db_session, "P-PUB-5", "U-PUB-5", "TEST-PUB-KW-5")
    resp = _run_publish(db_session, "P-PUB-5", _client_factory(uid=""), senaite_url="")
    assert resp.success is True and resp.warning is None
    _assert_native_publish_landed(db_session, row)
