"""Sub-sample image attachments + vial photo remove/replace.

Service tests use the shared in-memory db_session fixture plus a tmp_path
photo store. Route tests mock the service layer per the project pattern.

Design: docs/superpowers/specs/2026-06-11-subsample-attachments-design.md
"""
from __future__ import annotations

import pytest
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from main import app
from auth import get_current_user
from models import LimsSample, LimsSubSample, LimsSubSampleAttachment, LimsSubSampleEvent
from sub_samples import service
from sub_samples.photo_storage import (
    FilesystemPhotoStorage,
    get_storage,
    set_storage_for_tests,
)

client = TestClient(app)


@pytest.fixture(autouse=True)
def override_auth():
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    yield
    app.dependency_overrides.pop(get_current_user, None)


@pytest.fixture
def storage(tmp_path):
    """Swap the photo-store singleton for a tmp_path-backed one."""
    prev = get_storage()
    fs = FilesystemPhotoStorage(root=str(tmp_path))
    set_storage_for_tests(fs)
    yield fs
    set_storage_for_tests(prev)


def _make_parent(db, sample_id="P-TEST-001"):
    parent = LimsSample(sample_id=sample_id, external_lims_uid="SENAITE-PARENT")
    db.add(parent)
    db.flush()
    return parent


def _make_sub(db, parent, sample_id="P-TEST-001-S01", uid="SENAITE-SUB",
              photo_uid=None, vial_seq=1):
    sub = LimsSubSample(
        sample_id=sample_id,
        parent_sample_pk=parent.id,
        vial_sequence=vial_seq,
        external_lims_uid=uid,
        photo_external_uid=photo_uid,
    )
    db.add(sub)
    db.flush()
    return sub


def _native_sub_with_photo(db, storage, sample_id="P-TEST-001-S01"):
    """Native vial whose check-in photo is a real file in the tmp store."""
    parent = _make_parent(db)
    key = storage.save_photo(sample_id, b"original-photo", "vial.jpg")
    sub = _make_sub(db, parent, sample_id=sample_id,
                    uid="mk1://deadbeef", photo_uid=f"mk1://{key}")
    return sub, key


# ── add / list / get / delete attachments (service) ──────────────────────────


def test_add_attachment_persists_row_file_and_event(db_session, storage):
    sub, _ = _native_sub_with_photo(db_session, storage)

    att = service.add_attachment(
        db_session, sub.sample_id, b"extra-image", "side-label.png", user_id=7
    )

    assert att.filename == "side-label.png"
    assert att.content_type == "image/png"
    assert storage.fetch_photo(att.storage_key) == b"extra-image"
    events = db_session.query(LimsSubSampleEvent).filter_by(
        sub_sample_pk=sub.id, event="attachment_added").all()
    assert len(events) == 1
    assert events[0].details == {"filename": "side-label.png"}
    assert events[0].user_id == 7


def test_add_attachment_rejects_non_image_extension(db_session, storage):
    sub, _ = _native_sub_with_photo(db_session, storage)
    with pytest.raises(ValueError, match="unsupported image type"):
        service.add_attachment(db_session, sub.sample_id, b"%PDF-1.7", "report.pdf")
    with pytest.raises(ValueError, match="unsupported image type"):
        service.add_attachment(db_session, sub.sample_id, b"x", "noext")


def test_add_attachment_unknown_sample_raises_lookup(db_session, storage):
    with pytest.raises(LookupError):
        service.add_attachment(db_session, "NOPE-S01", b"x", "a.png")


def test_list_attachments_ordered_and_scoped(db_session, storage):
    sub, _ = _native_sub_with_photo(db_session, storage)
    other = _make_sub(db_session, sub.parent_sample, sample_id="P-TEST-001-S02",
                      uid="mk1://other", vial_seq=2)
    a1 = service.add_attachment(db_session, sub.sample_id, b"1", "a.png")
    a2 = service.add_attachment(db_session, sub.sample_id, b"2", "b.jpg")
    service.add_attachment(db_session, other.sample_id, b"3", "c.png")

    listed = service.list_attachments(db_session, sub.sample_id)
    assert [a.id for a in listed] == [a1.id, a2.id]


def test_get_attachment_wrong_sample_raises_lookup(db_session, storage):
    sub, _ = _native_sub_with_photo(db_session, storage)
    other = _make_sub(db_session, sub.parent_sample, sample_id="P-TEST-001-S02",
                      uid="mk1://other", vial_seq=2)
    att = service.add_attachment(db_session, sub.sample_id, b"1", "a.png")
    with pytest.raises(LookupError):
        service.get_attachment(db_session, other.sample_id, att.id)


def test_delete_attachment_removes_row_file_and_writes_event(db_session, storage):
    sub, _ = _native_sub_with_photo(db_session, storage)
    att = service.add_attachment(db_session, sub.sample_id, b"1", "a.png")
    key = att.storage_key

    service.delete_attachment(db_session, sub.sample_id, att.id, user_id=7)

    assert db_session.query(LimsSubSampleAttachment).count() == 0
    from sub_samples.photo_storage import PhotoNotFoundError
    with pytest.raises(PhotoNotFoundError):
        storage.fetch_photo(key)
    events = db_session.query(LimsSubSampleEvent).filter_by(
        sub_sample_pk=sub.id, event="attachment_removed").all()
    assert len(events) == 1
    # double delete → LookupError (row already gone)
    with pytest.raises(LookupError):
        service.delete_attachment(db_session, sub.sample_id, att.id)


# ── make-primary swap (service) ───────────────────────────────────────────────


def test_make_primary_swaps_photo_and_demotes_old(db_session, storage):
    sub, old_key = _native_sub_with_photo(db_session, storage)
    att = service.add_attachment(db_session, sub.sample_id, b"better-shot", "front.png")
    promoted_key = att.storage_key

    out = service.set_primary_attachment(db_session, sub.sample_id, att.id, user_id=7)

    # Promoted attachment's key now IS the photo; its row is consumed.
    assert out.photo_external_uid == f"mk1://{promoted_key}"
    remaining = db_session.query(LimsSubSampleAttachment).all()
    assert len(remaining) == 1
    # The old check-in photo survives as a regular attachment, file intact.
    demoted = remaining[0]
    assert demoted.storage_key == old_key
    assert storage.fetch_photo(old_key) == b"original-photo"
    events = db_session.query(LimsSubSampleEvent).filter_by(
        sub_sample_pk=sub.id, event="photo_primary_changed").all()
    assert len(events) == 1
    assert events[0].details == {"filename": "front.png", "demoted_previous": True}


def test_make_primary_with_no_existing_photo(db_session, storage):
    parent = _make_parent(db_session)
    sub = _make_sub(db_session, parent, uid="mk1://deadbeef", photo_uid=None)
    att = service.add_attachment(db_session, sub.sample_id, b"shot", "a.png")

    out = service.set_primary_attachment(db_session, sub.sample_id, att.id)

    assert out.photo_external_uid == f"mk1://{att.storage_key}"
    # Nothing to demote — no attachment rows remain.
    assert db_session.query(LimsSubSampleAttachment).count() == 0


def test_make_primary_blocked_on_legacy_senaite_photo(db_session, storage):
    parent = _make_parent(db_session)
    sub = _make_sub(db_session, parent, uid="SENAITE-SUB",
                    photo_uid="/senaite/clients/client-8/P-TEST-001-S01")
    att = service.add_attachment(db_session, sub.sample_id, b"shot", "a.png")

    with pytest.raises(service.PhotoNotMk1Error):
        service.set_primary_attachment(db_session, sub.sample_id, att.id)
    # Nothing changed: photo untouched, attachment still a regular row.
    assert sub.photo_external_uid == "/senaite/clients/client-8/P-TEST-001-S01"
    assert db_session.query(LimsSubSampleAttachment).count() == 1


# ── vial photo remove (service) ───────────────────────────────────────────────


def test_delete_photo_nulls_key_removes_file_writes_event(db_session, storage):
    sub, key = _native_sub_with_photo(db_session, storage)

    out = service.delete_sub_sample_photo(db_session, sub.sample_id, user_id=7)

    assert out.photo_external_uid is None
    from sub_samples.photo_storage import PhotoNotFoundError
    with pytest.raises(PhotoNotFoundError):
        storage.fetch_photo(key)
    events = db_session.query(LimsSubSampleEvent).filter_by(
        sub_sample_pk=sub.id, event="photo_removed").all()
    assert len(events) == 1


def test_delete_photo_idempotent_when_already_gone(db_session, storage):
    parent = _make_parent(db_session)
    sub = _make_sub(db_session, parent, uid="mk1://deadbeef", photo_uid=None)
    out = service.delete_sub_sample_photo(db_session, sub.sample_id)
    assert out.photo_external_uid is None
    assert db_session.query(LimsSubSampleEvent).count() == 0


def test_delete_photo_legacy_senaite_path_raises(db_session, storage):
    parent = _make_parent(db_session)
    sub = _make_sub(db_session, parent, uid="SENAITE-SUB",
                    photo_uid="/senaite/clients/client-8/P-TEST-001-S01")
    with pytest.raises(service.PhotoNotMk1Error):
        service.delete_sub_sample_photo(db_session, sub.sample_id)
    assert sub.photo_external_uid is not None


# ── vial photo replace via update_sub_sample (service) ───────────────────────


def test_update_native_photo_swaps_key_deletes_old_no_senaite(db_session, storage):
    sub, old_key = _native_sub_with_photo(db_session, storage)

    with patch("sub_samples.service.senaite.upload_photo") as up:
        out = service.update_sub_sample(
            db_session, sub.sample_id, b"new-photo", "vial.jpg", None, user_id=7
        )

    up.assert_not_called()
    assert out.photo_external_uid.startswith("mk1://")
    new_key = out.photo_external_uid[len("mk1://"):]
    assert new_key != old_key
    assert storage.fetch_photo(new_key) == b"new-photo"
    from sub_samples.photo_storage import PhotoNotFoundError
    with pytest.raises(PhotoNotFoundError):
        storage.fetch_photo(old_key)
    events = db_session.query(LimsSubSampleEvent).filter_by(
        sub_sample_pk=sub.id, event="photo_updated").all()
    assert len(events) == 1


def test_update_photo_after_removal_takes_mk1_branch(db_session, storage):
    """A native vial whose photo was removed gets a fresh Mk1 photo on replace
    (regression: NULL photo_external_uid used to fall into the SENAITE branch)."""
    parent = _make_parent(db_session)
    sub = _make_sub(db_session, parent, uid="mk1://deadbeef", photo_uid=None)

    with patch("sub_samples.service.senaite.upload_photo") as up:
        out = service.update_sub_sample(
            db_session, sub.sample_id, b"fresh", "vial.jpg", None
        )

    up.assert_not_called()
    assert out.photo_external_uid.startswith("mk1://")
    assert storage.fetch_photo(out.photo_external_uid[len("mk1://"):]) == b"fresh"


def test_update_legacy_photo_still_goes_to_senaite(db_session, storage):
    parent = _make_parent(db_session)
    sub = _make_sub(db_session, parent, uid="SENAITE-SUB",
                    photo_uid="/senaite/clients/client-8/P-TEST-001-S01")

    with patch("sub_samples.service.senaite.upload_photo") as up:
        service.update_sub_sample(
            db_session, sub.sample_id, b"new-photo", "vial.jpg", None
        )

    up.assert_called_once()
    assert sub.photo_external_uid == "/senaite/clients/client-8/P-TEST-001-S01"


# ── route wiring ──────────────────────────────────────────────────────────────


def test_route_list_attachments_200():
    att = MagicMock(id=3, filename="a.png", content_type="image/png")
    att.created_at = __import__("datetime").datetime.utcnow()
    with patch("sub_samples.routes.service.list_attachments", return_value=[att]):
        resp = client.get("/api/sub-samples/P-1-S01/attachments")
    assert resp.status_code == 200
    body = resp.json()
    assert body["attachments"][0]["id"] == 3
    assert body["attachments"][0]["content_type"] == "image/png"
    # Mocked att has no real int user_id — the int-guard skips resolution.
    assert body["attachments"][0]["created_by"] is None


def test_route_list_attachments_resolves_created_by():
    # Local StaticPool session (not the conftest db_session): TestClient runs
    # the route on another thread, which plain in-memory SQLite rejects.
    # Mirrors the fixture in test_packaging_photos_routes.py.
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool
    from database import Base, get_db
    from models import User

    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    db.add(User(id=1, email="ada@lab.test", hashed_password="x",
                first_name="Ada", last_name="Lovelace"))
    db.commit()

    def _override_db():
        yield db

    att = MagicMock(id=3, filename="a.png", content_type="image/png", user_id=1)
    att.created_at = __import__("datetime").datetime.utcnow()
    app.dependency_overrides[get_db] = _override_db
    try:
        with patch("sub_samples.routes.service.list_attachments",
                   return_value=[att]):
            resp = client.get("/api/sub-samples/P-1-S01/attachments")
    finally:
        app.dependency_overrides.pop(get_db, None)
    assert resp.status_code == 200
    assert resp.json()["attachments"][0]["created_by"] == "Ada Lovelace"


def test_route_list_attachments_404_unknown_sample():
    with patch("sub_samples.routes.service.list_attachments",
               side_effect=LookupError("sub-sample NOPE not found")):
        resp = client.get("/api/sub-samples/NOPE/attachments")
    assert resp.status_code == 404


def test_route_add_attachment_decodes_base64_and_passes_user():
    att = MagicMock(id=3, filename="a.png", content_type="image/png")
    att.created_at = __import__("datetime").datetime.utcnow()
    with patch("sub_samples.routes.service.add_attachment", return_value=att) as svc:
        resp = client.post(
            "/api/sub-samples/P-1-S01/attachments",
            json={"image_base64": "YWJj", "filename": "a.png"},
        )
    assert resp.status_code == 201
    args = svc.call_args.args
    assert args[2] == b"abc"
    assert args[3] == "a.png"
    assert svc.call_args.kwargs["user_id"] == 1


def test_route_add_attachment_400_on_non_image():
    with patch("sub_samples.routes.service.add_attachment",
               side_effect=ValueError("unsupported image type .pdf")):
        resp = client.post(
            "/api/sub-samples/P-1-S01/attachments",
            json={"image_base64": "YWJj", "filename": "report.pdf"},
        )
    assert resp.status_code == 400


def test_route_delete_photo_204():
    with patch("sub_samples.routes.service.delete_sub_sample_photo") as svc:
        resp = client.delete("/api/sub-samples/P-1-S01/photo")
    assert resp.status_code == 204
    assert svc.call_args.kwargs["user_id"] == 1


def test_route_delete_photo_409_on_legacy():
    with patch("sub_samples.routes.service.delete_sub_sample_photo",
               side_effect=service.PhotoNotMk1Error("legacy")):
        resp = client.delete("/api/sub-samples/P-1-S01/photo")
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "photo_not_mk1"


def test_route_make_primary_200():
    sub = MagicMock()
    sub.id = 1
    sub.sample_id = "P-1-S01"
    sub.vial_sequence = 1
    sub.received_at = __import__("datetime").datetime.utcnow()
    sub.received_by_user_id = 1
    sub.photo_external_uid = "mk1://P-1-S01/promoted.png"
    sub.remarks = None
    sub.assignment_role = None
    sub.assignment_kind = None
    sub.external_lims_uid = "mk1://deadbeef"
    sub.parent_sample = MagicMock(sample_id="P-1")
    with patch("sub_samples.routes.service.set_primary_attachment",
               return_value=sub) as svc:
        resp = client.post("/api/sub-samples/P-1-S01/attachments/3/make-primary")
    assert resp.status_code == 200
    assert resp.json()["photo_external_uid"] == "mk1://P-1-S01/promoted.png"
    assert svc.call_args.kwargs["user_id"] == 1


def test_route_make_primary_409_on_legacy():
    with patch("sub_samples.routes.service.set_primary_attachment",
               side_effect=service.PhotoNotMk1Error("legacy")):
        resp = client.post("/api/sub-samples/P-1-S01/attachments/3/make-primary")
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "photo_not_mk1"


def test_route_stream_attachment_bytes(db_session, storage):
    """End-to-end-ish: real storage behind a mocked service lookup."""
    key = storage.save_photo("P-1-S01", b"img-bytes", "a.png")
    att = MagicMock(storage_key=key, content_type="image/png")
    with patch("sub_samples.routes.service.get_attachment", return_value=att):
        resp = client.get("/api/sub-samples/P-1-S01/attachments/3")
    assert resp.status_code == 200
    assert resp.content == b"img-bytes"
    assert resp.headers["content-type"].startswith("image/png")
