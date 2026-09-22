"""Task 4 (HPLC native slice 6, M8): `_capture_parent_attachment_bg` gains a
`sample_id` fallback so native-born rows (no SENAITE uid — the uid passed in
is a synthetic `mk1://...` placeholder) still resolve, instead of the capture
silently failing with `capture_failed`.

Sqlite in-memory (StaticPool) harness patched onto `database.SessionLocal`
(the function does `from database import SessionLocal` lazily inside the
try, so patching the module attribute is enough); fake photo storage copied
from tests/test_receive_native_first.py.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import main
from database import Base
from models import LimsParentAttachment, LimsSample
from sub_samples.photo_storage import get_storage, set_storage_for_tests


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    TestSessionLocal = sessionmaker(bind=engine)
    with patch("database.SessionLocal", TestSessionLocal):
        s = TestSessionLocal()
        yield s
        s.close()


def _mk_sample(db, *, sample_id, uid=None, system="mk1"):
    row = LimsSample(sample_id=sample_id, external_lims_uid=uid,
                     external_lims_system=system, sample_type="x",
                     status="sample_due")
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


class _FakePhotoStorage:
    def save_photo(self, sample_id: str, photo_bytes: bytes, filename: str) -> str:
        return f"fake-key/{sample_id}/{filename}"

    def fetch_photo(self, key: str) -> bytes:  # pragma: no cover
        raise NotImplementedError

    def delete_photo(self, key: str) -> None:  # pragma: no cover
        raise NotImplementedError


@pytest.fixture(autouse=True)
def fake_storage():
    prev = get_storage()
    set_storage_for_tests(_FakePhotoStorage())
    yield
    set_storage_for_tests(prev)


def test_native_born_row_resolved_via_sample_id_fallback(db):
    # Native-born row: no SENAITE uid at all (mk1:// placeholder never
    # matches external_lims_uid, so the uid lookup misses on purpose).
    _mk_sample(db, sample_id="P-5001", uid=None, system="mk1")

    main._capture_parent_attachment_bg(
        sample_uid="mk1://x", file_bytes=b"png-bytes", filename="a.png",
        content_type="image/png", kind="manual", source_sample_id=None,
        user_id=1, sample_id="P-5001",
    )

    row = db.execute(select(LimsSample).where(LimsSample.sample_id == "P-5001")).scalar_one()
    att = db.execute(
        select(LimsParentAttachment).where(LimsParentAttachment.lims_sample_pk == row.id)
    ).scalar_one_or_none()
    assert att is not None
    assert att.filename == "a.png"


def test_uid_only_miss_still_no_row_and_warns(db, caplog):
    # No sample_id fallback given and the uid matches nothing — existing
    # behaviour (capture_failed warning, no attachment row) must be untouched.
    _mk_sample(db, sample_id="P-9999", uid="UID-REAL", system="senaite")

    with caplog.at_level("WARNING"):
        main._capture_parent_attachment_bg(
            sample_uid="UID-DOES-NOT-EXIST", file_bytes=b"png-bytes",
            filename="a.png", content_type="image/png", kind="manual",
            source_sample_id=None, user_id=1,
        )

    assert db.execute(select(LimsParentAttachment)).scalar_one_or_none() is None
    assert any("parent_attachment.capture_failed" in r.message for r in caplog.records)
