# User First/Last Name Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional first/last name to users, edit them on the profile page (and admin User Management), and show "First Last" (email fallback) in the Analyst column, worksheet analyst, activity-log @mentions, and the user list.

**Architecture:** Two nullable columns on `users` via the idempotent ALTER list. A single display rule mirrored backend (`user_display_name`) + FE (`displayName`/`resolveUserName`). Self-serve `PATCH /auth/me` (name-only body), a new `GET /auth/directory` for email→name resolution, and name fields threaded through the existing user-returning endpoints. Spec: `docs/superpowers/specs/2026-06-07-user-first-last-name-design.md`.

**Tech Stack:** FastAPI + SQLAlchemy (backend), React + TS + TanStack Query (FE), pytest + vitest in the docker containers.

**Environment:**
- Repo `C:/tmp/Accu-Mk1-subvial`, branch `subvial/continue` (push to PR #9 freely).
- Backend tests: `MSYS_NO_PATHCONV=1 docker exec -e SUBSAMPLE_NATIVE_CREATE=0 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest <path> -q --tb=short"`. If pytest missing: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend pip install pytest pytest-asyncio`.
- Backend full-suite baseline: **13 known failures** (filter `grep -vE 'checkin_times|sample_priorities|clickup_webhook_dispatch|completion_side_effects|test_e2e_peptide_request|test_list_sub_samples_with_children'`; clickup_task_retry trio bounces 13↔16) **plus 2 pre-existing `test_families_routes.py` failures** (documented in the analyst-from-worksheet work). No NEW failures.
- FE: `... node_modules/.bin/vitest run src/test/` (1 known peptide-requests-list flake); `... tsc --noEmit` (1 known error `WorksheetsInboxPage.tsx(356,38)`).
- New TestClient fixtures: snapshot/restore `app.dependency_overrides` (test_api_business_hours lesson).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Migration note: `users` lives in the MAIN Postgres; the ALTER goes in `backend/database.py:_run_migrations`. The migration runs at backend startup — after editing, the `--reload` uvicorn restart re-runs it; if columns don't appear, `docker restart accumark-subvial-accu-mk1-backend`.

---

### Task 1: Model columns + migration + `user_display_name` helper — TDD

**Files:**
- Create: `backend/users_display.py`
- Modify: `backend/models.py` (`class User`, ~line 30 — after `senaite_password_encrypted`)
- Modify: `backend/database.py` (`_run_migrations` list, ~line 133)
- Test: `backend/tests/test_user_display.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_user_display.py`:

```python
"""user_display_name: 'First Last' with single-name and email fallbacks."""
from types import SimpleNamespace

from users_display import user_display_name


def _u(first=None, last=None, email="x@lab.test"):
    return SimpleNamespace(first_name=first, last_name=last, email=email)


def test_both_names():
    assert user_display_name(_u("Ada", "Lovelace")) == "Ada Lovelace"


def test_first_only():
    assert user_display_name(_u(first="Ada")) == "Ada"


def test_last_only():
    assert user_display_name(_u(last="Lovelace")) == "Lovelace"


def test_neither_falls_back_to_email():
    assert user_display_name(_u(email="ada@lab.test")) == "ada@lab.test"


def test_whitespace_only_falls_back_to_email():
    assert user_display_name(_u(first="  ", last="\t", email="ada@lab.test")) == "ada@lab.test"


def test_strips_surrounding_whitespace():
    assert user_display_name(_u(first=" Ada ", last=" Lovelace ")) == "Ada Lovelace"


def test_none_user_returns_empty_string():
    assert user_display_name(None) == ""
```

- [ ] **Step 2: Run to verify it fails**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_user_display.py -q --tb=short"`
Expected: FAIL — `ModuleNotFoundError: users_display`.

- [ ] **Step 3: Create the helper**

Create `backend/users_display.py`:

```python
"""Shared display-name rule for users. Mirrored on the FE in
src/lib/user-display.ts — keep the two in sync.

Rule: "First Last" when both set; the single name when only one set;
the email when neither set (names are optional — email is the identity key).
"""
from typing import Optional


def user_display_name(user) -> str:
    """Return the user's display name, falling back to email.

    `user` is any object exposing first_name / last_name / email (the ORM
    User, or a SimpleNamespace in tests). Returns "" for None.
    """
    if user is None:
        return ""
    first = (getattr(user, "first_name", None) or "").strip()
    last = (getattr(user, "last_name", None) or "").strip()
    full = " ".join(p for p in (first, last) if p)
    return full or (getattr(user, "email", None) or "")
```

- [ ] **Step 4: Run to verify it passes**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_user_display.py -q --tb=short"`
Expected: 7 passed.

- [ ] **Step 5: Add the model columns**

In `backend/models.py`, in `class User`, immediately after the `senaite_password_encrypted` column (~line 30):

```python
    first_name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    last_name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
```

(`Optional`, `String`, `mapped_column`, `Mapped` are already imported — confirm at the file's import block.)

- [ ] **Step 6: Add the migration**

In `backend/database.py`, in the `migrations` list inside `_run_migrations` (right after the `senaite_password_encrypted` line, ~133):

```python
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name VARCHAR(100)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name VARCHAR(100)",
```

- [ ] **Step 7: Verify the migration applies live**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -c 'import database; database._run_migrations(); print(\"ok\")'"`
Then: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-postgres psql -U postgres -d accumark_mk1 -c "\d users"` — expect `first_name` and `last_name` columns present. (Idempotent — safe even if uvicorn reload already ran it.)

- [ ] **Step 8: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/users_display.py backend/models.py backend/database.py backend/tests/test_user_display.py
git commit -m "feat(be): user first/last name columns + display-name helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Endpoints carry names — schemas, `_user_to_read`, `PATCH /auth/me`, admin update, directory — TDD

**Files:**
- Modify: `backend/auth.py` (`UserRead` ~60, `UserUpdate` ~71; add `MeUpdate`)
- Modify: `backend/main.py` (`_user_to_read` ~10500; `update_user` ~535; add `PATCH /auth/me`; add `GET /auth/directory`; `GET /worksheets/users` ~13975)
- Test: `backend/tests/test_user_name_endpoints.py`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_user_name_endpoints.py`. Mirror the override+client pattern from `backend/tests/test_lims_analyses_routes.py` BUT this needs a REAL persisted user (the endpoints read/write the DB), so build one in the test DB and override `get_current_user` to return it. Snapshot/restore overrides.

```python
"""Endpoint coverage for user name fields: PATCH /auth/me, admin update,
directory, worksheets/users name passthrough."""
import pytest
from fastapi.testclient import TestClient

import auth
from main import app
from database import SessionLocal
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
def client_as(user):
    """TestClient authed as `user`, overrides restored after."""
    prev = app.dependency_overrides.get(auth.get_current_user)
    app.dependency_overrides[auth.get_current_user] = lambda: user
    yield TestClient(app)
    if prev is None:
        app.dependency_overrides.pop(auth.get_current_user, None)
    else:
        app.dependency_overrides[auth.get_current_user] = prev


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
```

- [ ] **Step 2: Run to verify it fails**

Run: `MSYS_NO_PATHCONV=1 docker exec -e SUBSAMPLE_NATIVE_CREATE=0 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_user_name_endpoints.py -q --tb=short"`
Expected: FAIL — `/auth/me` PATCH 405, `/auth/directory` 404, missing `first_name` keys.

- [ ] **Step 3: Schemas — `auth.py`**

`UserRead` (~60) gains the two fields (defaults None so existing constructions stay valid):

```python
class UserRead(BaseModel):
    id: int
    email: str
    role: str
    is_active: bool
    created_at: datetime
    senaite_configured: bool = False
    first_name: Optional[str] = None
    last_name: Optional[str] = None

    class Config:
        from_attributes = True
```

`UserUpdate` (~71) gains them (admin edit):

```python
class UserUpdate(BaseModel):
    email: Optional[str] = None
    role: Optional[str] = None
    is_active: Optional[bool] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
```

Add a new restricted body model (name-only, no privilege fields):

```python
class MeUpdate(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
```

(`Optional` already imported in auth.py.)

- [ ] **Step 4: `_user_to_read` — `main.py` ~10500**

```python
def _user_to_read(user) -> UserRead:
    """Convert User model to UserRead schema with senaite_configured."""
    return UserRead(
        id=user.id,
        email=user.email,
        role=user.role,
        is_active=user.is_active,
        created_at=user.created_at,
        senaite_configured=user.senaite_password_encrypted is not None,
        first_name=user.first_name,
        last_name=user.last_name,
    )
```

- [ ] **Step 5: `PATCH /auth/me` — add near `GET /auth/me` (~429) in main.py**

Import `MeUpdate` where `UserUpdate`/`UserRead` are imported from auth (check the existing `from auth import ...` line in main.py and add `MeUpdate`).

```python
@app.patch("/auth/me", response_model=UserRead)
async def update_me(
    data: MeUpdate,
    current_user=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Self-serve update of the caller's own name fields. Empty string clears
    to NULL. Cannot change role / active / email (not in MeUpdate)."""
    fields = data.model_dump(exclude_unset=True)
    if "first_name" in fields:
        v = (fields["first_name"] or "").strip()
        current_user.first_name = v or None
    if "last_name" in fields:
        v = (fields["last_name"] or "").strip()
        current_user.last_name = v or None
    db.commit()
    db.refresh(current_user)
    return _user_to_read(current_user)
```

- [ ] **Step 6: Admin `update_user` (~535) — accept names**

After the existing `if data.email is not None:` block and before `db.commit()`:

```python
    if data.first_name is not None:
        user.first_name = data.first_name.strip() or None
    if data.last_name is not None:
        user.last_name = data.last_name.strip() or None
```

- [ ] **Step 7: `GET /auth/directory` — add after `list_users` (~503) in main.py**

```python
@app.get("/auth/directory")
async def user_directory(
    _current_user=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Lightweight id/email/name list for ALL users (active + inactive) so the
    FE can resolve historical analyst emails to names. Auth-only, not admin."""
    rows = db.execute(
        select(User.id, User.email, User.first_name, User.last_name)
        .order_by(User.email)
    ).all()
    return [
        {"id": r.id, "email": r.email, "first_name": r.first_name, "last_name": r.last_name}
        for r in rows
    ]
```

(`select` is already imported in main.py.)

- [ ] **Step 8: `GET /worksheets/users` (~13975) — add name fields**

```python
@app.get("/worksheets/users")
async def get_worksheets_users(
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Return active users for analyst assignment. Accessible to all authenticated users (not admin-only)."""
    users = db.execute(
        select(User.id, User.email, User.first_name, User.last_name).where(User.is_active == True)  # noqa: E712
        .order_by(User.email)
    ).all()
    return [
        {"id": row.id, "email": row.email, "first_name": row.first_name, "last_name": row.last_name}
        for row in users
    ]
```

- [ ] **Step 9: Run the test file**

Run: `MSYS_NO_PATHCONV=1 docker exec -e SUBSAMPLE_NATIVE_CREATE=0 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_user_name_endpoints.py -q --tb=short"`
Expected: 6 passed. (If the backend needs the new columns and the live DB lacks them, run Task 1 Step 7's migration command first.)

- [ ] **Step 10: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/auth.py backend/main.py backend/tests/test_user_name_endpoints.py
git commit -m "feat(be): name fields on user endpoints + PATCH /auth/me + /auth/directory

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Serializer Analyst column shows the name — TDD

**Files:**
- Modify: `backend/lims_analyses/service.py` (`list_analyses_in_senaite_shape` analyst block ~961-1011)
- Test: `backend/tests/test_worksheet_analyst_stamp.py` (append)

- [ ] **Step 1: Append the failing test**

Add to `backend/tests/test_worksheet_analyst_stamp.py` (reuses its `_mk_*` helpers; `_mk_user` currently sets only email — extend the call inline):

```python
def test_senaite_shape_analyst_uses_display_name(db_session):
    """Analyst column shows 'First Last' when set, single name with one, email when none."""
    from lims_analyses.service import list_analyses_in_senaite_shape

    parent = _mk_parent(db_session)
    sub = _mk_sub(db_session, parent)
    g = _mk_group(db_session, "Analytics")
    a_full = _mk_analysis(db_session, sub, _mk_service(db_session, "K1", "T1", g))
    a_first = _mk_analysis(db_session, sub, _mk_service(db_session, "K2", "T2", g))
    a_none = _mk_analysis(db_session, sub, _mk_service(db_session, "K3", "T3", g))

    full = _mk_user(db_session, "full@lab.test")
    full.first_name = "Ada"; full.last_name = "Lovelace"
    first_only = _mk_user(db_session, "first@lab.test")
    first_only.first_name = "Grace"
    nameless = _mk_user(db_session, "nameless@lab.test")
    db_session.flush()

    a_full.analyst_user_id = full.id
    a_first.analyst_user_id = first_only.id
    a_none.analyst_user_id = nameless.id
    db_session.flush()

    by_kw = {s.keyword: s for s in list_analyses_in_senaite_shape(
        db_session, host_kind="sub_sample", host_pk=sub.id)}
    assert by_kw["K1"].analyst == "Ada Lovelace"
    assert by_kw["K2"].analyst == "Grace"
    assert by_kw["K3"].analyst == "nameless@lab.test"
```

- [ ] **Step 2: Run to verify it fails**

Run: `MSYS_NO_PATHCONV=1 docker exec -e SUBSAMPLE_NATIVE_CREATE=0 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_worksheet_analyst_stamp.py::test_senaite_shape_analyst_uses_display_name -q --tb=short"`
Expected: FAIL — `K1` analyst is `full@lab.test` (still email).

- [ ] **Step 3: Implement**

In `backend/lims_analyses/service.py`, replace the analyst bulk-load block (~961-970) so it stores a display name, not the email:

```python
    # Analyst display: "First Last" (email fallback). Mirrors the FE rule in
    # src/lib/user-display.ts; helper in backend/users_display.py.
    from models import User
    from users_display import user_display_name
    analyst_ids = {r.analyst_user_id for r in rows if r.analyst_user_id}
    analyst_name_by_id = {}
    if analyst_ids:
        analyst_name_by_id = {
            u.id: user_display_name(u)
            for u in db.execute(select(User).where(User.id.in_(analyst_ids))).scalars()
        }
```

And the `analyst=` line (~1011):

```python
            analyst=analyst_name_by_id.get(r.analyst_user_id),
```

(Single query preserved — still selects the full `User` rows, now passed through the helper.)

- [ ] **Step 4: Run the new test + the existing analyst tests (no regression)**

Run: `MSYS_NO_PATHCONV=1 docker exec -e SUBSAMPLE_NATIVE_CREATE=0 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_worksheet_analyst_stamp.py -q --tb=short"`
Expected: all pass. NOTE: the pre-existing `test_senaite_shape_surfaces_analyst_email` builds a user named `tech@lab.test` with NO first/last → `user_display_name` returns the email, so it still asserts `"tech@lab.test"`. Confirm it still passes; if it set a name, update its expectation. It does not — it should remain green.

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/lims_analyses/service.py backend/tests/test_worksheet_analyst_stamp.py
git commit -m "feat(be): Analyst column shows display name (First Last, email fallback)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: FE display helper + types + API fns — TDD on the helper

**Files:**
- Create: `src/lib/user-display.ts`
- Create: `src/test/user-display.test.ts`
- Modify: `src/store/auth-store.ts` (`AuthUser`); `src/lib/auth-api.ts` (add `updateMe`, `getUserDirectory`; `UserUpdateInput`); `src/lib/api.ts` (`WorksheetUser`)

- [ ] **Step 1: Write the failing helper test**

Create `src/test/user-display.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { displayName, resolveUserName } from '@/lib/user-display'

describe('displayName', () => {
  it('both names', () => {
    expect(displayName({ first_name: 'Ada', last_name: 'Lovelace', email: 'a@x' })).toBe('Ada Lovelace')
  })
  it('first only', () => {
    expect(displayName({ first_name: 'Ada', last_name: null, email: 'a@x' })).toBe('Ada')
  })
  it('last only', () => {
    expect(displayName({ first_name: null, last_name: 'Lovelace', email: 'a@x' })).toBe('Lovelace')
  })
  it('neither → email', () => {
    expect(displayName({ first_name: null, last_name: null, email: 'a@x' })).toBe('a@x')
  })
  it('whitespace-only → email', () => {
    expect(displayName({ first_name: '  ', last_name: '', email: 'a@x' })).toBe('a@x')
  })
})

describe('resolveUserName', () => {
  const dir = new Map([['a@x', 'Ada Lovelace']])
  it('resolves a known email to its name', () => {
    expect(resolveUserName('a@x', dir)).toBe('Ada Lovelace')
  })
  it('falls back to the short local-part for unknown emails', () => {
    expect(resolveUserName('grace@hopper.test', dir)).toBe('grace')
  })
  it('returns empty string for empty input', () => {
    expect(resolveUserName('', dir)).toBe('')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/vitest run src/test/user-display.test.ts"`
Expected: FAIL — cannot resolve `@/lib/user-display`.

- [ ] **Step 3: Create the helper**

Create `src/lib/user-display.ts`:

```typescript
/**
 * Display-name rule for users — mirrors backend/users_display.py.
 * "First Last" when both set; the single name when one set; email otherwise.
 */
export interface NameUser {
  first_name?: string | null
  last_name?: string | null
  email: string
}

export function displayName(u: NameUser): string {
  const first = (u.first_name ?? '').trim()
  const last = (u.last_name ?? '').trim()
  const full = [first, last].filter(Boolean).join(' ')
  return full || u.email
}

/** Local-part of an email (before '@'), for fallback when no name is known. */
export function shortEmail(email: string): string {
  if (!email) return ''
  const at = email.indexOf('@')
  return at > 0 ? email.slice(0, at) : email
}

/**
 * Resolve an email to a display name via a directory map (email → display name).
 * Falls back to the email's local-part when the email isn't in the directory
 * (deleted accounts, legacy events).
 */
export function resolveUserName(email: string, directory: Map<string, string>): string {
  if (!email) return ''
  return directory.get(email) ?? shortEmail(email)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/vitest run src/test/user-display.test.ts"`
Expected: 8 passed.

- [ ] **Step 5: Thread name fields into FE types**

`src/store/auth-store.ts` — `AuthUser`:

```typescript
export interface AuthUser {
  id: number
  email: string
  role: string
  is_active: boolean
  created_at: string
  senaite_configured: boolean
  first_name?: string | null
  last_name?: string | null
}
```

`src/lib/api.ts` — `WorksheetUser` (~4394):

```typescript
export interface WorksheetUser {
  id: number
  email: string
  first_name?: string | null
  last_name?: string | null
}
```

`src/lib/auth-api.ts` — add `updateMe` and `getUserDirectory`, and extend the admin `UserUpdateInput` type (find its definition near `updateUser`; add the two optional fields). Place these alongside the existing fns:

```typescript
export async function updateMe(
  data: { first_name?: string | null; last_name?: string | null }
): Promise<AuthUser> {
  const response = await fetch(`${API_BASE_URL()}/auth/me`, {
    method: 'PATCH',
    headers: getAuthHeaders(),
    body: JSON.stringify(data),
  })
  if (!response.ok) {
    await handleAuthError(response)
  }
  const user: AuthUser = await response.json()
  useAuthStore.getState().updateUser(user)
  return user
}

export interface DirectoryUser {
  id: number
  email: string
  first_name?: string | null
  last_name?: string | null
}

export async function getUserDirectory(): Promise<DirectoryUser[]> {
  const response = await fetch(`${API_BASE_URL()}/auth/directory`, {
    headers: getAuthHeaders(),
  })
  if (!response.ok) {
    await handleAuthError(response)
  }
  return response.json()
}
```

For `UserUpdateInput` (the admin update body type used by `updateUser`), add:

```typescript
  first_name?: string | null
  last_name?: string | null
```

- [ ] **Step 6: Typecheck**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit"`
Expected: only the known `WorksheetsInboxPage.tsx(356,38)` error.

- [ ] **Step 7: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add src/lib/user-display.ts src/test/user-display.test.ts src/store/auth-store.ts src/lib/auth-api.ts src/lib/api.ts
git commit -m "feat(fe): user display-name helper + name fields on types + updateMe/directory api

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: ProfilePage first/last name editor

**Files:**
- Modify: `src/components/auth/ProfilePage.tsx`

- [ ] **Step 1: Add the name form**

At the top of `ProfilePage`, after `const user = useAuthStore(state => state.user)`, add state seeded from the user and a save handler:

```typescript
  const [firstName, setFirstName] = useState(user?.first_name ?? '')
  const [lastName, setLastName] = useState(user?.last_name ?? '')
  const [savingName, setSavingName] = useState(false)

  const handleSaveName = async (e: FormEvent) => {
    e.preventDefault()
    setSavingName(true)
    try {
      await updateMe({ first_name: firstName, last_name: lastName })
      toast.success('Name updated')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update name')
    } finally {
      setSavingName(false)
    }
  }
```

Add `updateMe` to the `@/lib/auth-api` import line.

- [ ] **Step 2: Render the name card**

As the FIRST card in the page body (above the password card), following the existing Card/Label/Input/Button idiom in this file:

```tsx
      <Card>
        <CardHeader>
          <CardTitle>Name</CardTitle>
          <CardDescription>Shown as the analyst on samples and worksheets.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSaveName} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="first-name">First name</Label>
              <Input id="first-name" value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="Ada" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="last-name">Last name</Label>
              <Input id="last-name" value={lastName} onChange={e => setLastName(e.target.value)} placeholder="Lovelace" />
            </div>
            <Button type="submit" disabled={savingName} className="w-fit gap-2">
              {savingName ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Save name
            </Button>
          </form>
        </CardContent>
      </Card>
```

- [ ] **Step 3: Typecheck + FE suite**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit"` → only the known error.
Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/vitest run src/test/"` → only the known flake.

- [ ] **Step 4: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add src/components/auth/ProfilePage.tsx
git commit -m "feat(fe): first/last name editor on profile page

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Display names in worksheet analyst, User Management, and activity log

**Files:**
- Modify: `src/components/hplc/WorksheetDrawerHeader.tsx`; `src/components/hplc/WorksheetDrawer.tsx` (users prop type only if needed)
- Modify: `src/components/auth/UserManagement.tsx`
- Modify: `src/components/senaite/SampleActivityLog.tsx`

- [ ] **Step 1: Worksheet analyst — header + dropdown show names**

In `src/components/hplc/WorksheetDrawerHeader.tsx`: widen the `users` prop type and use `displayName`. Import: `import { displayName } from '@/lib/user-display'`.

Prop type (~14):

```typescript
  users: { id: number; email: string; first_name?: string | null; last_name?: string | null }[]
```

The completed-state analyst line (~149) — resolve the assigned analyst to a name via the users list (the worksheet response carries `assigned_analyst_email`; map it):

```tsx
        <p className="text-sm text-muted-foreground">
          {(() => {
            const a = users.find(u => u.id === worksheet.assigned_analyst)
            return a ? displayName(a) : (worksheet.assigned_analyst_email ?? 'No tech assigned')
          })()}
        </p>
```

The dropdown `SelectItem` label (~164):

```tsx
              <SelectItem key={user.id} value={String(user.id)}>
                {displayName(user)}
              </SelectItem>
```

(`getWorksheetUsers` now returns the name fields from Task 2; `WorksheetUser` type already widened in Task 4. If `WorksheetDrawer.tsx` declares an intermediate users type, widen it to match — otherwise no change there.)

- [ ] **Step 2: User Management — list + edit show/set names**

In `src/components/auth/UserManagement.tsx`, import `displayName`. The list row (~216) shows the name with email beneath:

```tsx
                  <TableCell className="font-medium">
                    {displayName(user)}
                    <span className="block text-xs text-muted-foreground">{user.email}</span>
                    {user.id === currentUser?.id && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        (you)
                      </span>
                    )}
                  </TableCell>
```

(Admin first/last EDIT inputs in the create/edit form are optional polish — the self-serve profile page is the primary editor and `PUT /auth/users/{id}` already accepts the fields. Add First/Last `Input`s to the form mirroring the Email field ONLY if straightforward; otherwise leave for a follow-up and note it. Do not block on it.)

- [ ] **Step 3: Activity log @mentions — resolve via directory**

In `src/components/senaite/SampleActivityLog.tsx`:

Import the directory hook source and helper:

```typescript
import { useQuery } from '@tanstack/react-query'
import { getUserDirectory } from '@/lib/auth-api'
import { resolveUserName } from '@/lib/user-display'
```

Build the directory map once in the component that renders the events (near the top of the activity-rendering component — find where the events list is mapped). Add:

```typescript
  const { data: directoryRows } = useQuery({
    queryKey: ['user-directory'],
    queryFn: getUserDirectory,
    staleTime: 5 * 60 * 1000,
  })
  const directory = useMemo(() => {
    const m = new Map<string, string>()
    for (const u of directoryRows ?? []) {
      m.set(u.email, displayName(u))
    }
    return m
  }, [directoryRows])
```

(Add `displayName` to the user-display import, and `useMemo` to the React import.)

Thread `directory` into `UserTag` — change its signature and the resolution:

```typescript
function UserTag({ email, directory }: { email: string; directory: Map<string, string> }) {
  return (
    <span className="text-violet-400/80" title={email}>
      @{resolveUserName(email, directory)}
    </span>
  )
}
```

Update the three call sites to pass `directory`:

```typescript
      if (d.processed_by) parts.push(<UserTag key="u" email={d.processed_by as string} directory={directory} />)
```
```typescript
      if (d.by) parts.push(<UserTag key="u" email={d.by as string} directory={directory} />)
```
```typescript
      if (d.analyst) parts.push(<span key="a">analyst=<UserTag email={d.analyst as string} directory={directory} /></span>)
      else if (d.created_by) parts.push(<span key="c">by <UserTag email={d.created_by as string} directory={directory} /></span>)
```

NOTE: the detail renderer is likely a standalone function, not a component, so `directory` must be passed INTO it from the rendering component. Trace how the `parts` builder is invoked (it takes the event `d`); thread `directory` as an added parameter through that function signature. If that function is called in several places, add `directory` to each call.

- [ ] **Step 4: Typecheck + FE suite**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit"` → only the known error.
Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/vitest run src/test/"` → only the known flake. (If a SampleActivityLog test exists and breaks on the new `directory` prop / query, wrap its render in a QueryClientProvider or pass an empty `directory` — fix the test to the new signature, don't weaken it.)

- [ ] **Step 5: Commit and push**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add src/components/hplc/WorksheetDrawerHeader.tsx src/components/auth/UserManagement.tsx src/components/senaite/SampleActivityLog.tsx
git commit -m "feat(fe): display names in worksheet analyst, user management, activity log

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push
```

(If `WorksheetDrawer.tsx` needed a type widen, include it in the `git add`.)

---

### Task 7: Live UAT on the subvial stack (user-driven)

No code. Backend hot-reloads (confirm the migration ran: `\d users` shows the columns; if not, `docker restart accumark-subvial-accu-mk1-backend`).

1. **Profile** (`http://localhost:5532/#account/profile`): set First = Forrest, Last = <surname> → Save → toast; reload, values persist.
2. **Analyst column**: on a vial already assigned to Forrest via a worksheet (e.g. P-0142-S02's HPLC analyses), the Analyst column now reads "Forrest <surname>" instead of the email. A vial assigned to a nameless user still shows that user's email.
3. **Worksheet analyst** (right-hand bar): the assign dropdown and the header show "Forrest <surname>"; users without names show their email.
4. **Activity log**: the "Added to worksheet — analyst …" / `by @…` mentions render the name (or short-email for users not in the directory).
5. **User Management** (admin): list shows names over emails; (if the edit inputs were added) set a name on another user and confirm it propagates to the Analyst column for their work.
6. Confirm a brand-new user with no name set never shows blank anywhere — always email/short-email fallback.
