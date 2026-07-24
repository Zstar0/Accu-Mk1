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

import csv as csv_mod
import io as io_mod
import logging
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

import main
from auth import get_current_user
from database import SessionLocal
from models import (
    HPLCAnalysis, LimsParentAttachment, LimsSample, LimsSubSample, Peptide,
)
from sub_samples.photo_storage import get_storage, set_storage_for_tests

TEST_PARENT_SAMPLE_ID = "TEST-PATTCAP-P1"
TEST_VIAL_SAMPLE_ID = "TEST-PATTCAP-P1-S01"
TEST_OTHER_PARENT_SAMPLE_ID = "TEST-PATTCAP-P2"
TEST_OTHER_VIAL_SAMPLE_ID = "TEST-PATTCAP-P2-S01"
TEST_PEPTIDE_ABBR = "TEST-PATTCAP-PEP"

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
    # HPLCAnalysis before Peptide (FK) — final review chromatogram tests.
    db.execute(delete(HPLCAnalysis).where(
        HPLCAnalysis.sample_id_label.like("TEST-PATTCAP-%")))
    db.execute(delete(Peptide).where(Peptide.abbreviation == TEST_PEPTIDE_ABBR))
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


@pytest.fixture
def seed_other_parent_vial(db):
    """A vial under a DIFFERENT parent — used to prove the cross-parent
    lineage guard (final review, 2026-07-14 item 4)."""
    other_parent = LimsSample(sample_id=TEST_OTHER_PARENT_SAMPLE_ID,
                              external_lims_uid="UID-PATTCAP-P2",
                              sample_type="x", status="verified")
    db.add(other_parent)
    db.commit()
    db.refresh(other_parent)
    row = LimsSubSample(
        sample_id=TEST_OTHER_VIAL_SAMPLE_ID,
        parent_sample_pk=other_parent.id,
        vial_sequence=1,
        external_lims_uid="UID-PATTCAP-P2-S01",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@pytest.fixture
def seed_peptide(db):
    existing = db.execute(select(Peptide).where(
        Peptide.abbreviation == TEST_PEPTIDE_ABBR)).scalar_one_or_none()
    if existing is not None:
        return existing
    p = Peptide(name="Test Peptide (PATTCAP)", abbreviation=TEST_PEPTIDE_ABBR)
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


@pytest.fixture
def seed_hplc_analysis(db, seed_peptide):
    """Independent of seed_parent/seed_vial — the chromatogram endpoint links
    to the parent only via the `sample_uid` query param, not a DB FK."""
    a = HPLCAnalysis(
        sample_id_label=TEST_VIAL_SAMPLE_ID,
        peptide_id=seed_peptide.id,
        stock_vial_empty=1.0, stock_vial_with_diluent=2.0,
        dil_vial_empty=1.0, dil_vial_with_diluent=2.0,
        dil_vial_with_diluent_and_sample=3.0,
        chromatogram_data={"times": [0.0, 0.1, 0.2],
                           "signals": [10.0, 20.5, 30.25]},
    )
    db.add(a)
    db.commit()
    db.refresh(a)
    return a


def _expected_csv_bytes(times, signals) -> bytes:
    """Recompute expected chromatogram CSV bytes via the SAME csv.writer path
    the endpoint uses (default line terminator is '\\r\\n', not '\\n' — a
    hand-written literal would silently mismatch)."""
    buf = io_mod.StringIO()
    w = csv_mod.writer(buf)
    for t, s in zip(times, signals):
        w.writerow([t, s])
    return buf.getvalue().encode("utf-8")


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
    assert row.attachment_type == "Sample Image"
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
    assert rows[0].attachment_type == "Sample Image"


# ═══════════════════════════════════════════════════════════════════════════
# Final review (2026-07-14) item 4: guards
# ═══════════════════════════════════════════════════════════════════════════


def test_upload_cross_parent_source_lineage_mismatch_records_none(
        db, seed_parent, seed_other_parent_vial, fake_storage, caplog):
    """A source_sample_id resolving to a vial under a DIFFERENT parent than
    the one being captured onto must not be recorded as lineage — the row
    still lands (best-effort capture), just with source_sub_sample_pk=NULL,
    and the mismatch is logged once."""
    proxy, _mock_instance = _mock_attachment_upload_flow()
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"), \
             caplog.at_level(logging.WARNING):
            r = _upload(
                _client_as_user(user_id=1),
                seed_parent.external_lims_uid,
                extra_data={
                    "native_kind": "vial_image",
                    "source_sample_id": TEST_OTHER_VIAL_SAMPLE_ID,
                },
            )
    finally:
        proxy.stop()

    assert r.status_code == 200, r.text
    assert r.json()["success"] is True

    parent = db.execute(select(LimsSample).where(
        LimsSample.sample_id == TEST_PARENT_SAMPLE_ID)).scalar_one()
    rows = db.execute(select(LimsParentAttachment).where(
        LimsParentAttachment.lims_sample_pk == parent.id)).scalars().all()
    assert len(rows) == 1
    assert rows[0].source_sub_sample_pk is None

    assert any("parent_attachment.source_lineage_mismatch" in rec.message
                for rec in caplog.records)


def test_upload_unresolvable_source_sample_id_logged(
        db, seed_parent, fake_storage, caplog):
    """A source_sample_id that resolves to NO vial at all (typo, deleted
    row) is also captured with source_sub_sample_pk=NULL, and logged
    distinctly from the cross-parent-mismatch case."""
    proxy, _mock_instance = _mock_attachment_upload_flow()
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"), \
             caplog.at_level(logging.WARNING):
            r = _upload(
                _client_as_user(user_id=1),
                seed_parent.external_lims_uid,
                extra_data={
                    "native_kind": "vial_image",
                    "source_sample_id": "TEST-PATTCAP-NOSUCH-S01",
                },
            )
    finally:
        proxy.stop()

    assert r.status_code == 200, r.text
    assert r.json()["success"] is True

    parent = db.execute(select(LimsSample).where(
        LimsSample.sample_id == TEST_PARENT_SAMPLE_ID)).scalar_one()
    rows = db.execute(select(LimsParentAttachment).where(
        LimsParentAttachment.lims_sample_pk == parent.id)).scalars().all()
    assert len(rows) == 1
    assert rows[0].source_sub_sample_pk is None

    assert any("parent_attachment.source_unresolvable" in rec.message
                for rec in caplog.records)


def test_upload_filename_truncated_to_255(db, seed_parent, fake_storage):
    """filename is truncated to the column's VARCHAR(255) limit BEFORE the
    write — without this guard an over-long filename would raise a DB error
    inside the best-effort try/except and silently drop the row entirely."""
    long_name = ("x" * 300) + ".png"
    proxy, _mock_instance = _mock_attachment_upload_flow()
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _client_as_user(user_id=1).post(
                f"/wizard/senaite/samples/{seed_parent.external_lims_uid}/attachments",
                data={"attachment_type": "Sample Image"},
                files={"file": (long_name, b"raw-bytes-123", "image/png")},
            )
    finally:
        proxy.stop()

    assert r.status_code == 200, r.text
    assert r.json()["success"] is True

    parent = db.execute(select(LimsSample).where(
        LimsSample.sample_id == TEST_PARENT_SAMPLE_ID)).scalar_one()
    rows = db.execute(select(LimsParentAttachment).where(
        LimsParentAttachment.lims_sample_pk == parent.id)).scalars().all()
    assert len(rows) == 1
    assert len(rows[0].filename) == 255
    assert rows[0].filename == long_name[:255]
    # The storage key is derived from the (already-truncated) filename too.
    assert fake_storage.calls[0][2] == long_name[:255]


# ═══════════════════════════════════════════════════════════════════════════
# Final review (2026-07-14) item 1 (CRITICAL, TDD): chromatogram-push
# captures a native row — a third, previously-uncaptured write path onto the
# parent AR. SelectVialChromatogramDialog (src/components/senaite/
# SampleDetails.tsx ~2374) passes the PARENT AR uid to this endpoint's
# sample_uid query param, exactly like upload_senaite_attachment's
# sample_uid — so the same mock harness applies unmodified.
# ═══════════════════════════════════════════════════════════════════════════


def test_chromatogram_push_captures_native_row(
        db, seed_parent, seed_hplc_analysis, fake_storage):
    proxy, _mock_instance = _mock_attachment_upload_flow(
        attachment_type="HPLC Graph")
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _client_as_user(user_id=1).post(
                f"/hplc/analyses/{seed_hplc_analysis.id}/chromatogram-to-senaite",
                params={"sample_uid": seed_parent.external_lims_uid},
            )
    finally:
        proxy.stop()

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True

    expected_filename = f"chromatogram_{seed_hplc_analysis.sample_id_label}.csv"
    expected_bytes = _expected_csv_bytes(
        seed_hplc_analysis.chromatogram_data["times"],
        seed_hplc_analysis.chromatogram_data["signals"],
    )

    assert len(fake_storage.calls) == 1
    saved_sample_id, saved_bytes, saved_filename = fake_storage.calls[0]
    assert saved_sample_id == TEST_PARENT_SAMPLE_ID
    assert saved_bytes == expected_bytes
    assert saved_filename == expected_filename

    parent = db.execute(select(LimsSample).where(
        LimsSample.sample_id == TEST_PARENT_SAMPLE_ID)).scalar_one()
    rows = db.execute(select(LimsParentAttachment).where(
        LimsParentAttachment.lims_sample_pk == parent.id)).scalars().all()
    assert len(rows) == 1
    row = rows[0]
    assert row.kind == "chromatogram"
    assert row.render_in_report is False
    assert row.attachment_type == "HPLC Graph"
    assert row.filename == expected_filename
    assert row.content_type == "text/csv"
    assert row.storage == "s3"
    assert row.storage_key == f"fake-key/{TEST_PARENT_SAMPLE_ID}/{expected_filename}"
    assert row.source_sub_sample_pk is None
    assert row.senaite_attachment_uid is None
    assert row.created_by_user_id == 1


def test_chromatogram_push_senaite_failure_skips_native(
        db, seed_parent, seed_hplc_analysis, fake_storage):
    proxy, _mock_instance = _mock_attachment_upload_flow(
        post_status=500, attachment_type="HPLC Graph")
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _client_as_user(user_id=1).post(
                f"/hplc/analyses/{seed_hplc_analysis.id}/chromatogram-to-senaite",
                params={"sample_uid": seed_parent.external_lims_uid},
            )
    finally:
        proxy.stop()

    assert r.status_code == 502, r.text
    assert fake_storage.calls == []

    parent = db.execute(select(LimsSample).where(
        LimsSample.sample_id == TEST_PARENT_SAMPLE_ID)).scalar_one()
    rows = db.execute(select(LimsParentAttachment).where(
        LimsParentAttachment.lims_sample_pk == parent.id)).scalars().all()
    assert rows == []
