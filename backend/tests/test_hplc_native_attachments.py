"""Task 1 (HPLC native slice 7): native-born parents get their own
attachment routes — `POST /hplc/analyses/{id}/chromatogram-native` and
`POST /wizard/samples/{sample_id}/attachments` — that write straight to
`lims_parent_attachments` via `write_parent_attachment`, no SENAITE hop.
The two legacy SENAITE routes 409 `native_born_use_native_route` when
handed a native-born row, BEFORE any SENAITE HTTP call; the new native
routes 409 `senaite_born_use_senaite_route` when handed a SENAITE-born row.

Real dev Postgres session (`database.SessionLocal`), same house pattern as
tests/test_parent_attachment_capture.py: TEST-prefixed sample_ids, FK-safe
cleanup, fake photo storage patched via `set_storage_for_tests`.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

import main
from auth import get_current_user
from database import SessionLocal
from models import (
    HPLCAnalysis,
    LimsParentAttachment,
    LimsSample,
    LimsSubSample,
    Peptide,
)
from sub_samples.photo_storage import get_storage, set_storage_for_tests
from tests.hplc_native_family import native_family

TEST_NATIVE_PARENT_ID = "TEST-HPLCATT-NP1"
TEST_SENAITE_PARENT_ID = "TEST-HPLCATT-SP1"
TEST_PEPTIDE_ABBR = "TEST-HPLCATT-PEP"


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
                LimsSample.sample_id.like("TEST-HPLCATT-%"))
        )
    ))
    db.execute(delete(HPLCAnalysis).where(
        HPLCAnalysis.sample_id_label.like("TEST-HPLCATT-%")))
    db.execute(delete(LimsSubSample).where(
        LimsSubSample.sample_id.like("TEST-HPLCATT-%")))
    db.execute(delete(LimsSample).where(
        LimsSample.sample_id.like("TEST-HPLCATT-%")))
    db.execute(delete(Peptide).where(Peptide.abbreviation.like("TEST-HPLCATT-%")))
    db.commit()


class _FakePhotoStorage:
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


@pytest.fixture
def native_parent(db):
    """A real native-born family (catalog services + peptide + parent +
    per-slot placeholders) built through the shared test helper."""
    parent, _services, _peps, _vial_rows = native_family(
        db, sample_id=TEST_NATIVE_PARENT_ID,
        slots=[("TEST-HPLCATT Peptide", TEST_PEPTIDE_ABBR)])
    db.commit()
    return parent


@pytest.fixture
def native_hplc_analysis(db, native_parent):
    """sample_id_label = the native PARENT's own sample_id — the same
    fallback field `_capture_parent_attachment_bg` / `_lims_sample_for_attachment`
    already resolve against for an analysis-triggered chromatogram write
    (see upload_chromatogram_to_senaite's `sample_id=analysis.sample_id_label`)."""
    peptide_id = db.execute(
        select(Peptide.id).where(Peptide.abbreviation == TEST_PEPTIDE_ABBR)
    ).scalar_one()
    a = HPLCAnalysis(
        sample_id_label=native_parent.sample_id,
        peptide_id=peptide_id,
        stock_vial_empty=1.0, stock_vial_with_diluent=2.0,
        dil_vial_empty=1.0, dil_vial_with_diluent=2.0,
        dil_vial_with_diluent_and_sample=3.0,
        chromatogram_data={"times": [0, 1], "signals": [0, 1]},
    )
    db.add(a)
    db.commit()
    db.refresh(a)
    return a


@pytest.fixture
def senaite_parent(db):
    row = LimsSample(sample_id=TEST_SENAITE_PARENT_ID,
                      external_lims_uid="UID-HPLCATT-SP1",
                      external_lims_system="senaite",
                      sample_type="x", status="verified")
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@pytest.fixture
def senaite_hplc_analysis(db, senaite_parent, native_parent):
    """Independent peptide reuse: any peptide_id works, the analysis just
    needs to exist and carry chromatogram data + the SENAITE sample's own
    sample_id_label (mirrors production: sample_id_label is whatever id the
    analysis was recorded against)."""
    peptide_id = db.execute(
        select(Peptide.id).where(Peptide.abbreviation == TEST_PEPTIDE_ABBR)
    ).scalar_one()
    a = HPLCAnalysis(
        sample_id_label=senaite_parent.sample_id,
        peptide_id=peptide_id,
        stock_vial_empty=1.0, stock_vial_with_diluent=2.0,
        dil_vial_empty=1.0, dil_vial_with_diluent=2.0,
        dil_vial_with_diluent_and_sample=3.0,
        chromatogram_data={"times": [0, 1], "signals": [0, 1]},
    )
    db.add(a)
    db.commit()
    db.refresh(a)
    return a


def _no_httpx_client():
    """Patches httpx.AsyncClient to raise if constructed — proves the 409
    native-born guard fires BEFORE any SENAITE HTTP call."""
    return patch("httpx.AsyncClient", side_effect=AssertionError(
        "SENAITE HTTP client must not be constructed for a native-born row"))


# ═══════════════════════════════════════════════════════════════════════════
# (a) native chromatogram route on a native-born parent
# ═══════════════════════════════════════════════════════════════════════════

def test_chromatogram_native_writes_row_and_gate_sees_it(
    db, native_parent, native_hplc_analysis, fake_storage,
):
    from main import _parent_attachment_kinds_native

    r = _client_as_user().post(
        f"/hplc/analyses/{native_hplc_analysis.id}/chromatogram-native",
        params={"sample_id": native_parent.sample_id},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True
    assert body["filename"] == f"chromatogram_{native_parent.sample_id}.csv"
    assert body["size_bytes"] > 0

    row = db.execute(select(LimsSample).where(
        LimsSample.sample_id == native_parent.sample_id)).scalar_one()
    atts = db.execute(select(LimsParentAttachment).where(
        LimsParentAttachment.lims_sample_pk == row.id)).scalars().all()
    assert len(atts) == 1
    att = atts[0]
    assert att.kind == "chromatogram"
    assert att.render_in_report is False
    assert att.attachment_type == "HPLC Graph"
    assert att.storage == "s3"

    assert "chromatogram" in _parent_attachment_kinds_native(db, row.id)

    # Second call: no dedupe, second row (symmetric with the SENAITE twin).
    r2 = _client_as_user().post(
        f"/hplc/analyses/{native_hplc_analysis.id}/chromatogram-native",
        params={"sample_id": native_parent.sample_id},
    )
    assert r2.status_code == 200, r2.text
    atts2 = db.execute(select(LimsParentAttachment).where(
        LimsParentAttachment.lims_sample_pk == row.id)).scalars().all()
    assert len(atts2) == 2


# ═══════════════════════════════════════════════════════════════════════════
# (b) native chromatogram route on a SENAITE-born row → 409
# ═══════════════════════════════════════════════════════════════════════════

def test_chromatogram_native_on_senaite_born_row_409s(
    db, senaite_parent, senaite_hplc_analysis, fake_storage,
):
    r = _client_as_user().post(
        f"/hplc/analyses/{senaite_hplc_analysis.id}/chromatogram-native",
        params={"sample_id": senaite_parent.sample_id},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "senaite_born_use_senaite_route"
    assert fake_storage.calls == []


# ═══════════════════════════════════════════════════════════════════════════
# Fix round 1, finding 2: chromatogram-native must cross-check `sample_id`
# against the analysis's own sample_id_label instead of trusting it blind —
# otherwise one analysis's chromatogram can be attached to an unrelated
# native parent just by passing a different sample_id.
# ═══════════════════════════════════════════════════════════════════════════

def test_chromatogram_native_mismatched_sample_id_409s(
    db, native_parent, native_hplc_analysis, senaite_parent, fake_storage,
):
    # senaite_parent is a real, different LimsSample row — not the analysis's
    # own sample_id_label (native_parent.sample_id) — so this must be
    # rejected before any write, regardless of what senaite_parent even is.
    r = _client_as_user().post(
        f"/hplc/analyses/{native_hplc_analysis.id}/chromatogram-native",
        params={"sample_id": senaite_parent.sample_id},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "chromatogram_sample_mismatch"
    assert fake_storage.calls == []

    row = db.execute(select(LimsSample).where(
        LimsSample.sample_id == native_parent.sample_id)).scalar_one()
    atts = db.execute(select(LimsParentAttachment).where(
        LimsParentAttachment.lims_sample_pk == row.id)).scalars().all()
    assert atts == []


def test_chromatogram_native_omitted_sample_id_resolves_from_analysis(
    db, native_parent, native_hplc_analysis, fake_storage,
):
    r = _client_as_user().post(
        f"/hplc/analyses/{native_hplc_analysis.id}/chromatogram-native",
    )
    assert r.status_code == 200, r.text

    row = db.execute(select(LimsSample).where(
        LimsSample.sample_id == native_parent.sample_id)).scalar_one()
    atts = db.execute(select(LimsParentAttachment).where(
        LimsParentAttachment.lims_sample_pk == row.id)).scalars().all()
    assert len(atts) == 1
    assert atts[0].kind == "chromatogram"


# ═══════════════════════════════════════════════════════════════════════════
# (c) native manual-attachment route
# ═══════════════════════════════════════════════════════════════════════════

def test_native_attachment_upload_writes_row(db, native_parent, fake_storage):
    r = _client_as_user().post(
        f"/wizard/samples/{native_parent.sample_id}/attachments",
        data={"attachment_type": "Sample Image"},
        files={"file": ("vial.png", b"raw-bytes-123", "image/png")},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True

    row = db.execute(select(LimsSample).where(
        LimsSample.sample_id == native_parent.sample_id)).scalar_one()
    atts = db.execute(select(LimsParentAttachment).where(
        LimsParentAttachment.lims_sample_pk == row.id)).scalars().all()
    assert len(atts) == 1
    att = atts[0]
    assert att.kind == "manual"  # native_kind not supplied -> default, clamped
    assert att.render_in_report is True
    assert att.attachment_type == "Sample Image"
    assert att.filename == "vial.png"
    assert att.content_type == "image/png"
    assert len(fake_storage.calls) == 1


def test_native_attachment_upload_on_senaite_born_row_409s(db, senaite_parent, fake_storage):
    r = _client_as_user().post(
        f"/wizard/samples/{senaite_parent.sample_id}/attachments",
        data={"attachment_type": "Sample Image"},
        files={"file": ("vial.png", b"raw-bytes-123", "image/png")},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "senaite_born_use_senaite_route"
    assert fake_storage.calls == []


# ═══════════════════════════════════════════════════════════════════════════
# (d) legacy chromatogram-to-senaite route on a native-born row → 409,
#     before any SENAITE HTTP call
# ═══════════════════════════════════════════════════════════════════════════

def test_legacy_chromatogram_route_on_native_born_row_409s_before_http(
    db, native_parent, native_hplc_analysis, fake_storage,
):
    with patch.object(main, "SENAITE_URL", "http://senaite.test"), _no_httpx_client():
        r = _client_as_user().post(
            f"/hplc/analyses/{native_hplc_analysis.id}/chromatogram-to-senaite",
            params={"sample_uid": "mk1://does-not-matter"},
        )
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "native_born_use_native_route"
    assert fake_storage.calls == []


def test_legacy_upload_attachment_route_on_native_born_uid_409s_before_http(
    db, native_parent, fake_storage,
):
    """The legacy multipart route only has `sample_uid` to resolve against —
    give it the native parent's real external_lims_uid so the gate's
    uid-lookup arm fires."""
    native_parent.external_lims_uid = "UID-HPLCATT-NATIVE-DIRECT"
    db.add(native_parent)
    db.commit()

    with patch.object(main, "SENAITE_URL", "http://senaite.test"), _no_httpx_client():
        r = _client_as_user().post(
            f"/wizard/senaite/samples/{native_parent.external_lims_uid}/attachments",
            data={"attachment_type": "Sample Image"},
            files={"file": ("vial.png", b"x", "image/png")},
        )
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "native_born_use_native_route"
    assert fake_storage.calls == []


# ═══════════════════════════════════════════════════════════════════════════
# (f) writer failure → native route 500, no row
# ═══════════════════════════════════════════════════════════════════════════

def test_chromatogram_native_storage_error_returns_500_no_row(
    db, native_parent, native_hplc_analysis,
):
    prev = get_storage()
    set_storage_for_tests(_FakePhotoStorage(raise_on_save=True))
    try:
        r = _client_as_user().post(
            f"/hplc/analyses/{native_hplc_analysis.id}/chromatogram-native",
            params={"sample_id": native_parent.sample_id},
        )
    finally:
        set_storage_for_tests(prev)

    assert r.status_code == 500, r.text

    row = db.execute(select(LimsSample).where(
        LimsSample.sample_id == native_parent.sample_id)).scalar_one()
    atts = db.execute(select(LimsParentAttachment).where(
        LimsParentAttachment.lims_sample_pk == row.id)).scalars().all()
    assert atts == []


def test_native_attachment_upload_storage_error_returns_500_no_row(db, native_parent):
    prev = get_storage()
    set_storage_for_tests(_FakePhotoStorage(raise_on_save=True))
    try:
        r = _client_as_user().post(
            f"/wizard/samples/{native_parent.sample_id}/attachments",
            data={"attachment_type": "Sample Image"},
            files={"file": ("vial.png", b"raw-bytes-123", "image/png")},
        )
    finally:
        set_storage_for_tests(prev)

    assert r.status_code == 500, r.text

    row = db.execute(select(LimsSample).where(
        LimsSample.sample_id == native_parent.sample_id)).scalar_one()
    atts = db.execute(select(LimsParentAttachment).where(
        LimsParentAttachment.lims_sample_pk == row.id)).scalars().all()
    assert atts == []
