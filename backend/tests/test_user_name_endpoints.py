"""Endpoint coverage for user name fields: PATCH /auth/me, admin update,
directory, worksheets/users name passthrough."""
import pytest
from fastapi.testclient import TestClient

import auth
from main import app
from database import SessionLocal, get_db
from models import User


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def user(db):
    u = User(email="me@lab.test", hashed_password="x", role="standard", is_active=True)
    db.add(u); db.commit(); db.refresh(u)
    yield u
    db.delete(db.get(User, u.id)); db.commit()


@pytest.fixture
def client_as(db, user):
    """TestClient authed as `user`. Shares ONE session across the request and the
    test: get_db yields the fixture session and get_current_user returns the
    fixture user, so the endpoint's commit/refresh act on the same instance the
    test reads (mirrors production, where get_current_user fetches via get_db)."""
    prev_user = app.dependency_overrides.get(auth.get_current_user)
    prev_db = app.dependency_overrides.get(get_db)

    def _override_get_db():
        yield db

    app.dependency_overrides[auth.get_current_user] = lambda: user
    app.dependency_overrides[get_db] = _override_get_db
    yield TestClient(app)
    for dep, prev in ((auth.get_current_user, prev_user), (get_db, prev_db)):
        if prev is None:
            app.dependency_overrides.pop(dep, None)
        else:
            app.dependency_overrides[dep] = prev


def test_patch_me_sets_names(client_as, db, user):
    r = client_as.patch("/auth/me", json={"first_name": "Ada", "last_name": "Lovelace"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["first_name"] == "Ada" and body["last_name"] == "Lovelace"
    db.refresh(user)
    assert user.first_name == "Ada" and user.last_name == "Lovelace"


def test_patch_me_empty_string_clears_to_null(client_as, db, user):
    user.first_name = "Ada"; db.commit()
    r = client_as.patch("/auth/me", json={"first_name": ""})
    assert r.status_code == 200
    db.refresh(user)
    assert user.first_name is None


def test_patch_me_ignores_role_field(client_as, db, user):
    # MeUpdate has no role field — extra keys are ignored by pydantic, role unchanged.
    r = client_as.patch("/auth/me", json={"role": "admin", "first_name": "Ada"})
    assert r.status_code == 200
    db.refresh(user)
    assert user.role == "standard"
    assert user.first_name == "Ada"


def test_auth_me_returns_name_fields(client_as, db, user):
    user.first_name = "Ada"; db.commit()
    r = client_as.get("/auth/me")
    assert r.status_code == 200
    assert r.json()["first_name"] == "Ada"


def test_directory_lists_users_with_names(client_as, db, user):
    user.first_name = "Ada"; user.last_name = "Lovelace"; db.commit()
    r = client_as.get("/auth/directory")
    assert r.status_code == 200
    rows = r.json()
    mine = next(x for x in rows if x["email"] == "me@lab.test")
    assert mine["first_name"] == "Ada" and mine["last_name"] == "Lovelace"
    assert "id" in mine


def test_worksheets_users_includes_names(client_as, db, user):
    user.first_name = "Ada"; db.commit()
    r = client_as.get("/worksheets/users")
    assert r.status_code == 200
    mine = next(x for x in r.json() if x["email"] == "me@lab.test")
    assert mine["first_name"] == "Ada"
