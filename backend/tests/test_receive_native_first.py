"""Receive flow is native-first (SENAITE-disconnect: receive-page flip).

Check-in must succeed on the native writes alone — photo capture, remark row,
status transition + date_received — with the SENAITE receive demoted to a
best-effort tee: its failure warns instead of failing, a native-born parent
(mk1:// uid) skips it entirely, and SENAITE_URL=None no longer blocks
check-in. Photo capture is now a HARD native step (the wizard requires a
photo; losing it silently would defeat the point), so a storage failure
fails the check-in atomically — no half-received sample.

Harness copied from test_receive_remarks_native.py (live-DB TestClient,
sequenced SENAITE httpx mock, fake photo storage; TEST-prefixed rows with
FK-safe cleanup).
"""
from __future__ import annotations

import base64
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

import main
from auth import get_current_user
from database import SessionLocal
from models import (
    LimsParentAttachment,
    LimsSample,
    LimsSampleRemark,
    LimsSampleTransition,
)
from sub_samples.photo_storage import get_storage, set_storage_for_tests

PFX = "TEST-RNF-"
SAMPLE_ID = PFX + "P1"
SAMPLE_UID = "UID-RNF-P1"
IMG_B64 = base64.b64encode(b"png-bytes").decode()


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
    pk_q = select(LimsSample.id).where(LimsSample.sample_id.like(PFX + "%"))
    db.execute(delete(LimsParentAttachment).where(
        LimsParentAttachment.lims_sample_pk.in_(pk_q)))
    db.execute(delete(LimsSampleRemark).where(
        LimsSampleRemark.lims_sample_pk.in_(pk_q)))
    db.execute(delete(LimsSampleTransition).where(
        LimsSampleTransition.lims_sample_pk.in_(pk_q)))
    db.execute(delete(LimsSample).where(LimsSample.sample_id.like(PFX + "%")))
    db.commit()
    main.app.dependency_overrides.clear()


def _seed(db, *, status="sample_due", uid=SAMPLE_UID, system="senaite",
          sample_id=SAMPLE_ID):
    row = LimsSample(sample_id=sample_id, external_lims_uid=uid,
                     external_lims_system=system, sample_type="x",
                     status=status)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


class _FakePhotoStorage:
    def __init__(self, *, raise_on_save: bool = False):
        self.calls: list[tuple[str, bytes, str]] = []
        self.raise_on_save = raise_on_save

    def save_photo(self, sample_id: str, photo_bytes: bytes, filename: str) -> str:
        if self.raise_on_save:
            raise RuntimeError("fake storage boom")
        self.calls.append((sample_id, photo_bytes, filename))
        return f"fake-key/{sample_id}/{filename}"

    def fetch_photo(self, key: str) -> bytes:  # pragma: no cover
        raise NotImplementedError

    def delete_photo(self, key: str) -> None:  # pragma: no cover
        raise NotImplementedError


@pytest.fixture
def fake_storage():
    prev = get_storage()
    fake = _FakePhotoStorage()
    set_storage_for_tests(fake)
    yield fake
    set_storage_for_tests(prev)


def _mock_senaite_ok(*, initial_state="sample_due", final_state="sample_received"):
    """Healthy-SENAITE mock in the endpoint's exact call order: sample lookup,
    CSRF page, CSRF re-fetch, post-transition verify; POSTs (attachment and/or
    workflow) all return 200."""
    mock_instance = AsyncMock()
    sample_resp = MagicMock()
    sample_resp.json = MagicMock(return_value={
        "count": 1,
        "items": [{"review_state": initial_state, "path": "/senaite/samples/ar-1"}],
    })
    page = MagicMock(); page.text = '<input name="_authenticator" value="A1"/>'
    page2 = MagicMock(); page2.text = '<input name="_authenticator" value="A2"/>'
    verify = MagicMock()
    verify.json = MagicMock(return_value={
        "count": 1, "items": [{"review_state": final_state}]})
    mock_instance.get = AsyncMock(side_effect=[sample_resp, page, page2, verify])
    ok = MagicMock(); ok.status_code = 200
    mock_instance.post = AsyncMock(return_value=ok)
    p = patch("httpx.AsyncClient")
    cls = p.start()
    cls.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
    cls.return_value.__aexit__ = AsyncMock(return_value=False)
    return p, mock_instance


def _mock_senaite_down():
    p = patch("httpx.AsyncClient")
    cls = p.start()
    cls.return_value.__aenter__ = AsyncMock(
        side_effect=httpx.ConnectError("senaite down"))
    cls.return_value.__aexit__ = AsyncMock(return_value=False)
    return p


def _post(json):
    return _client_as_user().post("/wizard/senaite/receive-sample", json=json)


def _native_state(db, sample_id=SAMPLE_ID):
    row = db.execute(select(LimsSample).where(
        LimsSample.sample_id == sample_id)).scalar_one()
    transitions = db.execute(select(LimsSampleTransition).where(
        LimsSampleTransition.lims_sample_pk == row.id,
        LimsSampleTransition.verb == "receive")).scalars().all()
    remarks = db.execute(select(LimsSampleRemark).where(
        LimsSampleRemark.lims_sample_pk == row.id)).scalars().all()
    atts = db.execute(select(LimsParentAttachment).where(
        LimsParentAttachment.lims_sample_pk == row.id)).scalars().all()
    return row, transitions, remarks, atts


def test_senaite_down_checkin_still_succeeds(db, fake_storage):
    _seed(db, status="sample_due")
    p = _mock_senaite_down()
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _post({"sample_uid": SAMPLE_UID, "sample_id": SAMPLE_ID,
                       "image_base64": IMG_B64, "remarks": "warm on arrival"})
    finally:
        p.stop()
    body = r.json()
    assert r.status_code == 200 and body["success"] is True
    assert "senaite" in body["message"].lower()  # carries the tee warning
    row, transitions, remarks, atts = _native_state(db)
    assert row.status == "sample_received"
    assert row.date_received is not None
    assert len(transitions) == 1 and transitions[0].source == "mk1"
    assert len(remarks) == 1 and remarks[0].content == "warm on arrival"
    assert len(atts) == 1 and atts[0].kind == "receive_image"
    assert len(fake_storage.calls) == 1
    steps = body["senaite_response"]["steps_done"]
    assert any(s.startswith("senaite_tee_failed") for s in steps)


def test_senaite_healthy_tee_runs_after_native(db, fake_storage):
    _seed(db, status="sample_due")
    p, mock_instance = _mock_senaite_ok()
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _post({"sample_uid": SAMPLE_UID, "sample_id": SAMPLE_ID,
                       "image_base64": IMG_B64, "remarks": None})
    finally:
        p.stop()
    body = r.json()
    assert body["success"] is True
    assert "failed" not in body["message"].lower()
    row, transitions, _, atts = _native_state(db)
    assert row.status == "sample_received" and row.date_received is not None
    assert len(transitions) == 1
    assert len(atts) == 1
    # the tee actually walked SENAITE's workflow_action
    posted_urls = [c.args[0] if c.args else c.kwargs.get("url", "")
                   for c in mock_instance.post.call_args_list]
    assert any("workflow_action" in str(u) for u in posted_urls)
    steps = body["senaite_response"]["steps_done"]
    assert "senaite_received" in steps


def test_native_born_parent_skips_tee(db, fake_storage):
    _seed(db, status="sample_due", uid="mk1://rnf-native-1", system="mk1")
    p = patch("httpx.AsyncClient")
    cls = p.start()
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _post({"sample_uid": "mk1://rnf-native-1", "sample_id": SAMPLE_ID,
                       "image_base64": IMG_B64, "remarks": None})
    finally:
        p.stop()
    body = r.json()
    assert body["success"] is True
    assert not cls.called  # no SENAITE client ever constructed
    row, transitions, _, _ = _native_state(db)
    assert row.status == "sample_received" and len(transitions) == 1
    assert "senaite_tee_skipped" in body["senaite_response"]["steps_done"]


def test_senaite_url_unset_still_receives(db, fake_storage):
    _seed(db, status="sample_due")
    with patch.object(main, "SENAITE_URL", None):
        r = _post({"sample_uid": SAMPLE_UID, "sample_id": SAMPLE_ID,
                   "image_base64": IMG_B64, "remarks": None})
    body = r.json()
    assert body["success"] is True
    row, transitions, _, _ = _native_state(db)
    assert row.status == "sample_received" and len(transitions) == 1
    assert "senaite_tee_skipped" in body["senaite_response"]["steps_done"]


def test_already_received_is_idempotent(db, fake_storage):
    _seed(db, status="sample_received")
    p, _mock = _mock_senaite_ok(initial_state="sample_received")
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _post({"sample_uid": SAMPLE_UID, "sample_id": SAMPLE_ID,
                       "image_base64": None, "remarks": "late note"})
    finally:
        p.stop()
    body = r.json()
    assert body["success"] is True
    assert "already" in body["message"].lower()
    row, transitions, remarks, _ = _native_state(db)
    assert row.status == "sample_received"
    assert transitions == []          # no synthetic re-receive
    assert len(remarks) == 1          # remark still captured


def test_no_registry_row_fails(db, fake_storage):
    with patch.object(main, "SENAITE_URL", "http://senaite.test"):
        r = _post({"sample_uid": "UID-RNF-GHOST", "sample_id": PFX + "GHOST",
                   "image_base64": None, "remarks": None})
    body = r.json()
    assert body["success"] is False
    assert "registry" in body["message"].lower()


def test_photo_storage_failure_fails_atomically(db):
    _seed(db, status="sample_due")
    prev = get_storage()
    set_storage_for_tests(_FakePhotoStorage(raise_on_save=True))
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _post({"sample_uid": SAMPLE_UID, "sample_id": SAMPLE_ID,
                       "image_base64": IMG_B64, "remarks": "should not persist"})
    finally:
        set_storage_for_tests(prev)
    body = r.json()
    assert body["success"] is False
    row, transitions, remarks, atts = _native_state(db)
    assert row.status == "sample_due"        # nothing half-applied
    assert row.date_received is None
    assert transitions == [] and remarks == [] and atts == []
