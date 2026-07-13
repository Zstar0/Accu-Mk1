"""Route tests for the capture-token endpoints.

Mirrors the fixture pattern in test_packaging_photos_routes.py: an in-memory
SQLite session (StaticPool so the table stays visible across the ASGI thread
boundary) + the filesystem PhotoStorage swapped under a tmp dir, plus the
get_current_user override for the two JWT-authed routes. The two phone
routes (GET /api/capture/{token}, POST /api/capture/{token}/photos) carry no
auth dependency, so popping the override must not affect them.
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
from capture_tokens import service as capture_service


_JPEG = b"\xff\xd8\xff\xe0hello-capture"
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
    set_storage_for_tests(FilesystemPhotoStorage(root=str(tmp_path / "capture")))

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
def two_samples(client):
    db = client._session
    p1 = LimsSample(sample_id="P-1000", external_lims_uid="u-1000")
    p2 = LimsSample(sample_id="P-1001", external_lims_uid="u-1001")
    db.add_all([p1, p2])
    db.commit()
    return p1, p2


def _mint(client, sample_ids, order_label=None):
    return client.post("/api/capture-tokens", json={
        "samples": [{"sample_id": sid} for sid in sample_ids],
        "order_label": order_label,
    })


def test_mint_201_returns_raw_token_once(client, two_samples):
    p1, p2 = two_samples
    resp = _mint(client, [p1.sample_id, p2.sample_id], "WP-100")
    assert resp.status_code == 201
    body = resp.json()
    assert body["id"] > 0
    assert isinstance(body["token"], str) and len(body["token"]) > 20
    assert "expires_at" in body


def test_mint_404_on_unknown_sample_id(client, two_samples):
    p1, _ = two_samples
    resp = _mint(client, [p1.sample_id, "NOPE"])
    assert resp.status_code == 404
    assert "NOPE" in resp.json()["detail"]


def test_get_context_200_with_zero_photo_count(client, two_samples):
    p1, p2 = two_samples
    raw = _mint(client, [p1.sample_id, p2.sample_id], "WP-200").json()["token"]
    resp = client.get(f"/api/capture/{raw}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["order_label"] == "WP-200"
    assert body["photo_count"] == 0
    assert {s["sample_id"] for s in body["samples"]} == {p1.sample_id, p2.sample_id}


def test_get_context_404_unknown_token(client):
    resp = client.get("/api/capture/not-a-real-token")
    assert resp.status_code == 404


def test_get_context_410_expired(client, two_samples, monkeypatch):
    p1, _ = two_samples
    monkeypatch.setattr(capture_service, "CAPTURE_TOKEN_TTL_HOURS", -1)
    raw = _mint(client, [p1.sample_id]).json()["token"]
    resp = client.get(f"/api/capture/{raw}")
    assert resp.status_code == 410


def test_post_photo_fans_out_to_all_samples(client, two_samples):
    p1, p2 = two_samples
    raw = _mint(client, [p1.sample_id, p2.sample_id]).json()["token"]
    resp = client.post(f"/api/capture/{raw}/photos", json={"photo_base64": _B64})
    assert resp.status_code == 201
    body = resp.json()
    assert body["created"] == 2
    assert body["photo_count"] == 1
    for p in (p1, p2):
        rows = client.get(f"/api/samples/{p.sample_id}/packaging-photos").json()
        assert len(rows) == 1


def test_post_photo_413_oversize(client, two_samples):
    p1, _ = two_samples
    raw = _mint(client, [p1.sample_id]).json()["token"]
    big = base64.b64encode(b"\xff\xd8\xff" + b"0" * (10 * 1024 * 1024)).decode()
    resp = client.post(f"/api/capture/{raw}/photos", json={"photo_base64": big})
    assert resp.status_code == 413


def test_post_photo_415_bad_magic_bytes(client, two_samples):
    p1, _ = two_samples
    raw = _mint(client, [p1.sample_id]).json()["token"]
    bad = base64.b64encode(b"not-an-image").decode()
    resp = client.post(f"/api/capture/{raw}/photos", json={"photo_base64": bad})
    assert resp.status_code == 415


def test_post_photo_429_after_shot_cap(client, two_samples, monkeypatch):
    p1, _ = two_samples
    monkeypatch.setattr(capture_service, "MAX_PHOTOS_PER_TOKEN", 1)
    raw = _mint(client, [p1.sample_id]).json()["token"]
    first = client.post(f"/api/capture/{raw}/photos", json={"photo_base64": _B64})
    assert first.status_code == 201
    second = client.post(f"/api/capture/{raw}/photos", json={"photo_base64": _B64})
    assert second.status_code == 429


def test_delete_then_get_context_410(client, two_samples):
    p1, _ = two_samples
    minted = _mint(client, [p1.sample_id]).json()
    resp = client.delete(f"/api/capture-tokens/{minted['id']}")
    assert resp.status_code == 204
    assert client.get(f"/api/capture/{minted['token']}").status_code == 410


def test_delete_is_idempotent(client, two_samples):
    p1, _ = two_samples
    minted = _mint(client, [p1.sample_id]).json()
    assert client.delete(f"/api/capture-tokens/{minted['id']}").status_code == 204
    assert client.delete(f"/api/capture-tokens/{minted['id']}").status_code == 204


def test_public_routes_work_without_auth_override(client, two_samples):
    p1, _ = two_samples
    raw = _mint(client, [p1.sample_id]).json()["token"]
    app.dependency_overrides.pop(get_current_user, None)
    resp = client.get(f"/api/capture/{raw}")
    assert resp.status_code == 200
