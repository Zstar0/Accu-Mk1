import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from main import app
    from auth import get_current_user
    from database import get_db, Base
    import models  # noqa: F401
    import flags.models  # noqa: F401

    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    shared = Session()

    def _db():
        yield shared
    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=42, role="standard", email="t@x.t")
    tc = TestClient(app)
    yield tc
    app.dependency_overrides.pop(get_db, None) if prev_db is None else app.dependency_overrides.__setitem__(get_db, prev_db)
    app.dependency_overrides.pop(get_current_user, None) if prev_user is None else app.dependency_overrides.__setitem__(get_current_user, prev_user)
    shared.close()


def test_get_defaults_when_no_row(client):
    r = client.get("/api/slack-prefs")
    assert r.status_code == 200
    body = r.json()
    assert body["enabled"] is True and body["linked"] is False
    assert body["slack_display_name"] is None
    assert all(body[f"notify_{c}"] is True for c in
               ("assigned", "mentioned", "raised_activity",
                "watching_activity", "status_changes"))


def test_put_upserts_and_persists(client):
    r = client.put("/api/slack-prefs",
                   json={"notify_watching_activity": False,
                         "slack_member_id": "U777"})
    assert r.status_code == 200
    r2 = client.get("/api/slack-prefs")
    assert r2.json()["notify_watching_activity"] is False
    assert r2.json()["linked"] is True


def test_test_endpoint_without_token_reports_not_configured(client, monkeypatch):
    monkeypatch.delenv("MK1_SLACK_BOT_TOKEN", raising=False)
    r = client.post("/api/slack-prefs/test")
    assert r.status_code == 200
    assert r.json()["ok"] is False
    assert "not configured" in r.json()["detail"].lower()
