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


# A one-pixel JPEG-magic payload; content-type is carried explicitly in the body.
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


def test_get_bytes_returns_content_type(client, parent):
    pid = _create(client).json()["id"]
    resp = client.get(f"/api/packaging-photos/{pid}")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/jpeg"
    assert resp.content == _JPEG


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
