# Planning Boards Slice 4 (Live Layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a board live: the board itself can carry flags, every flag on a board is fetched once and shown as frame rollup pills, item indicators, an attention dock and a board-card count; the canvas gets zoom-semantic rendering, Cmd+K jumps, remove-from-frame, note resizing and a `board_changed` live event so two editors see each other's changes.

**Architecture:** PR A (`feat/planning-boards-s4d`, base `master`) adds a `board` flag anchor next to `board_node`, one gated endpoint `GET /api/boards/{slug}/flags` that joins every anchor on a board server-side, `open_flag_count` on the boards list, and a TanStack query under `['flags', 'board', slug]` that every node, the dock and the header read (no per-node fetches). PR B (`feat/planning-boards-s4e`, stacked on s4d) adds the canvas behaviours and a `board_changed` event published through the existing flag event sink and bus (audience-stamped like flag events), which the stream glue turns into a refetch of that board.

**Tech Stack:** FastAPI + SQLAlchemy 2 + pydantic v2 (backend, no alembic: `_run_migrations` list, but this slice adds NO columns), React 19 with the React Compiler, TanStack Query 5, `@xyflow/react` 12, cmdk, shadcn/Radix, vitest + Testing Library, Playwright against a devbox stack.

**Spec:** `docs/superpowers/specs/2026-09-26-planning-boards-design.md` sections 8.3 (zoom, Cmd+K, rollups), 8.6 (attention dock), 8.7 (persistence), 14 (slice 3 deferrals and the slice 4 amendment Task 1 adds).

## Global Constraints

- Additive only: no existing route, payload key or component contract changes meaning; new keys default so old callers keep working.
- Invisible = 404, never 403 (spec 5, 9). Every board list read goes through `boards.access`; every flag read through `seams.visibility_clause` or `can_view_entity`.
- Every node write carries `version`; a 409 is handled by the shared `useBoardMutation` (reload + toast). No new mutation helper.
- No new dependencies. `@dagrejs/dagre`, cmdk, `@xyflow/react` and Radix are already installed.
- No em dashes anywhere (code, comments, tests, commit messages, docs). Use a comma, colon or parentheses.
- Commit by pathspec only (`git commit -- <paths>`), never `git add -A`; trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` on every commit. Create or append files with the Write tool or `python` (`newline='\n'`), never a Bash heredoc into a tracked file (it writes CRLF here). Check `git ls-files --eol <file>` shows `i/lf` before committing a new file.
- Frontend gates per task: `node node_modules/typescript/bin/tsc --noEmit`, `node node_modules/eslint/bin/eslint.js <touched files>` (zero warnings), `node node_modules/prettier/bin/prettier.cjs --check <touched files>`, `node node_modules/vitest/vitest.mjs run <touched dirs>`. Bare `npm`/`npx` shims hang in the agent shell; call the node entry points.
- Backend gates per task: `cd backend && <venv python> -m pytest <files> -q -p no:cacheprovider`; venv python = `C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe`. ONE pytest process at a time (two deadlock on the shared dev Postgres). The boards and flags tests here use in-memory SQLite fixtures.
- e2e specs live outside the tsconfig project: eslint reports a pre-existing `parserOptions.project` error on them; the gate for a spec is prettier + typecheck + a green run on the stack.
- CHANGELOG entries go under `## Unreleased` (one `### Planning boards, slice 4` block, added in Task 1 and extended by PR B).

## Review Focus

1. A flag on a document item the viewer cannot see must not leak through the board flags endpoint, the frame pill or the dock (`seams.visibility_clause` filters by type; the endpoint test in Task 3 raises a flag on a view-scoped anchor as an admin and reads as a viewer).
2. A flag on an `entity` item inside a frame is anchored on the entity, not on the node; the frame rollup must count it by that anchor (Task 5 unit test: entity child with a sample flag counts toward the frame).
3. A board with only a board-level open flag must refuse deletion with a 409 naming the count, like items do (Task 2 test).
4. A `board_changed` event for a restricted board must carry the grant groups as its audience so the bus never delivers it to an outsider (Task 13 test asserts the stamped audience; the bus filter is already tested).
5. Cmd+K commands registered for one board must disappear when the board unmounts, so a stale command cannot jump on a different page (Task 11 registry test for `unregisterCommands` and the `isAvailable` guard).

---

## File Structure

**PR A, `feat/planning-boards-s4d` (base `master`)**

- Modify `backend/boards/flag_entity.py`: add the `board` anchor closures and `register_board()` beside `register_board_node()`.
- Modify `backend/flags/seams.py` (`register_mk1_entities`): call `register_board()`.
- Modify `backend/boards/service.py`: `open_board_flag_count`, `open_flag_counts`, `board_open_flags`; `delete_board` counts board-level flags; `board_out` fills `open_flag_count`.
- Modify `backend/boards/schemas.py`: `BoardOut.open_flag_count: int = 0`.
- Modify `backend/boards/routes.py`: list route passes both count maps; new `GET /{slug}/flags`.
- Create `backend/tests/test_flags_board.py`; modify `backend/tests/test_boards_routes.py`.
- Modify `src/lib/api-boards.ts` (`open_flag_count`, `listBoardFlags`), `src/hooks/use-flags.ts` (`flagKeys.boards`, `flagKeys.board`), `src/services/boards.ts` (`useBoardFlags`), `src/components/flags/use-flag-stream-glue.ts` (standard set marks `flagKeys.boards()`).
- Create `src/components/boards/board-flags.ts` (pure helpers) + `__tests__/board-flags.test.ts`.
- Modify `src/components/boards/nodes/FrameNode.tsx`, `EntityNode.tsx`, `PersonNode.tsx` (pills); create `__tests__/FrameNode.test.tsx`, extend `__tests__/PersonNode.test.tsx`.
- Create `src/components/boards/AttentionDock.tsx` + `__tests__/AttentionDock.test.tsx`; modify `BoardSidePanel.tsx` (idle state renders the dock), `BoardPage.tsx` (header Raise flag, dock locate wiring), `BoardsPage.tsx` (count), `src/components/flags/flag-entity.ts` (`board` meta + deep link).
- Create `e2e/planning-boards-live.spec.ts` (tests 1 to 6 in PR A) + evidence `docs/superpowers/evidence/2026-10-12-planning-boards-live/`.
- Modify spec section 14 and `CHANGELOG.md`.

**PR B, `feat/planning-boards-s4e` (base `feat/planning-boards-s4d`)**

- Create `src/components/boards/nodes/use-compact.ts`; modify `NoteNode.tsx`, `EntityNode.tsx`, `PersonNode.tsx` (compact rendering), `board-mapping.ts` (note default width), `NoteNode` resize; tests.
- Modify `src/lib/commands/types.ts` (`label?`), `registry.ts` (`unregisterCommands`, literal-label search), `src/components/command-palette/CommandPalette.tsx` (literal label); create `src/components/boards/board-commands.ts` + test; modify `BoardPage.tsx` (register on mount).
- Modify `BoardSidePanel.tsx` (Remove from frame) + test.
- Modify `backend/boards/service.py` (`_emit_board_changed` after each write), `backend/tests/test_boards_routes.py`; modify `src/lib/flag-stream.ts` (optional `board_slug`), `use-flag-stream-glue.ts` (`board_changed` short-circuit) + glue test.
- Extend `e2e/planning-boards-live.spec.ts` (tests 7 to 11); CHANGELOG lines; spec 14 line.

---

## PR A: flags on the board

### Task 1: Spec amendment and changelog block

**Files:**
- Modify: `docs/superpowers/specs/2026-09-26-planning-boards-design.md` (end of section 14)
- Modify: `CHANGELOG.md` (under `## Unreleased`)

- [ ] **Step 1: Append the slice 4 amendment to section 14**

Append after the last bullet of section 14 (the `Slice 4c (person cards, PR #277)` bullet):

```markdown
- Slice 4d (flags on the board, 2026-10-12, Handler rulings): the board itself is a flag
  anchor (`entity_type = "board"`, `entity_id` = board id): raise = board editors, view =
  board viewers, audience = the board's grants, label = the board name, deep link opens the
  board; deleting a board with an open board-level flag is refused (409) like an item.
  `GET /api/boards/{slug}/flags` returns the open flags of every anchor on the board (the
  board, its items, and the entities behind entity items) under the caller's visibility,
  replacing the per-node fetch the spec left implicit in 8.3 and 8.6; the boards list carries
  `open_flag_count` (board and item anchors). The attention dock (8.6) lives in the side
  panel's idle state, not a third column. Cmd+K (8.3) is a "Board" group in the existing
  command palette, not a second palette. Dropped from this slice: groups in the person panel
  (no endpoint for another user's groups; low value) and the 250 ms drag-end debounce (drag
  end already writes once per drop, and a debounce reintroduces the dropped-callback trap
  found in 4b).
```

- [ ] **Step 2: Add the changelog block**

Under `## Unreleased` (keep the heading, insert below it):

```markdown
### Planning boards, slice 4: flags on the board
- **Flag a board.** Editors raise flags on the board itself from the header; board-level flags show in the attention dock and count on the board card. A board with open flags cannot be deleted.
- **Every flag on a board, once.** `GET /api/boards/{slug}/flags` returns the open flags on the board, its items and the entities behind entity items, under the caller's visibility. Frames show blocking and open counts, entity items show an open count, person cards show how many of the board's flags are assigned to them, and board cards show the open count.
- **Attention dock.** With nothing selected, the side panel lists the board's blocking and past-due flags, overdue first, with Locate to centre the item.
```

- [ ] **Step 3: Commit**

```bash
git commit -m "docs(boards): spec 14 slice 4 amendment and changelog block

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- docs/superpowers/specs/2026-09-26-planning-boards-design.md CHANGELOG.md
```

### Task 2: `board` as a flag anchor (backend)

**Files:**
- Modify: `backend/boards/flag_entity.py` (append below `register_board_node`)
- Modify: `backend/flags/seams.py:~820` (`register_mk1_entities` calls `register_board()`)
- Modify: `backend/boards/service.py` (`delete_board`, new `open_board_flag_count`)
- Create: `backend/tests/test_flags_board.py`

**Interfaces:**
- Consumes: `boards.access.can_view_board / can_edit_board / visible_board_ids`, `groups.access.is_admin`, `flags.seams.register_entity`, `flags.seams._ilike_prefix`, `flags.catalog.OPEN_STATES`.
- Produces: `register_board()`; `open_board_flag_count(db, board_id: int) -> int`; context dict `{"label": board.name, "deep_link": {"kind": "board", "id": board.slug}, "board_slug": slug, "node_kind": None, "sample_id": None, "analyses": [], "lot": None}`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_flags_board.py` (same fixture shape as `test_flags_board_node.py`; copy its `w` fixture verbatim, it already registers the entities through `seams.register_mk1_entities()`):

```python
"""`board` as a flag entity type (spec 14, slice 4d): the board itself carries flags."""
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
    note = BoardNode(board_id=org.id, kind="note", label="Welcome")
    s.add(note)
    s.commit()
    return SimpleNamespace(s=s, org=org, exec_=exec_, note=note)


def test_registered_with_must_exist(w):
    from flags import seams
    spec = seams.get_entity_spec("board")
    assert spec.must_exist is True
    assert spec.can_raise and spec.can_view and spec.visible_entity_ids and spec.search_scoped
    assert spec.descendants is None


def test_context_label_and_deep_link(w):
    from flags import seams
    ctx = seams.resolve_context(w.s, "board", str(w.exec_.id))
    assert ctx["label"] == "Exec"
    assert ctx["deep_link"] == {"kind": "board", "id": "exec"}
    assert ctx["board_slug"] == "exec"
    assert seams.resolve_context(w.s, "board", "999") is None
    assert seams.resolve_context(w.s, "board", "abc") is None
    assert seams.get_entity_spec("board").label(w.s, "999") == "Deleted board"
    assert seams.resolve_contexts(w.s, "board", [str(w.org.id), "999"]).keys() == {str(w.org.id)}


def test_can_raise_is_can_edit_board(w):
    from flags import seams
    spec = seams.get_entity_spec("board")
    eid = str(w.exec_.id)
    assert spec.can_raise(w.s, ADMIN, eid) is True
    assert spec.can_raise(w.s, EDITOR, eid) is True
    assert spec.can_raise(w.s, VIEWER, eid) is False
    assert spec.can_raise(w.s, OUTSIDER, eid) is False   # invisible: never confirmed
    assert spec.can_raise(w.s, EDITOR, "999") is False


def test_can_view_follows_the_board(w):
    from flags import seams
    spec = seams.get_entity_spec("board")
    assert [spec.can_view(w.s, u, str(w.exec_.id)) for u in (ADMIN, EDITOR, VIEWER, OUTSIDER)] == \
        [True, True, True, False]
    assert [spec.can_view(w.s, u, str(w.org.id)) for u in (VIEWER, OUTSIDER)] == [True, True]
    assert spec.can_view(w.s, OUTSIDER, "999") is False and spec.can_view(w.s, ADMIN, "999") is True


def test_visible_entity_ids_and_clause(w):
    from flags import seams, service as flags
    from flags.models import FlagFlag
    spec = seams.get_entity_spec("board")
    assert spec.visible_entity_ids(w.s, ADMIN) is None
    ids = set(w.s.execute(spec.visible_entity_ids(w.s, OUTSIDER)).scalars().all())
    assert ids == {str(w.org.id)}
    flags.create_flag(w.s, user=EDITOR, entity_type="board", entity_id=str(w.exec_.id), type="task", title="exec task")
    flags.create_flag(w.s, user=EDITOR, entity_type="board", entity_id=str(w.org.id), type="task", title="org task")
    seen = {f.title for f in flags.list_flags(w.s, user_id=OUTSIDER.id, tab="all_open", user=OUTSIDER)}
    assert "org task" in seen and "exec task" not in seen


def test_audience_and_snapshot(w):
    from flags import seams
    spec = seams.get_entity_spec("board")
    assert spec.audience(w.s, str(w.org.id)) is None
    aud = spec.audience(w.s, str(w.exec_.id))
    assert set(aud["groups"]) == {g.id for g in w.s.execute(select(__import__("groups.models", fromlist=["UserGroup"]).UserGroup)).scalars()}
    assert spec.audience(w.s, "999") == {"groups": []}
    assert spec.snapshot(w.s, str(w.exec_.id)) == {"board": "exec"}


def test_search_is_scoped_to_visible_boards(w):
    from flags import seams
    hits = seams.resolve_entity_search(w.s, "board", "e", user=OUTSIDER)
    assert [h["label"] for h in hits] == []   # "Exec" hidden, "Org" does not match "e" as a prefix
    hits = seams.resolve_entity_search(w.s, "board", "ex", user=VIEWER)
    assert [(h["entity_id"], h["label"]) for h in hits] == [(str(w.exec_.id), "Exec")]


def test_delete_board_counts_board_level_flags(w):
    from boards import service as boards
    from flags import service as flags
    from flags.models import FlagFlag
    from groups.errors import ConflictError
    f = flags.create_flag(w.s, user=EDITOR, entity_type="board", entity_id=str(w.org.id), type="task", title="t")
    assert boards.open_board_flag_count(w.s, w.org.id) == 1
    with pytest.raises(ConflictError, match="1 open flag"):
        boards.delete_board(w.s, ADMIN, "org")
    w.s.execute(FlagFlag.__table__.update().where(FlagFlag.id == f.id).values(status="resolved"))
    w.s.commit()
    boards.delete_board(w.s, ADMIN, "org")
    assert w.s.get(type(w.org), w.org.id) is None
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `cd backend && "$PY" -m pytest tests/test_flags_board.py -q -p no:cacheprovider`
Expected: FAIL on `get_entity_spec("board")` (unknown entity type) and `open_board_flag_count` (AttributeError).

- [ ] **Step 3: Add the closures and registration**

Append to `backend/boards/flag_entity.py` (after `register_board_node`):

```python
# --- the board itself as an anchor (spec 14, slice 4d) ------------------------------

DELETED_BOARD_LABEL = "Deleted board"


def _load_board(db: Session, eid: str):
    from boards.models import Board
    if db is None or not _ID_RE.fullmatch(str(eid)):
        return None
    return db.get(Board, int(eid))


def _board_ctx(board) -> dict:
    return {"label": board.name, "sample_id": None, "analyses": [], "lot": None,
            "deep_link": {"kind": "board", "id": board.slug},
            "board_slug": board.slug, "node_kind": None}


def _board_label(db, eid) -> str:
    board = _load_board(db, eid)
    return board.name if board else DELETED_BOARD_LABEL


def _board_context(db, eid) -> Optional[dict]:
    board = _load_board(db, eid)
    return _board_ctx(board) if board else None


def _board_contexts(db, eids) -> dict:
    from boards.models import Board
    ids = [int(e) for e in eids if _ID_RE.fullmatch(str(e))]
    if not ids:
        return {}
    rows = db.execute(select(Board).where(Board.id.in_(ids))).scalars().all()
    return {str(b.id): _board_ctx(b) for b in rows}


def _board_can_raise(db, user, eid) -> bool:
    from boards.access import can_edit_board, can_view_board
    board = _load_board(db, eid)
    if board is None or not can_view_board(db, user, board):
        return False  # existence is never confirmed (spec 9)
    return can_edit_board(db, user, board)


def _board_can_view(db, user, eid) -> bool:
    from boards.access import can_view_board
    from groups.access import is_admin
    board = _load_board(db, eid)
    if board is None:
        return is_admin(user)  # orphaned anchor: fail closed
    return can_view_board(db, user, board)


def _board_visible_ids(db, user):
    from boards.access import visible_board_ids
    from boards.models import Board
    from groups.access import is_admin
    if is_admin(user):
        return None
    return select(cast(Board.id, String)).where(Board.id.in_(visible_board_ids(db, user)))


def _board_search(db, user, q) -> list:
    from boards.access import visible_board_ids
    from boards.models import Board
    from flags.seams import _ilike_prefix
    pattern = _ilike_prefix(str(q))
    rows = db.execute(select(Board).where(Board.id.in_(visible_board_ids(db, user)),
                                          Board.name.ilike(pattern, escape="\\"))
                      .order_by(Board.name).limit(10)).scalars().all()
    return [{"entity_id": str(b.id), "label": b.name} for b in rows]


def _board_snapshot(db, eid) -> Optional[dict]:
    board = _load_board(db, eid)
    return {"board": board.slug} if board else None


def _board_audience(db, eid) -> Optional[dict]:
    from boards.models import BoardGrant
    board = _load_board(db, eid)
    if board is None:
        return {"groups": []}
    if board.visibility == "company":
        return None
    gids = db.execute(select(BoardGrant.group_id).where(BoardGrant.board_id == board.id)
                      .order_by(BoardGrant.group_id)).scalars().all()
    return {"groups": [int(g) for g in gids]}


def register_board() -> None:
    from flags.seams import register_entity
    register_entity("board",
                    label=_board_label,
                    deep_link=lambda eid: "/#boards/board",
                    can_flag=lambda user, eid: True,   # never consulted: can_raise wins
                    can_raise=_board_can_raise,
                    can_view=_board_can_view,
                    visible_entity_ids=_board_visible_ids,
                    context=_board_context,
                    contexts=_board_contexts,
                    search_scoped=_board_search,
                    snapshot=_board_snapshot,
                    audience=_board_audience,
                    must_exist=True)
```

Check `_ilike_prefix` in `backend/flags/seams.py:471` before using it: `_search` for board nodes builds `"%" + _ilike_prefix(q)`; mirror exactly what that function expects (if it already returns a pattern with wildcards, do not add `%` again; the search test above pins prefix semantics: "e" must not match "Exec" only because the board is hidden, "ex" must match it).

In `backend/flags/seams.py` `register_mk1_entities`, next to the existing `register_board_node()` call (line ~820), add the import and call:

```python
    from boards.flag_entity import register_board, register_board_node
    register_board_node()
    register_board()
```

(Keep whatever import form is already there for `register_board_node`; add `register_board` to it.)

In `backend/boards/service.py`, below `open_flag_count`:

```python
def open_board_flag_count(db: Session, board_id: int) -> int:
    """Open flags anchored on the board itself (entity_type 'board', spec 14 slice 4d)."""
    from flags.catalog import OPEN_STATES
    from flags.models import FlagFlag
    return int(db.execute(select(func.count()).select_from(FlagFlag).where(
        FlagFlag.entity_type == "board", FlagFlag.entity_id == str(board_id),
        FlagFlag.status.in_(OPEN_STATES))).scalar_one())
```

and in `delete_board`, replace the count lines with:

```python
    node_ids = list(db.execute(select(BoardNode.id).where(BoardNode.board_id == board.id)).scalars())
    n = open_flag_count(db, node_ids) + open_board_flag_count(db, board.id)
    if n:
        raise ConflictError(f"board has {n} open flag(s); resolve them first")
```

(`match="1 open flag"` in the existing `test_flags_board_node.py::test_delete_rules_follow_open_flags` still matches.)

- [ ] **Step 4: Run the tests**

Run: `cd backend && "$PY" -m pytest tests/test_flags_board.py tests/test_flags_board_node.py tests/test_boards_access.py -q -p no:cacheprovider`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(boards): the board itself is a flag anchor

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/boards/flag_entity.py backend/flags/seams.py backend/boards/service.py backend/tests/test_flags_board.py
```

### Task 3: `GET /api/boards/{slug}/flags` and `open_flag_count` on the list

**Files:**
- Modify: `backend/boards/service.py` (`open_flag_counts`, `board_open_flags`, `board_out`)
- Modify: `backend/boards/schemas.py:29-41` (`BoardOut.open_flag_count`)
- Modify: `backend/boards/routes.py` (list route, new flags route)
- Modify: `backend/tests/test_boards_routes.py`

**Interfaces:**
- Consumes: `flags.routes._with_entities(db, flags) -> list[FlagResponse]`, `flags.seams.visibility_clause`, `flags.catalog.OPEN_STATES`.
- Produces: `GET /api/boards/{slug}/flags -> List[FlagResponse]` (open only, caller-visible, every anchor on the board incl. the board); `BoardOut.open_flag_count` (board + item anchors, not entity anchors); `service.open_flag_counts(db, board_ids) -> dict[int, int]`; `service.board_open_flags(db, user, slug) -> list[FlagFlag]`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_boards_routes.py` (reuse its `client` fixture, `_board` helper and `client.as_user`; flags are raised through the real `/api/flags` route of the same app):

```python
def _flag(client, entity_type, entity_id, title, type_="task", **extra):
    r = client.post("/api/flags", json={"entity_type": entity_type, "entity_id": str(entity_id),
                                        "type": type_, "title": title, **extra})
    assert r.status_code == 201, r.text
    return r.json()


def test_board_flags_endpoint_joins_every_anchor_under_visibility(client):
    _board(client, "org")
    client.as_user(ADMIN)
    bid = client.get("/api/boards/org").json()["id"]
    frame = client.post("/api/boards/org/nodes", json={"kind": "frame", "label": "Marketing", "w": 400, "h": 200}).json()
    note = client.post("/api/boards/org/nodes", json={"kind": "note", "label": "Q4", "parent_id": frame["id"],
                                                      "data": {"markdown": ""}}).json()
    ws = client.post("/api/boards/org/nodes", json={"kind": "entity", "entity_type": "worksheet", "entity_id": "1"}).json()
    _flag(client, "board", bid, "board task")
    _flag(client, "board_node", note["id"], "note blocker", type_="blocker")
    _flag(client, "worksheet", "1", "worksheet task")
    done = _flag(client, "board_node", frame["id"], "done one")
    client.post(f"/api/flags/{done['id']}/status", json={"status": "resolved"})
    client.as_user(VIEWER)
    rows = client.get("/api/boards/org/flags").json()
    assert sorted(f["title"] for f in rows) == ["board task", "note blocker", "worksheet task"]
    by_title = {f["title"]: f for f in rows}
    assert by_title["board task"]["entity"]["label"] == "Org"
    assert by_title["board task"]["entity"]["deep_link"] == {"kind": "board", "id": "org"}
    assert by_title["note blocker"]["entity"]["label"] == "Org > Q4"
    client.as_user(OUTSIDER)
    assert client.get("/api/boards/org/flags").status_code == 200  # company board: visible
    _board(client, "exec", "restricted", [{"group_id": client.editors, "can_edit": True}])
    client.as_user(OUTSIDER)
    assert client.get("/api/boards/exec/flags").status_code == 404


def test_list_carries_open_flag_count_for_board_and_item_anchors(client):
    _board(client, "org")
    _board(client, "exec", "restricted", [{"group_id": client.editors, "can_edit": True}])
    client.as_user(ADMIN)
    bid = client.get("/api/boards/org").json()["id"]
    note = client.post("/api/boards/org/nodes", json={"kind": "note", "label": "Q4", "data": {"markdown": ""}}).json()
    _flag(client, "board", bid, "a")
    _flag(client, "board_node", note["id"], "b")
    done = _flag(client, "board_node", note["id"], "c")
    client.post(f"/api/flags/{done['id']}/status", json={"status": "resolved"})
    rows = {b["slug"]: b for b in client.get("/api/boards").json()}
    assert rows["org"]["open_flag_count"] == 2
    assert rows["exec"]["open_flag_count"] == 0
```

If the status route in `backend/flags/routes.py` is not `POST /api/flags/{id}/status` with `{"status": ...}`, read the route list (`grep -n "@router.post\|@router.patch" backend/flags/routes.py`) and use the real one; the point is one resolved flag that must not count.

- [ ] **Step 2: Run them to confirm they fail**

Run: `cd backend && "$PY" -m pytest tests/test_boards_routes.py -q -p no:cacheprovider -k "board_flags or open_flag_count"`
Expected: FAIL (404 on `/api/boards/org/flags`; `KeyError: 'open_flag_count'`).

- [ ] **Step 3: Implement**

`backend/boards/schemas.py`, in `BoardOut` after `node_count`:

```python
    open_flag_count: int = 0
```

`backend/boards/service.py`, after `node_counts`:

```python
def open_flag_counts(db: Session, board_ids: Iterable[int]) -> dict[int, int]:
    """Open flags per board: those on the board itself plus those on its items. Entity
    anchors (a sample pinned to the board) are left out: their visibility is per viewer
    and the list is one query for everyone."""
    from flags.catalog import OPEN_STATES
    from flags.models import FlagFlag
    ids = list(board_ids)
    if not ids:
        return {}
    out: dict[int, int] = {}
    node_rows = db.execute(
        select(BoardNode.board_id, func.count())
        .select_from(FlagFlag)
        .join(BoardNode, cast(BoardNode.id, String) == FlagFlag.entity_id)
        .where(FlagFlag.entity_type == "board_node", FlagFlag.status.in_(OPEN_STATES),
               BoardNode.board_id.in_(ids))
        .group_by(BoardNode.board_id)).all()
    for bid, n in node_rows:
        out[bid] = out.get(bid, 0) + int(n)
    board_rows = db.execute(
        select(FlagFlag.entity_id, func.count())
        .where(FlagFlag.entity_type == "board", FlagFlag.entity_id.in_([str(i) for i in ids]),
               FlagFlag.status.in_(OPEN_STATES))
        .group_by(FlagFlag.entity_id)).all()
    for eid, n in board_rows:
        out[int(eid)] = out.get(int(eid), 0) + int(n)
    return out


def board_open_flags(db: Session, user, slug: str) -> list:
    """Open flags on every anchor of one board, under the caller's visibility (spec 14,
    slice 4d): the board, its generic items, and the entities behind its entity items."""
    from flags import seams
    from flags.catalog import OPEN_STATES
    from flags.models import FlagFlag
    board = get_board(db, user, slug)
    pairs = [("board", str(board.id))]
    for n in db.execute(select(BoardNode).where(BoardNode.board_id == board.id)).scalars():
        if n.kind == "entity" and n.entity_type and n.entity_id:
            pairs.append((n.entity_type, str(n.entity_id)))
        else:
            pairs.append(("board_node", str(n.id)))
    stmt = (select(FlagFlag)
            .where(FlagFlag.status.in_(OPEN_STATES), seams.visibility_clause(db, user),
                   or_(*[and_(FlagFlag.entity_type == et, FlagFlag.entity_id == eid) for et, eid in pairs]))
            .order_by(FlagFlag.updated_at.desc()))
    return list(db.execute(stmt).scalars().all())
```

Add `cast, String, and_, or_` to the sqlalchemy import at the top of `service.py` if missing (`func` and `select` are already imported).

`board_out`:

```python
def board_out(db: Session, user, board: Board, counts: Optional[dict] = None,
              flag_counts: Optional[dict] = None) -> BoardOut:
    out = BoardOut.model_validate(board)
    out.node_count = (counts or node_counts(db, [board.id])).get(board.id, 0)
    out.open_flag_count = (flag_counts or open_flag_counts(db, [board.id])).get(board.id, 0)
    out.can_edit = access.can_edit_board(db, user, board)
    return out
```

`backend/boards/routes.py`: the list route becomes

```python
@router.get("", response_model=List[BoardOut])
def list_boards(db: Session = Depends(get_db), user=Depends(get_current_user)):
    boards = service.list_boards(db, user)
    ids = [b.id for b in boards]
    counts = service.node_counts(db, ids)
    flag_counts = service.open_flag_counts(db, ids)
    return [service.board_out(db, user, b, counts, flag_counts) for b in boards]
```

and after `get_board` add (imports: `from flags.routes import _with_entities as with_entities` and `from flags.schemas import FlagResponse`):

```python
@router.get("/{slug}/flags", response_model=List[FlagResponse])
def board_flags(slug: str, db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Open flags on every anchor of the board, for the rollups, pills and the dock."""
    try:
        return with_entities(db, service.board_open_flags(db, user, slug))
    except Exception as e:
        raise http_error(e)
```

- [ ] **Step 4: Run the boards and flags suites**

Run: `cd backend && "$PY" -m pytest tests/test_boards_routes.py tests/test_boards_nodes.py tests/test_flags_board.py tests/test_flags_board_node.py tests/test_flags_visibility_enforcement.py -q -p no:cacheprovider`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(boards): one gated endpoint for every open flag on a board; open_flag_count on the list

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/boards/service.py backend/boards/schemas.py backend/boards/routes.py backend/tests/test_boards_routes.py
```

### Task 4: Frontend data layer: `useBoardFlags`, keys, glue, pure helpers

**Files:**
- Modify: `src/lib/api-boards.ts` (`Board.open_flag_count`, `listBoardFlags`)
- Modify: `src/hooks/use-flags.ts:47-62` (`flagKeys.boards`, `flagKeys.board`)
- Modify: `src/services/boards.ts` (`useBoardFlags`)
- Modify: `src/components/flags/use-flag-stream-glue.ts` (`enqueueInvalidations` standard set)
- Modify: `src/components/flags/__tests__/flag-stream-glue-invalidation.test.ts`
- Create: `src/components/boards/board-flags.ts`, `src/components/boards/__tests__/board-flags.test.ts`

**Interfaces:**
- Produces: `flagKeys.boards() -> ['flags','board']`, `flagKeys.board(slug) -> ['flags','board',slug]`; `useBoardFlags(slug: string | null)` (TanStack query of `FlagResponse[]`); helpers below. Later tasks import `nodeAnchor`, `flagsByAnchor`, `frameRollup`, `assignedCount`, `attentionList`, `dueLabel`, `locateTargetFor`, `blockingTypeSet` from `./board-flags`.

- [ ] **Step 1: Write the failing helper tests**

`src/components/boards/__tests__/board-flags.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  assignedCount,
  attentionList,
  blockingTypeSet,
  dueLabel,
  flagsByAnchor,
  frameRollup,
  locateTargetFor,
  nodeAnchor,
} from '@/components/boards/board-flags'
import type { BoardNode } from '@/lib/api-boards'
import type { FlagResponse } from '@/lib/flags-api'

const node = (o: Partial<BoardNode>): BoardNode => ({
  id: 1,
  board_id: 1,
  kind: 'note',
  label: 'N',
  parent_id: null,
  x: 0,
  y: 0,
  w: null,
  h: null,
  z: 0,
  entity_type: null,
  entity_id: null,
  data: null,
  version: 1,
  created_by: null,
  updated_by: null,
  created_at: '',
  updated_at: '',
  ...o,
})
const flag = (o: Partial<FlagResponse>): FlagResponse => ({
  id: 1,
  entity_type: 'board_node',
  entity_id: '1',
  kind: 'issue',
  type: 'task',
  status: 'open',
  title: 'T',
  created_by: 1,
  assignee_id: null,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  resolved_at: null,
  resolved_by: null,
  due_at: null,
  ...o,
})
const NOW = new Date('2026-10-12T12:00:00Z')
const blocking = new Set(['blocker'])

describe('board-flags', () => {
  it('anchors: a generic item by its node id, an entity item by its entity', () => {
    expect(nodeAnchor(node({ id: 7 }))).toBe('board_node:7')
    expect(
      nodeAnchor(node({ id: 8, kind: 'entity', entity_type: 'sample', entity_id: 'P-1' }))
    ).toBe('sample:P-1')
    const by = flagsByAnchor([flag({ id: 1, entity_id: '7' }), flag({ id: 2, entity_type: 'sample', entity_id: 'P-1' })])
    expect(by.get('board_node:7')?.map(f => f.id)).toEqual([1])
    expect(by.get('sample:P-1')?.map(f => f.id)).toEqual([2])
  })

  it('a frame rolls up its children, counting an entity child by its entity anchor (Review Focus 2)', () => {
    const nodes = [
      node({ id: 1, kind: 'frame' }),
      node({ id: 2, parent_id: 1 }),
      node({ id: 3, parent_id: 1, kind: 'entity', entity_type: 'sample', entity_id: 'P-1' }),
      node({ id: 4 }),
    ]
    const flags = [
      flag({ id: 10, entity_id: '2', type: 'blocker' }),
      flag({ id: 11, entity_type: 'sample', entity_id: 'P-1' }),
      flag({ id: 12, entity_id: '4' }),
      flag({ id: 13, entity_id: '1' }),
    ]
    // The frame's own flag counts too; the loose item (4) does not.
    expect(frameRollup(flags, nodes, 1, blocking)).toEqual({ blocking: 1, other: 2 })
    expect(frameRollup(flags, nodes, 4, blocking)).toEqual({ blocking: 0, other: 1 })
  })

  it('assigned count is per user over the board flags', () => {
    const flags = [flag({ assignee_id: 5 }), flag({ id: 2, assignee_id: 5 }), flag({ id: 3, assignee_id: 6 })]
    expect(assignedCount(flags, 5)).toBe(2)
    expect(assignedCount(flags, null)).toBe(0)
  })

  it('attention list: blocking or past due, overdue first by due date, then blocking by recency', () => {
    const flags = [
      flag({ id: 1, type: 'blocker', updated_at: '2026-10-10T00:00:00Z' }),
      flag({ id: 2, due_at: '2026-10-11T00:00:00Z' }),
      flag({ id: 3, due_at: '2026-10-09T00:00:00Z' }),
      flag({ id: 4, due_at: '2026-10-20T00:00:00Z' }),
      flag({ id: 5, type: 'blocker', updated_at: '2026-10-11T00:00:00Z' }),
    ]
    expect(attentionList(flags, blocking, NOW).map(f => f.id)).toEqual([3, 2, 5, 1])
  })

  it('due labels', () => {
    expect(dueLabel(null, NOW)).toBeNull()
    expect(dueLabel('2026-10-09T12:00:00Z', NOW)).toBe('overdue 3d')
    expect(dueLabel('2026-10-12T18:00:00Z', NOW)).toBe('due today')
    expect(dueLabel('2026-10-14T12:00:00Z', NOW)).toBe('due in 2d')
  })

  it('locate target: the item for board_node and entity anchors, none for the board', () => {
    const nodes = [node({ id: 1 }), node({ id: 2, kind: 'entity', entity_type: 'sample', entity_id: 'P-1' })]
    expect(locateTargetFor(flag({ entity_id: '1' }), nodes)).toBe(1)
    expect(locateTargetFor(flag({ entity_type: 'sample', entity_id: 'P-1' }), nodes)).toBe(2)
    expect(locateTargetFor(flag({ entity_type: 'board', entity_id: '9' }), nodes)).toBeNull()
    expect(locateTargetFor(flag({ entity_id: '99' }), nodes)).toBeNull()
  })

  it('blocking set reads is_blocking off the type list', () => {
    expect(blockingTypeSet([{ slug: 'blocker', is_blocking: true }, { slug: 'task', is_blocking: false }])).toEqual(new Set(['blocker']))
    expect(blockingTypeSet(undefined)).toEqual(new Set())
  })
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `node node_modules/vitest/vitest.mjs run src/components/boards/__tests__/board-flags.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the helpers**

`src/components/boards/board-flags.ts`:

```ts
import type { BoardNode } from '@/lib/api-boards'
import type { FlagResponse } from '@/lib/flags-api'

/** Anchor key `type:id` for a flag or a node. */
export const anchorKey = (type: string | null, id: string | null) =>
  `${type ?? ''}:${id ?? ''}`

/** A generic item is anchored by its node id; an entity item by the entity behind it. */
export function nodeAnchor(
  node: Pick<BoardNode, 'id' | 'kind' | 'entity_type' | 'entity_id'>
): string {
  return node.kind === 'entity' && node.entity_type && node.entity_id
    ? anchorKey(node.entity_type, node.entity_id)
    : anchorKey('board_node', String(node.id))
}

export function flagsByAnchor(flags: FlagResponse[]): Map<string, FlagResponse[]> {
  const out = new Map<string, FlagResponse[]>()
  for (const f of flags) {
    const k = anchorKey(f.entity_type, f.entity_id)
    out.set(k, [...(out.get(k) ?? []), f])
  }
  return out
}

export function blockingTypeSet(
  types: { slug: string; is_blocking: boolean }[] | undefined
): ReadonlySet<string> {
  return new Set((types ?? []).filter(t => t.is_blocking).map(t => t.slug))
}

/** Open flags on a frame and everything inside it (spec 8.3 rollup pills). */
export function frameRollup(
  flags: FlagResponse[],
  nodes: BoardNode[],
  frameId: number,
  blocking: ReadonlySet<string>
): { blocking: number; other: number } {
  const by = flagsByAnchor(flags)
  const anchors = [
    anchorKey('board_node', String(frameId)),
    ...nodes.filter(n => n.parent_id === frameId).map(nodeAnchor),
  ]
  let b = 0
  let o = 0
  for (const a of anchors)
    for (const f of by.get(a) ?? []) {
      if (blocking.has(f.type)) b += 1
      else o += 1
    }
  return { blocking: b, other: o }
}

export function assignedCount(flags: FlagResponse[], userId: number | null): number {
  return userId == null ? 0 : flags.filter(f => f.assignee_id === userId).length
}

const DAY = 86_400_000

/** 'overdue Nd', 'due today', 'due in Nd', or null without a due date. */
export function dueLabel(due: string | null, now: Date): string | null {
  if (!due) return null
  const days = Math.floor((new Date(due).getTime() - now.getTime()) / DAY)
  if (days < 0) return `overdue ${-days}d`
  if (days === 0) return 'due today'
  return `due in ${days}d`
}

/** Blocking or past-due flags, overdue first (earliest due first), then blocking by recency (spec 8.6). */
export function attentionList(
  flags: FlagResponse[],
  blocking: ReadonlySet<string>,
  now: Date
): FlagResponse[] {
  const overdue = (f: FlagResponse) => !!f.due_at && new Date(f.due_at).getTime() < now.getTime()
  const picked = flags.filter(f => overdue(f) || blocking.has(f.type))
  return picked.sort((a, b) => {
    const oa = overdue(a)
    const ob = overdue(b)
    if (oa !== ob) return oa ? -1 : 1
    if (oa && ob) return new Date(a.due_at as string).getTime() - new Date(b.due_at as string).getTime()
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  })
}

/** The node to centre for a flag: the item for board_node and entity anchors, none for the board. */
export function locateTargetFor(flag: FlagResponse, nodes: BoardNode[]): number | null {
  if (flag.entity_type === 'board_node') {
    const id = Number(flag.entity_id)
    return nodes.some(n => n.id === id) ? id : null
  }
  if (flag.entity_type === 'board' || !flag.entity_type || !flag.entity_id) return null
  const hit = nodes.find(
    n => n.kind === 'entity' && n.entity_type === flag.entity_type && n.entity_id === flag.entity_id
  )
  return hit ? hit.id : null
}
```

`src/lib/api-boards.ts`: add `open_flag_count: number` to `Board` (after `node_count`), import `type FlagResponse` from `'@/lib/flags-api'`, and append:

```ts
/** Open flags on every anchor of the board (the board, its items, the entities behind entity items). */
export function listBoardFlags(slug: string): Promise<FlagResponse[]> {
  return apiFetch<FlagResponse[]>(`/api/boards/${encodeURIComponent(slug)}/flags`)
}
```

`src/hooks/use-flags.ts`, inside `flagKeys` after `entityScope`:

```ts
  // Open flags of every anchor on one board (planning boards slice 4). Under
  // ['flags', 'board'] so the stream glue refreshes mounted boards with its standard set.
  boards: () => ['flags', 'board'] as const,
  board: (slug: string) => ['flags', 'board', slug] as const,
```

`src/services/boards.ts` (import `listBoardFlags` from `@/lib/api-boards` and `flagKeys` from `@/hooks/use-flags`):

```ts
/** Every open flag on the board, once; nodes, the dock and the header read this one query. */
export function useBoardFlags(slug: string | null) {
  return useQuery({
    queryKey: flagKeys.board(slug ?? ''),
    queryFn: () => listBoardFlags(slug as string),
    enabled: slug != null,
    staleTime: 5_000,
  })
}
```

`src/components/flags/use-flag-stream-glue.ts`, in `enqueueInvalidations` right after `mark(flagKeys.activity())`:

```ts
    // Mounted board pages (at most one) hold every flag on that board: refresh them too.
    mark(flagKeys.boards())
```

Add to `flag-stream-glue-invalidation.test.ts` inside the describe:

```ts
  it('every event refreshes mounted board flag queries (planning boards)', async () => {
    await mountGlue()
    handler(evt({ flag: { entity_type: 'sample', entity_id: 'P-1' } }))
    vi.advanceTimersByTime(300)
    expect(hasKey(['flags', 'board'])).toBe(true)
  })
```

The test's `evt` helper builds standard events; a general-task event (both anchor parts absent) must also mark the key, which the standard-set placement guarantees.

- [ ] **Step 4: Run the gates**

Run: `node node_modules/vitest/vitest.mjs run src/components/boards/__tests__/board-flags.test.ts src/components/flags/__tests__/flag-stream-glue-invalidation.test.ts && node node_modules/typescript/bin/tsc --noEmit && node node_modules/eslint/bin/eslint.js src/components/boards/board-flags.ts src/lib/api-boards.ts src/hooks/use-flags.ts src/services/boards.ts src/components/flags/use-flag-stream-glue.ts && node node_modules/prettier/bin/prettier.cjs --check src/components/boards src/lib/api-boards.ts src/hooks/use-flags.ts src/services/boards.ts src/components/flags/use-flag-stream-glue.ts`
Expected: tests PASS, tsc clean, eslint clean, prettier clean (run `--write` on the new files first if needed).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(boards): board flags query, keys, glue refresh and the pure rollup helpers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/lib/api-boards.ts src/hooks/use-flags.ts src/services/boards.ts src/components/flags/use-flag-stream-glue.ts src/components/flags/__tests__/flag-stream-glue-invalidation.test.ts src/components/boards/board-flags.ts src/components/boards/__tests__/board-flags.test.ts
```

### Task 5: Rollup pills on frames, entity items and person cards

**Files:**
- Modify: `src/components/boards/nodes/FrameNode.tsx`, `EntityNode.tsx`, `PersonNode.tsx`
- Create: `src/components/boards/__tests__/FrameNode.test.tsx`
- Modify: `src/components/boards/__tests__/PersonNode.test.tsx`

**Interfaces:**
- Consumes: `useBoardFlags(slug)`, `useBoard(slug)` from `@/services/boards`; `useFlagTypes({})` from `@/services/flag-types` (returns `{ data?: { slug: string; is_blocking: boolean }[] }`); helpers from `../board-flags`; `useAuthStore` for the current user id is NOT needed (the person card counts flags assigned to the card's user).
- Produces: pills with `data-testid="frame-pill-blocking"`, `data-testid="frame-pill-open"`, `data-testid="entity-pill"`, `data-testid="person-pill"`.

- [ ] **Step 1: Write the failing tests**

`src/components/boards/__tests__/FrameNode.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

vi.mock('@xyflow/react', () => ({ NodeResizeControl: () => null }))
const h = vi.hoisted(() => ({
  flags: [] as unknown[],
  nodes: [] as unknown[],
}))
vi.mock('@/services/boards', () => ({
  usePatchNode: () => ({ mutate: vi.fn(), isPending: false }),
  useBoardFlags: () => ({ data: h.flags }),
  useBoard: () => ({ data: { nodes: h.nodes } }),
}))
vi.mock('@/services/flag-types', () => ({
  useFlagTypes: () => ({ data: [{ slug: 'blocker', is_blocking: true }, { slug: 'task', is_blocking: false }] }),
}))

import { FrameNode } from '@/components/boards/nodes/FrameNode'

const row = {
  id: 1, board_id: 1, kind: 'frame' as const, label: 'Marketing', parent_id: null, x: 0, y: 0,
  w: 400, h: 200, z: 0, entity_type: null, entity_id: null, data: { color: 'purple' },
  version: 1, created_by: null, updated_by: null, created_at: '', updated_at: '',
}
const flag = (o: object) => ({
  id: 1, entity_type: 'board_node', entity_id: '2', kind: 'issue', type: 'task', status: 'open',
  title: 'T', created_by: 1, assignee_id: null, created_at: '', updated_at: '', resolved_at: null,
  resolved_by: null, due_at: null, ...o,
})

describe('FrameNode rollup pills', () => {
  it('shows blocking and open counts for the frame and its children, nothing when empty', () => {
    h.nodes = [row, { ...row, id: 2, kind: 'note', parent_id: 1 }, { ...row, id: 3, kind: 'note', parent_id: null }]
    h.flags = [flag({ id: 1, entity_id: '2', type: 'blocker' }), flag({ id: 2, entity_id: '1' }), flag({ id: 3, entity_id: '3' })]
    render(<FrameNode id="1" data={{ row, canEdit: false, slug: 'org' }} selected={false} />)
    expect(screen.getByTestId('frame-pill-blocking')).toHaveTextContent('1 blocking')
    expect(screen.getByTestId('frame-pill-open')).toHaveTextContent('1 open')
  })

  it('renders no pills without flags', () => {
    h.nodes = [row]
    h.flags = []
    render(<FrameNode id="1" data={{ row, canEdit: false, slug: 'org' }} selected={false} />)
    expect(screen.queryByTestId('frame-pill-blocking')).toBeNull()
    expect(screen.queryByTestId('frame-pill-open')).toBeNull()
  })
})
```

`FrameNode` takes the full `NodeProps`; if tsc rejects the test's props, change the component signature to `Pick<NodeProps<BoardFlowNode>, 'data' | 'selected'>` (the LinkNode and PersonNode precedent) rather than padding the test.

Add to `PersonNode.test.tsx` (extend its `@/services/groups` mock file with a `@/services/boards` mock returning `useBoardFlags: () => ({ data: h.flags })`):

```tsx
  it('shows how many of the board flags are assigned to this person', () => {
    h.flags = [
      { id: 1, assignee_id: 4, entity_type: 'board_node', entity_id: '9', type: 'task', status: 'open' },
      { id: 2, assignee_id: 4, entity_type: 'board', entity_id: '1', type: 'task', status: 'open' },
      { id: 3, assignee_id: 7, entity_type: 'board_node', entity_id: '9', type: 'task', status: 'open' },
    ]
    render(<PersonNode data={data({ user_id: 4 })} />)
    expect(screen.getByTestId('person-pill')).toHaveTextContent('2 assigned')
  })
```

(declare `const h = vi.hoisted(() => ({ flags: [] as unknown[] }))` at the top of that file and reset `h.flags = []` in the existing tests so they stay pill-free.)

- [ ] **Step 2: Run to confirm they fail**

Run: `node node_modules/vitest/vitest.mjs run src/components/boards/__tests__/FrameNode.test.tsx src/components/boards/__tests__/PersonNode.test.tsx`
Expected: FAIL (missing test ids; `useBoardFlags` not imported by the nodes).

- [ ] **Step 3: Implement the pills**

`FrameNode.tsx`: import `useBoard, useBoardFlags, usePatchNode` from `@/services/boards`, `useFlagTypes` from `@/services/flag-types`, `blockingTypeSet, frameRollup` from `../board-flags`. Inside the component:

```tsx
  const flags = useBoardFlags(data.slug ?? null)
  const board = useBoard(data.slug ?? null)
  const types = useFlagTypes({})
  const roll = frameRollup(
    flags.data ?? [],
    board.data?.nodes ?? [],
    data.row.id,
    blockingTypeSet(types.data)
  )
```

and replace the title line with:

```tsx
      <div className="flex items-center gap-2 px-3 py-2 text-sm font-medium">
        <span className="truncate">{data.row.label}</span>
        {roll.blocking > 0 && (
          <span
            data-testid="frame-pill-blocking"
            className="rounded-full bg-red-600 px-1.5 text-[10px] font-semibold text-white"
          >
            {roll.blocking} blocking
          </span>
        )}
        {roll.other > 0 && (
          <span
            data-testid="frame-pill-open"
            className="rounded-full bg-amber-500 px-1.5 text-[10px] font-semibold text-white"
          >
            {roll.other} open
          </span>
        )}
      </div>
```

`EntityNode.tsx`: import `useBoardFlags`, `useFlagTypes`, `anchorKey, blockingTypeSet, flagsByAnchor` (use `nodeAnchor(row)`); compute

```tsx
  const flags = useBoardFlags(data.slug ?? null)
  const types = useFlagTypes({})
  const mine = flagsByAnchor(flags.data ?? []).get(nodeAnchor(row)) ?? []
  const blocking = blockingTypeSet(types.data)
  const hasBlocking = mine.some(f => blocking.has(f.type))
```

and after the label block render

```tsx
      {mine.length > 0 && (
        <span
          data-testid="entity-pill"
          className={`ml-1 rounded-full px-1.5 text-[10px] font-semibold text-white ${hasBlocking ? 'bg-red-600' : 'bg-amber-500'}`}
        >
          {mine.length} open
        </span>
      )}
```

`PersonNode.tsx`: import `useBoardFlags`, `assignedCount`; `const flags = useBoardFlags(data.slug ?? null)`; `const assigned = assignedCount(flags.data ?? [], Number(d.user_id) || null)`; after the name/title column:

```tsx
      {assigned > 0 && (
        <span
          data-testid="person-pill"
          className="rounded-full bg-amber-500 px-1.5 text-[10px] font-semibold text-white"
        >
          {assigned} assigned
        </span>
      )}
```

`toFlowNodes` already passes `slug` in node data for every node (check `board-mapping.ts:35-43`: `data: { row, canEdit, slug }`), so `data.slug` is set on all kinds.

- [ ] **Step 4: Run the gates**

Run: `node node_modules/vitest/vitest.mjs run src/components/boards && node node_modules/typescript/bin/tsc --noEmit && node node_modules/eslint/bin/eslint.js src/components/boards && node node_modules/prettier/bin/prettier.cjs --check src/components/boards`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(boards): rollup pills on frames, entity items and person cards

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/components/boards/nodes/FrameNode.tsx src/components/boards/nodes/EntityNode.tsx src/components/boards/nodes/PersonNode.tsx src/components/boards/__tests__/FrameNode.test.tsx src/components/boards/__tests__/PersonNode.test.tsx
```

### Task 6: Attention dock, header Raise flag, board card count, `board` deep link

**Files:**
- Create: `src/components/boards/AttentionDock.tsx`, `src/components/boards/__tests__/AttentionDock.test.tsx`
- Modify: `src/components/boards/BoardSidePanel.tsx:36-47` (idle state), `BoardPage.tsx` (header button, dock locate), `BoardsPage.tsx:76-86` (count), `src/components/flags/flag-entity.ts:52,139-165` (`board` meta + deep link)
- Modify: `src/components/boards/__tests__/BoardSidePanel.test.tsx`, `BoardsPage.test.tsx`

**Interfaces:**
- Consumes: `useBoardFlags`, `useFlagTypes`, `attentionList`, `dueLabel`, `locateTargetFor`, `FlagCard` (`{ flag: FlagResponse }`), `Collapsible`/`CollapsibleTrigger`/`CollapsibleContent` from `@/components/ui/collapsible`, `useUIStore().setPendingBoardNode(id: string | null)`.
- Produces: `AttentionDock({ board: BoardDetail })`; `BoardSidePanel` renders it when `selectedId` is null; `ENTITY_META.board`; `navigateToDeepLink({ kind: 'board', id: slug })`.

- [ ] **Step 1: Write the failing tests**

`src/components/boards/__tests__/AttentionDock.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ flags: [] as unknown[], pending: vi.fn() }))
vi.mock('@/services/boards', () => ({ useBoardFlags: () => ({ data: h.flags, isLoading: false }) }))
vi.mock('@/services/flag-types', () => ({
  useFlagTypes: () => ({ data: [{ slug: 'blocker', is_blocking: true }, { slug: 'task', is_blocking: false }] }),
}))
vi.mock('@/components/flags/FlagCard', () => ({
  FlagCard: ({ flag }: { flag: { title: string } }) => <div>{flag.title}</div>,
}))
vi.mock('@/store/ui-store', () => ({
  useUIStore: Object.assign((sel: (s: { setPendingBoardNode: typeof h.pending }) => unknown) => sel({ setPendingBoardNode: h.pending }), {
    getState: () => ({ setPendingBoardNode: h.pending }),
  }),
}))

import { AttentionDock } from '@/components/boards/AttentionDock'

const board = {
  id: 1, slug: 'org', name: 'Org', kind: 'map', visibility: 'company', created_by: 1,
  default_viewport: null, node_count: 2, open_flag_count: 2, can_edit: true, created_at: '', updated_at: '',
  nodes: [
    { id: 1, board_id: 1, kind: 'note', label: 'Q4', parent_id: null, x: 0, y: 0, w: null, h: null, z: 0,
      entity_type: null, entity_id: null, data: null, version: 1, created_by: null, updated_by: null, created_at: '', updated_at: '' },
  ],
  edges: [],
  grants: [],
} as never
const flag = (o: object) => ({
  id: 1, entity_type: 'board_node', entity_id: '1', kind: 'issue', type: 'task', status: 'open', title: 'T',
  created_by: 1, assignee_id: null, created_at: '', updated_at: '2026-10-01T00:00:00Z', resolved_at: null,
  resolved_by: null, due_at: null, ...o,
})

describe('AttentionDock', () => {
  beforeEach(() => h.pending.mockReset())

  it('lists blocking and overdue flags, overdue first, with Locate for item anchors only', async () => {
    const user = userEvent.setup()
    h.flags = [
      flag({ id: 1, title: 'Blocker on note', type: 'blocker' }),
      flag({ id: 2, title: 'Overdue on board', entity_type: 'board', entity_id: '1', due_at: '2020-01-01T00:00:00Z' }),
      flag({ id: 3, title: 'Plain task' }),
    ]
    render(<AttentionDock board={board} />)
    expect(screen.getByText(/Needs attention \(2\)/)).toBeInTheDocument()
    const titles = screen.getAllByText(/Blocker on note|Overdue on board/).map(e => e.textContent)
    expect(titles).toEqual(['Overdue on board', 'Blocker on note'])
    expect(screen.queryByText('Plain task')).toBeNull()
    const locate = screen.getAllByRole('button', { name: 'Locate' })
    expect(locate).toHaveLength(1)
    await user.click(locate[0] as HTMLElement)
    expect(h.pending).toHaveBeenCalledWith('1')
  })

  it('says so when nothing needs attention', () => {
    h.flags = [flag({ id: 3, title: 'Plain task' })]
    render(<AttentionDock board={board} />)
    expect(screen.getByText(/Nothing needs attention/)).toBeInTheDocument()
  })
})
```

Add to `BoardSidePanel.test.tsx` (mock `@/components/boards/AttentionDock` as `AttentionDock: () => <div>dock</div>`):

```tsx
  it('shows the attention dock when nothing is selected', () => {
    render(
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      <BoardSidePanel board={board(true)} selectedId={null} onClose={() => {}} />
    )
    expect(screen.getByText('dock')).toBeInTheDocument()
  })
```

Add to `BoardsPage.test.tsx` (its boards mock already lists two boards; give the first `open_flag_count: 3` and the second `0`):

```tsx
  it('shows the open-flag count on a card', async () => {
    render(<BoardsPage />)
    expect(await screen.findByText('3 open flags')).toBeInTheDocument()
    expect(screen.queryByText('0 open flags')).toBeNull()
  })
```

- [ ] **Step 2: Run to confirm they fail**

Run: `node node_modules/vitest/vitest.mjs run src/components/boards/__tests__/AttentionDock.test.tsx src/components/boards/__tests__/BoardSidePanel.test.tsx src/components/boards/__tests__/BoardsPage.test.tsx`
Expected: FAIL (module missing; dock text missing; count missing).

- [ ] **Step 3: Implement**

`src/components/boards/AttentionDock.tsx`:

```tsx
import { useState } from 'react'
import { ChevronDown, ChevronRight, Crosshair } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { FlagCard } from '@/components/flags/FlagCard'
import { useBoardFlags } from '@/services/boards'
import { useFlagTypes } from '@/services/flag-types'
import { useUIStore } from '@/store/ui-store'
import type { BoardDetail } from '@/lib/api-boards'
import {
  attentionList,
  blockingTypeSet,
  dueLabel,
  locateTargetFor,
} from './board-flags'

/** Blocking or past-due flags on this board, overdue first (spec 8.6). Lives in the
 *  side panel's idle state; Locate centres the item through the one-shot pending node. */
export function AttentionDock({ board }: { board: BoardDetail }) {
  const flags = useBoardFlags(board.slug)
  const types = useFlagTypes({})
  const setPendingBoardNode = useUIStore(s => s.setPendingBoardNode)
  const [open, setOpen] = useState(true)
  // Read once into state (React Compiler: no impure reads during render).
  const [now] = useState(() => new Date())
  const rows = attentionList(flags.data ?? [], blockingTypeSet(types.data), now)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-1 text-left text-xs font-medium text-muted-foreground"
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          Needs attention ({rows.length})
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 space-y-2">
        {rows.length === 0 && (
          <p className="text-xs text-muted-foreground">Nothing needs attention.</p>
        )}
        {rows.map(f => {
          const target = locateTargetFor(f, board.nodes)
          const due = dueLabel(f.due_at, now)
          return (
            <div key={f.id} className="space-y-1">
              <FlagCard flag={f} />
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                {due && <span className={due.startsWith('overdue') ? 'text-red-600' : ''}>{due}</span>}
                {f.entity?.label && <span className="truncate">{f.entity.label}</span>}
                {target != null && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto h-6 px-2 text-[11px]"
                    onClick={() => setPendingBoardNode(String(target))}
                  >
                    <Crosshair className="mr-1 h-3 w-3" />
                    Locate
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </CollapsibleContent>
    </Collapsible>
  )
}
```

`BoardSidePanel.tsx`: the idle branch becomes

```tsx
  if (!node) {
    return (
      <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 text-sm">
        <AttentionDock board={board} />
        <p className="text-xs text-muted-foreground">
          Select an item to see its flags and details.
        </p>
      </div>
    )
  }
```

(import `AttentionDock` from `./AttentionDock`). The canvas already selects and centres the pending node (`BoardCanvas.tsx` effect on `pendingBoardNode`), so Locate needs nothing else.

`BoardPage.tsx` header, after the `view only` span and before `<span className="flex-1" />`, for editors:

```tsx
        {canEdit && (
          <RaiseFlagButton
            entityType="board"
            entityId={String(b.id)}
            targetLabel={b.name}
            variant="compact"
          />
        )}
```

(import `RaiseFlagButton` from `@/components/flags/RaiseFlagButton`.)

`BoardsPage.tsx` card, after the `{board.node_count} items` span:

```tsx
        {board.open_flag_count > 0 && (
          <Badge variant="destructive">
            {board.open_flag_count} open flag{board.open_flag_count === 1 ? '' : 's'}
          </Badge>
        )}
```

`src/components/flags/flag-entity.ts`: add `board: { Icon: Map, label: 'Board', canDeepLink: true },` after `board_node`, and a deep-link case before `default`:

```ts
    case 'board':
      store.closeFlagsFlyout()
      store.navigateToBoard(deepLink.id)
      return true
```

- [ ] **Step 4: Run the gates**

Run: `node node_modules/vitest/vitest.mjs run src/components/boards src/components/flags/__tests__/flag-entity.test.ts && node node_modules/typescript/bin/tsc --noEmit && node node_modules/eslint/bin/eslint.js src/components/boards src/components/flags/flag-entity.ts && node node_modules/prettier/bin/prettier.cjs --check src/components/boards src/components/flags/flag-entity.ts`
Expected: green (if `flag-entity.test.ts` does not exist, drop it from the command).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(boards): attention dock, raise a flag on the board, open-flag count on cards, board deep link

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/components/boards/AttentionDock.tsx src/components/boards/__tests__/AttentionDock.test.tsx src/components/boards/BoardSidePanel.tsx src/components/boards/__tests__/BoardSidePanel.test.tsx src/components/boards/BoardPage.tsx src/components/boards/BoardsPage.tsx src/components/boards/__tests__/BoardsPage.test.tsx src/components/flags/flag-entity.ts
```

### Task 7: PR A end-to-end on a devbox stack, PR

**Files:**
- Create: `e2e/planning-boards-live.spec.ts` (tests 1 to 6)
- Create: `docs/superpowers/evidence/2026-10-12-planning-boards-live/` (screenshots + `api-summary.json`)

**Interfaces:**
- Consumes: the stack recipe (memory `project_mk1_playwright_e2e_suite`): devbox `forrestparker@100.73.137.3`, `./bin/accumark-stack create s4live`, worktree `~/worktrees/Accu-Mk1-s4live` on `origin/feat/planning-boards-s4d`, `mount s4live --mk1 ~/worktrees/Accu-Mk1-s4live`, creds into `/c/tmp/s4live-e2e.env` (E2E_EMAIL, E2E_PASSWORD, E2E_BASE_URL, E2E_BACKEND_URL), sourced in every Bash call, deleted at the end.

- [ ] **Step 1: Write the spec**

Model on `e2e/planning-boards-layout.spec.ts` (same `token`, `bearer`, `shot`, `record`, `open` helpers; `SHOTS` default `docs/superpowers/evidence/2026-10-12-planning-boards-live`; `test.use({ viewport: { width: 1400, height: 900 } })`; serial). Tests:

1. `seed`: company board `live-<run>` with a frame, a note inside it, a loose person (first directory user), an entity item for the first document code if one exists; through `POST /api/flags`: a `blocker` on the note, a `task` on the frame with `due_at` two days ago, a `task` on the board (`entity_type: 'board'`, `entity_id: board.id`), and one resolved task on the note (raise, then set status resolved through the status route used by the backend test). Record ids.
2. `endpoint`: `GET /api/boards/<slug>/flags` returns exactly the three open ones; `GET /api/boards` row has `open_flag_count === 3`.
3. `pills`: open the board; the frame node (`.react-flow__node-frame`) contains `1 blocking` and `1 open`; screenshot `01-frame-pills.png`.
4. `dock`: with nothing selected the side panel shows `Needs attention (2)` with the overdue frame task above the blocker (assert by order of `getByText`), the board task is absent from the dock, screenshot `02-attention-dock.png`; click `Locate` on the first row; the side panel header now shows `Marketing` (the frame is selected).
5. `raise on the board`: the header has a `Raise flag` button for the editor (`getByRole('button', { name: /raise flag/i })` exact: true if the side panel is closed, else `first()`); through the API as a standard user outside any group on a restricted board the same `POST /api/flags {entity_type:'board'}` answers 404 (seed a restricted board + group first, reuse the slice 2 spec's recipe), as an editor 201.
6. `board card`: `#boards/overview` card for the seeded board shows `3 open flags`; screenshot `03-board-card-count.png`.

- [ ] **Step 2: Stand up the stack and run**

```bash
ssh forrestparker@100.73.137.3 'cd ~/accumark-stack && ./bin/accumark-stack create s4live && ./bin/accumark-stack validate s4live | tail -1'
ssh forrestparker@100.73.137.3 'git -C ~/accumark-repos/Accu-Mk1 fetch origin feat/planning-boards-s4d:refs/remotes/origin/feat/planning-boards-s4d && git -C ~/accumark-repos/Accu-Mk1 worktree add --detach ~/worktrees/Accu-Mk1-s4live origin/feat/planning-boards-s4d && cd ~/accumark-stack && ./bin/accumark-stack mount s4live --mk1 ~/worktrees/Accu-Mk1-s4live'
# creds -> /c/tmp/s4live-e2e.env (awk the Password line; never print it), then:
set -a && . /c/tmp/s4live-e2e.env && set +a && node node_modules/@playwright/test/cli.js test planning-boards-live --reporter=list
```

Expected: 6 passed; PNGs and `api-summary.json` in the evidence dir.

- [ ] **Step 3: Commit spec + evidence, push, open the PR**

```bash
git commit -m "test(e2e): flags on the board: endpoint, pills, dock, raise on the board, card count

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- e2e/planning-boards-live.spec.ts docs/superpowers/evidence/2026-10-12-planning-boards-live/
git push -u origin feat/planning-boards-s4d
gh pr create --repo Zstar0/Accu-Mk1 --base master --head feat/planning-boards-s4d --title "Planning boards slice 4d: flags on the board" --body-file <body>
```

PR body: what lands (Task 1 changelog text), evidence images by raw URL, gates (backend suites, vitest boards + flags, tsc/eslint/prettier), the independent review verdict, "no schema change, no env change".

Delete `/c/tmp/s4live-e2e.env` after the run. Keep the stack up for PR B.

---

## PR B: canvas live

Branch `feat/planning-boards-s4e` from `feat/planning-boards-s4d`.

### Task 8: Zoom-semantic rendering

**Files:**
- Create: `src/components/boards/nodes/use-compact.ts`
- Modify: `src/components/boards/nodes/NoteNode.tsx`, `EntityNode.tsx`, `PersonNode.tsx`
- Modify: `src/components/boards/__tests__/PersonNode.test.tsx`, create `__tests__/NoteNode.test.tsx`

**Interfaces:**
- Produces: `useCompact(): boolean` (true below zoom 0.5, read from the xyflow store); compact nodes render the label line only and set `data-compact="true"` on their root.

- [ ] **Step 1: Write the failing tests**

`src/components/boards/__tests__/NoteNode.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

const h = vi.hoisted(() => ({ zoom: 1 }))
vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
  NodeResizeControl: () => null,
  useStore: (sel: (s: { transform: number[] }) => unknown) => sel({ transform: [0, 0, h.zoom] }),
}))
vi.mock('@/services/boards', () => ({ usePatchNode: () => ({ mutate: vi.fn(), isPending: false }) }))

import { NoteNode } from '@/components/boards/nodes/NoteNode'

const row = {
  id: 9, board_id: 1, kind: 'note' as const, label: 'Q4', parent_id: null, x: 0, y: 0, w: null, h: null, z: 0,
  entity_type: null, entity_id: null, data: { markdown: 'body text here' }, version: 1, created_by: null,
  updated_by: null, created_at: '', updated_at: '',
}

describe('NoteNode', () => {
  it('renders the body at normal zoom', () => {
    h.zoom = 1
    render(<NoteNode data={{ row, canEdit: false }} selected={false} />)
    expect(screen.getByText('body text here')).toBeInTheDocument()
  })
  it('hides the body below 0.5 zoom and keeps the title', () => {
    h.zoom = 0.3
    render(<NoteNode data={{ row, canEdit: false }} selected={false} />)
    expect(screen.getByText('Q4')).toBeInTheDocument()
    expect(screen.queryByText('body text here')).toBeNull()
  })
})
```

Extend the `@xyflow/react` mock in `PersonNode.test.tsx` with the same `useStore` (zoom 1) and add:

```tsx
  it('drops the title line when compact', () => {
    h.zoom = 0.3
    render(<PersonNode data={data({ user_id: 4 })} />)
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.queryByText('Lab Director')).toBeNull()
  })
```

(`h` in that file gains `zoom: 1`; set `h.zoom = 1` in the existing tests.)

- [ ] **Step 2: Run to confirm they fail**

Run: `node node_modules/vitest/vitest.mjs run src/components/boards/__tests__/NoteNode.test.tsx src/components/boards/__tests__/PersonNode.test.tsx`
Expected: the compact cases FAIL.

- [ ] **Step 3: Implement**

`src/components/boards/nodes/use-compact.ts`:

```ts
import { useStore } from '@xyflow/react'

export const COMPACT_BELOW = 0.5

/** Below this zoom, items show their label only (spec 8.3 zoom-semantic rendering). */
export function useCompact(): boolean {
  return useStore(s => s.transform[2] < COMPACT_BELOW)
}
```

`NoteNode.tsx`: `const compact = useCompact()`; add `data-compact={compact || undefined}` on the root; wrap the markdown `<div>` in `{!compact && (...)}`. `EntityNode.tsx`: wrap the `meta.label` line and the pill in `{!compact && ...}`. `PersonNode.tsx`: wrap the title `<span>` in `{!compact && ...}`. Frames and text nodes are unchanged.

- [ ] **Step 4: Run the gates**

Run: `node node_modules/vitest/vitest.mjs run src/components/boards && node node_modules/typescript/bin/tsc --noEmit && node node_modules/eslint/bin/eslint.js src/components/boards && node node_modules/prettier/bin/prettier.cjs --check src/components/boards`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(boards): items render label-only below 0.5 zoom

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/components/boards/nodes/use-compact.ts src/components/boards/nodes/NoteNode.tsx src/components/boards/nodes/EntityNode.tsx src/components/boards/nodes/PersonNode.tsx src/components/boards/__tests__/NoteNode.test.tsx src/components/boards/__tests__/PersonNode.test.tsx
```

### Task 9: Note resize, persisted

**Files:**
- Modify: `src/components/boards/board-mapping.ts:44-54` (`toFlowNodes`: notes default width), `src/components/boards/nodes/NoteNode.tsx`
- Modify: `src/components/boards/__tests__/board-mapping.test.ts`, `__tests__/NoteNode.test.tsx`

- [ ] **Step 1: Write the failing tests**

`board-mapping.test.ts`:

```ts
  it('a note without a stored size gets the default width so its box is resizable', () => {
    const [note] = toFlowNodes([row({ id: 3, kind: 'note' })], true)
    expect(note?.style).toEqual({ width: 240 })
    const [sized] = toFlowNodes([row({ id: 4, kind: 'note', w: 320, h: 140 })], true)
    expect(sized?.style).toEqual({ width: 320, height: 140 })
  })
```

`NoteNode.test.tsx` (replace the `NodeResizeControl` mock with one that renders a button calling `onResizeEnd`):

```tsx
vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
  NodeResizeControl: ({ onResizeEnd }: { onResizeEnd: (e: unknown, p: { width: number; height: number }) => void }) => (
    <button onClick={() => onResizeEnd(null, { width: 300, height: 120 })}>grip</button>
  ),
  useStore: (sel: (s: { transform: number[] }) => unknown) => sel({ transform: [0, 0, h.zoom] }),
}))
const patch = vi.hoisted(() => vi.fn())
vi.mock('@/services/boards', () => ({ usePatchNode: () => ({ mutate: patch, isPending: false }) }))
```

and the test:

```tsx
  it('editors resize a selected note from its corner and the size is saved with the version', () => {
    h.zoom = 1
    render(<NoteNode data={{ row, canEdit: true, slug: 'org' }} selected />)
    screen.getByRole('button', { name: 'grip' }).click()
    expect(patch).toHaveBeenCalledWith({ id: 9, data: { w: 300, h: 120, version: 1 } })
  })
  it('viewers get no grip', () => {
    render(<NoteNode data={{ row, canEdit: false, slug: 'org' }} selected />)
    expect(screen.queryByRole('button', { name: 'grip' })).toBeNull()
  })
```

- [ ] **Step 2: Run to confirm they fail**

Run: `node node_modules/vitest/vitest.mjs run src/components/boards/__tests__/board-mapping.test.ts src/components/boards/__tests__/NoteNode.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`board-mapping.ts` `toFlowNodes`, replace the `else if (row.w != null || row.h != null)` branch with:

```ts
      } else if (row.kind === 'note') {
        // Notes always carry a width so the corner grip has a box to resize; height stays auto until set.
        node.style = { width: row.w ?? 240, ...(row.h != null ? { height: row.h } : {}) }
      } else if (row.w != null || row.h != null) {
```

`NoteNode.tsx`: signature `({ data, selected }: Pick<NodeProps<BoardFlowNode>, 'data' | 'selected'>)`; root class `w-[240px]` becomes `h-full w-full min-w-[160px]`; import `NodeResizeControl`, `usePatchNode`, `resizePatch`; inside the root before the title:

```tsx
      {data.canEdit && selected && (
        <NodeResizeControl
          position="bottom-right"
          minWidth={160}
          minHeight={60}
          className="!h-3 !w-3 !rounded-sm !border-2 !border-background !bg-muted-foreground"
          onResizeEnd={(_, p) => {
            if (data.slug) patchNode.mutate(resizePatch(data.row, p))
          }}
        />
      )}
```

with `const patchNode = usePatchNode(data.slug ?? '')` at the top (the FrameNode precedent).

- [ ] **Step 4: Run the gates** (same command as Task 8).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(boards): notes resize from the corner and keep their size

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/components/boards/board-mapping.ts src/components/boards/nodes/NoteNode.tsx src/components/boards/__tests__/board-mapping.test.ts src/components/boards/__tests__/NoteNode.test.tsx
```

### Task 10: Remove from frame

**Files:**
- Modify: `src/components/boards/BoardSidePanel.tsx` (after the Label editor), `__tests__/BoardSidePanel.test.tsx`

**Interfaces:**
- Consumes: `patch.mutate({ id, data: { version, parent_id: null, x, y } })` (the `usePatchNode` mutation already in the panel).

- [ ] **Step 1: Write the failing test**

```tsx
  it('Remove from frame makes the item top-level at its absolute spot', async () => {
    const user = userEvent.setup()
    const frame = node({ id: 1, kind: 'frame', x: 100, y: 50 })
    const child = node({ id: 2, kind: 'note', label: 'Q4', parent_id: 1, x: 30, y: 20, version: 4, data: { markdown: '' } })
    render(
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      <BoardSidePanel board={board(true, [frame, child])} selectedId={2} onClose={() => {}} />
    )
    await user.click(screen.getByRole('button', { name: 'Remove from frame' }))
    expect(h.patch).toHaveBeenCalledWith({
      id: 2,
      data: { version: 4, parent_id: null, x: 130, y: 70 },
    })
  })
  it('no Remove from frame for top-level items or viewers', () => {
    const frame = node({ id: 1, kind: 'frame' })
    const child = node({ id: 2, kind: 'note', parent_id: 1, data: { markdown: '' } })
    render(
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      <BoardSidePanel board={board(false, [frame, child])} selectedId={2} onClose={() => {}} />
    )
    expect(screen.queryByRole('button', { name: 'Remove from frame' })).toBeNull()
  })
```

- [ ] **Step 2: Run to confirm it fails**

Run: `node node_modules/vitest/vitest.mjs run src/components/boards/__tests__/BoardSidePanel.test.tsx`
Expected: FAIL (no such button).

- [ ] **Step 3: Implement**

In `NodePanel`, after the Label editor block:

```tsx
      {canEdit && node.parent_id != null && (
        <Button
          size="sm"
          variant="outline"
          className="w-fit"
          disabled={patch.isPending}
          onClick={() => {
            const frame = board.nodes.find(n => n.id === node.parent_id)
            // Keep the item where it is on the canvas: relative becomes absolute.
            patch.mutate({
              id: node.id,
              data: {
                version: node.version,
                parent_id: null,
                x: node.x + (frame?.x ?? 0),
                y: node.y + (frame?.y ?? 0),
              },
            })
          }}
        >
          Remove from frame
        </Button>
      )}
```

- [ ] **Step 4: Run the gates** (boards suite, tsc, eslint, prettier on `src/components/boards`).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(boards): remove an item from its frame, keeping its spot

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/components/boards/BoardSidePanel.tsx src/components/boards/__tests__/BoardSidePanel.test.tsx
```

### Task 11: Cmd+K jumps to an item on this board

**Files:**
- Modify: `src/lib/commands/types.ts` (`AppCommand.label?: string`), `src/lib/commands/registry.ts` (`unregisterCommands`, literal label in search), `src/components/command-palette/CommandPalette.tsx:103` (literal label)
- Create: `src/components/boards/board-commands.ts`, `src/components/boards/__tests__/board-commands.test.ts`
- Modify: `src/components/boards/BoardPage.tsx` (register on mount, unregister on unmount), `src/lib/commands/commands.test.ts`

**Interfaces:**
- Produces: `AppCommand.label?: string` (literal label, used over `t(labelKey)` when present); `unregisterCommands(ids: string[]): void`; `boardNodeCommands(board: BoardDetail): AppCommand[]` with ids `board:<slug>:node:<id>`, `group: 'board'`, `isAvailable` true only while `useUIStore.getState().boardTargetSlug === slug`, `execute` = `useUIStore.getState().setPendingBoardNode(String(id))`.

- [ ] **Step 1: Write the failing tests**

`src/lib/commands/commands.test.ts`, add (inside the existing describe that has `registerCommands`/`getAllCommands` and `mockT`):

```ts
  it('a literal label is searched and unregister removes commands (Review Focus 5)', () => {
    registerCommands([
      {
        id: 'board:org:node:1',
        labelKey: 'commands.boardItem.label',
        label: 'Marketing frame',
        group: 'board',
        execute: () => {},
      },
    ])
    const ctx = createMockContext()
    expect(getAllCommands(ctx, 'marketing', mockT).map(c => c.id)).toEqual(['board:org:node:1'])
    unregisterCommands(['board:org:node:1'])
    expect(getAllCommands(ctx, 'marketing', mockT)).toEqual([])
  })
```

(import `unregisterCommands` next to `registerCommands`.)

`src/components/boards/__tests__/board-commands.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'

const h = vi.hoisted(() => ({ slug: 'org', pending: vi.fn() }))
vi.mock('@/store/ui-store', () => ({
  useUIStore: { getState: () => ({ boardTargetSlug: h.slug, setPendingBoardNode: h.pending }) },
}))

import { boardNodeCommands } from '@/components/boards/board-commands'

const board = {
  slug: 'org',
  nodes: [
    { id: 1, kind: 'frame', label: 'Marketing', context: null },
    { id: 2, kind: 'entity', label: 'P-1', context: { label: 'Sample P-1' } },
  ],
} as never

describe('boardNodeCommands', () => {
  it('one command per item, labelled by context when present, jumping through the pending node', () => {
    const cmds = boardNodeCommands(board)
    expect(cmds.map(c => [c.id, c.label, c.group])).toEqual([
      ['board:org:node:1', 'Marketing', 'board'],
      ['board:org:node:2', 'Sample P-1', 'board'],
    ])
    cmds[0]?.execute({ openPreferences: () => {}, showToast: () => {} })
    expect(h.pending).toHaveBeenCalledWith('1')
  })
  it('is only available while that board is open', () => {
    const [cmd] = boardNodeCommands(board)
    const ctx = { openPreferences: () => {}, showToast: () => {} }
    expect(cmd?.isAvailable?.(ctx)).toBe(true)
    h.slug = 'other'
    expect(cmd?.isAvailable?.(ctx)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to confirm they fail**

Run: `node node_modules/vitest/vitest.mjs run src/lib/commands/commands.test.ts src/components/boards/__tests__/board-commands.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`types.ts`: in `AppCommand` after `labelKey`:

```ts
  /** Literal label for commands built at runtime (a board's items); used instead of `labelKey` when set. */
  label?: string
```

`registry.ts`: search uses `const label = (cmd.label ?? t(cmd.labelKey)).toLowerCase()`; add

```ts
export function unregisterCommands(ids: string[]): void {
  ids.forEach(id => commandRegistry.delete(id))
}
```

`CommandPalette.tsx:103`: `<span>{command.label ?? t(command.labelKey)}</span>`.

`src/components/boards/board-commands.ts`:

```ts
import { Map as MapIcon } from 'lucide-react'
import type { AppCommand } from '@/lib/commands/types'
import type { BoardDetail } from '@/lib/api-boards'
import { useUIStore } from '@/store/ui-store'

/** Cmd+K entries for the open board's items (spec 8.3): selecting one centres the item. */
export function boardNodeCommands(board: BoardDetail): AppCommand[] {
  return board.nodes.map(n => ({
    id: `board:${board.slug}:node:${n.id}`,
    labelKey: 'commands.boardItem.label',
    label: n.context?.label ?? n.label,
    group: 'board',
    icon: MapIcon,
    keywords: [n.kind],
    execute: () => useUIStore.getState().setPendingBoardNode(String(n.id)),
    isAvailable: () => useUIStore.getState().boardTargetSlug === board.slug,
  }))
}
```

`BoardPage.tsx`: import `registerCommands, unregisterCommands` from `@/lib/commands/registry` and `boardNodeCommands`; after the `board` query resolves (below the early returns is too late for a hook, so place the effect above them and guard inside):

```tsx
  // Cmd+K: this board's items while it is open; gone when it unmounts.
  useEffect(() => {
    const nodes = board.data
    if (!nodes) return
    const cmds = boardNodeCommands(nodes)
    registerCommands(cmds)
    return () => unregisterCommands(cmds.map(c => c.id))
  }, [board.data])
```

- [ ] **Step 4: Run the gates**

Run: `node node_modules/vitest/vitest.mjs run src/lib/commands src/components/boards src/components/command-palette && node node_modules/typescript/bin/tsc --noEmit && node node_modules/eslint/bin/eslint.js src/lib/commands src/components/boards src/components/command-palette && node node_modules/prettier/bin/prettier.cjs --check src/lib/commands src/components/boards src/components/command-palette`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(boards): Cmd+K lists the open board's items

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/lib/commands/types.ts src/lib/commands/registry.ts src/lib/commands/commands.test.ts src/components/command-palette/CommandPalette.tsx src/components/boards/board-commands.ts src/components/boards/__tests__/board-commands.test.ts src/components/boards/BoardPage.tsx
```

### Task 12: `board_changed` live event (backend)

**Files:**
- Modify: `backend/boards/service.py` (`_emit_board_changed`, calls after each committed write)
- Modify: `backend/tests/test_boards_routes.py` (its `client` fixture exposes `as_user` and `editors`; the nodes fixture does not)

**Interfaces:**
- Produces: sink event `{"event_type": "board_changed", "board_slug": str, "board_id": int, "actor_id": int | None, "event_id": None, "audience": None | {"groups": [...]}}` emitted after `create_node`, `patch_node`, `patch_positions`, `delete_node`, `create_edge`, `patch_edge`, `delete_edge`, `patch_board` commit. `flags.routes._frame` already drops `audience` and omits the `id:` line when `event_id` is None; the bus filters by audience.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_boards_routes.py` (after `_board(client, "org")` and `client.as_user(EDITOR)` so the editor writes to the company board):

```python
def test_writes_emit_board_changed_with_the_board_audience(client):
    _board(client, "org", "company", [{"group_id": client.editors, "can_edit": True}])
    client.as_user(EDITOR)
    from flags import seams
    sink = seams.InMemoryEventSink()
    prev = seams.EVENT_SINK
    seams.set_event_sink(sink)
    try:
        n = client.post("/api/boards/org/nodes", json={"kind": "text", "label": "T"}).json()
        ev = [e for e in sink.events if e.get("event_type") == "board_changed"]
        assert ev and ev[-1]["board_slug"] == "org" and ev[-1]["audience"] is None
        assert ev[-1]["actor_id"] == EDITOR.id
        sink.events.clear()
        client.patch(f"/api/boards/org/nodes/{n['id']}", json={"version": n["version"], "label": "U"})
        client.delete(f"/api/boards/org/nodes/{n['id']}")
        assert [e["event_type"] for e in sink.events] == ["board_changed", "board_changed"]
        sink.events.clear()
        # Restricted board: the audience is its grant groups, so the bus never reaches an outsider.
        client.as_user(ADMIN)
        client.post("/api/boards", json={"slug": "exec", "name": "Exec", "visibility": "restricted"})
        client.put("/api/boards/exec/grants", json=[{"group_id": client.editors, "can_edit": True}])
        client.as_user(EDITOR)
        client.post("/api/boards/exec/nodes", json={"kind": "text", "label": "T"})
        ev = [e for e in sink.events if e.get("event_type") == "board_changed"]
        assert ev[-1]["audience"] == {"groups": [client.editors]}
    finally:
        seams.set_event_sink(prev)
```

`_board(client, slug, visibility, grants)` is the file's existing helper; check its signature at the top of the file before calling it.

- [ ] **Step 2: Run to confirm it fails**

Run: `cd backend && "$PY" -m pytest tests/test_boards_routes.py -q -p no:cacheprovider -k board_changed`
Expected: FAIL (no event).

- [ ] **Step 3: Implement**

In `backend/boards/service.py` (near the top, after the helpers; `log = logging.getLogger(__name__)` if the module has none):

```python
def _board_audience(db: Session, board: Board) -> Optional[dict]:
    if board.visibility == "company":
        return None
    gids = db.execute(select(BoardGrant.group_id).where(BoardGrant.board_id == board.id)
                      .order_by(BoardGrant.group_id)).scalars().all()
    return {"groups": [int(g) for g in gids]}


def _emit_board_changed(db: Session, board: Board, user) -> None:
    """Live hint for other open canvases (spec 8.6): rides the flag event sink and bus, stamped
    with the board's audience like a flag event. Best effort: a sink failure never fails the write."""
    from flags import seams
    try:
        seams.EVENT_SINK.emit({"event_type": "board_changed", "board_slug": board.slug, "board_id": board.id,
                               "actor_id": getattr(user, "id", None), "event_id": None,
                               "audience": _board_audience(db, board)})
    except Exception:  # noqa: BLE001
        log.warning("board_changed_emit_failed board=%s", board.slug, exc_info=True)
```

Then, in each of `create_node`, `patch_node`, `patch_positions`, `delete_node`, `create_edge`, `patch_edge`, `delete_edge`, `patch_board`: immediately after the `db.commit()` that ends the write, add `_emit_board_changed(db, board, user)` (each of these already holds `board` from `_editable` or `get_board`). Not in `replace_grants` or `create_board` (nobody has the board open yet) and not in `delete_board` (the row is gone).

- [ ] **Step 4: Run the boards suites**

Run: `cd backend && "$PY" -m pytest tests/test_boards_nodes.py tests/test_boards_routes.py tests/test_flags_bus.py -q -p no:cacheprovider`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(boards): board_changed live event after every board write

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/boards/service.py backend/tests/test_boards_routes.py
```

### Task 13: `board_changed` in the stream glue (frontend)

**Files:**
- Modify: `src/lib/flag-stream.ts:38-52` (`FlagStreamEvent.board_slug?`, `flag` optional for non-flag events), `src/components/flags/use-flag-stream-glue.ts:280` (short-circuit)
- Modify: `src/components/flags/__tests__/flag-stream-glue-invalidation.test.ts`, `src/lib/__tests__/flag-stream.test.ts`

**Interfaces:**
- Consumes: `boardKeys.detail(slug)` from `@/services/boards`.
- Produces: on `event_type === 'board_changed'` the glue invalidates `['boards', 'detail', slug]` only (and `['flags','board',slug]` is left to flag events), skips the flag set, toasts and unseen; events from the current user are ignored (their own mutation already refetched).

- [ ] **Step 1: Write the failing tests**

`flag-stream.test.ts`:

```ts
  it('parses a board_changed frame that carries no flag', () => {
    const data = { event_type: 'board_changed', board_slug: 'org', board_id: 1, actor_id: 2, event_id: null }
    const { events } = parseFrames(`event: board_changed\ndata: ${JSON.stringify(data)}\n\n`)
    expect(events).toHaveLength(1)
    expect(events[0]?.event_type).toBe('board_changed')
    expect((events[0] as { board_slug?: string }).board_slug).toBe('org')
  })
```

`flag-stream-glue-invalidation.test.ts`:

```ts
  it('board_changed refetches that board only, skipping the flag set', async () => {
    await mountGlue()
    handler({ event_type: 'board_changed', board_slug: 'org', board_id: 1, actor_id: 2, event_id: null })
    expect(hasKey(['boards', 'detail', 'org'])).toBe(true)
    vi.advanceTimersByTime(300)
    expect(hasKey(['flags', 'list'])).toBe(false)
    expect(hasKey(['flags', 'board'])).toBe(false)
  })
  it('board_changed from me is ignored (my own write already refetched)', async () => {
    useAuthStore.setState({ user: { id: 2 } as never })
    await mountGlue()
    handler({ event_type: 'board_changed', board_slug: 'org', board_id: 1, actor_id: 2, event_id: null })
    expect(hasKey(['boards', 'detail', 'org'])).toBe(false)
  })
```

- [ ] **Step 2: Run to confirm they fail**

Run: `node node_modules/vitest/vitest.mjs run src/lib/__tests__/flag-stream.test.ts src/components/flags/__tests__/flag-stream-glue-invalidation.test.ts`
Expected: the glue cases FAIL (the parser case may already pass; keep it as the contract).

- [ ] **Step 3: Implement**

`flag-stream.ts`: extend the type:

```ts
export type FlagEventType =
  | 'raised'
  | ...existing...
  | 'comment_reaction'
  | 'board_changed'

export interface FlagStreamEvent {
  event_type: FlagEventType | string
  flag_id: number
  actor_id: number | null
  from_value: string | null
  to_value: string | null
  details: Record<string, unknown> | null
  event_id: number
  flag: FlagSnapshot
  comment_id?: number
  emoji?: string
  action?: 'added' | 'removed'
  /** `board_changed` only (planning boards slice 4): the board another editor just wrote to. */
  board_slug?: string
  board_id?: number
}
```

`use-flag-stream-glue.ts`, first lines of the `useFlagStream` callback (import `boardKeys` from `@/services/boards`):

```ts
  useFlagStream((e: FlagStreamEvent) => {
    // A board write by someone else: refetch that board and stop; it is not a flag event.
    if (e.event_type === 'board_changed') {
      const me = useAuthStore.getState().user?.id ?? null
      if (e.board_slug && e.actor_id !== me)
        queryClient.invalidateQueries({ queryKey: boardKeys.detail(e.board_slug) })
      return
    }
```

The existing `enqueueInvalidations(e)` call stays after this guard.

- [ ] **Step 4: Run the gates**

Run: `node node_modules/vitest/vitest.mjs run src/lib/__tests__/flag-stream.test.ts src/components/flags && node node_modules/typescript/bin/tsc --noEmit && node node_modules/eslint/bin/eslint.js src/lib/flag-stream.ts src/components/flags/use-flag-stream-glue.ts && node node_modules/prettier/bin/prettier.cjs --check src/lib/flag-stream.ts src/components/flags/use-flag-stream-glue.ts`
Expected: green. (The `flag-stream-glue-*` files time out under concurrent pytest or Playwright load; run them alone before believing a failure.)

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(boards): other editors' board writes refetch the open board through the stream

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/lib/flag-stream.ts src/lib/__tests__/flag-stream.test.ts src/components/flags/use-flag-stream-glue.ts src/components/flags/__tests__/flag-stream-glue-invalidation.test.ts
```

### Task 14: PR B end-to-end, changelog, spec line, PR

**Files:**
- Modify: `e2e/planning-boards-live.spec.ts` (tests 7 to 11), `CHANGELOG.md`, spec section 14
- Evidence into `docs/superpowers/evidence/2026-10-12-planning-boards-live/`

- [ ] **Step 1: Extend the spec**

7. `compact`: pin the viewport with `zoom: 0.3` through `addInitScript` (the layout spec's `pinViewport` pattern with `{ x: 0, y: 0, zoom: 0.3 }`), open the board; the note node has `data-compact="true"` and does not contain its markdown text; screenshot `04-compact.png`. Then zoom 1: body visible.
8. `cmd+k`: open the board, press `Control+k`, type the frame label, press `Enter`; the side panel header shows the frame label (selected and centred).
9. `remove from frame`: select the note inside the frame, click `Remove from frame`; poll the API until `parent_id === null` and `x === frame.x + oldX`, `y === frame.y + oldY`.
10. `note resize`: select the note, drag its grip (`.react-flow__resize-control.bottom-right` on the note) by `+60,+40`; poll the API until `w` and `h` are set and `w >= 300`.
11. `live`: open the board in context A (editor); through the API (a second token, same user is fine because the glue ignores only the actor's own id: use the admin token for the API write and log context A in as the e2e user, or vice versa) create a text node; `expect(page.locator('.react-flow__node-text', { hasText: 'Live text' })).toBeVisible({ timeout: 10_000 })` without a reload; screenshot `05-live-update.png`.

- [ ] **Step 2: Changelog and spec**

Under the Task 1 block add:

```markdown
### Planning boards, slice 4: canvas live
- **Zoomed out, items show their label only** (below 0.5 zoom); frames keep their title and pills.
- **Cmd+K lists the open board's items**; pick one to centre it.
- **Remove from frame** in the side panel; the item keeps its spot on the canvas. **Notes resize** from their corner and keep their size.
- **Live boards.** Another editor's change appears on your open board without a reload.
```

Spec section 14, after the 4d bullet:

```markdown
- Slice 4e (canvas live, 2026-10-12): `board_changed` rides the flag event sink and bus with the
  board's audience; the stream glue refetches the open board and ignores the actor's own events.
  Items render label-only below 0.5 zoom (frames keep title and pills). Cmd+K items are
  registered with the open board and unregistered when it closes.
```

- [ ] **Step 3: Run on the stack**

Move the `s4live` worktree to `origin/feat/planning-boards-s4e` (`git fetch ... && git checkout -q -B feat/planning-boards-s4e origin/feat/planning-boards-s4e`; the mounted backend reloads), re-source the env file, run `node node_modules/@playwright/test/cli.js test planning-boards-live --reporter=list`.
Expected: 11 passed.

- [ ] **Step 4: Commit, push, PR; destroy the stack**

```bash
git commit -m "test(e2e): canvas live: compact zoom, Cmd+K, remove from frame, note resize, live update

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- e2e/planning-boards-live.spec.ts docs/superpowers/evidence/2026-10-12-planning-boards-live/ CHANGELOG.md docs/superpowers/specs/2026-09-26-planning-boards-design.md
git push -u origin feat/planning-boards-s4e
gh pr create --repo Zstar0/Accu-Mk1 --base feat/planning-boards-s4d --head feat/planning-boards-s4e --title "Planning boards slice 4e: canvas live" --body-file <body>
ssh forrestparker@100.73.137.3 'cd ~/accumark-stack && ./bin/accumark-stack destroy s4live --yes; git -C ~/accumark-repos/Accu-Mk1 worktree remove --force ~/worktrees/Accu-Mk1-s4live || sudo -n rm -rf ~/worktrees/Accu-Mk1-s4live; git -C ~/accumark-repos/Accu-Mk1 worktree prune'
```

Delete `/c/tmp/s4live-e2e.env`.

---

## Self-review notes

- Spec coverage: 8.3 rollup pills (Task 5), zoom (8), Cmd+K (11); 8.6 dock (6) with live refresh through the flag glue (4); 8.7 field edits with version (10, 9); 14 deferrals: EntityNode indicator (5), PersonNode pill (5), NodeResizer on notes (9), board-card count (3, 6); dropped by ruling: person-panel groups, drag debounce (recorded in Task 1). Board anchor (2, 3, 6, 7). Live editors (12, 13, 14).
- Type consistency: `useBoardFlags(slug: string | null)` everywhere; helper names match between Task 4 and Tasks 5, 6; `flagKeys.boards()` / `flagKeys.board(slug)`; `boardKeys.detail(slug)` from `src/services/boards.ts:34`; `AppCommand.label` used by registry, palette and `boardNodeCommands`.
- Known seams to verify at execution time (named in the tasks): the flags status route path (Task 3 tests), `_ilike_prefix` return shape (Task 2), the `_board` helper signature in `test_boards_routes.py` (Task 12), FrameNode prop typing (Task 5).
