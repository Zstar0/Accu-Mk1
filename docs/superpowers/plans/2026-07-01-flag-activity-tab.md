# Flag Activity Tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fifth "Activity" tab to the Flags flyout — a newest-first, infinite-scroll feed of flag events relevant to the current user (assignee/creator/watcher + own actions), backed by one new read-only endpoint.

**Architecture:** New `GET /api/flags/activity` with keyset (cursor) pagination over `flag_events`, reusing the `list_flags` relevance predicate unioned with `actor_id == me`; each item embeds the resolved `FlagResponse`. Frontend adds a TanStack `useInfiniteQuery` hook, a pure verb helper, two components (feed + row), and wires a new tab into `FlagsFlyout`.

**Tech Stack:** FastAPI + SQLAlchemy (backend), React 19 + TanStack Query v5 + Zustand + shadcn (frontend), pytest + vitest.

## Global Constraints

- **Additive only** — no existing behavior changes; new endpoint + new UI only.
- **npm only** for the frontend.
- **Zustand selector syntax** (ast-grep enforced) — never destructure the store.
- Flag type colors come from `useFlagTypesMap` (includes inactive). Status labels from `STATUS_LABELS`.
- Backend tables keep the `flag_` prefix. Relevance predicate must match `service.list_flags` (assignee_id / created_by / flag_participants).
- Verify in the live stack (`accumark-flagsfe`), not just the SQLite unit tests. Gate on typecheck + lint(changed) + flag vitest + flag pytest + build — NOT the red aggregate `check:all`.

---

### Task 1: Backend — `list_activity` service + cursor + schemas + route + index

**Files:**
- Modify: `backend/flags/service.py` (add `_encode_cursor`, `_decode_cursor`, `list_activity`)
- Modify: `backend/flags/schemas.py` (add `ActivityItem`, `ActivityPage`)
- Modify: `backend/flags/routes.py` (add `GET /activity` above `/{flag_id}`)
- Modify: `backend/database.py` (add one idempotent `CREATE INDEX` to the migrations list)
- Test: `backend/tests/test_flags_activity.py`

**Interfaces:**
- Produces (service): `list_activity(db, *, user_id: int, cursor: str | None = None, limit: int = 25) -> tuple[list[FlagEvent], str | None]` — returns `(rows_newest_first, next_cursor)`; `next_cursor` is `None` on the last page. Raises `BadRequestError` on a malformed cursor.
- Produces (schema): `ActivityItem{ id, event_type, actor_id, from_value, to_value, created_at, flag: FlagResponse }`, `ActivityPage{ items: list[ActivityItem], next_cursor: str | None }`.
- Consumes: `FlagEvent`, `FlagFlag`, `FlagParticipant` (flags.models); `_with_entity` (routes.py); `BadRequestError` (flags.errors).

- [ ] **Step 1: Write the failing service tests**

Create `backend/tests/test_flags_activity.py`:

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
    import models  # noqa: F401
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


def _user(id):
    return SimpleNamespace(id=id, role="standard", email=f"u{id}@x.t")


def _raise(db, actor, title, assignee=None):
    from flags import service
    return service.create_flag(db, user=_user(actor), entity_type="sub_sample",
                               entity_id="1", type="blocker", title=title,
                               assignee_id=assignee)


def test_activity_relevance_and_order(db):
    from flags import service
    # Flag A: created by me(1), someone else(2) comments on it.
    a = _raise(db, actor=1, title="mine")
    service.add_comment(db, user=_user(2), flag_id=a.id, body="hi")
    # Flag B: not mine, not watched — I must NOT see its events.
    _raise(db, actor=9, title="theirs")
    rows, nxt = service.list_activity(db, user_id=1, limit=25)
    titles = [r.flag.title for r in rows]
    assert "theirs" not in titles                    # relevance excludes B
    assert "mine" in titles                           # creator relevance
    # Newest first: the comment event precedes the raise event.
    types = [r.event_type for r in rows if r.flag.title == "mine"]
    assert types[0] == "commented" and types[-1] == "raised"


def test_activity_includes_my_own_actions(db):
    from flags import service
    # A flag I neither created nor am assigned to, but I acted on (commented).
    other = _raise(db, actor=9, title="foreign")
    service.add_comment(db, user=_user(1), flag_id=other.id, body="me acting")
    rows, _ = service.list_activity(db, user_id=1, limit=25)
    assert any(r.event_type == "commented" and r.flag.title == "foreign" for r in rows)


def test_activity_keyset_pagination_no_dupes(db):
    from flags import service
    for i in range(5):
        _raise(db, actor=1, title=f"f{i}")
    page1, c1 = service.list_activity(db, user_id=1, limit=2)
    assert len(page1) == 2 and c1 is not None
    page2, c2 = service.list_activity(db, user_id=1, cursor=c1, limit=2)
    ids1 = {r.id for r in page1}
    ids2 = {r.id for r in page2}
    assert ids1.isdisjoint(ids2)                      # no dupes across the boundary
    page3, c3 = service.list_activity(db, user_id=1, cursor=c2, limit=2)
    assert c3 is None                                 # last page → no next cursor


def test_activity_bad_cursor_raises(db):
    from flags import service
    from flags.errors import BadRequestError
    with pytest.raises(BadRequestError):
        service.list_activity(db, user_id=1, cursor="!!notbase64!!", limit=5)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `docker compose -p accumark-flagsfe exec -T accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_flags_activity.py -q"`
Expected: FAIL — `AttributeError: module 'flags.service' has no attribute 'list_activity'`.

- [ ] **Step 3: Implement `list_activity` + cursor helpers in `service.py`**

At the top of `backend/flags/service.py`, ensure these imports exist (add any missing): `import base64`, `from datetime import datetime`, and confirm `select, or_, and_` come from sqlalchemy and `BadRequestError` from `flags.errors` (both already used by `list_flags`). Then add:

```python
def _encode_cursor(ev: "FlagEvent") -> str:
    raw = f"{ev.created_at.isoformat()}|{ev.id}"
    return base64.urlsafe_b64encode(raw.encode()).decode()


def _decode_cursor(cursor: str) -> tuple[datetime, int]:
    try:
        raw = base64.urlsafe_b64decode(cursor.encode()).decode()
        ts_str, id_str = raw.rsplit("|", 1)
        return datetime.fromisoformat(ts_str), int(id_str)
    except Exception:
        raise BadRequestError("bad activity cursor")


def list_activity(db: Session, *, user_id: int, cursor: Optional[str] = None,
                  limit: int = 25) -> tuple[list["FlagEvent"], Optional[str]]:
    """Newest-first feed of flag events relevant to `user_id`: events on flags
    they're the assignee/creator/watcher of, unioned with their own actions.
    Keyset paginated on (created_at, id); returns (rows, next_cursor)."""
    limit = max(1, min(limit, 50))
    relevant = select(FlagFlag.id).where(or_(
        FlagFlag.assignee_id == user_id,
        FlagFlag.created_by == user_id,
        FlagFlag.id.in_(select(FlagParticipant.flag_id)
                        .where(FlagParticipant.user_id == user_id)),
    ))
    stmt = select(FlagEvent).where(or_(
        FlagEvent.actor_id == user_id,
        FlagEvent.flag_id.in_(relevant),
    ))
    if cursor:
        c_ts, c_id = _decode_cursor(cursor)
        stmt = stmt.where(or_(
            FlagEvent.created_at < c_ts,
            and_(FlagEvent.created_at == c_ts, FlagEvent.id < c_id),
        ))
    stmt = stmt.order_by(FlagEvent.created_at.desc(), FlagEvent.id.desc()).limit(limit + 1)
    rows = list(db.execute(stmt).scalars().all())
    next_cursor = None
    if len(rows) > limit:
        rows = rows[:limit]
        next_cursor = _encode_cursor(rows[-1])
    return rows, next_cursor
```

Confirm `FlagEvent`, `FlagFlag`, `FlagParticipant` are imported from `flags.models` at the top of `service.py` (FlagEvent/FlagFlag/FlagParticipant are already used elsewhere in the module — add FlagEvent to the import if missing).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `docker compose -p accumark-flagsfe exec -T accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_flags_activity.py -q"`
Expected: PASS (4 passed).

- [ ] **Step 5: Add the schemas**

In `backend/flags/schemas.py`, after `FlagDetailResponse`, add (confirm `datetime`, `Optional`, `List`, `BaseModel` already imported — they are, used by existing models):

```python
class ActivityItem(BaseModel):
    id: int
    event_type: str
    actor_id: Optional[int] = None
    from_value: Optional[str] = None
    to_value: Optional[str] = None
    created_at: datetime
    flag: FlagResponse


class ActivityPage(BaseModel):
    items: List[ActivityItem]
    next_cursor: Optional[str] = None
```

- [ ] **Step 6: Add the route (above `/{flag_id}`)**

In `backend/flags/routes.py`: extend the schema import to include `ActivityItem, ActivityPage`, then add this handler immediately after the `summary` route (so the literal `/activity` is registered before the `/{flag_id}` param route):

```python
@router.get("/activity", response_model=ActivityPage)
def activity(cursor: Optional[str] = None, limit: int = Query(25, ge=1, le=50),
            db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        rows, next_cursor = service.list_activity(
            db, user_id=getattr(user, "id", None), cursor=cursor, limit=limit)
        items = [
            ActivityItem(
                id=ev.id, event_type=ev.event_type, actor_id=ev.actor_id,
                from_value=ev.from_value, to_value=ev.to_value,
                created_at=ev.created_at, flag=_with_entity(db, ev.flag),
            )
            for ev in rows
        ]
        return ActivityPage(items=items, next_cursor=next_cursor)
    except Exception as e:
        raise _http(e)
```

- [ ] **Step 7: Add a route test**

Append to `backend/tests/test_flags_activity.py` a `client` fixture (copy verbatim from `backend/tests/test_flags_routes.py` lines 11–43) and:

```python
def test_activity_endpoint_returns_page(client):
    r = client.post("/api/flags", json={"entity_type": "sub_sample", "entity_id": "1",
                                        "type": "blocker", "title": "epage"})
    assert r.status_code == 201, r.text
    a = client.get("/api/flags/activity?limit=10")
    assert a.status_code == 200, a.text
    body = a.json()
    assert body["items"][0]["flag"]["title"] == "epage"
    assert body["items"][0]["event_type"] == "raised"
    assert "next_cursor" in body


def test_activity_endpoint_bad_cursor_400(client):
    client.post("/api/flags", json={"entity_type": "sub_sample", "entity_id": "1",
                                    "type": "blocker", "title": "x"})
    assert client.get("/api/flags/activity?cursor=@@bad@@").status_code == 400
```

- [ ] **Step 8: Add the performance index to `database.py`**

In `backend/database.py`, inside the `migrations` list in `_run_migrations()` (append at the end of the list, before the closing `]`):

```python
        # Flag activity feed: keyset scan on (created_at, id) newest-first
        "CREATE INDEX IF NOT EXISTS ix_flag_events_created_at_id ON flag_events (created_at DESC, id DESC)",
```

- [ ] **Step 9: Run the full flag backend suite**

Run: `docker compose -p accumark-flagsfe exec -T accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_flags_activity.py tests/test_flags_routes.py -q"`
Expected: PASS (all green).

- [ ] **Step 10: Commit**

```bash
git add backend/flags/service.py backend/flags/schemas.py backend/flags/routes.py backend/database.py backend/tests/test_flags_activity.py
git commit -m "feat(flags): activity feed endpoint (relevance-scoped, keyset paging)"
```

---

### Task 2: Frontend — API client + infinite-query hook

**Files:**
- Modify: `src/lib/flags-api.ts` (add `ActivityItem`, `ActivityPage`, `getActivity`)
- Modify: `src/hooks/use-flags.ts` (add `flagKeys.activity`, `useFlagActivity`)

**Interfaces:**
- Consumes: `ActivityPage` from the backend (`{ items, next_cursor }`), `FlagResponse` (existing).
- Produces: `getActivity(cursor?: string, limit?: number) => Promise<ActivityPage>`; `useFlagActivity()` returning a TanStack infinite query; `ActivityItem`, `ActivityPage` TS interfaces.

- [ ] **Step 1: Add the API types + function**

In `src/lib/flags-api.ts`, after `FlagDetailResponse`, add:

```typescript
/** Mirrors `ActivityItem` — one audit event + its (entity-resolved) flag. */
export interface ActivityItem {
  id: number
  event_type: string
  actor_id: number | null
  from_value: string | null
  to_value: string | null
  created_at: string
  flag: FlagResponse
}

/** Mirrors `ActivityPage` — one keyset page of the activity feed. */
export interface ActivityPage {
  items: ActivityItem[]
  next_cursor: string | null
}
```

In the endpoint-functions section (near `getSummary`), add:

```typescript
/** `GET /api/flags/activity` — one keyset page of the user's relevance feed
 *  (newest first). Omit `cursor` for the first page. */
export const getActivity = (cursor?: string, limit = 25) => {
  const qs = new URLSearchParams({ limit: String(limit) })
  if (cursor) qs.set('cursor', cursor)
  return apiFetch<ActivityPage>(`/api/flags/activity?${qs.toString()}`)
}
```

- [ ] **Step 2: Add the query key + infinite hook**

In `src/hooks/use-flags.ts`: add `useInfiniteQuery` to the `@tanstack/react-query` import; add `getActivity` and `type ActivityPage` to the `@/lib/flags-api` import. Add to `flagKeys`:

```typescript
  activity: () => ['flags', 'activity'] as const,
```

Then add the hook (after `useFlag`):

```typescript
/** The relevance activity feed — newest-first, keyset-paginated. Under
 *  ['flags', …] so the SSE glue's blanket invalidate refreshes it too. */
export function useFlagActivity() {
  return useInfiniteQuery({
    queryKey: flagKeys.activity(),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      getActivity(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: ActivityPage) => last.next_cursor ?? undefined,
    staleTime: 5_000,
  })
}
```

- [ ] **Step 3: Typecheck**

Run: `docker compose -p accumark-flagsfe exec -T accu-mk1-frontend sh -c "cd /app && npm run typecheck"`
Expected: clean (no errors).

- [ ] **Step 4: Commit**

```bash
git add src/lib/flags-api.ts src/hooks/use-flags.ts
git commit -m "feat(flags-ui): activity API client + useInfiniteQuery hook"
```

---

### Task 3: Frontend — pure verb helper (TDD)

**Files:**
- Create: `src/components/flags/flag-activity.ts`
- Test: `src/components/flags/__tests__/flag-activity.test.ts`

**Interfaces:**
- Produces: `activityVerb(item: ActivityItem, me: number | null, opts: { nameOf: (id: number | null) => string; statusLabelOf: (slug: string) => string }): string` — the action phrase (no actor prefix), e.g. `"assigned this to you"`, `"moved this to Blocked"`, `"commented"`.

- [ ] **Step 1: Write the failing test**

Create `src/components/flags/__tests__/flag-activity.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { activityVerb } from '@/components/flags/flag-activity'
import type { ActivityItem } from '@/lib/flags-api'

const base: ActivityItem = {
  id: 1, event_type: 'raised', actor_id: 7, from_value: null, to_value: null,
  created_at: '2026-07-01T00:00:00Z',
  flag: {} as ActivityItem['flag'],
}
const opts = {
  nameOf: (id: number | null) => (id === 2 ? 'Alice' : `User ${id}`),
  statusLabelOf: (slug: string) => (slug === 'blocked' ? 'Blocked' : slug),
}

describe('activityVerb', () => {
  it('raised', () => {
    expect(activityVerb({ ...base, event_type: 'raised' }, 7, opts)).toBe('raised this flag')
  })
  it('assigned to you when to_value is me', () => {
    const i = { ...base, event_type: 'assigned', to_value: '5' }
    expect(activityVerb(i, 5, opts)).toBe('assigned this to you')
  })
  it('assigned to a named other', () => {
    const i = { ...base, event_type: 'assigned', to_value: '2' }
    expect(activityVerb(i, 5, opts)).toBe('assigned this to Alice')
  })
  it('status change uses the resolved status label', () => {
    const i = { ...base, event_type: 'status_changed', to_value: 'blocked' }
    expect(activityVerb(i, 7, opts)).toBe('moved this to Blocked')
  })
  it('commented', () => {
    expect(activityVerb({ ...base, event_type: 'commented' }, 7, opts)).toBe('commented')
  })
  it('falls back for unknown types', () => {
    expect(activityVerb({ ...base, event_type: 'weird' }, 7, opts)).toBe('updated this')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker compose -p accumark-flagsfe exec -T accu-mk1-frontend sh -c "cd /app && npx vitest run src/components/flags/__tests__/flag-activity.test.ts"`
Expected: FAIL — cannot resolve `flag-activity`.

- [ ] **Step 3: Implement the helper**

Create `src/components/flags/flag-activity.ts`:

```typescript
/**
 * Pure event → phrase mapping for the activity feed. Returns the action phrase
 * only (the row supplies the actor prefix — "You"/name — and the flag title).
 */
import type { ActivityItem } from '@/lib/flags-api'

export function activityVerb(
  item: ActivityItem,
  me: number | null,
  opts: {
    nameOf: (id: number | null) => string
    statusLabelOf: (slug: string) => string
  }
): string {
  const to = item.to_value
  switch (item.event_type) {
    case 'raised':
      return 'raised this flag'
    case 'assigned': {
      const toId = to != null ? Number(to) : null
      if (toId != null && me != null && toId === me) return 'assigned this to you'
      return `assigned this to ${opts.nameOf(toId)}`
    }
    case 'unassigned':
      return 'unassigned this'
    case 'commented':
      return 'commented'
    case 'status_changed':
      return `moved this to ${opts.statusLabelOf(to ?? '')}`
    case 'watcher_added':
      return 'started watching'
    case 'watcher_removed':
      return 'stopped watching'
    default:
      return 'updated this'
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `docker compose -p accumark-flagsfe exec -T accu-mk1-frontend sh -c "cd /app && npx vitest run src/components/flags/__tests__/flag-activity.test.ts"`
Expected: PASS (6 passed).

- [ ] **Step 5: Commit**

```bash
git add src/components/flags/flag-activity.ts src/components/flags/__tests__/flag-activity.test.ts
git commit -m "feat(flags-ui): pure activity verb mapping (tested)"
```

---

### Task 4: Frontend — activity row + feed components

**Files:**
- Create: `src/components/flags/FlagActivityRow.tsx`
- Create: `src/components/flags/FlagActivityFeed.tsx`
- Test: `src/components/flags/__tests__/FlagActivityFeed.test.tsx`

**Interfaces:**
- Consumes: `useFlagActivity` (Task 2), `activityVerb` (Task 3), `useFlagUsers`/`nameForUser`/`initialsForUser`/`avatarColor`, `relativeTime`, `entityDisplayLabel`, `useFlagTypesMap`, `STATUS_LABELS`, `useUIStore.openFlagThread`, `useAuthStore`.
- Produces: `<FlagActivityFeed />` (default export of the feed), `<FlagActivityRow item={...} />`.

- [ ] **Step 1: Implement the row**

Create `src/components/flags/FlagActivityRow.tsx`:

```tsx
import { useAuthStore } from '@/store/auth-store'
import { useUIStore } from '@/store/ui-store'
import type { ActivityItem } from '@/lib/flags-api'
import { flagTypeDef } from '@/components/flags/flag-catalog'
import { useFlagTypesMap } from '@/services/flag-types'
import { entityDisplayLabel } from '@/components/flags/flag-entity'
import {
  useFlagUsers,
  nameForUser,
  initialsForUser,
  avatarColor,
} from '@/components/flags/flag-users'
import { relativeTime } from '@/components/flags/flag-format'
import { STATUS_LABELS } from '@/components/flags/flag-status'
import { FlagAvatar } from '@/components/flags/FlagAvatar'
import { activityVerb } from '@/components/flags/flag-activity'
import type { FlagStatus } from '@/lib/flags-api'

/** One line in the Activity feed: actor → verb → flag → entity → time. Clicking
 *  opens that flag's thread. */
export function FlagActivityRow({ item }: { item: ActivityItem }) {
  const users = useFlagUsers()
  const typesMap = useFlagTypesMap()
  const me = useAuthStore(state => state.user?.id ?? null)

  const def = typesMap[item.flag.type] ?? flagTypeDef(item.flag.type)
  const actor =
    item.actor_id == null
      ? 'System'
      : item.actor_id === me
        ? 'You'
        : nameForUser(users, item.actor_id)
  const verb = activityVerb(item, me, {
    nameOf: id => (id == null ? 'someone' : nameForUser(users, id)),
    statusLabelOf: slug => STATUS_LABELS[slug as FlagStatus] ?? slug,
  })
  const entity = entityDisplayLabel(item.flag)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => useUIStore.getState().openFlagThread(item.flag.id)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          useUIStore.getState().openFlagThread(item.flag.id)
        }
      }}
      className="group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/60"
    >
      <FlagAvatar
        initials={initialsForUser(users, item.actor_id, me)}
        color={avatarColor(item.actor_id)}
        isYou={item.actor_id != null && item.actor_id === me}
      />
      <span className="min-w-0 flex-1 truncate text-[13px]">
        <span className="font-semibold text-foreground">{actor}</span>{' '}
        <span className="text-muted-foreground">{verb}</span>{' '}
        <span
          className="font-medium text-foreground"
          style={{ borderBottom: `2px solid ${def.color}` }}
        >
          {item.flag.title}
        </span>
        <span className="text-muted-foreground"> · {entity}</span>
      </span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {relativeTime(item.created_at)}
      </span>
    </div>
  )
}

export default FlagActivityRow
```

- [ ] **Step 2: Implement the feed (observer + Load-more fallback)**

Create `src/components/flags/FlagActivityFeed.tsx`:

```tsx
import { useEffect, useRef } from 'react'
import { Activity } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { useFlagActivity } from '@/hooks/use-flags'
import { FlagActivityRow } from '@/components/flags/FlagActivityRow'

/** Infinite-scroll activity feed. An IntersectionObserver sentinel auto-loads
 *  the next keyset page; a manual "Load more" button is the accessible fallback
 *  (and the path used where IntersectionObserver is unavailable, e.g. jsdom). */
export function FlagActivityFeed() {
  const {
    data,
    isLoading,
    isError,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useFlagActivity()

  const sentinel = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const node = sentinel.current
    if (!node || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
        fetchNextPage()
      }
    })
    io.observe(node)
    return () => io.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  const items = data?.pages.flatMap(p => p.items) ?? []

  if (isLoading) {
    return (
      <div className="space-y-2 p-3">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    )
  }

  if (isError) {
    return (
      <div className="p-6 text-center">
        <p className="text-sm text-muted-foreground">Couldn’t load activity.</p>
        <button
          type="button"
          onClick={() => refetch()}
          className="mt-2 text-xs font-semibold text-primary hover:underline"
        >
          Retry
        </button>
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
        <Activity className="mb-3 h-8 w-8 text-muted-foreground/30" />
        <p className="text-sm font-semibold">No activity yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Actions on your flags will show up here.
        </p>
      </div>
    )
  }

  return (
    <div className="p-1">
      {items.map(item => (
        <FlagActivityRow key={item.id} item={item} />
      ))}
      <div ref={sentinel} />
      {hasNextPage && (
        <div className="flex justify-center py-2">
          <button
            type="button"
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
            className="text-xs font-semibold text-primary hover:underline disabled:opacity-50"
          >
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  )
}

export default FlagActivityFeed
```

- [ ] **Step 3: Write the feed test**

Create `src/components/flags/__tests__/FlagActivityFeed.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const mockUseFlagActivity = vi.fn()
vi.mock('@/hooks/use-flags', () => ({
  useFlagActivity: () => mockUseFlagActivity(),
}))
// Row pulls users/types/auth — stub to keep the feed test focused.
vi.mock('@/components/flags/FlagActivityRow', () => ({
  FlagActivityRow: ({ item }: { item: { id: number; flag: { title: string } } }) => (
    <div>{item.flag.title}</div>
  ),
}))

const page = (titles: string[], next: string | null) => ({
  items: titles.map((t, i) => ({ id: i + 1, flag: { title: t } })),
  next_cursor: next,
})

beforeEach(() => mockUseFlagActivity.mockReset())

describe('FlagActivityFeed', () => {
  it('renders rows and a Load more when there is a next page', async () => {
    const fetchNextPage = vi.fn()
    mockUseFlagActivity.mockReturnValue({
      data: { pages: [page(['a', 'b'], 'cur')] },
      isLoading: false, isError: false, refetch: vi.fn(),
      fetchNextPage, hasNextPage: true, isFetchingNextPage: false,
    })
    const { FlagActivityFeed } = await import('@/components/flags/FlagActivityFeed')
    render(<FlagActivityFeed />)
    expect(screen.getByText('a')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Load more'))
    expect(fetchNextPage).toHaveBeenCalled()
  })

  it('shows the empty state when there is no activity', async () => {
    mockUseFlagActivity.mockReturnValue({
      data: { pages: [page([], null)] },
      isLoading: false, isError: false, refetch: vi.fn(),
      fetchNextPage: vi.fn(), hasNextPage: false, isFetchingNextPage: false,
    })
    const { FlagActivityFeed } = await import('@/components/flags/FlagActivityFeed')
    render(<FlagActivityFeed />)
    expect(screen.getByText('No activity yet')).toBeInTheDocument()
  })
})
```

- [ ] **Step 4: Run the feed + verb tests**

Run: `docker compose -p accumark-flagsfe exec -T accu-mk1-frontend sh -c "cd /app && npx vitest run src/components/flags/__tests__/FlagActivityFeed.test.tsx src/components/flags/__tests__/flag-activity.test.ts"`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `docker compose -p accumark-flagsfe exec -T accu-mk1-frontend sh -c "cd /app && npm run typecheck"` → clean.

```bash
git add src/components/flags/FlagActivityRow.tsx src/components/flags/FlagActivityFeed.tsx src/components/flags/__tests__/FlagActivityFeed.test.tsx
git commit -m "feat(flags-ui): activity feed + row components"
```

---

### Task 5: Wire the Activity tab into the flyout

**Files:**
- Modify: `src/components/flags/FlagsFlyout.tsx`

**Interfaces:**
- Consumes: `FlagActivityFeed` (Task 4). Introduces local `FlyoutTab = FlagTab | 'activity'`.

- [ ] **Step 1: Widen the tab type + add the tab**

In `src/components/flags/FlagsFlyout.tsx`:

Add the import: `import { FlagActivityFeed } from '@/components/flags/FlagActivityFeed'`.

Introduce the widened type and add the tab to `TABS`:

```tsx
type FlyoutTab = FlagTab | 'activity'

const TABS: { value: FlyoutTab; label: string }[] = [
  { value: 'assigned', label: 'Assigned to me' },
  { value: 'raised', label: 'Raised by me' },
  { value: 'watching', label: 'Watching' },
  { value: 'all_open', label: 'All open' },
  { value: 'activity', label: 'Activity' },
]
```

Change the tab state to the widened type: `const [tab, setTab] = useState<FlyoutTab>('assigned')`. The auto-jump subscription (`setTab(s.justOpenedTab)`) still type-checks (`FlagTab` ⊂ `FlyoutTab`).

- [ ] **Step 2: Guard the flag-list queries + render the feed on the Activity tab**

The four list queries must only run for real `FlagTab` values. Add a discriminator near the top of the component body:

```tsx
const isActivity = tab === 'activity'
```

Change `useFlagsList(tab)` to `useFlagsList(isActivity ? 'assigned' : (tab as FlagTab))` where the tab query is built (the `tabQuery` line) — the value is ignored when `isActivity` (the feed renders instead), and keeping a valid tab avoids a bad request. (The entity/samples-scoped queries are unaffected — a scoped flyout never shows tabs.)

In the tabbed (non-scoped) branch, render the feed instead of the list when `isActivity`. Wrap the existing filter-bar + list `<div className="min-h-0 flex-1 overflow-auto p-2">…</div>` region so that when `isActivity` is true you render `<div className="min-h-0 flex-1 overflow-auto"><FlagActivityFeed /></div>` and otherwise the existing content. Concretely, guard the filter bar and list body:

- The filter bar line becomes: `{!isActivity && !isLoading && !isError && hasFlags && (<FlagsFilterBar … />)}`
- Replace the list container with:

```tsx
{isActivity ? (
  <div className="min-h-0 flex-1 overflow-auto">
    <FlagActivityFeed />
  </div>
) : (
  <div className="min-h-0 flex-1 overflow-auto p-2">
    {/* …existing count line, skeleton, error, empty, list/table render… */}
  </div>
)}
```

Leave the view-toggle in the header as-is (it's harmless on the Activity tab, but if trivial, hide it: `{!isActivity && <ViewToggle … />}` in the non-scoped header only).

- [ ] **Step 3: Typecheck + flag vitest (no regressions)**

Run: `docker compose -p accumark-flagsfe exec -T accu-mk1-frontend sh -c "cd /app && npm run typecheck && npx vitest run src/components/flags"`
Expected: typecheck clean; all flag tests pass (existing FlagsFlyout tests still green — default tab is still `assigned`).

- [ ] **Step 4: Lint changed files**

Run: `docker compose -p accumark-flagsfe exec -T accu-mk1-frontend sh -c "cd /app && npx eslint src/components/flags/FlagsFlyout.tsx src/components/flags/FlagActivityFeed.tsx src/components/flags/FlagActivityRow.tsx src/components/flags/flag-activity.ts src/hooks/use-flags.ts src/lib/flags-api.ts"`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/flags/FlagsFlyout.tsx
git commit -m "feat(flags-ui): wire the Activity tab into the flyout"
```

---

### Task 6: Full-stack verification in the live stack

- [ ] **Step 1: Build**

Run: `docker compose -p accumark-flagsfe exec -T accu-mk1-frontend sh -c "cd /app && npm run build"`
Expected: `✓ built`.

- [ ] **Step 2: Live API smoke**

With the backend restarted (so the new route + index load): `docker compose -p accumark-flagsfe restart accu-mk1-backend`, then mint an admin JWT and `GET /api/flags/activity?limit=5` (see `project_flag_system_design` for the `httpx`/`auth.create_access_token` one-liner). Expected: 200 with `items` newest-first and a `next_cursor` (or null).

- [ ] **Step 3: Hand off to the user for visual review**

Confirm the Activity tab appears at `http://100.73.137.3:5552`, lists recent events newest-first, scrolls to load more, and clicking a row opens the thread. Await sign-off.

## Self-Review

- **Spec coverage:** endpoint + keyset paging (T1), index (T1.8), API client + infinite hook (T2), verb mapping (T3), feed + row + observer + Load-more + states (T4), 5th tab + hidden filter/toggle (T5), tests backend+frontend (T1/T3/T4), live verify (T6). ISO 17025 = read-only surface over the existing audit log (no code beyond the feed). All spec sections mapped.
- **Placeholder scan:** none — every step has concrete code/commands.
- **Type consistency:** `list_activity` returns `(rows, next_cursor)` used identically in the route; `ActivityPage.next_cursor`/`getNextPageParam` align; `activityVerb` signature identical across Task 3 definition and Task 4 use; `FlyoutTab` widening is backward-compatible with the existing `setTab(FlagTab)` auto-jump.
```
