# Planning Boards Slice 1: Groups + Boards Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `user_groups` subsystem, the `board_*` tables and API, the `board_node` flag entity with its new registry seams, and the admin Groups settings pane, with restricted boards locked off until slice 2.

**Architecture:** Two new backend modules in the repo's `<pkg>/{models,schemas,service,routes}.py` shape: `groups/` (tables, membership helper, admin CRUD) and `boards/` (boards, grants, nodes, edges, one `access.py` that answers every visibility question). The flag registry gains four optional seams (`can_raise`, `can_view`, `visible_entity_ids`, `search_scoped`) plus two pure helpers (`can_view_entity`, `visibility_clause`) that slice 2 wires into the read paths; this slice only makes `create_flag` honor `can_raise` and lets `/entity-search` pass the user. Frontend work is one settings pane.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 (`Mapped`/`mapped_column`) + Pydantic v2; pytest with in-memory SQLite and `app.dependency_overrides`; React 19 + TanStack Query + shadcn + react-i18next; vitest + testing-library.

**Spec:** `docs/superpowers/specs/2026-09-26-planning-boards-design.md` (§4 data model, §5 access, §6.1 and §6.2 registry, §7 API, §8.8 Groups pane, §11 slice 1). Read it first; every task below cites the section it implements.

## Global Constraints

- Work only in the worktree `C:/tmp/Accu-Mk1-boards` on branch `feat/planning-boards` (cut from `origin/master` `bdc11fed`). Never touch the main checkout, which sits on an unrelated branch.
- Backend tests: `PY=/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe` (the venv lives in the main checkout; use it from the worktree). Run from `C:/tmp/Accu-Mk1-boards/backend`: `"$PY" -m pytest tests/<file>.py -q -p no:cacheprovider`. One pytest process at a time; two concurrent suites deadlock on the host dev Postgres.
- Frontend: `cd C:/tmp/Accu-Mk1-boards && npx vitest run <path>`; final gate `npm run check:all`.
- Table names: `user_groups`, `user_group_members`, `board_boards`, `board_grants`, `board_nodes`, `board_edges`. Never the `lims_` prefix.
- JSON columns: `JSONB().with_variant(JSON(), "sqlite")` (import `from sqlalchemy.dialects.postgresql import JSONB` and `from sqlalchemy import JSON`).
- User references are plain `Integer` columns, no FK (flags convention).
- Invisible board or flag = 404, never 403. Visible but not editable = 403.
- `RESTRICTED_BOARDS_ENABLED = False` in `backend/boards/service.py` for this slice; `POST /api/boards` with `visibility="restricted"` returns 400 while it is False.
- Slugs (groups and boards): regex `^[a-z0-9][a-z0-9-]{1,59}$`, immutable after create.
- No em dashes anywhere (code comments, docs, UI strings, commit messages).
- Every commit is a pathspec commit (`git commit -m "..." -- <paths>`), message ends with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never push; the Handler pushes.
- All files touched here are LF today; keep them LF.
- Additive only: existing routes, responses and tests keep passing unchanged. The one behavior change allowed is `create_flag` consulting `can_raise` when a type defines it.

## Review Focus

Inputs the spec implies but no task's tests would otherwise exercise, most likely to bite first. Each has a pinned test in the owning task:

1. A user removed from every group who still holds a JWT must lose restricted-board access on the next request, not the next login (Task 4: `test_visibility_reads_membership_live`).
2. A `positions` bulk PATCH mixing one stale version with fresh ones must change nothing (Task 6: `test_positions_bulk_is_all_or_nothing`).
3. Deleting a frame must not orphan its children off-canvas: they keep absolute coordinates (Task 6: `test_delete_frame_reparents_children_with_absolute_coords`).
4. A `link` node with `javascript:` or `data:` URL must be rejected at create AND at patch (Task 6: `test_link_url_scheme_rejected_on_create_and_patch`).
5. A board node of kind `entity` must refuse `board_node` flags with a 400 that names the real anchor, so a thread never forks between the board and the library (Task 7b: `test_entity_node_redirects_flags_to_underlying_entity`).

## File structure

Create:

- `backend/groups/__init__.py`, `models.py` (UserGroup, UserGroupMember), `errors.py` (NotFoundError, BadRequestError, ConflictError, PermissionDeniedError), `access.py` (`user_group_ids`, `is_admin`), `schemas.py`, `service.py`, `routes.py` (`/api/groups`).
- `backend/boards/__init__.py`, `models.py` (Board, BoardGrant, BoardNode, BoardEdge), `access.py` (`can_view_board`, `can_edit_board`, `visible_board_ids`, `require_view`, `require_edit`), `schemas.py`, `service.py` (boards, grants, nodes, edges, `RESTRICTED_BOARDS_ENABLED`), `routes.py` (`/api/boards`), `flag_entity.py` (`register_board_node()`).
- `backend/tests/test_groups_models.py`, `test_groups_routes.py`, `test_boards_models.py`, `test_boards_access.py`, `test_boards_routes.py`, `test_boards_nodes.py`, `test_flags_seams_visibility_hooks.py`, `test_flags_board_node.py`.
- `src/lib/api-groups.ts`, `src/services/groups.ts`, `src/components/preferences/panes/GroupsPane.tsx`, `src/components/preferences/panes/__tests__/GroupsPane.test.tsx`.

Modify:

- `backend/database.py` `init_db()` (two import lines).
- `backend/main.py` (two router imports, two `include_router`).
- `backend/flags/seams.py` (`EntitySpec` fields, `register_entity` kwargs, `resolve_entity_search(user=)`, `can_view_entity`, `visibility_clause`, `register_mk1_entities` tail calls `boards.flag_entity.register_board_node()`).
- `backend/flags/service.py` `create_flag` (can_raise branch).
- `backend/flags/schemas.py` `EntityContext` (+ `board_slug`, `node_kind`).
- `backend/flags/routes.py` `entity_search` (pass `user`).
- `src/components/preferences/panes.tsx`, `locales/en.json`, `locales/ar.json`, `locales/fr.json`.
- `docs/developer/flags-add-entity.md`, `CHANGELOG.md`, the spec (§14 amendments).

---

### Task 0: Baseline

**Files:** none changed. The spec §14 amendments and this plan were committed together when the plan was written.

- [ ] **Step 1: Capture the backend failure-set baseline**

Run from `C:/tmp/Accu-Mk1-boards/backend`:

```bash
"$PY" -m pytest tests -q -p no:cacheprovider 2>&1 | grep -E "^(FAILED|ERROR) " | sort > /c/tmp/Accu-Mk1-boards-baseline-failures.txt; wc -l /c/tmp/Accu-Mk1-boards-baseline-failures.txt
```

Expected: a non-empty list (master carries known failures, see memory `architecture_mk1_test_baseline_failures`). Keep the file; Task 9 diffs against it. If the run exceeds 15 minutes, stop it and record instead the failure set of `tests/test_flags_*.py tests/test_documents_*.py` only, and say so in the final report.

---

### Task 1: Groups models, errors, access helper

**Files:**
- Create: `backend/groups/__init__.py`, `backend/groups/models.py`, `backend/groups/errors.py`, `backend/groups/access.py`
- Modify: `backend/database.py:119-121` (add `import groups.models` after the documents import)
- Test: `backend/tests/test_groups_models.py`

**Interfaces:**
- Produces: `groups.models.UserGroup(id, slug, name, description, is_active, created_at)`, `groups.models.UserGroupMember(id, group_id, user_id)`; `groups.access.user_group_ids(db, user) -> frozenset[int]`; `groups.access.is_admin(user) -> bool`; `groups.errors.{NotFoundError, BadRequestError, ConflictError, PermissionDeniedError}`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_groups_models.py`:

```python
"""User groups: tables, constraints, membership helper (spec §4.1, §4.2)."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker


def _session():
    from database import Base
    import models  # noqa: F401
    import groups.models  # noqa: F401
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def test_tables_created():
    s = _session()
    names = set(inspect(s.get_bind()).get_table_names())
    assert {"user_groups", "user_group_members"} <= names


def test_member_pair_is_unique():
    from sqlalchemy.exc import IntegrityError
    from groups.models import UserGroup, UserGroupMember
    s = _session()
    g = UserGroup(slug="exec", name="Exec")
    s.add(g)
    s.flush()
    s.add(UserGroupMember(group_id=g.id, user_id=7))
    s.commit()
    s.add(UserGroupMember(group_id=g.id, user_id=7))
    with pytest.raises(IntegrityError):
        s.commit()


def test_slug_is_unique():
    from sqlalchemy.exc import IntegrityError
    from groups.models import UserGroup
    s = _session()
    s.add(UserGroup(slug="exec", name="Exec"))
    s.commit()
    s.add(UserGroup(slug="exec", name="Exec again"))
    with pytest.raises(IntegrityError):
        s.commit()


def test_user_group_ids_reads_membership():
    from groups.access import user_group_ids
    from groups.models import UserGroup, UserGroupMember
    s = _session()
    a = UserGroup(slug="a", name="A")
    b = UserGroup(slug="b", name="B")
    s.add_all([a, b])
    s.flush()
    s.add_all([UserGroupMember(group_id=a.id, user_id=7),
               UserGroupMember(group_id=b.id, user_id=7),
               UserGroupMember(group_id=a.id, user_id=8)])
    s.commit()
    assert user_group_ids(s, SimpleNamespace(id=7)) == frozenset({a.id, b.id})
    assert user_group_ids(s, SimpleNamespace(id=8)) == frozenset({a.id})
    assert user_group_ids(s, SimpleNamespace(id=9)) == frozenset()
    assert user_group_ids(s, None) == frozenset()


def test_is_admin_reads_role():
    from groups.access import is_admin
    assert is_admin(SimpleNamespace(role="admin")) is True
    assert is_admin(SimpleNamespace(role="standard")) is False
    assert is_admin(None) is False
```

- [ ] **Step 2: Run to verify failure**

```bash
"$PY" -m pytest tests/test_groups_models.py -q -p no:cacheprovider
```

Expected: `ModuleNotFoundError: No module named 'groups'`.

- [ ] **Step 3: Create the module**

`backend/groups/__init__.py`: empty file.

`backend/groups/errors.py`:

```python
"""Typed service exceptions for groups and boards; routes map them to HTTP codes."""


class NotFoundError(LookupError):
    """Group, board, node or edge not found (also used when the caller may not see it)."""


class BadRequestError(ValueError):
    """Structurally OK but semantically invalid input."""


class ConflictError(Exception):
    """Duplicate, referenced row, or stale version."""


class PermissionDeniedError(Exception):
    """Visible but not editable / not admin."""
```

`backend/groups/models.py`:

```python
"""User groups (spec 2026-09-26 §4.1, §4.2). Groups are the unit of access for boards
and, through board nodes, for flags. No lims_ prefix: not sample-hierarchy entities."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import (Boolean, DateTime, ForeignKey, Index, Integer, String, Text,
                        UniqueConstraint)
from sqlalchemy.orm import Mapped, mapped_column

from database import Base


class UserGroup(Base):
    """`slug` is the stable wire key and is immutable (service enforces)."""
    __tablename__ = "user_groups"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    slug: Mapped[str] = mapped_column(String(60), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True,
                                            server_default="true")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow,
                                                 nullable=False)

    def __repr__(self) -> str:
        return f"<UserGroup(id={self.id}, slug='{self.slug}')>"


class UserGroupMember(Base):
    """One row per (group, user). user_id is a plain integer (flags convention)."""
    __tablename__ = "user_group_members"
    __table_args__ = (
        UniqueConstraint("group_id", "user_id", name="uq_user_group_members_pair"),
        Index("ix_user_group_members_user_id", "user_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    group_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("user_groups.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[int] = mapped_column(Integer, nullable=False)
```

`backend/groups/access.py`:

```python
"""The one place that answers "which groups is this user in" and "is this an admin".
Admins are implicitly members of every group for visibility purposes (spec §3)."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from groups.models import UserGroupMember


def is_admin(user) -> bool:
    return getattr(user, "role", None) == "admin"


def user_group_ids(db: Session, user) -> frozenset[int]:
    uid = getattr(user, "id", None)
    if uid is None:
        return frozenset()
    rows = db.execute(select(UserGroupMember.group_id)
                      .where(UserGroupMember.user_id == uid)).scalars().all()
    return frozenset(int(g) for g in rows)
```

`backend/database.py`, inside `init_db()` right after `import documents.models  # noqa: F401  (...)`:

```python
    import groups.models  # noqa: F401  (register user_groups tables on Base)
```

- [ ] **Step 4: Run to verify pass**

```bash
"$PY" -m pytest tests/test_groups_models.py -q -p no:cacheprovider
```

Expected: `5 passed`.

- [ ] **Step 5: Commit**

```bash
cd /c/tmp/Accu-Mk1-boards
git add backend/groups/__init__.py backend/groups/models.py backend/groups/errors.py backend/groups/access.py backend/database.py backend/tests/test_groups_models.py
git commit -m "feat(groups): user_groups tables + membership helper

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/groups backend/database.py backend/tests/test_groups_models.py
```

---

### Task 2: Groups service, schemas, routes

**Files:**
- Create: `backend/groups/schemas.py`, `backend/groups/service.py`, `backend/groups/routes.py`
- Modify: `backend/main.py:127` (import after `documents_router`), `backend/main.py:622` (include after `documents_router`)
- Test: `backend/tests/test_groups_routes.py`

**Interfaces:**
- Consumes: Task 1 models, `groups.access`, `groups.errors`; `auth.get_current_user`, `auth.require_admin`, `database.get_db`; `models.User`.
- Produces: `groups.service.{list_groups, get_group, create_group, update_group, delete_group, list_members, replace_members, my_groups}`; wire models `GroupOut{id, slug, name, description, is_active, member_count, created_at}`, `GroupRef{id, slug, name}`, `GroupCreate{slug, name, description?}`, `GroupUpdate{name?, description?, is_active?}`, `GroupMembersOut{group_id, user_ids}`, `GroupMembersReplace{user_ids}`; router at `/api/groups`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_groups_routes.py`:

```python
"""Groups HTTP surface (spec §7.1)."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ADMIN = SimpleNamespace(id=1, role="admin", email="admin@x.t", is_active=True)
STAFF = SimpleNamespace(id=42, role="standard", email="t@x.t", is_active=True)


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from main import app
    from auth import get_current_user
    from database import Base, get_db
    import models  # noqa: F401
    import groups.models  # noqa: F401
    from models import User

    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    shared = sessionmaker(bind=engine)()
    for uid, email in ((1, "admin@x.t"), (42, "t@x.t"), (43, "u@x.t")):
        shared.add(User(id=uid, email=email, hashed_password="x",
                        role="admin" if uid == 1 else "standard", is_active=True))
    shared.add(User(id=44, email="gone@x.t", hashed_password="x", is_active=False))
    shared.commit()

    def _db():
        yield shared

    saved = {k: app.dependency_overrides.get(k) for k in (get_db, get_current_user)}
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: STAFF
    tc = TestClient(app)
    tc.db = shared
    tc.as_user = lambda u: app.dependency_overrides.__setitem__(get_current_user, lambda: u)
    yield tc
    for k, v in saved.items():
        if v is None:
            app.dependency_overrides.pop(k, None)
        else:
            app.dependency_overrides[k] = v
    shared.close()


def _mk(client, slug="exec", name="Exec"):
    client.as_user(ADMIN)
    r = client.post("/api/groups", json={"slug": slug, "name": name})
    assert r.status_code == 201, r.text
    client.as_user(STAFF)
    return r.json()


def test_standard_user_can_list_but_not_write(client):
    _mk(client)
    r = client.get("/api/groups")
    assert r.status_code == 200
    assert [g["slug"] for g in r.json()] == ["exec"]
    assert set(r.json()[0]) == {"id", "slug", "name", "description", "is_active",
                                "member_count", "created_at"}
    assert client.post("/api/groups", json={"slug": "x", "name": "X"}).status_code == 403
    assert client.put("/api/groups/1", json={"name": "Y"}).status_code == 403
    assert client.delete("/api/groups/1").status_code == 403
    assert client.get("/api/groups/1/members").status_code == 403
    assert client.put("/api/groups/1/members", json={"user_ids": [42]}).status_code == 403


def test_slug_rules(client):
    client.as_user(ADMIN)
    assert client.post("/api/groups", json={"slug": "Exec", "name": "E"}).status_code == 400
    assert client.post("/api/groups", json={"slug": "e", "name": "E"}).status_code == 400
    assert client.post("/api/groups", json={"slug": "exec team", "name": "E"}).status_code == 400
    assert client.post("/api/groups", json={"slug": "exec", "name": "E"}).status_code == 201
    assert client.post("/api/groups", json={"slug": "exec", "name": "E2"}).status_code == 409


def test_update_keeps_slug_immutable(client):
    g = _mk(client)
    client.as_user(ADMIN)
    r = client.put(f"/api/groups/{g['id']}", json={"name": "Executive", "description": "d"})
    assert r.status_code == 200 and r.json()["name"] == "Executive"
    assert client.put(f"/api/groups/{g['id']}", json={"slug": "other"}).status_code == 400
    assert client.put(f"/api/groups/{g['id']}", json={"slug": "exec"}).status_code == 200
    assert client.put("/api/groups/999", json={"name": "x"}).status_code == 404


def test_members_replace_and_validation(client):
    g = _mk(client)
    client.as_user(ADMIN)
    assert client.get(f"/api/groups/{g['id']}/members").json() == {"group_id": g["id"], "user_ids": []}
    r = client.put(f"/api/groups/{g['id']}/members", json={"user_ids": [42, 43, 42]})
    assert r.status_code == 200 and r.json()["user_ids"] == [42, 43]
    r = client.put(f"/api/groups/{g['id']}/members", json={"user_ids": [43]})
    assert r.json()["user_ids"] == [43]
    assert client.put(f"/api/groups/{g['id']}/members", json={"user_ids": [999]}).status_code == 400
    assert client.put(f"/api/groups/{g['id']}/members", json={"user_ids": [44]}).status_code == 400
    assert client.get("/api/groups").json()[0]["member_count"] == 1


def test_mine_lists_the_callers_groups(client):
    g = _mk(client)
    client.as_user(ADMIN)
    client.put(f"/api/groups/{g['id']}/members", json={"user_ids": [42]})
    client.as_user(STAFF)
    assert client.get("/api/groups/mine").json() == [{"id": g["id"], "slug": "exec", "name": "Exec"}]
    client.as_user(SimpleNamespace(id=43, role="standard", email="u@x.t", is_active=True))
    assert client.get("/api/groups/mine").json() == []


def test_inactive_groups_hidden_from_list_but_readable_by_admin(client):
    g = _mk(client)
    client.as_user(ADMIN)
    client.put(f"/api/groups/{g['id']}", json={"is_active": False})
    client.as_user(STAFF)
    assert client.get("/api/groups").json() == []
    client.as_user(ADMIN)
    assert [x["slug"] for x in client.get("/api/groups?include_inactive=true").json()] == ["exec"]


def test_delete_only_when_unused(client):
    g = _mk(client)
    client.as_user(ADMIN)
    client.put(f"/api/groups/{g['id']}/members", json={"user_ids": [42]})
    assert client.delete(f"/api/groups/{g['id']}").status_code == 409
    client.put(f"/api/groups/{g['id']}/members", json={"user_ids": []})
    assert client.delete(f"/api/groups/{g['id']}").status_code == 204
    assert client.delete(f"/api/groups/{g['id']}").status_code == 404
```

- [ ] **Step 2: Run to verify failure**

```bash
"$PY" -m pytest tests/test_groups_routes.py -q -p no:cacheprovider
```

Expected: every test fails with 404 (routes not mounted).

- [ ] **Step 3: Implement schemas, service, routes**

`backend/groups/schemas.py`:

```python
"""Pydantic v2 wire models for /api/groups (spec §7.1)."""
from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, ConfigDict


class GroupOut(BaseModel):
    id: int
    slug: str
    name: str
    description: Optional[str] = None
    is_active: bool
    member_count: int = 0
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class GroupRef(BaseModel):
    id: int
    slug: str
    name: str
    model_config = ConfigDict(from_attributes=True)


class GroupCreate(BaseModel):
    slug: str
    name: str
    description: Optional[str] = None


class GroupUpdate(BaseModel):
    """Partial. `slug` is accepted only when it equals the current slug (400 otherwise)."""
    slug: Optional[str] = None
    name: Optional[str] = None
    description: Optional[str] = None
    is_active: Optional[bool] = None


class GroupMembersOut(BaseModel):
    group_id: int
    user_ids: List[int]


class GroupMembersReplace(BaseModel):
    user_ids: List[int]
```

`backend/groups/service.py`:

```python
"""Group CRUD and membership (spec §4.1, §4.2, §7.1). Routes stay thin."""
from __future__ import annotations

import re
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from groups.errors import BadRequestError, ConflictError, NotFoundError
from groups.models import UserGroup, UserGroupMember

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,59}$")


def clean_slug(slug: str) -> str:
    s = (slug or "").strip()
    if not SLUG_RE.match(s):
        raise BadRequestError("slug must match ^[a-z0-9][a-z0-9-]{1,59}$")
    return s


def _clean_name(name: str) -> str:
    n = (name or "").strip()
    if not n or len(n) > 120:
        raise BadRequestError("name is required (max 120 chars)")
    return n


def member_counts(db: Session) -> dict[int, int]:
    rows = db.execute(select(UserGroupMember.group_id, func.count())
                      .group_by(UserGroupMember.group_id)).all()
    return {gid: n for gid, n in rows}


def list_groups(db: Session, *, include_inactive: bool = False) -> list[UserGroup]:
    stmt = select(UserGroup).order_by(UserGroup.name)
    if not include_inactive:
        stmt = stmt.where(UserGroup.is_active.is_(True))
    return list(db.execute(stmt).scalars().all())


def get_group(db: Session, group_id: int) -> UserGroup:
    g = db.get(UserGroup, group_id)
    if g is None:
        raise NotFoundError(f"group {group_id} not found")
    return g


def create_group(db: Session, *, slug: str, name: str, description: Optional[str]) -> UserGroup:
    slug = clean_slug(slug)
    if db.execute(select(UserGroup.id).where(UserGroup.slug == slug)).scalar_one_or_none():
        raise ConflictError(f"group slug {slug!r} already exists")
    g = UserGroup(slug=slug, name=_clean_name(name), description=(description or None))
    db.add(g)
    db.commit()
    db.refresh(g)
    return g


def update_group(db: Session, group_id: int, **fields) -> UserGroup:
    g = get_group(db, group_id)
    if "slug" in fields and fields["slug"] is not None and fields["slug"] != g.slug:
        raise BadRequestError("slug is immutable")
    if fields.get("name") is not None:
        g.name = _clean_name(fields["name"])
    if "description" in fields and fields["description"] is not None:
        g.description = fields["description"].strip() or None
    if fields.get("is_active") is not None:
        g.is_active = bool(fields["is_active"])
    db.commit()
    db.refresh(g)
    return g


def delete_group(db: Session, group_id: int) -> None:
    g = get_group(db, group_id)
    used = db.execute(select(UserGroupMember.id)
                      .where(UserGroupMember.group_id == g.id).limit(1)).scalar_one_or_none()
    if used is None:
        # Boards are registered later (Task 5); this import stays lazy so groups never
        # depend on boards at import time.
        try:
            from boards.models import BoardGrant
            used = db.execute(select(BoardGrant.id)
                              .where(BoardGrant.group_id == g.id).limit(1)).scalar_one_or_none()
        except ImportError:
            used = None
    if used is not None:
        raise ConflictError("group has members or board grants; deactivate it instead")
    db.delete(g)
    db.commit()


def list_members(db: Session, group_id: int) -> list[int]:
    get_group(db, group_id)
    return list(db.execute(select(UserGroupMember.user_id)
                           .where(UserGroupMember.group_id == group_id)
                           .order_by(UserGroupMember.user_id)).scalars().all())


def replace_members(db: Session, group_id: int, user_ids: list[int]) -> list[int]:
    from models import User
    get_group(db, group_id)
    wanted = sorted(set(int(u) for u in user_ids))
    if wanted:
        ok = set(db.execute(select(User.id).where(User.id.in_(wanted),
                                                   User.is_active.is_(True))).scalars().all())
        bad = [u for u in wanted if u not in ok]
        if bad:
            raise BadRequestError(f"unknown or inactive user ids: {bad}")
    db.query(UserGroupMember).filter(UserGroupMember.group_id == group_id).delete()
    for uid in wanted:
        db.add(UserGroupMember(group_id=group_id, user_id=uid))
    db.commit()
    return wanted


def my_groups(db: Session, user) -> list[UserGroup]:
    uid = getattr(user, "id", None)
    if uid is None:
        return []
    return list(db.execute(
        select(UserGroup)
        .join(UserGroupMember, UserGroupMember.group_id == UserGroup.id)
        .where(UserGroupMember.user_id == uid, UserGroup.is_active.is_(True))
        .order_by(UserGroup.name)).scalars().all())
```

`backend/groups/routes.py`:

```python
"""FastAPI router for user groups. Reads for any login, writes admin-only (spec §7.1)."""
from __future__ import annotations

import logging
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from auth import get_current_user, require_admin
from database import get_db
from groups import service
from groups.access import is_admin
from groups.errors import (BadRequestError, ConflictError, NotFoundError,
                           PermissionDeniedError)
from groups.schemas import (GroupCreate, GroupMembersOut, GroupMembersReplace, GroupOut,
                            GroupRef, GroupUpdate)

router = APIRouter(prefix="/api/groups", tags=["groups"])
logger = logging.getLogger(__name__)


def http_error(e: Exception) -> HTTPException:
    """Shared by groups and boards routes."""
    if isinstance(e, NotFoundError):
        return HTTPException(status_code=404, detail=str(e))
    if isinstance(e, PermissionDeniedError):
        return HTTPException(status_code=403, detail=str(e))
    if isinstance(e, ConflictError):
        return HTTPException(status_code=409, detail=str(e))
    if isinstance(e, BadRequestError):
        return HTTPException(status_code=400, detail=str(e))
    if isinstance(e, HTTPException):
        return e
    if isinstance(e, IntegrityError):
        logger.warning("groups/boards integrity conflict: %s", e)
        return HTTPException(status_code=409, detail="conflicting write; retry")
    logger.exception("unhandled groups/boards error")
    return HTTPException(status_code=500, detail="internal error")


def _out(g, counts) -> GroupOut:
    o = GroupOut.model_validate(g)
    o.member_count = counts.get(g.id, 0)
    return o


@router.get("", response_model=List[GroupOut])
def list_groups(include_inactive: bool = Query(False), db: Session = Depends(get_db),
                user=Depends(get_current_user)):
    counts = service.member_counts(db)
    rows = service.list_groups(db, include_inactive=include_inactive and is_admin(user))
    return [_out(g, counts) for g in rows]


@router.get("/mine", response_model=List[GroupRef])
def my_groups(db: Session = Depends(get_db), user=Depends(get_current_user)):
    return [GroupRef.model_validate(g) for g in service.my_groups(db, user)]


@router.post("", response_model=GroupOut, status_code=201)
def create_group(body: GroupCreate, db: Session = Depends(get_db), _=Depends(require_admin)):
    try:
        g = service.create_group(db, slug=body.slug, name=body.name, description=body.description)
    except Exception as e:
        db.rollback()
        raise http_error(e)
    return _out(g, {})


@router.put("/{group_id}", response_model=GroupOut)
def update_group(group_id: int, body: GroupUpdate, db: Session = Depends(get_db),
                 _=Depends(require_admin)):
    try:
        g = service.update_group(db, group_id, **body.model_dump(exclude_unset=True))
    except Exception as e:
        db.rollback()
        raise http_error(e)
    return _out(g, service.member_counts(db))


@router.delete("/{group_id}", status_code=204)
def delete_group(group_id: int, db: Session = Depends(get_db), _=Depends(require_admin)):
    try:
        service.delete_group(db, group_id)
    except Exception as e:
        db.rollback()
        raise http_error(e)
    return Response(status_code=204)


@router.get("/{group_id}/members", response_model=GroupMembersOut)
def get_members(group_id: int, db: Session = Depends(get_db), _=Depends(require_admin)):
    try:
        return GroupMembersOut(group_id=group_id, user_ids=service.list_members(db, group_id))
    except Exception as e:
        raise http_error(e)


@router.put("/{group_id}/members", response_model=GroupMembersOut)
def put_members(group_id: int, body: GroupMembersReplace, db: Session = Depends(get_db),
                _=Depends(require_admin)):
    try:
        ids = service.replace_members(db, group_id, body.user_ids)
    except Exception as e:
        db.rollback()
        raise http_error(e)
    return GroupMembersOut(group_id=group_id, user_ids=ids)
```

`backend/main.py`: after line 127 `from documents.routes import router as documents_router` add:

```python
from groups.routes import router as groups_router
```

and after line 622 `app.include_router(documents_router)` add:

```python
app.include_router(groups_router)
```

Note `require_admin` in `auth.py` raises 403 for a non-admin, which is why the test expects 403 for writes (an existing convention, distinct from the 404 rule for invisible boards).

- [ ] **Step 4: Run to verify pass**

```bash
"$PY" -m pytest tests/test_groups_routes.py tests/test_groups_models.py -q -p no:cacheprovider
```

Expected: `12 passed`.

- [ ] **Step 5: Commit**

```bash
cd /c/tmp/Accu-Mk1-boards
git add backend/groups/schemas.py backend/groups/service.py backend/groups/routes.py backend/main.py backend/tests/test_groups_routes.py
git commit -m "feat(groups): /api/groups CRUD, membership, mine

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/groups backend/main.py backend/tests/test_groups_routes.py
```

---

### Task 3: Boards models

**Files:**
- Create: `backend/boards/__init__.py`, `backend/boards/models.py`
- Modify: `backend/database.py` `init_db()` (add `import boards.models` after the groups import from Task 1)
- Test: `backend/tests/test_boards_models.py`

**Interfaces:**
- Produces: `boards.models.Board(id, slug, name, kind, visibility, created_by, default_viewport, created_at, updated_at)`, `BoardGrant(id, board_id, group_id, can_edit)`, `BoardNode(id, board_id, kind, label, parent_id, x, y, w, h, z, entity_type, entity_id, data, version, created_by, updated_by, created_at, updated_at)`, `BoardEdge(id, board_id, source_id, target_id, kind, label)`; constants `BOARD_KINDS`, `VISIBILITIES`, `NODE_KINDS`, `EDGE_KINDS`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_boards_models.py`:

```python
"""Boards tables and constraints (spec §4.3 to §4.6)."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker


def _session():
    from database import Base
    import models  # noqa: F401
    import groups.models  # noqa: F401
    import boards.models  # noqa: F401
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def test_tables_created():
    s = _session()
    names = set(inspect(s.get_bind()).get_table_names())
    assert {"board_boards", "board_grants", "board_nodes", "board_edges"} <= names


def test_visibility_and_kind_are_checked():
    from sqlalchemy.exc import IntegrityError
    from boards.models import Board
    s = _session()
    s.add(Board(slug="a", name="A", kind="map", visibility="secret"))
    with pytest.raises(IntegrityError):
        s.commit()
    s.rollback()
    s.add(Board(slug="a", name="A", kind="poster", visibility="company"))
    with pytest.raises(IntegrityError):
        s.commit()
    s.rollback()
    s.add(Board(slug="a", name="A"))
    s.commit()
    b = s.query(Board).one()
    assert (b.kind, b.visibility) == ("custom", "company")


def test_grant_pair_unique():
    from sqlalchemy.exc import IntegrityError
    from boards.models import Board, BoardGrant
    from groups.models import UserGroup
    s = _session()
    b, g = Board(slug="a", name="A"), UserGroup(slug="exec", name="Exec")
    s.add_all([b, g])
    s.flush()
    s.add(BoardGrant(board_id=b.id, group_id=g.id))
    s.commit()
    s.add(BoardGrant(board_id=b.id, group_id=g.id, can_edit=True))
    with pytest.raises(IntegrityError):
        s.commit()


def test_node_defaults_and_edge_uniqueness():
    from sqlalchemy.exc import IntegrityError
    from boards.models import Board, BoardEdge, BoardNode
    s = _session()
    b = Board(slug="a", name="A")
    s.add(b)
    s.flush()
    n1, n2 = BoardNode(board_id=b.id, kind="frame", label="F"), BoardNode(board_id=b.id, kind="text", label="T")
    s.add_all([n1, n2])
    s.commit()
    assert (n1.version, n1.z, n1.x, n1.y, n1.parent_id) == (1, 0, 0.0, 0.0, None)
    s.add(BoardEdge(board_id=b.id, source_id=n1.id, target_id=n2.id, kind="related"))
    s.commit()
    s.add(BoardEdge(board_id=b.id, source_id=n1.id, target_id=n2.id, kind="related"))
    with pytest.raises(IntegrityError):
        s.commit()
    s.rollback()
    s.add(BoardEdge(board_id=b.id, source_id=n1.id, target_id=n2.id, kind="teleport"))
    with pytest.raises(IntegrityError):
        s.commit()
```

- [ ] **Step 2: Run to verify failure**

```bash
"$PY" -m pytest tests/test_boards_models.py -q -p no:cacheprovider
```

Expected: `ModuleNotFoundError: No module named 'boards'`.

- [ ] **Step 3: Create the models**

`backend/boards/__init__.py`: empty.

`backend/boards/models.py`:

```python
"""Planning boards (spec 2026-09-26 §4.3 to §4.6). A board is a spatial index over
things Mk1 already tracks; nodes point at flag entities or are generic objects.
No lims_ prefix: not sample-hierarchy entities. User ids are plain integers."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import (JSON, Boolean, CheckConstraint, DateTime, Float, ForeignKey, Index,
                        Integer, String, UniqueConstraint)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from database import Base

BOARD_KINDS = ("map", "org", "training", "custom")
VISIBILITIES = ("company", "restricted")
NODE_KINDS = ("frame", "text", "note", "link", "entity", "person", "widget")
EDGE_KINDS = ("related", "reports_to", "depends_on", "next")

_JSON = JSONB().with_variant(JSON(), "sqlite")


def _in(col: str, values: tuple, name: str) -> CheckConstraint:
    quoted = ",".join(f"'{v}'" for v in values)
    return CheckConstraint(f"{col} IN ({quoted})", name=name)


class Board(Base):
    """`slug` is immutable (service enforces). `visibility` decides who may VIEW;
    grants decide who may EDIT (and, for restricted boards, also who may view)."""
    __tablename__ = "board_boards"
    __table_args__ = (
        _in("kind", BOARD_KINDS, "ck_board_boards_kind"),
        _in("visibility", VISIBILITIES, "ck_board_boards_visibility"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    slug: Mapped[str] = mapped_column(String(60), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False, default="custom")
    visibility: Mapped[str] = mapped_column(String(20), nullable=False, default="company")
    created_by: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    default_viewport: Mapped[Optional[dict]] = mapped_column(_JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow,
                                                 nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow,
                                                 onupdate=datetime.utcnow, nullable=False)

    def __repr__(self) -> str:
        return f"<Board(id={self.id}, slug='{self.slug}', visibility='{self.visibility}')>"


class BoardGrant(Base):
    __tablename__ = "board_grants"
    __table_args__ = (UniqueConstraint("board_id", "group_id", name="uq_board_grants_pair"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    board_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("board_boards.id", ondelete="CASCADE"), nullable=False)
    group_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("user_groups.id", ondelete="CASCADE"), nullable=False)
    can_edit: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False,
                                           server_default="false")


class BoardNode(Base):
    """One object on a board. `id` (stringified) is the `board_node` flag anchor.
    `x`/`y` are relative to the parent frame when `parent_id` is set (xyflow)."""
    __tablename__ = "board_nodes"
    __table_args__ = (
        _in("kind", NODE_KINDS, "ck_board_nodes_kind"),
        Index("ix_board_nodes_board_id", "board_id"),
        Index("ix_board_nodes_entity", "entity_type", "entity_id"),
        Index("ix_board_nodes_parent_id", "parent_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    board_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("board_boards.id", ondelete="CASCADE"), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    label: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    parent_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("board_nodes.id", ondelete="SET NULL"), nullable=True)
    x: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    y: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    w: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    h: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    z: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    entity_type: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    entity_id: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    data: Mapped[Optional[dict]] = mapped_column(_JSON, nullable=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_by: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    updated_by: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow,
                                                 nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow,
                                                 onupdate=datetime.utcnow, nullable=False)


class BoardEdge(Base):
    __tablename__ = "board_edges"
    __table_args__ = (
        UniqueConstraint("board_id", "source_id", "target_id", "kind", name="uq_board_edges"),
        _in("kind", EDGE_KINDS, "ck_board_edges_kind"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    board_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("board_boards.id", ondelete="CASCADE"), nullable=False)
    source_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("board_nodes.id", ondelete="CASCADE"), nullable=False)
    target_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("board_nodes.id", ondelete="CASCADE"), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False, default="related")
    label: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
```

`backend/database.py`, in `init_db()` right after the `import groups.models` line:

```python
    import boards.models  # noqa: F401  (register board_* tables on Base)
```

- [ ] **Step 4: Run to verify pass**

```bash
"$PY" -m pytest tests/test_boards_models.py -q -p no:cacheprovider
```

Expected: `4 passed`.

- [ ] **Step 5: Commit**

```bash
cd /c/tmp/Accu-Mk1-boards
git add backend/boards/__init__.py backend/boards/models.py backend/database.py backend/tests/test_boards_models.py
git commit -m "feat(boards): board_* tables

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/boards backend/database.py backend/tests/test_boards_models.py
```

---

### Task 4: Board access rules

**Files:**
- Create: `backend/boards/access.py`
- Test: `backend/tests/test_boards_access.py`

**Interfaces:**
- Consumes: `groups.access.{is_admin, user_group_ids}`, `groups.errors.{NotFoundError, PermissionDeniedError}`, Task 3 models.
- Produces: `boards.access.can_view_board(db, user, board) -> bool`, `can_edit_board(db, user, board) -> bool`, `visible_board_ids(db, user) -> Select`, `require_view(db, user, board)` (raises `NotFoundError`), `require_edit(db, user, board)` (raises `NotFoundError` when not viewable, `PermissionDeniedError` when viewable but not editable).

Membership is read fresh on every call (no cache). The spec's per-request cache is an optimization to add only when a query count shows it matters; Review Focus item 1 depends on reads being live.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_boards_access.py`:

```python
"""Access matrix (spec §5). Invisible = NotFoundError; visible-not-editable = PermissionDeniedError."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

ADMIN = SimpleNamespace(id=1, role="admin", is_active=True)
EDITOR = SimpleNamespace(id=10, role="standard", is_active=True)
VIEWER = SimpleNamespace(id=11, role="standard", is_active=True)
OUTSIDER = SimpleNamespace(id=12, role="standard", is_active=True)
INACTIVE = SimpleNamespace(id=13, role="standard", is_active=False)


@pytest.fixture
def world():
    from database import Base
    import models  # noqa: F401
    import groups.models  # noqa: F401
    import boards.models  # noqa: F401
    from boards.models import Board, BoardGrant
    from groups.models import UserGroup, UserGroupMember
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    editors, viewers = UserGroup(slug="editors", name="E"), UserGroup(slug="viewers", name="V")
    company, secret = Board(slug="org", name="Org"), Board(slug="exec", name="Exec", visibility="restricted")
    s.add_all([editors, viewers, company, secret])
    s.flush()
    s.add_all([UserGroupMember(group_id=editors.id, user_id=EDITOR.id),
               UserGroupMember(group_id=viewers.id, user_id=VIEWER.id),
               UserGroupMember(group_id=viewers.id, user_id=INACTIVE.id),
               BoardGrant(board_id=secret.id, group_id=editors.id, can_edit=True),
               BoardGrant(board_id=secret.id, group_id=viewers.id, can_edit=False),
               BoardGrant(board_id=company.id, group_id=editors.id, can_edit=True)])
    s.commit()
    return SimpleNamespace(s=s, company=company, secret=secret, viewers=viewers)


def test_view_matrix(world):
    from boards.access import can_view_board as v
    s = world.s
    assert [v(s, u, world.company) for u in (ADMIN, EDITOR, VIEWER, OUTSIDER, INACTIVE)] == \
        [True, True, True, True, False]
    assert [v(s, u, world.secret) for u in (ADMIN, EDITOR, VIEWER, OUTSIDER, INACTIVE)] == \
        [True, True, True, False, False]
    assert v(s, None, world.company) is False


def test_edit_matrix(world):
    from boards.access import can_edit_board as e
    s = world.s
    assert [e(s, u, world.company) for u in (ADMIN, EDITOR, VIEWER, OUTSIDER)] == [True, True, False, False]
    assert [e(s, u, world.secret) for u in (ADMIN, EDITOR, VIEWER, OUTSIDER)] == [True, True, False, False]


def test_visible_board_ids(world):
    from boards.access import visible_board_ids
    s = world.s
    ids = lambda u: set(s.execute(visible_board_ids(s, u)).scalars().all())  # noqa: E731
    both = {world.company.id, world.secret.id}
    assert ids(ADMIN) == both and ids(EDITOR) == both and ids(VIEWER) == both
    assert ids(OUTSIDER) == {world.company.id}
    assert ids(INACTIVE) == set()


def test_require_helpers_map_to_errors(world):
    from boards.access import require_edit, require_view
    from groups.errors import NotFoundError, PermissionDeniedError
    s = world.s
    require_view(s, VIEWER, world.secret)
    with pytest.raises(NotFoundError):
        require_view(s, OUTSIDER, world.secret)
    with pytest.raises(NotFoundError):
        require_edit(s, OUTSIDER, world.secret)
    with pytest.raises(PermissionDeniedError):
        require_edit(s, VIEWER, world.secret)
    require_edit(s, EDITOR, world.secret)


def test_visibility_reads_membership_live(world):
    """A user pulled from every group loses access on the next call, same session,
    same user object, no re-login (Review Focus 1)."""
    from boards.access import can_view_board
    from groups.models import UserGroupMember
    s = world.s
    assert can_view_board(s, VIEWER, world.secret) is True
    s.query(UserGroupMember).filter(UserGroupMember.user_id == VIEWER.id).delete()
    s.commit()
    assert can_view_board(s, VIEWER, world.secret) is False
```

- [ ] **Step 2: Run to verify failure**

```bash
"$PY" -m pytest tests/test_boards_access.py -q -p no:cacheprovider
```

Expected: `ModuleNotFoundError: No module named 'boards.access'`.

- [ ] **Step 3: Implement**

`backend/boards/access.py`:

```python
"""The one module that answers every board visibility question (spec §5).
Routes and the board_node flag seam call these; nothing else re-derives the rule.

  can_view_board : admin -> True; company -> active user; restricted -> any grant for
                   one of the user's groups
  can_edit_board : admin -> True; else a grant with can_edit for one of the user's groups
  visible_board_ids : Select of board ids the user may see (for IN (...) subqueries)

Membership is read on every call: revoking a group takes effect on the next request."""
from __future__ import annotations

from sqlalchemy import false, or_, select
from sqlalchemy.orm import Session

from boards.models import Board, BoardGrant
from groups.access import is_admin, user_group_ids
from groups.errors import NotFoundError, PermissionDeniedError


def _active(user) -> bool:
    return getattr(user, "id", None) is not None and bool(getattr(user, "is_active", True))


def _has_grant(db: Session, board: Board, gids: frozenset[int], *, edit: bool) -> bool:
    if not gids:
        return False
    stmt = select(BoardGrant.id).where(BoardGrant.board_id == board.id,
                                       BoardGrant.group_id.in_(gids))
    if edit:
        stmt = stmt.where(BoardGrant.can_edit.is_(True))
    return db.execute(stmt.limit(1)).scalar_one_or_none() is not None


def can_view_board(db: Session, user, board: Board) -> bool:
    if not _active(user):
        return False
    if is_admin(user) or board.visibility == "company":
        return True
    return _has_grant(db, board, user_group_ids(db, user), edit=False)


def can_edit_board(db: Session, user, board: Board) -> bool:
    if not _active(user):
        return False
    if is_admin(user):
        return True
    return _has_grant(db, board, user_group_ids(db, user), edit=True)


def visible_board_ids(db: Session, user):
    if not _active(user):
        return select(Board.id).where(false())
    if is_admin(user):
        return select(Board.id)
    cond = Board.visibility == "company"
    gids = user_group_ids(db, user)
    if gids:
        granted = select(BoardGrant.board_id).where(BoardGrant.group_id.in_(gids))
        cond = or_(cond, Board.id.in_(granted))
    return select(Board.id).where(cond)


def require_view(db: Session, user, board: Board) -> None:
    if not can_view_board(db, user, board):
        # 404, never 403: do not confirm a restricted board exists.
        raise NotFoundError(f"board {board.slug!r} not found")


def require_edit(db: Session, user, board: Board) -> None:
    require_view(db, user, board)
    if not can_edit_board(db, user, board):
        raise PermissionDeniedError(f"not allowed to edit board {board.slug!r}")
```

- [ ] **Step 4: Run to verify pass**

```bash
"$PY" -m pytest tests/test_boards_access.py -q -p no:cacheprovider
```

Expected: `5 passed`.

- [ ] **Step 5: Commit**

```bash
cd /c/tmp/Accu-Mk1-boards
git add backend/boards/access.py backend/tests/test_boards_access.py
git commit -m "feat(boards): access rules (view/edit/visible ids)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/boards/access.py backend/tests/test_boards_access.py
```

---

### Task 5: Boards service, schemas, routes (boards, grants, for-entity)

**Files:**
- Create: `backend/boards/schemas.py`, `backend/boards/service.py`, `backend/boards/routes.py`
- Modify: `backend/main.py` (import `boards_router` after `groups_router`; `include_router` after `groups_router`)
- Test: `backend/tests/test_boards_routes.py`

**Interfaces:**
- Consumes: Tasks 3 and 4; `groups.service.clean_slug`; `groups.routes.http_error`; `flags.models.FlagFlag`, `flags.catalog.OPEN_STATES`; `flags.seams.resolve_contexts`.
- Produces: `boards.service.RESTRICTED_BOARDS_ENABLED`, `list_boards`, `get_board`, `create_board`, `patch_board`, `delete_board`, `node_counts`, `list_grants`, `replace_grants`, `boards_for_entity`, `open_flag_count(db, node_ids) -> int`, `board_detail_payload(db, user, board) -> BoardDetail`; wire models `BoardOut`, `BoardDetail`, `BoardCreate`, `BoardPatch`, `ViewportIn`, `GrantIn`, `GrantOut`, `NodeOut`, `EdgeOut`, `EntityBoardRef`. Router at `/api/boards`. Task 6 adds node/edge functions to the same three files.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_boards_routes.py`:

```python
"""Boards HTTP surface: boards, grants, for-entity (spec §7.2)."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ADMIN = SimpleNamespace(id=1, role="admin", email="admin@x.t", is_active=True)
EDITOR = SimpleNamespace(id=10, role="standard", email="e@x.t", is_active=True)
VIEWER = SimpleNamespace(id=11, role="standard", email="v@x.t", is_active=True)
OUTSIDER = SimpleNamespace(id=12, role="standard", email="o@x.t", is_active=True)


@pytest.fixture
def client(monkeypatch):
    from fastapi.testclient import TestClient
    from main import app
    from auth import get_current_user
    from database import Base, get_db
    import models  # noqa: F401
    import groups.models  # noqa: F401
    import boards.models  # noqa: F401
    import flags.models  # noqa: F401
    from models import User
    from groups.models import UserGroup, UserGroupMember
    from boards import service

    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    for u in (ADMIN, EDITOR, VIEWER, OUTSIDER):
        s.add(User(id=u.id, email=u.email, hashed_password="x", role=u.role, is_active=True))
    editors, viewers = UserGroup(slug="editors", name="Editors"), UserGroup(slug="viewers", name="Viewers")
    s.add_all([editors, viewers])
    s.flush()
    s.add_all([UserGroupMember(group_id=editors.id, user_id=EDITOR.id),
               UserGroupMember(group_id=viewers.id, user_id=VIEWER.id)])
    s.commit()
    monkeypatch.setattr(service, "RESTRICTED_BOARDS_ENABLED", True)

    def _db():
        yield s

    saved = {k: app.dependency_overrides.get(k) for k in (get_db, get_current_user)}
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: OUTSIDER
    tc = TestClient(app)
    tc.db, tc.editors, tc.viewers = s, editors.id, viewers.id
    tc.as_user = lambda u: app.dependency_overrides.__setitem__(get_current_user, lambda: u)
    yield tc
    for k, v in saved.items():
        if v is None:
            app.dependency_overrides.pop(k, None)
        else:
            app.dependency_overrides[k] = v
    s.close()


def _board(client, slug, visibility="company", grants=()):
    client.as_user(ADMIN)
    r = client.post("/api/boards", json={"slug": slug, "name": slug.title(), "kind": "map",
                                         "visibility": visibility})
    assert r.status_code == 201, r.text
    if grants:
        g = client.put(f"/api/boards/{slug}/grants", json=list(grants))
        assert g.status_code == 200, g.text
    client.as_user(OUTSIDER)
    return r.json()


def test_list_and_get_follow_visibility(client):
    _board(client, "org")
    _board(client, "exec", "restricted", [{"group_id": client.editors, "can_edit": True},
                                          {"group_id": client.viewers, "can_edit": False}])
    client.as_user(OUTSIDER)
    assert [b["slug"] for b in client.get("/api/boards").json()] == ["org"]
    assert client.get("/api/boards/exec").status_code == 404
    assert client.get("/api/boards/org").status_code == 200
    client.as_user(VIEWER)
    rows = {b["slug"]: b for b in client.get("/api/boards").json()}
    assert set(rows) == {"exec", "org"}
    assert rows["exec"]["can_edit"] is False and rows["org"]["can_edit"] is False
    d = client.get("/api/boards/exec").json()
    assert d["nodes"] == [] and d["edges"] == []
    assert sorted(g["group_slug"] for g in d["grants"]) == ["editors", "viewers"]
    client.as_user(EDITOR)
    assert client.get("/api/boards/exec").json()["can_edit"] is True
    client.as_user(ADMIN)
    assert len(client.get("/api/boards").json()) == 2


def test_create_rules(client):
    from boards import service
    client.as_user(OUTSIDER)
    assert client.post("/api/boards", json={"slug": "x", "name": "X"}).status_code == 403
    client.as_user(ADMIN)
    assert client.post("/api/boards", json={"slug": "Bad Slug", "name": "X"}).status_code == 400
    assert client.post("/api/boards", json={"slug": "x", "name": "X", "kind": "poster"}).status_code == 400
    assert client.post("/api/boards", json={"slug": "x", "name": "X", "visibility": "secret"}).status_code == 400
    r = client.post("/api/boards", json={"slug": "x", "name": "X"})
    assert r.status_code == 201 and r.json()["kind"] == "custom" and r.json()["created_by"] == ADMIN.id
    assert client.post("/api/boards", json={"slug": "x", "name": "X2"}).status_code == 409
    service.RESTRICTED_BOARDS_ENABLED = False
    r = client.post("/api/boards", json={"slug": "y", "name": "Y", "visibility": "restricted"})
    assert r.status_code == 400 and "not enabled" in r.json()["detail"]


def test_patch_rights_and_visibility_is_admin_only(client):
    _board(client, "exec", "restricted", [{"group_id": client.editors, "can_edit": True},
                                          {"group_id": client.viewers, "can_edit": False}])
    client.as_user(OUTSIDER)
    assert client.patch("/api/boards/exec", json={"name": "N"}).status_code == 404
    client.as_user(VIEWER)
    assert client.patch("/api/boards/exec", json={"name": "N"}).status_code == 403
    client.as_user(EDITOR)
    r = client.patch("/api/boards/exec", json={"name": "Exec map", "kind": "org",
                                               "default_viewport": {"x": 1, "y": 2, "zoom": 0.5}})
    assert r.status_code == 200 and r.json()["kind"] == "org"
    assert r.json()["default_viewport"] == {"x": 1.0, "y": 2.0, "zoom": 0.5}
    assert client.patch("/api/boards/exec", json={"default_viewport": {"x": 0, "y": 0, "zoom": 9}}).status_code == 422
    assert client.patch("/api/boards/exec", json={"visibility": "company"}).status_code == 403
    client.as_user(ADMIN)
    assert client.patch("/api/boards/exec", json={"visibility": "company"}).json()["visibility"] == "company"
    assert client.patch("/api/boards/exec", json={"slug": "other"}).status_code == 422


def test_grants_replace(client):
    _board(client, "org")
    client.as_user(OUTSIDER)
    assert client.put("/api/boards/org/grants", json=[]).status_code == 403
    client.as_user(ADMIN)
    assert client.put("/api/boards/org/grants", json=[{"group_id": 999, "can_edit": True}]).status_code == 400
    r = client.put("/api/boards/org/grants", json=[{"group_id": client.editors, "can_edit": True}])
    assert [g["group_slug"] for g in r.json()] == ["editors"]
    r = client.put("/api/boards/org/grants", json=[{"group_id": client.viewers, "can_edit": False}])
    assert [g["group_slug"] for g in r.json()] == ["viewers"]
    client.as_user(EDITOR)
    assert client.get("/api/boards/org").json()["can_edit"] is False


def test_delete_is_admin_only(client):
    _board(client, "org")
    client.as_user(EDITOR)
    assert client.delete("/api/boards/org").status_code == 403
    client.as_user(ADMIN)
    assert client.delete("/api/boards/org").status_code == 204
    assert client.get("/api/boards/org").status_code == 404
    assert client.delete("/api/boards/org").status_code == 404


def test_for_entity_is_empty_without_nodes(client):
    _board(client, "org")
    client.as_user(OUTSIDER)
    r = client.get("/api/boards/for-entity", params={"entity_type": "document", "entity_id": "SOP-0001"})
    assert r.status_code == 200 and r.json() == []
```

- [ ] **Step 2: Run to verify failure**

```bash
"$PY" -m pytest tests/test_boards_routes.py -q -p no:cacheprovider
```

Expected: all fail with 404 (router not mounted).

- [ ] **Step 3: Implement schemas, service, routes**

`backend/boards/schemas.py`:

```python
"""Pydantic v2 wire models for /api/boards (spec §7.2, §7.3). Node `data` per kind
lives in KIND_DATA (Task 6 fills it)."""
from __future__ import annotations

from datetime import datetime
from typing import Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field


class ViewportIn(BaseModel):
    x: float
    y: float
    zoom: float = Field(ge=0.1, le=4)


class GrantIn(BaseModel):
    group_id: int
    can_edit: bool = False


class GrantOut(BaseModel):
    group_id: int
    group_slug: str
    group_name: str
    can_edit: bool


class BoardOut(BaseModel):
    id: int
    slug: str
    name: str
    kind: str
    visibility: str
    created_by: Optional[int] = None
    default_viewport: Optional[dict] = None
    node_count: int = 0
    can_edit: bool = False
    created_at: datetime
    updated_at: datetime
    model_config = ConfigDict(from_attributes=True)


class NodeOut(BaseModel):
    id: int
    board_id: int
    kind: str
    label: str
    parent_id: Optional[int] = None
    x: float
    y: float
    w: Optional[float] = None
    h: Optional[float] = None
    z: int
    entity_type: Optional[str] = None
    entity_id: Optional[str] = None
    data: Optional[dict] = None
    version: int
    created_by: Optional[int] = None
    updated_by: Optional[int] = None
    created_at: datetime
    updated_at: datetime
    context: Optional[dict] = None  # registry EntityContext for `entity` kinds
    model_config = ConfigDict(from_attributes=True)


class EdgeOut(BaseModel):
    id: int
    board_id: int
    source_id: int
    target_id: int
    kind: str
    label: Optional[str] = None
    model_config = ConfigDict(from_attributes=True)


class BoardDetail(BoardOut):
    nodes: List[NodeOut] = Field(default_factory=list)
    edges: List[EdgeOut] = Field(default_factory=list)
    grants: List[GrantOut] = Field(default_factory=list)


class BoardCreate(BaseModel):
    slug: str
    name: str
    kind: str = "custom"
    visibility: str = "company"


class BoardPatch(BaseModel):
    """No `slug`: immutable. An unknown field is a 422 (extra='forbid')."""
    name: Optional[str] = None
    kind: Optional[str] = None
    visibility: Optional[str] = None
    default_viewport: Optional[ViewportIn] = None
    model_config = ConfigDict(extra="forbid")


class EntityBoardRef(BaseModel):
    board_id: int
    board_slug: str
    board_name: str
    node_id: int
    node_label: str


# Filled by Task 6 (per-kind data models). Kept here so schemas is the single wire module.
KIND_DATA: Dict[str, type] = {}
```

`backend/boards/service.py`:

```python
"""Boards, grants, reverse lookup (spec §4.8, §5, §7.2). Nodes and edges: Task 6."""
from __future__ import annotations

from typing import Iterable, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from boards import access
from boards.models import BOARD_KINDS, VISIBILITIES, Board, BoardEdge, BoardGrant, BoardNode
from boards.schemas import BoardDetail, BoardOut, EdgeOut, GrantOut, NodeOut
from groups.access import is_admin
from groups.errors import BadRequestError, ConflictError, NotFoundError, PermissionDeniedError
from groups.models import UserGroup
from groups.service import clean_slug

# Flipped to True by slice 2 (flag visibility enforcement). Until then a restricted board
# would leak its flags into every staff member's All Open tab, so it cannot exist.
RESTRICTED_BOARDS_ENABLED = False


def _require_admin(user) -> None:
    if not is_admin(user):
        raise PermissionDeniedError("admin only")


def _check_visibility(visibility: str) -> str:
    if visibility not in VISIBILITIES:
        raise BadRequestError(f"visibility must be one of {VISIBILITIES}")
    if visibility == "restricted" and not RESTRICTED_BOARDS_ENABLED:
        raise BadRequestError("restricted boards are not enabled yet")
    return visibility


def _check_kind(kind: str) -> str:
    if kind not in BOARD_KINDS:
        raise BadRequestError(f"kind must be one of {BOARD_KINDS}")
    return kind


def _clean_name(name: str) -> str:
    n = (name or "").strip()
    if not n or len(n) > 120:
        raise BadRequestError("name is required (max 120 chars)")
    return n


def open_flag_count(db: Session, node_ids: Iterable[int]) -> int:
    """Open flags anchored on these board nodes (board_node + str(id)). Spec §4.8."""
    from flags.catalog import OPEN_STATES
    from flags.models import FlagFlag
    ids = [str(i) for i in node_ids]
    if not ids:
        return 0
    return int(db.execute(select(func.count()).select_from(FlagFlag).where(
        FlagFlag.entity_type == "board_node", FlagFlag.entity_id.in_(ids),
        FlagFlag.status.in_(OPEN_STATES))).scalar_one())


# --- boards ---------------------------------------------------------------------

def list_boards(db: Session, user) -> list[Board]:
    return list(db.execute(select(Board).where(Board.id.in_(access.visible_board_ids(db, user)))
                           .order_by(Board.name)).scalars().all())


def get_board(db: Session, user, slug: str) -> Board:
    board = db.execute(select(Board).where(Board.slug == slug)).scalar_one_or_none()
    if board is None:
        raise NotFoundError(f"board {slug!r} not found")
    access.require_view(db, user, board)
    return board


def create_board(db: Session, user, *, slug: str, name: str, kind: str, visibility: str) -> Board:
    _require_admin(user)
    slug = clean_slug(slug)
    if db.execute(select(Board.id).where(Board.slug == slug)).scalar_one_or_none():
        raise ConflictError(f"board slug {slug!r} already exists")
    board = Board(slug=slug, name=_clean_name(name), kind=_check_kind(kind),
                  visibility=_check_visibility(visibility), created_by=getattr(user, "id", None))
    db.add(board)
    db.commit()
    db.refresh(board)
    return board


def patch_board(db: Session, user, slug: str, **fields) -> Board:
    board = get_board(db, user, slug)
    access.require_edit(db, user, board)
    if fields.get("visibility") is not None:
        _require_admin(user)
        board.visibility = _check_visibility(fields["visibility"])
    if fields.get("name") is not None:
        board.name = _clean_name(fields["name"])
    if fields.get("kind") is not None:
        board.kind = _check_kind(fields["kind"])
    if fields.get("default_viewport") is not None:
        vp = fields["default_viewport"]
        board.default_viewport = vp if isinstance(vp, dict) else vp.model_dump()
    db.commit()
    db.refresh(board)
    return board


def delete_board(db: Session, user, slug: str) -> None:
    board = get_board(db, user, slug)
    _require_admin(user)
    node_ids = list(db.execute(select(BoardNode.id).where(BoardNode.board_id == board.id)).scalars())
    n = open_flag_count(db, node_ids)
    if n:
        raise ConflictError(f"board has {n} open flag(s) on its nodes; resolve them first")
    # Explicit cascade so SQLite tests and Postgres behave the same (spec §14).
    db.query(BoardEdge).filter(BoardEdge.board_id == board.id).delete()
    db.query(BoardNode).filter(BoardNode.board_id == board.id).update({BoardNode.parent_id: None})
    db.query(BoardNode).filter(BoardNode.board_id == board.id).delete()
    db.query(BoardGrant).filter(BoardGrant.board_id == board.id).delete()
    db.delete(board)
    db.commit()


def node_counts(db: Session, board_ids: Iterable[int]) -> dict[int, int]:
    ids = list(board_ids)
    if not ids:
        return {}
    rows = db.execute(select(BoardNode.board_id, func.count()).where(BoardNode.board_id.in_(ids))
                      .group_by(BoardNode.board_id)).all()
    return {bid: n for bid, n in rows}


# --- grants -----------------------------------------------------------------------

def list_grants(db: Session, board: Board) -> list[GrantOut]:
    rows = db.execute(select(BoardGrant, UserGroup).join(UserGroup, UserGroup.id == BoardGrant.group_id)
                      .where(BoardGrant.board_id == board.id).order_by(UserGroup.name)).all()
    return [GrantOut(group_id=g.id, group_slug=g.slug, group_name=g.name, can_edit=gr.can_edit)
            for gr, g in rows]


def replace_grants(db: Session, user, slug: str, grants) -> list[GrantOut]:
    board = get_board(db, user, slug)
    _require_admin(user)
    wanted = {}
    for g in grants:
        wanted[int(g.group_id)] = bool(g.can_edit)  # last one wins on duplicates
    if wanted:
        ok = set(db.execute(select(UserGroup.id).where(UserGroup.id.in_(list(wanted)))).scalars())
        bad = sorted(set(wanted) - ok)
        if bad:
            raise BadRequestError(f"unknown group ids: {bad}")
    db.query(BoardGrant).filter(BoardGrant.board_id == board.id).delete()
    for gid, can_edit in wanted.items():
        db.add(BoardGrant(board_id=board.id, group_id=gid, can_edit=can_edit))
    db.commit()
    return list_grants(db, board)


# --- reverse lookup ----------------------------------------------------------------

def boards_for_entity(db: Session, user, entity_type: str, entity_id: str) -> list[tuple[Board, BoardNode]]:
    rows = db.execute(select(Board, BoardNode).join(BoardNode, BoardNode.board_id == Board.id)
                      .where(BoardNode.entity_type == entity_type, BoardNode.entity_id == str(entity_id),
                             Board.id.in_(access.visible_board_ids(db, user)))
                      .order_by(Board.name, BoardNode.id)).all()
    return [(b, n) for b, n in rows]


# --- serialization -----------------------------------------------------------------

def board_out(db: Session, user, board: Board, counts: Optional[dict] = None) -> BoardOut:
    out = BoardOut.model_validate(board)
    out.node_count = (counts or node_counts(db, [board.id])).get(board.id, 0)
    out.can_edit = access.can_edit_board(db, user, board)
    return out


def board_detail_payload(db: Session, user, board: Board) -> BoardDetail:
    from flags import seams
    nodes = list(db.execute(select(BoardNode).where(BoardNode.board_id == board.id)
                            .order_by(BoardNode.z, BoardNode.id)).scalars().all())
    edges = list(db.execute(select(BoardEdge).where(BoardEdge.board_id == board.id)
                            .order_by(BoardEdge.id)).scalars().all())
    by_type: dict[str, list[str]] = {}
    for n in nodes:
        if n.kind == "entity" and n.entity_type and n.entity_id:
            by_type.setdefault(n.entity_type, []).append(n.entity_id)
    ctx = {(t, eid): c for t, ids in by_type.items()
           for eid, c in seams.resolve_contexts(db, t, ids).items()}
    base = board_out(db, user, board)
    detail = BoardDetail(**base.model_dump())
    for n in nodes:
        o = NodeOut.model_validate(n)
        if n.kind == "entity":
            o.context = ctx.get((n.entity_type, n.entity_id))
        detail.nodes.append(o)
    detail.edges = [EdgeOut.model_validate(e) for e in edges]
    detail.grants = list_grants(db, board)
    return detail
```

`backend/boards/routes.py`:

```python
"""FastAPI router for boards (spec §7.2, §7.3). Every route needs a login; boards the
caller cannot view are 404 on every route (spec §9)."""
from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from auth import get_current_user
from boards import service
from boards.schemas import (BoardCreate, BoardDetail, BoardOut, BoardPatch, EntityBoardRef,
                            GrantIn, GrantOut)
from database import get_db
from groups.routes import http_error

router = APIRouter(prefix="/api/boards", tags=["boards"])


@router.get("", response_model=List[BoardOut])
def list_boards(db: Session = Depends(get_db), user=Depends(get_current_user)):
    boards = service.list_boards(db, user)
    counts = service.node_counts(db, [b.id for b in boards])
    return [service.board_out(db, user, b, counts) for b in boards]


@router.post("", response_model=BoardOut, status_code=201)
def create_board(body: BoardCreate, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        b = service.create_board(db, user, slug=body.slug, name=body.name, kind=body.kind,
                                 visibility=body.visibility)
    except Exception as e:
        db.rollback()
        raise http_error(e)
    return service.board_out(db, user, b)


# Literal route ABOVE /{slug} so it wins the match (literal-before-param, flags convention).
@router.get("/for-entity", response_model=List[EntityBoardRef])
def boards_for_entity(entity_type: str = Query(...), entity_id: str = Query(...),
                      db: Session = Depends(get_db), user=Depends(get_current_user)):
    return [EntityBoardRef(board_id=b.id, board_slug=b.slug, board_name=b.name,
                           node_id=n.id, node_label=n.label)
            for b, n in service.boards_for_entity(db, user, entity_type, entity_id)]


@router.get("/{slug}", response_model=BoardDetail)
def get_board(slug: str, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        board = service.get_board(db, user, slug)
        return service.board_detail_payload(db, user, board)
    except Exception as e:
        raise http_error(e)


@router.patch("/{slug}", response_model=BoardOut)
def patch_board(slug: str, body: BoardPatch, db: Session = Depends(get_db),
                user=Depends(get_current_user)):
    try:
        b = service.patch_board(db, user, slug, **body.model_dump(exclude_unset=True))
    except Exception as e:
        db.rollback()
        raise http_error(e)
    return service.board_out(db, user, b)


@router.delete("/{slug}", status_code=204)
def delete_board(slug: str, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        service.delete_board(db, user, slug)
    except Exception as e:
        db.rollback()
        raise http_error(e)
    return Response(status_code=204)


@router.put("/{slug}/grants", response_model=List[GrantOut])
def put_grants(slug: str, body: List[GrantIn], db: Session = Depends(get_db),
               user=Depends(get_current_user)):
    try:
        return service.replace_grants(db, user, slug, body)
    except Exception as e:
        db.rollback()
        raise http_error(e)
```

`backend/main.py`: after `from groups.routes import router as groups_router` add
`from boards.routes import router as boards_router`; after `app.include_router(groups_router)` add
`app.include_router(boards_router)`.

Note on `patch_board` with `default_viewport`: `body.model_dump(exclude_unset=True)` turns the
`ViewportIn` into a dict already, so the service's `isinstance(vp, dict)` branch is the one that runs;
the `model_dump()` fallback covers direct service callers.

- [ ] **Step 4: Run to verify pass**

```bash
"$PY" -m pytest tests/test_boards_routes.py tests/test_boards_access.py tests/test_boards_models.py -q -p no:cacheprovider
```

Expected: `15 passed`.

- [ ] **Step 5: Commit**

```bash
cd /c/tmp/Accu-Mk1-boards
git add backend/boards/schemas.py backend/boards/service.py backend/boards/routes.py backend/main.py backend/tests/test_boards_routes.py
git commit -m "feat(boards): /api/boards CRUD, grants, for-entity

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/boards backend/main.py backend/tests/test_boards_routes.py
```

---

### Task 6: Nodes and edges

**Files:**
- Modify: `backend/boards/schemas.py` (per-kind data models, `KIND_DATA`, `NodeCreate`, `NodePatch`, `PositionItem`, `EdgeCreate`, `EdgePatch`)
- Modify: `backend/boards/service.py` (node/edge functions, `ALLOWED_WIDGETS`, `StaleVersionError`)
- Modify: `backend/boards/routes.py` (seven routes)
- Test: `backend/tests/test_boards_nodes.py`

**Interfaces:**
- Consumes: Task 5 (`get_board`, `open_flag_count`, `board_detail_payload`, `http_error`, `NodeOut`, `EdgeOut`), `boards.access.require_edit`, `flags.seams.{is_registered, resolve_context}`, `models.User`.
- Produces: `boards.service.{validate_node_data, create_node, patch_node, patch_positions, delete_node, create_edge, patch_edge, delete_edge, ALLOWED_WIDGETS, StaleVersionError}`; `boards.schemas.{FRAME_COLORS, FrameData, TextData, NoteData, LinkData, EntityData, PersonData, WidgetData, KIND_DATA, NodeCreate, NodePatch, PositionItem, EdgeCreate, EdgePatch}`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_boards_nodes.py`:

```python
"""Nodes and edges (spec §4.5 to §4.8, §7.3)."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ADMIN = SimpleNamespace(id=1, role="admin", email="admin@x.t", is_active=True)
EDITOR = SimpleNamespace(id=10, role="standard", email="e@x.t", is_active=True)
VIEWER = SimpleNamespace(id=11, role="standard", email="v@x.t", is_active=True)
OUTSIDER = SimpleNamespace(id=12, role="standard", email="o@x.t", is_active=True)


@pytest.fixture
def client(monkeypatch):
    from fastapi.testclient import TestClient
    from main import app
    from auth import get_current_user
    from database import Base, get_db
    import models  # noqa: F401
    import groups.models  # noqa: F401
    import boards.models  # noqa: F401
    import flags.models  # noqa: F401
    from models import User
    from groups.models import UserGroup, UserGroupMember
    from boards.models import Board, BoardGrant
    from boards import service
    from flags import seams

    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    for u in (ADMIN, EDITOR, VIEWER, OUTSIDER):
        s.add(User(id=u.id, email=u.email, hashed_password="x", role=u.role, is_active=True))
    s.add(User(id=13, email="gone@x.t", hashed_password="x", is_active=False))
    editors, viewers = UserGroup(slug="editors", name="Editors"), UserGroup(slug="viewers", name="Viewers")
    org, exec_ = Board(slug="org", name="Org"), Board(slug="exec", name="Exec", visibility="restricted")
    s.add_all([editors, viewers, org, exec_])
    s.flush()
    s.add_all([UserGroupMember(group_id=editors.id, user_id=EDITOR.id),
               UserGroupMember(group_id=viewers.id, user_id=VIEWER.id),
               BoardGrant(board_id=org.id, group_id=editors.id, can_edit=True),
               BoardGrant(board_id=org.id, group_id=viewers.id, can_edit=False),
               BoardGrant(board_id=exec_.id, group_id=editors.id, can_edit=True)])
    s.commit()
    monkeypatch.setattr(service, "RESTRICTED_BOARDS_ENABLED", True)
    seams.register_mk1_entities()  # `worksheet` resolves without any DB rows

    def _db():
        yield s

    saved = {k: app.dependency_overrides.get(k) for k in (get_db, get_current_user)}
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: EDITOR
    tc = TestClient(app)
    tc.db = s
    tc.as_user = lambda u: app.dependency_overrides.__setitem__(get_current_user, lambda: u)
    yield tc
    for k, v in saved.items():
        if v is None:
            app.dependency_overrides.pop(k, None)
        else:
            app.dependency_overrides[k] = v
    s.close()


def _node(client, slug="org", **body):
    body.setdefault("kind", "text")
    body.setdefault("label", body["kind"])
    r = client.post(f"/api/boards/{slug}/nodes", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def test_create_each_kind_with_validation(client):
    f = _node(client, kind="frame", label="Marketing")
    assert f["data"] == {"color": "slate"} and f["version"] == 1
    assert client.post("/api/boards/org/nodes", json={"kind": "frame", "data": {"color": "neon"}}).status_code == 400
    assert _node(client, kind="text", data={"size": "lg"})["data"] == {"size": "lg"}
    assert client.post("/api/boards/org/nodes", json={"kind": "text", "data": {"size": "xl"}}).status_code == 400
    assert _node(client, kind="note", data={"markdown": "# hi"})["data"] == {"markdown": "# hi"}
    assert client.post("/api/boards/org/nodes", json={"kind": "note", "data": {"markdown": "x" * 20001}}).status_code == 400
    link = _node(client, kind="link", label="Kinsta", data={"url": "https://my.kinsta.com/"})
    assert link["data"] == {"url": "https://my.kinsta.com/", "description": None}
    ent = _node(client, kind="entity", label="", entity_type="worksheet", entity_id="1")
    assert ent["label"] == "Worksheet 1"
    assert ent["context"]["label"] == "Worksheet 1" and ent["context"]["entity_type"] == "worksheet"
    assert client.post("/api/boards/org/nodes", json={"kind": "entity", "entity_type": "nope", "entity_id": "1"}).status_code == 400
    assert client.post("/api/boards/org/nodes", json={"kind": "entity", "entity_type": "board_node", "entity_id": "1"}).status_code == 400
    assert client.post("/api/boards/org/nodes", json={"kind": "entity", "entity_type": "worksheet"}).status_code == 400
    assert client.post("/api/boards/org/nodes", json={"kind": "text", "entity_type": "worksheet", "entity_id": "1"}).status_code == 400
    assert _node(client, kind="person", data={"user_id": EDITOR.id})["data"] == {"user_id": EDITOR.id}
    assert client.post("/api/boards/org/nodes", json={"kind": "person", "data": {"user_id": 999}}).status_code == 400
    assert client.post("/api/boards/org/nodes", json={"kind": "person", "data": {"user_id": 13}}).status_code == 400
    assert client.post("/api/boards/org/nodes", json={"kind": "widget", "data": {"key": "sla"}}).status_code == 400
    assert client.post("/api/boards/org/nodes", json={"kind": "sticker"}).status_code == 400
    detail = client.get("/api/boards/org").json()
    assert detail["node_count"] == 6
    ctxs = [n["context"] for n in detail["nodes"] if n["kind"] == "entity"]
    assert ctxs and ctxs[0]["label"] == "Worksheet 1"


def test_edit_rights_on_nodes(client):
    client.as_user(VIEWER)
    assert client.post("/api/boards/org/nodes", json={"kind": "text"}).status_code == 403
    client.as_user(OUTSIDER)
    assert client.post("/api/boards/exec/nodes", json={"kind": "text"}).status_code == 404
    assert client.get("/api/boards/org").status_code == 200


def test_parent_rules(client):
    frame = _node(client, kind="frame")
    inner = _node(client, kind="frame", parent_id=frame["id"])
    text = _node(client, kind="text")
    assert client.post("/api/boards/org/nodes", json={"kind": "text", "parent_id": text["id"]}).status_code == 400
    assert client.post("/api/boards/org/nodes", json={"kind": "text", "parent_id": inner["id"]}).status_code == 400
    assert client.post("/api/boards/org/nodes", json={"kind": "text", "parent_id": 9999}).status_code == 404
    other = _node(client, slug="exec", kind="frame")
    assert client.post("/api/boards/org/nodes", json={"kind": "text", "parent_id": other["id"]}).status_code == 404
    r = client.patch(f"/api/boards/org/nodes/{frame['id']}", json={"parent_id": frame["id"], "version": 1})
    assert r.status_code == 400


def test_patch_version_conflict_and_revalidation(client):
    n = _node(client, kind="frame", label="A")
    r = client.patch(f"/api/boards/org/nodes/{n['id']}", json={"label": "B", "version": 7})
    assert r.status_code == 409
    assert r.json()["detail"]["current"]["version"] == 1 and r.json()["detail"]["current"]["label"] == "A"
    r = client.patch(f"/api/boards/org/nodes/{n['id']}", json={"label": "B", "data": {"color": "teal"}, "version": 1})
    assert r.status_code == 200 and (r.json()["label"], r.json()["version"], r.json()["updated_by"]) == ("B", 2, EDITOR.id)
    assert client.patch(f"/api/boards/org/nodes/{n['id']}", json={"data": {"color": "neon"}, "version": 2}).status_code == 400
    assert client.patch(f"/api/boards/org/nodes/{n['id']}", json={"kind": "text", "version": 2}).status_code == 422
    assert client.patch(f"/api/boards/org/nodes/{n['id']}", json={"label": "C"}).status_code == 422


def test_link_url_scheme_rejected_on_create_and_patch(client):
    """Review Focus 4."""
    for bad in ("javascript:alert(1)", "data:text/html,hi", "ftp://x", "https://", "kinsta.com"):
        assert client.post("/api/boards/org/nodes", json={"kind": "link", "data": {"url": bad}}).status_code == 400, bad
    n = _node(client, kind="link", data={"url": "https://accumarklabs.com"})
    r = client.patch(f"/api/boards/org/nodes/{n['id']}", json={"data": {"url": "javascript:alert(1)"}, "version": 1})
    assert r.status_code == 400
    assert client.get("/api/boards/org").json()["nodes"][0]["data"]["url"] == "https://accumarklabs.com"


def test_positions_bulk_is_all_or_nothing(client):
    """Review Focus 2."""
    a, b = _node(client, x=0, y=0), _node(client, x=0, y=0)
    r = client.patch("/api/boards/org/nodes/positions", json=[
        {"id": a["id"], "x": 10, "y": 10, "version": 1},
        {"id": b["id"], "x": 20, "y": 20, "version": 99}])
    assert r.status_code == 409 and r.json()["detail"]["stale_ids"] == [b["id"]]
    nodes = {n["id"]: n for n in client.get("/api/boards/org").json()["nodes"]}
    assert (nodes[a["id"]]["x"], nodes[b["id"]]["x"]) == (0.0, 0.0)
    r = client.patch("/api/boards/org/nodes/positions", json=[
        {"id": a["id"], "x": 10, "y": 10, "version": 1},
        {"id": b["id"], "x": 20, "y": 20, "version": 1}])
    assert r.status_code == 200
    assert sorted((n["x"], n["version"]) for n in r.json()) == [(10.0, 2), (20.0, 2)]
    assert client.patch("/api/boards/org/nodes/positions", json=[{"id": 9999, "x": 1, "y": 1, "version": 1}]).status_code == 404


def test_positions_can_reparent_into_a_frame(client):
    frame, text = _node(client, kind="frame", x=100, y=50), _node(client, x=130, y=60)
    r = client.patch("/api/boards/org/nodes/positions", json=[
        {"id": text["id"], "x": 30, "y": 10, "parent_id": frame["id"], "version": 1}])
    assert r.status_code == 200 and r.json()[0]["parent_id"] == frame["id"]
    r = client.patch("/api/boards/org/nodes/positions", json=[
        {"id": text["id"], "x": 130, "y": 60, "parent_id": None, "version": 2}])
    assert r.json()[0]["parent_id"] is None


def test_delete_frame_reparents_children_with_absolute_coords(client):
    """Review Focus 3."""
    frame = _node(client, kind="frame", x=100, y=50)
    child = _node(client, kind="text", parent_id=frame["id"], x=10, y=5)
    other = _node(client, kind="text", x=0, y=0)
    e = client.post("/api/boards/org/edges", json={"source_id": frame["id"], "target_id": other["id"]})
    assert e.status_code == 201
    assert client.delete(f"/api/boards/org/nodes/{frame['id']}").status_code == 204
    d = client.get("/api/boards/org").json()
    c = next(n for n in d["nodes"] if n["id"] == child["id"])
    assert (c["parent_id"], c["x"], c["y"]) == (None, 110.0, 55.0)
    assert d["edges"] == []
    assert client.delete(f"/api/boards/org/nodes/{frame['id']}").status_code == 404
    client.as_user(VIEWER)
    assert client.delete(f"/api/boards/org/nodes/{child['id']}").status_code == 403


def test_edges(client):
    a, b = _node(client), _node(client)
    other = _node(client, slug="exec")
    r = client.post("/api/boards/org/edges", json={"source_id": a["id"], "target_id": b["id"], "kind": "reports_to"})
    assert r.status_code == 201 and r.json()["kind"] == "reports_to"
    eid = r.json()["id"]
    assert client.post("/api/boards/org/edges", json={"source_id": a["id"], "target_id": b["id"], "kind": "reports_to"}).status_code == 409
    assert client.post("/api/boards/org/edges", json={"source_id": a["id"], "target_id": a["id"]}).status_code == 400
    assert client.post("/api/boards/org/edges", json={"source_id": a["id"], "target_id": other["id"]}).status_code == 404
    assert client.post("/api/boards/org/edges", json={"source_id": a["id"], "target_id": b["id"], "kind": "teleport"}).status_code == 400
    r = client.patch(f"/api/boards/org/edges/{eid}", json={"kind": "next", "label": "then"})
    assert (r.json()["kind"], r.json()["label"]) == ("next", "then")
    assert client.patch(f"/api/boards/org/edges/{eid}", json={"kind": "teleport"}).status_code == 400
    client.as_user(VIEWER)
    assert client.delete(f"/api/boards/org/edges/{eid}").status_code == 403
    client.as_user(EDITOR)
    assert client.delete(f"/api/boards/org/edges/{eid}").status_code == 204
    assert client.delete(f"/api/boards/org/edges/{eid}").status_code == 404


def test_for_entity_lists_visible_boards_only(client):
    _node(client, slug="org", kind="entity", entity_type="worksheet", entity_id="1")
    _node(client, slug="exec", kind="entity", entity_type="worksheet", entity_id="1")
    client.as_user(OUTSIDER)
    r = client.get("/api/boards/for-entity", params={"entity_type": "worksheet", "entity_id": "1"})
    assert [x["board_slug"] for x in r.json()] == ["org"]
    client.as_user(EDITOR)
    r = client.get("/api/boards/for-entity", params={"entity_type": "worksheet", "entity_id": "1"})
    assert sorted(x["board_slug"] for x in r.json()) == ["exec", "org"]
```

- [ ] **Step 2: Run to verify failure**

```bash
"$PY" -m pytest tests/test_boards_nodes.py -q -p no:cacheprovider
```

Expected: failures with 404/405 (node routes absent).

- [ ] **Step 3: Extend schemas**

Append to `backend/boards/schemas.py` (replace the empty `KIND_DATA = {}` line with the block below):

```python
from urllib.parse import urlsplit

from pydantic import field_validator

FRAME_COLORS = ("slate", "red", "orange", "amber", "green", "teal", "blue", "purple")


class FrameData(BaseModel):
    color: str = "slate"
    model_config = ConfigDict(extra="forbid")

    @field_validator("color")
    @classmethod
    def _color(cls, v: str) -> str:
        if v not in FRAME_COLORS:
            raise ValueError(f"color must be one of {FRAME_COLORS}")
        return v


class TextData(BaseModel):
    size: str = "md"
    model_config = ConfigDict(extra="forbid")

    @field_validator("size")
    @classmethod
    def _size(cls, v: str) -> str:
        if v not in ("sm", "md", "lg"):
            raise ValueError("size must be sm, md or lg")
        return v


class NoteData(BaseModel):
    markdown: str = Field("", max_length=20_000)
    model_config = ConfigDict(extra="forbid")


class LinkData(BaseModel):
    url: str = Field(max_length=2048)
    description: Optional[str] = Field(None, max_length=500)
    model_config = ConfigDict(extra="forbid")

    @field_validator("url")
    @classmethod
    def _url(cls, v: str) -> str:
        v = (v or "").strip()
        parts = urlsplit(v)
        if parts.scheme.lower() not in ("http", "https") or not parts.netloc:
            raise ValueError("url must be http(s):// with a host")
        return v


class EntityData(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PersonData(BaseModel):
    user_id: int
    model_config = ConfigDict(extra="forbid")


class WidgetData(BaseModel):
    key: str = Field(max_length=60)
    model_config = ConfigDict(extra="forbid")


KIND_DATA: Dict[str, type] = {
    "frame": FrameData, "text": TextData, "note": NoteData, "link": LinkData,
    "entity": EntityData, "person": PersonData, "widget": WidgetData,
}


class NodeCreate(BaseModel):
    kind: str
    label: str = Field("", max_length=200)
    parent_id: Optional[int] = None
    x: float = 0.0
    y: float = 0.0
    w: Optional[float] = None
    h: Optional[float] = None
    z: int = 0
    entity_type: Optional[str] = None
    entity_id: Optional[str] = Field(None, max_length=200)
    data: dict = Field(default_factory=dict)
    model_config = ConfigDict(extra="forbid")


class NodePatch(BaseModel):
    """`version` is required (optimistic lock). `kind`, `entity_*` are immutable: a
    different kind is a new node. Unknown fields are 422 (extra='forbid')."""
    version: int
    label: Optional[str] = Field(None, max_length=200)
    parent_id: Optional[int] = None
    x: Optional[float] = None
    y: Optional[float] = None
    w: Optional[float] = None
    h: Optional[float] = None
    z: Optional[int] = None
    data: Optional[dict] = None
    model_config = ConfigDict(extra="forbid")


class PositionItem(BaseModel):
    id: int
    x: float
    y: float
    parent_id: Optional[int] = None  # only applied when present in the request
    version: int
    model_config = ConfigDict(extra="forbid")


class EdgeCreate(BaseModel):
    source_id: int
    target_id: int
    kind: str = "related"
    label: Optional[str] = Field(None, max_length=120)
    model_config = ConfigDict(extra="forbid")


class EdgePatch(BaseModel):
    kind: Optional[str] = None
    label: Optional[str] = Field(None, max_length=120)
    model_config = ConfigDict(extra="forbid")
```

- [ ] **Step 4: Extend the service**

Append to `backend/boards/service.py`:

```python
# --- nodes ------------------------------------------------------------------------
from pydantic import ValidationError  # noqa: E402  (kept next to its only users)

from boards.models import EDGE_KINDS, NODE_KINDS  # noqa: E402
from boards.schemas import KIND_DATA  # noqa: E402

# Widget keys a `widget` node may carry. Empty in slice 1 (spec §4.7); slice 5 fills it.
ALLOWED_WIDGETS: tuple[str, ...] = ()


class StaleVersionError(ConflictError):
    """Optimistic-lock miss. `current` is the row as it is now (single PATCH);
    `stale_ids` lists the losers of a bulk positions PATCH."""
    def __init__(self, msg: str, *, current=None, stale_ids=None) -> None:
        super().__init__(msg)
        self.current = current
        self.stale_ids = stale_ids or []


def validate_node_data(db: Session, *, kind: str, data: Optional[dict], entity_type: Optional[str],
                       entity_id: Optional[str]) -> tuple[dict, Optional[str]]:
    """Returns (clean_data, label_from_registry_or_None). Raises BadRequestError."""
    from flags import seams
    if kind not in NODE_KINDS:
        raise BadRequestError(f"kind must be one of {NODE_KINDS}")
    try:
        clean = KIND_DATA[kind].model_validate(data or {})
    except ValidationError as e:
        raise BadRequestError(f"invalid data for {kind}: {e.errors()[0]['msg']}")
    label = None
    if kind == "entity":
        if not entity_type or not entity_id:
            raise BadRequestError("entity nodes need entity_type and entity_id")
        if entity_type == "board_node":
            raise BadRequestError("a board node cannot point at a board node")
        if not seams.is_registered(entity_type):
            raise BadRequestError(f"unknown entity_type {entity_type!r}")
        ctx = seams.resolve_context(db, entity_type, str(entity_id))
        if ctx is None:
            raise BadRequestError(f"{entity_type} {entity_id!r} not found")
        label = ctx.get("label")
    elif entity_type is not None or entity_id is not None:
        raise BadRequestError(f"{kind} nodes take no entity_type/entity_id")
    if kind == "person":
        from models import User
        u = db.get(User, clean.user_id)
        if u is None or not u.is_active:
            raise BadRequestError(f"unknown or inactive user {clean.user_id}")
    if kind == "widget" and clean.key not in ALLOWED_WIDGETS:
        raise BadRequestError(f"widget {clean.key!r} is not available")
    return clean.model_dump(), label


def _node_on_board(db: Session, board: Board, node_id: int) -> BoardNode:
    n = db.get(BoardNode, int(node_id))
    if n is None or n.board_id != board.id:
        raise NotFoundError(f"node {node_id} not found on board {board.slug!r}")
    return n


def _check_parent(db: Session, board: Board, parent_id: Optional[int], *, self_id: Optional[int] = None) -> None:
    if parent_id is None:
        return
    if self_id is not None and int(parent_id) == int(self_id):
        raise BadRequestError("a node cannot be its own parent")
    parent = _node_on_board(db, board, parent_id)
    if parent.kind != "frame":
        raise BadRequestError("parent must be a frame")
    if parent.parent_id is not None:
        raise BadRequestError("frames nest one level deep")


def _editable(db: Session, user, slug: str) -> Board:
    board = get_board(db, user, slug)
    access.require_edit(db, user, board)
    return board


def _node_out(db: Session, node: BoardNode) -> NodeOut:
    from flags import seams
    out = NodeOut.model_validate(node)
    if node.kind == "entity" and node.entity_type and node.entity_id:
        out.context = seams.resolve_context(db, node.entity_type, node.entity_id)
    return out


def create_node(db: Session, user, slug: str, body) -> NodeOut:
    board = _editable(db, user, slug)
    clean, reg_label = validate_node_data(db, kind=body.kind, data=body.data,
                                          entity_type=body.entity_type, entity_id=body.entity_id)
    _check_parent(db, board, body.parent_id)
    uid = getattr(user, "id", None)
    node = BoardNode(board_id=board.id, kind=body.kind, label=(body.label or reg_label or "")[:200],
                     parent_id=body.parent_id, x=body.x, y=body.y, w=body.w, h=body.h, z=body.z,
                     entity_type=body.entity_type if body.kind == "entity" else None,
                     entity_id=str(body.entity_id) if body.kind == "entity" else None,
                     data=clean, created_by=uid, updated_by=uid)
    db.add(node)
    db.commit()
    db.refresh(node)
    return _node_out(db, node)


def patch_node(db: Session, user, slug: str, node_id: int, *, version: int, **fields) -> NodeOut:
    board = _editable(db, user, slug)
    node = _node_on_board(db, board, node_id)
    if node.version != version:
        raise StaleVersionError("stale version; reload the node", current=node)
    if "data" in fields and fields["data"] is not None:
        clean, _ = validate_node_data(db, kind=node.kind, data=fields["data"],
                                      entity_type=node.entity_type, entity_id=node.entity_id)
        node.data = clean
    if "parent_id" in fields:
        _check_parent(db, board, fields["parent_id"], self_id=node.id)
        node.parent_id = fields["parent_id"]
    for f in ("label", "x", "y", "w", "h", "z"):
        if f in fields and fields[f] is not None:
            setattr(node, f, fields[f])
    node.version += 1
    node.updated_by = getattr(user, "id", None)
    db.commit()
    db.refresh(node)
    return _node_out(db, node)


def patch_positions(db: Session, user, slug: str, items) -> list[NodeOut]:
    """All-or-nothing: one stale version rejects the whole batch (spec §7.3)."""
    board = _editable(db, user, slug)
    nodes = [(_node_on_board(db, board, it.id), it) for it in items]
    stale = [n.id for n, it in nodes if n.version != it.version]
    if stale:
        raise StaleVersionError("stale versions in positions batch", stale_ids=stale)
    uid = getattr(user, "id", None)
    for n, it in nodes:
        if "parent_id" in it.model_fields_set:
            _check_parent(db, board, it.parent_id, self_id=n.id)
            n.parent_id = it.parent_id
        n.x, n.y = it.x, it.y
        n.version += 1
        n.updated_by = uid
    db.commit()
    return [_node_out(db, n) for n, _ in nodes]


def delete_node(db: Session, user, slug: str, node_id: int) -> None:
    board = _editable(db, user, slug)
    node = _node_on_board(db, board, node_id)
    n = open_flag_count(db, [node.id])
    if n:
        raise ConflictError(f"node has {n} open flag(s); resolve them first")
    for child in db.execute(select(BoardNode).where(BoardNode.parent_id == node.id)).scalars():
        child.parent_id = None
        child.x += node.x  # keep the child where it was on the canvas
        child.y += node.y
    db.query(BoardEdge).filter((BoardEdge.source_id == node.id) | (BoardEdge.target_id == node.id)).delete(
        synchronize_session=False)
    db.delete(node)
    db.commit()


# --- edges ------------------------------------------------------------------------

def _edge_on_board(db: Session, board: Board, edge_id: int) -> BoardEdge:
    e = db.get(BoardEdge, int(edge_id))
    if e is None or e.board_id != board.id:
        raise NotFoundError(f"edge {edge_id} not found on board {board.slug!r}")
    return e


def _check_edge_kind(kind: str) -> str:
    if kind not in EDGE_KINDS:
        raise BadRequestError(f"edge kind must be one of {EDGE_KINDS}")
    return kind


def create_edge(db: Session, user, slug: str, body) -> BoardEdge:
    board = _editable(db, user, slug)
    if body.source_id == body.target_id:
        raise BadRequestError("an edge needs two different nodes")
    _node_on_board(db, board, body.source_id)
    _node_on_board(db, board, body.target_id)
    kind = _check_edge_kind(body.kind)
    dup = db.execute(select(BoardEdge.id).where(
        BoardEdge.board_id == board.id, BoardEdge.source_id == body.source_id,
        BoardEdge.target_id == body.target_id, BoardEdge.kind == kind)).scalar_one_or_none()
    if dup is not None:
        raise ConflictError("that edge already exists")
    e = BoardEdge(board_id=board.id, source_id=body.source_id, target_id=body.target_id,
                  kind=kind, label=body.label)
    db.add(e)
    db.commit()
    db.refresh(e)
    return e


def patch_edge(db: Session, user, slug: str, edge_id: int, **fields) -> BoardEdge:
    board = _editable(db, user, slug)
    e = _edge_on_board(db, board, edge_id)
    if fields.get("kind") is not None:
        e.kind = _check_edge_kind(fields["kind"])
    if "label" in fields:
        e.label = fields["label"]
    db.commit()
    db.refresh(e)
    return e


def delete_edge(db: Session, user, slug: str, edge_id: int) -> None:
    board = _editable(db, user, slug)
    db.delete(_edge_on_board(db, board, edge_id))
    db.commit()
```

- [ ] **Step 5: Add the routes**

Append to `backend/boards/routes.py` (add `HTTPException` to the fastapi import, and
`EdgeCreate, EdgePatch, EdgeOut, NodeCreate, NodeOut, NodePatch, PositionItem` to the schemas import):

```python
def _stale(e: "service.StaleVersionError") -> HTTPException:
    detail = {"message": str(e), "stale_ids": e.stale_ids,
              "current": NodeOut.model_validate(e.current).model_dump(mode="json") if e.current is not None else None}
    return HTTPException(status_code=409, detail=detail)


@router.post("/{slug}/nodes", response_model=NodeOut, status_code=201)
def create_node(slug: str, body: NodeCreate, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        return service.create_node(db, user, slug, body)
    except Exception as e:
        db.rollback()
        raise http_error(e)


# Literal /positions ABOVE /{node_id} so it wins the match.
@router.patch("/{slug}/nodes/positions", response_model=List[NodeOut])
def patch_positions(slug: str, body: List[PositionItem], db: Session = Depends(get_db),
                    user=Depends(get_current_user)):
    try:
        return service.patch_positions(db, user, slug, body)
    except service.StaleVersionError as e:
        db.rollback()
        raise _stale(e)
    except Exception as e:
        db.rollback()
        raise http_error(e)


@router.patch("/{slug}/nodes/{node_id}", response_model=NodeOut)
def patch_node(slug: str, node_id: int, body: NodePatch, db: Session = Depends(get_db),
               user=Depends(get_current_user)):
    try:
        fields = body.model_dump(exclude_unset=True)
        version = fields.pop("version")
        return service.patch_node(db, user, slug, node_id, version=version, **fields)
    except service.StaleVersionError as e:
        db.rollback()
        raise _stale(e)
    except Exception as e:
        db.rollback()
        raise http_error(e)


@router.delete("/{slug}/nodes/{node_id}", status_code=204)
def delete_node(slug: str, node_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        service.delete_node(db, user, slug, node_id)
    except Exception as e:
        db.rollback()
        raise http_error(e)
    return Response(status_code=204)


@router.post("/{slug}/edges", response_model=EdgeOut, status_code=201)
def create_edge(slug: str, body: EdgeCreate, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        return service.create_edge(db, user, slug, body)
    except Exception as e:
        db.rollback()
        raise http_error(e)


@router.patch("/{slug}/edges/{edge_id}", response_model=EdgeOut)
def patch_edge(slug: str, edge_id: int, body: EdgePatch, db: Session = Depends(get_db),
               user=Depends(get_current_user)):
    try:
        return service.patch_edge(db, user, slug, edge_id, **body.model_dump(exclude_unset=True))
    except Exception as e:
        db.rollback()
        raise http_error(e)


@router.delete("/{slug}/edges/{edge_id}", status_code=204)
def delete_edge(slug: str, edge_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        service.delete_edge(db, user, slug, edge_id)
    except Exception as e:
        db.rollback()
        raise http_error(e)
    return Response(status_code=204)
```

Ordering matters: `_stale` must be caught before the generic `except Exception` since `StaleVersionError` is a `ConflictError` and `http_error` would flatten it to a string detail.

- [ ] **Step 6: Run to verify pass**

```bash
"$PY" -m pytest tests/test_boards_nodes.py tests/test_boards_routes.py -q -p no:cacheprovider
```

Expected: `16 passed`.

- [ ] **Step 7: Commit**

```bash
cd /c/tmp/Accu-Mk1-boards
git add backend/boards/schemas.py backend/boards/service.py backend/boards/routes.py backend/tests/test_boards_nodes.py
git commit -m "feat(boards): nodes and edges with per-kind validation, versions, positions batch

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/boards backend/tests/test_boards_nodes.py
```

---

### Task 7a: Registry seams for visibility (defined, not yet wired into reads)

**Files:**
- Modify: `backend/flags/seams.py:19-72` (`EntitySpec` fields, `register_entity` kwargs), `backend/flags/seams.py:173-188` (`resolve_entity_search`), plus two new helpers after it
- Modify: `backend/flags/service.py:200-203` (`create_flag` can_raise branch)
- Modify: `backend/flags/schemas.py:100-114` (`EntityContext` two optional fields)
- Modify: `backend/flags/routes.py:379-397` (`entity_search` passes `user`)
- Test: `backend/tests/test_flags_seams_visibility_hooks.py`

**Interfaces:**
- Produces: `EntitySpec.can_raise(db, user, entity_id) -> bool`, `EntitySpec.can_view(db, user, entity_id) -> bool`, `EntitySpec.visible_entity_ids(db, user) -> Select | None`, `EntitySpec.search_scoped(db, user, q) -> list`; `seams.can_view_entity(db, user, entity_type, entity_id) -> bool`; `seams.visibility_clause(db, user) -> ColumnElement`; `seams.resolve_entity_search(db, entity_type, q, user=None)`; `EntityContext.board_slug`, `EntityContext.node_kind`.
- Slice 2 consumes `can_view_entity` and `visibility_clause`; this slice only defines and tests them. `create_flag` and `/entity-search` are the two call sites changed now.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_flags_seams_visibility_hooks.py`:

```python
"""New optional registry seams (spec §6.2, §14): can_raise, can_view, visible_entity_ids,
search_scoped, and the two helpers slice 2 wires into the read paths."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from types import SimpleNamespace

import pytest
from sqlalchemy import String, create_engine, literal, select, union_all
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ADMIN = SimpleNamespace(id=1, role="admin", is_active=True)
ALLOWED = SimpleNamespace(id=7, role="standard", is_active=True)
BLOCKED = SimpleNamespace(id=8, role="standard", is_active=True)


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    from flags import seams, types_service
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    types_service.seed_builtins(s)
    seams.register_mk1_entities()
    saved = dict(seams._REGISTRY)
    try:
        yield s
    finally:
        seams._REGISTRY.clear()
        seams._REGISTRY.update(saved)
        s.close()


def _register_thing(*, raise_in_view=False):
    from flags import seams

    def visible_ids(db, user):
        if getattr(user, "role", None) == "admin":
            return None
        if user.id != ALLOWED.id:
            return select(literal("", String)).where(literal(False))
        return union_all(select(literal("1", String)), select(literal("3", String)))

    def can_view(db, user, eid):
        if raise_in_view:
            raise RuntimeError("boom")
        return getattr(user, "role", None) == "admin" or (user.id == ALLOWED.id and eid in ("1", "3"))

    seams.register_entity(
        "thing",
        label=lambda db, eid: f"Thing {eid}",
        deep_link=lambda eid: "/#dashboard/orders",
        can_flag=lambda user, eid: True,
        can_raise=lambda db, user, eid: user.id == ALLOWED.id,
        can_view=can_view,
        visible_entity_ids=visible_ids,
        context=lambda db, eid: {"label": f"Thing {eid}", "sample_id": None, "analyses": [],
                                 "lot": None, "deep_link": {"kind": "none", "id": eid}},
        search_scoped=lambda db, user, q: [{"entity_id": "1", "label": f"{q} for {user.id}"}],
    )


def test_defaults_keep_legacy_types_visible(db):
    from flags import seams
    assert seams.can_view_entity(db, BLOCKED, "sample", "P-0001") is True
    assert seams.can_view_entity(db, BLOCKED, "not-registered", "x") is True
    spec = seams.get_entity_spec("sample")
    assert spec.can_raise is None and spec.can_view is None
    assert spec.visible_entity_ids is None and spec.search_scoped is None


def test_can_view_entity_uses_the_seam_and_fails_closed(db):
    from flags import seams
    _register_thing()
    assert seams.can_view_entity(db, ALLOWED, "thing", "1") is True
    assert seams.can_view_entity(db, ALLOWED, "thing", "2") is False
    assert seams.can_view_entity(db, BLOCKED, "thing", "1") is False
    assert seams.can_view_entity(db, ADMIN, "thing", "2") is True
    _register_thing(raise_in_view=True)
    assert seams.can_view_entity(db, ADMIN, "thing", "1") is False, "a raising closure hides, never shows"


def test_visibility_clause_filters_only_scoped_types(db):
    from flags import seams
    from flags.models import FlagFlag
    _register_thing()
    rows = [FlagFlag(entity_type=None, entity_id=None, kind="issue", type="task", status="open", title="general"),
            FlagFlag(entity_type="sample", entity_id="P-1", kind="issue", type="task", status="open", title="legacy"),
            FlagFlag(entity_type="thing", entity_id="1", kind="issue", type="task", status="open", title="ok"),
            FlagFlag(entity_type="thing", entity_id="2", kind="issue", type="task", status="open", title="hidden")]
    db.add_all(rows)
    db.commit()
    titles = lambda u: sorted(db.execute(  # noqa: E731
        select(FlagFlag.title).where(seams.visibility_clause(db, u))).scalars().all())
    assert titles(ALLOWED) == ["general", "legacy", "ok"]
    assert titles(BLOCKED) == ["general", "legacy"]
    assert titles(ADMIN) == ["general", "hidden", "legacy", "ok"]


def test_visibility_clause_is_true_when_no_type_scopes(db):
    from flags import seams
    from flags.models import FlagFlag
    db.add(FlagFlag(entity_type="sample", entity_id="P-1", kind="issue", type="task", status="open", title="t"))
    db.commit()
    assert db.execute(select(FlagFlag.id).where(seams.visibility_clause(db, BLOCKED))).scalars().all()


def test_entity_search_prefers_scoped_and_needs_a_user(db):
    from flags import seams
    _register_thing()
    assert seams.resolve_entity_search(db, "thing", "qq", user=ALLOWED) == [{"entity_id": "1", "label": "qq for 7"}]
    assert seams.resolve_entity_search(db, "thing", "qq") == []
    assert seams.resolve_entity_search(db, "worksheet", "zzz-none", user=ALLOWED) == []  # legacy `search` path still works


def test_create_flag_honors_can_raise(db):
    from flags import service
    from flags.errors import BadRequestError, PermissionDeniedError
    from flags import seams
    _register_thing()
    f = service.create_flag(db, user=ALLOWED, entity_type="thing", entity_id="1", type="task", title="ok")
    assert f.entity_type == "thing"
    with pytest.raises(PermissionDeniedError):
        service.create_flag(db, user=BLOCKED, entity_type="thing", entity_id="1", type="task", title="no")

    def redirect(db_, user, eid):
        raise BadRequestError("flag the underlying worksheet '9' instead")
    spec = seams.get_entity_spec("thing")
    seams.register_entity("thing", label=spec.label, deep_link=spec.deep_link, can_flag=spec.can_flag,
                          can_raise=redirect, context=spec.context)
    with pytest.raises(BadRequestError, match="underlying worksheet"):
        service.create_flag(db, user=ALLOWED, entity_type="thing", entity_id="1", type="task", title="x")
    # legacy path untouched: sample has no can_raise, can_flag says yes
    assert service.create_flag(db, user=BLOCKED, entity_type="sample", entity_id="P-1", type="task", title="s").id


def test_entity_context_carries_board_fields():
    from flags.schemas import EntityContext
    c = EntityContext(entity_type="board_node", entity_id="5", label="Org > Marketing",
                      board_slug="org", node_kind="frame")
    assert (c.board_slug, c.node_kind) == ("org", "frame")
    assert EntityContext(entity_type="sample", entity_id="P-1", label="P-1").board_slug is None
```

- [ ] **Step 2: Run to verify failure**

```bash
"$PY" -m pytest tests/test_flags_seams_visibility_hooks.py -q -p no:cacheprovider
```

Expected: `TypeError: register_entity() got an unexpected keyword argument 'can_raise'` and `AttributeError: module 'flags.seams' has no attribute 'can_view_entity'`.

- [ ] **Step 3: Extend `EntitySpec` and `register_entity`**

In `backend/flags/seams.py`, after the `must_exist: bool = False` line inside `EntitySpec` add:

```python
    # --- visibility seams (planning boards, spec 2026-09-26 §6.2, §14) ---------------
    # can_raise(db, user, entity_id): db-aware replacement for can_flag. When set,
    # create_flag consults it INSTEAD of can_flag. May raise BadRequestError to answer 400.
    can_raise: Optional[Callable[[Session, object, str], bool]] = None
    # can_view(db, user, entity_id): point visibility check. Unset = visible to all staff.
    can_view: Optional[Callable[[Session, object, str], bool]] = None
    # visible_entity_ids(db, user): a Select of the entity_ids (as strings) of this type the
    # user may see, or None meaning "all". Lets list queries stay in SQL.
    visible_entity_ids: Optional[Callable[[Session, object], Optional[object]]] = None
    # search_scoped(db, user, q): typeahead that needs the user; preferred over `search`.
    search_scoped: Optional[Callable[[Session, object, str], list]] = None
```

Replace `register_entity`:

```python
def register_entity(entity_type: str, *, label, deep_link, can_flag,
                    context=None, contexts=None, descendants=None, state=None,
                    search=None, snapshot=None, must_exist=False,
                    can_raise=None, can_view=None, visible_entity_ids=None,
                    search_scoped=None) -> None:
    _REGISTRY[entity_type] = EntitySpec(entity_type, label, deep_link, can_flag,
                                        context=context, contexts=contexts,
                                        descendants=descendants,
                                        state=state, search=search,
                                        snapshot=snapshot, must_exist=must_exist,
                                        can_raise=can_raise, can_view=can_view,
                                        visible_entity_ids=visible_entity_ids,
                                        search_scoped=search_scoped)
```

Replace `resolve_entity_search`:

```python
def resolve_entity_search(db: Session, entity_type: str, q: str, user=None) -> list:
    """Typeahead hits for a registered entity type, as
    `[{"entity_id": str, "label": str}, …]`. A type with `search_scoped` is searched with
    the user (no user -> []); otherwise the legacy `search(db, q)` runs. Returns [] for an
    unregistered type, no resolver, or resolver error — never raises into a request."""
    spec = _REGISTRY.get(entity_type)
    if spec is None:
        return []
    try:
        if spec.search_scoped is not None:
            if user is None:
                return []
            rows = spec.search_scoped(db, user, str(q))
        elif spec.search is not None:
            rows = spec.search(db, str(q))
        else:
            return []
    except Exception:  # noqa: BLE001 — search is best-effort decoration
        return []
    return list(rows or [])


def can_view_entity(db: Session, user, entity_type: str, entity_id) -> bool:
    """Point visibility check. Types without `can_view` are visible to all staff. A raising
    closure hides the entity (fail closed), never shows it."""
    spec = _REGISTRY.get(entity_type)
    if spec is None or spec.can_view is None:
        return True
    try:
        return bool(spec.can_view(db, user, str(entity_id)))
    except Exception:  # noqa: BLE001
        return False


def visibility_clause(db: Session, user):
    """SQL predicate over FlagFlag: for every registered type that scopes visibility,
    (entity_type IS NULL) OR (entity_type != T) OR (entity_id IN <visible ids>). Types
    without the seam add nothing; unanchored general tasks always pass. A closure that
    raises hides that whole type (fail closed). Slice 2 adds this to every list query."""
    from sqlalchemy import and_, or_, true
    from flags.models import FlagFlag
    clauses = []
    for spec in list(_REGISTRY.values()):
        if spec.visible_entity_ids is None:
            continue
        not_this_type = or_(FlagFlag.entity_type.is_(None), FlagFlag.entity_type != spec.entity_type)
        try:
            sub = spec.visible_entity_ids(db, user)
        except Exception:  # noqa: BLE001
            clauses.append(not_this_type)
            continue
        if sub is None:
            continue
        clauses.append(or_(not_this_type, FlagFlag.entity_id.in_(sub)))
    return and_(*clauses) if clauses else true()
```

- [ ] **Step 4: `create_flag` prefers `can_raise`**

In `backend/flags/service.py`, replace the two lines

```python
        if not spec.can_flag(user, str(entity_id)):
            raise PermissionDeniedError(f"not allowed to flag {entity_type} {entity_id}")
```

with

```python
        # can_raise (db-aware, planning boards) wins over the legacy can_flag when defined.
        # It may raise BadRequestError itself (e.g. "flag the underlying entity instead").
        allowed = (spec.can_raise(db, user, str(entity_id)) if spec.can_raise is not None
                   else spec.can_flag(user, str(entity_id)))
        if not allowed:
            raise PermissionDeniedError(f"not allowed to flag {entity_type} {entity_id}")
```

- [ ] **Step 5: `EntityContext` fields and the route**

In `backend/flags/schemas.py` `EntityContext`, after `customer_email: Optional[str] = None` add:

```python
    # board_node-only fields (planning boards): unset for every other type's context.
    board_slug: Optional[str] = None
    node_kind: Optional[str] = None
```

In `backend/flags/routes.py` `entity_search`, change the resolver call to
`seams.resolve_entity_search(db, entity_type, query, user=user)`.

- [ ] **Step 6: Run to verify pass, plus the existing flag suites**

```bash
"$PY" -m pytest tests/test_flags_seams_visibility_hooks.py -q -p no:cacheprovider
"$PY" -m pytest tests/test_flags_entity_search.py tests/test_flags_entity_search_mk1.py tests/test_flags_documents.py tests/test_flags_context_batch.py -q -p no:cacheprovider
```

Expected: `7 passed` for the new file; the existing files pass exactly as before (compare with the Task 0 baseline if any of them was already failing).

- [ ] **Step 7: Commit**

```bash
cd /c/tmp/Accu-Mk1-boards
git add backend/flags/seams.py backend/flags/service.py backend/flags/schemas.py backend/flags/routes.py backend/tests/test_flags_seams_visibility_hooks.py
git commit -m "feat(flags): can_raise/can_view/visible_entity_ids/search_scoped seams + visibility helpers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/flags/seams.py backend/flags/service.py backend/flags/schemas.py backend/flags/routes.py backend/tests/test_flags_seams_visibility_hooks.py
```

---

### Task 7b: `board_node` flag entity and deletion rules

**Files:**
- Create: `backend/boards/flag_entity.py`
- Modify: `backend/flags/seams.py` (tail of `register_mk1_entities()` calls `register_board_node()`)
- Test: `backend/tests/test_flags_board_node.py`

**Interfaces:**
- Consumes: Task 7a seams; `boards.access.{can_edit_board, can_view_board, visible_board_ids}`; `boards.models.{Board, BoardNode}`; `boards.service.{delete_node, delete_board, open_flag_count}`; `flags.errors.BadRequestError` (the flags one, so the flags route maps it to 400).
- Produces: `boards.flag_entity.register_board_node()`; registry type `board_node` with `deep_link.kind == "board_node"` and `id == "<slug>:<node_id>"`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_flags_board_node.py`:

```python
"""`board_node` as a flag entity type (spec §6.1, §6.2, §4.8)."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ADMIN = SimpleNamespace(id=1, role="admin", email="a@x.t", is_active=True)
EDITOR = SimpleNamespace(id=10, role="standard", email="e@x.t", is_active=True)
VIEWER = SimpleNamespace(id=11, role="standard", email="v@x.t", is_active=True)
OUTSIDER = SimpleNamespace(id=12, role="standard", email="o@x.t", is_active=True)


@pytest.fixture
def w():
    from database import Base
    import models  # noqa: F401
    import groups.models  # noqa: F401
    import boards.models  # noqa: F401
    import flags.models  # noqa: F401
    from boards.models import Board, BoardGrant, BoardNode
    from groups.models import UserGroup, UserGroupMember
    from flags import seams, types_service
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    types_service.seed_builtins(s)
    seams.register_mk1_entities()
    editors, viewers = UserGroup(slug="editors", name="Editors"), UserGroup(slug="viewers", name="Viewers")
    org = Board(slug="org", name="Org")
    exec_ = Board(slug="exec", name="Exec", visibility="restricted")
    s.add_all([editors, viewers, org, exec_])
    s.flush()
    s.add_all([UserGroupMember(group_id=editors.id, user_id=EDITOR.id),
               UserGroupMember(group_id=viewers.id, user_id=VIEWER.id),
               BoardGrant(board_id=exec_.id, group_id=editors.id, can_edit=True),
               BoardGrant(board_id=exec_.id, group_id=viewers.id, can_edit=False),
               BoardGrant(board_id=org.id, group_id=editors.id, can_edit=True)])
    frame = BoardNode(board_id=exec_.id, kind="frame", label="Marketing", x=100, y=50)
    s.add(frame)
    s.flush()
    text = BoardNode(board_id=exec_.id, kind="text", label="Q4", parent_id=frame.id)
    ent = BoardNode(board_id=exec_.id, kind="entity", label="Worksheet 1", parent_id=frame.id,
                    entity_type="worksheet", entity_id="1")
    pub = BoardNode(board_id=org.id, kind="note", label="Welcome")
    s.add_all([text, ent, pub])
    s.commit()
    return SimpleNamespace(s=s, org=org, exec_=exec_, frame=frame, text=text, ent=ent, pub=pub)


def test_registered_with_must_exist(w):
    from flags import seams
    spec = seams.get_entity_spec("board_node")
    assert spec.must_exist is True
    assert spec.can_raise and spec.can_view and spec.visible_entity_ids and spec.search_scoped


def test_context_label_and_deep_link(w):
    from flags import seams
    ctx = seams.resolve_context(w.s, "board_node", str(w.frame.id))
    assert ctx["label"] == "Exec > Marketing"
    assert ctx["deep_link"] == {"kind": "board_node", "id": f"exec:{w.frame.id}"}
    assert (ctx["board_slug"], ctx["node_kind"]) == ("exec", "frame")
    assert seams.resolve_context(w.s, "board_node", "999") is None
    assert seams.resolve_context(w.s, "board_node", "abc") is None
    assert seams.get_entity_spec("board_node").label(w.s, "999") == "Deleted board item"


def test_contexts_batch_matches_per_id(w):
    from flags import seams
    ids = [str(w.frame.id), str(w.text.id), "999"]
    batch = seams.resolve_contexts(w.s, "board_node", ids)
    assert set(batch) == {str(w.frame.id), str(w.text.id)}
    for eid in batch:
        assert batch[eid]["label"] == seams.resolve_context(w.s, "board_node", eid)["label"]


def test_descendants_of_a_frame_include_entity_children_by_their_own_anchor(w):
    from flags import seams
    pairs = set(seams.resolve_descendants(w.s, "board_node", str(w.frame.id)))
    assert pairs == {("board_node", str(w.text.id)), ("worksheet", "1")}
    assert seams.resolve_descendants(w.s, "board_node", str(w.text.id)) == []


def test_can_raise_is_can_edit_board(w):
    from flags import service
    from flags.errors import PermissionDeniedError
    f = service.create_flag(w.s, user=EDITOR, entity_type="board_node", entity_id=str(w.frame.id),
                            type="task", title="Plan Q4")
    assert f.entity_type == "board_node"
    with pytest.raises(PermissionDeniedError):
        service.create_flag(w.s, user=VIEWER, entity_type="board_node", entity_id=str(w.frame.id),
                            type="task", title="nope")
    with pytest.raises(PermissionDeniedError):
        service.create_flag(w.s, user=OUTSIDER, entity_type="board_node", entity_id=str(w.frame.id),
                            type="task", title="nope")


def test_entity_node_redirects_flags_to_underlying_entity(w):
    """Review Focus 5: a thread about an SOP must never fork onto the board copy."""
    from flags import service
    from flags.errors import BadRequestError
    with pytest.raises(BadRequestError, match="worksheet '1'"):
        service.create_flag(w.s, user=EDITOR, entity_type="board_node", entity_id=str(w.ent.id),
                            type="task", title="x")


def test_snapshot_records_board_and_kind(w):
    from flags import service
    from flags.models import FlagEvent
    f = service.create_flag(w.s, user=EDITOR, entity_type="board_node", entity_id=str(w.frame.id),
                            type="task", title="Plan Q4")
    ev = w.s.execute(select(FlagEvent).where(FlagEvent.flag_id == f.id,
                                             FlagEvent.event_type == "raised")).scalar_one()
    assert ev.details["entity_snapshot"] == {"board": "exec", "kind": "frame"}


def test_can_view_follows_the_board(w):
    from flags import seams
    fid = str(w.frame.id)
    assert seams.can_view_entity(w.s, ADMIN, "board_node", fid) is True
    assert seams.can_view_entity(w.s, EDITOR, "board_node", fid) is True
    assert seams.can_view_entity(w.s, VIEWER, "board_node", fid) is True
    assert seams.can_view_entity(w.s, OUTSIDER, "board_node", fid) is False
    assert seams.can_view_entity(w.s, OUTSIDER, "board_node", str(w.pub.id)) is True
    assert seams.can_view_entity(w.s, OUTSIDER, "board_node", "999") is False, "orphans: admins only"
    assert seams.can_view_entity(w.s, ADMIN, "board_node", "999") is True


def test_visible_entity_ids_and_clause(w):
    from flags import seams
    from flags.models import FlagFlag
    spec = seams.get_entity_spec("board_node")
    assert spec.visible_entity_ids(w.s, ADMIN) is None
    ids = set(w.s.execute(spec.visible_entity_ids(w.s, OUTSIDER)).scalars().all())
    assert ids == {str(w.pub.id)}
    w.s.add_all([FlagFlag(entity_type="board_node", entity_id=str(w.frame.id), kind="issue", type="task",
                          status="open", title="secret"),
                 FlagFlag(entity_type="board_node", entity_id=str(w.pub.id), kind="issue", type="task",
                          status="open", title="public")])
    w.s.commit()
    titles = lambda u: sorted(w.s.execute(  # noqa: E731
        select(FlagFlag.title).where(seams.visibility_clause(w.s, u))).scalars().all())
    assert titles(OUTSIDER) == ["public"] and titles(VIEWER) == ["public", "secret"]


def test_search_is_scoped_and_skips_entity_nodes(w):
    from flags import seams
    hits = lambda u, q: [h["entity_id"] for h in seams.resolve_entity_search(w.s, "board_node", q, user=u)]  # noqa: E731
    assert hits(OUTSIDER, "mar") == []
    assert hits(VIEWER, "mar") == [str(w.frame.id)]
    assert hits(VIEWER, "worksheet") == [], "entity nodes are not board_node anchors"
    assert seams.resolve_entity_search(w.s, "board_node", "mar") == []
    lab = seams.resolve_entity_search(w.s, "board_node", "wel", user=OUTSIDER)[0]["label"]
    assert lab == "Org > Welcome"


def test_delete_rules_follow_open_flags(w):
    from boards import service as boards
    from flags import service as flags
    from flags import seams
    from flags.models import FlagFlag
    from groups.errors import ConflictError
    f = flags.create_flag(w.s, user=EDITOR, entity_type="board_node", entity_id=str(w.text.id),
                          type="task", title="open one")
    with pytest.raises(ConflictError, match="1 open flag"):
        boards.delete_node(w.s, EDITOR, "exec", w.text.id)
    with pytest.raises(ConflictError):
        boards.delete_board(w.s, ADMIN, "exec")
    w.s.execute(FlagFlag.__table__.update().where(FlagFlag.id == f.id).values(status="resolved"))
    w.s.commit()
    boards.delete_node(w.s, EDITOR, "exec", w.text.id)
    assert seams.resolve_context(w.s, "board_node", str(w.text.id)) is None
    assert seams.get_entity_spec("board_node").label(w.s, str(w.text.id)) == "Deleted board item"
    boards.delete_board(w.s, ADMIN, "exec")
    assert w.s.get(type(w.frame), w.frame.id) is None
```

- [ ] **Step 2: Run to verify failure**

```bash
"$PY" -m pytest tests/test_flags_board_node.py -q -p no:cacheprovider
```

Expected: `KeyError`/`NotFoundError` from `get_entity_spec("board_node")` (type not registered).

- [ ] **Step 3: Create the registration module**

`backend/boards/flag_entity.py`:

```python
"""`board_node` as a flag entity (spec 2026-09-26 §6.1, §6.2, §14).

Anchors are board node ids (stringified). A node of kind `entity` is NOT an anchor: flags on
it belong to the underlying entity, so `can_raise` answers 400 pointing there. Visibility
follows the board through boards.access; an orphaned anchor (node deleted) is admin-only.
All host knowledge lives in these closures; flags.service never imports boards."""
from __future__ import annotations

from typing import Optional

from sqlalchemy import String, cast, or_, select
from sqlalchemy.orm import Session

DELETED_LABEL = "Deleted board item"


def _load(db: Session, eid: str):
    from boards.models import Board, BoardNode
    if db is None or not str(eid).isdigit():
        return None, None
    row = db.execute(select(BoardNode, Board).join(Board, Board.id == BoardNode.board_id)
                     .where(BoardNode.id == int(eid))).first()
    return (row[0], row[1]) if row else (None, None)


def _ctx(node, board) -> dict:
    return {"label": f"{board.name} > {node.label}", "sample_id": None, "analyses": [], "lot": None,
            "deep_link": {"kind": "board_node", "id": f"{board.slug}:{node.id}"},
            "board_slug": board.slug, "node_kind": node.kind}


def _label(db, eid) -> str:
    node, board = _load(db, eid)
    return f"{board.name} > {node.label}" if node else DELETED_LABEL


def _context(db, eid) -> Optional[dict]:
    node, board = _load(db, eid)
    return _ctx(node, board) if node else None


def _contexts(db, eids) -> dict:
    from boards.models import Board, BoardNode
    ids = [int(e) for e in eids if str(e).isdigit()]
    if not ids:
        return {}
    rows = db.execute(select(BoardNode, Board).join(Board, Board.id == BoardNode.board_id)
                      .where(BoardNode.id.in_(ids))).all()
    return {str(n.id): _ctx(n, b) for n, b in rows}


def _descendants(db, eid) -> list:
    from boards.models import BoardNode
    node, _ = _load(db, eid)
    if node is None or node.kind != "frame":
        return []
    out = []
    for c in db.execute(select(BoardNode).where(BoardNode.parent_id == node.id)).scalars():
        if c.kind == "entity" and c.entity_type and c.entity_id:
            out.append((c.entity_type, c.entity_id))
        else:
            out.append(("board_node", str(c.id)))
    return out


def _can_raise(db, user, eid) -> bool:
    from boards.access import can_edit_board
    from flags.errors import BadRequestError  # the flags one: flags.routes maps it to 400
    node, board = _load(db, eid)
    if node is None:
        return False
    if node.kind == "entity":
        raise BadRequestError(
            f"flag the underlying {node.entity_type} {node.entity_id!r} instead of the board node")
    return can_edit_board(db, user, board)


def _can_view(db, user, eid) -> bool:
    from boards.access import can_view_board
    from groups.access import is_admin
    node, board = _load(db, eid)
    if node is None:
        return is_admin(user)  # orphaned anchor: fail closed
    return can_view_board(db, user, board)


def _visible_ids(db, user):
    from boards.access import visible_board_ids
    from boards.models import BoardNode
    from groups.access import is_admin
    if is_admin(user):
        return None
    return select(cast(BoardNode.id, String)).where(BoardNode.board_id.in_(visible_board_ids(db, user)))


def _search(db, user, q) -> list:
    from boards.access import visible_board_ids
    from boards.models import Board, BoardNode
    from flags.seams import _ilike_prefix
    pattern = "%" + _ilike_prefix(str(q))
    rows = db.execute(
        select(BoardNode, Board).join(Board, Board.id == BoardNode.board_id)
        .where(BoardNode.kind != "entity",
               BoardNode.board_id.in_(visible_board_ids(db, user)),
               or_(BoardNode.label.ilike(pattern, escape="\\"), Board.name.ilike(pattern, escape="\\")))
        .order_by(Board.name, BoardNode.label).limit(10)).all()
    return [{"entity_id": str(n.id), "label": f"{b.name} > {n.label}"} for n, b in rows]


def _snapshot(db, eid) -> Optional[dict]:
    node, board = _load(db, eid)
    return {"board": board.slug, "kind": node.kind} if node else None


def register_board_node() -> None:
    from flags.seams import register_entity
    register_entity("board_node",
                    label=_label,
                    deep_link=lambda eid: "/#boards/board",
                    can_flag=lambda user, eid: True,   # never consulted: can_raise wins
                    can_raise=_can_raise,
                    can_view=_can_view,
                    visible_entity_ids=_visible_ids,
                    context=_context,
                    contexts=_contexts,
                    descendants=_descendants,
                    search_scoped=_search,
                    snapshot=_snapshot,
                    must_exist=True)
```

Check `_ilike_prefix` in `seams.py:359` escapes `%`/`_` and appends `%`; the leading `"%" +` here makes it a contains-match like `_document_search` does for titles.

- [ ] **Step 4: Register it from `register_mk1_entities()`**

At the very end of `register_mk1_entities()` in `backend/flags/seams.py` (after the `register_entity("document", ...)` call) add:

```python
    # --- planning boards (2026-09-26): closures live in boards.flag_entity -----------
    from boards.flag_entity import register_board_node
    register_board_node()
```

- [ ] **Step 5: Run to verify pass**

```bash
"$PY" -m pytest tests/test_flags_board_node.py tests/test_flags_seams_visibility_hooks.py tests/test_boards_nodes.py -q -p no:cacheprovider
"$PY" -m pytest tests/test_flags_entity_search.py tests/test_flags_entity_search_mk1.py tests/test_flags_documents.py -q -p no:cacheprovider
```

Expected: `28 passed` for the first line; the second line unchanged from baseline.

- [ ] **Step 6: Commit**

```bash
cd /c/tmp/Accu-Mk1-boards
git add backend/boards/flag_entity.py backend/flags/seams.py backend/tests/test_flags_board_node.py
git commit -m "feat(boards): board_node flag entity (can_raise, can_view, scoped search, descendants)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/boards/flag_entity.py backend/flags/seams.py backend/tests/test_flags_board_node.py
```

---

### Task 8: Groups settings pane

**Files:**
- Create: `src/lib/api-groups.ts`, `src/services/groups.ts`, `src/components/preferences/panes/GroupsPane.tsx`
- Modify: `src/components/preferences/panes.tsx` (type union, import, nav item after `flags`, `PANE_COMPONENTS`)
- Modify: `locales/en.json`, `locales/ar.json`, `locales/fr.json` (same keys; ar/fr carry the English strings, matching how `preferences.documents.*` was added)
- Test: `src/components/preferences/panes/__tests__/GroupsPane.test.tsx`

**Interfaces:**
- Consumes: `/api/groups*` (Task 2), `apiFetch` from `@/lib/api`, `getWorksheetUsers` + `WorksheetUser` from `@/lib/api`, `SettingsSection` from `../shared/SettingsComponents`, `useAuthStore`.
- Produces: `api-groups.ts` `{Group, GroupRef, GroupCreate, GroupUpdate, listGroups, listMyGroups, createGroup, updateGroup, deleteGroup, getGroupMembers, replaceGroupMembers}`; `services/groups.ts` `{groupKeys, useGroups, useMyGroups, useCreateGroup, useUpdateGroup, useDeleteGroup, useGroupMembers, useReplaceGroupMembers, useDirectoryUsers}`; pane id `groups` at `#settings/groups`. Slice 3 reuses `useMyGroups` and `useDirectoryUsers`.

- [ ] **Step 1: Write the failing test**

`src/components/preferences/panes/__tests__/GroupsPane.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  role: 'admin' as 'admin' | 'standard',
  groups: [
    { id: 1, slug: 'exec', name: 'Exec', description: null, is_active: true, member_count: 2, created_at: '2026-09-26T00:00:00' },
    { id: 2, slug: 'lab', name: 'Lab', description: 'Bench staff', is_active: false, member_count: 0, created_at: '2026-09-26T00:00:00' },
  ],
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  replace: vi.fn(),
}))

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: { count?: number }) => (o?.count !== undefined ? `${k}:${o.count}` : k) }) }))
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (sel: (s: { user: { role: string } }) => unknown) => sel({ user: { role: h.role } }),
}))
vi.mock('@/services/groups', () => ({
  useGroups: () => ({ data: h.groups, isLoading: false, isError: false }),
  useCreateGroup: () => ({ mutate: h.create, isPending: false }),
  useUpdateGroup: () => ({ mutate: h.update, isPending: false }),
  useDeleteGroup: () => ({ mutate: h.remove, isPending: false }),
  useGroupMembers: () => ({ data: [10], isLoading: false }),
  useReplaceGroupMembers: () => ({ mutate: h.replace, isPending: false }),
  useDirectoryUsers: () => ({ data: [
    { id: 10, email: 'e@x.t', first_name: 'Ed', last_name: 'Itor' },
    { id: 11, email: 'v@x.t', first_name: null, last_name: null },
  ], isLoading: false }),
}))

import { GroupsPane } from '@/components/preferences/panes/GroupsPane'

describe('GroupsPane', () => {
  beforeEach(() => {
    h.role = 'admin'
    h.create.mockReset(); h.update.mockReset(); h.remove.mockReset(); h.replace.mockReset()
  })

  it('lists groups with slug, activity and member count', () => {
    render(<GroupsPane />)
    expect(screen.getByText('exec')).toBeInTheDocument()
    expect(screen.getByText('lab')).toBeInTheDocument()
    expect(screen.getByText('preferences.groups.memberCount:2')).toBeInTheDocument()
    expect(screen.getByText('preferences.groups.inactive')).toBeInTheDocument()
  })

  it('admin can add a group and delete only an empty one', async () => {
    const user = userEvent.setup()
    render(<GroupsPane />)
    await user.type(screen.getByLabelText('preferences.groups.newSlug'), 'front-desk')
    await user.type(screen.getByLabelText('preferences.groups.newName'), 'Front desk')
    await user.click(screen.getByRole('button', { name: /preferences.groups.add/ }))
    expect(h.create).toHaveBeenCalledWith(
      { slug: 'front-desk', name: 'Front desk', description: null },
      expect.anything()
    )
    const deletes = screen.getAllByRole('button', { name: 'preferences.groups.delete' })
    expect(deletes).toHaveLength(1) // only `lab` (0 members) offers Delete
    await user.click(deletes[0])
    expect(h.remove).toHaveBeenCalledWith(2)
  })

  it('admin edits members through the directory checklist', async () => {
    const user = userEvent.setup()
    render(<GroupsPane />)
    await user.click(screen.getAllByRole('button', { name: 'preferences.groups.members' })[0])
    const ed = screen.getByRole('checkbox', { name: /Ed Itor/ })
    const v = screen.getByRole('checkbox', { name: /v@x.t/ })
    expect(ed).toBeChecked()
    expect(v).not.toBeChecked()
    await user.click(v)
    await user.click(screen.getByRole('button', { name: 'preferences.groups.saveMembers' }))
    expect(h.replace).toHaveBeenCalledWith({ id: 1, userIds: [10, 11] })
    expect(screen.getByText('preferences.groups.membersHint')).toBeInTheDocument()
  })

  it('non-admin sees the list read-only', () => {
    h.role = 'standard'
    render(<GroupsPane />)
    expect(screen.getByText('preferences.groups.readOnly')).toBeInTheDocument()
    expect(screen.queryByLabelText('preferences.groups.newSlug')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'preferences.groups.delete' })).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /c/tmp/Accu-Mk1-boards && npx vitest run src/components/preferences/panes/__tests__/GroupsPane.test.tsx
```

Expected: fails to resolve `@/components/preferences/panes/GroupsPane` and `@/services/groups`.

- [ ] **Step 3: API client and hooks**

`src/lib/api-groups.ts`:

```ts
/** User groups API client (spec 2026-09-26 §7.1). Sibling of api-documents.ts. */
import { apiFetch } from '@/lib/api'

export interface Group {
  id: number
  slug: string
  name: string
  description: string | null
  is_active: boolean
  member_count: number
  created_at: string
}

export interface GroupRef {
  id: number
  slug: string
  name: string
}

export interface GroupCreate {
  slug: string
  name: string
  description?: string | null
}

export interface GroupUpdate {
  name?: string
  description?: string | null
  is_active?: boolean
}

export function listGroups(includeInactive = false): Promise<Group[]> {
  return apiFetch<Group[]>(
    `/api/groups${includeInactive ? '?include_inactive=true' : ''}`
  )
}

export function listMyGroups(): Promise<GroupRef[]> {
  return apiFetch<GroupRef[]>('/api/groups/mine')
}

export function createGroup(data: GroupCreate): Promise<Group> {
  return apiFetch<Group>('/api/groups', { method: 'POST', body: JSON.stringify(data) })
}

export function updateGroup(id: number, data: GroupUpdate): Promise<Group> {
  return apiFetch<Group>(`/api/groups/${id}`, { method: 'PUT', body: JSON.stringify(data) })
}

export function deleteGroup(id: number): Promise<void> {
  // apiFetch returns undefined on 204 (same idiom as deleteDocumentCategory).
  return apiFetch<undefined>(`/api/groups/${id}`, { method: 'DELETE' })
}

export async function getGroupMembers(id: number): Promise<number[]> {
  const out = await apiFetch<{ group_id: number; user_ids: number[] }>(`/api/groups/${id}/members`)
  return out.user_ids
}

export async function replaceGroupMembers(id: number, userIds: number[]): Promise<number[]> {
  const out = await apiFetch<{ group_id: number; user_ids: number[] }>(`/api/groups/${id}/members`, {
    method: 'PUT',
    body: JSON.stringify({ user_ids: userIds }),
  })
  return out.user_ids
}
```

`src/services/groups.ts`:

```ts
/** TanStack Query hooks for user groups. Mirrors services/documents.ts. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { getWorksheetUsers } from '@/lib/api'
import {
  createGroup,
  deleteGroup,
  getGroupMembers,
  listGroups,
  listMyGroups,
  replaceGroupMembers,
  updateGroup,
  type GroupCreate,
  type GroupUpdate,
} from '@/lib/api-groups'

export const groupKeys = {
  all: ['groups'] as const,
  list: (includeInactive: boolean) => ['groups', 'list', includeInactive] as const,
  mine: ['groups', 'mine'] as const,
  members: (id: number) => ['groups', 'members', id] as const,
  directory: ['groups', 'directory'] as const,
}

export function useGroups(includeInactive = false) {
  return useQuery({
    queryKey: groupKeys.list(includeInactive),
    queryFn: () => listGroups(includeInactive),
    staleTime: 60_000,
  })
}

export function useMyGroups() {
  return useQuery({ queryKey: groupKeys.mine, queryFn: listMyGroups, staleTime: 60_000 })
}

/** Active users for the members picker; the same directory the worksheets UI uses. */
export function useDirectoryUsers() {
  return useQuery({ queryKey: groupKeys.directory, queryFn: getWorksheetUsers, staleTime: 5 * 60_000 })
}

export function useGroupMembers(id: number | null) {
  return useQuery({
    queryKey: groupKeys.members(id ?? -1),
    queryFn: () => getGroupMembers(id as number),
    enabled: id != null,
  })
}

function invalidateGroups(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: groupKeys.all })
}

export function useCreateGroup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: GroupCreate) => createGroup(data),
    onSuccess: () => { invalidateGroups(qc); toast.success('Group created') },
    onError: (e: Error) => toast.error(/failed: 409/.test(e.message) ? 'That slug is taken' : e.message),
  })
}

export function useUpdateGroup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: GroupUpdate }) => updateGroup(id, data),
    onSuccess: () => { invalidateGroups(qc); toast.success('Group updated') },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDeleteGroup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deleteGroup(id),
    onSuccess: () => { invalidateGroups(qc); toast.success('Group deleted') },
    onError: (e: Error) => {
      if (/failed: 409/.test(e.message)) {
        toast.error('Group still has members or board grants; deactivate it instead')
        return
      }
      toast.error(e.message)
    },
  })
}

export function useReplaceGroupMembers() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, userIds }: { id: number; userIds: number[] }) => replaceGroupMembers(id, userIds),
    onSuccess: (_ids, { id }) => {
      qc.invalidateQueries({ queryKey: groupKeys.members(id) })
      invalidateGroups(qc)
      toast.success('Members saved')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}
```

- [ ] **Step 4: The pane**

`src/components/preferences/panes/GroupsPane.tsx`:

```tsx
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Plus, Users } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SettingsSection } from '../shared/SettingsComponents'
import { useAuthStore } from '@/store/auth-store'
import {
  useCreateGroup,
  useDeleteGroup,
  useDirectoryUsers,
  useGroupMembers,
  useGroups,
  useReplaceGroupMembers,
  useUpdateGroup,
} from '@/services/groups'
import type { Group } from '@/lib/api-groups'
import type { WorksheetUser } from '@/lib/api'

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,59}$/

function userLabel(u: WorksheetUser): string {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ')
  return name ? `${name} (${u.email})` : u.email
}

/** User groups (spec 2026-09-26 §4.1, §8.8). Groups are the unit of access for
 *  boards and, through board nodes, for flags. Read-only for non-admins. */
export function GroupsPane() {
  const { t } = useTranslation()
  const isAdmin = useAuthStore(state => state.user?.role === 'admin')
  const groups = useGroups(isAdmin)

  if (groups.isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (groups.isError || !groups.data) {
    return <p className="text-sm text-destructive">{t('preferences.groups.loadError')}</p>
  }

  return (
    <div className="space-y-8">
      {!isAdmin && (
        <p className="text-sm text-muted-foreground">{t('preferences.groups.readOnly')}</p>
      )}
      <SettingsSection title={t('preferences.groups.sectionTitle')}>
        <p className="text-sm text-muted-foreground">{t('preferences.groups.sectionHint')}</p>
        <div className="divide-y rounded-md border">
          {groups.data.map(g => (
            <GroupRow key={g.id} group={g} readOnly={!isAdmin} />
          ))}
        </div>
        {isAdmin && <NewGroupForm />}
      </SettingsSection>
    </div>
  )
}

function GroupRow({ group, readOnly }: { group: Group; readOnly: boolean }) {
  const { t } = useTranslation()
  const [name, setName] = useState(group.name)
  const [description, setDescription] = useState(group.description ?? '')
  const [membersOpen, setMembersOpen] = useState(false)
  const update = useUpdateGroup()
  const remove = useDeleteGroup()
  const dirty =
    name.trim() !== group.name || (description.trim() || null) !== group.description

  return (
    <div className="px-3 py-2 text-sm">
      <div className="grid grid-cols-[120px_1fr_1fr_auto] items-center gap-3">
        <span className="font-mono text-xs">{group.slug}</span>
        <Input
          value={name}
          onChange={e => setName(e.target.value)}
          disabled={readOnly}
          className="h-8 text-xs"
          aria-label={`${group.slug} name`}
        />
        <Input
          value={description}
          onChange={e => setDescription(e.target.value)}
          disabled={readOnly}
          placeholder={t('preferences.groups.descriptionPlaceholder')}
          className="h-8 text-xs"
          aria-label={`${group.slug} description`}
        />
        <div className="flex items-center gap-2">
          <Badge variant={group.is_active ? 'default' : 'outline'}>
            {group.is_active ? t('preferences.groups.active') : t('preferences.groups.inactive')}
          </Badge>
          <span className="w-20 text-right text-xs text-muted-foreground tabular-nums">
            {t('preferences.groups.memberCount', { count: group.member_count })}
          </span>
          {!readOnly && (
            <>
              <Button size="sm" variant="outline" onClick={() => setMembersOpen(o => !o)}>
                <Users className="mr-1 h-3.5 w-3.5" />
                {t('preferences.groups.members')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!dirty || update.isPending || !name.trim()}
                onClick={() =>
                  update.mutate({
                    id: group.id,
                    data: { name: name.trim(), description: description.trim() || null },
                  })
                }
              >
                {t('preferences.groups.save')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={update.isPending}
                onClick={() => update.mutate({ id: group.id, data: { is_active: !group.is_active } })}
              >
                {group.is_active ? t('preferences.groups.deactivate') : t('preferences.groups.activate')}
              </Button>
              {group.member_count === 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(group.id)}
                >
                  {t('preferences.groups.delete')}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      {membersOpen && !readOnly && <MembersEditor groupId={group.id} />}
    </div>
  )
}

function MembersEditor({ groupId }: { groupId: number }) {
  const { t } = useTranslation()
  const members = useGroupMembers(groupId)
  const directory = useDirectoryUsers()
  const replace = useReplaceGroupMembers()
  const [selected, setSelected] = useState<Set<number> | null>(null)
  const current = selected ?? new Set(members.data ?? [])

  if (members.isLoading || directory.isLoading || !directory.data) {
    return <Loader2 className="mt-2 h-4 w-4 animate-spin text-muted-foreground" />
  }

  const toggle = (id: number) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  return (
    <div className="mt-2 rounded-md border border-dashed p-3">
      <div className="grid gap-1 sm:grid-cols-2">
        {directory.data.map(u => (
          <label key={u.id} className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={current.has(u.id)}
              onChange={() => toggle(u.id)}
              aria-label={userLabel(u)}
            />
            <span>{userLabel(u)}</span>
          </label>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-3">
        <Button
          size="sm"
          disabled={replace.isPending || selected === null}
          onClick={() =>
            replace.mutate(
              { id: groupId, userIds: [...current].sort((a, b) => a - b) },
              { onSuccess: () => setSelected(null) }
            )
          }
        >
          {t('preferences.groups.saveMembers')}
        </Button>
        <span className="text-xs text-muted-foreground">{t('preferences.groups.membersHint')}</span>
      </div>
    </div>
  )
}

function NewGroupForm() {
  const { t } = useTranslation()
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const create = useCreateGroup()
  const valid = SLUG_RE.test(slug.trim()) && name.trim().length > 0

  return (
    <form
      className="grid grid-cols-[120px_1fr_1fr_auto] items-end gap-3 rounded-md border border-dashed px-3 py-3"
      onSubmit={e => {
        e.preventDefault()
        if (!valid || create.isPending) return
        create.mutate(
          { slug: slug.trim(), name: name.trim(), description: description.trim() || null },
          { onSuccess: () => { setSlug(''); setName(''); setDescription('') } }
        )
      }}
    >
      <div className="grid gap-1">
        <Label htmlFor="group-new-slug" className="text-xs">{t('preferences.groups.newSlug')}</Label>
        <Input
          id="group-new-slug"
          value={slug}
          onChange={e => setSlug(e.target.value.toLowerCase())}
          placeholder={t('preferences.groups.newSlugPlaceholder')}
          maxLength={60}
          className="h-8 font-mono text-xs"
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="group-new-name" className="text-xs">{t('preferences.groups.newName')}</Label>
        <Input
          id="group-new-name"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={t('preferences.groups.newNamePlaceholder')}
          className="h-8 text-xs"
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="group-new-desc" className="text-xs">{t('preferences.groups.newDescription')}</Label>
        <Input
          id="group-new-desc"
          value={description}
          onChange={e => setDescription(e.target.value)}
          className="h-8 text-xs"
        />
      </div>
      <Button type="submit" size="sm" disabled={!valid || create.isPending}>
        <Plus className="mr-1 h-4 w-4" />
        {t('preferences.groups.add')}
      </Button>
    </form>
  )
}
```

- [ ] **Step 5: Register the pane and add the strings**

`src/components/preferences/panes.tsx`: add `Users` to the lucide import; add `| 'groups'` to `PreferencePane` after `'flags'`; add `import { GroupsPane } from './panes/GroupsPane'`; add `{ id: 'groups', labelKey: 'preferences.groups', icon: Users },` right after the `flags` entry in `navigationItems`; add `groups: GroupsPane,` to `PANE_COMPONENTS` after `flags`.

`locales/en.json`: insert after the last `"preferences.documents.*"` line (keep the file's flat-key style, one key per line):

```json
  "preferences.groups": "Groups",
  "preferences.groups.loadError": "Could not load user groups.",
  "preferences.groups.readOnly": "Only administrators can change user groups.",
  "preferences.groups.sectionTitle": "User groups",
  "preferences.groups.sectionHint": "Groups decide who can see and edit restricted boards, and who can see the flags raised on them. Admins see everything. Never put a secret on a board.",
  "preferences.groups.active": "Active",
  "preferences.groups.inactive": "Inactive",
  "preferences.groups.memberCount": "{{count}} members",
  "preferences.groups.memberCount_one": "{{count}} member",
  "preferences.groups.memberCount_other": "{{count}} members",
  "preferences.groups.members": "Members",
  "preferences.groups.saveMembers": "Save members",
  "preferences.groups.membersHint": "Stream visibility changes apply when the app reconnects.",
  "preferences.groups.save": "Save",
  "preferences.groups.activate": "Activate",
  "preferences.groups.deactivate": "Deactivate",
  "preferences.groups.delete": "Delete",
  "preferences.groups.descriptionPlaceholder": "Description",
  "preferences.groups.newSlug": "Slug",
  "preferences.groups.newSlugPlaceholder": "front-desk",
  "preferences.groups.newName": "Name",
  "preferences.groups.newNamePlaceholder": "Front desk",
  "preferences.groups.newDescription": "Description",
  "preferences.groups.add": "Add group",
```

Add the same 24 lines, same English text, to `locales/ar.json` and `locales/fr.json` next to their `preferences.documents.*` block (that is how the documents keys were added; translation is a separate pass). Mind the trailing comma of the preceding line in each file.

- [ ] **Step 6: Run to verify pass**

```bash
cd /c/tmp/Accu-Mk1-boards && npx vitest run src/components/preferences/panes/__tests__/GroupsPane.test.tsx src/components/preferences/__tests__/SettingsPage.test.tsx && npm run typecheck && npm run lint
```

Expected: `4 passed` in the new file, SettingsPage tests unchanged, typecheck clean, lint clean (`--max-warnings 0`).

- [ ] **Step 7: Commit**

```bash
cd /c/tmp/Accu-Mk1-boards
git add src/lib/api-groups.ts src/services/groups.ts src/components/preferences/panes/GroupsPane.tsx src/components/preferences/panes/__tests__/GroupsPane.test.tsx src/components/preferences/panes.tsx locales/en.json locales/ar.json locales/fr.json
git commit -m "feat(settings): Groups pane (user groups CRUD + members)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/lib/api-groups.ts src/services/groups.ts src/components/preferences/panes/GroupsPane.tsx src/components/preferences/panes/__tests__/GroupsPane.test.tsx src/components/preferences/panes.tsx locales/en.json locales/ar.json locales/fr.json
```

---

### Task 9: Developer docs, changelog, final gates

**Files:**
- Modify: `docs/developer/flags-add-entity.md` (new section), `CHANGELOG.md` (Unreleased)

- [ ] **Step 1: Document the new seams**

Append to `docs/developer/flags-add-entity.md`:

```markdown

## Visibility seams (2026-09-26, planning boards)

Four more optional closures on `register_entity(...)`. Leave them out and the type behaves
exactly as before: raisable by anyone `can_flag` allows, visible to every staff login.

```python
register_entity(
    "<type>", ...,
    can_raise=lambda db, user, eid: ...,          # db-aware; WINS over can_flag when set;
                                                  # may raise flags.errors.BadRequestError -> 400
    can_view=lambda db, user, eid: ...,           # point check; unset = visible to all staff
    visible_entity_ids=lambda db, user: <Select of str ids> | None,  # None = all
    search_scoped=lambda db, user, q: [...],      # typeahead that needs the user; wins over `search`
)
```

`seams.can_view_entity(db, user, type, id)` and `seams.visibility_clause(db, user)` are the
helpers the flag read paths use (slice 2 of the planning boards work wires them in). A closure
that raises hides, never shows. Unanchored general tasks always pass the clause.

Worked example: `backend/boards/flag_entity.py` registers `board_node`. Its `can_raise` is
"can edit the board", `can_view` is "can view the board", `visible_entity_ids` is a subselect of
node ids on visible boards, and it refuses (400) to anchor a flag on a node of kind `entity`,
pointing the caller at the underlying entity so a thread never forks.
```

- [ ] **Step 2: Changelog**

Under `## Unreleased` in `CHANGELOG.md` add:

```markdown
### Planning boards, slice 1: groups and boards backend
- **User groups.** New `user_groups` / `user_group_members` tables, admin CRUD at `/api/groups`, a Groups pane in Settings (create, rename, deactivate, edit members; delete only when unused). Groups are the unit of access for boards and, through board nodes, for flags.
- **Boards API.** `board_boards`, `board_grants`, `board_nodes`, `board_edges` and `/api/boards` (boards, grants, nodes with per-kind validation and optimistic versions, a positions batch that is all-or-nothing, edges, and a `for-entity` reverse lookup). Company boards are viewable by every active user and editable by granted groups; restricted boards cannot be created yet (`RESTRICTED_BOARDS_ENABLED` is off until the flag visibility slice lands). Boards a user cannot see answer 404 on every route.
- **`board_node` is a flag entity.** Frames, notes, links and text on a board can carry flags; a node of kind `entity` refuses them with a 400 that names the real anchor. Frames roll up their children's flags through `descendants`. Deleting a node or board with open flags is refused (409).
- **Flag registry gains visibility seams** (`can_raise`, `can_view`, `visible_entity_ids`, `search_scoped`) plus `can_view_entity` and `visibility_clause` helpers. `create_flag` consults `can_raise` when a type defines it; `/entity-search` passes the caller so scoped types can filter. No read path is filtered yet. See `docs/developer/flags-add-entity.md`.
```

- [ ] **Step 3: Final gates**

```bash
cd /c/tmp/Accu-Mk1-boards/backend
"$PY" -m pytest tests/test_groups_models.py tests/test_groups_routes.py tests/test_boards_models.py tests/test_boards_access.py tests/test_boards_routes.py tests/test_boards_nodes.py tests/test_flags_seams_visibility_hooks.py tests/test_flags_board_node.py -q -p no:cacheprovider
"$PY" -m pytest tests -q -p no:cacheprovider 2>&1 | grep -E "^(FAILED|ERROR) " | sort > /c/tmp/Accu-Mk1-boards-after-failures.txt
diff /c/tmp/Accu-Mk1-boards-baseline-failures.txt /c/tmp/Accu-Mk1-boards-after-failures.txt && echo "FAILURE SET UNCHANGED"
cd /c/tmp/Accu-Mk1-boards && npm run check:all
```

Expected: all new suites pass; the failure-set diff is empty (the gate is "same failures as master", never "zero failures"); `check:all` exits 0. If `check:all` halts on the three pre-existing ast-grep errors in `hash-navigation.ts`/`read-source.ts` noted in memory, run the remaining steps (`format:check`, `test:run`) individually and record that in the report.

- [ ] **Step 4: Commit**

```bash
cd /c/tmp/Accu-Mk1-boards
git add docs/developer/flags-add-entity.md CHANGELOG.md
git commit -m "docs(boards): visibility seams guide + changelog for slice 1

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- docs/developer/flags-add-entity.md CHANGELOG.md
```

- [ ] **Step 5: Report, do not push**

Report: commits on `feat/planning-boards`, the two failure-set files, and anything skipped. The Handler pushes and opens the PR. Slice 2 (flag visibility enforcement) and slice 3 (canvas) each get their own plan off this branch.

---

## Self-review notes

- Spec coverage: §4.1 to §4.8 (Tasks 1, 3, 5, 6, 7b), §5 (Task 4), §6.1 and §6.2 (Tasks 7a, 7b), §7.1 (Task 2), §7.2 and §7.3 (Tasks 5, 6), §8.8 (Task 8), §11 slice 1 gate `RESTRICTED_BOARDS_ENABLED` (Task 5). §6.3 to §6.5 are slice 2 by design; §8.1 to §8.7 are slice 3.
- Deliberate deviations from the spec, all recorded in spec §14 by Task 0: `can_raise` replaces the db-less `can_flag` for `board_node`; `EntityContext` carries `board_slug`/`node_kind`; per-kind data models instead of a formal discriminated union; explicit cascades in the service.
- Deviation not in §14: `groups.access.user_group_ids` does not cache per request (spec §4.2 said "cached"). Live reads are what Review Focus 1 pins; add caching only with a query-count test showing the need.
- Names used across tasks were checked for drift: `http_error` (Task 2, used by Task 5/6), `open_flag_count` (Task 5, used by 6 and 7b), `StaleVersionError` (Task 6 only), `register_board_node` (7b, called from `seams.register_mk1_entities`), `useDirectoryUsers` (Task 8, mocked in its test).
- Review Focus items 1 to 5 each have a named test: Task 4 `test_visibility_reads_membership_live`, Task 6 `test_positions_bulk_is_all_or_nothing`, `test_delete_frame_reparents_children_with_absolute_coords`, `test_link_url_scheme_rejected_on_create_and_patch`, Task 7b `test_entity_node_redirects_flags_to_underlying_entity`.
