"""/admin/integrations: admin only, allowlist, test-before-store, never echo the value (spec 3.4, 4, 8)."""
import base64
from unittest.mock import MagicMock

import httpx
import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from auth import get_current_user
from database import Base, get_db
from integration_keys import registry, routes, store
from models import IntegrationKey, IntegrationKeyEvent, User

GOOD, BAD = "close_good_key_a3f9", "close_bad_key_0000"


def provider(req: httpx.Request) -> httpx.Response:
    """Fake Close/Plain/Anthropic: the key's text decides the answer (Close sends it as Basic auth)."""
    header = req.headers.get("authorization", "")
    key = req.headers.get("x-api-key", "") or header.removeprefix("Bearer ")
    if header.startswith("Basic "):
        key = base64.b64decode(header.split()[-1]).decode()
    if "down" in key:
        return httpx.Response(503)
    if BAD in key:
        return httpx.Response(401)
    if req.url.host == "core-api.uk.plain.com":
        return httpx.Response(200, json={"data": {"myWorkspace": {"id": "w_1"}}})
    return httpx.Response(200, json={})


@pytest.fixture
def api(monkeypatch):
    import main

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    s.add(User(id=1, email="forrest@x.example", hashed_password="x", role="admin", first_name="Forrest"))
    s.commit()
    s.close()

    def _db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    monkeypatch.setenv("INTEGRATION_KEYS_SECRET", Fernet.generate_key().decode())
    for n in registry.PROVIDERS:
        monkeypatch.delenv(n, raising=False)
    monkeypatch.setattr(store, "_session_factory", Session)
    monkeypatch.setattr(routes, "_transport", httpx.MockTransport(provider))
    store.drop_cache()
    main.app.dependency_overrides[get_db] = _db
    main.app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1, role="admin")
    yield TestClient(main.app), Session
    main.app.dependency_overrides.clear()
    store.drop_cache()


def test_list_shows_three_rows_without_values(api, monkeypatch):
    client, _ = api
    monkeypatch.setenv("CLOSE_API_KEY", "env_close_wxyz")
    store.drop_cache()
    body = client.get("/admin/integrations").json()
    assert body["configured"] is True
    assert [k["name"] for k in body["keys"]] == ["CLOSE_API_KEY", "PLAIN_API_KEY", "ANTHROPIC_API_KEY"]
    assert body["keys"][0]["source"] == "env" and body["keys"][0]["last4"] == "wxyz"
    assert "env_close_wxyz" not in client.get("/admin/integrations").text


def test_save_tests_then_stores_and_goes_live(api):
    client, Session = api
    r = client.put("/admin/integrations/CLOSE_API_KEY", json={"value": f"  {GOOD}  "})
    assert r.status_code == 200
    assert r.json()["source"] == "settings" and r.json()["last4"] == "a3f9" and r.json()["updated_by_name"] == "Forrest"
    assert store.get("CLOSE_API_KEY") == GOOD


def test_rejected_key_is_never_stored(api):
    client, Session = api
    r = client.put("/admin/integrations/CLOSE_API_KEY", json={"value": BAD})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "key_rejected"
    assert Session().get(IntegrationKey, "CLOSE_API_KEY") is None
    assert [(e.action, e.outcome) for e in Session().query(IntegrationKeyEvent)] == [("set", "rejected")]


def test_rejected_replacement_keeps_the_old_key(api):
    client, _ = api
    client.put("/admin/integrations/CLOSE_API_KEY", json={"value": GOOD})
    assert client.put("/admin/integrations/CLOSE_API_KEY", json={"value": BAD}).status_code == 422
    assert store.get("CLOSE_API_KEY") == GOOD


def test_provider_down_is_502_and_nothing_stored(api):
    client, Session = api
    r = client.put("/admin/integrations/CLOSE_API_KEY", json={"value": "close_down_key"})
    assert r.status_code == 502 and r.json()["detail"]["code"] == "provider_unavailable"
    assert Session().get(IntegrationKey, "CLOSE_API_KEY") is None


def test_value_limits(api):
    client, _ = api
    for v in ("   ", "x" * 513):
        r = client.put("/admin/integrations/CLOSE_API_KEY", json={"value": v})
        assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_input"


def test_test_endpoint_uses_the_key_in_effect(api, monkeypatch):
    client, Session = api
    assert client.post("/admin/integrations/PLAIN_API_KEY/test").json() == {"ok": False, "outcome": "not_set"}
    monkeypatch.setenv("PLAIN_API_KEY", "plain_env_key")
    store.drop_cache()
    assert client.post("/admin/integrations/PLAIN_API_KEY/test").json() == {"ok": True, "outcome": "ok"}
    monkeypatch.setenv("PLAIN_API_KEY", BAD)
    store.drop_cache()
    assert client.post("/admin/integrations/PLAIN_API_KEY/test").json() == {"ok": False, "outcome": "rejected"}
    assert {e.action for e in Session().query(IntegrationKeyEvent)} == {"tested"}


def test_delete_reverts_to_env(api, monkeypatch):
    client, _ = api
    monkeypatch.setenv("CLOSE_API_KEY", "env_close_key")
    client.put("/admin/integrations/CLOSE_API_KEY", json={"value": GOOD})
    r = client.delete("/admin/integrations/CLOSE_API_KEY")
    assert r.status_code == 200 and r.json()["source"] == "env" and store.get("CLOSE_API_KEY") == "env_close_key"


def test_unknown_name_is_404_everywhere(api):
    client, _ = api
    for method, path in (("put", "/admin/integrations/JWT_SECRET"), ("post", "/admin/integrations/JWT_SECRET/test"),
                         ("delete", "/admin/integrations/JWT_SECRET")):
        kw = {"json": {"value": "x"}} if method == "put" else {}
        r = getattr(client, method)(path, **kw)
        assert r.status_code == 404 and r.json()["detail"]["code"] == "unknown_key", path


def test_non_admin_is_403_everywhere(api):
    import main

    client, _ = api
    main.app.dependency_overrides[get_current_user] = lambda: MagicMock(id=2, role="standard")
    assert client.get("/admin/integrations").status_code == 403
    assert client.put("/admin/integrations/CLOSE_API_KEY", json={"value": GOOD}).status_code == 403
    assert client.post("/admin/integrations/CLOSE_API_KEY/test").status_code == 403
    assert client.delete("/admin/integrations/CLOSE_API_KEY").status_code == 403


def test_without_secret_writes_503_and_list_says_not_configured(api, monkeypatch):
    client, _ = api
    monkeypatch.delenv("INTEGRATION_KEYS_SECRET")
    store.drop_cache()
    assert client.get("/admin/integrations").json()["configured"] is False
    r = client.put("/admin/integrations/CLOSE_API_KEY", json={"value": GOOD})
    assert r.status_code == 503 and r.json()["detail"]["code"] == "keys_not_configured"


def test_no_response_ever_contains_the_value(api):
    client, _ = api
    huge = "LEAK" + "x" * 5000
    texts = [client.put("/admin/integrations/CLOSE_API_KEY", json={"value": huge}).text,
             client.put("/admin/integrations/CLOSE_API_KEY", json={"value": GOOD}).text,
             client.put("/admin/integrations/PLAIN_API_KEY", json={"value": BAD}).text,
             client.get("/admin/integrations").text,
             client.post("/admin/integrations/CLOSE_API_KEY/test").text,
             client.delete("/admin/integrations/CLOSE_API_KEY").text]
    assert not any(GOOD in t or BAD in t or "LEAKxxxx" in t for t in texts)


@pytest.mark.parametrize("value", ["abc\u200bdef_key", "abc def_key", "abc\ndef_key", "abc\u00e9def_key"])
def test_non_ascii_or_whitespace_inside_a_key_is_422(api, value):
    client, Session = api
    r = client.put("/admin/integrations/PLAIN_API_KEY", json={"value": value})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_input"
    assert Session().get(IntegrationKey, "PLAIN_API_KEY") is None
