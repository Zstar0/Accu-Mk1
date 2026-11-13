# Agent Users Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mk1 machine principals ("agents") that authenticate with a username + key, are refused everywhere except an explicit route allow-list (documents always, Lab tools and COA publishing as per-agent switches), and are managed in Settings > Agents; plus labmanager-mcp support for the key.

**Architecture:** An agent is a `users` row with `role='agent'` plus one `agent_credentials` row (sha256 of the key secret, switches, last used). `auth.get_current_user` recognises an `mk1a.` bearer and resolves it through `agents/auth.py`, which accepts only `(method, route template)` pairs listed in `agents/access.py`; with no matched route it refuses (fail closed). On the documents routes an agent becomes an `AgentWriter` (never a `User`), so every existing agent deny keeps working. Admin CRUD lives at `/admin/agents`.

**Tech Stack:** FastAPI + SQLAlchemy 2 (Mk1 backend, Postgres in prod, SQLite in tests), React + TanStack Query + shadcn (Mk1 frontend, npm), Python FastMCP (labmanager-mcp).

**Spec:** `docs/superpowers/specs/2026-10-12-agent-users-design.md`

## Global Constraints

- Agent username grammar: `^[a-z0-9][a-z0-9_-]{0,39}$`, input stripped and lowercased before validation.
- Key wire format: `mk1a.<username>.<secret>`, `secret = secrets.token_urlsafe(32)`; only `sha256(secret)` hex is stored; `key_hint` = first 6 chars of the secret.
- Agent email: `<username>@agent.invalid`; role `agent`; password = bcrypt of a discarded random secret.
- Exact texts: 401 body detail `invalid agent key` (same for every auth failure); 403 detail `agent keys cannot use this endpoint`.
- `coa_publishing` requires `lab_tools`; turning `lab_tools` off also clears `coa_publishing`.
- Admin API errors use `detail: {"code": "<code>"}` (the frontend's `crmFetch` reads `detail.code`).
- Names in `MK1_DOCUMENT_AGENT_TOKENS` (`jarvis`, `tars`) are refused as agent usernames.
- Mk1 repo: files LF (`git ls-files --eol` must show `i/lf`), commit with explicit pathspecs only (never `git add -A`; `.impeccable/` and others are untracked), `core.autocrlf=false` in this repo.
- Backend tests: `PY=/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe`, run from `backend/` as `$PY -m pytest -q -p no:cacheprovider -W ignore::DeprecationWarning <files>`. One backend suite at a time (they can deadlock on the host dev Postgres). Never bare `python`/`python3`.
- Frontend: npm only. `npx tsc --noEmit`, `npx eslint --max-warnings 0 <files>`, `npx prettier --check <files>`, `npx vitest run <paths>`.
- Docs and CHANGELOG: no em dashes.
- Bash heredocs turn `\n` into real newlines here: write scripts and files with the Write tool.

## Review Focus

1. **A key pasted with spaces or a trailing newline** (copied from a dialog into Paperclip): the MCP strips both values and the server's parser strips the bearer, so it still works (Task 3 `test_whitespace_around_the_key_is_tolerated`, Task 9 `test_agent_values_are_stripped`).
2. **The wrong agent's key pasted into a connection**: the MCP refuses at start when the name inside the key differs from `LABMGR_MK1_AGENT_NAME`, without printing the key (Task 9 `test_key_for_another_agent_is_refused_without_echo`).
3. **Usernames that differ only by case or carry spaces** (`" Pia "`): normalised to `pia`; a second `PIA` is `name_taken`, not a second agent (Task 4 `test_username_is_normalised_and_unique_case_insensitively`).
4. **Turning Lab tools off while COA publishing is on**: COA turns off with it and COA routes are 403 on the next call (Task 4 `test_lab_off_clears_coa`).
5. **An attempt to rename an agent through PATCH or to manage it through the people endpoints** (`PUT /auth/users/{id}`, reset-password): refused, so a username always means one principal (Task 4 `test_patch_cannot_rename`, Task 6 `test_user_admin_cannot_touch_agents`).

---

### Task 1: Agent identity, key format and credential table

**Files:**
- Create: `backend/agents/__init__.py`, `backend/agents/models.py`, `backend/agents/keys.py`, `backend/tests/agents_support.py`, `backend/tests/test_agents_keys.py`
- Modify: `backend/database.py` (init_db model imports, after `import boards.models`)

**Interfaces:**
- Produces: `agents.keys.PREFIX = "mk1a."`, `USERNAME_RE`, `new_secret() -> str`, `hash_secret(secret) -> str`, `wire_key(username, secret) -> str`, `hint(secret) -> str`, `is_agent_key(token) -> bool`, `parse(token) -> tuple[str, str] | None`, `email_for(username) -> str`, `username_of(user) -> str`; `agents.models.AgentCredential`; test fixture `app_client` yielding `(TestClient, Session)`, helpers `make_admin(db) -> (User, headers)`, `make_agent(db, username="pia", lab_tools=False, coa_publishing=False) -> (User, headers)` (the latter uses Task 4's service; Tasks 1 to 3 build agent rows directly), `restricted_space(db, slug="leadership") -> (DocumentSpace, UserGroup)`, `HTML`.

- [ ] **Step 1: Write the failing test** `backend/tests/test_agents_keys.py`

```python
"""Agent key format (spec 2026-10-12 section 3.3)."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


def test_wire_key_round_trips_and_only_the_hash_is_derivable():
    from agents import keys
    secret = keys.new_secret()
    assert len(secret) >= 40 and "." not in secret
    token = keys.wire_key("pia", secret)
    assert token.startswith("mk1a.pia.") and keys.is_agent_key(token)
    assert keys.parse(token) == ("pia", secret)
    assert keys.hash_secret(secret) != secret and len(keys.hash_secret(secret)) == 64
    assert keys.hint(secret) == secret[:6]


def test_parse_refuses_malformed_keys():
    from agents import keys
    good = keys.new_secret()
    for bad in ("mk1a.pia", "mk1a..x" + good, "mk1a.Pia." + good, "mk1a.pia.short",
                "eyJhbGciOiJIUzI1NiJ9.x.y", "", "mk1a.p!a." + good):
        assert keys.parse(bad) is None, bad
    assert not keys.is_agent_key("eyJhbGciOiJIUzI1NiJ9.x.y") and not keys.is_agent_key(None)


def test_whitespace_around_the_key_is_tolerated():
    from agents import keys
    secret = keys.new_secret()
    assert keys.parse(f"  {keys.wire_key('pia', secret)} \n") == ("pia", secret)


def test_email_and_username_mapping():
    from types import SimpleNamespace
    from agents import keys
    assert keys.email_for("pia") == "pia@agent.invalid"
    assert keys.username_of(SimpleNamespace(email="pia@agent.invalid")) == "pia"


def test_credential_table_is_created(app_client):
    from sqlalchemy import inspect
    _, db = app_client
    cols = {c["name"] for c in inspect(db.get_bind()).get_columns("agent_credentials")}
    assert {"user_id", "key_hash", "key_hint", "lab_tools", "coa_publishing", "created_at",
            "created_by_user_id", "rotated_at", "last_used_at"} <= cols


from agents_support import app_client  # noqa: E402,F401
```

- [ ] **Step 2: Run it to verify it fails**

Run: `$PY -m pytest -q -p no:cacheprovider tests/test_agents_keys.py`
Expected: FAIL with `ModuleNotFoundError: No module named 'agents'` (or `agents_support`).

- [ ] **Step 3: Implement** `backend/agents/__init__.py` (empty docstring module), `backend/agents/keys.py`, `backend/agents/models.py`, and the shared fixture.

`backend/agents/__init__.py`:

```python
"""Agent users: machine principals that authenticate with a username + key (spec 2026-10-12)."""
```

`backend/agents/keys.py`:

```python
"""Agent key format (spec 2026-10-12 section 3.3): mk1a.<username>.<secret>.
Only sha256(secret) is stored: the secret is 256 random bits, so stretching adds nothing."""
from __future__ import annotations

import hashlib
import re
import secrets
from typing import Optional

PREFIX = "mk1a."
USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
EMAIL_DOMAIN = "agent.invalid"  # reserved TLD: never deliverable, never a person's address
_MIN_SECRET = 40


def new_secret() -> str:
    return secrets.token_urlsafe(32)


def hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def wire_key(username: str, secret: str) -> str:
    return f"{PREFIX}{username}.{secret}"


def hint(secret: str) -> str:
    return secret[:6]


def is_agent_key(token) -> bool:
    return isinstance(token, str) and token.strip().startswith(PREFIX)


def parse(token: str) -> Optional[tuple[str, str]]:
    """(username, secret), or None for anything malformed."""
    if not is_agent_key(token):
        return None
    username, sep, secret = token.strip()[len(PREFIX):].partition(".")
    if not sep or not USERNAME_RE.match(username) or len(secret) < _MIN_SECRET:
        return None
    return username, secret


def email_for(username: str) -> str:
    return f"{username}@{EMAIL_DOMAIN}"


def username_of(user) -> str:
    return (getattr(user, "email", "") or "").split("@", 1)[0]
```

`backend/agents/models.py`:

```python
"""Agent credentials (spec 2026-10-12 section 3.2). The agent itself is a `users` row with
role 'agent'; this row holds its key hash and switches. One row, one live key, per agent."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from database import Base


class AgentCredential(Base):
    __tablename__ = "agent_credentials"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    key_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    key_hint: Mapped[str] = mapped_column(String(8), nullable=False)
    lab_tools: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    # Honoured only together with lab_tools (agents/access.scopes_for).
    coa_publishing: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False,
                                                 server_default="false")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    created_by_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    rotated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_used_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
```

In `backend/database.py` `init_db()`, after `import boards.models  # noqa: F401 ...` add:

```python
    import agents.models  # noqa: F401  (register agent_credentials on Base)
```

`backend/tests/agents_support.py` (the REAL app and REAL auth: nothing overrides `get_current_user`):

```python
"""Shared fixture for agent tests: the real app and real auth on in-memory SQLite. Nothing
overrides get_current_user, so every request authenticates the way production does."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

HTML = ("<!doctype html><html><head><title>t</title><style>/* accumark-docs v1 */</style></head>"
        "<body><p>hi</p></body></html>")


@pytest.fixture
def app_client():
    from fastapi.testclient import TestClient
    from main import app
    from database import Base, get_db
    import models  # noqa: F401
    import flags.models  # noqa: F401
    import documents.models  # noqa: F401
    import groups.models  # noqa: F401
    import boards.models  # noqa: F401
    import agents.models  # noqa: F401
    from documents import service, storage

    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    service.seed_categories(db)
    service.seed_spaces(db)
    storage.set_storage_for_tests(storage.InMemoryDocumentStorage())

    def _db():
        yield db

    saved = dict(app.dependency_overrides)
    app.dependency_overrides.clear()
    app.dependency_overrides[get_db] = _db
    yield TestClient(app), db
    app.dependency_overrides.clear()
    app.dependency_overrides.update(saved)
    db.close()


def make_admin(db, email="admin@x.t"):
    import models
    from auth import create_access_token, get_password_hash
    u = models.User(email=email, hashed_password=get_password_hash("pw-12345678"), role="admin",
                    is_active=True, first_name="Ada", last_name="Admin")
    db.add(u)
    db.commit()
    return u, {"Authorization": f"Bearer {create_access_token({'sub': str(u.id)})}"}


def make_agent(db, username="pia", lab_tools=False, coa_publishing=False):
    from agents import service
    user, key = service.create_agent(db, username=username, display_name=username.title(),
                                     lab_tools=lab_tools, coa_publishing=coa_publishing,
                                     created_by_user_id=None)
    return user, {"Authorization": f"Bearer {key}"}


def restricted_space(db, slug="leadership"):
    from documents.models import DocumentSpace, DocumentSpaceGrant
    from groups.models import UserGroup
    g = UserGroup(slug=f"{slug}-group", name=f"{slug} group")
    sp = DocumentSpace(slug=slug, name=slug.title(), visibility="restricted")
    db.add_all([g, sp])
    db.flush()
    db.add(DocumentSpaceGrant(space_id=sp.id, group_id=g.id))
    db.commit()
    return sp, g
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `$PY -m pytest -q -p no:cacheprovider tests/test_agents_keys.py`
Expected: `5 passed`.

- [ ] **Step 5: Commit**

```bash
git add -- backend/agents/__init__.py backend/agents/keys.py backend/agents/models.py backend/tests/agents_support.py backend/tests/test_agents_keys.py backend/database.py
git ls-files --eol -- backend/agents backend/tests/agents_support.py backend/tests/test_agents_keys.py
git commit -m "feat(agents): key format, credential table, shared test fixture" -- backend/agents/__init__.py backend/agents/keys.py backend/agents/models.py backend/tests/agents_support.py backend/tests/test_agents_keys.py backend/database.py
```

---

### Task 2: The route allow-list

**Files:**
- Create: `backend/agents/access.py`, `backend/tests/test_agents_access.py`

**Interfaces:**
- Consumes: `AgentCredential` (Task 1) for `scopes_for`.
- Produces: `agents.access.DOCUMENTS`, `LAB`, `COA` (frozensets of `(METHOD, template)`), `scopes_for(cred) -> frozenset[str]`, `allowed(scopes, method, template) -> bool`, `all_routes() -> frozenset`.

- [ ] **Step 1: Write the failing test** `backend/tests/test_agents_access.py`

```python
"""The agent route allow-list (spec 2026-10-12 section 3.4)."""
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


def test_every_listed_template_exists_in_the_app_with_that_method():
    from fastapi.routing import APIRoute
    from main import app
    from agents import access
    present = {(m, r.path) for r in app.routes if isinstance(r, APIRoute) for m in r.methods}
    missing = sorted(access.all_routes() - present)
    assert missing == [], f"allow-list names routes the app does not have: {missing}"


def test_scopes_follow_the_switches_and_coa_needs_lab():
    from agents import access
    cred = lambda lab, coa: SimpleNamespace(lab_tools=lab, coa_publishing=coa)  # noqa: E731
    assert access.scopes_for(cred(False, False)) == {"documents"}
    assert access.scopes_for(cred(True, False)) == {"documents", "lab"}
    assert access.scopes_for(cred(True, True)) == {"documents", "lab", "coa"}
    assert access.scopes_for(cred(False, True)) == {"documents"}  # COA alone is never honoured


def test_allowed_is_exact_and_deny_by_default():
    from agents import access
    docs = frozenset({"documents"})
    assert access.allowed(docs, "get", "/api/documents/{doc_id}")
    assert not access.allowed(docs, "DELETE", "/api/documents/{doc_id}")
    assert not access.allowed(docs, "GET", "/api/flags")
    assert not access.allowed(docs | {"lab"}, "POST", "/wizard/senaite/samples/{sample_id}/publish-coa")
    assert access.allowed(docs | {"lab", "coa"}, "POST", "/wizard/senaite/samples/{sample_id}/publish-coa")
    assert not access.allowed(docs | {"lab", "coa"}, "GET", "/auth/users")


def test_admin_and_destructive_document_routes_are_never_listed():
    from agents import access
    for pair in [("DELETE", "/api/documents/{doc_id}"), ("PUT", "/api/documents/{doc_id}/content"),
                 ("POST", "/api/document-categories"), ("POST", "/api/document-spaces"),
                 ("PUT", "/api/document-spaces/{space_id}/grants"), ("POST", "/api/flags/types"),
                 ("PATCH", "/api/sub-samples/{sample_id}")]:
        assert pair not in access.all_routes(), pair
```

- [ ] **Step 2: Run it to verify it fails**

Run: `$PY -m pytest -q -p no:cacheprovider tests/test_agents_access.py`
Expected: FAIL with `ModuleNotFoundError: No module named 'agents.access'`.

- [ ] **Step 3: Implement** `backend/agents/access.py`

```python
"""Which routes an agent key may call (spec 2026-10-12 section 3.4). The ONLY place that answers
it. Deny by default: a route not listed here refuses every agent, including routes added later.
Templates are FastAPI route templates exactly as `app.routes` holds them (tests pin each one)."""
from __future__ import annotations

_G, _P, _PATCH, _D = "GET", "POST", "PATCH", "DELETE"

DOCUMENTS = frozenset({
    (_G, "/api/document-categories"), (_G, "/api/document-spaces"),
    (_G, "/api/documents"), (_G, "/api/documents/{doc_id}"), (_G, "/api/documents/{doc_id}/content"),
    (_P, "/api/documents"), (_PATCH, "/api/documents/{doc_id}"),
    (_P, "/api/documents/{doc_id}/activate"), (_P, "/api/documents/{doc_id}/retire"),
    (_G, "/api/documents/comment-labels"), (_G, "/api/documents/comments"),
    (_G, "/api/documents/comments/{comment_id}"), (_PATCH, "/api/documents/comments/{comment_id}"),
    (_D, "/api/documents/comments/{comment_id}"),
    (_P, "/api/documents/comments/{comment_id}/resolve"), (_P, "/api/documents/comments/{comment_id}/reopen"),
    (_G, "/api/documents/{doc_id}/comments"), (_P, "/api/documents/{doc_id}/comments"),
    (_G, "/api/documents/{doc_id}/comments/export"),
    (_P, "/api/documents/{doc_id}/comment-attachments"),
    (_G, "/api/documents/comment-attachments/{attachment_id}"),
})

# Exactly what labmanager-mcp's lab tools call (tools/reads.py, media.py, flags.py, flagging.py,
# reports.py and the read half of coa.py). Reads, plus raising and commenting on flags.
LAB = frozenset({
    (_G, "/senaite/samples"), (_G, "/wizard/senaite/lookup"),
    (_G, "/api/lims-analyses"), (_G, "/api/lims-analyses/promotions"),
    (_G, "/api/lims-analyses/parent/{sample_id}/native-analyses"), (_G, "/api/conformance/{sample_id}"),
    (_G, "/api/sub-samples"), (_G, "/api/sub-samples/{sample_id}/chromatograms"),
    (_G, "/api/sub-samples/{parent_sample_id}/variance-set"),
    (_G, "/api/sub-samples/{sample_id}/attachments"),
    (_G, "/api/sub-samples/{sample_id}/attachments/{attachment_id}"),
    (_G, "/api/sub-samples/{sample_id}/photo"),
    (_G, "/api/flags"), (_G, "/api/flags/types"), (_P, "/api/flags"), (_P, "/api/flags/{flag_id}/comments"),
    (_G, "/explorer/coa-generations"),
    (_G, "/reports/dashboard"), (_G, "/reports/throughput"), (_G, "/reports/turnaround"),
    (_G, "/reports/sla-performance"), (_G, "/reports/checkin-times"), (_G, "/reports/analyte-trends"),
    (_G, "/reports/purity-trend/{analyte_name}"), (_G, "/reports/ready-to-publish"),
    (_G, "/reports/ready-to-publish/summary"), (_G, "/reports/sync-status"),
    (_G, "/reports/customers/summary"), (_G, "/reports/customers/list"), (_G, "/reports/customers/orders"),
    (_G, "/reports/customers/cohorts"), (_G, "/reports/customers/at-risk"),
    (_G, "/reports/customers/churn-signals"), (_G, "/reports/customers/changes"),
    (_G, "/reports/customers/{customer_key}"),
})

# Changes what customers receive: its own switch, honoured only with Lab tools.
COA = frozenset({
    (_P, "/wizard/senaite/samples/{sample_id}/generate-coa"),
    (_P, "/wizard/senaite/samples/{sample_id}/generate-vial-coas"),
    (_P, "/wizard/senaite/samples/{sample_id}/publish-coa"),
})

_BY_SCOPE = {"documents": DOCUMENTS, "lab": LAB, "coa": COA}


def scopes_for(cred) -> frozenset:
    scopes = {"documents"}
    if cred.lab_tools:
        scopes.add("lab")
        if cred.coa_publishing:
            scopes.add("coa")
    return frozenset(scopes)


def allowed(scopes, method: str, template: str) -> bool:
    pair = (method.upper(), template)
    return any(pair in _BY_SCOPE[s] for s in scopes)


def all_routes() -> frozenset:
    return DOCUMENTS | LAB | COA
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `$PY -m pytest -q -p no:cacheprovider tests/test_agents_access.py`
Expected: `4 passed`. If the first test lists a missing template, fix the TEMPLATE (copy it from `app.routes`), never delete the test.

- [ ] **Step 5: Commit**

```bash
git add -- backend/agents/access.py backend/tests/test_agents_access.py
git commit -m "feat(agents): deny-by-default route allow-list (documents, lab, coa)" -- backend/agents/access.py backend/tests/test_agents_access.py
```

---

### Task 3: Authenticating an agent key (one choke point, fail closed)

**Files:**
- Create: `backend/agents/auth.py`, `backend/tests/test_agents_auth.py`
- Modify: `backend/auth.py` (imports; `get_current_user`)

**Interfaces:**
- Consumes: `agents.keys` (Task 1), `agents.access` (Task 2), `AgentCredential`.
- Produces: `agents.auth.DENIED = "agent keys cannot use this endpoint"`, `resolve(db, token) -> (User, AgentCredential)` (401 on any failure), `agent_for_route(db, token, request) -> User` (401, or 403 off the allow-list or with no matched route). `auth.get_current_user(request=None, token=..., db=...)`.

- [ ] **Step 1: Write the failing test** `backend/tests/test_agents_auth.py` (builds agent rows with a local helper, so it does not wait for Task 4's service)

```python
"""Agent key authentication (spec 2026-10-12 sections 3.3, 3.4)."""
import os
import sys
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

sys.path.insert(0, os.path.dirname(__file__))
from agents_support import app_client  # noqa: E402,F401


def _agent(db, username="pia", lab=False, coa=False, active=True):
    """Row-level helper so this task does not depend on the admin service (Task 4)."""
    import models
    from agents import keys
    from agents.models import AgentCredential
    from auth import get_password_hash
    secret = keys.new_secret()
    u = models.User(email=keys.email_for(username), hashed_password=get_password_hash(keys.new_secret()),
                    role="agent", is_active=active, first_name=username.title())
    db.add(u)
    db.flush()
    db.add(AgentCredential(user_id=u.id, key_hash=keys.hash_secret(secret), key_hint=keys.hint(secret),
                           lab_tools=lab, coa_publishing=coa))
    db.commit()
    return u, keys.wire_key(username, secret)


def _h(key):
    return {"Authorization": f"Bearer {key}"}


def test_documents_route_accepts_the_agent(app_client):
    c, db = app_client
    _, key = _agent(db)
    assert c.get("/api/documents", headers=_h(key)).status_code == 200


def test_unlisted_route_is_403_with_the_exact_text(app_client):
    c, db = app_client
    _, key = _agent(db)
    for path in ("/api/flags/types", "/auth/me", "/worksheets/users"):
        r = c.get(path, headers=_h(key))
        assert (r.status_code, r.json()) == (403, {"detail": "agent keys cannot use this endpoint"}), path


def test_lab_switch_opens_lab_routes_only(app_client):
    c, db = app_client
    _, key = _agent(db, lab=True)
    assert c.get("/api/flags/types", headers=_h(key)).status_code == 200
    r = c.post("/wizard/senaite/samples/P-1/publish-coa", headers=_h(key), json={})
    assert r.status_code == 403


def test_coa_route_passes_auth_only_with_lab_and_coa(app_client):
    """Checked at the dependency, so no COA handler (network) runs in the test."""
    from fastapi import HTTPException
    from agents.auth import agent_for_route
    _, db = app_client
    route = SimpleNamespace(path="/wizard/senaite/samples/{sample_id}/publish-coa")
    req = SimpleNamespace(method="POST", scope={"route": route})
    _, lab_only = _agent(db, "lab-only", lab=True)
    with pytest.raises(HTTPException) as e:
        agent_for_route(db, lab_only, req)
    assert e.value.status_code == 403
    user, both = _agent(db, "coa-agent", lab=True, coa=True)
    assert agent_for_route(db, both, req).id == user.id


def test_every_auth_failure_is_the_same_401(app_client):
    from agents import keys
    c, db = app_client
    _, key = _agent(db)
    _, off = _agent(db, "dormant", active=False)
    wrong = key.rsplit(".", 1)[0] + "." + keys.new_secret()
    unknown = keys.wire_key("nobody", keys.new_secret())
    bodies = set()
    for bad in (wrong, unknown, off, "mk1a.pia.short"):
        r = c.get("/api/documents", headers=_h(bad))
        assert r.status_code == 401, bad[:12]
        bodies.add(r.text)
    assert bodies == {'{"detail":"invalid agent key"}'}


def test_direct_call_without_a_route_fails_closed(app_client):
    from fastapi import HTTPException
    from auth import get_current_user
    _, db = app_client
    _, key = _agent(db)
    with pytest.raises(HTTPException) as e:
        get_current_user(token=key, db=db)
    assert e.value.status_code == 403


def test_a_jwt_for_an_agent_row_is_refused(app_client):
    from auth import create_access_token
    c, db = app_client
    user, _ = _agent(db)
    r = c.get("/auth/me", headers=_h(create_access_token({"sub": str(user.id)})))
    assert r.status_code == 401


def test_last_used_is_written_at_most_every_five_minutes(app_client):
    from agents.models import AgentCredential
    c, db = app_client
    user, key = _agent(db)
    c.get("/api/documents", headers=_h(key))
    first = db.get(AgentCredential, user.id).last_used_at
    assert first is not None
    c.get("/api/documents", headers=_h(key))
    db.expire_all()
    assert db.get(AgentCredential, user.id).last_used_at == first
    cred = db.get(AgentCredential, user.id)
    cred.last_used_at = datetime.utcnow() - timedelta(minutes=6)
    db.commit()
    c.get("/api/documents", headers=_h(key))
    db.expire_all()
    assert db.get(AgentCredential, user.id).last_used_at > first


def test_whitespace_around_the_key_is_tolerated(app_client):
    c, db = app_client
    _, key = _agent(db)
    assert c.get("/api/documents", headers={"Authorization": f"Bearer  {key}  "}).status_code == 200
```

- [ ] **Step 2: Run it to verify it fails**

Run: `$PY -m pytest -q -p no:cacheprovider tests/test_agents_auth.py`
Expected: FAIL (`No module named 'agents.auth'`; agent keys currently decode as bad JWTs -> 401 where 200/403 is expected).

- [ ] **Step 3: Implement** `backend/agents/auth.py`

```python
"""Resolving an agent key (spec 2026-10-12 sections 3.3, 3.4). Every failure to authenticate is
the same 401; an authenticated agent off its allow-list, or with no matched route, is 403."""
from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta

from fastapi import HTTPException, status

from agents import access, keys

logger = logging.getLogger(__name__)
DENIED = "agent keys cannot use this endpoint"
_TOUCH_EVERY = timedelta(minutes=5)
_NO_HASH = "0" * 64  # compared when the name is unknown, so both paths do the same work


def _invalid() -> HTTPException:
    return HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid agent key",
                         headers={"WWW-Authenticate": "Bearer"})


def resolve(db, token: str):
    """(user, credential) for a valid key of an ACTIVE agent; 401 otherwise."""
    from models import User
    from agents.models import AgentCredential
    parsed = keys.parse(token)
    if parsed is None:
        raise _invalid()
    username, secret = parsed
    user = (db.query(User)
            .filter(User.email == keys.email_for(username), User.role == "agent").first())
    cred = db.get(AgentCredential, user.id) if user is not None else None
    match = secrets.compare_digest(keys.hash_secret(secret), cred.key_hash if cred else _NO_HASH)
    if not (match and cred is not None and user.is_active):
        logger.warning("agents.auth_failed username=%s", username[:40])
        raise _invalid()
    now = datetime.utcnow()
    if cred.last_used_at is None or now - cred.last_used_at > _TOUCH_EVERY:
        cred.last_used_at = now
        db.commit()
    return user, cred


def agent_for_route(db, token: str, request):
    """The agent's user row, only on a route its scopes allow. No request or no matched route
    (a direct call outside FastAPI dependency injection) is refused: fail closed."""
    user, cred = resolve(db, token)
    route = request.scope.get("route") if request is not None else None
    template = getattr(route, "path", None)
    if template is None or not access.allowed(access.scopes_for(cred), request.method, template):
        raise HTTPException(status.HTTP_403_FORBIDDEN, DENIED)
    return user
```

In `backend/auth.py` change the FastAPI import to include `Request`:

```python
from fastapi import Depends, Header, HTTPException, Request, status
```

and replace `get_current_user` with:

```python
def get_current_user(
    request: Request = None,  # type: ignore[assignment]  # FastAPI injects it; direct calls pass none
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    """Dependency: the current user from a JWT, or an agent from an mk1a. key. An agent is
    accepted only on routes its switches allow (agents/access.py); with no matched route (a direct
    call) it is refused, so no caller can bypass the allow-list."""
    from models import User
    from agents.keys import is_agent_key

    if is_agent_key(token):
        from agents.auth import agent_for_route
        return agent_for_route(db, token, request)

    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        sub = payload.get("sub")
        if sub is None:
            raise credentials_exception
        user_id = int(sub)
    except (JWTError, ValueError):
        raise credentials_exception

    user = db.query(User).filter(User.id == user_id).first()
    # Agents never hold a JWT; refuse one that names an agent row (defence in depth).
    if user is None or not user.is_active or user.role == "agent":
        raise credentials_exception

    return user
```

- [ ] **Step 4: Run the tests**

Run: `$PY -m pytest -q -p no:cacheprovider tests/test_agents_auth.py tests/test_agents_access.py tests/test_agents_keys.py`
Expected: all pass. Then confirm nothing else moved: `$PY -m pytest -q -p no:cacheprovider tests/test_documents_routes.py tests/test_documents_access.py tests/test_groups*.py` all pass.

- [ ] **Step 5: Commit**

```bash
git add -- backend/agents/auth.py backend/tests/test_agents_auth.py backend/auth.py
git commit -m "feat(agents): authenticate mk1a. keys in get_current_user, allow-listed, fail closed" -- backend/agents/auth.py backend/tests/test_agents_auth.py backend/auth.py
```

---

### Task 4: Agent administration: service and /admin/agents

**Files:**
- Create: `backend/agents/service.py`, `backend/agents/routes.py`, `backend/tests/test_agents_admin.py`
- Modify: `backend/main.py` (import + `app.include_router(agents_router)` next to `integration_keys_router`)

**Interfaces:**
- Consumes: `agents.keys`, `AgentCredential`, `groups.models.UserGroup/UserGroupMember`, `documents.routes._agent_tokens`.
- Produces: `agents.service.AgentError(status, code)`, `create_agent(db, *, username, display_name, lab_tools=False, coa_publishing=False, created_by_user_id=None) -> (User, key)`, `get_agent(db, agent_id) -> (User, AgentCredential)`, `list_agents(db) -> list[(User, AgentCredential)]`, `update_agent(db, agent_id, **fields) -> (User, AgentCredential)`, `rotate_key(db, agent_id) -> (User, AgentCredential, key)`, `set_groups(db, agent_id, group_ids) -> list[int]`, `group_ids(db, user_id) -> list[int]`. HTTP: `GET/POST /admin/agents`, `PATCH /admin/agents/{agent_id}`, `POST /admin/agents/{agent_id}/rotate-key`, `PUT /admin/agents/{agent_id}/groups`. Response `AgentOut` = `{id, username, display_name, is_active, lab_tools, coa_publishing, key_hint, created_at, created_by_name, rotated_at, last_used_at, group_ids}`; create/rotate return `{agent: AgentOut, key}`.

- [ ] **Step 1: Write the failing test** `backend/tests/test_agents_admin.py`

```python
"""Settings > Agents API (spec 2026-10-12 section 4)."""
import os
import sys
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
from agents_support import app_client, make_admin, make_agent  # noqa: E402,F401


def _create(c, admin, **over):
    body = {"username": "pia", "display_name": "Pia"}
    body.update(over)
    return c.post("/admin/agents", json=body, headers=admin)


def test_create_returns_the_key_once_and_it_works_at_once(app_client):
    c, db = app_client
    _, admin = make_admin(db)
    r = _create(c, admin)
    assert r.status_code == 201, r.text
    key = r.json()["key"]
    assert key.startswith("mk1a.pia.") and r.json()["agent"]["key_hint"] == key.split(".")[2][:6]
    listed = c.get("/admin/agents", headers=admin).json()
    assert [a["username"] for a in listed] == ["pia"] and key not in str(listed)
    assert c.get("/api/documents", headers={"Authorization": f"Bearer {key}"}).status_code == 200


def test_rotate_kills_the_old_key_immediately(app_client):
    c, db = app_client
    _, admin = make_admin(db)
    created = _create(c, admin).json()
    rotated = c.post(f"/admin/agents/{created['agent']['id']}/rotate-key", headers=admin).json()
    old, new = created["key"], rotated["key"]
    assert c.get("/api/documents", headers={"Authorization": f"Bearer {old}"}).status_code == 401
    assert c.get("/api/documents", headers={"Authorization": f"Bearer {new}"}).status_code == 200
    assert rotated["agent"]["rotated_at"] is not None


def test_deactivate_is_immediate(app_client):
    c, db = app_client
    _, admin = make_admin(db)
    created = _create(c, admin).json()
    c.patch(f"/admin/agents/{created['agent']['id']}", json={"is_active": False}, headers=admin)
    assert c.get("/api/documents", headers={"Authorization": f"Bearer {created['key']}"}).status_code == 401


def test_username_is_normalised_and_unique_case_insensitively(app_client):
    c, db = app_client
    _, admin = make_admin(db)
    assert _create(c, admin, username="  Pia ").json()["agent"]["username"] == "pia"
    r = _create(c, admin, username="PIA")
    assert (r.status_code, r.json()["detail"]["code"]) == (409, "name_taken")
    r = _create(c, admin, username="pia!")
    assert (r.status_code, r.json()["detail"]["code"]) == (400, "invalid_username")


def test_env_token_names_are_reserved(app_client):
    c, db = app_client
    _, admin = make_admin(db)
    with patch.dict(os.environ, {"MK1_DOCUMENT_AGENT_TOKENS": "jarvis:" + "j" * 40}):
        r = _create(c, admin, username="jarvis")
    assert (r.status_code, r.json()["detail"]["code"]) == (409, "name_taken")


def test_coa_needs_lab(app_client):
    c, db = app_client
    _, admin = make_admin(db)
    r = _create(c, admin, coa_publishing=True)
    assert (r.status_code, r.json()["detail"]["code"]) == (400, "coa_needs_lab")


def test_lab_off_clears_coa(app_client):
    c, db = app_client
    _, admin = make_admin(db)
    a = _create(c, admin, lab_tools=True, coa_publishing=True).json()["agent"]
    out = c.patch(f"/admin/agents/{a['id']}", json={"lab_tools": False}, headers=admin).json()
    assert (out["lab_tools"], out["coa_publishing"]) == (False, False)


def test_patch_cannot_rename(app_client):
    c, db = app_client
    _, admin = make_admin(db)
    a = _create(c, admin).json()["agent"]
    r = c.patch(f"/admin/agents/{a['id']}", json={"username": "other"}, headers=admin)
    assert r.status_code == 422


def test_groups_are_set_on_the_agent(app_client):
    from groups.models import UserGroup
    c, db = app_client
    _, admin = make_admin(db)
    g1, g2 = UserGroup(slug="a", name="A"), UserGroup(slug="b", name="B", is_active=False)
    db.add_all([g1, g2])
    db.commit()
    a = _create(c, admin).json()["agent"]
    out = c.put(f"/admin/agents/{a['id']}/groups", json={"group_ids": [g1.id]}, headers=admin).json()
    assert out["group_ids"] == [g1.id]
    r = c.put(f"/admin/agents/{a['id']}/groups", json={"group_ids": [g2.id]}, headers=admin)
    assert (r.status_code, r.json()["detail"]["code"]) == (400, "unknown_group")


def test_only_admin_logins_manage_agents(app_client):
    import models
    from auth import create_access_token, get_password_hash
    c, db = app_client
    std = models.User(email="s@x.t", hashed_password=get_password_hash("pw-12345678"), role="standard")
    db.add(std)
    db.commit()
    assert c.get("/admin/agents", headers={"Authorization":
                 f"Bearer {create_access_token({'sub': str(std.id)})}"}).status_code == 403
    _, agent = make_agent(db, "devon")
    assert c.get("/admin/agents", headers=agent).status_code == 403
```

- [ ] **Step 2: Run it to verify it fails**

Run: `$PY -m pytest -q -p no:cacheprovider tests/test_agents_admin.py`
Expected: FAIL (`/admin/agents` is 404; `agents.service` missing).

- [ ] **Step 3: Implement** `backend/agents/service.py`

```python
"""Creating and managing agent users (spec 2026-10-12 sections 3.1, 4). Keys are returned to the
caller exactly once and never stored; callers commit through these functions."""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from sqlalchemy import select

from agents import keys
from agents.models import AgentCredential

logger = logging.getLogger(__name__)


class AgentError(Exception):
    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status, self.code = status, code


def _clean_username(raw: str) -> str:
    username = (raw or "").strip().lower()
    if not keys.USERNAME_RE.match(username):
        raise AgentError(400, "invalid_username")
    from documents.routes import _agent_tokens
    if username in _agent_tokens():
        raise AgentError(409, "name_taken")  # one name never means two principals
    return username


def _clean_display(raw: Optional[str]) -> str:
    name = (raw or "").strip()
    if not name or len(name) > 100:
        raise AgentError(400, "invalid_display_name")
    return name


def create_agent(db, *, username: str, display_name: str, lab_tools: bool = False,
                 coa_publishing: bool = False, created_by_user_id: Optional[int] = None):
    from models import User
    from auth import get_password_hash
    username = _clean_username(username)
    display = _clean_display(display_name)
    if coa_publishing and not lab_tools:
        raise AgentError(400, "coa_needs_lab")
    if db.query(User).filter(User.email == keys.email_for(username)).first() is not None:
        raise AgentError(409, "name_taken")
    secret = keys.new_secret()
    user = User(email=keys.email_for(username), role="agent", is_active=True, first_name=display,
                # bcrypt of a discarded secret: verify_password never matches and never errors
                hashed_password=get_password_hash(keys.new_secret()))
    db.add(user)
    db.flush()
    db.add(AgentCredential(user_id=user.id, key_hash=keys.hash_secret(secret), key_hint=keys.hint(secret),
                           lab_tools=lab_tools, coa_publishing=coa_publishing,
                           created_by_user_id=created_by_user_id))
    db.commit()
    db.refresh(user)
    logger.info("agents.created username=%s by=%s lab=%s coa=%s", username, created_by_user_id,
                lab_tools, coa_publishing)
    return user, keys.wire_key(username, secret)


def get_agent(db, agent_id: int):
    from models import User
    user = db.get(User, int(agent_id))
    cred = db.get(AgentCredential, int(agent_id)) if user is not None else None
    if user is None or user.role != "agent" or cred is None:
        raise AgentError(404, "unknown_agent")
    return user, cred


def list_agents(db):
    from models import User
    users = db.execute(select(User).where(User.role == "agent").order_by(User.email)).scalars().all()
    return [(u, db.get(AgentCredential, u.id)) for u in users]


def update_agent(db, agent_id: int, *, display_name=None, is_active=None, lab_tools=None,
                 coa_publishing=None):
    user, cred = get_agent(db, agent_id)
    display = _clean_display(display_name) if display_name is not None else None
    lab = cred.lab_tools if lab_tools is None else bool(lab_tools)
    coa = cred.coa_publishing if coa_publishing is None else bool(coa_publishing)
    if coa_publishing and not lab:
        raise AgentError(400, "coa_needs_lab")
    if not lab:
        coa = False  # Lab tools off takes COA publishing with it
    if display is not None:
        user.first_name = display
    if is_active is not None:
        user.is_active = bool(is_active)
    cred.lab_tools, cred.coa_publishing = lab, coa
    db.commit()
    logger.info("agents.updated username=%s active=%s lab=%s coa=%s", keys.username_of(user),
                user.is_active, lab, coa)
    return user, cred


def rotate_key(db, agent_id: int):
    user, cred = get_agent(db, agent_id)
    secret = keys.new_secret()
    cred.key_hash, cred.key_hint, cred.rotated_at = keys.hash_secret(secret), keys.hint(secret), datetime.utcnow()
    db.commit()
    logger.info("agents.key_rotated username=%s", keys.username_of(user))
    return user, cred, keys.wire_key(keys.username_of(user), secret)


def group_ids(db, user_id: int) -> list[int]:
    from groups.models import UserGroupMember
    return sorted(db.execute(select(UserGroupMember.group_id)
                             .where(UserGroupMember.user_id == user_id)).scalars())


def set_groups(db, agent_id: int, wanted: list[int]) -> list[int]:
    """Replace the agent's group memberships. Every id must be an ACTIVE group."""
    from groups.models import UserGroup, UserGroupMember
    user, _ = get_agent(db, agent_id)
    ids = sorted(set(int(g) for g in wanted))
    if ids:
        ok = set(db.execute(select(UserGroup.id).where(UserGroup.id.in_(ids),
                                                       UserGroup.is_active.is_(True))).scalars())
        if set(ids) - ok:
            raise AgentError(400, "unknown_group")
    db.query(UserGroupMember).filter(UserGroupMember.user_id == user.id).delete()
    db.add_all([UserGroupMember(group_id=g, user_id=user.id) for g in ids])
    db.commit()
    return ids
```

`backend/agents/routes.py`:

```python
"""/admin/agents: Settings > Agents (spec 2026-10-12 section 4). Admin LOGIN only; an agent key
never passes require_admin. Keys appear only in create and rotate responses."""
from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from agents import keys, service
from auth import require_admin
from database import get_db

router = APIRouter(prefix="/admin/agents", tags=["agents"])


class AgentOut(BaseModel):
    id: int
    username: str
    display_name: str
    is_active: bool
    lab_tools: bool
    coa_publishing: bool
    key_hint: str
    created_at: datetime
    created_by_name: Optional[str] = None
    rotated_at: Optional[datetime] = None
    last_used_at: Optional[datetime] = None
    group_ids: List[int] = []


class AgentWithKey(BaseModel):
    agent: AgentOut
    key: str


class AgentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str
    display_name: str
    lab_tools: bool = False
    coa_publishing: bool = False


class AgentPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")  # username is immutable: a rename is a 422
    display_name: Optional[str] = None
    is_active: Optional[bool] = None
    lab_tools: Optional[bool] = None
    coa_publishing: Optional[bool] = None


class GroupsReplace(BaseModel):
    group_ids: List[int]


def _out(db, user, cred) -> AgentOut:
    from documents.comments import display_name
    creator = db.get(type(user), cred.created_by_user_id) if cred.created_by_user_id else None
    return AgentOut(id=user.id, username=keys.username_of(user), display_name=user.first_name or "",
                    is_active=user.is_active, lab_tools=cred.lab_tools, coa_publishing=cred.coa_publishing,
                    key_hint=cred.key_hint, created_at=cred.created_at,
                    created_by_name=display_name(creator) if creator else None,
                    rotated_at=cred.rotated_at, last_used_at=cred.last_used_at,
                    group_ids=service.group_ids(db, user.id))


def _http(e: service.AgentError) -> HTTPException:
    return HTTPException(status_code=e.status, detail={"code": e.code})


@router.get("", response_model=List[AgentOut])
def list_agents(db: Session = Depends(get_db), _a=Depends(require_admin)):
    return [_out(db, u, c) for u, c in service.list_agents(db)]


@router.post("", response_model=AgentWithKey, status_code=201)
def create_agent(body: AgentCreate, db: Session = Depends(get_db), admin=Depends(require_admin)):
    try:
        user, key = service.create_agent(db, username=body.username, display_name=body.display_name,
                                         lab_tools=body.lab_tools, coa_publishing=body.coa_publishing,
                                         created_by_user_id=admin.id)
        _, cred = service.get_agent(db, user.id)
    except service.AgentError as e:
        raise _http(e)
    return AgentWithKey(agent=_out(db, user, cred), key=key)


@router.patch("/{agent_id}", response_model=AgentOut)
def update_agent(agent_id: int, body: AgentPatch, db: Session = Depends(get_db),
                 _a=Depends(require_admin)):
    try:
        user, cred = service.update_agent(db, agent_id, **body.model_dump(exclude_unset=True))
    except service.AgentError as e:
        raise _http(e)
    return _out(db, user, cred)


@router.post("/{agent_id}/rotate-key", response_model=AgentWithKey)
def rotate_key(agent_id: int, db: Session = Depends(get_db), _a=Depends(require_admin)):
    try:
        user, cred, key = service.rotate_key(db, agent_id)
    except service.AgentError as e:
        raise _http(e)
    return AgentWithKey(agent=_out(db, user, cred), key=key)


@router.put("/{agent_id}/groups", response_model=AgentOut)
def put_groups(agent_id: int, body: GroupsReplace, db: Session = Depends(get_db),
               _a=Depends(require_admin)):
    try:
        service.set_groups(db, agent_id, body.group_ids)
        user, cred = service.get_agent(db, agent_id)
    except service.AgentError as e:
        db.rollback()
        raise _http(e)
    return _out(db, user, cred)
```

In `backend/main.py`, beside `from integration_keys.routes import router as integration_keys_router` add `from agents.routes import router as agents_router`, and beside `app.include_router(integration_keys_router)` add `app.include_router(agents_router)`.

- [ ] **Step 4: Run the tests**

Run: `$PY -m pytest -q -p no:cacheprovider tests/test_agents_admin.py tests/test_agents_documents.py tests/test_agents_auth.py`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -- backend/agents/service.py backend/agents/routes.py backend/tests/test_agents_admin.py backend/main.py
git diff --cached --stat
git commit -m "feat(agents): /admin/agents create, edit, rotate key, groups; key shown once" -- backend/agents/service.py backend/agents/routes.py backend/tests/test_agents_admin.py backend/main.py
```

---

### Task 5: Documents and comments: the agent is an AgentWriter, never a User

**Files:**
- Modify: `backend/documents/routes.py` (AgentWriter; `require_document_writer`; `_space_reader`; create route `user_id=`), `backend/documents/access.py` (add `visible_space_slugs`), `backend/documents/comment_routes.py` (`require_comment_actor`)
- Create: `backend/tests/test_agents_documents.py`

**Interfaces:**
- Consumes: `agents.auth.agent_for_route`, `agents.keys.is_agent_key`, `agents.keys.username_of`.
- Produces: `AgentWriter(name, spaces=frozenset({"general"}), user_id: Optional[int] = None)`; `documents.access.visible_space_slugs(db, user) -> frozenset[str]`.

- [ ] **Step 1: Write the failing test** `backend/tests/test_agents_documents.py`

```python
"""An agent user on the documents routes (spec 2026-10-12 section 3.5): reads and writes only in
spaces it can see, never an admin's powers, attributed to itself."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from agents_support import HTML, app_client, make_admin, make_agent, restricted_space  # noqa: E402,F401

DENIED = {"detail": "agent keys cannot use this endpoint"}


def _post(c, headers, **body):
    payload = {"title": "Note", "html": HTML, "category": "ART", "activate": False}
    payload.update(body)
    return c.post("/api/documents", json=payload, headers=headers)


def test_agent_creates_in_general_and_is_the_attributed_creator(app_client):
    c, db = app_client
    agent, h = make_agent(db, "pia")
    r = _post(c, h, author="Forrest Parker")
    assert r.status_code == 201, r.text
    doc = r.json()
    assert doc["co_author"] == "pia" and doc["created_by_user_id"] == agent.id
    assert doc["provenance"]["creator"] == {"kind": "agent", "id": "pia", "label": "pia", "verified": True}
    assert doc["provenance"]["requested_by"]["verified"] is False


def test_spaces_follow_group_membership(app_client):
    from groups.models import UserGroupMember
    c, db = app_client
    agent, h = make_agent(db)
    sp, g = restricted_space(db)
    r = _post(c, h, space="leadership", html=HTML + "<!--1-->")
    assert r.status_code == 400 and "not allowed for this agent" in r.text
    db.add(UserGroupMember(group_id=g.id, user_id=agent.id))
    db.commit()
    assert _post(c, h, space="leadership", html=HTML + "<!--2-->").status_code == 201
    slugs = {s["slug"] for s in c.get("/api/document-spaces", headers=h).json()}
    assert slugs == {"general", "leadership"}


def test_hidden_documents_are_404_to_read_and_to_revise(app_client):
    c, db = app_client
    _, admin = make_admin(db)
    restricted_space(db)
    secret = _post(c, admin, space="leadership").json()
    _, h = make_agent(db)
    assert c.get(f"/api/documents/{secret['id']}", headers=h).status_code == 404
    assert _post(c, h, code=secret["code"], html=HTML + "<!--r2-->").status_code == 404
    assert all(i["code"] != secret["code"] for i in c.get("/api/documents", headers=h).json()["items"])


def test_admin_powers_are_refused(app_client):
    c, db = app_client
    _, admin = make_admin(db)
    sp, _ = restricted_space(db)
    draft = _post(c, admin).json()
    _, h = make_agent(db)
    checks = [
        c.delete(f"/api/documents/{draft['id']}?code={draft['code']}&revision=1", headers=h),
        c.post("/api/document-categories", json={"name": "X", "code_prefix": "XX"}, headers=h),
        c.post("/api/document-spaces", json={"slug": "x", "name": "X"}, headers=h),
        c.get(f"/api/document-spaces/{sp.id}/grants", headers=h),
        c.put(f"/api/documents/{draft['id']}/content", json={"html": HTML + "<!--x-->"}, headers=h),
    ]
    for r in checks:
        assert (r.status_code, r.json()) == (403, DENIED), r.request.url
    move = c.patch(f"/api/documents/{draft['id']}", json={"space_id": sp.id}, headers=h)
    assert move.status_code == 403  # existing "only an admin login can move" check


def test_agent_comments_are_authored_by_the_agent(app_client):
    c, db = app_client
    _, h = make_agent(db)
    doc = _post(c, h).json()
    r = c.post(f"/api/documents/{doc['id']}/comments", json={"body": "looks right"}, headers=h)
    assert r.status_code == 201, r.text
    assert r.json()["author_agent"] == "pia" and r.json()["author_user_id"] is None
```

- [ ] **Step 2: Run it to verify it fails**

Run: `$PY -m pytest -q -p no:cacheprovider tests/test_agents_documents.py`
Expected: FAIL (writer routes call `get_current_user(token=...)` directly, so agents get 403 everywhere, and `visible_space_slugs` does not exist).

- [ ] **Step 3: Implement**

`backend/documents/access.py`, append:

```python
def visible_space_slugs(db: Session, user) -> frozenset:
    """Slugs of the spaces `user` can see: an agent user's write allow-list (spec 2026-10-12 3.5)."""
    return frozenset(db.execute(select(DocumentSpace.slug)
                                .where(DocumentSpace.id.in_(visible_space_ids(db, user)))).scalars())
```

`backend/documents/routes.py`:

1. Imports: change `from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status` to add `Request`; add `from agents.keys import is_agent_key, username_of`.
2. AgentWriter gains the agent user's id:

```python
@dataclass(frozen=True)
class AgentWriter:
    """A caller holding a documents-scoped agent token, or an agent USER's key (spec 2026-10-12
    3.5). Not a User: it has no email and is never an admin; it may author and archive but never
    delete. `spaces` is the slug allow-list it may publish into (env token: its configured list;
    agent user: the spaces it can see). `user_id` is set for agent users only."""
    name: str
    spaces: frozenset = frozenset({"general"})
    user_id: Optional[int] = None
```

3. Add below `agent_may_write`:

```python
def _agent_user_writer(db, token: str, request) -> AgentWriter:
    """An agent user's key on these routes is an AgentWriter, never its User row: until agent
    users existed every bearer reaching here was an admin, and the deny checks lean on that
    (require_document_admin_writer, the space-move check, updated_by, _reader_for)."""
    from agents.auth import agent_for_route
    user = agent_for_route(db, token, request)
    return AgentWriter(username_of(user), access.visible_space_slugs(db, user), user.id)
```

4. `require_document_writer` and `_space_reader` each take `request: Request` as their FIRST parameter and, right after the `if x_service_token is not None:` block, add:

```python
    if token and is_agent_key(token):
        return _agent_user_writer(db, token, request)
```

5. In `create_document`, replace `user_id=getattr(writer, "id", None),` with:

```python
            user_id=writer.user_id if isinstance(writer, AgentWriter) else getattr(writer, "id", None),
```

`backend/documents/comment_routes.py`: add `Request` to the fastapi import and `from agents.keys import is_agent_key, username_of`; give `require_comment_actor` a first parameter `request: Request`, and before `return actor_from_user(get_current_user(token=token, db=db))` add:

```python
    if token and is_agent_key(token):
        from agents.auth import agent_for_route
        from documents.access import visible_space_slugs
        user = agent_for_route(db, token, request)
        return actor_from_agent(username_of(user), visible_space_slugs(db, user))
```

(`require_document_admin_user` needs no change: its direct `get_current_user(token=...)` call has no request, so an agent is refused there by Task 3's fail-closed rule; `test_admin_powers_are_refused` pins it.)

- [ ] **Step 4: Run the tests**

Run: `$PY -m pytest -q -p no:cacheprovider tests/test_agents_documents.py tests/test_agents_auth.py`
Expected: all pass. Then the existing documents suites, which must be unchanged: `$PY -m pytest -q -p no:cacheprovider tests/test_documents*.py tests/test_flags_documents.py tests/test_customer_review*.py` all pass.

- [ ] **Step 5: Commit**

```bash
git add -- backend/documents/routes.py backend/documents/access.py backend/documents/comment_routes.py backend/tests/test_agents_documents.py
git commit -m "feat(agents): agent users write documents as AgentWriters within the spaces they can see" -- backend/documents/routes.py backend/documents/access.py backend/documents/comment_routes.py backend/tests/test_agents_documents.py
```

---

### Task 6: Agents are not people

**Files:**
- Modify: `backend/main.py` (`login`, `list_users`, `update_user`, `admin_reset_password`, `get_worksheets_users`), `backend/customer_review/names.py` (`staff_names`)
- Create: `backend/tests/test_agents_people.py`

**Interfaces:**
- Consumes: `make_agent`, `make_admin`.
- Produces: none new; behavior only.

- [ ] **Step 1: Write the failing test** `backend/tests/test_agents_people.py`

```python
"""Agents never appear or act as people (spec 2026-10-12 section 3.6)."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from agents_support import app_client, make_admin, make_agent  # noqa: E402,F401


def test_login_refuses_agents(app_client):
    c, db = app_client
    make_agent(db)
    r = c.post("/auth/login", json={"email": "pia@agent.invalid", "password": "anything"})
    assert (r.status_code, r.json()["detail"]) == (401, "Invalid credentials")


def test_people_lists_exclude_agents(app_client):
    c, db = app_client
    _, admin = make_admin(db)
    make_agent(db)
    assert all(u["role"] != "agent" for u in c.get("/auth/users", headers=admin).json())
    assert all(not u["email"].endswith("@agent.invalid")
               for u in c.get("/worksheets/users", headers=admin).json())


def test_user_admin_cannot_touch_agents(app_client):
    c, db = app_client
    _, admin = make_admin(db)
    agent, _ = make_agent(db)
    r = c.put(f"/auth/users/{agent.id}", json={"role": "admin"}, headers=admin)
    assert r.status_code == 400
    assert c.post(f"/auth/users/{agent.id}/reset-password", headers=admin).status_code == 400
    db.refresh(agent)
    assert agent.role == "agent"


def test_agent_names_are_not_scrubbed_from_ai_reviews(app_client):
    from customer_review.names import staff_names
    _, db = app_client
    make_admin(db)
    make_agent(db, "devon")
    names = staff_names(db, None)
    assert "Ada" in names and "Devon" not in names
```

- [ ] **Step 2: Run it to verify it fails**

Run: `$PY -m pytest -q -p no:cacheprovider tests/test_agents_people.py`
Expected: FAIL (login 500s on bcrypt or returns a token path; lists include the agent; PUT changes its role; "Devon" is scrubbed).

- [ ] **Step 3: Implement**

`backend/main.py`:

- `login`: replace `if not user or not verify_password(form_data.password, user.hashed_password):` with
  `if not user or user.role == "agent" or not verify_password(form_data.password, user.hashed_password):`
- `list_users`: `users = db.query(User).filter(User.role != "agent").order_by(User.created_at.desc()).all()`
- `update_user` and `admin_reset_password`: right after the `if not user: raise HTTPException(status_code=404, ...)` lines add

```python
    if user.role == "agent":
        raise HTTPException(status_code=400, detail="Agents are managed in Settings > Agents")
```

- `get_worksheets_users`: change `.where(User.is_active == True)  # noqa: E712` to
  `.where(User.is_active == True, User.role != "agent")  # noqa: E712`

`backend/customer_review/names.py` `staff_names`: change
`db.execute(select(User.first_name, User.last_name)).all()` to
`db.execute(select(User.first_name, User.last_name).where(User.role != "agent")).all()`

- [ ] **Step 4: Run the tests**

Run: `$PY -m pytest -q -p no:cacheprovider tests/test_agents_people.py tests/test_customer_review*.py`
Expected: all pass. Then `git diff --stat -- backend/main.py` shows only these few lines (main.py is huge; a whole-file diff means a line-ending accident: stop and fix).

- [ ] **Step 5: Commit**

```bash
git add -- backend/main.py backend/customer_review/names.py backend/tests/test_agents_people.py
git commit -m "feat(agents): agents never log in, list, get edited or scrubbed as people" -- backend/main.py backend/customer_review/names.py backend/tests/test_agents_people.py
```

---

### Task 7: The route matrix: a real key against every authenticated route

**Files:**
- Create: `backend/tests/test_agents_route_matrix.py`

**Interfaces:**
- Consumes: `agents.access`, `make_agent`, every auth dependency.

- [ ] **Step 1: Write the test**

```python
"""Every authenticated route refuses an agent key unless the allow-list names it (spec 2026-10-12
section 9). Sends a REAL key to each route; 403 is raised in the auth dependency, so no handler
runs. A route that rejects earlier for another reason (401/422 before auth) must be listed in
EARLY_REJECT with a reason; it is still never a success."""
import os
import re
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))
from agents_support import app_client, make_agent  # noqa: E402,F401

DENIED = {"detail": "agent keys cannot use this endpoint"}
EARLY_REJECT: dict[tuple[str, str], str] = {}


def _auth_deps():
    from auth import get_current_user, require_admin
    from documents import comment_routes, routes as doc_routes
    return {get_current_user, require_admin, doc_routes.require_document_writer,
            doc_routes.require_document_admin_writer, doc_routes.require_document_admin_user,
            doc_routes._space_reader, comment_routes.require_comment_actor}


def _uses_auth(dependant, deps) -> bool:
    return dependant.call in deps or any(_uses_auth(d, deps) for d in dependant.dependencies)


def _authed_routes():
    from fastapi.routing import APIRoute
    from main import app
    deps = _auth_deps()
    for r in app.routes:
        if isinstance(r, APIRoute) and _uses_auth(r.dependant, deps):
            for m in sorted(r.methods - {"HEAD", "OPTIONS"}):
                yield m, r.path


def _url(template: str) -> str:
    return re.sub(r"\{[^}]+\}", "1", template)


def _call(c, method, template, headers):
    kw = {"headers": headers}
    if method in ("POST", "PUT", "PATCH"):
        kw["json"] = {}
    return c.request(method, _url(template), **kw)


@pytest.mark.parametrize("lab,coa", [(True, True), (True, False), (False, False)])
def test_every_route_outside_the_scopes_refuses(app_client, lab, coa):
    from agents import access
    from types import SimpleNamespace
    c, db = app_client
    _, h = make_agent(db, f"m{int(lab)}{int(coa)}", lab_tools=lab, coa_publishing=coa)
    scopes = access.scopes_for(SimpleNamespace(lab_tools=lab, coa_publishing=coa))
    checked = 0
    for method, template in _authed_routes():
        if access.allowed(scopes, method, template):
            continue
        r = _call(c, method, template, h)
        if (method, template) in EARLY_REJECT:
            assert r.status_code in (401, 403, 422), (method, template, r.status_code)
        else:
            assert (r.status_code, r.json()) == (403, DENIED), (method, template, r.status_code, r.text[:200])
        checked += 1
    assert checked > 300  # the whole authenticated surface, not a handful
```

- [ ] **Step 2: Run it**

Run: `$PY -m pytest -q -p no:cacheprovider tests/test_agents_route_matrix.py`
Expected: PASS. If a route fails: (a) a 2xx means a hole: fix the code, never the test; (b) a 401/422 from a dependency that runs before auth: add it to `EARLY_REJECT` with a one-line reason; (c) a 403 with different text: find which dependency answered first and confirm it is a refusal.

- [ ] **Step 3: Commit**

```bash
git add -- backend/tests/test_agents_route_matrix.py
git commit -m "test(agents): a real agent key against every authenticated route" -- backend/tests/test_agents_route_matrix.py
```

---

### Task 8: Settings > Agents (frontend)

**Files:**
- Create: `src/lib/api-agents.ts`, `src/components/preferences/panes/AgentsPane.tsx`, `src/components/preferences/panes/__tests__/AgentsPane.test.tsx`
- Modify: `src/components/preferences/panes.tsx` (union, nav item after `integrations`, pane map, icon import `Bot`), `src/store/ui-store.ts` (add `'agents'` to the pane union), `locales/en.json` (`"preferences.agents": "Agents"` after `"preferences.integrations"`)

**Interfaces:**
- Consumes: HTTP from Task 4; `useGroups` from `@/services/groups`; `crmFetch`/`CrmError` from `@/lib/api-crm`.
- Produces: `listAgents`, `createAgent`, `updateAgent`, `rotateAgentKey`, `setAgentGroups`; `AgentsPane`.

- [ ] **Step 1: Write the failing test** `src/components/preferences/panes/__tests__/AgentsPane.test.tsx`

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/lib/api-agents'
import type { Agent } from '@/lib/api-agents'
import { AgentsPane } from '../AgentsPane'
import { visibleNavItems } from '../../panes'

const auth = vi.hoisted(() => ({ role: 'admin' }))
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { role: auth.role } }),
}))
vi.mock('@/services/groups', () => ({
  useGroups: () => ({ data: [{ id: 7, name: 'Leadership', is_active: true }] }),
}))
vi.mock('@/lib/api-agents', async () => {
  const actual = await vi.importActual<typeof api>('@/lib/api-agents')
  return { ...actual, listAgents: vi.fn(), createAgent: vi.fn(), updateAgent: vi.fn(),
           rotateAgentKey: vi.fn(), setAgentGroups: vi.fn() }
})

const pia: Agent = {
  id: 3, username: 'pia', display_name: 'Pia', is_active: true, lab_tools: false,
  coa_publishing: false, key_hint: 'abc123', created_at: '2026-10-12T10:00:00',
  created_by_name: 'Ada Admin', rotated_at: null, last_used_at: null, group_ids: [],
}
const KEY = 'mk1a.pia.' + 'x'.repeat(43)

function renderPane() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><AgentsPane /></QueryClientProvider>)
}

describe('AgentsPane', () => {
  beforeEach(() => {
    auth.role = 'admin'
    vi.mocked(api.listAgents).mockResolvedValue([pia])
  })

  it('lists agents with their switches and key hint, never a key', async () => {
    renderPane()
    expect(await screen.findByText('Pia')).toBeInTheDocument()
    expect(screen.getByText(/abc123/)).toBeInTheDocument()
    expect(screen.queryByText(/mk1a\./)).toBeNull()
  })

  it('shows a new key once, with the two MCP settings, and hides it on Done', async () => {
    vi.mocked(api.createAgent).mockResolvedValue({ agent: { ...pia, id: 4, username: 'devon', display_name: 'Devon' }, key: KEY.replace('pia', 'devon') })
    renderPane()
    await screen.findByText('Pia')
    await userEvent.type(screen.getByLabelText('Username'), 'devon')
    await userEvent.type(screen.getByLabelText('Display name'), 'Devon')
    await userEvent.click(screen.getByRole('button', { name: 'Create agent' }))
    const once = await screen.findByTestId('agent-key-once')
    expect(once.textContent).toContain('LABMGR_MK1_AGENT_NAME=devon')
    expect(once.textContent).toContain('LABMGR_MK1_AGENT_KEY=mk1a.devon.')
    await userEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByTestId('agent-key-once')).toBeNull()
    expect(screen.queryByText(/mk1a\./)).toBeNull()
  })

  it('keeps COA publishing off until Lab tools is on', async () => {
    renderPane()
    await screen.findByText('Pia')
    expect(screen.getByLabelText('COA publishing for Pia')).toBeDisabled()
  })

  it('rotates only after confirmation and shows the new key once', async () => {
    vi.mocked(api.rotateAgentKey).mockResolvedValue({ agent: pia, key: KEY })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    renderPane()
    await screen.findByText('Pia')
    await userEvent.click(screen.getByRole('button', { name: 'Rotate key for Pia' }))
    expect(api.rotateAgentKey).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Rotate key for Pia' }))
    await waitFor(() => expect(api.rotateAgentKey).toHaveBeenCalledWith(3))
    expect(await screen.findByTestId('agent-key-once')).toBeInTheDocument()
    confirm.mockRestore()
  })

  it('is admin-only, in the pane and in the nav', () => {
    auth.role = 'standard'
    renderPane()
    expect(screen.getByText('Only admins can manage agents.')).toBeInTheDocument()
    expect(visibleNavItems(false).some(i => i.id === 'agents')).toBe(false)
    expect(visibleNavItems(true).some(i => i.id === 'agents')).toBe(true)
  })
})
```

(`visibleNavItems(isAdmin: boolean)` is the real signature in `panes.tsx`; `IntegrationsPane.test.tsx` uses it the same way.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/components/preferences/panes/__tests__/AgentsPane.test.tsx`
Expected: FAIL (`Failed to resolve import "@/lib/api-agents"`).

- [ ] **Step 3: Implement**

`src/lib/api-agents.ts`:

```ts
/** Settings > Agents (spec 2026-10-12 section 4). Keys appear only in create and rotate responses. */
import { crmFetch } from '@/lib/api-crm'

export interface Agent {
  id: number
  username: string
  display_name: string
  is_active: boolean
  lab_tools: boolean
  coa_publishing: boolean
  key_hint: string
  created_at: string
  created_by_name: string | null
  rotated_at: string | null
  last_used_at: string | null
  group_ids: number[]
}

export interface AgentWithKey {
  agent: Agent
  key: string
}

export interface AgentCreate {
  username: string
  display_name: string
  lab_tools: boolean
  coa_publishing: boolean
}

export type AgentPatch = Partial<
  Pick<Agent, 'display_name' | 'is_active' | 'lab_tools' | 'coa_publishing'>
>

const none = () => new URLSearchParams()
const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

export const listAgents = () => crmFetch<Agent[]>('/admin/agents', none())
export const createAgent = (body: AgentCreate) =>
  crmFetch<AgentWithKey>('/admin/agents', none(), send('POST', body))
export const updateAgent = (id: number, patch: AgentPatch) =>
  crmFetch<Agent>(`/admin/agents/${id}`, none(), send('PATCH', patch))
export const rotateAgentKey = (id: number) =>
  crmFetch<AgentWithKey>(`/admin/agents/${id}/rotate-key`, none(), send('POST'))
export const setAgentGroups = (id: number, groupIds: number[]) =>
  crmFetch<Agent>(`/admin/agents/${id}/groups`, none(), send('PUT', { group_ids: groupIds }))
```

`src/components/preferences/panes/AgentsPane.tsx`:

```tsx
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useAuthStore } from '@/store/auth-store'
import { CrmError } from '@/lib/api-crm'
import { useGroups } from '@/services/groups'
import {
  createAgent,
  listAgents,
  rotateAgentKey,
  setAgentGroups,
  updateAgent,
  type Agent,
  type AgentPatch,
  type AgentWithKey,
} from '@/lib/api-agents'
import { SettingsSection } from '../shared/SettingsComponents'

const QK = ['agents']
const ERRORS: Record<string, string> = {
  invalid_username: 'Usernames are lowercase letters, digits, - and _ (40 at most).',
  name_taken: 'Another agent already uses that username.',
  coa_needs_lab: 'COA publishing needs Lab tools on.',
  invalid_display_name: 'Give the agent a display name.',
  unknown_group: 'One of those groups is gone or inactive.',
}
const errorText = (e: unknown) =>
  (e instanceof CrmError && e.code && ERRORS[e.code]) ||
  'Could not save. Nothing was changed.'

const when = (iso: string | null) =>
  iso ? new Date(`${iso}Z`).toLocaleString() : 'never'

/** The key, once. Closing it hides it for good: Mk1 keeps only a hash. */
function KeyOnce({ shown, onDone }: { shown: AgentWithKey; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  const env = `LABMGR_MK1_AGENT_NAME=${shown.agent.username}\nLABMGR_MK1_AGENT_KEY=${shown.key}`
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-amber-500 p-3"
      data-testid="agent-key-once"
    >
      <p className="text-sm font-medium">
        Key for {shown.agent.display_name}. Copy it now: it will not be shown again.
      </p>
      <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{env}</pre>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(env)
            setCopied(true)
          }}
        >
          <Copy className="mr-1 h-3 w-3" /> {copied ? 'Copied' : 'Copy settings'}
        </Button>
        <Button size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  )
}

function NewAgent({ onCreated }: { onCreated: (s: AgentWithKey) => void }) {
  const [username, setUsername] = useState('')
  const [display, setDisplay] = useState('')
  const [lab, setLab] = useState(false)
  const [coa, setCoa] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      onCreated(
        await createAgent({ username, display_name: display, lab_tools: lab, coa_publishing: lab && coa })
      )
      setUsername('')
      setDisplay('')
      setLab(false)
      setCoa(false)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="agent-username">Username</Label>
          <Input id="agent-username" value={username} onChange={e => setUsername(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="agent-display">Display name</Label>
          <Input id="agent-display" value={display} onChange={e => setDisplay(e.target.value)} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <Switch checked={lab} onCheckedChange={v => { setLab(v); if (!v) setCoa(false) }} aria-label="Lab tools" />
          Lab tools
        </label>
        <label className="flex items-center gap-2">
          <Switch checked={coa} disabled={!lab} onCheckedChange={setCoa} aria-label="COA publishing" />
          COA publishing
        </label>
      </div>
      {lab && coa && (
        <p className="text-xs text-amber-600">Can generate and publish COAs that customers receive.</p>
      )}
      <div>
        <Button size="sm" disabled={busy || !username.trim() || !display.trim()} onClick={() => void submit()}>
          Create agent
        </Button>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  )
}

function AgentRow({ agent, onKey }: { agent: Agent; onKey: (s: AgentWithKey) => void }) {
  const qc = useQueryClient()
  const groups = useGroups()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const put = (row: Agent) =>
    qc.setQueryData<Agent[]>(QK, old => old?.map(a => (a.id === row.id ? row : a)))
  const run = async (fn: () => Promise<Agent | AgentWithKey>) => {
    setBusy(true)
    setError(null)
    try {
      const out = await fn()
      if ('key' in out) {
        put(out.agent)
        onKey(out)
      } else put(out)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const patch = (p: AgentPatch) => void run(() => updateAgent(agent.id, p))
  const toggleGroup = (id: number, on: boolean) => {
    const next = on ? [...agent.group_ids, id] : agent.group_ids.filter(g => g !== id)
    void run(() => setAgentGroups(agent.id, next))
  }
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{agent.display_name}</span>
        <span className="font-mono text-xs text-muted-foreground">{agent.username}</span>
        {!agent.is_active && (
          <span className="rounded-md bg-muted px-2 py-0.5 text-xs">Inactive</span>
        )}
        <span className="text-xs text-muted-foreground">
          key {agent.key_hint}... · last used {when(agent.last_used_at)}
        </span>
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            aria-label={`Rotate key for ${agent.display_name}`}
            onClick={() => {
              if (window.confirm(`Rotate ${agent.display_name}'s key? The current key stops working now.`))
                void run(() => rotateAgentKey(agent.id))
            }}
          >
            Rotate key
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => patch({ is_active: !agent.is_active })}>
            {agent.is_active ? 'Deactivate' : 'Reactivate'}
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <Switch
            checked={agent.lab_tools}
            disabled={busy}
            onCheckedChange={v => patch({ lab_tools: v })}
            aria-label={`Lab tools for ${agent.display_name}`}
          />
          Lab tools
        </label>
        <label className="flex items-center gap-2">
          <Switch
            checked={agent.coa_publishing}
            disabled={busy || !agent.lab_tools}
            onCheckedChange={v => patch({ coa_publishing: v })}
            aria-label={`COA publishing for ${agent.display_name}`}
          />
          COA publishing
        </label>
      </div>
      {(groups.data ?? []).some(g => g.is_active) && (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="text-muted-foreground">Groups (restricted spaces):</span>
          {(groups.data ?? []).filter(g => g.is_active).map(g => (
            <label key={g.id} className="flex items-center gap-1">
              <Checkbox
                checked={agent.group_ids.includes(g.id)}
                disabled={busy}
                onCheckedChange={v => toggleGroup(g.id, v === true)}
                aria-label={`${g.name} for ${agent.display_name}`}
              />
              {g.name}
            </label>
          ))}
        </div>
      )}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  )
}

/** Settings > Agents: machine users with a key (spec 2026-10-12 section 5). Admins only. */
export function AgentsPane() {
  const isAdmin = useAuthStore(state => state.user?.role === 'admin')
  const qc = useQueryClient()
  const [shown, setShown] = useState<AgentWithKey | null>(null)
  const q = useQuery({ queryKey: QK, queryFn: listAgents, enabled: isAdmin, retry: false })
  if (!isAdmin)
    return <p className="text-sm text-muted-foreground">Only admins can manage agents.</p>
  return (
    <SettingsSection title="Agents">
      <p className="text-sm text-muted-foreground">
        Machine users for AI agents. Each has a username and a key; it can read and write
        documents in the spaces it can see, and only what its switches allow.
      </p>
      {shown && <KeyOnce shown={shown} onDone={() => setShown(null)} />}
      <NewAgent
        onCreated={s => {
          qc.setQueryData<Agent[]>(QK, old => [...(old ?? []), s.agent])
          setShown(s)
        }}
      />
      {q.isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      {q.isError && <p className="text-sm text-red-500">Could not load the agents.</p>}
      <div className="flex flex-col gap-3">
        {(q.data ?? []).map(a => (
          <AgentRow key={a.id} agent={a} onKey={setShown} />
        ))}
      </div>
    </SettingsSection>
  )
}
```

`src/components/preferences/panes.tsx`: add `| 'agents'` to the `PreferencePane` union; `import { Bot } from 'lucide-react'` with the other icons; add the nav item right after the `integrations` item:

```tsx
  { id: 'agents', labelKey: 'preferences.agents', icon: Bot, adminOnly: true },
```

import `AgentsPane` beside `IntegrationsPane` and add `agents: AgentsPane,` to the pane map. `src/store/ui-store.ts`: add `| 'agents'` to its pane union. `locales/en.json`: add `"preferences.agents": "Agents",` after `"preferences.integrations": "Integrations",`.

- [ ] **Step 4: Run tests and gates**

Run: `npx vitest run src/components/preferences` then `npx tsc --noEmit` then `npx eslint --max-warnings 0 src/lib/api-agents.ts src/components/preferences/panes/AgentsPane.tsx src/components/preferences/panes/__tests__/AgentsPane.test.tsx src/components/preferences/panes.tsx src/store/ui-store.ts` then `npx prettier --write` on those files and re-run vitest.
Expected: AgentsPane 5 passed; existing preferences tests unchanged; tsc and eslint clean.

- [ ] **Step 5: Commit**

```bash
git add -- src/lib/api-agents.ts src/components/preferences/panes/AgentsPane.tsx src/components/preferences/panes/__tests__/AgentsPane.test.tsx src/components/preferences/panes.tsx src/store/ui-store.ts locales/en.json
git ls-files --eol -- src/lib/api-agents.ts src/components/preferences/panes/AgentsPane.tsx
git commit -m "feat(agents): Settings > Agents (create, key once, switches, groups, rotate)" -- src/lib/api-agents.ts src/components/preferences/panes/AgentsPane.tsx src/components/preferences/panes/__tests__/AgentsPane.test.tsx src/components/preferences/panes.tsx src/store/ui-store.ts locales/en.json
```

---

### Task 9: labmanager-mcp agent-key mode (separate repo)

**Files** (repo `Zstar0/labmanager-mcp`, new worktree `C:/tmp/lmcp-agent-keys`, branch `feat/agent-keys` from `origin/release/documents-spaces-comments` @dd5f735, which is what the bot host runs):
- Modify: `src/labmanager_mcp/config.py`, `src/labmanager_mcp/mk1_client.py`, `src/labmanager_mcp/tools/documents.py` (`SOURCE_HELP` wording)
- Create: `tests/test_agent_mode.py`

Setup: `git -C /c/Users/forre/OneDrive/Documents/GitHub/labmanager-mcp fetch -q origin && git -C /c/Users/forre/OneDrive/Documents/GitHub/labmanager-mcp worktree add -b feat/agent-keys C:/tmp/lmcp-agent-keys origin/release/documents-spaces-comments`. Do NOT touch the main labmanager-mcp checkout (another session's uncommitted work). Tests: `cd C:/tmp/lmcp-agent-keys && PYTHONPATH="src;tests" /c/Users/forre/OneDrive/Documents/GitHub/labmanager-mcp/.venv/Scripts/python.exe -m pytest -q -p no:cacheprovider` (semicolon: Windows Python).

**Interfaces:**
- Consumes: Mk1 key wire format and exact texts (Global Constraints).
- Produces: env `LABMGR_MK1_AGENT_NAME` + `LABMGR_MK1_AGENT_KEY` (the full key Mk1 shows); `Config.agent_name`, `Config.agent_key`, `Config.agent_mode`.

- [ ] **Step 1: Write the failing test** `tests/test_agent_mode.py`

```python
import os
import re
from unittest.mock import patch

import httpx
import pytest

from labmanager_mcp.config import Config
from labmanager_mcp.mk1_client import Mk1Client

KEY = "mk1a.pia." + "s" * 43
BASE = {"LABMGR_MK1_BASE_URL": "https://mk1.test/api"}


def test_agent_mode_needs_no_email_or_password():
    with patch.dict(os.environ, {**BASE, "LABMGR_MK1_AGENT_NAME": "pia", "LABMGR_MK1_AGENT_KEY": KEY}, clear=True):
        cfg = Config.from_env()
    assert cfg.agent_mode and cfg.bot_email == "" and cfg.bot_password == ""


def test_agent_values_are_stripped():
    with patch.dict(os.environ, {**BASE, "LABMGR_MK1_AGENT_NAME": " pia\n", "LABMGR_MK1_AGENT_KEY": f" {KEY}\n"}, clear=True):
        cfg = Config.from_env()
    assert (cfg.agent_name, cfg.agent_key) == ("pia", KEY)


def test_key_for_another_agent_is_refused_without_echo():
    with patch.dict(os.environ, {**BASE, "LABMGR_MK1_AGENT_NAME": "devon", "LABMGR_MK1_AGENT_KEY": KEY}, clear=True):
        with pytest.raises(RuntimeError) as e:
            Config.from_env()
    assert "s" * 20 not in str(e.value)


def test_half_configured_agent_is_refused():
    with patch.dict(os.environ, {**BASE, "LABMGR_MK1_AGENT_NAME": "pia"}, clear=True):
        with pytest.raises(RuntimeError):
            Config.from_env()


def _client(handler):
    cfg = Config(mk1_base_url="https://mk1.test/api", bot_email="", bot_password="",
                 agent_name="pia", agent_key=KEY)
    c = Mk1Client(cfg)
    c._http = httpx.Client(base_url=cfg.mk1_base_url, transport=httpx.MockTransport(handler))
    return c


def test_reads_and_document_writes_send_the_agent_bearer_and_never_log_in():
    seen = []

    def handler(req):
        seen.append((req.url.path, req.headers.get("authorization"), req.headers.get("x-service-token")))
        return httpx.Response(200, json={"ok": True})

    c = _client(handler)
    c.get_json("/api/documents")
    c.post("/api/documents", json={}, service=True)
    assert all(a == f"Bearer {KEY}" and s is None for _, a, s in seen)
    assert not any(p.endswith("/auth/login") for p, _, _ in seen)


def test_a_route_this_agent_is_not_enabled_for_says_so():
    c = _client(lambda req: httpx.Response(403, json={"detail": "agent keys cannot use this endpoint"}))
    with pytest.raises(PermissionError) as e:
        c.get("/api/flags")
    assert "Lab tools" in str(e.value)


HERMES_PATTERNS = [r"ignore\s+(all\s+)?previous\s+instructions", r"you\s+are\s+now\s+a",
                   r"your\s+new\s+(task|role|instructions?)\s+(is|are)", r"system\s*:\s*",
                   r"<\s*(system|human|assistant)\s*>", r"do\s+not\s+(tell|inform|mention|reveal)",
                   r"(curl|wget|fetch)\s+https?://", r"base64\.(b64decode|decodebytes)",
                   r"exec\s*\(|eval\s*\(", r"import\s+(subprocess|os|shutil|socket)"]


def test_no_tool_description_trips_the_hermes_injection_scanner():
    import asyncio
    from labmanager_mcp.server import build_server
    from test_server import FakeClient
    s = build_server(FakeClient(), Config(mk1_base_url="https://mk1.test", bot_email="b@x.t", bot_password="pw"))
    for t in asyncio.run(s.list_tools()):
        for p in HERMES_PATTERNS:
            assert not re.search(p, t.description or "", re.I), (t.name, p)
```

- [ ] **Step 2: Run it to verify it fails**

Expected: FAIL (`Config` has no `agent_name`; `documents_create` description matches `system\s*:\s*`).

- [ ] **Step 3: Implement**

`config.py`: add fields after `service_token`:

```python
    # Agent-user mode (Mk1 1.47+): one key for reads and writes, no password login.
    # agent_key is the FULL key Mk1 showed once (mk1a.<name>.<secret>); agent_name must match it.
    agent_name: str = ""
    agent_key: str = ""

    @property
    def agent_mode(self) -> bool:
        return bool(self.agent_name and self.agent_key)
```

and replace `from_env` with:

```python
    @classmethod
    def from_env(cls) -> "Config":
        name = os.environ.get("LABMGR_MK1_AGENT_NAME", "").strip()
        key = os.environ.get("LABMGR_MK1_AGENT_KEY", "").strip()
        if bool(name) != bool(key):
            raise RuntimeError("Set both LABMGR_MK1_AGENT_NAME and LABMGR_MK1_AGENT_KEY, or neither")
        if key and not key.startswith(f"mk1a.{name}."):
            # Never echo the key: this is the wrong-connection check, not a debug aid.
            raise RuntimeError("LABMGR_MK1_AGENT_KEY is not a key for agent "
                               f"'{name}' (check you pasted this agent's key)")
        try:
            return cls(
                mk1_base_url=os.environ["LABMGR_MK1_BASE_URL"].rstrip("/"),
                bot_email="" if key else os.environ["LABMGR_MK1_EMAIL"],
                bot_password="" if key else os.environ["LABMGR_MK1_PASSWORD"],
                request_timeout=float(os.environ.get("LABMGR_REQUEST_TIMEOUT", "30")),
                max_image_edge=int(os.environ.get("LABMGR_MAX_IMAGE_EDGE", "1600")),
                mk1_web_url=os.environ.get("LABMGR_MK1_WEB_URL", ""),
                service_token=os.environ.get("LABMGR_MK1_SERVICE_TOKEN", ""),
                agent_name=name,
                agent_key=key,
            )
        except KeyError as e:
            raise RuntimeError(f"Missing required env var: {e}") from e
```

`mk1_client.py`: add near the top `AGENT_DENIED = "agent keys cannot use this endpoint"`; at the top of `_headers` add

```python
        if self._cfg.agent_mode:
            # One key for reads and writes; Mk1 decides what this agent may call.
            return {"Authorization": f"Bearer {self._cfg.agent_key}"}
```

and in `_request` change `if resp.status_code == 401 and not service:` to `if resp.status_code == 401 and not service and not self._cfg.agent_mode:` and, before the GET-retry block, add:

```python
            if self._cfg.agent_mode and resp.status_code == 403 and _detail(resp) == AGENT_DENIED:
                raise PermissionError(
                    "This agent is not enabled for that in Mk1. Ask a Mk1 admin to turn on "
                    "Lab tools (or COA publishing) for it in Settings > Agents.")
```

with a module-level helper:

```python
def _detail(resp: httpx.Response):
    try:
        return resp.json().get("detail")
    except (ValueError, AttributeError):
        return None
```

`tools/documents.py`: in `SOURCE_HELP` replace `"(system: paperclip, valence-hq, slack, claude-code or accumk1; e.g. record "` with `"(source_system is one of paperclip, valence-hq, slack, claude-code or accumk1; e.g. record "`.

- [ ] **Step 4: Run the whole MCP suite**

Expected: all previous tests (101 passed, 8 skipped at dd5f735) plus the 7 new ones pass.

- [ ] **Step 5: Commit** (this repo's working tree is CRLF with `core.autocrlf=true`; `git add` normalises to LF)

```bash
git -C C:/tmp/lmcp-agent-keys add -- src/labmanager_mcp/config.py src/labmanager_mcp/mk1_client.py src/labmanager_mcp/tools/documents.py tests/test_agent_mode.py
git -C C:/tmp/lmcp-agent-keys diff --cached --stat
git -C C:/tmp/lmcp-agent-keys commit -m "feat: agent-key mode (LABMGR_MK1_AGENT_NAME/KEY) for Mk1 agent users; no system: in tool text" -- src/labmanager_mcp/config.py src/labmanager_mcp/mk1_client.py src/labmanager_mcp/tools/documents.py tests/test_agent_mode.py
```

---

### Task 10: Prove it on Postgres and in a browser, changelog, PRs

**Files:**
- Create: `e2e/agents/agents-pane.mjs` (browser check, modelled on `e2e/paperclip-app/provenance-embed.mjs`), `docs/superpowers/e2e/2026-10-12-agent-users/` (screenshots + results.json, synthetic data only)
- Modify: `e2e/paperclip-app/mk1_fixture.py` (optional `MK1_FIXTURE_ADMIN_PASSWORD`: also create admin `admin@example.test`), `CHANGELOG.md` (Unreleased section)

- [ ] **Step 1: Postgres boot, fresh and upgraded.** Start a throwaway container on a free local port (55432, 8561 and 18081 are taken on this PC): `docker run -d --rm --name mk1-agents-pg -e POSTGRES_PASSWORD=<generated, kept in a scratchpad file, never printed> -p 127.0.0.1:56888:5432 postgres:16`; create `agents_upgrade` and `agents_fresh`. Upgrade path: from a detached `origin/master` worktree run `database.init_db()` against `agents_upgrade`, then this branch's `init_db()`; fresh path: this branch's `init_db()` against `agents_fresh`. Both must show table `agent_credentials` with the Task 1 columns and FKs (`user_id` CASCADE, `created_by_user_id` SET NULL), identical between the two. Then, on each, with a TestClient on the real app (only `get_db` real, no overrides): create an admin row, `POST /admin/agents` with its JWT, and with the returned key: `GET /api/documents` 200, `POST /api/documents` 201 with provenance creator `agent/<name>`, `DELETE /api/documents/{id}?...` 403, `GET /auth/me` 403. Stop the container, delete the password file and the base worktree.

- [ ] **Step 2: Browser pass.** `mk1_fixture.py`: when `MK1_FIXTURE_ADMIN_PASSWORD` is set, also add `models.User(email="admin@example.test", role="admin", is_active=True, first_name="Ada", last_name="Admin", hashed_password=get_password_hash(os.environ["MK1_FIXTURE_ADMIN_PASSWORD"]))`. Build with PowerShell (`$env:VITE_API_URL='/api'; npm run build`; Git Bash mangles `/api`). `e2e/agents/agents-pane.mjs` starts the fixture (venv Python via `MK1_PY`) and the same static+`/api` proxy as `provenance-embed.mjs` on 127.0.0.1:8571, signs in as the fixture admin with a generated password, opens Settings > Agents, creates `devon`, checks the one-time panel shows `LABMGR_MK1_AGENT_NAME=devon`, copies nothing out of the page, clicks Done (panel gone, no `mk1a.` text on the page), turns Lab tools on, checks COA becomes enabled, rotates (accepting the confirm), and screenshots the list. Assert with `fetch` from Node that the key from the create response authenticates `GET /api/documents` (200) and `GET /auth/me` is 403. Write `results.json` and two screenshots into `docs/superpowers/e2e/2026-10-12-agent-users/`.

- [ ] **Step 3: Full gates.** Backend: `$PY -m pytest -q -p no:cacheprovider tests/test_agents_*.py tests/test_documents*.py tests/test_flags_documents.py tests/test_customer_review*.py tests/test_groups*.py tests/test_boards*.py` (expect 0 failures); frontend: `npx tsc --noEmit`, `npx vitest run src/components/preferences src/components/documents src/lib`. Record the counts.

- [ ] **Step 4: CHANGELOG** (top of `CHANGELOG.md`, no em dashes):

```markdown
## Unreleased

### Agents get their own Mk1 accounts
- **Settings > Agents (admins):** create a machine user for an AI agent with a username; Mk1 shows its key once. No password, no server change, works on the next request.
- **Least privilege by default:** an agent can read and write documents in the spaces it can see (General plus its groups) and nothing else. **Lab tools** (lab reads, reports, flags) and **COA publishing** are separate switches per agent; COA publishing needs Lab tools.
- **Revoke instantly:** deactivate the agent or rotate its key; the old key stops on the next request. Everything an agent writes is attributed to it.
- Agents never appear in staff lists, cannot log in, and cannot be edited as people.
```

- [ ] **Step 5: Commit and open PRs (do not merge).**

```bash
git add -- e2e/agents/agents-pane.mjs e2e/paperclip-app/mk1_fixture.py docs/superpowers/e2e/2026-10-12-agent-users CHANGELOG.md
git commit -m "test(agents): Postgres boot + browser pass; changelog" -- e2e/agents/agents-pane.mjs e2e/paperclip-app/mk1_fixture.py docs/superpowers/e2e/2026-10-12-agent-users CHANGELOG.md
git push -u origin feat/agent-users
gh pr create -R Zstar0/Accu-Mk1 --base master --head feat/agent-users --title "feat: agent users (username + key), Settings > Agents" --body-file <scratchpad body with What / Verified / Known limits / Not done>
git -C C:/tmp/lmcp-agent-keys push -u origin feat/agent-keys
gh pr create -R Zstar0/labmanager-mcp --base release/documents-spaces-comments --head feat/agent-keys --title "feat: agent-key mode for Mk1 agent users" --body-file <scratchpad body>
```

The Verified block quotes the real test counts, the Postgres result, and links the screenshots. Merging, deploying (Mk1 first, then the MCP cutover) and the Paperclip per-agent setup are separate, Handler-approved steps.
