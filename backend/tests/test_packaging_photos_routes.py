"""Route tests for the packaging-photo endpoints.

Stateful integration style: an in-memory SQLite session (StaticPool so the
table stays visible across the ASGI thread boundary) + the filesystem
PhotoStorage swapped under a tmp dir, so DELETE-then-GET reflects real storage.
Mirrors the fixture pattern in test_promote_writeback_route.py and the auth
override in test_boxes_routes.py.
"""
import base64

import pytest
from unittest.mock import MagicMock
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from main import app
from auth import get_current_user
from database import Base, get_db
from models import LimsSample
from sub_samples import photo_storage
from sub_samples.photo_storage import FilesystemPhotoStorage, set_storage_for_tests


# A JPEG-magic payload; the served Content-Type derives from the stored key's
# extension (sniffed from these bytes at create), NOT the body's content_type.
_JPEG = b"\xff\xd8\xff\xe0hello-packaging"
_B64 = base64.b64encode(_JPEG).decode()


@pytest.fixture
def client(tmp_path):
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    shared_session = Session()

    def _override_get_db():
        yield shared_session

    prev_storage = photo_storage.get_storage()
    set_storage_for_tests(FilesystemPhotoStorage(root=str(tmp_path / "packaging")))

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=7)

    tc = TestClient(app)
    tc._session = shared_session
    yield tc

    if prev_db is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev_db
    if prev_user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = prev_user
    set_storage_for_tests(prev_storage)
    shared_session.close()


@pytest.fixture
def parent(client):
    db = client._session
    p = LimsSample(sample_id="P-0800", external_lims_uid="u-800")
    db.add(p)
    db.commit()
    return p


@pytest.fixture
def two_parents(client):
    db = client._session
    p1 = LimsSample(sample_id="P-0900", external_lims_uid="u-900")
    p2 = LimsSample(sample_id="P-0901", external_lims_uid="u-901")
    db.add_all([p1, p2])
    db.commit()
    return p1, p2


def _create(client, sample_id="P-0800", remarks=None):
    return client.post(
        f"/api/samples/{sample_id}/packaging-photos",
        json={"photo_base64": _B64, "content_type": "image/jpeg", "remarks": remarks},
    )


def test_post_creates(client, parent):
    resp = _create(client, remarks="front label")
    assert resp.status_code == 201
    body = resp.json()
    assert body["id"] > 0
    assert body["ordering"] == 0
    assert body["remarks"] == "front label"
    assert body["content_type"] == "image/jpeg"
    assert body["created_by_user_id"] == 7


def test_get_list_ordered(client, parent):
    _create(client, remarks="a")
    _create(client, remarks="b")
    _create(client, remarks="c")
    resp = client.get("/api/samples/P-0800/packaging-photos")
    assert resp.status_code == 200
    rows = resp.json()
    assert [r["remarks"] for r in rows] == ["a", "b", "c"]
    assert [r["ordering"] for r in rows] == [0, 1, 2]


def test_get_bytes_returns_derived_content_type(client, parent):
    pid = _create(client).json()["id"]
    resp = client.get(f"/api/packaging-photos/{pid}")
    assert resp.status_code == 200
    # image/jpeg because the stored key ends .jpg (sniffed from the bytes),
    # not because the create body said so.
    assert resp.headers["content-type"] == "image/jpeg"
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert resp.headers["content-disposition"].startswith('inline; filename="')
    assert resp.content == _JPEG


def test_get_bytes_ignores_client_content_type(client, parent):
    # A lying content_type (stored-XSS attempt) must not be echoed back; the
    # served type comes from the stored key's extension (.png via byte sniff).
    png = b"\x89PNG\r\n\x1a\n" + b"not-really-a-png-but-magic-says-so"
    resp = client.post(
        "/api/samples/P-0800/packaging-photos",
        json={"photo_base64": base64.b64encode(png).decode(), "content_type": "text/html"},
    )
    assert resp.status_code == 201
    pid = resp.json()["id"]
    r = client.get(f"/api/packaging-photos/{pid}")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert r.headers["x-content-type-options"] == "nosniff"


def test_patch_updates_remarks(client, parent):
    pid = _create(client, remarks="old").json()["id"]
    resp = client.patch(f"/api/packaging-photos/{pid}", json={"remarks": "new"})
    assert resp.status_code == 200
    assert resp.json()["remarks"] == "new"


def test_delete_then_get_bytes_404(client, parent):
    pid = _create(client).json()["id"]
    resp = client.delete(f"/api/packaging-photos/{pid}")
    assert resp.status_code == 204
    assert resp.content == b""
    assert client.get(f"/api/packaging-photos/{pid}").status_code == 404


def test_unauthenticated_rejected(client, parent):
    # Drop the auth override so the real Bearer/JWT dependency runs.
    app.dependency_overrides.pop(get_current_user, None)
    resp = client.get("/api/samples/P-0800/packaging-photos")
    assert resp.status_code in (401, 403)


def test_post_unknown_parent_404(client):
    resp = _create(client, sample_id="NOPE")
    assert resp.status_code == 404


def test_get_unknown_photo_404(client, parent):
    assert client.get("/api/packaging-photos/9999").status_code == 404


def test_patch_unknown_photo_404(client, parent):
    resp = client.patch("/api/packaging-photos/9999", json={"remarks": "x"})
    assert resp.status_code == 404


def test_delete_unknown_photo_404(client, parent):
    assert client.delete("/api/packaging-photos/9999").status_code == 404


def test_bulk_route_creates_on_all_parents(client, two_parents):
    p1, p2 = two_parents
    resp = client.post("/api/packaging-photos/bulk", json={
        "parent_sample_ids": [p1.sample_id, p2.sample_id],
        "photo_base64": base64.b64encode(b"\xff\xd8\xffbulk").decode(),
        "remarks": "box",
    })
    assert resp.status_code == 201
    body = resp.json()
    assert len(body) == 2
    # PackagingPhotoOut has no parent_sample_id column, so confirm the fan-out
    # landed on both parents via a follow-up per-parent list instead.
    for p in (p1, p2):
        rows = client.get(f"/api/samples/{p.sample_id}/packaging-photos").json()
        assert len(rows) == 1
        assert rows[0]["remarks"] == "box"


def test_bulk_route_404_names_missing(client, two_parents):
    p1, _ = two_parents
    resp = client.post("/api/packaging-photos/bulk", json={
        "parent_sample_ids": [p1.sample_id, "NOPE"],
        "photo_base64": base64.b64encode(b"\xff\xd8\xffx").decode(),
    })
    assert resp.status_code == 404
    assert "NOPE" in resp.json()["detail"]
