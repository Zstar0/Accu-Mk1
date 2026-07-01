# Flag System — "Activity" tab (relevance feed)

*Design spec. Created 2026-07-01. Part of the Flag System frontend work on PR #28
(`feat/flag-system-frontend`).*

## Summary

Add a fifth tab, **Activity**, to the Flags flyout: a paginated, newest-first feed
of flag events relevant to the current user — activity on any flag they're the
assignee, creator, or a watcher of, **plus their own actions**. Infinite-scroll
(cursor/keyset paging) with a "Load more" fallback. One new read-only backend
endpoint; the rest is frontend. Additive only — no existing behavior changes.

## Motivation

The four existing tabs (Assigned to me / Raised by me / Watching / All open) each
show a snapshot list of *flags*. None answer "what's happened recently?" — the
question you ask after time away. The `flag_events` append-only audit log already
records every state-changing action; this feature surfaces it as a per-user feed.

## Scope decision (locked)

**"Your recent activity" = everything relevant to you**: events on flags where you
are assignee OR creator OR watcher, unioned with events where you are the actor
(your own actions are included — the feed doubles as a personal audit trail).
Newest first. (Chosen over "others' actions only" and "my own actions only".)

## Data model (existing — no schema change beyond an index)

`flag_events` (`backend/flags/models.py:FlagEvent`) is the source:
`id, flag_id, actor_id, event_type, from_value, to_value, details (JSONB), created_at`.
Relevance joins to `flag_flags` (`assignee_id`, `created_by`) and
`flag_participants` (watchers). These are the **same predicates `service.list_flags`
uses** — the activity query reuses them, unioned with `actor_id == me`.

**New index (additive, idempotent):** via Mk1's startup DDL —
`CREATE INDEX IF NOT EXISTS ix_flag_events_created_at_id ON flag_events (created_at DESC, id DESC)`
so the keyset scan stays fast as the log grows.

## Backend

### Endpoint

`GET /api/flags/activity?cursor=<opaque>&limit=25`

- Registered as a **literal route above `/{flag_id}`** (like `/summary`, `/types`)
  so it wins the path match.
- `limit`: default 25, capped at 50.
- Auth: `get_current_user` (any authenticated user; feed is self-scoped).

### Query (`service.list_activity`)

```
relevant_flags = select(FlagFlag.id).where(or_(
    FlagFlag.assignee_id == user_id,
    FlagFlag.created_by == user_id,
    FlagFlag.id.in_(select(FlagParticipant.flag_id)
                    .where(FlagParticipant.user_id == user_id)),
))
stmt = (select(FlagEvent)
        .where(or_(FlagEvent.actor_id == user_id,
                   FlagEvent.flag_id.in_(relevant_flags)))
        .order_by(FlagEvent.created_at.desc(), FlagEvent.id.desc()))
# keyset: when cursor present, add
#   or_(FlagEvent.created_at < c_ts,
#       and_(FlagEvent.created_at == c_ts, FlagEvent.id < c_id))
stmt = stmt.limit(limit + 1)   # +1 sentinel row → is there a next page?
```

The `flag` for each event is loaded and serialized via the existing
`_with_entity(db, flag)` so every item carries the resolved `EntityContext`
(label, sample_id, deep_link) and the flag's type/status/title. Events on the
same flag within a page reuse the resolve (acceptable at ≤50 rows/page).

### Cursor

Opaque: `base64url("{created_at.isoformat()}|{id}")` of the last returned row.
`next_cursor` is `null` when the `limit+1` sentinel row was absent (last page).
A malformed/undecodable cursor → 400.

### Response schemas (`schemas.py`)

```
class ActivityItem(BaseModel):
    id: int                    # event id
    event_type: str
    actor_id: int | None
    from_value: str | None
    to_value: str | None
    created_at: datetime
    flag: FlagResponse         # embedded, with resolved entity

class ActivityPage(BaseModel):
    items: list[ActivityItem]
    next_cursor: str | None
```

## Frontend

### API client (`lib/flags-api.ts`)

- `ActivityItem`, `ActivityPage` interfaces mirroring the schemas.
- `getActivity(cursor?: string, limit = 25) => apiFetch<ActivityPage>(...)`.

### Tab wiring (`FlagsFlyout.tsx`)

- Local tab type widens: `type FlyoutTab = FlagTab | 'activity'`. Only the four
  real `FlagTab` values reach `useFlagsList`; `'activity'` routes to
  `<FlagActivityFeed />`.
- Add `{ value: 'activity', label: 'Activity' }` to the tab list.
- The filter bar and the list/table view toggle are **hidden** on the Activity
  tab (they filter flags, not events).

### Data hook (`hooks/use-flags.ts`)

- `useFlagActivity()` = TanStack `useInfiniteQuery`:
  - `queryKey: flagKeys.activity()` (new key under `flagKeys.all`).
  - `queryFn: ({ pageParam }) => getActivity(pageParam)`.
  - `getNextPageParam: (last) => last.next_cursor ?? undefined`.
  - `initialPageParam: undefined`.

### Components

- **`FlagActivityFeed.tsx`** — flattens `data.pages[].items`, renders rows, and
  places an `IntersectionObserver` sentinel below the last row that calls
  `fetchNextPage()` when it enters view (guarded by `hasNextPage &&
  !isFetchingNextPage`). A manual **"Load more"** button renders as the fallback
  (also shown when the observer is unsupported / for keyboard users). Skeleton
  (initial load), empty state ("No activity yet"), and error+retry — mirroring
  the other tabs.
- **`FlagActivityRow.tsx`** — one line, click opens the thread
  (`openFlagThread(item.flag.id)`):
  `{ActorAvatar}  **{Actor}** {verb}  **{flag.title}**  · {entity} · {relativeTime}`
  - Actor: `actor_id === me → "You"`, else `nameForUser`; `null → "System"`.
  - Reuses `avatarColor`, `initialsForUser`, `relativeTime`, `entityDisplayLabel`,
    `useFlagTypesMap` (type dot color), `STATUS_LABELS` (for status verbs).

### Verb helper (`flag-activity.ts`, pure — unit tested)

`activityVerb(item, me, resolveName, resolveStatus)` → phrase:

| event_type | phrase |
|---|---|
| `raised` | raised this flag |
| `assigned` | `to_value == me` → "assigned this to you"; else "assigned this to {name}" |
| `unassigned` | unassigned this |
| `commented` | commented |
| `status_changed` | moved this to {status label of `to_value`} |
| `watcher_added` | started watching *(self)* / added {name} as a watcher |
| `watcher_removed` | stopped watching *(self)* / removed a watcher |
| *(fallback)* | updated this |

## Real-time (v1 — lean)

The feed loads fresh when the Activity tab is opened and infinite-scrolls for
history. Live events continue to surface through the toast + persisted bar pulse
already shipped. **Deferred:** auto-prepending new events into an open feed (a
"N new — refresh" affordance) — avoids scroll-jank complexity now.

## Testing

**Backend (pytest, `tests/test_flags_activity.py`):**
- Relevance: I see events on my assigned/created/watched flags + my own actions;
  I do NOT see events on unrelated flags.
- Ordering: strictly newest-first by `(created_at, id)`.
- Keyset pagination: two pages across a boundary have no duplicate and no skipped
  event; `next_cursor` is null exactly on the last page.
- `limit` respected and capped at 50; malformed cursor → 400.

**Frontend (vitest):**
- `flag-activity.test.ts` — the pure `activityVerb` mapping (each event type, self
  vs other, status label resolution).
- `FlagActivityFeed.test.tsx` — renders rows from mocked pages; the sentinel
  entering view triggers `fetchNextPage`; empty and error states.

## ISO 17025 alignment

The feed is a read-only presentation of the existing `flag_events` audit trail —
it adds a *surface*, not a new record of truth.
- **Attribution (7.5.1):** every row shows who did what and when (actor + verb +
  timestamp), making personnel attribution of flag actions directly visible.
- **Traceable amendments (7.5.2 / 8.4):** status changes and reassignments appear
  in chronological order, so the history of a flag's handling is legible.
- No amendment path is added here; the feed cannot mutate events (read-only GET).

## Scope guard (explicitly out for v1 — all deferrable)

- No event-type filtering on the feed.
- No day/"Today · Yesterday" grouping (time is on each row).
- No live-prepend / seen-tracking on the feed.
- No cross-user "team activity" view (self-scoped only).

## Files

**Backend:** `flags/routes.py` (+`/activity`), `flags/service.py`
(+`list_activity`), `flags/schemas.py` (+`ActivityItem`, `ActivityPage`), startup
DDL (+index), `tests/test_flags_activity.py`.
**Frontend:** `lib/flags-api.ts`, `hooks/use-flags.ts` (+`useFlagActivity`,
`flagKeys.activity`), `components/flags/FlagsFlyout.tsx`,
`components/flags/FlagActivityFeed.tsx`, `components/flags/FlagActivityRow.tsx`,
`components/flags/flag-activity.ts`, `__tests__/flag-activity.test.ts`,
`__tests__/FlagActivityFeed.test.tsx`.
