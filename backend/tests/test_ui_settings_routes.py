"""/api/ui-settings/{key}: per-user page layout settings (spec 2026-10-27 tasks page, section 5)."""
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from auth import get_current_user
from database import Base, get_db
from models import User, UserUiSetting
from ui_settings.routes import router


@pytest.fixture
def Session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    s.add_all([
        User(id=1, email="one@x.example", hashed_password="x", role="standard"),
        User(id=2, email="two@x.example", hashed_password="x", role="standard"),
    ])
    s.commit()
    s.close()
    return Session


@pytest.fixture
def session(Session):
    s = Session()
    yield s
    s.close()


@pytest.fixture
def current_user_id():
    return [1]


@pytest.fixture
def client(Session, current_user_id):
    app = FastAPI()
    app.include_router(router)

    def _db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=current_user_id[0])
    return TestClient(app)


@pytest.fixture
def as_user(current_user_id):
    def switch(user_id: int) -> None:
        current_user_id[0] = user_id
    return switch


def test_get_unsaved_key_returns_null_value(client):
    r = client.get("/api/ui-settings/tasks.page")
    assert r.status_code == 200 and r.json() == {"key": "tasks.page", "value": None}


def test_put_then_get_round_trips_unknown_nested_keys(client):
    v = {"v": 1, "tab": "raised", "extra": {"a": [1, 2]}}
    assert client.put("/api/ui-settings/tasks.page", json={"value": v}).json() == {"key": "tasks.page", "value": v}
    assert client.get("/api/ui-settings/tasks.page").json()["value"] == v


def test_put_upserts_one_row(client, session):
    client.put("/api/ui-settings/tasks.page", json={"value": {"tab": "a"}})
    client.put("/api/ui-settings/tasks.page", json={"value": {"tab": "b"}})
    rows = session.query(UserUiSetting).all()
    assert len(rows) == 1 and rows[0].value == {"tab": "b"}


def test_unknown_key_is_400(client):
    assert client.get("/api/ui-settings/other.page").status_code == 400
    assert client.put("/api/ui-settings/other.page", json={"value": {}}).status_code == 400


def test_non_object_value_is_422(client):
    assert client.put("/api/ui-settings/tasks.page", json={"value": [1, 2]}).status_code == 422
    assert client.put("/api/ui-settings/tasks.page", json={"value": "x"}).status_code == 422


def test_oversize_value_is_413(client):
    assert client.put("/api/ui-settings/tasks.page", json={"value": {"x": "a" * 16500}}).status_code == 413


def test_settings_are_per_user(client, as_user):
    client.put("/api/ui-settings/tasks.page", json={"value": {"tab": "raised"}})
    as_user(2)
    assert client.get("/api/ui-settings/tasks.page").json()["value"] is None
