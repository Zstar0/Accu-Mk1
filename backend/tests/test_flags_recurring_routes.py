import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


def _make_client(role):
    from fastapi.testclient import TestClient
    from main import app
    from auth import get_current_user
    from database import get_db, Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    from flags import types_service

    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    shared = Session()
    types_service.seed_builtins(shared)  # includes a global "task" type

    def _db():
        yield shared
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=1, role=role, email="t@x.t")
    tc = TestClient(app)
    tc._session = shared  # type: ignore[attr-defined]
    return tc


@pytest.fixture
def client_admin():
    from main import app
    from auth import get_current_user
    from database import get_db
    tc = _make_client("admin")
    yield tc
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    tc._session.close()


@pytest.fixture
def client_standard():
    from main import app
    from auth import get_current_user
    from database import get_db
    tc = _make_client("standard")
    yield tc
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    tc._session.close()


def test_create_requires_admin(client_standard):
    r = client_standard.post("/api/flags/recurring",
                             json={"title": "x", "type": "task", "cadence": "daily"})
    assert r.status_code == 403


def test_admin_crud_roundtrip(client_admin):
    r = client_admin.post("/api/flags/recurring",
                          json={"title": "Calibrate", "type": "task",
                                "cadence": "weekly:0", "watchers": [3]})
    assert r.status_code == 201
    rid = r.json()["id"]
    assert r.json()["cadence"] == "weekly:0" and r.json()["active"] is True
    assert client_admin.get("/api/flags/recurring").json()[0]["id"] == rid
    assert client_admin.put(f"/api/flags/recurring/{rid}",
                            json={"active": False}).json()["active"] is False
    assert client_admin.delete(f"/api/flags/recurring/{rid}").status_code == 204


def test_bad_cadence_400(client_admin):
    r = client_admin.post("/api/flags/recurring",
                          json={"title": "x", "type": "task", "cadence": "hourly"})
    assert r.status_code == 400
