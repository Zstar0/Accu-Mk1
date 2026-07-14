"""Generic field-update endpoint intercepts Remarks natively (read-flip
spec §6, final-review finding — the receive flow and the lookup were flipped,
but `POST /wizard/senaite/samples/{uid}/update` (`update_senaite_sample_fields`)
was a third, unclosed SENAITE Remarks write path: both `AddRemarkForm`
(SampleDetails.tsx) and `AssignRemarksBlock` (AssignStep.tsx) call
`updateSenaiteSampleFields(uid, { Remarks: trimmed })`, which forwarded
straight to SENAITE — landing somewhere nothing reads post-flip.

Three behaviors:
1. Remarks-only payload → native `lims_sample_remarks` row (content,
   author_user_id = acting user), NO SENAITE HTTP call at all, success.
2. Mixed payload ({"Remarks": ..., "ClientSampleID": ...}) → native row
   written AND the SENAITE call carries ClientSampleID but NOT Remarks.
3. Remarks-only payload for a uid with no registry row → failure response,
   no native row, no SENAITE call (fail closed, same posture as the
   receive-flow's missing-registry-row case).

Mock harness follows test_receive_remarks_native.py's `_client_as_user` /
patch-httpx idioms, simplified for this endpoint's single-POST shape (no
CSRF/GET sequence — `update_senaite_sample_fields` only ever does one
`client.post(update_url, ...)`).

House pattern: TEST-prefixed rows (`TEST-UFI-` sample_ids), FK-safe cleanup
(LimsSampleRemark before LimsSample). `author_user_id=1` matches the
container dev DB's seeded user row (same reason test_receive_remarks_native.py
uses user_id=1 — the FK must resolve or the insert 500s before the SENAITE
call is ever reached).
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

TEST_SAMPLE_ID = "TEST-UFI-SAMPLE"
TEST_UID = "UID-UFI-1"
TEST_MISSING_UID = "UID-UFI-MISSING"


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
            select(LimsSample.id).where(LimsSample.sample_id.like("TEST-UFI-%"))
        )
    ))
    db.execute(delete(LimsSample).where(LimsSample.sample_id.like("TEST-UFI-%")))
    db.commit()


@pytest.fixture
def seed_sample(db):
    row = LimsSample(
        sample_id=TEST_SAMPLE_ID, sample_type="x", status="verified",
        external_lims_uid=TEST_UID,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _mock_update_call(status_code: int = 200):
    """Single-POST mock for update_senaite_sample_fields's httpx shape:
    one `client.post(update_url, json=...)`, no GETs, no CSRF dance."""
    mock_instance = AsyncMock()
    resp = MagicMock()
    resp.status_code = status_code
    resp.raise_for_status = MagicMock()
    mock_instance.post = AsyncMock(return_value=resp)

    p = patch("httpx.AsyncClient")
    cls = p.start()
    cls.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
    cls.return_value.__aexit__ = AsyncMock(return_value=False)
    return p, cls, mock_instance


# ═══════════════════════════════════════════════════════════════════════════
# Final-review fix: Remarks intercept on the generic field-update endpoint
# ═══════════════════════════════════════════════════════════════════════════


def test_remarks_only_writes_native_no_senaite_call(db, seed_sample):
    cls_patcher = patch("httpx.AsyncClient")
    cls = cls_patcher.start()
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _client_as_user(user_id=1).post(
                f"/wizard/senaite/samples/{TEST_UID}/update",
                json={"fields": {"Remarks": "  checked in, seal intact  "}},
            )
    finally:
        cls_patcher.stop()

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True

    # Zero SENAITE HTTP calls: httpx.AsyncClient never even constructed.
    cls.assert_not_called()

    rows = db.query(LimsSampleRemark).filter_by(
        lims_sample_pk=seed_sample.id
    ).all()
    assert len(rows) == 1
    assert rows[0].content == "checked in, seal intact"
    assert rows[0].author_user_id == 1


def test_mixed_payload_writes_native_and_forwards_remaining(db, seed_sample):
    proxy, cls, mock_instance = _mock_update_call()
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _client_as_user(user_id=1).post(
                f"/wizard/senaite/samples/{TEST_UID}/update",
                json={"fields": {"Remarks": "note", "ClientSampleID": "X"}},
            )
    finally:
        proxy.stop()

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True

    rows = db.query(LimsSampleRemark).filter_by(
        lims_sample_pk=seed_sample.id
    ).all()
    assert len(rows) == 1
    assert rows[0].content == "note"
    assert rows[0].author_user_id == 1

    assert mock_instance.post.await_count == 1
    json_body = mock_instance.post.call_args.kwargs.get("json")
    assert json_body == {"ClientSampleID": "X"}
    assert "Remarks" not in json_body


def test_remarks_only_missing_registry_row_fails_closed(db):
    # No seed_sample fixture — deliberately no lims_samples row carries
    # TEST_MISSING_UID.
    cls_patcher = patch("httpx.AsyncClient")
    cls = cls_patcher.start()
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _client_as_user(user_id=1).post(
                f"/wizard/senaite/samples/{TEST_MISSING_UID}/update",
                json={"fields": {"Remarks": "orphaned note"}},
            )
    finally:
        cls_patcher.stop()

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is False
    assert "registry row" in body["message"]

    cls.assert_not_called()

    rows = db.query(LimsSampleRemark).filter_by(content="orphaned note").all()
    assert rows == []
