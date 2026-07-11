# Flag P2 Slice 1 — Filters & Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Composite "All Open" status filter (default on personal tabs), assignee filter, Activity-tab personalization chips, and watcher visibility/management in the flag thread.

**Architecture:** Pure client-side filter extensions on the existing `filterFlags` predicate (lists are already fully fetched per tab); two small additive backend changes — `watchers` on `FlagDetailResponse` and a `relevance` marker list on `ActivityItem`. No migrations, no new SSE endpoints.

**Tech Stack:** React 18 + TypeScript + shadcn Select + TanStack Query (frontend), FastAPI + SQLAlchemy (backend). Spec: `docs/superpowers/specs/2026-07-09-flag-system-phase2-design.md` §4.

## Global Constraints

- **npm only** for the Accu-Mk1 frontend (never pnpm/yarn). No new dependencies in this slice.
- **Additive only** — no behavior change to existing tabs' server scoping; existing tests stay green (gate = normalized failure-set diff vs the known baseline, ~19 backend / 34 frontend known failures).
- **Module purity** — `backend/flags/` must not import Mk1 host models; user resolution stays client-side via `useFlagUsers()`.
- Watchers get **no live toasts** (Phase 1 LOCKED decision) — this slice adds no notification paths.
- Frontend gates per task: `npx vitest run <file>`; slice gate: `npm run check:all` + `npm run build`. Backend: `python -m pytest backend/tests -k flag -q`.
- Branch: `feat/flag-p2-filters` off `origin/master`. Commit after every task.

---

### Task 1: `all_open` composite status in the filter predicate

**Files:**
- Modify: `src/components/flags/flag-status.ts` (add `OPEN_STATUSES` export)
- Modify: `src/components/flags/flag-filter.ts`
- Test: `src/components/flags/__tests__/flag-filter.test.ts` (extend existing)

**Interfaces:**
- Consumes: `FlagStatus` from `@/lib/flags-api`; existing `FlagFilterState`, `filterFlags`.
- Produces: `OPEN_STATUSES: FlagStatus[]` (flag-status.ts); `filterFlags` honoring `status: 'all_open'`. Task 3's dropdown and Task 4's defaults rely on the literal string `'all_open'`.

- [ ] **Step 1: Write the failing tests** (append to the existing filter test file)

```ts
import { describe, expect, it } from 'vitest'
import { filterFlags, EMPTY_FLAG_FILTER } from '@/components/flags/flag-filter'
import type { FlagResponse } from '@/lib/flags-api'

const mk = (over: Partial<FlagResponse>): FlagResponse =>
  ({
    id: 1, entity_type: 'sample', entity_id: 'PB-1', kind: 'issue',
    type: 'blocker', status: 'open', title: 't', created_by: 1,
    assignee_id: null, created_at: '', updated_at: '',
    resolved_at: null, resolved_by: null, entity: null,
    ...over,
  }) as FlagResponse

describe('all_open composite status', () => {
  it('keeps open, in_progress, blocked; drops resolved, closed', () => {
    const flags = [
      mk({ id: 1, status: 'open' }),
      mk({ id: 2, status: 'in_progress' }),
      mk({ id: 3, status: 'blocked' }),
      mk({ id: 4, status: 'resolved' }),
      mk({ id: 5, status: 'closed' }),
    ]
    const out = filterFlags(flags, { ...EMPTY_FLAG_FILTER, status: 'all_open' })
    expect(out.map(f => f.id)).toEqual([1, 2, 3])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/flags/__tests__/flag-filter.test.ts`
Expected: FAIL — `all_open` currently matches nothing (exact-match branch).

- [ ] **Step 3: Implement**

In `flag-status.ts`, after `STATUS_ORDER`:

```ts
/** Statuses that count as "open" for the composite All-Open filter.
 *  Mirrors backend OPEN_STATES (catalog.py). */
export const OPEN_STATUSES: FlagStatus[] = ['open', 'in_progress', 'blocked']
```

In `flag-filter.ts`: import `OPEN_STATUSES` from `@/components/flags/flag-status`, update the doc comment on `status` to `A FlagStatus slug, 'all_open' (open ∪ in_progress ∪ blocked), or 'all'.`, and replace the status branch inside `filterFlags` with:

```ts
    if (status === 'all_open') {
      if (!OPEN_STATUSES.includes(flag.status as FlagStatus)) return false
    } else if (status !== 'all' && flag.status !== status) return false
```

Also update the early-return guard: `status === 'all'` stays the pass-through condition (`all_open` must NOT short-circuit).

- [ ] **Step 4: Run to verify it passes** — same command, expected PASS (and the rest of the file stays green).

- [ ] **Step 5: Commit** — `git commit -m "feat(flags): all_open composite status filter"`

---

### Task 2: `assignee` field in the filter state + predicate

**Files:**
- Modify: `src/components/flags/flag-filter.ts`
- Test: `src/components/flags/__tests__/flag-filter.test.ts`

**Interfaces:**
- Produces: `FlagFilterState.assignee: string` — `'all'` | `'none'` (unassigned) | a user id as decimal string (e.g. `'7'`). `EMPTY_FLAG_FILTER.assignee === 'all'`. Tasks 3–4 rely on these exact literals.

- [ ] **Step 1: Failing tests**

```ts
describe('assignee filter', () => {
  const flags = [
    mk({ id: 1, assignee_id: 7 }),
    mk({ id: 2, assignee_id: 9 }),
    mk({ id: 3, assignee_id: null }),
  ]
  it("'all' passes everything", () => {
    expect(filterFlags(flags, { ...EMPTY_FLAG_FILTER, assignee: 'all' })).toHaveLength(3)
  })
  it("matches a specific user id", () => {
    expect(filterFlags(flags, { ...EMPTY_FLAG_FILTER, assignee: '7' }).map(f => f.id)).toEqual([1])
  })
  it("'none' matches unassigned only", () => {
    expect(filterFlags(flags, { ...EMPTY_FLAG_FILTER, assignee: 'none' }).map(f => f.id)).toEqual([3])
  })
})
```

- [ ] **Step 2: Run — FAIL** (property `assignee` missing → TS error is the failure).

- [ ] **Step 3: Implement** — in `flag-filter.ts`:

```ts
export interface FlagFilterState {
  text: string
  /** A `FlagStatus` slug, `'all_open'`, or `'all'`. */
  status: string
  /** An entity-type slug (e.g. `sample`), or `'all'`. */
  entityType: string
  /** A flag-type slug (e.g. `blocker`), or `'all'`. */
  type: string
  /** `'all'`, `'none'` (unassigned), or a user id as string. */
  assignee: string
}

export const EMPTY_FLAG_FILTER: FlagFilterState = {
  text: '', status: 'all', entityType: 'all', type: 'all', assignee: 'all',
}
```

In `filterFlags`, destructure `assignee` and add before the text check:

```ts
    if (assignee === 'none') {
      if (flag.assignee_id != null) return false
    } else if (assignee !== 'all' && String(flag.assignee_id) !== assignee) {
      return false
    }
```

Extend the early-return guard with `&& assignee === 'all'`.
Fix any other construction sites of `FlagFilterState` the compiler reports (search `EMPTY_FLAG_FILTER` usages — spreads keep working).

- [ ] **Step 4: Run — PASS.** Also run `npx tsc --noEmit -p tsconfig.json` to catch missed construction sites.

- [ ] **Step 5: Commit** — `git commit -m "feat(flags): assignee filter predicate"`

---

### Task 3: FlagsFilterBar — All-Open option + assignee dropdown

**Files:**
- Modify: `src/components/flags/FlagsFilterBar.tsx`
- Test: `src/components/flags/__tests__/FlagsFilterBar.test.tsx` (create if absent; render-level)

**Interfaces:**
- Consumes: Task 1–2 literals; `useFlagUsers`, `nameForUser` from `@/components/flags/flag-users`.
- Produces: new optional prop `showAssignee?: boolean` (default `true`) — Task 4 passes `false` on the Assigned tab.

- [ ] **Step 1: Failing test**

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FlagsFilterBar } from '@/components/flags/FlagsFilterBar'
import { EMPTY_FLAG_FILTER } from '@/components/flags/flag-filter'

vi.mock('@/lib/api', async orig => ({
  ...(await orig()),
  getWorksheetUsers: vi.fn().mockResolvedValue([]),
}))

const wrap = (ui: React.ReactElement) => (
  <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
)

describe('FlagsFilterBar', () => {
  it('renders the assignee select by default', () => {
    render(wrap(<FlagsFilterBar value={EMPTY_FLAG_FILTER} onChange={() => {}} />))
    expect(screen.getByLabelText('Filter by assignee')).toBeInTheDocument()
  })
  it('hides the assignee select when showAssignee=false', () => {
    render(wrap(
      <FlagsFilterBar value={EMPTY_FLAG_FILTER} onChange={() => {}} showAssignee={false} />
    ))
    expect(screen.queryByLabelText('Filter by assignee')).toBeNull()
  })
})
```

(Mirror the mocking idiom of the existing tests in `src/components/flags/__tests__/` — if they mock `useFlagTypes` or the query layer differently, follow that file's pattern instead.)

- [ ] **Step 2: Run — FAIL** (no assignee select).

- [ ] **Step 3: Implement** — in `FlagsFilterBar.tsx`:

Props become `{ value, onChange, showAssignee = true }` with `showAssignee?: boolean` in the type. Add imports:

```tsx
import { useFlagUsers, nameForUser } from '@/components/flags/flag-users'
import { OPEN_STATUSES } from '@/components/flags/flag-status'
import { displayName } from '@/lib/user-display'
```

Status select: insert directly under `<SelectItem value="all">All statuses</SelectItem>`:

```tsx
          <SelectItem value="all_open">
            <span className="flex -space-x-0.5">
              {OPEN_STATUSES.map(s => <Dot key={s} color={STATUS_DOT[s]} />)}
            </span>
            All open
          </SelectItem>
```

Assignee select (render after the entity select, guarded by `showAssignee`):

```tsx
      {showAssignee && (
        <Select
          value={value.assignee}
          onValueChange={assignee => onChange({ ...value, assignee })}
        >
          <SelectTrigger size="sm" aria-label="Filter by assignee" className="h-8 w-auto text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Anyone</SelectItem>
            <SelectItem value="none">Unassigned</SelectItem>
            {users.map(u => (
              <SelectItem key={u.id} value={String(u.id)}>
                {displayName(u)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
```

where `const userMap = useFlagUsers()` and `const users = [...userMap.values()].sort((a, b) => displayName(a).localeCompare(displayName(b)))` at the top of the component.

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): All-Open + assignee options in filter bar"`

---

### Task 4: Per-tab filter defaults + localStorage persistence + flyout wiring

**Files:**
- Create: `src/components/flags/use-flag-filter.ts`
- Modify: `src/components/flags/FlagsFlyout.tsx` (replace `useState(EMPTY_FLAG_FILTER)` at ~line 127 and the reset at ~line 225)
- Test: `src/components/flags/__tests__/use-flag-filter.test.ts`

**Interfaces:**
- Consumes: `FlagFilterState`, `EMPTY_FLAG_FILTER` (Task 2 shape).
- Produces: `useFlagFilter(tab: string): [FlagFilterState, (next: FlagFilterState) => void]` — keyed storage `flags:filter:<tab>`; defaults `status: 'all_open'` on `assigned`/`raised`/`watching`, `'all'` otherwise.

- [ ] **Step 1: Failing tests**

```ts
import { renderHook, act } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useFlagFilter, defaultFlagFilter } from '@/components/flags/use-flag-filter'

beforeEach(() => localStorage.clear())

describe('useFlagFilter', () => {
  it('defaults personal tabs to all_open, others to all', () => {
    expect(defaultFlagFilter('assigned').status).toBe('all_open')
    expect(defaultFlagFilter('raised').status).toBe('all_open')
    expect(defaultFlagFilter('watching').status).toBe('all_open')
    expect(defaultFlagFilter('all_open').status).toBe('all')
  })
  it('persists per tab and restores', () => {
    const { result, rerender } = renderHook(({ tab }) => useFlagFilter(tab), {
      initialProps: { tab: 'raised' },
    })
    act(() => result.current[1]({ ...result.current[0], type: 'blocker' }))
    rerender({ tab: 'assigned' })
    expect(result.current[0].type).toBe('all')   // other tab untouched
    rerender({ tab: 'raised' })
    expect(result.current[0].type).toBe('blocker') // restored
    expect(result.current[0].status).toBe('all_open')
  })
  it('ignores corrupt storage', () => {
    localStorage.setItem('flags:filter:raised', '{not json')
    const { result } = renderHook(() => useFlagFilter('raised'))
    expect(result.current[0].status).toBe('all_open')
  })
})
```

- [ ] **Step 2: Run — FAIL** (module missing).

- [ ] **Step 3: Implement** `use-flag-filter.ts`:

```ts
/**
 * Per-tab persisted filter state for the flags flyout.
 * Stored under `flags:filter:<tab>` (same localStorage idiom as
 * `flags:viewMode`); personal tabs default to the composite All-Open status.
 */
import { useCallback, useMemo, useState } from 'react'
import {
  EMPTY_FLAG_FILTER,
  type FlagFilterState,
} from '@/components/flags/flag-filter'

const KEY = (tab: string) => `flags:filter:${tab}`
const PERSONAL_TABS = new Set(['assigned', 'raised', 'watching'])

export function defaultFlagFilter(tab: string): FlagFilterState {
  return {
    ...EMPTY_FLAG_FILTER,
    status: PERSONAL_TABS.has(tab) ? 'all_open' : 'all',
  }
}

function load(tab: string): FlagFilterState {
  try {
    const raw = localStorage.getItem(KEY(tab))
    if (!raw) return defaultFlagFilter(tab)
    const parsed = JSON.parse(raw)
    // Merge over defaults so missing/new keys stay valid.
    return { ...defaultFlagFilter(tab), ...parsed, text: '' }
  } catch {
    return defaultFlagFilter(tab)
  }
}

/** [filter, setFilter] for a tab; setFilter writes through to localStorage.
 *  Free-text is deliberately session-only (never persisted). */
export function useFlagFilter(
  tab: string
): [FlagFilterState, (next: FlagFilterState) => void] {
  // Bump to re-read after writes; load() is cheap.
  const [, setTick] = useState(0)
  const [session, setSession] = useState<Record<string, string>>({})

  const filter = useMemo(
    () => ({ ...load(tab), text: session[tab] ?? '' }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick invalidates
    [tab, session]
  )

  const setFilter = useCallback(
    (next: FlagFilterState) => {
      const { text, ...persisted } = next
      try {
        localStorage.setItem(KEY(tab), JSON.stringify(persisted))
      } catch {
        /* quota/SSR — session-only */
      }
      setSession(s => ({ ...s, [tab]: text }))
      setTick(t => t + 1)
    },
    [tab]
  )

  return [filter, setFilter]
}
```

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Wire the flyout.** In `FlagsFlyout.tsx`: replace `const [filter, setFilter] = useState<FlagFilterState>(EMPTY_FLAG_FILTER)` with `const [filter, setFilter] = useFlagFilter(tab)`; DELETE the `setFilter(EMPTY_FLAG_FILTER)` reset in the tab-change handler (~line 225) — per-tab persistence supersedes it; pass `showAssignee={tab !== 'assigned'}` to `<FlagsFilterBar>`. Keep unused imports tidy (`EMPTY_FLAG_FILTER` may drop out).

- [ ] **Step 6: Full flag suite + typecheck**

Run: `npx vitest run src/components/flags && npx tsc --noEmit -p tsconfig.json`
Expected: PASS (flag suite baseline ~117 tests + new ones).

- [ ] **Step 7: Commit** — `git commit -m "feat(flags): per-tab persisted filters, All-Open default on personal tabs"`

---

### Task 5: Backend — watchers on FlagDetailResponse

**Files:**
- Modify: `backend/flags/schemas.py` (WatcherOut + field), `backend/flags/service.py` (list_watchers), `backend/flags/routes.py` (attach in `get_flag`)
- Test: `backend/tests/test_flags_watchers_detail.py` (create; mirror fixture idiom of the existing `backend/tests/test_flag*` files — in-memory sqlite + `seed_builtins`)

**Interfaces:**
- Produces: `FlagDetailResponse.watchers: List[WatcherOut]` where `WatcherOut = {user_id: int, added_at: datetime, added_by: Optional[int]}`; `service.list_watchers(db, flag_id) -> list[FlagParticipant]` (404s via existing `NotFoundError` when the flag is missing). Task 7 mirrors this shape as TS `Watcher`.

- [ ] **Step 1: Failing test**

```python
def test_detail_includes_watchers(db, actor):
    flag = service.create_flag(db, user=actor, entity_type="sample",
                               entity_id="PB-1", type="blocker", title="t")
    service.add_watcher(db, user=actor, flag_id=flag.id, user_id=42)
    rows = service.list_watchers(db, flag.id)
    assert [w.user_id for w in rows if w.user_id == 42] == [42]

def test_list_watchers_missing_flag_404s(db):
    import pytest
    from backend.flags.errors import NotFoundError
    with pytest.raises(NotFoundError):
        service.list_watchers(db, 99999)
```

(Adopt the existing conftest fixtures — the flag test files already define `db`/actor-style helpers; reuse, don't reinvent. Adjust import paths to match how sibling tests import `service`.)

- [ ] **Step 2: Run — FAIL** (`list_watchers` missing).

Run: `python -m pytest backend/tests/test_flags_watchers_detail.py -q`

- [ ] **Step 3: Implement.** `service.py`:

```python
def list_watchers(db: Session, flag_id: int) -> list[FlagParticipant]:
    """Watcher participants for a flag, oldest first. 404s on a missing flag."""
    get_flag(db, flag_id)
    return list(db.execute(
        select(FlagParticipant)
        .where(FlagParticipant.flag_id == flag_id,
               FlagParticipant.role == "watcher")
        .order_by(FlagParticipant.added_at.asc(), FlagParticipant.id.asc())
    ).scalars().all())
```

`schemas.py`:

```python
class WatcherOut(BaseModel):
    user_id: int
    added_at: datetime
    added_by: Optional[int] = None
    model_config = ConfigDict(from_attributes=True)
```

and on `FlagDetailResponse`: `watchers: List[WatcherOut] = Field(default_factory=list)`.

`routes.py` `get_flag`: build the response as today, then attach —

```python
        resp = _with_entity(db, service.get_flag(db, flag_id), FlagDetailResponse)
        resp.watchers = [WatcherOut.model_validate(w)
                         for w in service.list_watchers(db, flag_id)]
        return resp
```

(add `WatcherOut` to the schemas import list).

- [ ] **Step 4: Run — PASS**, then the whole flag suite: `python -m pytest backend/tests -k flag -q` — no new failures.

- [ ] **Step 5: Commit** — `git commit -m "feat(flags): watchers on flag detail response"`

---

### Task 6: Backend — ActivityItem relevance markers (+ mentions in comment events)

**Files:**
- Modify: `backend/flags/schemas.py` (`ActivityItem.relevance`), `backend/flags/service.py` (comment-event mentions if absent), `backend/flags/routes.py` (compute relevance in the activity route)
- Test: `backend/tests/test_flags_activity_relevance.py`

**Interfaces:**
- Produces: `ActivityItem.relevance: List[str]` — subset of `["actor", "assigned", "raised", "watching", "mentioned"]` for the REQUESTING user. Task 8 filters on these exact strings.

- [ ] **Step 1: Failing test**

```python
def test_activity_relevance_markers(db, actor, other):
    # actor raises + assigns to other; other watches nothing yet
    flag = service.create_flag(db, user=actor, entity_type="sample",
                               entity_id="PB-1", type="blocker", title="t",
                               assignee_id=other.id)
    rows, _ = service.list_activity(db, user_id=actor.id)
    rel = compute_relevance_for_tests(db, rows, user_id=actor.id)  # helper below
    raised_ev = next(r for r, m in rel if r.event_type == "raised")
    assert "actor" in dict(rel)[raised_ev] and "raised" in dict(rel)[raised_ev]

def test_comment_event_carries_mentions(db, actor):
    flag = service.create_flag(db, user=actor, entity_type="sample",
                               entity_id="PB-1", type="blocker", title="t")
    service.add_comment(db, user=actor, flag_id=flag.id, body="hi @x",
                        mention_ids=[7])
    ev = [e for e in service.get_flag(db, flag.id).events
          if e.event_type == "commented"][-1]
    assert (ev.details or {}).get("mentions") == [7]
```

(Write against the real function you factor out in Step 3 — name it `compute_relevance(db, events, *, user_id) -> dict[int, list[str]]` in `service.py`; fix the test to call it directly. Check first whether `add_comment` already writes `mentions` into the event details — if it does, keep the test as a regression guard and skip that part of Step 3.)

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** In `service.py` add:

```python
def compute_relevance(db: Session, events: list[FlagEvent], *,
                      user_id: int) -> dict[int, list[str]]:
    """Why each event is in this user's feed. Batch queries — no N+1."""
    flag_ids = {e.flag_id for e in events}
    flags = {f.id: f for f in db.execute(
        select(FlagFlag).where(FlagFlag.id.in_(flag_ids))).scalars()}
    watching = {fid for (fid,) in db.execute(
        select(FlagParticipant.flag_id).where(
            FlagParticipant.user_id == user_id,
            FlagParticipant.flag_id.in_(flag_ids),
            FlagParticipant.role == "watcher"))}
    out: dict[int, list[str]] = {}
    for e in events:
        rel: list[str] = []
        f = flags.get(e.flag_id)
        if e.actor_id == user_id: rel.append("actor")
        if f is not None and f.assignee_id == user_id: rel.append("assigned")
        if f is not None and f.created_by == user_id: rel.append("raised")
        if e.flag_id in watching: rel.append("watching")
        if user_id in ((e.details or {}).get("mentions") or []): rel.append("mentioned")
        out[e.id] = rel
    return out
```

If `add_comment`'s `_audit(...)` call doesn't already put `mentions` in details, extend its details dict additively: `details={..., "mentions": mention_ids or []}`.

`schemas.py`: `ActivityItem` gains `relevance: List[str] = Field(default_factory=list)`.

Activity route: after fetching `(rows, next_cursor)`, call `rel = service.compute_relevance(db, rows, user_id=user.id)` and set `relevance=rel.get(e.id, [])` when building each `ActivityItem`.

- [ ] **Step 4: Run — PASS**; full `-k flag` suite green (baseline diff only).
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): activity relevance markers + comment-event mentions"`

---

### Task 7: Thread watcher row (FlagWatchers component)

**Files:**
- Create: `src/components/flags/FlagWatchers.tsx`
- Modify: `src/lib/flags-api.ts` (add `Watcher` interface + `watchers` on the detail type), `src/components/flags/FlagThread.tsx` (mount under the header block, near the status/assignee controls ~line 241–310)
- Test: `src/components/flags/__tests__/FlagWatchers.test.tsx`

**Interfaces:**
- Consumes: `Watcher {user_id: number; added_at: string; added_by: number | null}` (mirror of Task 5), existing `addWatcher(id, user_id)` / `removeWatcher(id, user_id)` from `flags-api.ts`, `useFlagUsers`/`nameForUser`/`initialsForUser`/`avatarColor` from `flag-users.ts`, `FlagAvatar` component.
- Produces: `<FlagWatchers flagId={number} watchers={Watcher[]} currentUserId={number | null} />` — self-contained; invalidates the flag-detail query key on mutation (find the exact key in `use-flags.ts` — it's the hook the thread uses to fetch detail; reuse its key factory).

- [ ] **Step 1: Failing test**

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FlagWatchers } from '@/components/flags/FlagWatchers'

const api = vi.hoisted(() => ({
  addWatcher: vi.fn().mockResolvedValue({ ok: true }),
  removeWatcher: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/flags-api', async orig => ({ ...(await orig()), ...api }))
vi.mock('@/lib/api', async orig => ({
  ...(await orig()),
  getWorksheetUsers: vi.fn().mockResolvedValue([
    { id: 7, email: 'a@x.com', first_name: 'Ann', last_name: 'Lee' },
    { id: 9, email: 'b@x.com', first_name: 'Bo', last_name: 'Nguyen' },
  ]),
}))

const wrap = (ui: React.ReactElement) => (
  <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
)

describe('FlagWatchers', () => {
  it('shows watcher count and self watch toggle', async () => {
    render(wrap(
      <FlagWatchers flagId={1} currentUserId={9}
        watchers={[{ user_id: 7, added_at: '', added_by: null }]} />
    ))
    expect(await screen.findByText(/1 watching/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^watch$/i }))
    await waitFor(() => expect(api.addWatcher).toHaveBeenCalledWith(1, 9))
  })
  it('unwatch when already watching', async () => {
    render(wrap(
      <FlagWatchers flagId={1} currentUserId={7}
        watchers={[{ user_id: 7, added_at: '', added_by: null }]} />
    ))
    fireEvent.click(await screen.findByRole('button', { name: /unwatch/i }))
    await waitFor(() => expect(api.removeWatcher).toHaveBeenCalledWith(1, 7))
  })
})
```

- [ ] **Step 2: Run — FAIL** (component missing).

- [ ] **Step 3: Implement** `FlagWatchers.tsx`:

```tsx
/**
 * Watcher row for the flag thread: avatar cluster + count, expandable list
 * with remove, a self Watch/Unwatch toggle, and an add-watcher picker.
 * Names resolve client-side via the shared user directory (module purity —
 * the backend ships ids only). Watchers get no live toasts (Phase 1 LOCKED).
 */
import { useState } from 'react'
import { Eye, EyeOff, Plus, X } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { addWatcher, removeWatcher, type Watcher } from '@/lib/flags-api'
import {
  useFlagUsers, nameForUser, initialsForUser, avatarColor,
} from '@/components/flags/flag-users'
import { displayName } from '@/lib/user-display'

export function FlagWatchers({
  flagId, watchers, currentUserId,
}: {
  flagId: number
  watchers: Watcher[]
  currentUserId: number | null
}) {
  const users = useFlagUsers()
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const [adding, setAdding] = useState(false)

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ['flags'] }) // matches use-flags.ts key prefix; verify + adjust

  const add = useMutation({
    mutationFn: (userId: number) => addWatcher(flagId, userId),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (userId: number) => removeWatcher(flagId, userId),
    onSuccess: invalidate,
  })

  const watcherIds = new Set(watchers.map(w => w.user_id))
  const meWatching = currentUserId != null && watcherIds.has(currentUserId)
  const candidates = [...users.values()]
    .filter(u => !watcherIds.has(u.id))
    .sort((a, b) => displayName(a).localeCompare(displayName(b)))

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <button
        type="button"
        className="flex items-center gap-1 hover:text-foreground"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
      >
        <span className="flex -space-x-1.5">
          {watchers.slice(0, 4).map(w => (
            <span
              key={w.user_id}
              className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-white ring-1 ring-background"
              style={{ backgroundColor: avatarColor(w.user_id) }}
              title={nameForUser(users, w.user_id)}
            >
              {initialsForUser(users, w.user_id, currentUserId)}
            </span>
          ))}
        </span>
        {watchers.length} watching
      </button>

      <Button
        variant="ghost" size="sm" className="h-6 px-2 text-xs"
        onClick={() =>
          currentUserId != null &&
          (meWatching ? remove.mutate(currentUserId) : add.mutate(currentUserId))
        }
      >
        {meWatching ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
        {meWatching ? 'Unwatch' : 'Watch'}
      </Button>

      {adding ? (
        <Select
          onValueChange={v => { add.mutate(Number(v)); setAdding(false) }}
          onOpenChange={open => { if (!open) setAdding(false) }}
          defaultOpen
        >
          <SelectTrigger size="sm" aria-label="Add watcher" className="h-6 w-40 text-xs">
            <SelectValue placeholder="Add watcher…" />
          </SelectTrigger>
          <SelectContent>
            {candidates.map(u => (
              <SelectItem key={u.id} value={String(u.id)}>{displayName(u)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setAdding(true)}>
          <Plus className="h-3 w-3" /> Add watcher
        </Button>
      )}

      {expanded && (
        <ul className="w-full space-y-1 pl-1">
          {watchers.map(w => (
            <li key={w.user_id} className="flex items-center gap-2">
              <span className="text-foreground">{nameForUser(users, w.user_id)}</span>
              <button
                type="button" aria-label={`Remove ${nameForUser(users, w.user_id)}`}
                className="text-muted-foreground hover:text-destructive"
                onClick={() => remove.mutate(w.user_id)}
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
```

`flags-api.ts`: add

```ts
/** Mirrors backend `WatcherOut`. */
export interface Watcher {
  user_id: number
  added_at: string
  added_by: number | null
}
```

and `watchers: Watcher[]` on the detail interface (the type `getFlag`/detail hook returns — find it next to `FlagDetailResponse`'s mirror in this file; add with a default `[]` treatment at the consumer).

`FlagThread.tsx`: mount `<FlagWatchers flagId={flag.id} watchers={flag.watchers ?? []} currentUserId={currentUserId} />` inside the header section, directly below the status/assignee control row (~line 306 area) — `currentUserId` is already available in the thread for the "YOU" avatar logic; reuse the same source.

- [ ] **Step 4: Run — PASS**; verify the invalidate key against `use-flags.ts` and correct if the prefix differs.
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): watcher row in thread (view/add/remove/self-toggle)"`

---

### Task 8: Activity tab personalization chips

**Files:**
- Modify: `src/lib/flags-api.ts` (`relevance` on `ActivityItem`), `src/components/flags/FlagActivityFeed.tsx`
- Test: `src/components/flags/__tests__/flag-activity-chips.test.ts`

**Interfaces:**
- Consumes: `ActivityItem.relevance: string[]` (Task 6 literals).
- Produces: pure helper `filterActivity(items: ActivityItem[], chip: ActivityChip): ActivityItem[]` with `type ActivityChip = 'all' | 'actor' | 'mine' | 'watching' | 'mentioned'` exported from `FlagActivityFeed.tsx` (`'mine'` = `assigned ∪ raised`).

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest'
import { filterActivity } from '@/components/flags/FlagActivityFeed'
import type { ActivityItem } from '@/lib/flags-api'

const item = (id: number, relevance: string[]): ActivityItem =>
  ({ id, event_type: 'commented', actor_id: 1, from_value: null,
     to_value: null, created_at: '', relevance, flag: {} as never })

describe('filterActivity', () => {
  const items = [
    item(1, ['actor']),
    item(2, ['assigned']),
    item(3, ['raised', 'watching']),
    item(4, ['mentioned']),
  ]
  it('all passes everything', () =>
    expect(filterActivity(items, 'all')).toHaveLength(4))
  it('actor', () =>
    expect(filterActivity(items, 'actor').map(i => i.id)).toEqual([1]))
  it('mine = assigned ∪ raised', () =>
    expect(filterActivity(items, 'mine').map(i => i.id)).toEqual([2, 3]))
  it('watching', () =>
    expect(filterActivity(items, 'watching').map(i => i.id)).toEqual([3]))
  it('mentioned', () =>
    expect(filterActivity(items, 'mentioned').map(i => i.id)).toEqual([4]))
})
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** `flags-api.ts`: `relevance: string[]` on `ActivityItem` (optional `relevance?: string[]` if older cached payloads matter — they don't; make it required and default `[]` where constructed in tests). In `FlagActivityFeed.tsx`:

```ts
export type ActivityChip = 'all' | 'actor' | 'mine' | 'watching' | 'mentioned'

export function filterActivity(
  items: ActivityItem[], chip: ActivityChip
): ActivityItem[] {
  if (chip === 'all') return items
  if (chip === 'mine')
    return items.filter(i =>
      i.relevance.includes('assigned') || i.relevance.includes('raised'))
  return items.filter(i => i.relevance.includes(chip))
}
```

Chip row UI above the feed list (persist choice in localStorage `flags:activityChip`):

```tsx
const CHIPS: { key: ActivityChip; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'actor', label: 'My actions' },
  { key: 'mine', label: 'My flags' },
  { key: 'watching', label: 'Watching' },
  { key: 'mentioned', label: 'Mentions' },
]
// inside the component:
const [chip, setChip] = useState<ActivityChip>(
  () => (localStorage.getItem('flags:activityChip') as ActivityChip) || 'all')
const pick = (c: ActivityChip) => { setChip(c); localStorage.setItem('flags:activityChip', c) }
// render:
<div className="flex gap-1 px-3 py-2">
  {CHIPS.map(c => (
    <button key={c.key} type="button" onClick={() => pick(c.key)}
      className={`rounded-full border px-2 py-0.5 text-[11px] ${
        chip === c.key ? 'border-primary bg-primary/10 text-primary'
                       : 'text-muted-foreground hover:text-foreground'}`}>
      {c.label}
    </button>
  ))}
</div>
```

and feed the list through `filterActivity(items, chip)` before rendering rows. (The feed paginates keyset pages — filter the concatenated items client-side; when a chip empties the current pages, show the existing empty-state with the text "No activity for this filter".)

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): activity personalization chips"`

---

### Task 9: Slice gates

- [ ] **Step 1:** `npm run check:all` — typecheck, lint, ast:lint, format, rust, tests. Expected: green except the documented baseline failures (compare failure SET to baseline, not count).
- [ ] **Step 2:** `npm run build` — succeeds.
- [ ] **Step 3:** `python -m pytest backend/tests -q` — failure set matches the ~19 known baseline (no NEW failures).
- [ ] **Step 4:** Commit any straggler formatting: `git commit -am "chore(flags): slice 1 gates"` and push branch `feat/flag-p2-filters`; open PR titled "Flag P2 Slice 1 — filters & visibility" against master.
