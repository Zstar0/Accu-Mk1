# Flag Unread State — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Durable, cross-device per-flag unread state: a dedicated-color left-bar marker per row, unread dots on the flyout tabs, and a new "Unread" tab — all cleared when you open a flag's thread.

**Architecture:** New `flag_reads(user_id, flag_id, last_read_at)` table. Unread = a flag relevant to me (assignee/creator/participant) whose `updated_at` is newer than my `last_read_at` (or never read). One `GET /api/flags/unread` feeds three FE views; opening a thread `POST`s a read stamp. Real-time via the glue's existing `['flags']` invalidation.

**Tech Stack:** FastAPI + SQLAlchemy, React 19 + TanStack Query v5, pytest + vitest.

## Global Constraints

- **Additive only. npm only.** Zustand selector syntax. Colors: type stays in the pill; unread uses the dedicated `--flag-unread` token.
- `flag_reads` is a NEW table → `Base.metadata.create_all` creates it; no `database.py` DDL needed (unlike a column add).
- Verify in the live stack (`accumark-flagsfe`). Gate on typecheck + lint(changed) + flag vitest + flag pytest + build — NOT the red aggregate.

---

### Task 1: Backend — FlagRead model, relevance extract, list_unread, mark_read, routes (TDD)

**Files:**
- Modify: `backend/flags/models.py` (`FlagRead`)
- Modify: `backend/flags/service.py` (`_relevant_flag_ids`, refactor `list_activity`, `list_unread`, `mark_read`)
- Modify: `backend/flags/routes.py` (`GET /unread`, `POST /{flag_id}/read`)
- Test: `backend/tests/test_flags_unread.py`

**Interfaces:**
- Produces: `_relevant_flag_ids(user_id) -> Select`; `list_unread(db, *, user_id) -> list[FlagFlag]` (relevant + changed-since-read, newest-updated first); `mark_read(db, *, user_id, flag_id) -> None` (idempotent upsert).

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_flags_unread.py`:

```python
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    from flags import seams, types_service
    seams.set_event_sink(seams.InMemoryEventSink())
    seams.register_entity("sub_sample", label=lambda d, e: f"Vial {e}",
                          deep_link=lambda e: f"/v/{e}", can_flag=lambda u, e: True)
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    types_service.seed_builtins(s)
    from models import User
    for uid in (1, 2, 9):
        s.add(User(id=uid, email=f"u{uid}@x.t", hashed_password="x", is_active=True))
    s.commit()
    try:
        yield s
    finally:
        s.close()


def _user(id):
    return SimpleNamespace(id=id, role="standard", email=f"u{id}@x.t")


def _flag(db, actor, assignee=None):
    from flags import service
    return service.create_flag(db, user=_user(actor), entity_type="sub_sample",
                               entity_id="1", type="blocker", title="t",
                               assignee_id=assignee)


def test_relevant_flag_unread_until_read(db):
    from flags import service
    f = _flag(db, actor=1)                     # created by me(1) → relevant
    assert f.id in {x.id for x in service.list_unread(db, user_id=1)}
    service.mark_read(db, user_id=1, flag_id=f.id)
    assert f.id not in {x.id for x in service.list_unread(db, user_id=1)}


def test_new_activity_after_read_reopens_unread(db):
    from flags import service
    f = _flag(db, actor=1)
    service.mark_read(db, user_id=1, flag_id=f.id)
    service.add_comment(db, user=_user(9), flag_id=f.id, body="ping")  # bumps updated_at
    assert f.id in {x.id for x in service.list_unread(db, user_id=1)}


def test_irrelevant_flag_never_unread(db):
    from flags import service
    other = _flag(db, actor=9)                  # not mine, not assigned, not watching
    assert other.id not in {x.id for x in service.list_unread(db, user_id=1)}


def test_mark_read_is_idempotent(db):
    from flags import service
    from flags.models import FlagRead
    f = _flag(db, actor=1)
    service.mark_read(db, user_id=1, flag_id=f.id)
    service.mark_read(db, user_id=1, flag_id=f.id)
    rows = db.execute(select(FlagRead).where(FlagRead.user_id == 1,
                                             FlagRead.flag_id == f.id)).scalars().all()
    assert len(rows) == 1
```

- [ ] **Step 2: Run → fail** (push as RED, sync):
`docker compose -p accumark-flagsfe exec -T accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_flags_unread.py -q"` → FAIL (`FlagRead`/`list_unread` missing).

- [ ] **Step 3: Add the model**

In `backend/flags/models.py`, after `FlagEvent`:

```python
class FlagRead(Base):
    """Per-user last-read marker for a flag (drives unread state)."""
    __tablename__ = "flag_reads"
    __table_args__ = (UniqueConstraint("user_id", "flag_id", name="uq_flag_read"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    flag_id: Mapped[int] = mapped_column(Integer, ForeignKey("flag_flags.id", ondelete="CASCADE"),
                                         nullable=False, index=True)
    last_read_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
```

(`Integer`, `DateTime`, `ForeignKey`, `UniqueConstraint`, `Mapped`, `mapped_column`, `datetime` already imported.)

- [ ] **Step 4: Extract relevance + add `list_unread` + `mark_read` in `service.py`**

Add `FlagRead` to the `flags.models` import. Add the shared helper and refactor `list_activity`:

```python
def _relevant_flag_ids(user_id: int):
    """Flags the user is the assignee/creator/participant of (a Select of ids)."""
    return select(FlagFlag.id).where(or_(
        FlagFlag.assignee_id == user_id,
        FlagFlag.created_by == user_id,
        FlagFlag.id.in_(select(FlagParticipant.flag_id)
                        .where(FlagParticipant.user_id == user_id)),
    ))
```

In `list_activity`, replace the inline `relevant = select(...)` block with `relevant = _relevant_flag_ids(user_id)`.

Add:

```python
def list_unread(db: Session, *, user_id: int) -> list[FlagFlag]:
    """Flags relevant to the user that changed since they last read them
    (never-read counts as unread), newest-updated first."""
    stmt = (select(FlagFlag)
            .outerjoin(FlagRead, and_(FlagRead.flag_id == FlagFlag.id,
                                      FlagRead.user_id == user_id))
            .where(FlagFlag.id.in_(_relevant_flag_ids(user_id)))
            .where(or_(FlagRead.last_read_at.is_(None),
                       FlagFlag.updated_at > FlagRead.last_read_at))
            .order_by(FlagFlag.updated_at.desc()))
    return list(db.execute(stmt).scalars().all())


def mark_read(db: Session, *, user_id: int, flag_id: int) -> None:
    get_flag(db, flag_id)  # 404 if the flag doesn't exist
    row = db.execute(select(FlagRead).where(
        FlagRead.user_id == user_id, FlagRead.flag_id == flag_id)).scalar_one_or_none()
    if row is None:
        db.add(FlagRead(user_id=user_id, flag_id=flag_id, last_read_at=datetime.utcnow()))
    else:
        row.last_read_at = datetime.utcnow()
    db.commit()
```

- [ ] **Step 5: Routes**

In `backend/flags/routes.py`, add `GET /unread` immediately after the `activity` route (literal, above `/{flag_id}`):

```python
@router.get("/unread", response_model=List[FlagResponse])
def unread(db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        rows = service.list_unread(db, user_id=getattr(user, "id", None))
        return [_with_entity(db, r) for r in rows]
    except Exception as e:
        raise _http(e)
```

Add `POST /{flag_id}/read` near the other `/{flag_id}/…` mutations:

```python
@router.post("/{flag_id}/read", status_code=204)
def mark_read(flag_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        service.mark_read(db, user_id=getattr(user, "id", None), flag_id=flag_id)
    except Exception as e:
        raise _http(e)
```

- [ ] **Step 6: Run green** (push as `feat(flags): unread state — flag_reads + list_unread/mark_read`, sync):
`... pytest tests/test_flags_unread.py tests/test_flags_activity.py tests/test_flags_routes.py -q` → PASS (activity still green after the extract).

---

### Task 2: Frontend — API, hooks, dedicated color token

**Files:**
- Modify: `src/lib/flags-api.ts` (`getUnread`, `markRead`)
- Modify: `src/hooks/use-flags.ts` (`flagKeys.unread`, `useFlagUnread`)
- Modify: `src/App.css` (`--flag-unread`)

**Interfaces:**
- Produces: `getUnread() => Promise<FlagResponse[]>`; `markRead(id) => Promise<undefined>`; `useFlagUnread()`; `flagKeys.unread()`.

- [ ] **Step 1: API**

In `src/lib/flags-api.ts` (near `getSummary`):

```typescript
/** `GET /api/flags/unread` — flags relevant to me with unread changes. */
export const getUnread = () => apiFetch<FlagResponse[]>('/api/flags/unread')

/** `POST /api/flags/{id}/read` — stamp this flag read for me (204). */
export const markRead = (id: number) =>
  apiFetch<undefined>(`/api/flags/${id}/read`, { method: 'POST' })
```

- [ ] **Step 2: Query key + hook**

In `src/hooks/use-flags.ts`: add `getUnread` to the api import. Add to `flagKeys`:

```typescript
  unread: () => ['flags', 'unread'] as const,
```

Add the query (after `useFlagActivity`):

```typescript
/** Flags with unread notifications for me. Under ['flags', …] so the glue's
 *  blanket invalidate refreshes it live. */
export function useFlagUnread() {
  return useQuery({
    queryKey: flagKeys.unread(),
    queryFn: getUnread,
    staleTime: 5_000,
  })
}
```

- [ ] **Step 3: Dedicated color token**

In `src/App.css`, add near the flag animation block:

```css
/* Dedicated "unread" accent — not a type/status/flash color. Tune to taste. */
:root {
  --flag-unread: #ec4899;
}
```

- [ ] **Step 4: Typecheck + commit.**

---

### Task 3: Frontend — unread tab-bucketing (pure, TDD)

**Files:**
- Create: `src/components/flags/unread-buckets.ts`
- Test: `src/components/flags/__tests__/unread-buckets.test.ts`

**Interfaces:**
- Produces: `unreadBuckets(unread: FlagResponse[], me: number | null): { assigned: boolean; raised: boolean; watching: boolean; allOpen: boolean }`.

- [ ] **Step 1: Failing test**

Create `src/components/flags/__tests__/unread-buckets.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { unreadBuckets } from '@/components/flags/unread-buckets'
import type { FlagResponse } from '@/lib/flags-api'

const f = (over: Partial<FlagResponse>): FlagResponse =>
  ({
    id: 1, entity_type: 'sub_sample', entity_id: '1', kind: 'issue',
    type: 'blocker', status: 'open', title: 't', created_by: 9,
    assignee_id: null, created_at: '', updated_at: '', resolved_at: null,
    resolved_by: null, ...over,
  }) as FlagResponse

describe('unreadBuckets', () => {
  it('assigned when an open flag is assigned to me', () => {
    expect(unreadBuckets([f({ assignee_id: 5 })], 5).assigned).toBe(true)
  })
  it('raised when I created it', () => {
    expect(unreadBuckets([f({ created_by: 5 })], 5).raised).toBe(true)
  })
  it('watching when relevant but neither mine-assigned nor mine-created', () => {
    const b = unreadBuckets([f({ assignee_id: 9, created_by: 9 })], 5)
    expect(b.watching).toBe(true)
  })
  it('assigned excludes closed flags', () => {
    expect(unreadBuckets([f({ assignee_id: 5, status: 'closed' })], 5).assigned).toBe(false)
  })
})
```

- [ ] **Step 2: Run → fail. Step 3: Implement**

Create `src/components/flags/unread-buckets.ts`:

```typescript
import type { FlagResponse } from '@/lib/flags-api'

const CLOSED = new Set(['resolved', 'closed'])
const isOpen = (status: string) => !CLOSED.has(status)

/** Which flyout tabs contain ≥1 unread flag (all inputs are already relevant to
 *  `me`; a flag that's neither mine-assigned nor mine-created is participant-only
 *  → the Watching tab). */
export function unreadBuckets(
  unread: FlagResponse[],
  me: number | null
): { assigned: boolean; raised: boolean; watching: boolean; allOpen: boolean } {
  return {
    assigned: unread.some(fl => fl.assignee_id === me && isOpen(fl.status)),
    raised: unread.some(fl => fl.created_by === me),
    watching: unread.some(fl => fl.assignee_id !== me && fl.created_by !== me),
    allOpen: unread.some(fl => isOpen(fl.status)),
  }
}
```

- [ ] **Step 4: Run → pass. Commit.**

---

### Task 4: Frontend — left-bar unread marker (`FlagCard` + `FlagTable`)

**Files:**
- Modify: `src/components/flags/FlagCard.tsx`
- Modify: `src/components/flags/FlagTable.tsx`
- Test: extend `src/components/flags/__tests__/FlagTable.test.tsx`

**Interfaces:** `FlagCard` already accepts `unread?: boolean`; `FlagTable` gains `unreadIds?: Set<number>` and passes `unread` per row.

- [ ] **Step 1: FlagCard — re-purpose the accent bar**

In `FlagCard.tsx`, the left accent `div` currently uses `backgroundColor: def.color`. Change it to the unread marker (the `unread` prop already exists; drop the separate blue dot in favor of the bar):

```tsx
      <div
        className="w-[3px] shrink-0 rounded-full"
        style={{ backgroundColor: unread ? 'var(--flag-unread)' : 'transparent' }}
        aria-hidden
      />
```

Remove the old `{unread && <span … bg-blue-500 …/>}` dot block (the bar now conveys unread).

- [ ] **Step 2: FlagTable — accent column becomes the marker**

In `FlagTable.tsx`, add `unreadIds?: Set<number>` to `FlagTable`'s props and pass `unread={unreadIds?.has(flag.id) ?? false}` to each `FlagTableRow`. Add `unread?: boolean` to `FlagTableRow`'s props. Change the accent span:

```tsx
      <span
        className="h-6 w-full rounded-full"
        style={{ backgroundColor: unread ? 'var(--flag-unread)' : 'transparent' }}
        aria-hidden
      />
```

- [ ] **Step 3: Test the marker**

Extend `FlagTable.test.tsx` with a case: render `<FlagTable flags={[flag]} unreadIds={new Set([flag.id])} />` and assert the row's accent cell has the unread style (query the row; the accent is the first grid cell). Minimal assertion: the component renders without error and the accent element exists. (If the existing test file lacks a flag fixture, reuse its current one; assert `container.querySelector('[style*="--flag-unread"]')` is present when unread, absent otherwise.)

- [ ] **Step 4: Typecheck + flag vitest + commit.**

---

### Task 5: Frontend — Unread tab, tab dots, marker wiring, mark-read

**Files:**
- Modify: `src/components/flags/FlagsFlyout.tsx`
- Modify: `src/components/flags/FlagThread.tsx`

- [ ] **Step 1: Flyout — load unread, wire markers, add the tab**

In `FlagsFlyout.tsx`:

- Imports: `useFlagUnread` from `@/hooks/use-flags`; `unreadBuckets` from `@/components/flags/unread-buckets`; `useAuthStore`.
- `const me = useAuthStore(state => state.user?.id ?? null)`.
- `const { data: unreadFlags } = useFlagUnread()`.
- `const unreadIds = new Set((unreadFlags ?? []).map(f => f.id))`.
- `const buckets = unreadBuckets(unreadFlags ?? [], me)`.
- Extend `FlyoutTab` and `TABS` with `{ value: 'unread', label: 'Unread' }`.
- `const isUnread = tab === 'unread'`.
- When selecting the list source, add an unread branch before the `tabQuery` fallback: if `isUnread`, `flags = unreadFlags`, `isLoading = unreadQuery.isLoading`… (capture `const unreadQuery = useFlagUnread()` once and reuse, OR reuse the `{ data: unreadFlags }` above plus `useFlagUnread()`'s `isLoading/isError/refetch`). Simplest: `const unreadQuery = useFlagUnread()` and derive `unreadFlags = unreadQuery.data`.
- Guard `useFlagsList(isActivity || isUnread ? 'assigned' : (tab as FlagTab))` so the tab query stays valid.
- Filter bar: also hide on `isUnread` (`!isActivity && !isUnread && …`).
- Pass markers to both renderers in the shared list branch:
  - `<FlagTable flags={visibleFlags} highlightIds={highlightIds} unreadIds={unreadIds} />`
  - `<FlagCard … unread={unreadIds.has(flag.id)} />`
- Tab dots: in the `TabsTrigger` map, render a dot/count:

```tsx
{TABS.map(t => {
  const dot =
    t.value === 'assigned' ? buckets.assigned
    : t.value === 'raised' ? buckets.raised
    : t.value === 'watching' ? buckets.watching
    : t.value === 'all_open' ? buckets.allOpen
    : false
  const count = t.value === 'unread' ? (unreadFlags?.length ?? 0) : 0
  return (
    <TabsTrigger key={t.value} value={t.value} className="… (unchanged) …">
      {t.label}
      {t.value === 'unread' && count > 0 && (
        <span className="ml-1 rounded-full px-1.5 text-[10px] font-semibold text-white"
              style={{ backgroundColor: 'var(--flag-unread)' }}>{count}</span>
      )}
      {t.value !== 'unread' && dot && (
        <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full align-middle"
              style={{ backgroundColor: 'var(--flag-unread)' }} aria-hidden />
      )}
    </TabsTrigger>
  )
})}
```

For the Unread tab's list source, set `flags = unreadFlags` when `isUnread` (it flows through the existing `visibleFlags`/FlagCard/FlagTable render; the generic empty state is acceptable for v1).

- [ ] **Step 2: FlagThread — mark read on open (and as it updates while viewed)**

In `FlagThread.tsx`: import `markRead` from `@/lib/flags-api`, `useQueryClient` from `@tanstack/react-query`, `flagKeys` from `@/hooks/use-flags`, and `useEffect` from react. After `flag` is available, add:

```tsx
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!flag) return
    void markRead(flagId)
      .then(() =>
        queryClient.invalidateQueries({ queryKey: flagKeys.unread() })
      )
      .catch(() => {})
    // Re-stamp when the viewed flag changes under us (own comment, etc.).
  }, [flagId, flag?.updated_at, queryClient])
```

(No setState in the effect — it POSTs + invalidates, off the render path.)

- [ ] **Step 3: Typecheck + lint(changed) + flag vitest + build. Fix prettier drift. Commit.**

---

### Task 6: Full-stack verification

- [ ] **Step 1: Build** → `✓ built`.
- [ ] **Step 2: Live smoke** — as an admin token: `GET /api/flags/unread` returns relevant flags; `POST /api/flags/{id}/read` then `GET /unread` no longer includes it; a new comment by another user bumps it back into unread. (TestClient, like the mentions smoke.)
- [ ] **Step 3: Hand off for visual review** — at `http://100.73.137.3:5552`: rows relevant to you show the dedicated-color left bar until opened; tabs show unread dots + the Unread tab shows a count; opening a flag clears its bar (others stay); a mention/comment from the other browser re-lights it. Confirm cross-device by reading on one browser and seeing it clear in the other. Await sign-off.

## Self-Review

- **Spec coverage:** `flag_reads` table (T1), relevance extract + `list_unread` + `mark_read` (T1), routes (T1), API+hook (T2), `--flag-unread` token (T2), bucketing (T3), left-bar marker (T4), Unread tab + tab dots + marker wiring (T5), mark-read on thread open keyed on updated_at (T5), tests backend (T1) + FE (T3/T4), live verify (T6). ISO = read-state is private, not an audit amendment (noted, no code). All mapped.
- **Placeholder scan:** none.
- **Type consistency:** `list_unread`/`mark_read` signatures match the route calls; `getUnread`/`markRead` match `useFlagUnread`/`FlagThread` usage; `unreadBuckets` return shape matches the T5 dot logic; `FlagTable.unreadIds: Set<number>` matches the flyout's `unreadIds`; `FlagCard.unread` reused as-is.
```
