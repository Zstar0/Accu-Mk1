# Integration Keys in Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins set, replace, test and clear the Close, Plain and Anthropic API keys from Settings > Integrations. Keys are stored encrypted and write-only, and go live without a restart.

**Architecture:**
- A new backend package `integration_keys/` holds the allowlist with provider test calls (`registry.py`), Fernet-encrypted storage with a 60 s resolver cache and audit events (`store.py`), and four admin routes (`routes.py`).
- The three existing client factories read through `integration_keys.store.get(NAME)`. That returns the stored key, else the env value. Each factory already rebuilds its client when the key changes.
- A new admin-only Settings pane drives the routes.

**Tech Stack:** FastAPI + pydantic 2.9, SQLAlchemy 2, `cryptography` Fernet (already installed), httpx (MockTransport in tests), pytest; React 19, TanStack Query, vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-10-integration-keys-settings-design.md`

## Global Constraints

- **Allowlist:** `CLOSE_API_KEY`, `PLAIN_API_KEY` and `ANTHROPIC_API_KEY` only. Any other name returns 404 `unknown_key`.
- **Encryption key:** env `INTEGRATION_KEYS_SECRET`, a Fernet key.
  - Never derive it from `JWT_SECRET`.
  - If it is missing or invalid, writes return 503 `keys_not_configured`, GET reports `configured: false`, and the resolver uses env values only, without touching the DB.
- **Never visible:** no plaintext key in any table, log line or response body. Request bodies are never logged.
- **Never in `settings`:** do not use the existing `settings` table.
- **Value limits:** 1 to 512 characters after trim.
- **Provider tests:** 10 s timeout, no retry. 2xx means ok. 401 or 403 means `rejected`. Anything else, including network errors, means `unavailable`.
- **Saving:** a key the provider rejects is never stored.
- **Resolver cache:** 60 s, dropped on every save and clear.
- **Access:** every route is `require_admin`, and the nav item is hidden from non-admins.
- **Frontend tooling:** npm only. No em dashes in UI copy.
- **Backend tests:** `cd backend && /c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python -m pytest <files> -q`. Run one suite at a time.
- **Frontend tests:** run `npm ci` once in the worktree, then `npx vitest run <files>`. Gate on `tsc --noEmit` plus eslint and prettier on the changed files only; master's `check:all` fails for pre-existing reasons. Never run prettier on files you only touched lightly if that reformats unrelated lines.

## Review Focus

1. **The DB is unreachable when a client factory asks for a key.**
   - Expect: the env value is used and nothing raises. A failed lookup is not cached, so a stored key wins again once the DB is back.
   - Pinned in Task 1: `test_db_error_falls_back_to_env_and_is_not_cached`.
2. **`INTEGRATION_KEYS_SECRET` is present but malformed** (not a valid Fernet key).
   - Expect: it is treated as "not configured" (writes 503, resolver env-only) and never surfaces as a 500.
   - Pinned in Task 1: `test_malformed_secret_counts_as_not_configured`.
3. **A key value echoed back.**
   - Expect: no response from any endpoint, success or failure, contains the submitted value.
   - Pinned in Task 2: `test_no_response_ever_contains_the_value`.
4. **A save the provider rejects, after an earlier good key was stored.**
   - Expect: the earlier key stays stored and in use.
   - Pinned in Task 2: `test_rejected_replacement_keeps_the_old_key`.
5. **The client modules' existing tests, which only set env vars, start hitting the DB.**
   - Expect: with no `INTEGRATION_KEYS_SECRET`, the resolver never opens a session.
   - Pinned in Task 1: `test_no_secret_never_opens_a_session`.

---

### Task 1: Models, encrypted store and resolver

**Files:**
- Modify: `backend/models.py` (append two models at the end of the file)
- Create: `backend/integration_keys/__init__.py` (empty)
- Create: `backend/integration_keys/registry.py`
- Create: `backend/integration_keys/store.py`
- Test: `backend/tests/test_integration_keys_store.py`

**Interfaces:**
- Produces:
  - `models.IntegrationKey(name: str PK, ciphertext: str, last4: str, updated_by: int, updated_at: datetime)` and `models.IntegrationKeyEvent(id, at, name, action, user_id, outcome)`.
  - `registry.PROVIDERS: dict[str, Provider]` with `Provider(name, label, test)`, and `registry.run_test(name: str, key: str, transport: httpx.BaseTransport | None = None) -> str`, which returns `"ok" | "rejected" | "unavailable"`.
  - From `store`:
    - `store.configured() -> bool`
    - `store.get(name: str) -> str | None`
    - `store.save(db, name: str, value: str, user_id: int) -> None` (raises `store.KeysNotConfigured`)
    - `store.clear(db, name: str, user_id: int) -> None`
    - `store.event(db, name, action, user_id, outcome) -> None` (no commit)
    - `store.status(db, name: str) -> dict`, with keys `name, label, source, last4, updated_by_name, updated_at, undecryptable`
    - `store.drop_cache() -> None`
    - `store._session_factory`, which tests monkeypatch

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_integration_keys_store.py`:

```python
"""integration_keys.store: Fernet at rest, resolver order, cache, fallbacks, status (spec 3.2, 3.3)."""
import pytest
from cryptography.fernet import Fernet
from sqlalchemy import create_engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from database import Base
from integration_keys import store
from models import IntegrationKey, IntegrationKeyEvent, User

SECRET = Fernet.generate_key().decode()


@pytest.fixture
def db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    monkeypatch.setattr(store, "_session_factory", Session)
    monkeypatch.setenv("INTEGRATION_KEYS_SECRET", SECRET)
    monkeypatch.delenv("CLOSE_API_KEY", raising=False)
    store.drop_cache()
    s = Session()
    s.add(User(id=7, email="forrest@x.example", hashed_password="x", role="admin", first_name="Forrest"))
    s.commit()
    yield s
    s.close()
    store.drop_cache()


def test_save_encrypts_and_get_returns_the_value(db):
    store.save(db, "CLOSE_API_KEY", "api_live_secret_a3f9", 7)
    row = db.get(IntegrationKey, "CLOSE_API_KEY")
    assert row.ciphertext != "api_live_secret_a3f9" and "secret" not in row.ciphertext
    assert row.last4 == "a3f9" and row.updated_by == 7
    assert store.get("CLOSE_API_KEY") == "api_live_secret_a3f9"
    assert [(e.action, e.outcome) for e in db.query(IntegrationKeyEvent)] == [("set", "ok")]


def test_resolver_order_settings_then_env_then_none(db, monkeypatch):
    assert store.get("CLOSE_API_KEY") is None
    monkeypatch.setenv("CLOSE_API_KEY", " env_key ")
    store.drop_cache()
    assert store.get("CLOSE_API_KEY") == "env_key"
    store.save(db, "CLOSE_API_KEY", "stored_key", 7)
    assert store.get("CLOSE_API_KEY") == "stored_key"
    store.clear(db, "CLOSE_API_KEY", 7)
    assert store.get("CLOSE_API_KEY") == "env_key"


def test_cache_holds_for_ttl_but_writes_drop_it(db, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(store, "_clock", lambda: now[0])
    store.save(db, "CLOSE_API_KEY", "first", 7)
    assert store.get("CLOSE_API_KEY") == "first"
    db.get(IntegrationKey, "CLOSE_API_KEY").ciphertext = Fernet(SECRET.encode()).encrypt(b"sneaky").decode()
    db.commit()
    assert store.get("CLOSE_API_KEY") == "first"  # cached
    now[0] += 61
    assert store.get("CLOSE_API_KEY") == "sneaky"
    store.save(db, "CLOSE_API_KEY", "second", 7)
    assert store.get("CLOSE_API_KEY") == "second"


def test_undecryptable_row_falls_back_to_env_and_reports_it(db, monkeypatch):
    store.save(db, "CLOSE_API_KEY", "stored_key", 7)
    monkeypatch.setenv("INTEGRATION_KEYS_SECRET", Fernet.generate_key().decode())
    monkeypatch.setenv("CLOSE_API_KEY", "env_key")
    store.drop_cache()
    assert store.get("CLOSE_API_KEY") == "env_key"
    s = store.status(db, "CLOSE_API_KEY")
    assert s["undecryptable"] is True and s["source"] == "env" and s["last4"] == "_key"


def test_db_error_falls_back_to_env_and_is_not_cached(db, monkeypatch):
    store.save(db, "CLOSE_API_KEY", "stored_key", 7)
    monkeypatch.setenv("CLOSE_API_KEY", "env_key")
    store.drop_cache()
    good = store._session_factory

    def broken():
        raise OperationalError("select", {}, Exception("down"))

    monkeypatch.setattr(store, "_session_factory", broken)
    assert store.get("CLOSE_API_KEY") == "env_key"
    monkeypatch.setattr(store, "_session_factory", good)
    assert store.get("CLOSE_API_KEY") == "stored_key"


def test_no_secret_never_opens_a_session(db, monkeypatch):
    monkeypatch.delenv("INTEGRATION_KEYS_SECRET")
    monkeypatch.setenv("CLOSE_API_KEY", "env_key")
    store.drop_cache()

    def forbidden():
        raise AssertionError("opened a DB session without INTEGRATION_KEYS_SECRET")

    monkeypatch.setattr(store, "_session_factory", forbidden)
    assert store.configured() is False and store.get("CLOSE_API_KEY") == "env_key"


def test_malformed_secret_counts_as_not_configured(db, monkeypatch):
    monkeypatch.setenv("INTEGRATION_KEYS_SECRET", "not-a-fernet-key")
    store.drop_cache()
    assert store.configured() is False
    with pytest.raises(store.KeysNotConfigured):
        store.save(db, "CLOSE_API_KEY", "x", 7)


def test_status_for_settings_env_and_none(db, monkeypatch):
    assert store.status(db, "CLOSE_API_KEY") == {
        "name": "CLOSE_API_KEY", "label": "Close CRM", "source": "none", "last4": None,
        "updated_by_name": None, "updated_at": None, "undecryptable": False}
    monkeypatch.setenv("CLOSE_API_KEY", "env_wxyz")
    store.drop_cache()
    assert store.status(db, "CLOSE_API_KEY")["source"] == "env"
    assert store.status(db, "CLOSE_API_KEY")["last4"] == "wxyz"
    store.save(db, "CLOSE_API_KEY", "stored_a3f9", 7)
    s = store.status(db, "CLOSE_API_KEY")
    assert (s["source"], s["last4"], s["updated_by_name"]) == ("settings", "a3f9", "Forrest")
    assert s["updated_at"]
```

- [ ] **Step 2: Run to watch it fail**

Run: `cd backend && <venv python> -m pytest tests/test_integration_keys_store.py -q`
Expected: collection error, `ModuleNotFoundError: No module named 'integration_keys'`.

- [ ] **Step 3: Models**

Append to the end of `backend/models.py`:

```python


class IntegrationKey(Base):
    """A third-party API key saved from Settings > Integrations, Fernet-encrypted (spec 2026-10-10, 3.2).

    The plaintext never touches this table; last4 is for display only.
    """
    __tablename__ = "integration_keys"

    name: Mapped[str] = mapped_column(String(64), primary_key=True)
    ciphertext: Mapped[str] = mapped_column(Text, nullable=False)
    last4: Mapped[str] = mapped_column(String(4), nullable=False)
    updated_by: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class IntegrationKeyEvent(Base):
    """Audit of integration key changes and tests. Never holds a key value."""
    __tablename__ = "integration_key_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    action: Mapped[str] = mapped_column(String(16), nullable=False)
    user_id: Mapped[int] = mapped_column(Integer, nullable=False)
    outcome: Mapped[str] = mapped_column(String(16), nullable=False)
```

- [ ] **Step 4: Registry**

`backend/integration_keys/registry.py`:

```python
"""Allowlisted third-party keys and their read-only provider tests (spec 3.1)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import httpx

TIMEOUT = 10.0


@dataclass(frozen=True)
class Provider:
    name: str
    label: str
    test: Callable[[httpx.Client, str], httpx.Response]


def _close(c: httpx.Client, key: str) -> httpx.Response:
    return c.get("https://api.close.com/api/v1/me/", auth=(key, ""))


def _plain(c: httpx.Client, key: str) -> httpx.Response:
    return c.post("https://core-api.uk.plain.com/graphql/v1", json={"query": "query { myWorkspace { id } }"},
                  headers={"Authorization": f"Bearer {key}"})


def _anthropic(c: httpx.Client, key: str) -> httpx.Response:
    return c.get("https://api.anthropic.com/v1/models", params={"limit": 1},
                 headers={"x-api-key": key, "anthropic-version": "2023-06-01"})


PROVIDERS: dict[str, Provider] = {p.name: p for p in (
    Provider("CLOSE_API_KEY", "Close CRM", _close),
    Provider("PLAIN_API_KEY", "Plain support", _plain),
    Provider("ANTHROPIC_API_KEY", "Anthropic (AI review)", _anthropic),
)}


def run_test(name: str, key: str, transport: httpx.BaseTransport | None = None) -> str:
    """One read-only call, no retry: "ok", "rejected" (401/403) or "unavailable"."""
    try:
        with httpx.Client(timeout=TIMEOUT, transport=transport) as c:
            r = PROVIDERS[name].test(c, key)
    except httpx.HTTPError:
        return "unavailable"
    if r.status_code in (401, 403):
        return "rejected"
    if not 200 <= r.status_code < 300:
        return "unavailable"
    if name == "PLAIN_API_KEY":  # GraphQL reports failures inside a 200
        try:
            body = r.json()
        except ValueError:
            return "unavailable"
        if not isinstance(body, dict) or body.get("errors") or not ((body.get("data") or {}).get("myWorkspace") or {}).get("id"):
            return "unavailable"
    return "ok"
```

- [ ] **Step 5: Store**

`backend/integration_keys/store.py`:

```python
"""Encrypted storage, the key resolver and the audit for integration keys (spec 3.2, 3.3)."""
from __future__ import annotations

import logging
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from database import SessionLocal
from integration_keys.registry import PROVIDERS
from models import IntegrationKey, IntegrationKeyEvent, User

logger = logging.getLogger(__name__)
CACHE_TTL = 60.0
_session_factory = SessionLocal
_clock = time.monotonic
_lock = threading.Lock()
_cache: dict[str, tuple[float, str | None, bool]] = {}  # name -> (at, decrypted stored value, undecryptable)
_warned: set[str] = set()


class KeysNotConfigured(Exception):
    """INTEGRATION_KEYS_SECRET is missing or not a valid Fernet key."""


def _fernet() -> Fernet | None:
    raw = (os.environ.get("INTEGRATION_KEYS_SECRET") or "").strip()
    if not raw:
        return None
    try:
        return Fernet(raw.encode())
    except (ValueError, TypeError):
        logger.warning("integration_keys.bad_secret")
        return None


def configured() -> bool:
    return _fernet() is not None


def _env(name: str) -> str | None:
    return (os.environ.get(name) or "").strip() or None


def _decrypt(token: str | None) -> tuple[str | None, bool]:
    """(value, undecryptable). No token is (None, False)."""
    if not token:
        return None, False
    f = _fernet()
    if f is None:
        return None, True
    try:
        return f.decrypt(token.encode()).decode(), False
    except InvalidToken:
        return None, True


def _stored(name: str) -> tuple[str | None, bool]:
    if not configured():  # feature off: env only, never touch the DB
        return None, False
    with _lock:
        hit = _cache.get(name)
        if hit and _clock() - hit[0] < CACHE_TTL:
            return hit[1], hit[2]
    try:
        with _session_factory() as db:
            row = db.get(IntegrationKey, name)
            token = row.ciphertext if row else None
    except SQLAlchemyError:
        logger.warning("integration_keys.db_unavailable name=%s", name)
        return None, False  # not cached: the stored key wins again once the DB is back
    value, bad = _decrypt(token)
    if bad and name not in _warned:
        _warned.add(name)
        logger.warning("integration_keys.undecryptable name=%s", name)
    with _lock:
        _cache[name] = (_clock(), value, bad)
    return value, bad


def get(name: str) -> str | None:
    """The key in effect: saved in Settings, else the server env, else None."""
    value, _ = _stored(name)
    return value or _env(name)


def drop_cache() -> None:
    with _lock:
        _cache.clear()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def event(db: Session, name: str, action: str, user_id: int, outcome: str) -> None:
    db.add(IntegrationKeyEvent(at=_now(), name=name, action=action, user_id=user_id, outcome=outcome))


def save(db: Session, name: str, value: str, user_id: int) -> None:
    f = _fernet()
    if f is None:
        raise KeysNotConfigured()
    row = db.get(IntegrationKey, name) or IntegrationKey(name=name)
    row.ciphertext = f.encrypt(value.encode()).decode()
    row.last4, row.updated_by, row.updated_at = value[-4:], user_id, _now()
    db.add(row)
    event(db, name, "set", user_id, "ok")
    db.commit()
    drop_cache()


def clear(db: Session, name: str, user_id: int) -> None:
    row = db.get(IntegrationKey, name)
    if row is not None:
        db.delete(row)
    event(db, name, "cleared", user_id, "ok")
    db.commit()
    drop_cache()


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    dt = dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)  # SQLite returns naive datetimes
    return dt.isoformat().replace("+00:00", "Z")


def status(db: Session, name: str) -> dict[str, Any]:
    row = db.get(IntegrationKey, name)
    _, bad = _decrypt(row.ciphertext if row else None)
    out: dict[str, Any] = {"name": name, "label": PROVIDERS[name].label, "source": "none", "last4": None,
                           "updated_by_name": None, "updated_at": None, "undecryptable": bad}
    if row is not None and not bad:
        user = db.get(User, row.updated_by)
        who = " ".join(x for x in (getattr(user, "first_name", None), getattr(user, "last_name", None)) if x)
        out.update(source="settings", last4=row.last4, updated_by_name=who or getattr(user, "email", None),
                   updated_at=_iso(row.updated_at))
    elif env := _env(name):
        out.update(source="env", last4=env[-4:])
    return out
```

Also create the empty `backend/integration_keys/__init__.py`.

- [ ] **Step 6: Run to watch it pass**

Run: `cd backend && <venv python> -m pytest tests/test_integration_keys_store.py -q`
Expected: PASS (8 tests).

- [ ] **Step 7: Commit**

```bash
git add backend/models.py backend/integration_keys/__init__.py backend/integration_keys/registry.py backend/integration_keys/store.py backend/tests/test_integration_keys_store.py
git commit -m "feat(integration-keys): encrypted store, resolver and provider registry"
```

---

### Task 2: Provider tests and admin routes

**Files:**
- Create: `backend/integration_keys/routes.py`
- Modify: `backend/main.py` (import and `app.include_router` beside `support_plain_router`, ~line 129 and ~line 650)
- Test: `backend/tests/test_integration_keys_routes.py`

**Interfaces:**
- Consumes: Task 1 (`registry.PROVIDERS`, `registry.run_test`, the `store.*` functions).
- Produces:
  - `GET /admin/integrations` returns `{configured, keys: [KeyStatus]}`.
  - `PUT /admin/integrations/{name}` takes `{value}` and returns the `KeyStatus`.
  - `POST /admin/integrations/{name}/test` returns `{ok, outcome}`.
  - `DELETE /admin/integrations/{name}` returns the `KeyStatus`.
  - `routes._transport` is an injectable httpx transport for tests.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_integration_keys_routes.py`:

```python
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
    texts = [client.put("/admin/integrations/CLOSE_API_KEY", json={"value": GOOD}).text,
             client.put("/admin/integrations/PLAIN_API_KEY", json={"value": BAD}).text,
             client.get("/admin/integrations").text,
             client.post("/admin/integrations/CLOSE_API_KEY/test").text,
             client.delete("/admin/integrations/CLOSE_API_KEY").text]
    assert not any(GOOD in t or BAD in t for t in texts)
```

- [ ] **Step 2: Run to watch it fail**

Run: `cd backend && <venv python> -m pytest tests/test_integration_keys_routes.py -q`
Expected: FAIL. Either `ImportError: cannot import name 'routes'`, or 404s on `/admin/integrations`.

- [ ] **Step 3: Routes**

`backend/integration_keys/routes.py`:

```python
"""/admin/integrations: set, test, clear third-party API keys (spec section 4). Admin only; values never returned."""
from __future__ import annotations

from typing import Literal, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from auth import require_admin
from database import get_db
from integration_keys import registry, store

router = APIRouter(prefix="/admin/integrations", tags=["integration-keys"])
_transport: httpx.BaseTransport | None = None  # tests inject a MockTransport
MAX_LEN = 512


class KeyStatus(BaseModel):
    name: str
    label: str
    source: Literal["settings", "env", "none"]
    last4: Optional[str] = None
    updated_by_name: Optional[str] = None
    updated_at: Optional[str] = None
    undecryptable: bool = False


class KeyList(BaseModel):
    configured: bool
    keys: list[KeyStatus]


class SaveBody(BaseModel):
    value: str = Field(max_length=4096)


class TestResult(BaseModel):
    ok: bool
    outcome: Literal["ok", "rejected", "unavailable", "not_set"]


def _known(name: str) -> None:
    if name not in registry.PROVIDERS:
        raise HTTPException(status_code=404, detail={"code": "unknown_key"})


@router.get("", response_model=KeyList)
def list_keys(db: Session = Depends(get_db), _u=Depends(require_admin)):
    return {"configured": store.configured(), "keys": [store.status(db, n) for n in registry.PROVIDERS]}


@router.put("/{name}", response_model=KeyStatus)
def save_key(name: str, body: SaveBody, db: Session = Depends(get_db), user=Depends(require_admin)):
    _known(name)
    if not store.configured():
        raise HTTPException(status_code=503, detail={"code": "keys_not_configured"})
    value = body.value.strip()
    if not value or len(value) > MAX_LEN:
        raise HTTPException(status_code=422, detail={"code": "invalid_input"})
    outcome = registry.run_test(name, value, _transport)
    if outcome != "ok":
        store.event(db, name, "set", user.id, outcome)
        db.commit()
        if outcome == "rejected":
            raise HTTPException(status_code=422, detail={"code": "key_rejected"})
        raise HTTPException(status_code=502, detail={"code": "provider_unavailable"})
    try:
        store.save(db, name, value, user.id)
    except store.KeysNotConfigured:
        raise HTTPException(status_code=503, detail={"code": "keys_not_configured"})
    return store.status(db, name)


@router.post("/{name}/test", response_model=TestResult)
def test_key(name: str, db: Session = Depends(get_db), user=Depends(require_admin)):
    _known(name)
    key = store.get(name)
    if not key:
        return {"ok": False, "outcome": "not_set"}
    outcome = registry.run_test(name, key, _transport)
    store.event(db, name, "tested", user.id, outcome)
    db.commit()
    return {"ok": outcome == "ok", "outcome": outcome}


@router.delete("/{name}", response_model=KeyStatus)
def clear_key(name: str, db: Session = Depends(get_db), user=Depends(require_admin)):
    _known(name)
    store.clear(db, name, user.id)
    return store.status(db, name)
```

In `backend/main.py`, add `from integration_keys.routes import router as integration_keys_router` next to the `support_plain` router import, and `app.include_router(integration_keys_router)` next to `app.include_router(support_plain_router)`.

- [ ] **Step 4: Run to watch it pass**

Run: `cd backend && <venv python> -m pytest tests/test_integration_keys_routes.py tests/test_integration_keys_store.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/integration_keys/routes.py backend/main.py backend/tests/test_integration_keys_routes.py
git commit -m "feat(integration-keys): admin routes that test before they store"
```

---

### Task 3: The three clients read through the resolver

**Files:**
- Modify: `backend/crm_close/client.py` (`get_client`, ~line 72)
- Modify: `backend/support_plain/client.py` (`get_client`, ~line 81)
- Modify: `backend/customer_review/llm.py` (`get_client`, ~line 83)
- Test: `backend/tests/test_integration_keys_clients.py`

**Interfaces:**
- Consumes: `integration_keys.store.get(name) -> str | None`, `store.save`, `store._session_factory`, `store.drop_cache`.
- Produces: each `get_client()` now uses `store.get(NAME)`, and each module's `_shared` cache still keys clients by key.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_integration_keys_clients.py`:

```python
"""The three integration clients use a key saved in Settings on the next call, without a restart."""
import pytest
from cryptography.fernet import Fernet
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from crm_close import client as close_client
from customer_review import llm
from database import Base
from integration_keys import store
from support_plain import client as plain_client


@pytest.fixture
def db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    monkeypatch.setattr(store, "_session_factory", Session)
    monkeypatch.setenv("INTEGRATION_KEYS_SECRET", Fernet.generate_key().decode())
    store.drop_cache()
    s = Session()
    yield s
    s.close()
    store.drop_cache()


@pytest.mark.parametrize("module,name,shared_key", [
    (close_client, "CLOSE_API_KEY", lambda k: k),
    (plain_client, "PLAIN_API_KEY", lambda k: k),
    (llm, "ANTHROPIC_API_KEY", lambda k: (k, "")),
])
def test_saved_key_wins_over_env_on_the_next_call(db, monkeypatch, module, name, shared_key):
    monkeypatch.setenv(name, "env_key")
    monkeypatch.delenv("ANTHROPIC_WORKSPACE_ID", raising=False)
    module._shared.clear()
    first = module.get_client()
    assert shared_key("env_key") in module._shared
    store.save(db, name, "saved_key", 1)
    second = module.get_client()
    assert second is not first and shared_key("saved_key") in module._shared
```

- [ ] **Step 2: Run to watch it fail**

Run: `cd backend && <venv python> -m pytest tests/test_integration_keys_clients.py -q`
Expected: 3 FAIL. `second is first`, because the factories still read only the env.

- [ ] **Step 3: Switch each factory**

In each of the three files, add `from integration_keys import store as integration_keys` to the imports, and replace the env read:
- `crm_close/client.py`: `key = (os.environ.get("CLOSE_API_KEY") or "").strip()` becomes `key = integration_keys.get("CLOSE_API_KEY") or ""`
- `support_plain/client.py`: `key = (os.environ.get("PLAIN_API_KEY") or "").strip()` becomes `key = integration_keys.get("PLAIN_API_KEY") or ""`
- `customer_review/llm.py`: `key = (os.environ.get("ANTHROPIC_API_KEY") or "").strip()` becomes `key = integration_keys.get("ANTHROPIC_API_KEY") or ""`

Leave `ANTHROPIC_WORKSPACE_ID` as an env read (it is not a secret). If a module no longer uses `os`, remove its `import os`.

- [ ] **Step 4: Run to watch it pass, then the clients' own suites**

Run, one at a time:
- `cd backend && <venv python> -m pytest tests/test_integration_keys_clients.py -q`
- `<venv python> -m pytest tests/test_crm_close_client.py tests/test_support_plain_client.py tests/test_customer_review_llm.py -q`

(If a listed file does not exist, run `ls tests | grep -E "crm_close|support_plain_client|customer_review_llm"` and use the real names.)

Expected: PASS. The existing suites set only env vars and no `INTEGRATION_KEYS_SECRET`, so the resolver never opens a session.

- [ ] **Step 5: Commit**

```bash
git add backend/crm_close/client.py backend/support_plain/client.py backend/customer_review/llm.py backend/tests/test_integration_keys_clients.py
git commit -m "feat(integration-keys): Close, Plain and Anthropic clients read saved keys"
```

---

### Task 4: Settings > Integrations pane

**Files:**
- Create: `src/lib/api-integration-keys.ts`
- Create: `src/components/preferences/panes/IntegrationsPane.tsx`
- Create: `src/components/preferences/panes/__tests__/IntegrationsPane.test.tsx`
- Modify: `src/components/preferences/panes.tsx` (union, nav item with `adminOnly`, `PANE_COMPONENTS`, new `visibleNavItems`)
- Modify: `src/components/preferences/SettingsPage.tsx` (use `visibleNavItems(isAdmin)`)
- Modify: `locales/en.json`, `locales/fr.json`, `locales/ar.json` (add `preferences.integrations`)

**Interfaces:**
- Consumes: Task 2's routes; `crmFetch` and `CrmError` from `@/lib/api-crm` (generic fetch with `detail.code` extraction).
- Produces:
  - `IntegrationKeyStatus` and `IntegrationKeyList` types.
  - `getIntegrationKeys()`, `saveIntegrationKey(name, value)`, `testIntegrationKey(name)`, `clearIntegrationKey(name)`.
  - `visibleNavItems(isAdmin: boolean)` and `<IntegrationsPane />`.

- [ ] **Step 1: Install, then write the failing tests**

Run once in the worktree: `npm ci`.

`src/components/preferences/panes/__tests__/IntegrationsPane.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/lib/api-integration-keys'
import type { IntegrationKeyList, IntegrationKeyStatus } from '@/lib/api-integration-keys'
import { CrmError } from '@/lib/api-crm'
import { IntegrationsPane } from '../IntegrationsPane'
import { visibleNavItems } from '../../panes'

const auth = vi.hoisted(() => ({ role: 'admin' }))
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { role: auth.role } }),
}))
vi.mock('@/lib/api-integration-keys', async () => {
  const actual = await vi.importActual<typeof api>('@/lib/api-integration-keys')
  return {
    ...actual,
    getIntegrationKeys: vi.fn(),
    saveIntegrationKey: vi.fn(),
    testIntegrationKey: vi.fn(),
    clearIntegrationKey: vi.fn(),
  }
})

const close: IntegrationKeyStatus = {
  name: 'CLOSE_API_KEY',
  label: 'Close CRM',
  source: 'env',
  last4: 'wxyz',
  updated_by_name: null,
  updated_at: null,
  undecryptable: false,
}
const list: IntegrationKeyList = { configured: true, keys: [close] }

function setup(data: IntegrationKeyList = list) {
  vi.mocked(api.getIntegrationKeys).mockResolvedValue(data)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <IntegrationsPane />
    </QueryClientProvider>
  )
}

describe('IntegrationsPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.role = 'admin'
  })

  it('shows the source and last four, never a value', async () => {
    setup()
    expect(await screen.findByText('Close CRM')).toBeInTheDocument()
    expect(screen.getByText('From server env')).toBeInTheDocument()
    expect(screen.getByText(/ends in wxyz/)).toBeInTheDocument()
  })

  it('save success clears the field and updates the row', async () => {
    setup()
    vi.mocked(api.saveIntegrationKey).mockResolvedValue({
      ...close,
      source: 'settings',
      last4: 'a3f9',
      updated_by_name: 'Forrest',
      updated_at: '2026-10-10T00:00:00Z',
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Replace' }))
    await userEvent.type(screen.getByLabelText('New Close CRM key'), 'close_good_key_a3f9')
    await userEvent.click(screen.getByRole('button', { name: 'Save and test' }))
    await waitFor(() =>
      expect(api.saveIntegrationKey).toHaveBeenCalledWith('CLOSE_API_KEY', 'close_good_key_a3f9')
    )
    expect(await screen.findByText('Saved in Settings')).toBeInTheDocument()
    expect(screen.queryByLabelText('New Close CRM key')).toBeNull()
  })

  it('a rejected key keeps the field and explains', async () => {
    setup()
    vi.mocked(api.saveIntegrationKey).mockRejectedValue(new CrmError(422, 'key_rejected'))
    await userEvent.click(await screen.findByRole('button', { name: 'Replace' }))
    const field = screen.getByLabelText('New Close CRM key')
    await userEvent.type(field, 'bad')
    await userEvent.click(screen.getByRole('button', { name: 'Save and test' }))
    expect(await screen.findByText('Close CRM rejected this key.')).toBeInTheDocument()
    expect(field).toHaveValue('bad')
  })

  it('test reports the outcome inline', async () => {
    setup()
    vi.mocked(api.testIntegrationKey).mockResolvedValue({ ok: true, outcome: 'ok' })
    await userEvent.click(await screen.findByRole('button', { name: 'Test' }))
    expect(await screen.findByText('Working.')).toBeInTheDocument()
  })

  it('not configured disables Replace and says why', async () => {
    setup({ configured: false, keys: [close] })
    expect(await screen.findByText(/INTEGRATION_KEYS_SECRET is missing/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Replace' })).toBeDisabled()
  })

  it('an undecryptable key explains how to fix it', async () => {
    setup({ configured: true, keys: [{ ...close, undecryptable: true }] })
    expect(await screen.findByText(/saved key can't be read/)).toBeInTheDocument()
  })

  it('non-admins get no data and no nav item', async () => {
    auth.role = 'standard'
    setup()
    expect(await screen.findByText(/Only admins/)).toBeInTheDocument()
    expect(api.getIntegrationKeys).not.toHaveBeenCalled()
    expect(visibleNavItems(false).some(i => i.id === 'integrations')).toBe(false)
    expect(visibleNavItems(true).some(i => i.id === 'integrations')).toBe(true)
  })
})
```

- [ ] **Step 2: Run to watch it fail**

Run: `npx vitest run src/components/preferences/panes/__tests__/IntegrationsPane.test.tsx`
Expected: FAIL on unresolved imports (`@/lib/api-integration-keys`, `../IntegrationsPane`).

- [ ] **Step 3: API client**

`src/lib/api-integration-keys.ts`:

```ts
import { crmFetch } from '@/lib/api-crm'

export interface IntegrationKeyStatus {
  name: string
  label: string
  source: 'settings' | 'env' | 'none'
  last4: string | null
  updated_by_name: string | null
  updated_at: string | null
  undecryptable: boolean
}

export interface IntegrationKeyList {
  configured: boolean
  keys: IntegrationKeyStatus[]
}

export interface IntegrationKeyTest {
  ok: boolean
  outcome: 'ok' | 'rejected' | 'unavailable' | 'not_set'
}

const path = (name: string) => `/admin/integrations/${encodeURIComponent(name)}`
const none = () => new URLSearchParams()

export function getIntegrationKeys(): Promise<IntegrationKeyList> {
  return crmFetch('/admin/integrations', none())
}

export function saveIntegrationKey(name: string, value: string): Promise<IntegrationKeyStatus> {
  return crmFetch(path(name), none(), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  })
}

export function testIntegrationKey(name: string): Promise<IntegrationKeyTest> {
  return crmFetch(`${path(name)}/test`, none(), { method: 'POST' })
}

export function clearIntegrationKey(name: string): Promise<IntegrationKeyStatus> {
  return crmFetch(path(name), none(), { method: 'DELETE' })
}
```

- [ ] **Step 4: Pane**

`src/components/preferences/panes/IntegrationsPane.tsx`:

```tsx
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuthStore } from '@/store/auth-store'
import { CrmError } from '@/lib/api-crm'
import {
  clearIntegrationKey,
  getIntegrationKeys,
  saveIntegrationKey,
  testIntegrationKey,
  type IntegrationKeyList,
  type IntegrationKeyStatus,
} from '@/lib/api-integration-keys'
import { SettingsSection } from '../shared/SettingsComponents'

const QK = ['integration-keys']
const SOURCE = {
  settings: 'Saved in Settings',
  env: 'From server env',
  none: 'Not set',
} as const

function saveError(e: unknown, label: string): string {
  const code = e instanceof CrmError ? e.code : null
  if (code === 'key_rejected') return `${label} rejected this key.`
  if (code === 'provider_unavailable') return `${label} is not answering; nothing was saved.`
  if (code === 'invalid_input') return 'Paste a key first (512 characters at most).'
  if (code === 'keys_not_configured') return 'Key storage is not set up on this server.'
  return 'Could not save. Nothing was changed.'
}

const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''

function KeyRow({ k, configured }: { k: IntegrationKeyStatus; configured: boolean }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const put = (row: IntegrationKeyStatus) =>
    qc.setQueryData<IntegrationKeyList>(QK, old =>
      old ? { ...old, keys: old.keys.map(x => (x.name === row.name ? row : x)) } : old
    )

  const save = async () => {
    setBusy(`Testing with ${k.label}...`)
    setMsg(null)
    try {
      put(await saveIntegrationKey(k.name, value))
      setValue('')
      setEditing(false)
      setMsg({ ok: true, text: 'Saved and working.' })
    } catch (e) {
      setMsg({ ok: false, text: saveError(e, k.label) })
    } finally {
      setBusy(null)
    }
  }

  const test = async () => {
    setBusy('Testing...')
    setMsg(null)
    try {
      const r = await testIntegrationKey(k.name)
      const text = {
        ok: 'Working.',
        rejected: `${k.label} rejected the key in use.`,
        unavailable: `${k.label} is not answering.`,
        not_set: 'No key is set.',
      }[r.outcome]
      setMsg({ ok: r.ok, text })
    } catch {
      setMsg({ ok: false, text: 'Could not run the test.' })
    } finally {
      setBusy(null)
    }
  }

  const revert = async () => {
    setBusy('Switching to the server env...')
    setMsg(null)
    try {
      put(await clearIntegrationKey(k.name))
    } catch {
      setMsg({ ok: false, text: 'Could not switch. Nothing was changed.' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{k.label}</span>
        <span className="rounded-md bg-muted px-2 py-0.5 text-xs">{SOURCE[k.source]}</span>
        {k.last4 && <span className="text-xs text-muted-foreground">ends in {k.last4}</span>}
        {k.updated_by_name && (
          <span className="text-xs text-muted-foreground">
            Updated by {k.updated_by_name}, {day(k.updated_at)}
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" disabled={!configured || busy !== null}
            onClick={() => setEditing(e => !e)}>
            Replace
          </Button>
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void test()}>
            Test
          </Button>
          {k.source === 'settings' && (
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void revert()}>
              Use server env
            </Button>
          )}
        </div>
      </div>
      {k.undecryptable && (
        <p className="text-xs text-amber-600">
          The saved key can't be read (the encryption key changed). Using the server env value. Replace it to fix.
        </p>
      )}
      {editing && (
        <div className="flex gap-2">
          <Input
            type="password"
            autoComplete="off"
            aria-label={`New ${k.label} key`}
            value={value}
            onChange={e => setValue(e.target.value)}
          />
          <Button size="sm" disabled={!value.trim() || busy !== null} onClick={() => void save()}>
            Save and test
          </Button>
        </div>
      )}
      {busy && (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> {busy}
        </p>
      )}
      {msg && <p className={msg.ok ? 'text-xs text-emerald-600' : 'text-xs text-red-500'}>{msg.text}</p>}
    </div>
  )
}

/** Settings > Integrations: third-party API keys, write-only (spec 2026-10-10 section 5). */
export function IntegrationsPane() {
  const isAdmin = useAuthStore(state => state.user?.role === 'admin')
  const q = useQuery({ queryKey: QK, queryFn: getIntegrationKeys, enabled: isAdmin, retry: false })
  if (!isAdmin) return <p className="text-sm text-muted-foreground">Only admins can manage integration keys.</p>
  return (
    <SettingsSection title="API keys">
      {q.isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      {q.isError && <p className="text-sm text-red-500">Could not load the integration keys.</p>}
      {q.data && !q.data.configured && (
        <p className="text-sm text-amber-600">
          Key storage is not set up on this server (INTEGRATION_KEYS_SECRET is missing). Keys still come from the
          server env.
        </p>
      )}
      {q.data && (
        <div className="flex flex-col gap-3">
          {q.data.keys.map(k => (
            <KeyRow key={k.name} k={k} configured={q.data.configured} />
          ))}
        </div>
      )}
    </SettingsSection>
  )
}
```

- [ ] **Step 5: Navigation, locales**

In `src/components/preferences/panes.tsx`:
- add `| 'integrations'` to the `PreferencePane` union
- add `adminOnly?: boolean` to `NavigationItem`
- add `{ id: 'integrations', labelKey: 'preferences.integrations', icon: KeyRound, adminOnly: true },` before the `advanced` item (`KeyRound` from `lucide-react`)
- add `integrations: IntegrationsPane,` to `PANE_COMPONENTS` with `import { IntegrationsPane } from './panes/IntegrationsPane'`
- append:

```ts
/** The nav items this user may see: admin-only panes are hidden from everyone else. */
export function visibleNavItems(isAdmin: boolean): readonly NavigationItem[] {
  return navigationItems.filter(item => !item.adminOnly || isAdmin)
}
```

In `src/components/preferences/SettingsPage.tsx`: import `visibleNavItems` instead of `navigationItems`, add `const isAdmin = useAuthStore(state => state.user?.role === 'admin')` (import from `@/store/auth-store`), and map over `visibleNavItems(isAdmin)`. `SettingsPage.test.tsx` mocks `./panes`; if it now fails on the missing `visibleNavItems`, add `visibleNavItems: () => [...the mocked items]` to that mock (stale-test fix, not a behaviour change).

Locales, next to `"preferences.documents"` in each file: en `"preferences.integrations": "Integrations"`, fr `"preferences.integrations": "Intégrations"`, ar `"preferences.integrations": "التكاملات"`.

- [ ] **Step 6: Run to watch them pass, then the neighbours and the gates**

Run:
- `npx vitest run src/components/preferences/`
- `npx tsc --noEmit -p .`
- `npx eslint` on the changed files (list them explicitly)

Expected: PASS and clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/api-integration-keys.ts src/components/preferences/panes/IntegrationsPane.tsx src/components/preferences/panes/__tests__/IntegrationsPane.test.tsx src/components/preferences/panes.tsx src/components/preferences/SettingsPage.tsx locales/en.json locales/fr.json locales/ar.json
git commit -m "feat(integration-keys): Settings > Integrations pane (admin, write-only)"
```

---

## After the tasks (not code)

Rollout per spec section 7:
1. Generate `INTEGRATION_KEYS_SECRET` inside the prod backend container and append it to `backend/.env` with a dated backup, without printing it. The Handler keeps a copy in the vault.
2. Deploy.
3. Restart.
4. Smoke: list, Test each row, save the current Close key, then revert to the server env.
