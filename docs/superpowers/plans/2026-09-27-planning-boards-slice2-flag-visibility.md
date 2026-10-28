# Planning Boards Slice 2: Flag Visibility Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every flag read path, every target guard, and the SSE stream honor the anchor entity's visibility, so a flag on a restricted board's node is invisible to anyone outside the board's groups, then turn restricted boards on.

**Architecture:** Slice 1 defined the seams (`can_view`, `visible_entity_ids`, `search_scoped`, `can_raise`) and the helpers (`can_view_entity`, `visibility_clause`) but wired none of them into reads. This slice adds one point-read gate (`service.get_visible_flag`) used by every per-flag service function and route, adds `visibility_clause` to every list query, adds target guards (assignee, watcher, mention) through a new `load_user` seam, stamps a producer-side `audience` on every SSE event through a new `audience` seam so the bus can filter per subscriber without touching the database, and flips `RESTRICTED_BOARDS_ENABLED`. The flags core still never imports boards or groups; all host knowledge stays in `boards/flag_entity.py` and `seams.register_mk1_entities()`.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 + Pydantic v2; pytest with in-memory SQLite and `app.dependency_overrides`; Playwright real-stack E2E against an accumark-stack on the devbox.

**Spec:** `docs/superpowers/specs/2026-09-26-planning-boards-design.md` §6.3 (enforcement table), §6.4 (SSE audience), §6.5 (Slack), §9 (security), §10 (tests), §11 slice 2, §14 (amendments). The spec is the authority; this plan argues from it.

## Global Constraints

- Worktree `C:/tmp/Accu-Mk1-boards`, branch `feat/planning-boards` (slice 1 is on it, PR #256 open). Slice 2 commits stack on top; the PR for slice 2 is opened against `feat/planning-boards` until #256 merges, then retargeted to `master` (retarget BEFORE merging, never rely on auto-retarget).
- Backend tests: `PY=/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe`, run from `C:/tmp/Accu-Mk1-boards/backend`, `"$PY" -m pytest tests/<file>.py -q -p no:cacheprovider`. One pytest process at a time.
- Invisible flag = 404 with the SAME detail text as a missing flag (`flag <id> not found`). Never 403 for visibility.
- A caller that passes no `user` to a list function gets the fail-closed clause (`visibility_clause(db, None)` hides every scoped type). No read path ever widens.
- The flags core (`backend/flags/*`) never imports `boards` or `groups` at module level or inside service/route functions; host knowledge enters only through `seams.register_mk1_entities()` closures and the two existing lazy `from models import User` providers in `seams.py`/`service.py`.
- The SSE wire contract is unchanged: `audience` never reaches a client frame.
- `RESTRICTED_BOARDS_ENABLED` flips to `True` only in Task 7, after Tasks 2 to 6 are green.
- Additive only for every existing flag route: existing tests keep passing byte-for-byte; new kwargs are keyword-only with defaults.
- No em dashes. Pathspec commits with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never push (the controller pushes for the E2E stack and the PR).
- All touched files are LF; keep them LF.

## Review Focus

Inputs the spec implies but no task's tests would otherwise exercise, most likely to bite first. Each has a pinned test in the owning task:

1. An outsider probing `GET /api/flags/{id}` must get a response byte-identical to a nonexistent id: same status, same `detail` text (Task 2: `test_invisible_and_missing_are_indistinguishable`).
2. Membership revoked mid-session: the next list call hides the flag, and a NEW SSE subscription after revocation receives nothing for it; an existing connection is documented to persist until reconnect (Task 6: `test_new_subscription_after_revocation_gets_nothing`).
3. An inactive admin is not an admin for audience purposes: `resolve_membership` returns `is_admin=False` (Task 1: `test_inactive_admin_is_not_admin_for_membership`; closes the slice 1 deferred T4 cell).
4. Unanchored general tasks and legacy anchors stay visible to every staff login even when restricted boards exist (Task 3: `test_general_and_legacy_flags_unaffected`).
5. A flag whose node was deleted (orphan anchor) is visible only to admins in lists, detail, and the stream (Task 3: `test_orphan_anchor_is_admin_only`; Task 6 covers the audience `{"groups": []}` form).

## File structure

Modify:

- `backend/flags/seams.py`: `EntitySpec.audience`, `register_entity(audience=)`, `resolve_audience`, `load_user`, `set_membership_resolver`/`resolve_membership`; `register_mk1_entities()` tail sets the membership resolver from `groups.access`.
- `backend/boards/flag_entity.py`: `_audience` closure, registered.
- `backend/boards/service.py`: `RESTRICTED_BOARDS_ENABLED = True` (Task 7).
- `backend/flags/service.py`: `get_visible_flag`, `_require_target_can_view`, `user=` kwargs on `list_flags`, `list_unread`, `summary`, `list_activity`, `search_flags`, `mark_read`, `get_attachment`; point-read replacement in every per-flag function; `audience` stamped in `_audit` and `_emit_reaction`.
- `backend/flags/routes.py`: every route passes `user`; detail route masks invisible entity links and drops invisible flag links; stream route subscribes with membership and strips `audience` (via a new `_frame(event)` helper); `mark_read`/`get_attachment` pass `user`.
- `backend/flags/bus.py`: `Subscription(group_ids, is_admin, system)`, `subscribe(...)`, `_visible_to(sub, event)`.
- `backend/slack_notify/notifier.py`: `bus.subscribe(None, system=True)`.
- `backend/slack_notify/digest.py`: `compute_stats(..., user=None)` loads the `User` row and passes `user=` to `list_unread`.
- `docs/developer/flags-add-entity.md`, `CHANGELOG.md`, spec §14.
- `e2e/planning-boards-slice1.spec.ts` (restricted assertion becomes 201) and new `e2e/planning-boards-slice2.spec.ts`.

Create tests: `backend/tests/test_flags_audience_membership.py`, `backend/tests/test_flags_visibility_enforcement.py`; extend `tests/test_flags_seams_visibility_hooks.py`, `tests/test_flags_bus.py`, `tests/test_boards_routes.py`.

---

### Task 0: Baseline

- [ ] **Step 1: Capture the failure-set baseline on the slice 1 tip**

From `C:/tmp/Accu-Mk1-boards/backend` (one pytest process, about 3 minutes):

```bash
"$PY" -m pytest tests -q -p no:cacheprovider > /c/tmp/Accu-Mk1-boards-s2-baseline-full.log 2>&1; grep -E "^(FAILED|ERROR) " /c/tmp/Accu-Mk1-boards-s2-baseline-full.log | sed 's/ - .*$//' | sort -u > /c/tmp/Accu-Mk1-boards-s2-baseline-failures.txt; wc -l /c/tmp/Accu-Mk1-boards-s2-baseline-failures.txt
```

Expected: about 160 lines (master's known failures plus per-run UUID noise). Task 10 diffs against it.

---

### Task 1: Audience, membership, and user-loading seams

**Files:**
- Modify: `backend/flags/seams.py` (`EntitySpec`, `register_entity`, three new functions, `register_mk1_entities()` tail)
- Modify: `backend/boards/flag_entity.py` (`_audience`, registration)
- Test: `backend/tests/test_flags_audience_membership.py`

**Interfaces:**
- Produces: `EntitySpec.audience: Optional[Callable[[Session, str], Optional[dict]]]`; `seams.resolve_audience(db, entity_type, entity_id) -> Optional[dict]` (None = everyone, `{"groups": [ids]}` = those groups plus admins; a raising closure or a missing anchor yields `{"groups": []}`); `seams.load_user(db, user_id) -> User | None`; `seams.set_membership_resolver(fn)` and `seams.resolve_membership(db, user) -> tuple[frozenset[int], bool]` (default without a resolver: `(frozenset(), role == "admin" and is_active)`); `boards.flag_entity._audience`.
- Consumed by Tasks 4 (load_user), 6 (resolve_audience, resolve_membership).

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_flags_audience_membership.py`:

```python
"""Audience + membership seams for the SSE stream and the target guards (spec §6.4, §14)."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ADMIN = SimpleNamespace(id=1, role="admin", is_active=True)
INACTIVE_ADMIN = SimpleNamespace(id=2, role="admin", is_active=False)
MEMBER = SimpleNamespace(id=10, role="standard", is_active=True)
OUTSIDER = SimpleNamespace(id=12, role="standard", is_active=True)


@pytest.fixture
def w():
    from database import Base
    import models  # noqa: F401
    import groups.models  # noqa: F401
    import boards.models  # noqa: F401
    import flags.models  # noqa: F401
    from boards.models import Board, BoardGrant, BoardNode
    from groups.models import UserGroup, UserGroupMember
    from models import User
    from flags import seams, types_service
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    for u in (ADMIN, INACTIVE_ADMIN, MEMBER, OUTSIDER):
        s.add(User(id=u.id, email=f"u{u.id}@x.t", hashed_password="x", role=u.role, is_active=u.is_active))
    types_service.seed_builtins(s)
    seams.register_mk1_entities()
    g = UserGroup(slug="exec", name="Exec")
    org = Board(slug="org", name="Org")
    exec_ = Board(slug="exec", name="Exec", visibility="restricted")
    s.add_all([g, org, exec_])
    s.flush()
    s.add_all([UserGroupMember(group_id=g.id, user_id=MEMBER.id),
               BoardGrant(board_id=exec_.id, group_id=g.id, can_edit=True)])
    pub = BoardNode(board_id=org.id, kind="frame", label="Public")
    sec = BoardNode(board_id=exec_.id, kind="frame", label="Secret")
    s.add_all([pub, sec])
    s.commit()
    return SimpleNamespace(s=s, g=g, pub=pub, sec=sec)


def test_audience_follows_the_board(w):
    from flags import seams
    assert seams.resolve_audience(w.s, "board_node", str(w.pub.id)) is None
    assert seams.resolve_audience(w.s, "board_node", str(w.sec.id)) == {"groups": [w.g.id]}
    assert seams.resolve_audience(w.s, "board_node", "999") == {"groups": []}, "orphan: admins only"
    assert seams.resolve_audience(w.s, "sample", "P-1") is None
    assert seams.resolve_audience(w.s, None, None) is None


def test_audience_fails_closed_when_the_closure_raises(w):
    from flags import seams
    spec = seams.get_entity_spec("board_node")

    def boom(db, eid):
        raise RuntimeError("boom")
    seams.register_entity("thing", label=spec.label, deep_link=spec.deep_link, can_flag=spec.can_flag,
                          audience=boom)
    try:
        assert seams.resolve_audience(w.s, "thing", "1") == {"groups": []}
    finally:
        seams._REGISTRY.pop("thing", None)


def test_load_user_returns_the_row_or_none(w):
    from flags import seams
    assert seams.load_user(w.s, MEMBER.id).email == "u10@x.t"
    assert seams.load_user(w.s, 999) is None
    assert seams.load_user(w.s, None) is None


def test_membership_resolver_is_host_registered(w):
    from flags import seams
    gids, adm = seams.resolve_membership(w.s, MEMBER)
    assert gids == frozenset({w.g.id}) and adm is False
    gids, adm = seams.resolve_membership(w.s, OUTSIDER)
    assert gids == frozenset() and adm is False
    gids, adm = seams.resolve_membership(w.s, ADMIN)
    assert adm is True


def test_inactive_admin_is_not_admin_for_membership(w):
    """Review Focus 3 (closes slice 1's deferred T4 cell)."""
    from flags import seams
    _, adm = seams.resolve_membership(w.s, INACTIVE_ADMIN)
    assert adm is False


def test_membership_default_without_resolver():
    from flags import seams
    saved = seams._MEMBERSHIP_RESOLVER
    seams.set_membership_resolver(None)
    try:
        assert seams.resolve_membership(None, ADMIN) == (frozenset(), True)
        assert seams.resolve_membership(None, INACTIVE_ADMIN) == (frozenset(), False)
        assert seams.resolve_membership(None, MEMBER) == (frozenset(), False)
    finally:
        seams.set_membership_resolver(saved)
```

- [ ] **Step 2: Run to verify failure**

```bash
"$PY" -m pytest tests/test_flags_audience_membership.py -q -p no:cacheprovider
```

Expected: `AttributeError: module 'flags.seams' has no attribute 'resolve_audience'` (and `register_entity() got an unexpected keyword argument 'audience'`).

- [ ] **Step 3: Extend `seams.py`**

In `EntitySpec`, after the `search_scoped` field add:

```python
    # audience(db, entity_id) -> Optional[dict]: who may receive LIVE events about flags on
    # this entity. None = every staff login; {"groups": [ids]} = members of those groups plus
    # admins. Stamped by the producer (service._audit) so the bus never touches the db.
    audience: Optional[Callable[[Session, str], Optional[dict]]] = None
```

Add `audience=None` to `register_entity`'s signature and pass `audience=audience` into `EntitySpec(...)`.

After `visibility_clause` add:

```python
def resolve_audience(db: Session, entity_type, entity_id) -> Optional[dict]:
    """Live-event audience for a flag on (entity_type, entity_id). None = everyone.
    Unset seam = everyone (legacy types). A raising closure fails closed: {"groups": []}
    (admins only)."""
    spec = _REGISTRY.get(entity_type) if entity_type else None
    if spec is None or spec.audience is None:
        return None
    try:
        return spec.audience(db, str(entity_id))
    except Exception:  # noqa: BLE001
        return {"groups": []}


def load_user(db: Session, user_id):
    """Default Mk1 provider: id -> User row or None. Same lazy host import as resolve_user;
    the core needs a user OBJECT to ask can_view about a target (assignee, watcher, mention)."""
    if db is None or user_id is None:
        return None
    from models import User
    return db.get(User, int(user_id))


_MEMBERSHIP_RESOLVER = None


def set_membership_resolver(fn) -> None:
    """Host hook: fn(db, user) -> (frozenset[group_id], is_admin). The SSE stream route
    calls resolve_membership once per connection."""
    global _MEMBERSHIP_RESOLVER
    _MEMBERSHIP_RESOLVER = fn


def resolve_membership(db: Session, user) -> tuple[frozenset, bool]:
    active = bool(getattr(user, "is_active", True))
    if _MEMBERSHIP_RESOLVER is None:
        return frozenset(), active and getattr(user, "role", None) == "admin"
    try:
        gids, adm = _MEMBERSHIP_RESOLVER(db, user)
        return frozenset(gids), bool(adm) and active
    except Exception:  # noqa: BLE001
        return frozenset(), False
```

At the end of `register_mk1_entities()` (after `register_board_node()`), add:

```python
    from groups.access import is_admin, user_group_ids
    set_membership_resolver(lambda db, user: (user_group_ids(db, user), is_admin(user)))
```

- [ ] **Step 4: Register the audience closure**

In `backend/boards/flag_entity.py` add after `_snapshot`:

```python
def _audience(db, eid) -> Optional[dict]:
    """Live-event audience: everyone for a company board, the granted groups (plus admins)
    for a restricted board, nobody but admins for an orphaned anchor."""
    from boards.models import BoardGrant
    node, board = _load(db, eid)
    if node is None:
        return {"groups": []}
    if board.visibility == "company":
        return None
    gids = db.execute(select(BoardGrant.group_id).where(BoardGrant.board_id == board.id)
                      .order_by(BoardGrant.group_id)).scalars().all()
    return {"groups": [int(g) for g in gids]}
```

and pass `audience=_audience` in `register_board_node()`.

- [ ] **Step 5: Run to verify pass, plus neighbors**

```bash
"$PY" -m pytest tests/test_flags_audience_membership.py tests/test_flags_board_node.py tests/test_flags_seams_visibility_hooks.py -q -p no:cacheprovider
```

Expected: `25 passed` (6 new + 12 + 7).

- [ ] **Step 6: Commit**

```bash
cd /c/tmp/Accu-Mk1-boards
git add backend/flags/seams.py backend/boards/flag_entity.py backend/tests/test_flags_audience_membership.py
git commit -m "feat(flags): audience, load_user and membership seams for visibility enforcement

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/flags/seams.py backend/boards/flag_entity.py backend/tests/test_flags_audience_membership.py
```

---

### Task 2: Point-read gate on every per-flag path

**Files:**
- Modify: `backend/flags/service.py` (new `get_visible_flag`; `mark_read(user=)`, `get_attachment(user=)`; replace `get_flag(db, flag_id)` in every user-facing function)
- Modify: `backend/flags/routes.py` (detail route, `mark_read`, `get_attachment`)
- Test: `backend/tests/test_flags_visibility_enforcement.py` (created here; Tasks 3 to 5 extend it)

**Interfaces:**
- Produces: `service.get_visible_flag(db, user, flag_id) -> FlagFlag` (raises `NotFoundError(f"flag {flag_id} not found")`, the same text `get_flag` uses, when the caller cannot view the anchor; unanchored flags are always visible); `service.mark_read(db, *, user_id, flag_id, user=None)`; `service.get_attachment(db, attachment_id, *, user=None)`.
- Consumes: `seams.can_view_entity` (slice 1).

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_flags_visibility_enforcement.py`:

```python
"""Flag visibility enforcement (spec §6.3): the anchor decides who may read, write, or be
pulled into a flag. Fixture: one company board, one restricted board granted to `exec`,
users admin / member / outsider, and four flags (general, legacy sample, public node,
secret node)."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ADMIN = SimpleNamespace(id=1, role="admin", email="a@x.t", is_active=True)
MEMBER = SimpleNamespace(id=10, role="standard", email="m@x.t", is_active=True)
OUTSIDER = SimpleNamespace(id=12, role="standard", email="o@x.t", is_active=True)
PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 32


@pytest.fixture
def w(monkeypatch):
    from fastapi.testclient import TestClient
    from main import app
    from auth import get_current_user
    from database import Base, get_db
    import models  # noqa: F401
    import groups.models  # noqa: F401
    import boards.models  # noqa: F401
    import flags.models  # noqa: F401
    from boards.models import Board, BoardGrant, BoardNode
    from groups.models import UserGroup, UserGroupMember
    from models import User
    from flags import seams, service, types_service

    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    for u in (ADMIN, MEMBER, OUTSIDER):
        s.add(User(id=u.id, email=u.email, hashed_password="x", role=u.role, is_active=True))
    types_service.seed_builtins(s)
    seams.register_mk1_entities()
    seams.set_attachment_storage_for_tests(seams.InMemoryAttachmentStorage())
    g = UserGroup(slug="exec", name="Exec")
    org = Board(slug="org", name="Org")
    exec_ = Board(slug="exec", name="Exec", visibility="restricted")
    s.add_all([g, org, exec_])
    s.flush()
    s.add_all([UserGroupMember(group_id=g.id, user_id=MEMBER.id),
               BoardGrant(board_id=exec_.id, group_id=g.id, can_edit=True)])
    pub = BoardNode(board_id=org.id, kind="frame", label="Public")
    sec = BoardNode(board_id=exec_.id, kind="frame", label="Secret")
    s.add_all([pub, sec])
    s.flush()
    child = BoardNode(board_id=exec_.id, kind="text", label="Child", parent_id=sec.id)
    s.add(child)
    s.commit()

    def mk(**kw):
        return service.create_flag(s, user=ADMIN, type="task", **kw)
    f_general = mk(entity_type=None, entity_id=None, title="General task")
    f_sample = mk(entity_type="sample", entity_id="P-1", title="Legacy sample flag")
    f_public = mk(entity_type="board_node", entity_id=str(pub.id), title="Public node flag")
    f_secret = mk(entity_type="board_node", entity_id=str(sec.id), title="Secret node flag")
    f_child = mk(entity_type="board_node", entity_id=str(child.id), title="Secret child flag")

    def _db():
        yield s

    saved = {k: app.dependency_overrides.get(k) for k in (get_db, get_current_user)}
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: OUTSIDER
    tc = TestClient(app)
    tc.as_user = lambda u: app.dependency_overrides.__setitem__(get_current_user, lambda: u)
    yield SimpleNamespace(c=tc, s=s, g=g, org=org, exec_=exec_, pub=pub, sec=sec, child=child,
                          f_general=f_general, f_sample=f_sample, f_public=f_public,
                          f_secret=f_secret, f_child=f_child)
    for k, v in saved.items():
        if v is None:
            app.dependency_overrides.pop(k, None)
        else:
            app.dependency_overrides[k] = v
    s.close()


def test_invisible_and_missing_are_indistinguishable(w):
    """Review Focus 1."""
    w.c.as_user(OUTSIDER)
    hidden = w.c.get(f"/api/flags/{w.f_secret.id}")
    missing = w.c.get("/api/flags/999999")
    assert hidden.status_code == missing.status_code == 404
    assert hidden.json()["detail"] == f"flag {w.f_secret.id} not found"
    assert missing.json()["detail"] == "flag 999999 not found"
    w.c.as_user(MEMBER)
    assert w.c.get(f"/api/flags/{w.f_secret.id}").status_code == 200
    w.c.as_user(ADMIN)
    assert w.c.get(f"/api/flags/{w.f_secret.id}").status_code == 200
    w.c.as_user(OUTSIDER)
    for fid in (w.f_general.id, w.f_sample.id, w.f_public.id):
        assert w.c.get(f"/api/flags/{fid}").status_code == 200


def test_per_flag_writes_are_404_for_outsider(w):
    w.c.as_user(OUTSIDER)
    fid = w.f_secret.id
    assert w.c.post(f"/api/flags/{fid}/comments", json={"body": "hi"}).status_code == 404
    assert w.c.post(f"/api/flags/{fid}/assign", json={"assignee_id": OUTSIDER.id}).status_code == 404
    assert w.c.post(f"/api/flags/{fid}/status", json={"to_status": "in_progress"}).status_code == 404
    assert w.c.put(f"/api/flags/{fid}/due", json={"due_at": "2026-12-01T00:00:00"}).status_code == 404
    assert w.c.post(f"/api/flags/{fid}/watchers", json={"user_id": OUTSIDER.id}).status_code == 404
    assert w.c.delete(f"/api/flags/{fid}/watchers/{OUTSIDER.id}").status_code == 404
    assert w.c.post(f"/api/flags/{fid}/links/entities",
                    json={"entity_type": "sample", "entity_id": "P-1"}).status_code == 404
    assert w.c.post(f"/api/flags/{fid}/links/flags", json={"flag_id": w.f_general.id}).status_code == 404
    assert w.c.post(f"/api/flags/{w.f_general.id}/links/flags", json={"flag_id": fid}).status_code == 404
    assert w.c.post(f"/api/flags/{fid}/read").status_code == 404
    assert w.c.post(f"/api/flags/{fid}/attachments",
                    files={"file": ("a.png", PNG, "image/png")}).status_code == 404
    w.c.as_user(MEMBER)
    assert w.c.post(f"/api/flags/{fid}/comments", json={"body": "hi"}).status_code == 201
    assert w.c.post(f"/api/flags/{fid}/read").status_code == 204


def test_reactions_and_attachments_follow_the_flag(w):
    w.c.as_user(ADMIN)
    cid = w.c.post(f"/api/flags/{w.f_secret.id}/comments", json={"body": "note"}).json()["id"]
    att = w.c.post(f"/api/flags/{w.f_secret.id}/attachments",
                   files={"file": ("a.png", PNG, "image/png")})
    assert att.status_code == 201, att.text
    aid = att.json()["id"]
    w.c.as_user(OUTSIDER)
    assert w.c.put(f"/api/flags/comments/{cid}/reactions/%F0%9F%91%8D").status_code == 404
    assert w.c.get(f"/api/flags/attachments/{aid}").status_code == 404
    w.c.as_user(MEMBER)
    assert w.c.put(f"/api/flags/comments/{cid}/reactions/%F0%9F%91%8D").status_code == 200
    assert w.c.get(f"/api/flags/attachments/{aid}").status_code == 200


def test_flag_link_needs_both_ends_visible(w):
    w.c.as_user(MEMBER)
    assert w.c.post(f"/api/flags/{w.f_public.id}/links/flags",
                    json={"flag_id": w.f_secret.id}).status_code == 201
    w.c.as_user(OUTSIDER)
    assert w.c.post(f"/api/flags/{w.f_general.id}/links/flags",
                    json={"flag_id": w.f_secret.id}).status_code == 404
```

- [ ] **Step 2: Run to verify failure**

```bash
"$PY" -m pytest tests/test_flags_visibility_enforcement.py -q -p no:cacheprovider
```

Expected: the outsider assertions fail with 200/201 (no gate yet).

- [ ] **Step 3: Add the gate and use it everywhere**

In `backend/flags/service.py`, directly after `get_flag`:

```python
def get_visible_flag(db: Session, user, flag_id: int) -> FlagFlag:
    """The point-read gate (spec §6.3). Same NotFoundError text as a missing flag, so a
    caller cannot tell "hidden" from "absent". Unanchored flags are visible to all staff."""
    flag = get_flag(db, flag_id)
    if flag.entity_type is not None and not seams.can_view_entity(
            db, user, flag.entity_type, flag.entity_id):
        raise NotFoundError(f"flag {flag_id} not found")
    return flag
```

Replace `flag = get_flag(db, flag_id)` with `flag = get_visible_flag(db, user, flag_id)` in: `add_comment`, `assign`, `add_watcher`, `remove_watcher`, `add_attachment`, `add_entity_link`, `remove_entity_link`, `add_flag_link` (and its `other = get_flag(db, other_id)` becomes `other = get_visible_flag(db, user, other_id)`), `remove_flag_link` (the `flag` load only; the `other` load stays `get_flag`), `change_status`, `set_due`.

`mark_read`: signature becomes `def mark_read(db, *, user_id, flag_id, user=None)`; its first line becomes `get_visible_flag(db, user, flag_id)  # 404 if missing OR hidden`.

Reactions: in the shared permission check (currently `permissions.can(user, "comment", get_flag(db, comment.flag_id))`) use `get_visible_flag(db, user, comment.flag_id)` for both `add_reaction` and `remove_reaction`.

`get_attachment`: signature becomes `def get_attachment(db, attachment_id, *, user=None)`; after loading the row and before returning, `get_visible_flag(db, user, att.flag_id)`.

- [ ] **Step 4: Routes**

In `backend/flags/routes.py`: the detail route calls `service.get_visible_flag(db, user, flag_id)` instead of `service.get_flag(db, flag_id)`; `mark_read` passes `user=user`; `get_attachment` passes `user=user`. Every other per-flag route already passes `user`.

- [ ] **Step 5: Run to verify pass, plus the flag suites that exercise these functions**

```bash
"$PY" -m pytest tests/test_flags_visibility_enforcement.py -q -p no:cacheprovider
"$PY" -m pytest tests/test_flags_attachments.py tests/test_flags_attachments_service.py tests/test_flags_documents.py tests/test_flags_due_dates.py tests/test_flags_blocked_status.py -q -p no:cacheprovider
```

Expected: `4 passed`; the existing files pass exactly as before.

- [ ] **Step 6: Commit**

```bash
cd /c/tmp/Accu-Mk1-boards
git add backend/flags/service.py backend/flags/routes.py backend/tests/test_flags_visibility_enforcement.py
git commit -m "feat(flags): point-read visibility gate on every per-flag path

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/flags/service.py backend/flags/routes.py backend/tests/test_flags_visibility_enforcement.py
```

---

### Task 3: List queries, digest, and the fail-closed tests

**Files:**
- Modify: `backend/flags/service.py` (`list_flags`, `list_unread`, `summary`, `list_activity`, `search_flags` gain `user=None`)
- Modify: `backend/flags/routes.py` (list, summary, activity, unread, search pass `user=user`)
- Modify: `backend/slack_notify/digest.py` (`compute_stats(..., user=None)`)
- Test: extend `backend/tests/test_flags_visibility_enforcement.py`; extend `backend/tests/test_flags_seams_visibility_hooks.py`

**Interfaces:**
- Produces: `list_flags(..., user=None)`, `list_unread(..., user=None)`, `summary(..., user=None)`, `list_activity(..., user=None)`, `search_flags(..., user=None)`. `user=None` means fail closed (`visibility_clause(db, None)`).

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_flags_visibility_enforcement.py`:

```python
def _titles(c, path):
    r = c.get(path)
    assert r.status_code == 200, r.text
    body = r.json()
    rows = body["items"] if isinstance(body, dict) and "items" in body else body
    return sorted({(x.get("flag") or x)["title"] for x in rows})


def test_all_open_hides_secret_for_outsider(w):
    w.c.as_user(OUTSIDER)
    assert _titles(w.c, "/api/flags?tab=all_open") == [
        "General task", "Legacy sample flag", "Public node flag"]
    w.c.as_user(MEMBER)
    assert "Secret node flag" in _titles(w.c, "/api/flags?tab=all_open")
    w.c.as_user(ADMIN)
    assert "Secret child flag" in _titles(w.c, "/api/flags?tab=all_open")


def test_general_and_legacy_flags_unaffected(w):
    """Review Focus 4."""
    w.c.as_user(OUTSIDER)
    got = _titles(w.c, "/api/flags?tab=all_open")
    assert "General task" in got and "Legacy sample flag" in got


def test_orphan_anchor_is_admin_only(w):
    """Review Focus 5: the node row is gone, the flag remains."""
    w.s.delete(w.child)
    w.s.commit()
    w.c.as_user(MEMBER)
    assert "Secret child flag" not in _titles(w.c, "/api/flags?tab=all_open")
    assert w.c.get(f"/api/flags/{w.f_child.id}").status_code == 404
    w.c.as_user(ADMIN)
    assert "Secret child flag" in _titles(w.c, "/api/flags?tab=all_open")
    assert w.c.get(f"/api/flags/{w.f_child.id}").status_code == 200


def test_unread_summary_activity_search_are_filtered(w):
    from flags.models import FlagParticipant
    # A stale participant row (as if membership was revoked after watching) must not
    # bring the secret flag back through unread/activity.
    w.s.add(FlagParticipant(flag_id=w.f_secret.id, user_id=OUTSIDER.id, role="watcher", added_by=ADMIN.id))
    w.s.commit()
    w.c.as_user(ADMIN)
    assert w.c.post(f"/api/flags/{w.f_secret.id}/comments", json={"body": "Secret update"}).status_code == 201
    w.c.as_user(OUTSIDER)
    assert "Secret node flag" not in _titles(w.c, "/api/flags/unread")
    assert "Secret node flag" not in _titles(w.c, "/api/flags/activity")
    hits = w.c.get("/api/flags/search?q=Secret").json()
    assert hits == []
    w.c.as_user(MEMBER)
    assert [h["flag_id"] for h in w.c.get("/api/flags/search?q=Secret node").json()] == [w.f_secret.id]


def test_summary_counts_only_visible_assigned(w):
    from flags.models import FlagFlag
    # Assigned directly in the DB (a stale assignment after revocation); Task 4 blocks new ones.
    w.s.execute(FlagFlag.__table__.update().where(FlagFlag.id == w.f_secret.id)
                .values(assignee_id=OUTSIDER.id))
    w.s.commit()
    w.c.as_user(OUTSIDER)
    assert w.c.get("/api/flags/summary").json()["assigned_to_me"] == 0
    w.c.as_user(MEMBER)
    w.s.execute(FlagFlag.__table__.update().where(FlagFlag.id == w.f_secret.id)
                .values(assignee_id=MEMBER.id))
    w.s.commit()
    assert w.c.get("/api/flags/summary").json()["assigned_to_me"] == 1


def test_include_descendants_rollup_respects_viewer(w):
    q = f"/api/flags?tab=all_open&entity_type=board_node&entity_id={w.sec.id}&include_descendants=true"
    w.c.as_user(OUTSIDER)
    assert _titles(w.c, q) == []
    w.c.as_user(MEMBER)
    assert _titles(w.c, q) == ["Secret child flag", "Secret node flag"]


def test_list_without_user_fails_closed(w):
    from flags import service
    titles = sorted(f.title for f in service.list_flags(w.s, user_id=ADMIN.id, tab="all_open"))
    assert titles == ["General task", "Legacy sample flag"], "no user = scoped types hidden"


def test_digest_stats_pass_the_user(w):
    from datetime import datetime, timezone
    from flags.models import FlagParticipant
    from slack_notify.digest import compute_stats
    w.s.add(FlagParticipant(flag_id=w.f_secret.id, user_id=OUTSIDER.id, role="watcher", added_by=ADMIN.id))
    w.s.commit()
    w.c.as_user(ADMIN)
    w.c.post(f"/api/flags/{w.f_secret.id}/comments", json={"body": "ping"})
    stats = compute_stats(w.s, OUTSIDER.id, now=datetime.now(timezone.utc))
    assert stats["unread"] == 0
    stats = compute_stats(w.s, MEMBER.id, now=datetime.now(timezone.utc))
    assert stats["unread"] >= 0  # member path loads the User row and applies the clause without error
```

Append to `backend/tests/test_flags_seams_visibility_hooks.py` (closes slice 1's deferred T7a minor):

```python
def test_visibility_clause_hides_a_type_whose_closure_raises(db):
    from flags import seams
    from flags.models import FlagFlag
    _register_thing()
    spec = seams.get_entity_spec("thing")

    def boom(db_, user):
        raise RuntimeError("boom")
    seams.register_entity("thing", label=spec.label, deep_link=spec.deep_link, can_flag=spec.can_flag,
                          context=spec.context, visible_entity_ids=boom)
    db.add_all([FlagFlag(entity_type=None, entity_id=None, kind="issue", type="task", status="open",
                         title="general", created_by=1),
                FlagFlag(entity_type="thing", entity_id="1", kind="issue", type="task", status="open",
                         title="hidden", created_by=1)])
    db.commit()
    titles = sorted(db.execute(select(FlagFlag.title).where(seams.visibility_clause(db, ADMIN))).scalars().all())
    assert titles == ["general"], "a raising closure hides its whole type, even for admins"
```

- [ ] **Step 2: Run to verify failure**

```bash
"$PY" -m pytest tests/test_flags_visibility_enforcement.py tests/test_flags_seams_visibility_hooks.py -q -p no:cacheprovider
```

Expected: the new list tests fail (secret titles present); the raising-closure test fails only if the clause is wrong (it should already pass; keep it as the pin).

- [ ] **Step 3: Service changes**

In `backend/flags/service.py`:

`list_flags`: add `user=None` as the last keyword parameter; change the first statement to
`stmt = select(FlagFlag).where(seams.visibility_clause(db, user)).order_by(FlagFlag.updated_at.desc())`.

`list_unread(db, *, user_id, user=None)`: add `.where(seams.visibility_clause(db, user))` to its select.

`summary(db, *, user_id, user=None)`: add `.where(seams.visibility_clause(db, user))` to the `assigned` select.

`list_activity(db, *, user_id, cursor=None, limit=25, user=None)`: after building `stmt`, add
`stmt = stmt.where(FlagEvent.flag_id.in_(select(FlagFlag.id).where(seams.visibility_clause(db, user))))`.

`search_flags(db, *, q, limit=50, user=None)`: define `visible = select(FlagFlag.id).where(seams.visibility_clause(db, user))` before the comment query; add `.where(FlagComment.flag_id.in_(visible))` to the comment query and `.where(seams.visibility_clause(db, user))` to the title query.

- [ ] **Step 4: Routes and digest**

`backend/flags/routes.py`: `list_flags`, `summary`, `activity`, `unread`, `search` pass `user=user` to their service calls.

`backend/slack_notify/digest.py` `compute_stats(db, user_id, *, now, user=None)`: at the top,

```python
    if user is None:
        from models import User
        user = db.get(User, user_id)
```

and call `service.list_unread(db, user_id=user_id, user=user)`.

- [ ] **Step 5: Run to verify pass, plus the flag list suites**

```bash
"$PY" -m pytest tests/test_flags_visibility_enforcement.py tests/test_flags_seams_visibility_hooks.py -q -p no:cacheprovider
"$PY" -m pytest tests/test_flags_activity.py tests/test_flags_activity_relevance.py tests/test_flags_context_batch.py tests/test_flags_entity_search.py tests/test_flags_documents.py tests/test_slack_digest.py -q -p no:cacheprovider
```

Expected: `12 passed` and `8 passed` respectively for the two new/extended files (4 + 8 in enforcement, 7 + 1 in hooks); the existing files, including `test_slack_digest.py`, unchanged.

- [ ] **Step 6: Commit**

```bash
cd /c/tmp/Accu-Mk1-boards
git add backend/flags/service.py backend/flags/routes.py backend/slack_notify/digest.py backend/tests/test_flags_visibility_enforcement.py backend/tests/test_flags_seams_visibility_hooks.py
git commit -m "feat(flags): visibility clause on every list query, digest passes the user

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/flags/service.py backend/flags/routes.py backend/slack_notify/digest.py backend/tests/test_flags_visibility_enforcement.py backend/tests/test_flags_seams_visibility_hooks.py
```

---

### Task 4: Target guards (assignee, watcher, mention)

**Files:**
- Modify: `backend/flags/service.py` (`_require_target_can_view`; `create_flag`, `assign`, `add_watcher`, `add_comment`)
- Test: extend `backend/tests/test_flags_visibility_enforcement.py`

**Interfaces:**
- Produces: `service._require_target_can_view(db, entity_type, entity_id, target_user_id, what) -> None` raising `BadRequestError(f"user {id} cannot see this flag; {what} refused")`.
- Consumes: `seams.load_user`, `seams.can_view_entity`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_flags_visibility_enforcement.py`:

```python
def test_outsider_cannot_be_pulled_into_a_secret_flag(w):
    fid = w.f_secret.id
    w.c.as_user(ADMIN)
    r = w.c.post("/api/flags", json={"entity_type": "board_node", "entity_id": str(w.sec.id),
                                     "type": "task", "title": "x", "assignee_id": OUTSIDER.id})
    assert r.status_code == 400 and "cannot see" in r.json()["detail"]
    assert w.c.post(f"/api/flags/{fid}/assign", json={"assignee_id": OUTSIDER.id}).status_code == 400
    assert w.c.post(f"/api/flags/{fid}/watchers", json={"user_id": OUTSIDER.id}).status_code == 400
    r = w.c.post(f"/api/flags/{fid}/comments", json={"body": "hey", "mention_ids": [OUTSIDER.id]})
    assert r.status_code == 400
    # MEMBER is fine on every path
    assert w.c.post(f"/api/flags/{fid}/assign", json={"assignee_id": MEMBER.id}).status_code == 200
    assert w.c.post(f"/api/flags/{fid}/watchers", json={"user_id": MEMBER.id}).status_code == 201
    r = w.c.post(f"/api/flags/{fid}/comments", json={"body": "hey", "mention_ids": [MEMBER.id]})
    assert r.status_code == 201
    r = w.c.post("/api/flags", json={"entity_type": "board_node", "entity_id": str(w.sec.id),
                                     "type": "task", "title": "y", "assignee_id": MEMBER.id})
    assert r.status_code == 201


def test_legacy_and_general_flags_take_any_assignee(w):
    w.c.as_user(ADMIN)
    assert w.c.post(f"/api/flags/{w.f_sample.id}/assign", json={"assignee_id": OUTSIDER.id}).status_code == 200
    assert w.c.post(f"/api/flags/{w.f_general.id}/assign", json={"assignee_id": OUTSIDER.id}).status_code == 200
    assert w.c.post(f"/api/flags/{w.f_public.id}/watchers", json={"user_id": OUTSIDER.id}).status_code == 201


def test_unknown_target_user_is_400_on_a_scoped_flag(w):
    w.c.as_user(ADMIN)
    assert w.c.post(f"/api/flags/{w.f_secret.id}/assign", json={"assignee_id": 999}).status_code == 400
```

Check the comment request field name for mentions in `backend/flags/schemas.py` (`CommentRequest`); if it is not `mention_ids`, use the real name in the test.

- [ ] **Step 2: Run to verify failure**

```bash
"$PY" -m pytest tests/test_flags_visibility_enforcement.py -q -p no:cacheprovider
```

Expected: the three new tests fail (200/201 where 400 is expected).

- [ ] **Step 3: Implement**

In `backend/flags/service.py`, after `get_visible_flag`:

```python
def _require_target_can_view(db: Session, entity_type, entity_id, target_user_id, what: str) -> None:
    """Target guard (spec §6.3): never pull a user into a flag they cannot see. Unanchored
    flags and legacy anchors have no visibility scope, so they take any user."""
    if entity_type is None or target_user_id is None:
        return
    target = seams.load_user(db, target_user_id)
    if target is None or not seams.can_view_entity(db, target, entity_type, str(entity_id)):
        raise BadRequestError(f"user {target_user_id} cannot see this flag; {what} refused")
```

- `create_flag`: inside the existing `if entity_type is not None and not is_virtual_kind:` block, after the `must_exist` check, add `_require_target_can_view(db, entity_type, entity_id, assignee_id, "assignment")`.
- `assign`: after `flag = get_visible_flag(...)` and the permission check, add `_require_target_can_view(db, flag.entity_type, flag.entity_id, assignee_id, "assignment")` (the helper returns immediately for `None`).
- `add_watcher`: same, with `user_id` and `"watching"`.
- `add_comment`: after `valid = _valid_user_ids(...)`, `for uid in valid: _require_target_can_view(db, flag.entity_type, flag.entity_id, uid, "mention")`.

- [ ] **Step 4: Run to verify pass**

```bash
"$PY" -m pytest tests/test_flags_visibility_enforcement.py tests/test_flags_activity_relevance.py tests/test_flags_documents.py -q -p no:cacheprovider
```

Expected: `15 passed` in the enforcement file; the others unchanged.

- [ ] **Step 5: Commit**

```bash
cd /c/tmp/Accu-Mk1-boards
git add backend/flags/service.py backend/tests/test_flags_visibility_enforcement.py
git commit -m "feat(flags): target guards for assignee, watcher and mention on scoped flags

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/flags/service.py backend/tests/test_flags_visibility_enforcement.py
```

---

### Task 5: Detail route masks invisible links

**Files:**
- Modify: `backend/flags/routes.py` (detail route entity links and flag links)
- Modify: `backend/flags/service.py` (`add_entity_link` refuses an invisible target)
- Test: extend `backend/tests/test_flags_visibility_enforcement.py`

**Interfaces:**
- An entity link whose target the caller cannot view serializes with `entity_id: ""` and `entity: {label: "Restricted", deep_link: {kind: "none", id: ""}}`; a flag link whose other flag is invisible is omitted from `flag_links`. `add_entity_link` raises `NotFoundError(f"{entity_type} {entity_id!r} not found")` when the caller cannot view the target.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_flags_visibility_enforcement.py`:

```python
def test_detail_masks_invisible_entity_links_and_drops_invisible_flag_links(w):
    w.c.as_user(MEMBER)
    fid = w.f_public.id
    assert w.c.post(f"/api/flags/{fid}/links/entities",
                    json={"entity_type": "board_node", "entity_id": str(w.sec.id)}).status_code == 201
    assert w.c.post(f"/api/flags/{fid}/links/flags", json={"flag_id": w.f_secret.id}).status_code == 201
    w.c.as_user(OUTSIDER)
    d = w.c.get(f"/api/flags/{fid}").json()
    link = d["entity_links"][0]
    assert link["entity_type"] == "board_node" and link["entity_id"] == ""
    assert link["entity"]["label"] == "Restricted"
    assert d["flag_links"] == []
    w.c.as_user(MEMBER)
    d = w.c.get(f"/api/flags/{fid}").json()
    assert d["entity_links"][0]["entity"]["label"] == "Exec > Secret"
    assert [l["flag_id"] for l in d["flag_links"]] == [w.f_secret.id]


def test_outsider_cannot_link_a_public_flag_to_a_secret_node(w):
    w.c.as_user(OUTSIDER)
    r = w.c.post(f"/api/flags/{w.f_public.id}/links/entities",
                 json={"entity_type": "board_node", "entity_id": str(w.sec.id)})
    assert r.status_code == 404
```

- [ ] **Step 2: Run to verify failure**

Expected: the outsider sees the real label / the secret flag link; the link create returns 201.

- [ ] **Step 3: Implement**

In `backend/flags/routes.py` `get_flag` (detail), replace the entity-link loop body with:

```python
        for link in service.list_entity_links(db, flag_id):
            out = EntityLinkOut.model_validate(link)
            if seams.can_view_entity(db, user, link.entity_type, link.entity_id):
                ctx = seams.resolve_context(db, link.entity_type, link.entity_id)
                out.entity = EntityContext(**ctx) if ctx else None
            else:
                # Spec §6.3: never confirm what a hidden anchor is. Keep the type (the
                # card needs an icon) and blank the rest.
                out.entity_id = ""
                out.entity = EntityContext(entity_type=link.entity_type, entity_id="",
                                           label="Restricted",
                                           deep_link={"kind": "none", "id": ""})
            resp.entity_links.append(out)
```

and the flag-link loop with:

```python
        for link in service.list_flag_links(db, flag_id):
            oid = link.linked_flag_id if link.flag_id == flag_id else link.flag_id
            try:
                o = service.get_visible_flag(db, user, oid)
            except NotFoundError:
                continue  # the other end is hidden from this caller
            resp.flag_links.append(FlagLinkOut(
                id=link.id, flag_id=o.id, title=o.title, status=o.status, type=o.type))
```

(`NotFoundError` is already imported in routes.py from `flags.errors`; confirm.) If `EntityLinkOut.entity_id` is typed `str`, the empty string is valid; if it is `int`, use the field's zero value and note it in the report.

In `backend/flags/service.py` `add_entity_link`, after loading the flag and validating the type, add:

```python
    if not seams.can_view_entity(db, user, entity_type, str(entity_id)):
        raise NotFoundError(f"{entity_type} {entity_id!r} not found")
```

- [ ] **Step 4: Run to verify pass**

```bash
"$PY" -m pytest tests/test_flags_visibility_enforcement.py tests/test_flags_links.py -q -p no:cacheprovider
```

Expected: `17 passed` in the enforcement file; `test_flags_links.py` unchanged.

- [ ] **Step 5: Commit**

```bash
cd /c/tmp/Accu-Mk1-boards
git add backend/flags/routes.py backend/flags/service.py backend/tests/test_flags_visibility_enforcement.py
git commit -m "feat(flags): mask invisible entity links, drop invisible flag links, gate link targets

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/flags/routes.py backend/flags/service.py backend/tests/test_flags_visibility_enforcement.py
```

---

### Task 6: SSE audience

**Files:**
- Modify: `backend/flags/service.py` (`_audit` and `_emit_reaction` stamp `audience`)
- Modify: `backend/flags/bus.py` (`Subscription`, `subscribe`, `_visible_to`)
- Modify: `backend/flags/routes.py` (`stream` subscribes with membership; `_frame` helper strips `audience`)
- Modify: `backend/slack_notify/notifier.py` (`bus.subscribe(None, system=True)`)
- Test: extend `backend/tests/test_flags_bus.py`; extend `backend/tests/test_flags_visibility_enforcement.py`

**Interfaces:**
- `Subscription(bus, user_id, *, group_ids=frozenset(), is_admin=False, system=False)`; `FlagEventBus.subscribe(user_id, *, group_ids=frozenset(), is_admin=False, system=False)`; `FlagEventBus._visible_to(sub, event) -> bool`; `routes._frame(event) -> str`. Events carry `audience: None | {"groups": [ids]}` internally only.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_flags_bus.py`:

```python
def _run(coro):
    return asyncio.run(coro)


def test_audience_none_reaches_everyone():
    async def scenario():
        bus = FlagEventBus()
        bus.set_loop(asyncio.get_running_loop())
        subs = [bus.subscribe(1, group_ids=frozenset(), is_admin=False),
                bus.subscribe(2, group_ids=frozenset({5}), is_admin=False),
                bus.subscribe(3, is_admin=True), bus.subscribe(None, system=True)]
        bus.publish({"event_type": "raised", "flag_id": 1, "audience": None})
        for s in subs:
            assert (await asyncio.wait_for(s.get(), timeout=1.0))["flag_id"] == 1
            s.close()
    _run(scenario())


def test_audience_groups_reach_members_admins_and_system_only():
    async def scenario():
        bus = FlagEventBus()
        bus.set_loop(asyncio.get_running_loop())
        outsider = bus.subscribe(1, group_ids=frozenset({9}))
        member = bus.subscribe(2, group_ids=frozenset({5, 9}))
        admin = bus.subscribe(3, is_admin=True)
        system = bus.subscribe(None, system=True)
        bus.publish({"event_type": "raised", "flag_id": 7, "audience": {"groups": [5]}})
        for s in (member, admin, system):
            assert (await asyncio.wait_for(s.get(), timeout=1.0))["flag_id"] == 7
        with pytest_raises_timeout():
            await asyncio.wait_for(outsider.get(), timeout=0.2)
        for s in (outsider, member, admin, system):
            s.close()
    _run(scenario())


def test_orphan_audience_is_admin_and_system_only():
    async def scenario():
        bus = FlagEventBus()
        bus.set_loop(asyncio.get_running_loop())
        member = bus.subscribe(2, group_ids=frozenset({5}))
        admin = bus.subscribe(3, is_admin=True)
        bus.publish({"event_type": "commented", "flag_id": 8, "audience": {"groups": []}})
        assert (await asyncio.wait_for(admin.get(), timeout=1.0))["flag_id"] == 8
        with pytest_raises_timeout():
            await asyncio.wait_for(member.get(), timeout=0.2)
        member.close(); admin.close()
    _run(scenario())


def test_new_subscription_after_revocation_gets_nothing():
    """Review Focus 2: a subscription opened after the user left the group carries no
    group ids, so it receives nothing for that board; an older connection persists until
    reconnect (documented)."""
    async def scenario():
        bus = FlagEventBus()
        bus.set_loop(asyncio.get_running_loop())
        before = bus.subscribe(2, group_ids=frozenset({5}))
        after = bus.subscribe(2, group_ids=frozenset())
        bus.publish({"event_type": "raised", "flag_id": 9, "audience": {"groups": [5]}})
        assert (await asyncio.wait_for(before.get(), timeout=1.0))["flag_id"] == 9
        with pytest_raises_timeout():
            await asyncio.wait_for(after.get(), timeout=0.2)
        before.close(); after.close()
    _run(scenario())


def test_legacy_subscribe_signature_still_works():
    async def scenario():
        bus = FlagEventBus()
        bus.set_loop(asyncio.get_running_loop())
        sub = bus.subscribe(user_id=7)
        bus.publish({"event_type": "raised", "flag_id": 1})  # no audience key at all
        assert (await asyncio.wait_for(sub.get(), timeout=1.0))["flag_id"] == 1
        sub.close()
    _run(scenario())
```

Append to `backend/tests/test_flags_visibility_enforcement.py`:

```python
class _Collect:
    def __init__(self):
        self.events = []

    def emit(self, event):
        self.events.append(event)


def test_producer_stamps_audience_and_frame_strips_it(w):
    from flags import seams, service
    from flags.routes import _frame
    sink, saved = _Collect(), seams.EVENT_SINK
    seams.set_event_sink(sink)
    try:
        service.create_flag(w.s, user=ADMIN, entity_type="board_node", entity_id=str(w.sec.id),
                            type="task", title="secret live")
        service.create_flag(w.s, user=ADMIN, entity_type="board_node", entity_id=str(w.pub.id),
                            type="task", title="public live")
        service.create_flag(w.s, user=ADMIN, entity_type=None, entity_id=None,
                            type="task", title="general live")
    finally:
        seams.set_event_sink(saved)
    by_title = {e["flag"]["title"]: e for e in sink.events if e["event_type"] == "raised"}
    assert by_title["secret live"]["audience"] == {"groups": [w.g.id]}
    assert by_title["public live"]["audience"] is None
    assert by_title["general live"]["audience"] is None
    frame = _frame(by_title["secret live"])
    assert "audience" not in frame and "event: raised" in frame and '"flag_id"' in frame
```

- [ ] **Step 2: Run to verify failure**

```bash
"$PY" -m pytest tests/test_flags_bus.py tests/test_flags_visibility_enforcement.py -q -p no:cacheprovider
```

Expected: `TypeError: subscribe() got an unexpected keyword argument 'group_ids'`; `ImportError: cannot import name '_frame'`.

- [ ] **Step 3: Producer stamps the audience**

In `backend/flags/service.py` `_audit`, add to the staged event dict (after `"flag": _flag_summary(flag),`):

```python
        "audience": seams.resolve_audience(db, flag.entity_type, flag.entity_id),
```

Do the same in `_emit_reaction`'s event dict (search for `"flag": _flag_summary(flag)` near the reactions code).

- [ ] **Step 4: Bus**

Replace `Subscription.__init__`, `subscribe`, and `_visible_to` in `backend/flags/bus.py`:

```python
class Subscription:
    def __init__(self, bus: "FlagEventBus", user_id: Optional[int], *,
                 group_ids=frozenset(), is_admin: bool = False, system: bool = False) -> None:
        self._bus = bus
        self.user_id = user_id
        self.group_ids = frozenset(int(g) for g in group_ids)
        self.is_admin = bool(is_admin)
        self.system = bool(system)   # the Slack notifier: sees everything, DMs participants only
        self.queue: "asyncio.Queue[dict]" = asyncio.Queue(maxsize=1000)
```

```python
    def subscribe(self, user_id: Optional[int], *, group_ids=frozenset(),
                  is_admin: bool = False, system: bool = False) -> Subscription:
        sub = Subscription(self, user_id, group_ids=group_ids, is_admin=is_admin, system=system)
        self._subs.add(sub)
        if self._loop is None:
            try:
                self._loop = asyncio.get_running_loop()
            except RuntimeError:
                pass
        return sub
```

```python
    def _visible_to(self, sub: Subscription, event: dict) -> bool:
        """Producer-stamped `audience` (spec §6.4): None = everyone; {"groups": [...]} =
        members of those groups, admins, and the system subscriber. The bus never
        touches the database."""
        aud = event.get("audience")
        if sub.system or aud is None or sub.is_admin:
            return True
        groups = {int(g) for g in (aud.get("groups") or [])}
        return bool(groups & sub.group_ids)
```

and in `_deliver` call `self._visible_to(sub, event)`.

- [ ] **Step 5: Stream route and notifier**

In `backend/flags/routes.py`, add a module-level helper next to the stream route:

```python
def _frame(event: dict) -> str:
    """One SSE frame. `audience` is server-side only (spec §6.4) and never reaches a client."""
    payload = {k: v for k, v in event.items() if k != "audience"}
    frame = ""
    if payload.get("event_id") is not None:
        frame += f"id: {payload['event_id']}\n"
    return frame + f"event: {payload['event_type']}\ndata: {json.dumps(payload)}\n\n"
```

Change the stream route to take `db: Session = Depends(get_db)` and subscribe with membership:

```python
@router.get("/stream")
async def stream(request: Request, db: Session = Depends(get_db), user=Depends(get_current_user)):
    gids, adm = seams.resolve_membership(db, user)
    sub = BUS.subscribe(getattr(user, "id", None), group_ids=gids, is_admin=adm)
```

and replace the inline frame construction inside `gen()` with `yield _frame(event)`.

In `backend/slack_notify/notifier.py` line 128: `sub = bus.subscribe(None, system=True)`.

- [ ] **Step 6: Run to verify pass**

```bash
"$PY" -m pytest tests/test_flags_bus.py tests/test_flags_visibility_enforcement.py -q -p no:cacheprovider
"$PY" -m pytest tests/test_flags_stream.py tests/test_is_event_stream_sync.py tests/test_flags_reactions.py tests/test_slack_notify_notifier.py tests/test_slack_notify_planner.py -q -p no:cacheprovider
```

Expected: bus file 10 passed (5 + 5), enforcement 18 passed, the existing stream/reaction/Slack files unchanged. Note: `tests/test_flags_stream.py:84` calls the route function directly as `stream(FakeRequest(), user=user)`, so `db` arrives as the `Depends` marker, not a Session. Guard it in the route: `if not isinstance(db, Session): gids, adm = frozenset(), False` before calling `seams.resolve_membership` (fail closed), so that test keeps passing unchanged.

- [ ] **Step 7: Commit**

```bash
cd /c/tmp/Accu-Mk1-boards
git add backend/flags/service.py backend/flags/bus.py backend/flags/routes.py backend/slack_notify/notifier.py backend/tests/test_flags_bus.py backend/tests/test_flags_visibility_enforcement.py
git commit -m "feat(flags): producer-stamped SSE audience, per-subscriber filtering, stripped frames

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/flags/service.py backend/flags/bus.py backend/flags/routes.py backend/slack_notify/notifier.py backend/tests/test_flags_bus.py backend/tests/test_flags_visibility_enforcement.py
```

---

### Task 7: Turn restricted boards on

**Files:**
- Modify: `backend/boards/service.py` (`RESTRICTED_BOARDS_ENABLED = True`, comment)
- Test: extend `backend/tests/test_boards_routes.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_boards_routes.py`:

```python
def test_restricted_boards_are_enabled_by_default():
    from boards import service
    assert service.RESTRICTED_BOARDS_ENABLED is True, "slice 2 wires flag visibility; the lock is off"
```

- [ ] **Step 2: Run to verify failure**

```bash
"$PY" -m pytest tests/test_boards_routes.py -q -p no:cacheprovider
```

Expected: the new test fails (`False is True`).

- [ ] **Step 3: Flip**

In `backend/boards/service.py` replace the constant and its comment with:

```python
# Restricted boards are safe once every flag read path honors the anchor's visibility
# (slice 2: point-read gate, list clause, target guards, SSE audience). Left as a constant
# so a stack can lock them off again with a one-line change.
RESTRICTED_BOARDS_ENABLED = True
```

- [ ] **Step 4: Run to verify pass**

```bash
"$PY" -m pytest tests/test_boards_routes.py tests/test_boards_nodes.py -q -p no:cacheprovider
```

Expected: all pass (the fixtures' `monkeypatch.setattr(service, "RESTRICTED_BOARDS_ENABLED", True)` is now a no-op; `test_create_rules` still sets it False explicitly for its 400 case).

- [ ] **Step 5: Commit**

```bash
cd /c/tmp/Accu-Mk1-boards
git add backend/boards/service.py backend/tests/test_boards_routes.py
git commit -m "feat(boards): enable restricted boards

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/boards/service.py backend/tests/test_boards_routes.py
```

---

### Task 8: Docs, changelog, spec amendments

**Files:**
- Modify: `docs/developer/flags-add-entity.md`, `CHANGELOG.md`, `docs/superpowers/specs/2026-09-26-planning-boards-design.md` (§14)

- [ ] **Step 1: Developer doc**

Append to `docs/developer/flags-add-entity.md`:

```markdown

### Audience and membership (slice 2)

Two more host hooks make live events and target guards follow the same visibility:

```python
register_entity("<type>", ...,
    audience=lambda db, eid: None | {"groups": [group_ids]},  # who receives LIVE events;
                                                              # unset = everyone
)
seams.set_membership_resolver(lambda db, user: (group_ids, is_admin))  # once, at startup
```

`service._audit` stamps `audience` on every event; the bus filters per subscriber
(`system` subscribers such as the Slack notifier see everything and DM participants only);
the stream route strips `audience` before framing. `seams.load_user(db, user_id)` gives the
target guards a user object to ask `can_view` about an assignee, watcher or mention.

Every read path is gated: `service.get_visible_flag` for point reads (404, same text as a
missing flag), `seams.visibility_clause` on every list query, and a caller that passes no
`user` gets the fail-closed clause.
```

- [ ] **Step 2: Changelog**

Under `## Unreleased` in `CHANGELOG.md`, after the slice 1 subsection, add:

```markdown
### Planning boards, slice 2: flag visibility follows the board
- **Restricted boards are on.** A board granted to groups is visible to those groups and admins only; every board route answers 404 to anyone else.
- **Flags follow their anchor.** Every flag read path honors the anchor's visibility: point reads (detail, comments, assign, status, due, watchers, links, attachments, reactions, read marks) answer 404 with the same text as a missing flag; All open, Unread, Activity, Summary and Search filter through one SQL clause; a caller that passes no user gets the fail-closed clause. Unanchored general tasks and legacy anchors are unchanged.
- **Nobody is pulled into a flag they cannot see.** Assigning, watching or mentioning a user who cannot view the anchor is a 400; linking a flag to a hidden entity or a hidden flag is a 404; hidden entity links render as "Restricted" and hidden flag links are dropped.
- **Live updates respect the audience.** The producer stamps every SSE event with an audience derived from the anchor (everyone, the board's groups plus admins, or admins only for an orphaned anchor); the stream filters per connection and never sends the audience field. Group changes apply on the next reconnect. The Slack notifier subscribes as a system listener and still DMs participants only.
- New seams for other entity types: `audience`, `seams.load_user`, `seams.set_membership_resolver`. See `docs/developer/flags-add-entity.md`.
```

- [ ] **Step 3: Spec §14**

Append bullets to §14 of the spec:

```markdown
- Slice 2: `EntitySpec.audience(db, entity_id)` (None = everyone, `{"groups": [...]}` otherwise,
  `{"groups": []}` for an orphaned anchor or a raising closure) is stamped by `service._audit`;
  `Subscription` carries `group_ids`, `is_admin`, `system`; the Slack notifier is a `system`
  subscriber. `seams.load_user` and `seams.set_membership_resolver` are the two host hooks the
  target guards and the stream route use; both keep the lazy `models.User` import pattern
  `resolve_user` already established.
- Slice 2: `add_entity_link` refuses (404) a target the caller cannot view; hidden entity links
  serialize with `entity_id: ""` and label "Restricted"; hidden flag links are omitted.
- Slice 2: list functions take `user=None` and fail closed without a user; the Slack digest loads
  the `User` row and passes it.
```

- [ ] **Step 4: Commit**

```bash
cd /c/tmp/Accu-Mk1-boards
git add docs/developer/flags-add-entity.md CHANGELOG.md docs/superpowers/specs/2026-09-26-planning-boards-design.md
git commit -m "docs(flags): slice 2 visibility enforcement guide, changelog, spec §14

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- docs/developer/flags-add-entity.md CHANGELOG.md docs/superpowers/specs/2026-09-26-planning-boards-design.md
```

---

### Task 9: Real-stack E2E with screenshots

**Files:**
- Modify: `e2e/planning-boards-slice1.spec.ts` (restricted board now creates: expect 201, record `restricted_board_created`)
- Create: `e2e/planning-boards-slice2.spec.ts`

Run by the controller against devbox stack `boards` (branch mounted; backend hot-reloads). From `C:/tmp/Accu-Mk1-boards`: `E2E_BASE_URL=http://100.73.137.3:5592 E2E_BACKEND_URL=http://100.73.137.3:5590 E2E_EMAIL=stackdev@accumark.local E2E_PASSWORD=<from accumark-stack creds boards> npx playwright test e2e/planning-boards-slice1.spec.ts e2e/planning-boards-slice2.spec.ts --reporter=list`. Screenshots land in `docs/superpowers/evidence/2026-09-27-planning-boards-slice2/`.

- [ ] **Step 1: Update the slice 1 assertion**

In `e2e/planning-boards-slice1.spec.ts`, the block that posts a `restricted` board now expects `201` and records `restricted_board_created: true`; delete the "not enabled" assertion.

- [ ] **Step 2: Write the slice 2 spec**

`e2e/planning-boards-slice2.spec.ts`:

```ts
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Planning boards, slice 2: a flag on a restricted board is invisible outside the board's
 * groups, across the API and the flag flyout. Creates its own group, two standard users
 * (member, outsider), a restricted board, a frame and a flag, all suffixed per run.
 */
const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8012'
const SHOTS = process.env.E2E_SHOTS_DIR ?? 'docs/superpowers/evidence/2026-09-27-planning-boards-slice2'
const RUN = Date.now().toString(36).slice(-4)
const TITLE = `Secret plan (${RUN})`
const TOKEN_KEY = 'accu_mk1_auth_token'
const USER_KEY = 'accu_mk1_auth_user'

test.describe.configure({ mode: 'serial' })

async function login(request: APIRequestContext, email: string, password: string) {
  const r = await request.post(`${BACKEND_URL}/auth/login`, { data: { email, password } })
  expect(r.ok(), `login ${email}: ${r.status()}`).toBeTruthy()
  return ((await r.json()) as { access_token: string }).access_token
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` })

async function asUser(page: Page, token: string, email: string, role: string) {
  await page.addInitScript(
    ({ token, user, tokenKey, userKey }) => {
      window.localStorage.setItem(tokenKey, token)
      window.localStorage.setItem(userKey, JSON.stringify(user))
    },
    { token, user: { email, role, is_active: true }, tokenKey: TOKEN_KEY, userKey: USER_KEY }
  )
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, name) })
}

const world: Record<string, unknown> = { run: RUN }
function record(k: string, v: unknown) {
  world[k] = v
  fs.mkdirSync(SHOTS, { recursive: true })
  fs.writeFileSync(path.join(SHOTS, 'api-summary.json'), JSON.stringify(world, null, 2) + '\n')
}

let admin = ''
let memberTok = ''
let outsiderTok = ''
let memberEmail = ''
let outsiderEmail = ''
let flagId = 0
let boardSlug = ''
let frameId = 0

test('setup: group, member, outsider, restricted board, frame, flag', async ({ request }) => {
  admin = await login(request, process.env.E2E_EMAIL!, process.env.E2E_PASSWORD!)
  const h = bearer(admin)
  memberEmail = `e2e-member-${RUN}@accumark.local`
  outsiderEmail = `e2e-outsider-${RUN}@accumark.local`
  const pw = randomBytes(12).toString('base64url')
  for (const email of [memberEmail, outsiderEmail]) {
    const r = await request.post(`${BACKEND_URL}/auth/users`, { headers: h, data: { email, password: pw, role: 'standard' } })
    expect([200, 201]).toContain(r.status())
  }
  const members = (await (await request.get(`${BACKEND_URL}/worksheets/users`, { headers: h })).json()) as { id: number; email: string }[]
  const memberId = members.find(u => u.email === memberEmail)!.id
  const g = await request.post(`${BACKEND_URL}/api/groups`, { headers: h, data: { slug: `exec-${RUN}`, name: 'Exec' } })
  expect(g.status()).toBe(201)
  const gid = ((await g.json()) as { id: number }).id
  expect((await request.put(`${BACKEND_URL}/api/groups/${gid}/members`, { headers: h, data: { user_ids: [memberId] } })).status()).toBe(200)
  boardSlug = `exec-board-${RUN}`
  const b = await request.post(`${BACKEND_URL}/api/boards`, { headers: h, data: { slug: boardSlug, name: 'Exec board', kind: 'map', visibility: 'restricted' } })
  expect(b.status(), await b.text()).toBe(201)
  record('restricted_board_created', true)
  expect((await request.put(`${BACKEND_URL}/api/boards/${boardSlug}/grants`, { headers: h, data: [{ group_id: gid, can_edit: true }] })).status()).toBe(200)
  const f = await request.post(`${BACKEND_URL}/api/boards/${boardSlug}/nodes`, { headers: h, data: { kind: 'frame', label: 'Compensation review', x: 40, y: 40, w: 400, h: 240, data: { color: 'red' } } })
  expect(f.status()).toBe(201)
  frameId = ((await f.json()) as { id: number }).id
  const fl = await request.post(`${BACKEND_URL}/api/flags`, { headers: h, data: { entity_type: 'board_node', entity_id: String(frameId), type: 'task', title: TITLE } })
  expect(fl.status(), await fl.text()).toBe(201)
  flagId = ((await fl.json()) as { id: number }).id
  memberTok = await login(request, memberEmail, pw)
  outsiderTok = await login(request, outsiderEmail, pw)
})

test('API: the outsider cannot see the board or the flag; the member can', async ({ request }) => {
  const o = bearer(outsiderTok)
  const m = bearer(memberTok)
  expect((await request.get(`${BACKEND_URL}/api/boards/${boardSlug}`, { headers: o })).status()).toBe(404)
  expect((await request.get(`${BACKEND_URL}/api/boards/${boardSlug}`, { headers: m })).status()).toBe(200)
  const hidden = await request.get(`${BACKEND_URL}/api/flags/${flagId}`, { headers: o })
  const missing = await request.get(`${BACKEND_URL}/api/flags/999999999`, { headers: o })
  expect(hidden.status()).toBe(404)
  expect(missing.status()).toBe(404)
  expect((await request.get(`${BACKEND_URL}/api/flags/${flagId}`, { headers: m })).status()).toBe(200)
  const oList = (await (await request.get(`${BACKEND_URL}/api/flags?tab=all_open`, { headers: o })).json()) as { title: string }[]
  const mList = (await (await request.get(`${BACKEND_URL}/api/flags?tab=all_open`, { headers: m })).json()) as { title: string }[]
  expect(oList.map(f => f.title)).not.toContain(TITLE)
  expect(mList.map(f => f.title)).toContain(TITLE)
  const oSearch = (await (await request.get(`${BACKEND_URL}/api/flags/entity-search?entity_type=board_node&q=Comp`, { headers: o })).json()) as unknown[]
  expect(oSearch).toEqual([])
  const outsiderId = ((await (await request.get(`${BACKEND_URL}/worksheets/users`, { headers: bearer(admin) })).json()) as { id: number; email: string }[]).find(u => u.email === outsiderEmail)!.id
  const assign = await request.post(`${BACKEND_URL}/api/flags/${flagId}/assign`, { headers: bearer(admin), data: { assignee_id: outsiderId } })
  expect(assign.status()).toBe(400)
  record('outsider', { board: 404, flag: 404, in_all_open: false, entity_search: 0, assign: 400 })
  record('member', { board: 200, flag: 200, in_all_open: true })
})

test('flyout: the member sees the flag, the outsider does not', async ({ browser }) => {
  const mCtx = await browser.newContext()
  const mPage = await mCtx.newPage()
  await asUser(mPage, memberTok, memberEmail, 'standard')
  await mPage.goto('/')
  await mPage.locator('#flags-header-button').click()
  await mPage.getByRole('tab', { name: 'All open' }).click()
  await expect(mPage.getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await shot(mPage, '01-member-sees-restricted-flag.png')
  await mCtx.close()

  const oCtx = await browser.newContext()
  const oPage = await oCtx.newPage()
  await asUser(oPage, outsiderTok, outsiderEmail, 'standard')
  await oPage.goto('/')
  await oPage.locator('#flags-header-button').click()
  await oPage.getByRole('tab', { name: 'All open' }).click()
  await expect(oPage.getByRole('tab', { name: 'All open' })).toHaveAttribute('aria-selected', 'true')
  await oPage.waitForTimeout(1500)
  await expect(oPage.getByText(TITLE)).toHaveCount(0)
  await shot(oPage, '02-outsider-does-not-see-restricted-flag.png')
  await oCtx.close()
})
```

`browser.newContext()` needs `baseURL`; it inherits from the config's `use.baseURL`, which the config sets from `E2E_BASE_URL`. If `page.goto('/')` fails to resolve, pass `{ baseURL: process.env.E2E_BASE_URL }` to `newContext`.

- [ ] **Step 3: Run both specs (controller)**

Expected: slice 1 spec 5 passed (with the 201 change), slice 2 spec 3 passed, two screenshots and `api-summary.json` in the slice 2 evidence directory. Commit the specs and evidence:

```bash
cd /c/tmp/Accu-Mk1-boards
git add e2e/planning-boards-slice1.spec.ts e2e/planning-boards-slice2.spec.ts docs/superpowers/evidence/2026-09-27-planning-boards-slice2/
git commit -m "test(e2e): planning boards slice 2 restricted-board visibility with evidence screenshots

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- e2e/planning-boards-slice1.spec.ts e2e/planning-boards-slice2.spec.ts docs/superpowers/evidence/2026-09-27-planning-boards-slice2/
```

---

### Task 10: Final gates

- [ ] **Step 1: New and touched suites**

```bash
cd /c/tmp/Accu-Mk1-boards/backend
"$PY" -m pytest tests/test_flags_audience_membership.py tests/test_flags_visibility_enforcement.py tests/test_flags_seams_visibility_hooks.py tests/test_flags_bus.py tests/test_flags_board_node.py tests/test_boards_routes.py tests/test_boards_nodes.py tests/test_groups_routes.py -q -p no:cacheprovider
```

Expected: all pass (about 90 tests).

- [ ] **Step 2: Full-suite failure-set diff**

```bash
"$PY" -m pytest tests -q -p no:cacheprovider > /c/tmp/Accu-Mk1-boards-s2-after-full.log 2>&1; grep -E "^(FAILED|ERROR) " /c/tmp/Accu-Mk1-boards-s2-after-full.log | sed 's/ - .*$//' | sort -u > /c/tmp/Accu-Mk1-boards-s2-after-failures.txt; diff <(grep -v completion_side_effects /c/tmp/Accu-Mk1-boards-s2-baseline-failures.txt) <(grep -v completion_side_effects /c/tmp/Accu-Mk1-boards-s2-after-failures.txt) && echo "NO NEW FAILURES"
```

Any line that appears only on the right is a regression: stop and report it.

- [ ] **Step 3: Frontend**

```bash
cd /c/tmp/Accu-Mk1-boards && npm run typecheck && npx eslint e2e/planning-boards-slice2.spec.ts --max-warnings 0 && npx prettier --check e2e/planning-boards-slice2.spec.ts e2e/planning-boards-slice1.spec.ts
```

(Fix formatting with `npx prettier --write` if needed and amend the E2E commit.)

- [ ] **Step 4: Report**

Per gate: command, summary line, pass/fail; the failure-set diff verbatim; what was skipped. The controller then runs the whole-branch security review (the spec §11 slice 2 gate) and opens the PR.

---

## Self-review notes

- Spec coverage: §6.3 rows map to Tasks 2 (point reads, attachments), 3 (lists, search, activity, unread, summary), 4 (assign/watcher/mention guards), 5 (entity link masking; `add_entity_link` gate added beyond the table because the table's spirit is "never confirm a hidden anchor"), 1 + 6 (`/entity-search` already scoped in slice 1; SSE audience), 7 (restricted flip). §6.4 = Task 6. §6.5 = Task 3 (digest) + Task 6 (system subscriber). §10 tests: one per enforcement row with non-member, member, admin; SSE three-subscription test; orphan and general/legacy pins. §11 slice 2 security review pass = the SDD whole-branch review.
- Deviations to record in §14 (Task 8): `audience` seam, `load_user`, `set_membership_resolver`, `add_entity_link` gate, `entity_id: ""` masking, list functions failing closed without a user.
- Name consistency: `get_visible_flag` (Task 2, used by 4 and 5), `_require_target_can_view` (Task 4), `resolve_audience`/`resolve_membership`/`load_user` (Task 1, used by 4 and 6), `_frame` (Task 6, tested in the enforcement file), `Subscription(group_ids, is_admin, system)` (Task 6, notifier).
- Review Focus 1 to 5 have named tests in Tasks 2, 6, 1, 3, 3 (plus the bus test for the orphan audience).
- Known limits stated in docs: an open SSE connection keeps its membership until reconnect (15 s keepalive cadence); Slack DM recipients are participants, who pass the target guards.
