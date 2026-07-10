# Flag P2 Slice 4 — Comment Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The flyout search box (today: title + Sample-ID, client-side) also finds flags by **comment body**. Comment bodies aren't in the list payloads, so a new `GET /api/flags/search?q=` returns matching flag ids + a snippet (Postgres `ILIKE` on `flag_comments.body` + `flag_flags.title`, accelerated by a `pg_trgm` GIN index). The flyout merges those server hits into the current tab's client-filtered list as a "matched in comments" badge + snippet line; the instant client-side title/ID filter is untouched.

**Architecture:** One additive backend endpoint + service function (portable `.ilike()` — a GIN `gin_trgm_ops` index accelerates it on Postgres, and the identical query degrades to a `lower() LIKE` seqscan on SQLite / when the extension is unavailable). Index-only migration, degrade-safe via the existing per-statement migration isolation. Frontend: a hand-rolled debounce hook (no new dependency), a `useFlagSearch` query gated at ≥3 chars, and a pure `mergeSearchHits` helper that folds comment hits into the existing `filterFlags` output. Card/table gain an optional snippet/badge.

**Tech Stack:** FastAPI + SQLAlchemy (backend), React 18 + TypeScript + TanStack Query (frontend). Spec: `docs/superpowers/specs/2026-07-09-flag-system-phase2-design.md` §7 (plus §2, §11, §12).

## Global Constraints

- **npm only** for the Accu-Mk1 frontend (never pnpm/yarn). **NO new frontend dependencies** — debounce is hand-rolled (the codebase has no reusable `useDebounce`; `setTimeout` is used ad hoc, e.g. `flag-stream` glue).
- **Additive only** — the instant client-side `filterFlags` text match (title / Sample ID) is unchanged; search only *augments* it with comment matches for ≥3-char queries. Existing tests stay green (gate = normalized failure-set diff vs the known baseline, ~19 backend / 34 frontend known failures — count the failure **set**, not the number).
- **Module purity** — `backend/flags/` imports no Mk1 host models; the search touches only `flag_flags` / `flag_comments`.
- **Trusted-staff authz (§2/§11)** — every flags endpoint is behind `get_current_user`; all authenticated users are staff, so search is unscoped by user (no per-flag authz). The endpoint is **tab-agnostic**: it searches all flags; the client intersects hits with the current tab's already-fetched list, so a closed-flag hit simply won't appear in an "All open" tab (no server-side status filter needed).
- **Parameterized queries only** — the `q` value rides SQLAlchemy `.ilike()` bind params; **never** string-interpolated into SQL. LIKE metacharacters (`%` `_` `\`) in `q` are escaped so they match literally.
- **Snippet builder strips Slice-3 `{attachment:N}` tokens** (comment bodies gain them in Slice 3, spec §6) so opaque tokens never leak into the UI. `@mention` tokens (`@name`) are readable and kept.
- Frontend gates per task: `npx vitest run <file>`; slice gate: `npm run check:all` + `npm run build`. Backend: `python -m pytest backend/tests -k flag -q`.
- Branch: `feat/flag-p2-search` off `feat/flag-p2-comments` (Slice 3). Slices 1 and 4 are independent (spec §3) — **do NOT reference any Slice-1 name** (`assignee`, `all_open`, `OPEN_STATUSES`); write against the `flag-filter.ts` shape in this repo (`text`/`status`/`entityType`/`type`). Commit after every task.

### Wire contract (pin once — five call sites must stay in lockstep)

`FlagSearchHit` — returned by the endpoint, consumed by the merge + render:

| field | type | meaning |
|-------|------|---------|
| `flag_id` | `int` | the matched flag |
| `snippet` | `str` | cleaned comment excerpt around the match; `""` on a title-only hit |
| `matched_in` | `list[str]` | subset of `["comment", "title"]` |

Snake_case on the wire **both** sides (`apiFetch` returns raw JSON — camelCase drift silently breaks the merge). No `title` field: the merge reads titles from the tab flags it already holds. The five places this shape lives: `schemas.py` (Task 2), `service.search_flags` return (Task 1), the TS `FlagSearchHit` (Task 4), `mergeSearchHits` (Task 5), the card/table render props (Task 6).

---

### Task 1: Backend — `search_flags` service + snippet builder

**Files:**
- Modify: `backend/flags/service.py` (add `SearchHit`, `search_flags`, `_like_pattern`, `_snippet`, `_clean_body`)
- Test: `backend/tests/test_flags_search.py` (create; mirror `test_flags_service.py`'s `db` fixture + `_user` helper idiom)

**Interfaces:**
- Produces: `service.search_flags(db, *, q, limit=50) -> list[SearchHit]` where `SearchHit = dataclass(flag_id: int, snippet: str, matched_in: list[str])`. Returns `[]` for `len(q.strip()) < 3`. Ordered newest-first (`flag_id` DESC), capped at `limit`. Task 2 wraps each `SearchHit` into `FlagSearchHit`.

- [ ] **Step 1: Write the failing tests** (`backend/tests/test_flags_search.py`)

```python
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401  (register FlagType on Base)
    import flags.models  # noqa: F401
    from flags import seams, types_service
    seams.set_event_sink(seams.InMemoryEventSink())
    seams.register_entity("sub_sample",
                          label=lambda d, e: f"Vial {e}",
                          deep_link=lambda e: f"/v/{e}",
                          can_flag=lambda u, e: True)
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    types_service.seed_builtins(s)
    try:
        yield s
    finally:
        s.close()


def _user(id=1, role="standard"):
    return SimpleNamespace(id=id, role=role, email=f"u{id}@x.t")


def _mk(db, *, title, entity_id, comment=None):
    from flags import service
    u = _user(7)
    f = service.create_flag(db, user=u, entity_type="sub_sample",
                            entity_id=entity_id, type="blocker", title=title)
    if comment is not None:
        service.add_comment(db, user=u, flag_id=f.id, body=comment)
    return f


def test_short_query_returns_empty(db):
    from flags import service
    _mk(db, title="ph drift", entity_id="1", comment="the ph is drifting")
    assert service.search_flags(db, q="ph") == []
    assert service.search_flags(db, q="  ") == []


def test_matches_comment_body_with_snippet(db):
    from flags import service
    f = _mk(db, title="Pump seal", entity_id="1",
            comment="the cloudy precipitate settled overnight in the vial")
    hits = service.search_flags(db, q="precipitate")
    assert [h.flag_id for h in hits] == [f.id]
    assert "comment" in hits[0].matched_in
    assert "precipitate" in hits[0].snippet.lower()


def test_matches_title_only_has_empty_snippet(db):
    from flags import service
    f = _mk(db, title="Centrifuge imbalance", entity_id="1")
    hits = service.search_flags(db, q="centrifuge")
    assert [h.flag_id for h in hits] == [f.id]
    assert hits[0].matched_in == ["title"]
    assert hits[0].snippet == ""


def test_match_in_both_title_and_comment(db):
    from flags import service
    f = _mk(db, title="residue on wall", entity_id="1",
            comment="more residue than expected")
    hits = service.search_flags(db, q="residue")
    assert hits[0].flag_id == f.id
    assert set(hits[0].matched_in) == {"title", "comment"}


def test_snippet_strips_attachment_tokens(db):
    from flags import service
    _mk(db, title="x", entity_id="1",
        comment="see {attachment:5} the residue on the wall")
    hits = service.search_flags(db, q="residue")
    assert "{attachment" not in hits[0].snippet
    assert "residue" in hits[0].snippet


def test_escapes_like_metacharacters(db):
    from flags import service
    a = _mk(db, title="100% pure", entity_id="1")
    _mk(db, title="everything else", entity_id="2")
    # '%' is a literal here, NOT a wildcard — only the '100% pure' flag matches.
    hits = service.search_flags(db, q="100%")
    assert [h.flag_id for h in hits] == [a.id]


def test_case_insensitive_and_newest_first(db):
    from flags import service
    a = _mk(db, title="Alpha buffer", entity_id="1", comment="BUFFER low")
    b = _mk(db, title="beta", entity_id="2", comment="buffer high")
    hits = service.search_flags(db, q="buffer")
    # flag_id DESC → newest first.
    assert [h.flag_id for h in hits] == [b.id, a.id]


def test_respects_limit(db):
    from flags import service
    for i in range(1, 6):
        _mk(db, title=f"t{i}", entity_id=str(i), comment="widget failure")
    hits = service.search_flags(db, q="widget", limit=2)
    assert len(hits) == 2
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m pytest backend/tests/test_flags_search.py -q`
Expected: FAIL — `search_flags` doesn't exist (`AttributeError`).

- [ ] **Step 3: Implement** — in `backend/flags/service.py`.

Add to the imports at the top (after the existing `from datetime import datetime`):

```python
import re
from dataclasses import dataclass, field
```

`FlagComment` is already imported from `flags.models`. Add — placed after `list_activity`/`list_unread` (a read-only query, grouped with the other list queries):

```python
_ATTACHMENT_TOKEN_RE = re.compile(r"\{attachment:\d+\}")
_WS_RE = re.compile(r"\s+")


@dataclass
class SearchHit:
    """One title/comment search match (service-internal; the route maps it to
    the FlagSearchHit wire model). `snippet` is empty on a title-only hit."""
    flag_id: int
    snippet: str = ""
    matched_in: list[str] = field(default_factory=list)


def _clean_body(body: str) -> str:
    """Drop Slice-3 `{attachment:N}` tokens and collapse whitespace so a snippet
    reads as one clean line. @mention tokens (`@name`) are readable — kept."""
    return _WS_RE.sub(" ", _ATTACHMENT_TOKEN_RE.sub("", body)).strip()


def _snippet(body: str, needle: str, *, radius: int = 48) -> str:
    """A one-line excerpt of `body` centered on the first case-insensitive
    occurrence of `needle`, ellipsized when truncated."""
    text = _clean_body(body)
    idx = text.lower().find(needle.lower())
    if idx < 0:
        # The match sat inside a stripped token or spanned a token boundary —
        # show the head of the cleaned body rather than nothing.
        head = text[: 2 * radius]
        return head + "…" if len(text) > len(head) else head
    start = max(0, idx - radius)
    end = min(len(text), idx + len(needle) + radius)
    out = text[start:end]
    if start > 0:
        out = "…" + out
    if end < len(text):
        out = out + "…"
    return out


def _like_pattern(q: str) -> str:
    """A `%…%` ILIKE pattern with LIKE metacharacters escaped (escape char = `\\`)
    so a user typing `%` or `_` searches for the literal, not a wildcard."""
    esc = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{esc}%"


def search_flags(db: Session, *, q: str, limit: int = 50) -> list[SearchHit]:
    """Flags whose title OR any comment body contains `q` (case-insensitive
    substring). Portable ILIKE: a pg_trgm GIN index accelerates it on Postgres,
    and the identical query degrades to a `lower() LIKE` seqscan on SQLite / when
    the extension is absent. Newest-first (flag_id DESC), capped at `limit`."""
    q = (q or "").strip()
    if len(q) < 3:
        return []
    limit = max(1, min(limit, 100))
    pattern = _like_pattern(q)

    # Comment matches: the first matching comment per flag drives its snippet.
    # Bounded scan (limit*4) — enough matching comments to still cover `limit`
    # distinct newest flags without pulling an unbounded set.
    comment_rows = db.execute(
        select(FlagComment.flag_id, FlagComment.body)
        .where(FlagComment.body.ilike(pattern, escape="\\"))
        .order_by(FlagComment.flag_id.desc(), FlagComment.id.asc())
        .limit(limit * 4)
    ).all()
    snippet_by_flag: dict[int, str] = {}
    for flag_id, body in comment_rows:
        if flag_id not in snippet_by_flag:
            snippet_by_flag[flag_id] = _snippet(body, q)

    title_ids = {
        fid for (fid,) in db.execute(
            select(FlagFlag.id)
            .where(FlagFlag.title.ilike(pattern, escape="\\"))
            .order_by(FlagFlag.id.desc())
            .limit(limit)
        ).all()
    }

    hit_ids = sorted(set(snippet_by_flag) | title_ids, reverse=True)[:limit]
    hits: list[SearchHit] = []
    for fid in hit_ids:
        matched_in: list[str] = []
        if fid in snippet_by_flag:
            matched_in.append("comment")
        if fid in title_ids:
            matched_in.append("title")
        hits.append(SearchHit(fid, snippet_by_flag.get(fid, ""), matched_in))
    return hits
```

- [ ] **Step 4: Run to verify it passes** — `python -m pytest backend/tests/test_flags_search.py -q` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(flags): search_flags service (title + comment ILIKE) with snippet builder"`

---

### Task 2: Backend — `FlagSearchHit` schema + `GET /api/flags/search` route

**Files:**
- Modify: `backend/flags/schemas.py` (add `FlagSearchHit`), `backend/flags/routes.py` (add the route + import)
- Test: `backend/tests/test_flags_search_route.py` (create; mirror `test_flags_routes.py`'s `client` fixture)

**Interfaces:**
- Produces: `GET /api/flags/search?q=<str>&limit=<int>` → `List[FlagSearchHit]`. Registered **ABOVE** `/{flag_id}` (literal-before-param rule — else `flag_id="search"` swallows it). `FlagSearchHit = {flag_id, snippet, matched_in}` (the wire contract above). Task 4's TS interface mirrors it exactly.

- [ ] **Step 1: Write the failing tests** (`backend/tests/test_flags_search_route.py`)

```python
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
    from flags import seams, types_service
    seams.set_event_sink(seams.InMemoryEventSink())
    seams.register_mk1_entities()

    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    shared = Session()
    types_service.seed_builtins(shared)

    def _db():
        yield shared
    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=42, role="standard", email="t@x.t")
    tc = TestClient(app)
    yield tc
    app.dependency_overrides.pop(get_db, None) if prev_db is None else app.dependency_overrides.__setitem__(get_db, prev_db)
    app.dependency_overrides.pop(get_current_user, None) if prev_user is None else app.dependency_overrides.__setitem__(get_current_user, prev_user)
    shared.close()


def _raise(client, *, title, entity_id, comment=None):
    r = client.post("/api/flags", json={"entity_type": "sub_sample", "entity_id": entity_id,
                                         "type": "blocker", "title": title})
    assert r.status_code == 201, r.text
    fid = r.json()["id"]
    if comment is not None:
        c = client.post(f"/api/flags/{fid}/comments", json={"body": comment})
        assert c.status_code == 201, c.text
    return fid


def test_search_matches_comment_body(client):
    fid = _raise(client, title="Pump seal", entity_id="1",
                 comment="the cloudy precipitate settled overnight")
    hits = client.get("/api/flags/search?q=precipitate").json()
    assert [h["flag_id"] for h in hits] == [fid]
    assert "comment" in hits[0]["matched_in"]
    assert "precipitate" in hits[0]["snippet"].lower()


def test_search_matches_title(client):
    fid = _raise(client, title="Centrifuge imbalance", entity_id="2")
    hits = client.get("/api/flags/search?q=centrifuge").json()
    hit = next(h for h in hits if h["flag_id"] == fid)
    assert hit["matched_in"] == ["title"] and hit["snippet"] == ""


def test_search_short_query_returns_empty(client):
    _raise(client, title="ph drift", entity_id="3", comment="ph is drifting")
    assert client.get("/api/flags/search?q=ph").json() == []


def test_search_route_wins_over_flag_id_param(client):
    # /search must resolve to the search handler, NOT GET /{flag_id} with
    # flag_id="search" (which would 422). A no-match query returns [] with 200.
    r = client.get("/api/flags/search?q=zzzznomatch")
    assert r.status_code == 200 and r.json() == []


def test_search_requires_auth(client):
    from auth import get_current_user
    from main import app
    app.dependency_overrides.pop(get_current_user, None)
    try:
        r = client.get("/api/flags/search?q=anything")
        assert r.status_code in (401, 403)
    finally:
        app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
            id=42, role="standard", email="t@x.t")
```

(If the ambient `get_current_user` override in this repo's test harness makes the auth-removal test flaky, keep it only if it passes cleanly against `main.app`; the literal-route and match tests are the load-bearing ones.)

- [ ] **Step 2: Run — FAIL** (`python -m pytest backend/tests/test_flags_search_route.py -q`) — 422/404 on `/search` (no route yet).

- [ ] **Step 3: Implement.** `schemas.py` — add after `SummaryResponse`:

```python
class FlagSearchHit(BaseModel):
    """One comment/title search match (spec §7). `snippet` is a cleaned comment
    excerpt (empty on a title-only hit); `matched_in` ⊆ {"comment","title"}."""
    flag_id: int
    snippet: str = ""
    matched_in: List[str] = Field(default_factory=list)
    model_config = ConfigDict(from_attributes=True)
```

`routes.py` — add `FlagSearchHit` to the `from flags.schemas import (...)` list. Insert the route in the **literal block above `/{flag_id}`** (immediately before `@router.get("/{flag_id}", ...)` at ~line 200):

```python
@router.get("/search", response_model=List[FlagSearchHit])
def search_flags(q: str = Query("", description="substring; <3 chars → empty"),
                 limit: int = Query(50, ge=1, le=100),
                 db: Session = Depends(get_db), user=Depends(get_current_user)):
    # Literal /search registered ABOVE /{flag_id} so it wins the match
    # (literal-before-param). The service returns [] for <3 chars; the client
    # also gates at 3 chars + a 300ms debounce.
    try:
        return [FlagSearchHit.model_validate(h)
                for h in service.search_flags(db, q=q, limit=limit)]
    except Exception as e:
        raise _http(e)
```

- [ ] **Step 4: Run — PASS**, then the whole flag suite: `python -m pytest backend/tests -k flag -q` — failure set matches baseline (no NEW failures).

- [ ] **Step 5: Commit** — `git commit -m "feat(flags): GET /api/flags/search endpoint (above /{flag_id})"`

---

### Task 3: Backend — `pg_trgm` GIN index migration (degrade-safe)

**Files:**
- Modify: `backend/database.py` (append 3 statements to the flags block in the idempotent-migration list)

**Interfaces:**
- Produces: on Postgres with the extension available, `ILIKE '%q%'` on `flag_comments.body` and `flag_flags.title` uses a `gin_trgm_ops` GIN index. No code depends on the index existing — `search_flags` is functionally correct without it (proven by Task 1's SQLite tests, which have neither the extension nor the index).

- [ ] **Step 1: Add the migration statements.** In `backend/database.py`, inside the `migrations = [...]` list, in the **flags module block** (after the `ix_flag_events_created_at_id` / `mentions` entries, ~line 915–917), append:

```python
        # --- flag comment search (Slice 4) ---
        # pg_trgm makes ILIKE '%q%' index-accelerated. CREATE EXTENSION needs
        # superuser; if it fails (insufficient privilege) the two index creates
        # below also fail — and the per-statement isolation loop (see end of this
        # function) swallows each with a `migration_skipped` warning rather than
        # crashing startup. Search then degrades to a sequential-scan ILIKE:
        # correct, just slower (fine at lab scale). On the SQLite test path all
        # three fail (no pg_trgm/GIN) and are likewise swallowed; the service's
        # portable .ilike() still returns correct results there.
        "CREATE EXTENSION IF NOT EXISTS pg_trgm",
        "CREATE INDEX IF NOT EXISTS ix_flag_comments_body_trgm "
        "ON flag_comments USING gin (body gin_trgm_ops)",
        "CREATE INDEX IF NOT EXISTS ix_flag_flags_title_trgm "
        "ON flag_flags USING gin (title gin_trgm_ops)",
```

Rely on the **existing** per-statement `try/except` at the end of the function (it already `conn.rollback()`s and logs `migration_skipped` on any single statement's failure) — do NOT add new error handling.

- [ ] **Step 2: Regression gate (automated).** The statements must not break app import or the test suites (tests use `create_all`, not this migration path, so they exercise the *functional* fallback, not the swallow):

Run: `python -m pytest backend/tests -k flag -q`
Expected: failure set matches baseline (no NEW failures) — Task 1/2's SQLite tests confirm search works with **no** index.

- [ ] **Step 3: Prod/devbox verification (manual — Postgres only).** On a devbox stack (accumark-stack) or after a prod deploy, confirm the index is present and used:

```bash
# extension installed
psql "$DATABASE_URL" -c "\dx pg_trgm"
# indexes present
psql "$DATABASE_URL" -c "\d+ flag_comments" | grep trgm
# planner uses the trgm index for the ILIKE (Bitmap Index Scan on ...trgm)
psql "$DATABASE_URL" -c "EXPLAIN SELECT flag_id FROM flag_comments WHERE body ILIKE '%precipitate%';"
```

If `\dx pg_trgm` is empty (non-superuser role), grep the backend logs for `migration_skipped sql='CREATE EXTENSION` — the app is healthy and search runs as a seqscan; escalate to have a superuser run `CREATE EXTENSION pg_trgm;` once, then restart (the `CREATE INDEX ... IF NOT EXISTS` reruns and builds).

- [ ] **Step 4: Commit** — `git commit -m "feat(flags): pg_trgm GIN index for comment/title search (degrade-safe)"`

---

### Task 4: Frontend — search API client, query hook, and debounce hook

**Files:**
- Modify: `src/lib/flags-api.ts` (add `FlagSearchHit` + `searchFlags`)
- Modify: `src/hooks/use-flags.ts` (add `flagKeys.search` + `useFlagSearch`)
- Create: `src/hooks/use-debounced-value.ts`
- Test: `src/hooks/__tests__/use-debounced-value.test.ts` (create); `src/hooks/__tests__/use-flags.test.tsx` (extend existing — add `searchFlags` to the mock + a `useFlagSearch` gating test)

**Interfaces:**
- Produces: `FlagSearchHit { flag_id: number; snippet: string; matched_in: string[] }` (mirrors the wire contract — snake_case); `searchFlags(q, limit?) → Promise<FlagSearchHit[]>`; `flagKeys.search(q) = ['flags', 'search', q]` (under `['flags']` so the SSE glue's blanket invalidate keeps live-added comments fresh); `useFlagSearch(q)` — **disabled** until `q.trim().length >= 3`; `useDebouncedValue<T>(value, delayMs) → T`.

- [ ] **Step 1: Failing tests** — `src/hooks/__tests__/use-debounced-value.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDebouncedValue } from '@/hooks/use-debounced-value'

describe('useDebouncedValue', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('returns the initial value immediately', () => {
    const { result } = renderHook(() => useDebouncedValue('a', 300))
    expect(result.current).toBe('a')
  })

  it('updates only after the delay elapses', () => {
    const { result, rerender } = renderHook(
      ({ v }) => useDebouncedValue(v, 300),
      { initialProps: { v: 'a' } }
    )
    rerender({ v: 'ab' })
    expect(result.current).toBe('a') // not yet
    act(() => void vi.advanceTimersByTime(299))
    expect(result.current).toBe('a')
    act(() => void vi.advanceTimersByTime(1))
    expect(result.current).toBe('ab')
  })

  it('coalesces rapid changes to the last value', () => {
    const { result, rerender } = renderHook(
      ({ v }) => useDebouncedValue(v, 300),
      { initialProps: { v: 'a' } }
    )
    rerender({ v: 'ab' })
    act(() => void vi.advanceTimersByTime(150))
    rerender({ v: 'abc' })
    act(() => void vi.advanceTimersByTime(150))
    expect(result.current).toBe('a') // first timer was reset
    act(() => void vi.advanceTimersByTime(150))
    expect(result.current).toBe('abc')
  })
})
```

Add to `src/hooks/__tests__/use-flags.test.tsx`: extend the `vi.mock('@/lib/flags-api', …)` return with `searchFlags: vi.fn(async () => [])`, import `useFlagSearch` from `@/hooks/use-flags`, and add:

```ts
describe('useFlagSearch', () => {
  beforeEach(() => vi.clearAllMocks())

  it('stays disabled (no fetch) below 3 chars', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderHook(() => useFlagSearch('ph'), { wrapper: makeWrapper(qc) })
    await new Promise(r => setTimeout(r, 20))
    expect(api.searchFlags).not.toHaveBeenCalled()
    qc.clear()
  })

  it('queries once at 3+ chars', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderHook(() => useFlagSearch('precip'), { wrapper: makeWrapper(qc) })
    await waitFor(() => expect(api.searchFlags).toHaveBeenCalledWith('precip'))
    qc.clear()
  })
})
```

- [ ] **Step 2: Run — FAIL** (`npx vitest run src/hooks/__tests__/use-debounced-value.test.ts src/hooks/__tests__/use-flags.test.tsx`) — modules/exports missing.

- [ ] **Step 3: Implement.** `src/hooks/use-debounced-value.ts`:

```ts
import { useEffect, useState } from 'react'

/**
 * The latest `value` after it has stopped changing for `delayMs`. A hand-rolled
 * debounce (no new dependency) — each change resets a timer; only the last value
 * in a burst is committed. Used to throttle the flag comment-search request.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])
  return debounced
}
```

`src/lib/flags-api.ts` — add the interface (near `SummaryResponse`, in the response-shapes block):

```ts
/** Mirrors `FlagSearchHit` (spec §7). `snippet` is a cleaned comment excerpt
 *  (empty on a title-only hit); `matched_in` ⊆ `['comment','title']`. */
export interface FlagSearchHit {
  flag_id: number
  snippet: string
  matched_in: string[]
}
```

and the endpoint fn (near `getUnread`):

```ts
/** `GET /api/flags/search?q=` — flags whose title or a comment body matches `q`
 *  (comment matches carry a snippet). Caller gates at ≥3 chars + debounce. */
export const searchFlags = (q: string, limit = 50) => {
  const qs = new URLSearchParams({ q, limit: String(limit) })
  return apiFetch<FlagSearchHit[]>(`/api/flags/search?${qs.toString()}`)
}
```

`src/hooks/use-flags.ts` — add `searchFlags` to the imports from `@/lib/flags-api`, add the key, and the hook:

```ts
// in flagKeys:
  search: (q: string) => ['flags', 'search', q] as const,
```

```ts
/** Comment/title search hits for `q`. Disabled below 3 chars (the flyout also
 *  debounces the input). Under ['flags', …] so the SSE glue's blanket
 *  invalidate keeps results fresh as comments arrive live. */
export function useFlagSearch(q: string) {
  const trimmed = q.trim()
  return useQuery({
    queryKey: flagKeys.search(trimmed),
    queryFn: () => searchFlags(trimmed),
    enabled: trimmed.length >= 3,
    staleTime: 5_000,
  })
}
```

- [ ] **Step 4: Run — PASS** (both test files). Also `npx tsc --noEmit -p tsconfig.json`.

- [ ] **Step 5: Commit** — `git commit -m "feat(flags): searchFlags client + useFlagSearch + useDebouncedValue"`

---

### Task 5: Frontend — `mergeSearchHits` pure helper

**Files:**
- Create: `src/components/flags/flag-search.ts` (`FlagSearchMeta` + `mergeSearchHits`)
- Test: `src/components/flags/__tests__/flag-search.test.ts` (create)

**Interfaces:**
- Produces: `FlagSearchMeta { snippet: string }`; `mergeSearchHits(tabFlags, clientVisible, hits) → { flags: FlagResponse[]; searchMeta: Map<number, FlagSearchMeta> }`. Title-only hits add nothing (the client already matches titles); comment hits for tab flags the client dropped are appended in tab order; `searchMeta` carries the snippet for every visible flag the server matched on a comment. Task 6 renders from `searchMeta`; Task 7 calls this.

- [ ] **Step 1: Failing tests** — `src/components/flags/__tests__/flag-search.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mergeSearchHits } from '@/components/flags/flag-search'
import type { FlagResponse, FlagSearchHit } from '@/lib/flags-api'

const mk = (id: number): FlagResponse =>
  ({
    id, entity_type: 'sample', entity_id: `P-${id}`, kind: 'issue',
    type: 'blocker', status: 'open', title: `t${id}`, created_by: 1,
    assignee_id: null, created_at: '', updated_at: '', resolved_at: null,
    resolved_by: null, entity: null,
  }) as FlagResponse

describe('mergeSearchHits', () => {
  const tab = [mk(1), mk(2), mk(3)]

  it('appends comment-hit flags the client filter dropped, in tab order', () => {
    const clientVisible = [mk(1)] // e.g. flag 1 matched by title client-side
    const hits: FlagSearchHit[] = [
      { flag_id: 3, snippet: '…residue…', matched_in: ['comment'] },
    ]
    const { flags, searchMeta } = mergeSearchHits(tab, clientVisible, hits)
    expect(flags.map(f => f.id)).toEqual([1, 3])
    expect(searchMeta.get(3)?.snippet).toBe('…residue…')
    expect(searchMeta.has(1)).toBe(false)
  })

  it('does not duplicate a flag matched both client-side and in a comment', () => {
    const clientVisible = [mk(2)]
    const hits: FlagSearchHit[] = [
      { flag_id: 2, snippet: '…foo…', matched_in: ['comment'] },
    ]
    const { flags, searchMeta } = mergeSearchHits(tab, clientVisible, hits)
    expect(flags.map(f => f.id)).toEqual([2])
    expect(searchMeta.get(2)?.snippet).toBe('…foo…') // still annotated
  })

  it('ignores title-only hits (the client already matches titles)', () => {
    const hits: FlagSearchHit[] = [
      { flag_id: 3, snippet: '', matched_in: ['title'] },
    ]
    expect(mergeSearchHits(tab, [], hits).flags).toEqual([])
  })

  it('ignores hits for flags outside the current tab', () => {
    const hits: FlagSearchHit[] = [
      { flag_id: 99, snippet: '…x…', matched_in: ['comment'] },
    ]
    expect(mergeSearchHits(tab, [], hits).flags).toEqual([])
  })
})
```

- [ ] **Step 2: Run — FAIL** (`npx vitest run src/components/flags/__tests__/flag-search.test.ts`) — module missing.

- [ ] **Step 3: Implement** `src/components/flags/flag-search.ts`:

```ts
/**
 * Fold server comment-search hits into the flyout's client-filtered list.
 *
 * The instant client-side filter (title / Sample ID substring — `filterFlags`)
 * stays the source of truth for visibility; this only ADDS flags the SERVER
 * matched on a comment body, which the client can't see because comment bodies
 * aren't in the list payload. Title-only server hits need no augmentation (the
 * client already matches titles), so they never add rows. Returns the visible
 * list (client matches first, then comment-only extras in tab order) plus a
 * per-flag-id map of the snippet for the "matched in comments" badge.
 */
import type { FlagResponse, FlagSearchHit } from '@/lib/flags-api'

export interface FlagSearchMeta {
  snippet: string
}

export function mergeSearchHits(
  tabFlags: FlagResponse[],
  clientVisible: FlagResponse[],
  hits: FlagSearchHit[]
): { flags: FlagResponse[]; searchMeta: Map<number, FlagSearchMeta> } {
  const commentHitById = new Map(
    hits.filter(h => h.matched_in.includes('comment')).map(h => [h.flag_id, h])
  )
  const visibleIds = new Set(clientVisible.map(f => f.id))
  const extras = tabFlags.filter(
    f => !visibleIds.has(f.id) && commentHitById.has(f.id)
  )
  const flags = [...clientVisible, ...extras]

  const searchMeta = new Map<number, FlagSearchMeta>()
  for (const f of flags) {
    const h = commentHitById.get(f.id)
    if (h) searchMeta.set(f.id, { snippet: h.snippet })
  }
  return { flags, searchMeta }
}
```

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): mergeSearchHits helper (fold comment hits into tab list)"`

---

### Task 6: Frontend — snippet + badge on FlagCard and FlagTable

**Files:**
- Modify: `src/components/flags/FlagCard.tsx` (optional `search` prop)
- Modify: `src/components/flags/FlagTable.tsx` (optional `searchMeta` prop threaded to rows)
- Test: `src/components/flags/__tests__/FlagCard.search.test.tsx` (create); extend `FlagTable` coverage if a test file exists, else a small new one

**Interfaces:**
- Consumes: `FlagSearchMeta` from `@/components/flags/flag-search`.
- Produces: `<FlagCard … search?={FlagSearchMeta} />` renders a "matched in comments" badge + a snippet line when `search` is set. `<FlagTable … searchMeta?={Map<number, FlagSearchMeta>} />` renders the badge in the Title cell + the snippet as the row `title` tooltip (the fixed grid can't take a full extra line). Absent props ⇒ zero visual change (additive).

- [ ] **Step 1: Failing test** — `src/components/flags/__tests__/FlagCard.search.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FlagCard } from '@/components/flags/FlagCard'
import type { FlagResponse } from '@/lib/flags-api'

vi.mock('@/lib/api', async orig => ({
  ...(await orig()),
  getWorksheetUsers: vi.fn().mockResolvedValue([]),
}))

const wrap = (ui: React.ReactElement) => (
  <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
)

const flag = (): FlagResponse =>
  ({
    id: 1, entity_type: 'sample', entity_id: 'P-1', kind: 'issue',
    type: 'blocker', status: 'open', title: 'Pump seal', created_by: 1,
    assignee_id: null, created_at: '', updated_at: '2026-07-09T00:00:00',
    resolved_at: null, resolved_by: null, entity: null,
  }) as FlagResponse

describe('FlagCard search snippet', () => {
  it('shows the badge + snippet when a comment matched', () => {
    render(wrap(
      <FlagCard flag={flag()} search={{ snippet: '…cloudy precipitate settled…' }} />
    ))
    expect(screen.getByText(/matched in comments/i)).toBeInTheDocument()
    expect(screen.getByText(/cloudy precipitate settled/)).toBeInTheDocument()
  })

  it('renders no snippet affordance without the search prop', () => {
    render(wrap(<FlagCard flag={flag()} />))
    expect(screen.queryByText(/matched in comments/i)).toBeNull()
  })
})
```

(Mirror the existing flag component tests' mocking idiom — if sibling tests in `src/components/flags/__tests__/` mock `useFlagTypesMap` / the user query differently, follow that file's pattern.)

- [ ] **Step 2: Run — FAIL** (`npx vitest run src/components/flags/__tests__/FlagCard.search.test.tsx`) — `search` prop unknown, no badge.

- [ ] **Step 3: Implement.** `FlagCard.tsx` — import the type and extend the props:

```tsx
import type { FlagSearchMeta } from '@/components/flags/flag-search'
```

```tsx
export function FlagCard({
  flag,
  unread = false,
  highlight = false,
  search,
}: {
  flag: FlagResponse
  unread?: boolean
  highlight?: boolean
  search?: FlagSearchMeta
}) {
```

In the meta row (inside the `flex flex-wrap … text-muted-foreground` div that holds the entity chip / type pill / status badge), append after the status badge:

```tsx
          {search && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--flag-unread)]/15 px-2 py-0.5 text-[10px] font-medium text-foreground/70">
              matched in comments
            </span>
          )}
```

After the title `<div>` (and the existing `hasContext` context block), add the snippet line:

```tsx
        {search && (
          <div className="mt-0.5 truncate text-[11px] italic text-muted-foreground">
            {search.snippet}
          </div>
        )}
```

`FlagTable.tsx` — thread the map through:

```tsx
import type { FlagSearchMeta } from '@/components/flags/flag-search'
```

Add `searchMeta?: Map<number, FlagSearchMeta>` to `FlagTable`'s props and pass `search={searchMeta?.get(flag.id)}` into each `FlagTableRow`; add `search?: FlagSearchMeta` to `FlagTableRow`'s props. In the Title cell, set the tooltip to the snippet when present and append a small badge:

```tsx
      {/* Title */}
      <span
        className="flex min-w-0 items-center gap-1.5 font-semibold text-foreground"
        title={search ? search.snippet : flag.title}
      >
        <span className="truncate">{flag.title}</span>
        {search && (
          <span
            className="shrink-0 rounded-full bg-[var(--flag-unread)]/15 px-1.5 text-[9px] font-medium text-foreground/70"
            title={search.snippet}
          >
            💬
          </span>
        )}
      </span>
```

- [ ] **Step 4: Run — PASS.** Also `npx vitest run src/components/flags` (flag suite baseline + new) and `npx tsc --noEmit -p tsconfig.json`.

- [ ] **Step 5: Commit** — `git commit -m "feat(flags): comment-match badge + snippet on card and table"`

---

### Task 7: Frontend — wire debounced comment search into FlagsFlyout

**Files:**
- Modify: `src/components/flags/FlagsFlyout.tsx`
- Modify: `src/components/flags/FlagsFilterBar.tsx` (placeholder + aria-label copy)

**Interfaces:**
- Consumes: `useFlagSearch` (Task 4), `useDebouncedValue` (Task 4), `mergeSearchHits` (Task 5), the card/table `search`/`searchMeta` props (Task 6).
- Produces: for a ≥3-char query (300 ms debounced), comment matches in the current tab appear with a badge + snippet; <3 chars keeps the instant title/ID filter unchanged. The "No matching flags" empty-state is suppressed while a search request is in flight.

- [ ] **Step 1: Update the filter-bar copy** so the box signals comments are searched (spec §7's first sentence). In `FlagsFilterBar.tsx`, change the input's `placeholder` and `aria-label`:

```tsx
          placeholder="Search title, Sample ID, or comments…"
          aria-label="Search flags by title, Sample ID, or comment"
```

- [ ] **Step 2: Wire the search in `FlagsFlyout.tsx`.** Add imports:

```tsx
import { useFlagSearch } from '@/hooks/use-flags'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { mergeSearchHits } from '@/components/flags/flag-search'
```

Replace the client-filter block (currently):

```tsx
  // Client-side triage filters layered on the fetched list (no API change).
  const total = flags?.length ?? 0
  const visibleFlags = flags ? filterFlags(flags, filter) : []
  const hasFlags = total > 0
  const filteredOut = hasFlags && visibleFlags.length === 0
```

with:

```tsx
  // Client-side triage filters layered on the fetched list (no API change).
  const total = flags?.length ?? 0
  const clientVisible = flags ? filterFlags(flags, filter) : []

  // Comment search: the instant client filter above stays untouched; for a
  // 3+ char query (debounced) we ALSO fetch comment/title matches server-side
  // and merge in the ones the client dropped (comment-only hits). Search is
  // tab-agnostic server-side; mergeSearchHits intersects with this tab's list.
  const liveText = filter.text.trim()
  const debouncedText = useDebouncedValue(liveText, 300)
  const searchActive = liveText.length >= 3 && debouncedText.length >= 3
  const searchQuery = useFlagSearch(searchActive ? debouncedText : '')
  const hits = searchQuery.data ?? []

  const { flags: visibleFlags, searchMeta } = searchActive
    ? mergeSearchHits(flags ?? [], clientVisible, hits)
    : { flags: clientVisible, searchMeta: EMPTY_SEARCH_META }

  const hasFlags = total > 0
  // Don't flash "no matches" while a comment query is still in flight — a
  // comment-only query has clientVisible === [] until the hits land.
  const searchPending = searchActive && searchQuery.isFetching
  const filteredOut = hasFlags && visibleFlags.length === 0 && !searchPending
```

Add a module-level constant near the top of the file (after the imports) so the non-search branch reuses one empty map:

```tsx
const EMPTY_SEARCH_META = new Map<number, import('@/components/flags/flag-search').FlagSearchMeta>()
```

(Or import `FlagSearchMeta` normally at the top and write `new Map<number, FlagSearchMeta>()` — match the file's existing import style.)

- [ ] **Step 3: Pass the metadata into the renderers.** In the list/table render block, update the two call sites:

```tsx
                    <FlagTable
                      flags={visibleFlags}
                      highlightIds={highlightIds}
                      unreadIds={unreadIds}
                      searchMeta={searchMeta}
                    />
```

```tsx
                    visibleFlags.map(flag => (
                      <FlagCard
                        key={flag.id}
                        flag={flag}
                        highlight={highlightIds.has(flag.id)}
                        unread={unreadIds.has(flag.id)}
                        search={searchMeta.get(flag.id)}
                      />
                    ))
```

- [ ] **Step 4: Reflect search in the count line** (optional but honest — the "N of total" line under-counts while searching). Where it renders `{visibleFlags.length} of {total}`, append a pending hint:

```tsx
                    {visibleFlags.length} of {total}
                    {searchPending && (
                      <span className="ml-2 italic">searching comments…</span>
                    )}
```

- [ ] **Step 5: Typecheck + full flag suite.**

Run: `npx vitest run src/components/flags src/hooks/__tests__/use-flags.test.tsx && npx tsc --noEmit -p tsconfig.json`
Expected: PASS (flag + hook suites baseline + new tests).

- [ ] **Step 6: Commit** — `git commit -m "feat(flags): debounced comment search wired into the flyout"`

---

### Task 8: Slice gates (no push, no PR)

- [ ] **Step 1:** `npm run check:all` — typecheck, lint, ast:lint, format, rust, tests. Expected: green except the documented baseline failures (compare the failure **set** to the ~34-frontend baseline, not the count).
- [ ] **Step 2:** `npm run build` — succeeds.
- [ ] **Step 3:** `python -m pytest backend/tests -q` — failure set matches the ~19 known backend baseline (no NEW failures). Confirm `test_flags_search.py` + `test_flags_search_route.py` pass.
- [ ] **Step 4:** Commit any straggler formatting only: `git commit -am "chore(flags): slice 4 gates"`. **Do NOT push and do NOT open a PR** — this slice ends at green gates on `feat/flag-p2-search`; the team lead owns branch push + PR.
