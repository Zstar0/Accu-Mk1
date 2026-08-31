"""S2S attachment bytes route (read-independence spec §4).

GET /s2s/samples/{sample_id}/attachments/{attachment_id} serves the bytes
behind the URLs backend/coa/sample_meta.py mints for the `sample_meta.
attachments[*].url` wire field — COABuilder downloads each one with the
shared service-token header instead of walking SENAITE's AR attachments.

Byte-loading and header logic are cloned from the user-JWT download route
(download_registry_parent_attachment, GET /registry/sample/{sample_id}/
attachments/{attachment_id}/download, main.py ~22019): Content-Type and
filename come from the DB row — NEVER the storage-key extension (the '.bin'
trap: chromatogram snapshots key as '.bin' while the row says text/csv).

NO SENAITE branch (R1): a non-'s3' row (e.g. a legacy 'senaite'-stored row)
is a plain 404 here, not a proxy hint — this route only ever serves S3
snapshots; the producer never mints its URL for anything else.

Fixture idiom copied from test_coa_sections_endpoint.py / test_s2s_catalog_
keys.py (StaticPool in-memory SQLite + get_db override — sync route handler
runs in a TestClient worker thread, so plain sqlite3 would raise "objects
created in a different thread"; ACCUMK1_INTERNAL_SERVICE_TOKEN set per-test
via patch.dict for run-order determinism, same rationale documented in
test_coa_sections_endpoint.py's module docstring).

Storage mocking follows test_parent_attachment_capture.py's
`_FakePhotoStorage` + `set_storage_for_tests`/`get_storage` idiom (the
route imports `get_storage` locally from sub_samples.photo_storage inside
the function body, matching the download route's convention — so
`patch("main.get_storage")` would not reach it; swapping the module-level
singleton is the only idiom that does). A single fake covers both storage
backends at the route level — FilesystemPhotoStorage/S3PhotoStorage
themselves are unit-tested in test_photo_storage.py / test_s3_photo_
storage.py; this route only depends on the PhotoStorage.fetch_photo
protocol.
"""
import os
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from main import app
from database import get_db, Base
from models import LimsSample, LimsParentAttachment
from sub_samples.photo_storage import get_storage, set_storage_for_tests, PhotoNotFoundError

SVC_TOKEN = "test-internal-token"
SVC_TOKEN_HEADER = {"X-Service-Token": SVC_TOKEN}


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()


@pytest.fixture
def client(db_session):
    def _override_get_db():
        yield db_session

    prev_db = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = _override_get_db
    tc = TestClient(app)
    yield tc
    if prev_db is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev_db


class _FakePhotoStorage:
    """Records the key it was asked to fetch; returns canned bytes or raises
    PhotoNotFoundError, per-instance configurable."""

    def __init__(self, *, bytes_by_key=None, missing_keys=None):
        self.bytes_by_key = bytes_by_key or {}
        self.missing_keys = missing_keys or set()
        self.fetch_calls: list[str] = []

    def save_photo(self, sample_id, photo_bytes, filename):  # pragma: no cover - unused
        raise NotImplementedError

    def fetch_photo(self, key: str) -> bytes:
        self.fetch_calls.append(key)
        if key in self.missing_keys:
            raise PhotoNotFoundError(f"no photo at key={key!r}")
        return self.bytes_by_key[key]

    def delete_photo(self, key: str) -> None:  # pragma: no cover - unused
        raise NotImplementedError


@pytest.fixture
def fake_storage():
    prev = get_storage()
    fake = _FakePhotoStorage()
    set_storage_for_tests(fake)
    yield fake
    set_storage_for_tests(prev)


def _seed_sample_and_attachment(db, *, sample_id="TEST-S2S-01", **att_overrides):
    row = LimsSample(sample_id=sample_id, status="verified")
    db.add(row)
    db.flush()
    att_kwargs = dict(
        lims_sample_pk=row.id,
        kind="chromatogram",
        filename="c.csv",
        content_type="text/csv",
        storage="s3",
        storage_key="test/c.bin",
        render_in_report=False,
        attachment_type="HPLC Graph",
        created_by_user_id=None,
    )
    att_kwargs.update(att_overrides)
    att = LimsParentAttachment(**att_kwargs)
    db.add(att)
    db.commit()
    db.refresh(row)
    db.refresh(att)
    return row, att


def _url(sample_id, attachment_id):
    return f"/s2s/samples/{sample_id}/attachments/{attachment_id}"


def _get(client, sample_id, attachment_id, token=SVC_TOKEN):
    headers = {"X-Service-Token": token} if token else {}
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        return client.get(_url(sample_id, attachment_id), headers=headers)


def test_token_required_missing_header(client, db_session):
    row, att = _seed_sample_and_attachment(db_session)
    resp = _get(client, row.sample_id, att.id, token=None)
    assert resp.status_code in (401, 403)


def test_token_required_wrong_token(client, db_session):
    row, att = _seed_sample_and_attachment(db_session)
    resp = _get(client, row.sample_id, att.id, token="definitely-wrong")
    assert resp.status_code in (401, 403)


def test_serves_bytes_with_db_row_content_type_not_key_extension(client, db_session, fake_storage):
    """The storage key ends in '.bin' (chromatogram snapshot naming) but the
    DB row says text/csv — the response MUST reflect the row, proving the
    route never derives Content-Type from the key extension."""
    row, att = _seed_sample_and_attachment(db_session)
    fake_storage.bytes_by_key[att.storage_key] = b"a,b\n1,2\n"

    resp = _get(client, row.sample_id, att.id)

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/csv")
    assert "c.csv" in resp.headers.get("content-disposition", "")
    assert resp.content == b"a,b\n1,2\n"
    assert fake_storage.fetch_calls == [att.storage_key]


def test_404_unknown_attachment_id(client, db_session):
    row, _att = _seed_sample_and_attachment(db_session)
    resp = _get(client, row.sample_id, 999999)
    assert resp.status_code == 404


def test_404_on_sample_mismatch(client, db_session):
    """An attachment id that is real but belongs to a DIFFERENT sample_id
    must 404, not leak bytes cross-sample."""
    _row, att = _seed_sample_and_attachment(db_session, sample_id="TEST-S2S-OWNER")
    resp = _get(client, "TEST-S2S-OTHER", att.id)
    assert resp.status_code == 404


def test_404_on_non_s3_storage(client, db_session):
    """No SENAITE branch (R1): a non-'s3' row is a plain 404, not a proxy
    redirect/hint."""
    row, att = _seed_sample_and_attachment(db_session, storage="senaite")
    resp = _get(client, row.sample_id, att.id)
    assert resp.status_code == 404


def test_404_on_missing_object_in_storage(client, db_session, fake_storage):
    row, att = _seed_sample_and_attachment(db_session)
    fake_storage.missing_keys.add(att.storage_key)
    resp = _get(client, row.sample_id, att.id)
    assert resp.status_code == 404
