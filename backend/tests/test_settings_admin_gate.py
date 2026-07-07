"""Server-side admin gate for admin-only settings keys.

The checkin_multi_order_enabled toggle is admin-only in the UI; these tests
pin the server-side enforcement (main.ADMIN_ONLY_SETTING_KEYS) so the gate
can't be bypassed by calling the API directly. Fixture pattern mirrors
test_packaging_photos_routes.py (StaticPool sqlite + dependency overrides).
"""
import pytest
from unittest.mock import MagicMock
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from main import app
from auth import get_current_user
from database import Base, get_db

ADMIN_KEY = "checkin_multi_order_enabled"


@pytest.fixture
def client():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    shared_session = sessionmaker(bind=engine)()

    def _override_get_db():
        yield shared_session

    prev_db = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = _override_get_db

    tc = TestClient(app)
    yield tc

    if prev_db is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev_db
    app.dependency_overrides.pop(get_current_user, None)
    shared_session.close()


def _as(role):
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1, role=role)


def test_non_admin_put_admin_key_403(client):
    _as("standard")
    resp = client.put(f"/settings/{ADMIN_KEY}", json={"value": "true"})
    assert resp.status_code == 403


def test_admin_put_admin_key_200(client):
    _as("admin")
    resp = client.put(f"/settings/{ADMIN_KEY}", json={"value": "true"})
    assert resp.status_code == 200
    assert resp.json()["value"] == "true"


def test_non_admin_put_generic_key_still_allowed(client):
    _as("standard")
    resp = client.put("/settings/some_generic_key", json={"value": "x"})
    assert resp.status_code == 200
    assert resp.json()["value"] == "x"


def test_non_admin_delete_admin_key_403(client):
    _as("admin")
    assert client.put(f"/settings/{ADMIN_KEY}", json={"value": "true"}).status_code == 200
    _as("standard")
    resp = client.delete(f"/settings/{ADMIN_KEY}")
    assert resp.status_code == 403
    # Still there for the admin.
    _as("admin")
    assert client.get(f"/settings/{ADMIN_KEY}").status_code == 200


def test_admin_delete_admin_key_200(client):
    _as("admin")
    assert client.put(f"/settings/{ADMIN_KEY}", json={"value": "true"}).status_code == 200
    resp = client.delete(f"/settings/{ADMIN_KEY}")
    assert resp.status_code == 200
