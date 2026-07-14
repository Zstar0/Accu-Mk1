"""AR-attachment upload captures a native row + frozen S3 snapshot
(read-flip spec §7, Layer 3 Task 2).

SENAITE upload behavior stays byte-identical on both the success and
failure paths; the native capture is best-effort AFTER SENAITE success and
never raises into the response (logs `parent_attachment.capture_failed`
on any capture-side error).

Mock harness idiom copied from test_receive_remarks_native.py's
`_mock_receive_flow` (broad `httpx.AsyncClient` patch), adapted for this
endpoint's call sequence: GET analysisrequest metadata, GET sample page
HTML (needs an `_authenticator` input + an `<option>` matching the
attachment type name), POST the attachment form.

House pattern: TEST-prefixed rows (`TEST-PATTCAP-` sample_ids), FK-safe
cleanup (LimsParentAttachment/LimsSubSample before LimsSample).
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
from models import LimsParentAttachment, LimsSample, LimsSubSample
from sub_samples.photo_storage import get_storage, set_storage_for_tests

TEST_PARENT_SAMPLE_ID = "TEST-PATTCAP-P1"
TEST_VIAL_SAMPLE_ID = "TEST-PATTCAP-P1-S01"

ATTACHMENT_TYPE_UID = "att-type-uid-1"


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
    db.execute(delete(LimsParentAttachment).where(
        LimsParentAttachment.lims_sample_pk.in_(
            select(LimsSample.id).where(
                LimsSample.sample_id.like("TEST-PATTCAP-%"))
        )
    ))
    db.execute(delete(LimsSubSample).where(
        LimsSubSample.sample_id.like("TEST-PATTCAP-%")))
    db.execute(delete(LimsSample).where(
        LimsSample.sample_id.like("TEST-PATTCAP-%")))
    db.commit()


@pytest.fixture
def seed_parent(db):
    row = LimsSample(sample_id=TEST_PARENT_SAMPLE_ID,
                      external_lims_uid="UID-PATTCAP-P1",
                      sample_type="x", status="verified")
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@pytest.fixture
def seed_vial(db, seed_parent):
    row = LimsSubSample(
        sample_id=TEST_VIAL_SAMPLE_ID,
        parent_sample_pk=seed_parent.id,
        vial_sequence=1,
        external_lims_uid="UID-PATTCAP-P1-S01",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


class _FakePhotoStorage:
    """Records every save_photo call; returns a deterministic key."""

    def __init__(self, *, raise_on_save: bool = False):
        self.calls: list[tuple[str, bytes, str]] = []
        self.raise_on_save = raise_on_save

    def save_photo(self, sample_id: str, photo_bytes: bytes, filename: str) -> str:
        if self.raise_on_save:
            raise RuntimeError("fake storage boom")
        self.calls.append((sample_id, photo_bytes, filename))
        return f"fake-key/{sample_id}/{filename}"

    def fetch_photo(self, key: str) -> bytes:  # pragma: no cover - unused
        raise NotImplementedError

    def delete_photo(self, key: str) -> None:  # pragma: no cover - unused
        raise NotImplementedError


@pytest.fixture
def fake_storage():
    prev = get_storage()
    fake = _FakePhotoStorage()
    set_storage_for_tests(fake)
    yield fake
    set_storage_for_tests(prev)


# ── SENAITE HTTP mock ───────────────────────────────────────────────────

def _mock_attachment_upload_flow(*, post_status: int = 200,
                                  attachment_type: str = "Sample Image"):
    """Mocks upload_senaite_attachment's exact call sequence:
    GET analysisrequest metadata, GET sample page HTML (CSRF +
    attachment-type UID), POST the attachment form. Returns
    `(patcher, mock_instance)` so callers can inspect calls.
    """
    mock_instance = AsyncMock()

    meta_resp = MagicMock()
    meta_resp.json = MagicMock(return_value={
        "items": [{"url": "http://senaite.test/senaite/samples/ar-1"}],
    })
    meta_resp.raise_for_status = MagicMock()

    page_resp = MagicMock()
    page_resp.text = (
        '<input name="_authenticator" value="AUTH1"/>'
        f'<option value="{ATTACHMENT_TYPE_UID}">{attachment_type}</option>'
    )

    mock_instance.get = AsyncMock(side_effect=[meta_resp, page_resp])

    post_resp = MagicMock()
    post_resp.status_code = post_status
    mock_instance.post = AsyncMock(return_value=post_resp)

    p = patch("httpx.AsyncClient")
    cls = p.start()
    cls.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
    cls.return_value.__aexit__ = AsyncMock(return_value=False)
    return p, mock_instance


def _upload(client, sample_uid, *, extra_data=None):
    data = {"attachment_type": "Sample Image"}
    if extra_data:
        data.update(extra_data)
    return client.post(
        f"/wizard/senaite/samples/{sample_uid}/attachments",
        data=data,
        files={"file": ("vial.png", b"raw-bytes-123", "image/png")},
    )


# ═══════════════════════════════════════════════════════════════════════════
# Task 2: native capture on attachment upload
# ═══════════════════════════════════════════════════════════════════════════


def test_upload_captures_snapshot_and_native_row(db, seed_parent, seed_vial, fake_storage):
    proxy, _mock_instance = _mock_attachment_upload_flow()
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _upload(
                _client_as_user(user_id=1),
                seed_parent.external_lims_uid,
                extra_data={
                    "native_kind": "vial_image",
                    "source_sample_id": TEST_VIAL_SAMPLE_ID,
                },
            )
    finally:
        proxy.stop()

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True

    # Fake storage received the exact uploaded bytes, keyed by the PARENT
    # sample id (not the vial's).
    assert len(fake_storage.calls) == 1
    saved_sample_id, saved_bytes, saved_filename = fake_storage.calls[0]
    assert saved_sample_id == TEST_PARENT_SAMPLE_ID
    assert saved_bytes == b"raw-bytes-123"
    assert saved_filename == "vial.png"

    parent = db.execute(select(LimsSample).where(
        LimsSample.sample_id == TEST_PARENT_SAMPLE_ID)).scalar_one()
    rows = db.execute(select(LimsParentAttachment).where(
        LimsParentAttachment.lims_sample_pk == parent.id)).scalars().all()
    assert len(rows) == 1
    row = rows[0]
    assert row.kind == "vial_image"
    assert row.source_sub_sample_pk == seed_vial.id
    assert row.filename == "vial.png"
    assert row.content_type == "image/png"
    assert row.storage == "s3"
    assert row.storage_key == f"fake-key/{TEST_PARENT_SAMPLE_ID}/vial.png"
    assert row.render_in_report is True
    assert row.created_by_user_id == 1
    assert row.senaite_attachment_uid is None


def test_upload_senaite_failure_skips_native(db, seed_parent, seed_vial, fake_storage):
    proxy, _mock_instance = _mock_attachment_upload_flow(post_status=500)
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _upload(
                _client_as_user(user_id=1),
                seed_parent.external_lims_uid,
                extra_data={
                    "native_kind": "vial_image",
                    "source_sample_id": TEST_VIAL_SAMPLE_ID,
                },
            )
    finally:
        proxy.stop()

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is False
    assert "500" in body["message"]

    assert fake_storage.calls == []

    parent = db.execute(select(LimsSample).where(
        LimsSample.sample_id == TEST_PARENT_SAMPLE_ID)).scalar_one()
    rows = db.execute(select(LimsParentAttachment).where(
        LimsParentAttachment.lims_sample_pk == parent.id)).scalars().all()
    assert rows == []


def test_upload_native_failure_never_breaks_response(db, seed_parent, seed_vial, caplog):
    prev = get_storage()
    fake = _FakePhotoStorage(raise_on_save=True)
    set_storage_for_tests(fake)
    try:
        proxy, _mock_instance = _mock_attachment_upload_flow()
        try:
            with patch.object(main, "SENAITE_URL", "http://senaite.test"), \
                 caplog.at_level(logging.WARNING):
                r = _upload(
                    _client_as_user(user_id=1),
                    seed_parent.external_lims_uid,
                    extra_data={
                        "native_kind": "vial_image",
                        "source_sample_id": TEST_VIAL_SAMPLE_ID,
                    },
                )
        finally:
            proxy.stop()
    finally:
        set_storage_for_tests(prev)

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True

    parent = db.execute(select(LimsSample).where(
        LimsSample.sample_id == TEST_PARENT_SAMPLE_ID)).scalar_one()
    rows = db.execute(select(LimsParentAttachment).where(
        LimsParentAttachment.lims_sample_pk == parent.id)).scalars().all()
    assert rows == []

    assert any("parent_attachment.capture_failed" in rec.message
                for rec in caplog.records)


def test_upload_defaults_manual_kind_no_source(db, seed_parent, fake_storage):
    proxy, _mock_instance = _mock_attachment_upload_flow()
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _upload(
                _client_as_user(user_id=1),
                seed_parent.external_lims_uid,
            )
    finally:
        proxy.stop()

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True

    parent = db.execute(select(LimsSample).where(
        LimsSample.sample_id == TEST_PARENT_SAMPLE_ID)).scalar_one()
    rows = db.execute(select(LimsParentAttachment).where(
        LimsParentAttachment.lims_sample_pk == parent.id)).scalars().all()
    assert len(rows) == 1
    assert rows[0].kind == "manual"
    assert rows[0].source_sub_sample_pk is None
