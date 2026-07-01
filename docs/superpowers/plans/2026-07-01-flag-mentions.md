# Flag @mentions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a commenter `@`-mention a lab user who then gets a live notification even if unassigned (and is added as a watcher so the flag surfaces in their Watching tab + Activity feed). Watchers do NOT get live toasts — only explicit mentions.

**Architecture:** Backend stores mention ids on the comment, adds mentioned users as watchers, and tags the `commented` event with `details.mentions`. The frontend glue widens relevance to assignee/creator/mentioned (from the payload), the composer gets an `@`-autocomplete picker, and mentions render as chips.

**Tech Stack:** FastAPI + SQLAlchemy, React 19 + TanStack Query v5 + shadcn, pytest + vitest.

## Global Constraints

- **Additive only** — no existing behavior removed. **npm only.** Zustand selector syntax (ast-grep). Colors from `useFlagTypesMap`.
- Backend `flag_` prefix; watchers reuse `flag_participants`.
- Verify in the live stack (`accumark-flagsfe`). Gate on typecheck + lint(changed) + flag vitest + flag pytest + build — NOT the red aggregate.
- Editing a function → the repo's GitNexus rule asks for impact analysis; these are additive edits to `add_comment`, `_flag_summary`, and the glue — note blast radius (comment path + notification relevance) in commits.

---

### Task 1: Backend — mentions storage, watcher-add, event tagging (TDD)

**Files:**
- Modify: `backend/flags/models.py` (`FlagComment.mentions`)
- Modify: `backend/flags/service.py` (`_valid_user_ids`, `add_comment` mentions)
- Modify: `backend/flags/schemas.py` (`CommentRequest.mention_ids`, `CommentResponse.mentions`)
- Modify: `backend/flags/routes.py` (pass `mention_ids`)
- Modify: `backend/database.py` (idempotent `mentions` column)
- Test: `backend/tests/test_flags_mentions.py`

**Interfaces:**
- Produces: `add_comment(db, *, user, flag_id, body, mention_ids=None)` — stores valid ids on the comment, adds each as a `watcher` participant (dedup), tags the `commented` event `details={"mentions": [...]}`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_flags_mentions.py`:

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
    # Two real users so mention validation has something to match.
    from models import User
    for uid, em in [(1, "a@x.t"), (2, "b@x.t"), (3, "c@x.t")]:
        s.add(User(id=uid, email=em, hashed_password="x", is_active=True))
    s.commit()
    try:
        yield s
    finally:
        s.close()


def _user(id):
    return SimpleNamespace(id=id, role="standard", email=f"u{id}@x.t")


def _flag(db, actor=1):
    from flags import service
    return service.create_flag(db, user=_user(actor), entity_type="sub_sample",
                               entity_id="1", type="blocker", title="t")


def test_mention_stores_ids_adds_watcher_and_tags_event(db):
    from flags import service, seams
    from flags.models import FlagParticipant
    f = _flag(db, actor=1)
    sink = seams.EVENT_SINK
    before = len(sink.events)
    c = service.add_comment(db, user=_user(1), flag_id=f.id, body="hey @b", mention_ids=[2])
    assert c.mentions == [2]
    # user 2 is now a watcher participant
    parts = db.execute(select(FlagParticipant.user_id).where(
        FlagParticipant.flag_id == f.id)).scalars().all()
    assert 2 in parts
    # the commented event carries details.mentions
    ev = [e for e in sink.events[before:] if e["event_type"] == "commented"][-1]
    assert ev["details"]["mentions"] == [2]


def test_mention_drops_unknown_ids_and_dedups(db):
    from flags import service
    f = _flag(db, actor=1)
    c = service.add_comment(db, user=_user(1), flag_id=f.id, body="x",
                            mention_ids=[2, 2, 999])
    assert c.mentions == [2]           # 999 unknown dropped, 2 deduped
```

- [ ] **Step 2: Run to verify failure**

Push (commit as `test(flags): mention tests (RED)`), sync devbox, run:
`docker compose -p accumark-flagsfe exec -T accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_flags_mentions.py -q"`
Expected: FAIL (`add_comment` has no `mention_ids`; `mentions` attr missing).

- [ ] **Step 3: Add the model column**

In `backend/flags/models.py`, add to `FlagComment` (after `audience`):

```python
    mentions: Mapped[Optional[list]] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"), nullable=True)
```

(`JSONB`, `JSON`, `Optional` are already imported in this module.)

- [ ] **Step 4: Add `_valid_user_ids` + `add_comment` mentions in `service.py`**

Add a helper (near the other module helpers):

```python
def _valid_user_ids(db: Session, ids) -> list[int]:
    """Existing user ids only, order-preserving + deduped."""
    from models import User
    if not ids:
        return []
    uniq = list(dict.fromkeys(int(i) for i in ids))
    present = set(db.execute(select(User.id).where(User.id.in_(uniq))).scalars().all())
    return [i for i in uniq if i in present]
```

Change `add_comment` to accept + apply mentions:

```python
def add_comment(db: Session, *, user, flag_id, body, mention_ids=None) -> FlagComment:
    flag = get_flag(db, flag_id)
    if not permissions.can(user, "comment", flag):
        raise PermissionDeniedError("not allowed to comment")
    if not body or not body.strip():
        raise BadRequestError("comment body required")
    actor_id = getattr(user, "id", None)
    valid = _valid_user_ids(db, mention_ids or [])
    c = FlagComment(flag_id=flag.id, author_id=actor_id, body=body.strip(),
                    mentions=valid or None)
    db.add(c)
    for uid in valid:
        exists = db.execute(select(FlagParticipant).where(
            FlagParticipant.flag_id == flag.id,
            FlagParticipant.user_id == uid)).scalar_one_or_none()
        if exists is None:
            db.add(FlagParticipant(flag_id=flag.id, user_id=uid,
                                   role="watcher", added_by=actor_id))
    flag.updated_at = datetime.utcnow()
    _audit(db, flag, actor_id, "commented",
           details={"mentions": valid} if valid else None)
    _commit_and_emit(db)
    db.refresh(c)
    return c
```

- [ ] **Step 5: Schemas — request + response**

In `backend/flags/schemas.py`: add `field_validator` to the pydantic import. Change `CommentRequest`:

```python
class CommentRequest(BaseModel):
    body: str
    mention_ids: List[int] = Field(default_factory=list)
```

Add `mentions` to `CommentResponse` (with a None→[] coercion for legacy rows):

```python
    mentions: List[int] = Field(default_factory=list)

    @field_validator("mentions", mode="before")
    @classmethod
    def _none_to_list(cls, v):
        return v or []
```

(Place the field above `model_config`; the validator anywhere in the class body.)

- [ ] **Step 6: Route pass-through**

In `backend/flags/routes.py`, `add_comment` handler:

```python
        return CommentResponse.model_validate(
            service.add_comment(db, user=user, flag_id=flag_id, body=req.body,
                                mention_ids=req.mention_ids))
```

- [ ] **Step 7: Idempotent column migration**

In `backend/database.py` `_run_migrations()` list, append near the other flag statements:

```python
        "ALTER TABLE flag_comments ADD COLUMN IF NOT EXISTS mentions JSON",
```

- [ ] **Step 8: Run tests green**

Push (`feat(flags): comment mentions + watcher-add`), sync, run:
`docker compose -p accumark-flagsfe exec -T accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_flags_mentions.py tests/test_flags_routes.py -q"`
Expected: PASS.

---

### Task 2: Frontend — API + hook

**Files:**
- Modify: `src/lib/flags-api.ts` (`CommentResponse.mentions`, `addComment` mentionIds)
- Modify: `src/hooks/use-flags.ts` (`useAddComment` passes mentionIds)

**Interfaces:**
- Produces: `addComment(id, body, mentionIds?: number[])`; `CommentResponse.mentions: number[]`.

- [ ] **Step 1: API client**

In `src/lib/flags-api.ts`: add `mentions: number[]` to `CommentResponse`. Change `addComment`:

```typescript
export const addComment = (id: number, body: string, mentionIds: number[] = []) =>
  apiFetch<CommentResponse>(`/api/flags/${id}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body, mention_ids: mentionIds }),
  })
```

- [ ] **Step 2: Hook**

In `src/hooks/use-flags.ts`, change `useAddComment`:

```typescript
export function useAddComment(flagId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ body, mentionIds }: { body: string; mentionIds?: number[] }) =>
      addComment(flagId, body, mentionIds),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: flagKeys.detail(flagId) }),
  })
}
```

- [ ] **Step 3: Typecheck** — `npm run typecheck` (will surface the `FlagThread` call site, fixed in Task 5; if so, defer the run to after Task 5). Commit.

---

### Task 3: Frontend — relevance (mention) as a pure, tested unit

**Files:**
- Create: `src/components/flags/flag-relevance.ts`
- Test: `src/components/flags/__tests__/flag-relevance.test.ts`
- Modify: `src/components/flags/use-flag-stream-glue.ts`

**Interfaces:**
- Produces: `evaluateRelevance(input, me) => { relevant: boolean; mentioned: boolean }`.

- [ ] **Step 1: Failing test**

Create `src/components/flags/__tests__/flag-relevance.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { evaluateRelevance } from '@/components/flags/flag-relevance'

const base = { actorId: 9, assigneeId: null, createdBy: 9, mentions: [] }

describe('evaluateRelevance', () => {
  it('relevant to the assignee', () => {
    expect(evaluateRelevance({ ...base, assigneeId: 5 }, 5).relevant).toBe(true)
  })
  it('relevant to the creator', () => {
    expect(evaluateRelevance({ ...base, createdBy: 5 }, 5).relevant).toBe(true)
  })
  it('relevant + mentioned when mentioned', () => {
    const r = evaluateRelevance({ ...base, mentions: [5] }, 5)
    expect(r.relevant).toBe(true)
    expect(r.mentioned).toBe(true)
  })
  it('never notifies the actor about their own action', () => {
    expect(evaluateRelevance({ ...base, actorId: 5, mentions: [5] }, 5).relevant).toBe(false)
  })
  it('not relevant to an unrelated user', () => {
    expect(evaluateRelevance(base, 5).relevant).toBe(false)
  })
})
```

- [ ] **Step 2: Run → fail. Step 3: Implement**

Create `src/components/flags/flag-relevance.ts`:

```typescript
/** Is a flag event relevant to `me` (should it notify), and was I mentioned?
 *  Pure — decided entirely from the SSE payload (assignee/creator/mention).
 *  Watching does NOT notify live. The actor is never notified about their own
 *  action. */
export interface RelevanceInput {
  actorId: number | null
  assigneeId: number | null
  createdBy: number
  mentions: number[]
}

export function evaluateRelevance(
  input: RelevanceInput,
  me: number | null
): { relevant: boolean; mentioned: boolean } {
  if (me == null || input.actorId === me) {
    return { relevant: false, mentioned: false }
  }
  const mentioned = input.mentions.includes(me)
  const relevant =
    input.assigneeId === me || input.createdBy === me || mentioned
  return { relevant, mentioned }
}
```

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Wire into the glue**

In `src/components/flags/use-flag-stream-glue.ts`: import `evaluateRelevance`. Replace the inline relevance block:

```typescript
    const me = useAuthStore.getState().user?.id ?? null
    const ui = useUIStore.getState()
    const showingThisThread =
      ui.flagsFlyoutOpen && ui.flagsThreadId === e.flag_id
    const mentions = Array.isArray(e.details?.mentions)
      ? (e.details.mentions as number[])
      : []
    const { relevant, mentioned } = evaluateRelevance(
      {
        actorId: e.actor_id,
        assigneeId: e.flag.assignee_id,
        createdBy: e.flag.created_by,
        mentions,
      },
      me
    )
    const supersededByAssign =
      e.event_type === 'raised' &&
      e.flag.assignee_id != null &&
      e.flag.assignee_id !== e.actor_id

    if (relevant && !showingThisThread && !supersededByAssign) {
      const def = resolveTypeDef(queryClient, e.flag.type)
      const tab: FlagTab = e.flag.assignee_id === me ? 'assigned' : 'raised'
      useFlagUnseen.getState().markUnseen(e.flag_id, tab)
      notifyForEvent(e, me, def, mentioned)
    }
```

Change `notifyForEvent` to take a `mentioned` flag and prefer the mention title:

```typescript
function notifyForEvent(
  e: FlagStreamEvent,
  me: number | null,
  def: FlagTypeDef,
  mentioned: boolean
) {
  const title = mentioned ? 'You were mentioned' : toastTitle(e, me)
  ...
```

- [ ] **Step 6: Typecheck + flag vitest. Commit.**

---

### Task 4: Frontend — pure mention parse + comment-body render (TDD)

**Files:**
- Create: `src/components/flags/mention-parse.ts`
- Test: `src/components/flags/__tests__/mention-parse.test.ts`

**Interfaces:**
- Produces:
  - `activeMentionQuery(value: string, caret: number): { query: string; start: number } | null`
  - `mentionIdsInBody(body: string, selected: Map<number, string>): number[]`
  - `renderCommentSegments(body: string, mentions: number[], nameOf: (id: number) => string): Array<{ text: string; mentionId: number | null }>`

- [ ] **Step 1: Failing test**

Create `src/components/flags/__tests__/mention-parse.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import {
  activeMentionQuery,
  mentionIdsInBody,
  renderCommentSegments,
} from '@/components/flags/mention-parse'

describe('activeMentionQuery', () => {
  it('opens a token at the caret after @', () => {
    expect(activeMentionQuery('hi @al', 6)).toEqual({ query: 'al', start: 3 })
  })
  it('is null with no @ before the caret', () => {
    expect(activeMentionQuery('hello', 5)).toBeNull()
  })
  it('closes on whitespace', () => {
    expect(activeMentionQuery('hi @al bob', 10)).toBeNull()
  })
})

describe('mentionIdsInBody', () => {
  const sel = new Map([
    [2, 'Alice Ng'],
    [3, 'Bob Ray'],
  ])
  it('keeps ids whose @name is still present', () => {
    expect(mentionIdsInBody('hey @Alice Ng!', sel)).toEqual([2])
  })
  it('drops ids whose text was removed', () => {
    expect(mentionIdsInBody('nobody here', sel)).toEqual([])
  })
})

describe('renderCommentSegments', () => {
  it('splits a body into text + mention segments', () => {
    const segs = renderCommentSegments('hey @Alice Ng ok', [2], id =>
      id === 2 ? 'Alice Ng' : `User ${id}`
    )
    expect(segs).toEqual([
      { text: 'hey ', mentionId: null },
      { text: '@Alice Ng', mentionId: 2 },
      { text: ' ok', mentionId: null },
    ])
  })
})
```

- [ ] **Step 2: Run → fail. Step 3: Implement**

Create `src/components/flags/mention-parse.ts`:

```typescript
/** Compose + render helpers for @mentions. All pure. */

/** The open `@token` immediately before the caret, or null. A token runs from an
 *  `@` (at string start or after whitespace) up to the caret, and closes on any
 *  whitespace. */
export function activeMentionQuery(
  value: string,
  caret: number
): { query: string; start: number } | null {
  const upto = value.slice(0, caret)
  const at = upto.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && !/\s/.test(upto[at - 1] ?? '')) return null
  const query = upto.slice(at + 1)
  if (/\s/.test(query)) return null
  return { query, start: at }
}

/** Ids from `selected` whose `@name` text is still present in the body. */
export function mentionIdsInBody(
  body: string,
  selected: Map<number, string>
): number[] {
  const out: number[] = []
  for (const [id, name] of selected) {
    if (body.includes(`@${name}`)) out.push(id)
  }
  return out
}

/** Split a body into plain-text + mention segments for rendering. Longest names
 *  first so overlapping names match greedily. */
export function renderCommentSegments(
  body: string,
  mentions: number[],
  nameOf: (id: number) => string
): Array<{ text: string; mentionId: number | null }> {
  const tokens = mentions
    .map(id => ({ id, tok: `@${nameOf(id)}` }))
    .sort((a, b) => b.tok.length - a.tok.length)
  const segs: Array<{ text: string; mentionId: number | null }> = []
  let i = 0
  while (i < body.length) {
    const hit = tokens.find(t => body.startsWith(t.tok, i))
    if (hit) {
      segs.push({ text: hit.tok, mentionId: hit.id })
      i += hit.tok.length
    } else {
      const last = segs[segs.length - 1]
      if (last && last.mentionId === null) last.text += body[i]
      else segs.push({ text: body[i] ?? '', mentionId: null })
      i += 1
    }
  }
  return segs
}
```

- [ ] **Step 4: Run → pass. Commit.**

---

### Task 5: Frontend — composer `@`-picker + comment-body chips (`FlagThread.tsx`)

**Files:**
- Modify: `src/components/flags/FlagThread.tsx`

**Interfaces:** consumes Task 2 (`useAddComment` object arg), Task 4 (mention-parse), `useFlagUsers`/`getWorksheetUsers`, `displayName`.

- [ ] **Step 1: Composer state + picker**

Add imports: `activeMentionQuery, mentionIdsInBody, renderCommentSegments` from `mention-parse`; `displayName` from `@/lib/user-display`; the users list. Replace the composer's local state + submit with mention-aware versions (near the existing `draft`/`submit`):

```tsx
  const usersList = useFlagUsers() // Map<id, user>
  const [selected, setSelected] = useState<Map<number, string>>(new Map())
  const [menu, setMenu] = useState<{ query: string; start: number } | null>(null)
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const candidates = menu
    ? [...usersList.values()]
        .filter(u => {
          const n = displayName(u).toLowerCase()
          const q = menu.query.toLowerCase()
          return n.includes(q) || u.email.toLowerCase().includes(q)
        })
        .slice(0, 6)
    : []

  const onDraftChange = (value: string, caret: number) => {
    setDraft(value)
    const m = activeMentionQuery(value, caret)
    setMenu(m)
    setActiveIdx(0)
  }

  const pick = (u: { id: number; email: string }) => {
    if (!menu) return
    const name = displayName(u)
    const before = draft.slice(0, menu.start)
    const after = draft.slice(menu.start + 1 + menu.query.length)
    const next = `${before}@${name} ${after}`
    setDraft(next)
    setSelected(prev => new Map(prev).set(u.id, name))
    setMenu(null)
    queueMicrotask(() => inputRef.current?.focus())
  }

  const submit = () => {
    const body = draft.trim()
    if (!body || addComment.isPending) return
    addComment.mutate({ body, mentionIds: mentionIdsInBody(body, selected) })
    setDraft('')
    setSelected(new Map())
    setMenu(null)
  }
```

Rewire the `Input` (wrap the composer in a `relative` container for the dropdown):

```tsx
      <div className="relative flex items-center gap-2.5 border-t bg-background px-3 py-2.5">
        <FlagAvatar … />
        {menu && candidates.length > 0 && (
          <div className="absolute bottom-full left-12 z-20 mb-1 w-64 overflow-hidden rounded-md border bg-popover shadow-md">
            {candidates.map((u, i) => (
              <button
                key={u.id}
                type="button"
                onMouseDown={e => {
                  e.preventDefault()
                  pick(u)
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px]',
                  i === activeIdx ? 'bg-accent' : 'hover:bg-accent/60'
                )}
              >
                <FlagAvatar
                  initials={initialsForUser(users, u.id, currentUserId)}
                  color={avatarColor(u.id)}
                  size={18}
                />
                <span className="truncate">{displayName(u)}</span>
              </button>
            ))}
          </div>
        )}
        <Input
          ref={inputRef}
          value={draft}
          onChange={e => onDraftChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={e => {
            if (menu && candidates.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActiveIdx(i => Math.min(i + 1, candidates.length - 1))
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActiveIdx(i => Math.max(i - 1, 0))
                return
              }
              if (e.key === 'Enter') {
                e.preventDefault()
                pick(candidates[activeIdx]!)
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setMenu(null)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="Write a comment… use @ to mention"
          className="h-10 flex-1"
        />
        <Button … onClick={submit} … />
      </div>
```

(`useState`, `useRef` — ensure imported from `react`.)

- [ ] **Step 2: Render mention chips in `CommentRow`**

`CommentRow` needs the user directory to resolve names. Pass `users` (the `UserMap`) as a prop from the parent (it already computes `users`), then render segments:

```tsx
        <div className="text-[13px] leading-relaxed text-foreground/90">
          {renderCommentSegments(
            comment.body,
            comment.mentions ?? [],
            id => nameForUser(users, id)
          ).map((seg, i) =>
            seg.mentionId != null ? (
              <span
                key={i}
                className="rounded bg-primary/15 px-1 font-medium text-primary"
              >
                {seg.text}
              </span>
            ) : (
              <span key={i}>{seg.text}</span>
            )
          )}
        </div>
```

Add `users: UserMap` to `CommentRow`'s props and pass it at the call site; import `renderCommentSegments` and `type UserMap`.

- [ ] **Step 3: Typecheck + lint(changed) + flag vitest**

Run typecheck, `npx eslint` on the changed files, `npx vitest run src/components/flags`. Expected: clean + green. Fix any prettier drift (`npx prettier --write` the changed files).

- [ ] **Step 4: Commit.**

---

### Task 6: Full-stack verification

- [ ] **Step 1: Build** — `npm run build` → `✓ built`.
- [ ] **Step 2: Live smoke** — mint two users' tokens (or use the seeded admin), `POST /api/flags/{id}/comments` with `mention_ids`, then `GET /api/flags/{id}` → the comment carries `mentions`; a second user is now a participant (`?tab=watching`). Confirm the `commented` event (via a brief SSE read or DB `flag_participants`) added the watcher. Restart backend so the `mentions` column migration runs; confirm healthy.
- [ ] **Step 3: Hand off for visual review** — at `http://100.73.137.3:5552`: typing `@` in a comment shows the picker; posting notifies the mentioned user in the other browser (toast "You were mentioned" + bar pulse) even though unassigned; the mention renders as a chip; the mentioned user now sees the flag under Watching. Await sign-off.

## Self-Review

- **Spec coverage:** mentions column + storage (T1), watcher-add (T1), event `details.mentions` (T1), relevance widening (mention only) + mention title (T3), `@`-picker compose (T5), chip render (T4 helper + T5), tests backend (T1) + FE (T3/T4), live verify (T6). ISO = attribution recorded on comment + event (T1). Watchers get no live toasts (no payload/relevance change for watching) — matches the locked decision. All mapped.
- **Placeholder scan:** none.
- **Type consistency:** `add_comment(..., mention_ids)` matches route call; `useAddComment` object arg `{ body, mentionIds }` matches the T5 call site; `evaluateRelevance` signature (no `watchers`) identical across T3 def/use; `renderCommentSegments`/`mentionIdsInBody`/`activeMentionQuery` identical across T4 def and T5 use.
```
