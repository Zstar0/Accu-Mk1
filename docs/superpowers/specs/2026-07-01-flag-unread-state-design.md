# Flag System — per-flag unread state

*Design spec. Created 2026-07-01. Part of the Flag System frontend work on PR #28
(`feat/flag-system-frontend`).*

## Summary

Give each flag a durable, **server-side, cross-device** unread state for the
current user. A flag is unread when it's relevant to you (assignee / creator /
participant) and has changed since you last opened it; it clears when you open its
thread. Three views read from one query: a **dedicated-color left-bar marker** on
each row, **unread dots on the flyout tabs**, and a new **"Unread" tab** listing
everything with unread notifications.

## Motivation

We have transient, per-session notification signals (toast, header bar-pulse, blue
row flash — all localStorage `unseen`). What's missing is a *persistent per-flag*
"you haven't looked at this yet" state that survives across sessions AND devices.
localStorage can't do cross-device (reading on desktop wouldn't clear it on
mobile), so unread lives in the database.

## Decisions (locked with the user)

- **Unread = a relevant change you haven't opened** (assignee/creator/participant
  + `updated_at` newer than your last read). Clears when you open that flag's
  thread. (Not "any activity on anything visible".)
- **Server-side, per user** (`flag_reads` table) — durable + cross-device.
- **Left bar becomes a dedicated unread color**, not the type color (type is
  already shown by the Type pill). One reserved token; read rows show no bar.
- **The blue flash stays** as the transient arrival flourish (localStorage
  `unseen`); the left bar is the durable marker (server `flag_reads`). Clicking one
  flag clears only its bar — the others stay marked.

## Data model

New table **`flag_reads`** (created by `create_all`; new table, no migration DDL
needed):

```
flag_reads(
  id            PK,
  user_id       INTEGER NOT NULL,          # no FK to users (module convention)
  flag_id       INTEGER FK flag_flags(id) ON DELETE CASCADE, NOT NULL,
  last_read_at  DateTime NOT NULL,
  UNIQUE(user_id, flag_id)
)
```

## Backend

### Relevance predicate (DRY)

Extract the assignee/creator/participant subquery already used by
`list_activity` into a shared `service._relevant_flag_ids(user_id)` and reuse it
for unread.

### `service.list_unread(db, *, user_id) -> list[FlagFlag]`

```
reads = select(FlagRead.flag_id, FlagRead.last_read_at).where(FlagRead.user_id == user_id)
# left-join relevant flags to my read rows; unread = never-read OR updated since read
stmt = (select(FlagFlag)
        .where(FlagFlag.id.in_(_relevant_flag_ids(user_id)))
        .outerjoin(FlagRead, and_(FlagRead.flag_id == FlagFlag.id,
                                  FlagRead.user_id == user_id))
        .where(or_(FlagRead.last_read_at.is_(None),
                   FlagFlag.updated_at > FlagRead.last_read_at))
        .order_by(FlagFlag.updated_at.desc()))
```

### `service.mark_read(db, *, user_id, flag_id)`

Portable upsert (get-or-create; works on SQLite + Postgres): fetch the
`(user_id, flag_id)` row → update `last_read_at = now`, else insert. `flag_id`
must exist (`get_flag` first, raising NotFound).

### Routes (literal routes above `/{flag_id}`)

- `GET /api/flags/unread` → `List[FlagResponse]` (entity-resolved via `_with_entity`).
- `POST /api/flags/{id}/read` → `204`; upserts my `last_read_at`.

## Frontend — one query, three views

### API + hooks

- `getUnread() => FlagResponse[]`; `markRead(id) => void` (`lib/flags-api.ts`).
- `useFlagUnread()` (`flagKeys.unread()`, under `['flags', …]` so the glue's
  blanket invalidate refreshes it); `useMarkRead()` mutation (invalidates unread).

### Dedicated unread color

A single CSS token in `App.css`: `:root { --flag-unread: #ec4899; }` — a dedicated
magenta/pink that is NOT in the type palette, status dots, or the flash blue.
Trivially swappable (the user will tune the exact shade on the live review); the
`.dark` theme may override if needed.

### Left-bar marker (`FlagCard` + `FlagTable`)

Both rows take an `unread?: boolean` prop (already a forward-looking prop on
`FlagCard`). The left accent element's color becomes
`unread ? 'var(--flag-unread)' : 'transparent'` (keep the element for gutter
alignment; type color moves off the bar — it's still in the Type pill). The flyout
passes an `unreadIds: Set<number>` down; each row sets `unread={unreadIds.has(id)}`.

### Top-tab unread dots (`FlagsFlyout`)

From the unread flags (all relevant to me), bucket client-side:
- **Assigned** — any with `assignee_id === me` and open status.
- **Raised** — any with `created_by === me`.
- **Watching** — any with `assignee_id !== me && created_by !== me` (relevant but
  not mine → participant-only).
- **All open** — any open.
- **Unread** (new tab) — the count.

Render a small dot on tabs with unread; a count badge on the Unread tab.

### "Unread" tab

Add `'unread'` to `FlyoutTab`. When active, the list renders `useFlagUnread()`'s
flags (reusing `FlagCard`/`FlagTable`, newest-updated first) instead of a
`useFlagsList` tab. Filter bar hidden (like Activity); view toggle applies.

### Mark read

In `FlagThread`, an effect keyed on `[flagId, flag.updated_at]` calls
`useMarkRead().mutate(flagId)` — so opening a flag marks it read, and a flag you're
actively viewing *stays* read as it changes under you (your own comment won't
re-mark it unread). On success → invalidate `flagKeys.unread()`.

### Real-time

The glue already invalidates `['flags']` on every SSE event → the unread query
refetches, so markers/dots/tab counts update live.

## Testing

**Backend (`tests/test_flags_unread.py`):**
- A relevant flag with no read row is unread; after `mark_read` it's not.
- A new event bumping `updated_at` past `last_read_at` makes it unread again.
- A flag NOT relevant to me never appears (even if updated).
- `mark_read` is idempotent (upsert, one row per user+flag).

**Frontend (vitest):**
- `unread-buckets.ts` (pure) — bucketing unread flags → which tabs get a dot;
  Watching = relevant-but-not-mine.
- `FlagTable`/`FlagCard`: an `unread` row renders the marker (var-colored), a read
  row doesn't.

## ISO 17025 alignment

- Read-state is a private per-user UI convenience — it records nothing about the
  sample/result and creates no audit amendment. `flag_reads` is not part of the
  flag's traceable history (that remains `flag_events`). No 17025 surface beyond
  what the flag audit trail already covers.

## Scope guard (out for v1 — deferrable)

- No manual "mark unread" / "mark all read" controls.
- No unread on flags you're not involved in.
- No read receipts exposed to other users.
- No email/push digest of unread.
- Unread ordering is by `updated_at` only (no priority weighting).

## Files

**Backend:** `flags/models.py` (`FlagRead`), `flags/service.py`
(`_relevant_flag_ids` extract, `list_unread`, `mark_read`), `flags/routes.py`
(`GET /unread`, `POST /{id}/read`), `tests/test_flags_unread.py`.
**Frontend:** `lib/flags-api.ts`, `hooks/use-flags.ts` (`useFlagUnread`,
`useMarkRead`, `flagKeys.unread`), `App.css` (`--flag-unread`),
`components/flags/FlagCard.tsx` + `FlagTable.tsx` (unread bar),
`components/flags/FlagsFlyout.tsx` (Unread tab + tab dots + pass `unreadIds`),
`components/flags/FlagThread.tsx` (mark-read effect),
`components/flags/unread-buckets.ts` (+ test).
