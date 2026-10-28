# Tasks page (full-page flags list) design

Date: 2026-10-27
Status: approved in conversation with the Handler; this document is the build contract.
Base: origin/master `ac316df2` (v1.53.0). Branch `feat/tasks-page`.

## Why

Flags are turning into the team's task system (general tasks, item kinds, due dates, watchers all shipped in
Flag Phase 2). The only way to work a task list today is the flags flyout: an 880px slide-over with a
fixed-width table where only Due sorts and nothing resizes. The Handler wants a standalone **Tasks** page that is
a full-page version of the flyout, so a person can open it in the morning and see the new and important tasks
assigned to them that they need to start.

Recommendations for this direction already live on Mk1 Task #4056 ("Improve flags for general task management
and organization", created by Jarvis 2026-10-05). This page is the first step.

This is part one of three, in this order:

1. **Tasks page** (this document).
2. **Flags API for other systems** (Paperclip, Valence HQ). Designed next, separately.
3. **AI summary card** on the Tasks page (nightly when tasks changed, plus a Regenerate button). Designed last.

## Goals

- A new top-level **Tasks** page at `#tasks`, for every logged-in Mk1 user.
- It opens on **Assigned to me**, or on the tab the user last used.
- It reuses the flyout's six tabs, filter bar, comment search and unread markers.
- Its table has **sortable columns** (click a header) and **resizable columns** (drag a header edge).
- **Sort, column widths and last tab are saved to the user's account** (server side), so they follow the user to
  any computer and browser.
- Clicking a task opens the **existing flags flyout** on that task's thread (the slide-over the Handler picked in
  the mockup, option B). Back and close return straight to the Tasks page.
- `#tasks/overview?flag=<id>` opens the page with that task's thread open.
- Slack DM links for flags with no entity page (general tasks) land on the Tasks page instead of the orders
  dashboard.

## Non-goals

- No change to the flyout's own list, table, tabs or behavior when it is opened from the header button or an
  entity page.
- No change to the flyout's filters (`flags:filter:<tab>` in localStorage). The page's filters are separate and also
  stay in the browser, not the account.
- No column reorder, column show/hide, server-side sorting or pagination.
- No sidebar badge count on the Tasks item.
- No new flag-data backend routes. The page reads flags only through the existing `/api/flags` routes.
- The flags API work and the AI summary are separate documents.

## Anti-goals (would make this a failure even if it works)

- Anything that changes what people see in the flyout if they never open the Tasks page.
- A page-only backend route for flag data. Everything the page does with flags must go through routes that other
  systems will also be able to use once the flags API work lands. The one deliberate exception is the per-user
  UI settings route below, which is UI state, not flag data.
- Settings that silently fail to save, or that reset to defaults without the user doing anything.
- Breaking Order Explorer, COA Explorer, Documents or the order detail panel, which already use
  `src/components/ui/data-table.tsx`.

## What exists today (facts the design relies on)

- `src/components/flags/FlagsFlyout.tsx`: tabs `assigned`, `raised`, `watching`, `all_open` (API tabs) plus
  `unread` and `activity` (front-end only). Uses `useFlagsList`, `useFlagUnread`, `useFlagSearch`,
  `useFlagFilter`, `filterFlags`, `mergeSearchHits`, `FlagsFilterBar`, `RaiseFlagButton`, `FlagActivityFeed`.
- `src/components/flags/FlagTable.tsx`: CSS-grid table. Columns: unread accent, Item, Type, Title, Assignee,
  Status, Due, Created. Only Due sorts (local toggle). Row click calls
  `useUIStore.getState().openFlagThread(flag.id)`.
- `openFlagThread(id)` in `src/store/ui-store.ts` sets `flagsFlyoutOpen: true, flagsThreadId: id`, so a row click
  already opens the global flyout on the thread. `FlagThread`'s back arrow (labelled with the flyout tab) and its
  error-state "Back to flags" button call `closeFlagThread()`, which clears the thread and leaves the flyout open
  on its own list.
- `src/lib/hash-navigation.ts` parses `?flag=<id>` and calls `openFlagThread`, but **only for hashes of the form
  `#section/subsection?flag=`**: `parseNavHash` returns `null` when the path has no slash
  (`hash-navigation.ts:67-68`), so a bare `#tasks` or `#tasks?flag=1` is ignored. Sections must be listed in
  `VALID_SECTIONS`. Top-level sidebar items navigate to the `overview` subsection (`AppSidebar.tsx:319`), so the
  page's real address is `#tasks/overview`.
- `useFlagFilter` (`src/components/flags/use-flag-filter.ts`) holds each tab's filter in component state after
  the first read and writes through to localStorage. The flyout is mounted permanently, so it never re-reads a
  value another component wrote, and its next write for that tab overwrites the other value.
- `GET /api/flags?tab=` (`backend/flags/routes.py`, `service.list_flags`) returns every visible flag for the tab,
  ordered by `updated_at DESC`, with **no limit**. Client-side sorting therefore sorts the complete set.
- `src/components/ui/data-table.tsx` wraps `@tanstack/react-table` 8.21 with sorting and `onChange` column
  resizing, both held in local state (lost on reload). It carries `'use no memo'` for the React Compiler.
- There is **no server-side per-user settings store** in Mk1. App preferences go through Tauri commands (the
  desktop app is unused); flag filters and view mode use localStorage.
- Agent users (machine keys) are deny-by-default: `backend/auth.py` accepts them only on routes listed in
  `backend/agents/access.py`. A new route that uses `get_current_user` is closed to agents automatically.
- Schema changes: Mk1 has no Alembic. New tables come from `Base.metadata.create_all` (`backend/models.py`); new
  columns on existing tables use the idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` list in
  `backend/database.py`.
- `backend/slack_notify/messages.py` `link_hash_for()` builds DM tap-through links. Flags whose entity has no page
  fall back to `#dashboard/orders?flag=<id>`.

## The design

### 1. Navigation

- New `ActiveSection` value `tasks`, wired exactly like the existing `boards` section (a top-level item with no
  sub-items): `ui-store.ts` section union, `VALID_SECTIONS` in `hash-navigation.ts`, the `MainWindowContent`
  switch, and the `AppSidebar` item list (plus `LeftSideBar` if `boards` appears there).
- Sidebar label **Tasks**, a checklist-style lucide icon. Placement near the top of the sidebar is the builder's
  call.
- Visible to every logged-in user (no `adminOnly`).

### 2. Page layout

Top to bottom:

1. Header: "Tasks" title, the flags Guide link (`/guides/flags-system-guide.html`, same as the flyout), and a
   **New task** button that is the existing `RaiseFlagButton` with no preset entity (it already defaults the
   anchor to the General Task item kind).
2. Tab row: Assigned to me, Raised by me, Watching, All open, Unread, Activity. Same labels and order as the
   flyout. Unread dots on tabs work as in the flyout (`unreadBuckets`).
3. Filter bar: the existing `FlagsFilterBar`, shown on every tab except Unread and Activity (the flyout also hides
   it on Unread). **The page's filters are its own, separate from the flyout's** (Handler, 2026-10-27). They are
   stored in localStorage under their own keys (for example `tasks:filter:<tab>`) with the same per-tab defaults
   as the flyout (personal tabs default to All open). Builder's suggestion: give `useFlagFilter` an optional scope
   argument that only changes the storage key and defaults to today's `flags:filter:<tab>`, so the flyout's calls
   and behavior are untouched. Do not prefix the tab name itself: `defaultFlagFilter` keys its All-open default off
   the bare tab name.
4. Body:
   - API tabs and Unread: the new sortable, resizable table (section 3).
   - Activity: `FlagActivityFeed`, full width. It is a feed, not a table, so sorting and widths do not apply.
   - Loading, error (with retry), empty ("Nothing assigned to you" style copy per tab) and filtered-out ("No
     tasks match these filters") states, matching the flyout's wording where it already has one.

Comment search works as in the flyout: instant client filter, plus `useFlagSearch` for 3+ characters, merged
with `mergeSearchHits`.

Out of scope for the page: the flyout's entity-scoped and order-scoped views (those are reached from entity
pages and stay flyout-only), the list/table view toggle (the page is always a table), and the row "pulse" for
just-acknowledged pings. Opening the Tasks page does **not** acknowledge pings; the header flag button's ping
behavior is unchanged.

### 3. The table

Columns, left to right:

| Column | Content | Sort key |
| --- | --- | --- |
| (accent) | Unread bar, same as `FlagTable` | not sortable, not resizable, fixed narrow |
| Item | Entity chip with deep-link button, same as `FlagTable` | display label, case-insensitive |
| Type | Type pill | type label, case-insensitive |
| Title | Title plus the search-hit marker | title, case-insensitive |
| Assignee | Avatar plus name | name, case-insensitive; Unassigned sorts last |
| Status | Status pill | workflow order: open, in_progress, blocked, resolved, closed |
| Due | Due label, overdue in red | `due_at`; tasks with no due date sort last in both directions |
| Last activity | **New column.** `updated_at`, same date-time format as Created | `updated_at` |
| Created | `created_at` | `created_at` |

- **Last activity** is new because the server already orders lists by `updated_at`; showing it makes the default
  order visible and sortable.
- **Default order** (no saved sort): Last activity, newest first, which is the server's order.
- Clicking a header cycles that column through ascending, descending, and off (single-column sort). Off means
  the default order.
- Dragging a header's right edge resizes that column. Sensible minimum widths so pills and chips stay readable;
  Title gets the widest default. If the total width exceeds the page, the table scrolls horizontally inside its
  container; the page itself does not.
- Rows: click or Enter/Space opens the task (section 4). The Item chip's deep-link button keeps working without
  opening the task, as in `FlagTable`.
- The cell markup must match `FlagTable` exactly. **Builder's call, with this constraint:** extract the cell
  renderers from `FlagTableRow` into a shared module so both tables render the same chips. `FlagTable`'s output
  and tests must not change.
- **Table component (my call, open to the builder if it fights the shape):** extend
  `src/components/ui/data-table.tsx` rather than writing a second TanStack table. Add optional props for
  controlled `sorting` and `columnSizing` with change callbacks, a per-row class name, and keyboard row
  activation. When the new props are absent, the component behaves exactly as today, so its four existing callers
  are untouched. If the builder instead writes a sibling component, it must reuse TanStack's sorting and resizing,
  not hand-roll them.

### 4. Opening a task

- A row click calls `openFlagThread(id)` with a new, optional "return to page" marker (for example
  `openFlagThread(id, { returnTo: 'page' })`; naming is the builder's call). This opens the existing global flyout
  on the thread, exactly as today.
- While that marker is set, the thread's back arrow and its "Back to flags" error button **close the flyout**
  instead of showing the flyout's list. The back arrow's label reads "Tasks" instead of the flyout tab name.
- The marker is per open, not per page: if a user on the Tasks page opens the flyout from the header button and
  clicks a thread there, back returns to the flyout list as usual. Closing the flyout clears the marker.
- `#tasks/overview?flag=<id>` opens the page and the thread with the marker set. The existing `?flag=` handling in
  `hash-navigation.ts` covers this once `tasks` is in `VALID_SECTIONS`; the builder adds the marker when the
  section is `tasks`. Accepting a bare `#tasks` as well is the builder's call; every link we emit uses
  `#tasks/overview`.

### 5. Saved settings (per user, server side)

**Storage.** New table `user_ui_settings` (created by `create_all`):

- `id` integer primary key
- `user_id` integer, foreign key to `users.id`, not null
- `key` varchar(64), not null
- `value` JSON, not null
- `updated_at` timestamp
- unique constraint on (`user_id`, `key`)

It is not a LIMS table, so no `lims_` prefix.

**Routes** (new small router, prefix `/api/ui-settings`, `get_current_user`):

- `GET /api/ui-settings/{key}` returns `{"key": ..., "value": {...}}`, or `{"key": ..., "value": null}` when the
  user has never saved that key. Not a 404, so the page needs no error branch for first use.
- `PUT /api/ui-settings/{key}` with body `{"value": {...}}` upserts and returns the same shape.
- The user is always the session user. There is no user id in the path, so nobody can read or write another
  person's settings.
- `key` must be in an explicit server-side allowlist. Today that is only `tasks.page`. Anything else returns 400.
  Adding a page later is a one-line change.
- `value` must be a JSON object no larger than 16 KB serialized. Larger returns 413, non-object returns 422.
- The response model types `value` as a free `dict[str, Any]`. A typed model would silently drop keys the front
  end adds later (a known FastAPI `response_model` trap in this codebase).
- Agents cannot reach these routes, because they are not on the `backend/agents/access.py` allowlist. This is
  correct and deliberate: it is the one UI-only route, as noted under anti-goals.

**Value for `tasks.page`:**

```json
{
  "v": 1,
  "tab": "assigned",
  "sorting": [{ "id": "due", "desc": false }],
  "columnSizing": { "title": 360, "assignee": 140 }
}
```

- On load, unknown tabs, unknown column ids and malformed entries are ignored and replaced with defaults. A bad
  saved value must never break the page.
- One sort and one set of widths for the whole table, shared by every tab. The last tab is saved too.

**Front end:**

- Read the setting **once** into React state when the page mounts, through TanStack Query. Never read it inside
  render or a memoized derivation. (The 2026-07 `useFlagFilter` bug: the React Compiler cached an impure read and
  same-tab updates stopped rendering.)
- Until the first load answers, show the page's normal loading state rather than rendering defaults and then
  jumping. If the load fails, use defaults and carry on.
- Save on change, debounced (about 500 ms). Column resizing fires on every mouse move in `onChange` mode, so the
  save must be debounced or happen on resize end; one drag must produce one request, not hundreds.
- If a save fails, show one quiet toast ("Couldn't save your table settings") and keep the user's current layout
  on screen.

### 6. Slack deep links

Change the fallback in `backend/slack_notify/messages.py` `link_hash_for()` from `#dashboard/orders?flag=<id>` to
`#tasks/overview?flag=<id>`. Sample, worksheet and order links are unchanged. Approved by the Handler on
2026-10-27 for general tasks.

- **Scope (my call):** the fallback is used by every `deep_link` kind except sample, worksheet and order. That
  includes general tasks and also `document`, `board`, `board_node` and `customer_item` flags. All of them move
  from the orders dashboard to the Tasks page, which is the more relevant landing; the thread opens either way.
- **Ship order:** the frontend that knows the `tasks` section must be live before or with the backend that emits
  the new links. A Mk1 release deploys both; if they are ever deployed separately, frontend first.
- **Tests:** `backend/tests/test_slack_notify_messages.py` asserts the old fallback at lines 22, 47-48 and 63
  (directly and through `build_message`). Update all of them.

## Constraints

- **Additive only.** Extend existing systems; do not re-architect the flyout, the flag service or `DataTable`.
- **npm only** in the Mk1 frontend.
- No new dependencies. `@tanstack/react-table`, `@tanstack/react-query`, lucide and the shadcn components are
  already installed.
- No em dashes in UI copy.
- Release gate: run the frontend **Docker build** (the image's `tsc` has no `backend/`), not only local tsc.
- Test baseline: gate on the failure-set diff against the base, never on zero failures. Backend pytest hits the
  host dev Postgres; run one suite at a time.

## Verification the builder owes

- Backend pytest for the settings routes: own-user only, key allowlist (400), size cap (413), non-object (422),
  first-use `null`, upsert, unknown keys inside `value` survive the round trip, agent key gets refused.
- Backend test for the new `link_hash_for()` fallback.
- Vitest: `DataTable` existing behavior unchanged without the new props; controlled sorting and sizing call their
  callbacks; Tasks page reads settings once, applies them, debounces saves, ignores malformed saved values;
  thread back arrow closes the flyout when opened from the page and returns to the list when opened from the
  header.
- `FlagTable` tests stay green with no snapshot or output changes.
- A devbox stack run, for the PR's `## Verified` block: sort and resize, reload, log in from a second browser and
  see the same layout; open a task and close it back to the page; `#tasks?flag=<id>` link; flyout unchanged when
  opened from the header.

## Rollout and rollback

- Mk1 frontend plus backend release. The new table is created at backend startup. No changes to the Integration
  Service, COA Builder or WordPress; `JWT_SECRET` is unaffected.
- Rollback: redeploy the previous Mk1 version. `user_ui_settings` is left behind unused and harmless.
- Production behavior changes: a new page, and Slack DM links for general tasks now open the Tasks page. Both
  approved by the Handler.

## Known limits

- **All open** loads every open flag and sorts in the browser. The production count was not checked for this
  document; it should be fine at our volume. If it ever reaches several thousand, sorting and paging move to the
  server (`GET /api/flags` gains `sort` and `limit` parameters), which belongs with the flags API work.
- Filters remain per browser. Moving them to the account is a later step that reuses the same settings store
  (another allowlisted key).

## Left to the builder

- Sidebar position and icon.
- Default column widths and minimums.
- Names of the new `DataTable` props and the `openFlagThread` marker.
- Empty-state copy per tab, matching the flyout's tone.
- Whether resize saves on drag end or through the debounce, as long as one drag makes one request.
