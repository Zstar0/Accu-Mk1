"""Publish route skips the SENAITE AR search for native-born samples (HPLC
native slice 4 / M6, Task 5).

Fixture and route-driving idiom copied from test_publish_route_authority.py
(the in-process idiom, not TestClient, so the request session stays this
test's sqlite `db_session` — a real threadpool/TestClient hands a `:memory:`
engine a different connection).
"""
import json
from unittest.mock import patch

import pytest
from sqlalchemy import select

from models import AnalysisService, LimsAnalysis, LimsSample, LimsSampleTransition


class _Resp:
    def __init__(self, payload=None, status_code=200):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = ""

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


def _asserting_client_cls():
    """httpx.AsyncClient stand-in: the IS publish-coa POST succeeds; ANY
    SENAITE call (the search GET to resolve senaite_uid, or any SENAITE
    update POST) fails the test — a native-born sample has no SENAITE AR
    and must never touch it."""

    class _Client:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, **kw):
            raise AssertionError(f"SENAITE called (GET {url}) for a native-born sample")

        async def post(self, url, **kw):
            if "publish-coa" in url:
                return _Resp({"success": True, "message": "COA published",
                              "verification_code": None})
            raise AssertionError(f"SENAITE called (POST {url}) for a native-born sample")

    return _Client


def _native_publishable_sample(db, sid, kw):
    from workflow.catalog import clear_sample_state_cache
    from workflow.seeds import seed_workflow_catalog
    from models import Settings

    clear_sample_state_cache()
    seed_workflow_catalog(db)
    db.add(Settings(key="registry_read_source", value=json.dumps({"sample_status": "mk1"})))
    row = LimsSample(sample_id=sid, status="verified", native_status="verified",
                      external_lims_system="mk1", external_lims_uid=None)
    db.add(row)
    db.flush()
    # one verified canonical line so the seeded publish edge's all-analyses
    # gate is satisfiable (mirrors test_publish_route_authority.py)
    svc = AnalysisService(title="TEST: native publish gate", keyword=kw)
    db.add(svc)
    db.flush()
    db.add(LimsAnalysis(lims_sample_pk=row.id, analysis_service_id=svc.id,
                         keyword=svc.keyword, title=svc.title,
                         provenance="canonical", review_state="verified"))
    db.flush()
    return row


def _run_publish(db, sample_id, client_cls):
    import asyncio
    from types import SimpleNamespace
    import main

    async def _inline(fn, *a, **kw):
        return fn(*a, **kw)

    # SENAITE_URL deliberately non-empty: proves the search is skipped
    # because of the native-born gate, not because SENAITE_URL is falsy
    # (that path is already covered by
    # test_publish_route_without_a_senaite_uid_still_runs_the_native_publish).
    with patch("main.SENAITE_URL", "http://senaite.invalid"), \
         patch("main._get_senaite_auth", return_value=None), \
         patch("httpx.AsyncClient", client_cls), \
         patch("fastapi.concurrency.run_in_threadpool", new=_inline):
        return asyncio.run(main.publish_sample_coa(
            sample_id, current_user=SimpleNamespace(id=1), db=db))


def test_publish_native_born_never_searches_senaite(db_session):
    row = _native_publishable_sample(db_session, "P-1501", "TEST-NATIVE-PUB-KW")
    resp = _run_publish(db_session, "P-1501", _asserting_client_cls())
    assert resp.success is True
    ledger = db_session.execute(select(LimsSampleTransition).where(
        LimsSampleTransition.lims_sample_pk == row.id,
        LimsSampleTransition.verb == "publish")).scalars().all()
    assert len(ledger) == 1
    assert row.status == "published"
