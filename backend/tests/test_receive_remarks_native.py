"""Receive-flow remarks go native (read-flip spec §6).

Three behaviors:
1. remarks in the receive request → lims_sample_remarks row with the acting
   user's id; NO SENAITE update/{uid} call carrying "Remarks".
2. no remarks → no row, no SENAITE Remarks call (unchanged behavior).
3. no registry row for the sample id → receive fails with the same response
   shape the SENAITE-write failure used to produce (hard step preserved).

Mock harness is copied (not imported) from test_sample_transition_log.py's
`_mock_receive_flow` / `_client_as_user` — same endpoint, same SENAITE HTTP
mock sequence. The one adaptation: this copy also returns the mock
AsyncClient instance so tests can inspect every recorded POST's JSON body
(needed to prove no call carried a "Remarks" key — the shared harness only
returns the patcher, which isn't enough for that assertion).

House pattern: TEST-prefixed rows (`TEST-RRN-` sample_ids), FK-safe cleanup
(LimsSampleRemark before LimsSample).
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

import main
from auth import get_current_user
from database import SessionLocal
from models import LimsSample, LimsSampleRemark

TEST_SAMPLE_ID = "TEST-RRN-SAMPLE"
TEST_MISSING_SAMPLE_ID = "TEST-RRN-MISSING"


# ── fixtures ─────────────────────────────────────────────────────────────

def _client_as_user(user_id: int = 1) -> TestClient:
    main.app.dependency_overrides.clear()
    main.app.dependency_overrides[get_current_user] = (
        lambda: MagicMock(id=user_id, email="a@x", role="standard"))
    return TestClient(main.app)


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.rollback()
    s.close()


@pytest.fixture(autouse=True)
def cleanup(db):
    yield
    db.rollback()
    db.execute(delete(LimsSampleRemark).where(
        LimsSampleRemark.lims_sample_pk.in_(
            select(LimsSample.id).where(LimsSample.sample_id.like("TEST-RRN-%"))
        )
    ))
    db.execute(delete(LimsSample).where(LimsSample.sample_id.like("TEST-RRN-%")))
    db.commit()


@pytest.fixture
def seed_sample(db):
    row = LimsSample(sample_id=TEST_SAMPLE_ID, sample_type="x", status="verified")
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _mock_receive_flow(*, initial_state="sample_due", final_state="sample_received",
                       wf_post_status=200):
    """Copied from test_sample_transition_log.py's `_mock_receive_flow`
    (sequenced GETs matching receive_senaite_sample's exact call order: sample
    lookup, CSRF page fetch, CSRF re-fetch before the workflow POST,
    post-transition verify re-read; one POST for the workflow transition).

    Adaptation: returns `(patcher, mock_instance)` instead of just the
    patcher, so callers can inspect `mock_instance.post.call_args_list` —
    needed to assert no POST body carried a "Remarks" key.
    """
    mock_instance = AsyncMock()

    sample_resp = MagicMock()
    sample_resp.json = MagicMock(return_value={
        "count": 1,
        "items": [{"review_state": initial_state, "path": "/senaite/samples/ar-1"}],
    })

    page_resp = MagicMock()
    page_resp.text = '<input name="_authenticator" value="AUTH1"/>'

    page_resp2 = MagicMock()
    page_resp2.text = '<input name="_authenticator" value="AUTH2"/>'

    verify_resp = MagicMock()
    verify_resp.json = MagicMock(return_value={
        "count": 1,
        "items": [{"review_state": final_state}],
    })

    mock_instance.get = AsyncMock(
        side_effect=[sample_resp, page_resp, page_resp2, verify_resp]
    )

    wf_resp = MagicMock()
    wf_resp.status_code = wf_post_status
    mock_instance.post = AsyncMock(return_value=wf_resp)

    p = patch("httpx.AsyncClient")
    cls = p.start()
    cls.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
    cls.return_value.__aexit__ = AsyncMock(return_value=False)
    return p, mock_instance


# ═══════════════════════════════════════════════════════════════════════════
# Task 2: native remark write on receive
# ═══════════════════════════════════════════════════════════════════════════


def test_receive_writes_native_remark_row(db, seed_sample):
    proxy, mock_instance = _mock_receive_flow()
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _client_as_user(user_id=1).post(
                "/wizard/senaite/receive-sample",
                json={
                    "sample_uid": "UID-RRN-1",
                    "sample_id": seed_sample.sample_id,
                    "remarks": "checked in, seal intact",
                },
            )
    finally:
        proxy.stop()

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True
    assert "remarks_added" in body["senaite_response"]["steps_done"]

    rows = db.query(LimsSampleRemark).filter_by(
        lims_sample_pk=seed_sample.id
    ).all()
    assert len(rows) == 1
    assert rows[0].content == "checked in, seal intact"
    assert rows[0].author_user_id == 1
    assert rows[0].author_label is None

    for call in mock_instance.post.call_args_list:
        json_body = call.kwargs.get("json")
        assert not (isinstance(json_body, dict) and "Remarks" in json_body), (
            f"SENAITE POST carried a Remarks key: {call}"
        )


def test_receive_without_remarks_writes_nothing(db, seed_sample):
    proxy, mock_instance = _mock_receive_flow()
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _client_as_user(user_id=1).post(
                "/wizard/senaite/receive-sample",
                json={
                    "sample_uid": "UID-RRN-2",
                    "sample_id": seed_sample.sample_id,
                    "remarks": None,
                },
            )
    finally:
        proxy.stop()

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True
    assert "remarks_added" not in body["senaite_response"]["steps_done"]

    rows = db.query(LimsSampleRemark).filter_by(
        lims_sample_pk=seed_sample.id
    ).all()
    assert rows == []

    for call in mock_instance.post.call_args_list:
        json_body = call.kwargs.get("json")
        assert not (isinstance(json_body, dict) and "Remarks" in json_body)


def test_receive_remarks_fails_closed_without_registry_row(db):
    # No seed_sample fixture used here — deliberately no lims_samples row for
    # TEST_MISSING_SAMPLE_ID.
    proxy, mock_instance = _mock_receive_flow()
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _client_as_user(user_id=1).post(
                "/wizard/senaite/receive-sample",
                json={
                    "sample_uid": "UID-RRN-3",
                    "sample_id": TEST_MISSING_SAMPLE_ID,
                    "remarks": "checked in, seal intact",
                },
            )
    finally:
        proxy.stop()

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is False
    assert "registry row" in body["message"]

    rows = db.query(LimsSampleRemark).join(
        LimsSample, LimsSampleRemark.lims_sample_pk == LimsSample.id
    ).filter(LimsSample.sample_id == TEST_MISSING_SAMPLE_ID).all()
    assert rows == []
