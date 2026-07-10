"""Tests for Task 4: threadpool wrapper + hook A1 (set_analysis_result).

Hooks the parent-analysis SENAITE->Mk1 shadow mirror into
POST /wizard/senaite/analyses/{uid}/result. The endpoint is `async def`,
takes NO `db` dependency, and calls SENAITE via httpx inside its own
`async with httpx.AsyncClient(...)`. The hook fires AFTER
`resp.raise_for_status()` using only the response's `items[0]` + `req.result`,
via `await run_in_threadpool(_mirror_parent_analysis_bg, ...)` — the wrapper
opens its own SessionLocal(), commits, and swallows every exception so a
mirror failure can never fail or delay-fail the user's edit.

House pattern: TestClient(main.app) with get_current_user overridden (see
test_box_label_summaries_batch.py) + httpx.AsyncClient mocked via
patch("httpx.AsyncClient") + __aenter__/__aexit__ (see
test_native_manage_analyses.py). DB-side assertions use a live SessionLocal()
exactly like test_parent_mirror_helper.py (TEST-prefixed LimsSample + a real
seeded AnalysisService keyword + FK-safe cleanup).
"""
from __future__ import annotations

import logging
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

import main
from auth import get_current_user
from database import SessionLocal
from models import AnalysisService, LimsAnalysis, LimsAnalysisTransition, LimsSample

TEST_SAMPLE_ID = "TEST-PM4-PARENT"


def _client() -> TestClient:
    main.app.dependency_overrides.clear()
    main.app.dependency_overrides[get_current_user] = (
        lambda: {"email": "a@x", "role": "standard"})
    return TestClient(main.app)


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def analysis_service(db):
    """Pick any seeded analysis_service with a non-null keyword."""
    svc = db.execute(
        select(AnalysisService).where(AnalysisService.keyword.isnot(None))
    ).scalars().first()
    if svc is None:
        pytest.skip("no analysis_services row available")
    return svc


@pytest.fixture
def seed_parent_and_service(db, analysis_service):
    """A fresh TEST-prefixed parent LimsSample + an existing seeded service."""
    parent = LimsSample(sample_id=TEST_SAMPLE_ID, sample_type="x", status="received")
    db.add(parent)
    db.commit()
    db.refresh(parent)
    return parent, analysis_service


@pytest.fixture(autouse=True)
def cleanup(db):
    yield
    db.rollback()
    db.execute(delete(LimsAnalysisTransition).where(
        LimsAnalysisTransition.analysis_id.in_(
            select(LimsAnalysis.id).where(
                LimsAnalysis.lims_sample_pk.in_(
                    select(LimsSample.id).where(LimsSample.sample_id == TEST_SAMPLE_ID)
                )
            )
        )
    ))
    db.execute(delete(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk.in_(
            select(LimsSample.id).where(LimsSample.sample_id == TEST_SAMPLE_ID)
        )
    ))
    db.execute(delete(LimsSample).where(LimsSample.sample_id == TEST_SAMPLE_ID))
    db.commit()


def _mock_senaite_update(*, review_state, keyword, get_request_id):
    """Patch httpx.AsyncClient so set_analysis_result's POST to SENAITE's
    /update/{uid} returns items[0] echoing review_state/Keyword/getRequestID.
    Caller must .stop() the returned patcher."""
    mock_instance = AsyncMock()
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json = MagicMock(return_value={
        "items": [{
            "review_state": review_state,
            "Keyword": keyword,
            "getRequestID": get_request_id,
        }]
    })
    mock_instance.post = AsyncMock(return_value=mock_resp)
    p = patch("httpx.AsyncClient")
    cls = p.start()
    cls.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
    cls.return_value.__aexit__ = AsyncMock(return_value=False)
    return p


def test_set_result_writes_shadow_row(db, seed_parent_and_service):
    parent, svc = seed_parent_and_service
    proxy = _mock_senaite_update(
        review_state="to_be_verified", keyword=svc.keyword,
        get_request_id=parent.sample_id,
    )
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _client().post(
                "/wizard/senaite/analyses/UID-123/result", json={"result": "42%"}
            )
    finally:
        proxy.stop()

    assert r.status_code == 200
    body = r.json()
    assert body["success"] is True

    row = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, provenance="shadow"
    ).one()
    assert row.result_value == "42%"
    assert row.mirror_review_state == "to_be_verified"


def test_mirror_failure_never_fails_the_response(caplog):
    """The never-fails contract: mirror_parent_analysis raising must not
    change the endpoint's success response, and must log a warning."""
    proxy = _mock_senaite_update(
        review_state="to_be_verified", keyword="ANY-KW",
        get_request_id="P-DOESNT-MATTER",
    )
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"), \
             patch("lims_analyses.parent_mirror.mirror_parent_analysis",
                   side_effect=RuntimeError("boom")), \
             caplog.at_level(logging.WARNING):
            r = _client().post(
                "/wizard/senaite/analyses/UID-999/result", json={"result": "1"}
            )
    finally:
        proxy.stop()

    assert r.status_code == 200
    body = r.json()
    assert body["success"] is True
    assert body["message"] == "Result updated"
    assert any("registry.analysis_mirror_failed" in rec.message for rec in caplog.records)


def test_missing_request_id_skips_mirror_silently(db):
    """No getRequestID/RequestID in the SENAITE response item -> the hook is
    a no-op (per brief: skip silently, no extra SENAITE fetch). Response is
    unaffected either way."""
    proxy = _mock_senaite_update(
        review_state="to_be_verified", keyword="ANY-KW", get_request_id=None,
    )
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _client().post(
                "/wizard/senaite/analyses/UID-777/result", json={"result": "1"}
            )
    finally:
        proxy.stop()

    assert r.status_code == 200
    assert r.json()["success"] is True
