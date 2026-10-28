# Tasks Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone `#tasks` page that is a full-page version of the flags flyout, with a sortable, resizable table whose sort, column widths and last tab are saved to the user's account.

**Architecture:** One small backend store (`user_ui_settings` table plus `GET/PUT /api/ui-settings/{key}`) holds per-user UI state. The page reuses the flyout's data hooks, filter bar and activity feed, renders flags through the existing `ui/data-table.tsx` (extended with optional controlled state), and opens tasks in the existing flyout with a "return to page" marker. Slack's fallback deep link moves to the page.

**Tech Stack:** FastAPI + SQLAlchemy (sqlite in unit tests, Postgres in prod), React 19, Zustand, TanStack Query 5, TanStack Table 8.21, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-27-tasks-page-design.md` (read it before any task).

## Global Constraints

- Additive only: extend existing systems; no re-architecture of the flyout, flag service or `DataTable`.
- `DataTable` behaves exactly as today for its four existing callers (`COAExplorer`, `OrderExplorer`, `DocumentsPage`, `OrderDetailPanel`) when the new props are absent.
- The flyout's list, table, tabs and filters (`flags:filter:<tab>`) do not change. `FlagTable` output and tests do not change.
- Flag data only through existing `/api/flags` routes. The only new routes are `/api/ui-settings/{key}`.
- Settings keys allowlist: exactly `{"tasks.page"}`. Value: JSON object, max 16 KB serialized (16384 bytes). 400 unknown key, 413 oversize, 422 non-object. Response `value` typed as a free `dict[str, Any]`.
- New table name `user_ui_settings` (no `lims_` prefix), created by `create_all`; no ALTER entries.
- npm only. No new dependencies.
- No em dashes in UI copy.
- Settings read once into state; never read storage inside render memoization (React Compiler).
- One column drag produces one save request. Other saves debounced 500 ms.
- Save failure toast copy: `Couldn't save your table settings`.
- Slack fallback: `#tasks/overview?flag=<id>`.

**Working rules for this worktree** (`C:/tmp/Accu-Mk1-tasks-page`, branch `feat/tasks-page`):

- Backend Python: `/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe` (bare `python` hangs on this box). Abbreviated below as `$PY`. Run from `backend/`, prefixed `MK1_DB_HOST=127.0.0.1 INTEGRATION_DB_LOCAL_HOST=127.0.0.1`. One pytest process at a time.
- Frontend: run `npm ci` once before Task 3 (no `node_modules` in this worktree yet).
- New files written on Windows come out CRLF: `sed -i 's/\r$//' <new files>` before staging.
- Stage and commit with explicit paths: `git -c core.autocrlf=true add -- <paths>` then `git -c core.autocrlf=true commit -m "..." -- <paths>`. End messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Gate on the failure-set diff against base `ac316df2`, never on zero failures.

## Review Focus

1. Saved settings from an older build: unknown column ids, widths of 0, negative, NaN or 99999, a tab value that no longer exists. Expect: dropped or clamped, page renders normally (Task 7 test `parseTasksSettings sanitizes bad input`).
2. Settings GET fails (network, 401, 500). Expect: page renders defaults, no error banner, and no PUT is sent until the user changes something (Task 7 test `load failure falls back to defaults without saving`).
3. General tasks (no entity) and unassigned rows under Item and Assignee sorts. Expect: no crash; Unassigned last in both directions (Task 8 test `assignee sort puts Unassigned last both ways`).
4. Deep link to a flag the user cannot see, opened on the Tasks page. Expect: thread error state's "Back to flags" closes the flyout and leaves the page (Task 5 test `closeFlagThread with the page marker closes the flyout`, which covers both buttons because both call `closeFlagThread`).
5. Clicking a linked flag inside a thread opened from the page. Expect: back still returns to the page (Task 5 test `marker survives opening another thread while the flyout is open`).

---

### Task 1: Backend per-user UI settings store

**Files:**

- Modify: `backend/models.py` (add `UserUiSetting` after `SlackDmPrefs`)
- Create: `backend/ui_settings/__init__.py` (empty), `backend/ui_settings/routes.py`
- Modify: `backend/main.py` (import near line 125, `app.include_router` next to `flags_router` near line 648)
- Test: `backend/tests/test_ui_settings_routes.py`

**Interfaces:**

- Produces: `GET /api/ui-settings/{key}` and `PUT /api/ui-settings/{key}` (body `{"value": {...}}`), both returning `{"key": str, "value": dict | null}`. Consumed by Task 7.

- [ ] **Step 1: Write the failing tests.** Fixture: in-memory sqlite engine with `StaticPool`, `Base.metadata.create_all`, two `User` rows (ids 1 and 2); a bare `FastAPI()` app that includes `ui_settings.routes.router`, with `app.dependency_overrides` for `get_db` and `get_current_user` (a mutable holder so a test can switch to user 2).

```python
def test_get_unsaved_key_returns_null_value(client):
    r = client.get("/api/ui-settings/tasks.page")
    assert r.status_code == 200 and r.json() == {"key": "tasks.page", "value": None}

def test_put_then_get_round_trips_unknown_nested_keys(client):
    v = {"v": 1, "tab": "raised", "extra": {"a": [1, 2]}}
    assert client.put("/api/ui-settings/tasks.page", json={"value": v}).json() == {"key": "tasks.page", "value": v}
    assert client.get("/api/ui-settings/tasks.page").json()["value"] == v

def test_put_upserts_one_row(client, session):
    client.put("/api/ui-settings/tasks.page", json={"value": {"tab": "a"}})
    client.put("/api/ui-settings/tasks.page", json={"value": {"tab": "b"}})
    rows = session.query(UserUiSetting).all()
    assert len(rows) == 1 and rows[0].value == {"tab": "b"}

def test_unknown_key_is_400(client):
    assert client.get("/api/ui-settings/other.page").status_code == 400
    assert client.put("/api/ui-settings/other.page", json={"value": {}}).status_code == 400

def test_non_object_value_is_422(client):
    assert client.put("/api/ui-settings/tasks.page", json={"value": [1, 2]}).status_code == 422
    assert client.put("/api/ui-settings/tasks.page", json={"value": "x"}).status_code == 422

def test_oversize_value_is_413(client):
    assert client.put("/api/ui-settings/tasks.page", json={"value": {"x": "a" * 16500}}).status_code == 413

def test_settings_are_per_user(client, as_user):
    client.put("/api/ui-settings/tasks.page", json={"value": {"tab": "raised"}})
    as_user(2)
    assert client.get("/api/ui-settings/tasks.page").json()["value"] is None
```

- [ ] **Step 2: Run to verify failure.** `cd backend && MK1_DB_HOST=127.0.0.1 INTEGRATION_DB_LOCAL_HOST=127.0.0.1 $PY -m pytest tests/test_ui_settings_routes.py -q -p no:cacheprovider`. Expected: collection error (`ui_settings` / `UserUiSetting` missing).

- [ ] **Step 3: Add `class UserUiSetting(Base)`** in `backend/models.py`: `__tablename__ = "user_ui_settings"`; `id` int PK autoincrement; `user_id` `Integer, ForeignKey("users.id"), nullable=False, index=True`; `key` `String(64), nullable=False`; `value` `JSON, nullable=False`; `updated_at` `DateTime(timezone=True), nullable=False`; `__table_args__ = (UniqueConstraint("user_id", "key", name="uq_user_ui_settings_user_key"),)`. Docstring: per-user UI state for pages (sort, widths, last tab); never flag data.

- [ ] **Step 4: Implement `backend/ui_settings/routes.py`.** `router = APIRouter(prefix="/api/ui-settings", tags=["ui-settings"])`; `ALLOWED_KEYS = frozenset({"tasks.page"})`; `MAX_BYTES = 16384`; `class UiSettingIn(BaseModel): value: dict[str, Any]`; `class UiSettingOut(BaseModel): key: str; value: dict[str, Any] | None`. `get_setting(key, db=Depends(get_db), user=Depends(get_current_user)) -> UiSettingOut` and `put_setting(key, body: UiSettingIn, db, user) -> UiSettingOut`. Order in both: key not in `ALLOWED_KEYS` raises 400 `"unknown settings key"`; in PUT, `len(json.dumps(body.value, separators=(",", ":")).encode())` above `MAX_BYTES` raises 413; upsert by `(user.id, key)`, set `updated_at = datetime.now(timezone.utc)`, commit. Register in `main.py`.

- [ ] **Step 5: Run the new tests and the agent route matrix.** `$PY -m pytest tests/test_ui_settings_routes.py tests/test_agents_route_matrix.py -q -p no:cacheprovider` (same env prefix). Expected: all pass. The matrix walks every bearer route, so it now proves agent keys get 403 on both new routes.

- [ ] **Step 6: Commit** `backend/models.py backend/ui_settings/__init__.py backend/ui_settings/routes.py backend/main.py backend/tests/test_ui_settings_routes.py` with `feat(ui-settings): per-user UI settings store for page layouts`.

---

### Task 2: Slack fallback link opens the Tasks page

**Files:**

- Modify: `backend/slack_notify/messages.py` (`link_hash_for`, fallback line)
- Test: `backend/tests/test_slack_notify_messages.py` (assertions at lines 22, 47-48, 63; check line 83's intent)

- [ ] **Step 1: Update the tests first.** Every expectation of `#dashboard/orders?flag=7` becomes `#tasks/overview?flag=7` (direct `link_hash_for` calls and through `build_message`, e.g. `assert "https://mk1.example/#tasks/overview?flag=7" in flat`). Line 83 asserts the old fallback is absent for a resolvable entity; keep that intent and also assert `"#tasks/overview" not in flat` there.
- [ ] **Step 2: Run to verify failure.** `$PY -m pytest tests/test_slack_notify_messages.py -q -p no:cacheprovider`. Expected: the updated assertions fail.
- [ ] **Step 3: Change the fallback** to `return f"#tasks/overview?flag={flag_id}"` and the docstring's "dashboard fallback" to "Tasks page fallback".
- [ ] **Step 4: Run again.** Expected: pass.
- [ ] **Step 5: Commit** both files: `feat(slack): flag DMs without an entity page open the Tasks page`.

---

### Task 3: `DataTable` optional controlled state

**Files:**

- Modify: `src/components/ui/data-table.tsx`
- Test: `src/components/ui/__tests__/data-table.test.tsx` (new)

**Interfaces:**

- Produces (all optional; absent means today's behavior):
  - `sorting?: SortingState`, `onSortingChange?: (next: SortingState) => void`
  - `columnSizing?: ColumnSizingState`, `onColumnSizingChange?: (next: ColumnSizingState) => void`
  - `onColumnSizingCommit?: (sizing: ColumnSizingState) => void` (fires once when a resize drag ends)
  - `getRowClassName?: (row: TData) => string | undefined`
  - `keyboardRowActivation?: boolean` (rows get `tabIndex=0`; Enter or Space calls `onRowClick`)

- [ ] **Step 0:** `npm ci` (worktree has no `node_modules`).
- [ ] **Step 1: Write the failing tests** (two columns `name` and `n`, three rows):

```tsx
it('uncontrolled: clicking a header still sorts rows', ...)          // rows reorder; no props passed
it('controlled sorting: header click reports, rows follow the prop', () => {
  // render with sorting=[] and onSortingChange=spy; click "Name" header
  expect(spy).toHaveBeenCalledWith([{ id: 'name', desc: false }])
  // rerender with sorting=[{ id: 'name', desc: true }] -> first row is the last name alphabetically
})
it('controlled sizing: header width comes from the prop', () => {
  // columnSizing={{ name: 240 }} -> the Name <th> has style width 240px
})
it('a resize drag fires onColumnSizingCommit exactly once, with the final width', () => {
  // a wrapper component holds columnSizing in useState and passes it back (controlled, as TasksPage will);
  // mouseDown on the Name resize handle at x=100, mouseMove on document to 120, 140, 160, mouseUp
  expect(commit).toHaveBeenCalledTimes(1)
  expect(commit.mock.calls[0][0].name).toBe(startWidth + 60)
})
it('keyboard rows: Enter activates, and rows are not focusable without the flag', ...)
it('getRowClassName adds its class to the row', ...)
```

- [ ] **Step 2: Run to verify failure.** `npx vitest run src/components/ui/__tests__/data-table.test.tsx`. Expected: controlled, commit, keyboard and class tests fail.
- [ ] **Step 3: Implement.** Internal `useState` stays as the fallback when a controlled prop is undefined. TanStack's updater callbacks resolve `typeof u === 'function' ? u(current) : u` before calling the prop. Commit detection: keep the previous `table.getState().columnSizingInfo.isResizingColumn` in a ref; on the transition from a column id to `false`, call `onColumnSizingCommit(table.getState().columnSizing)`. Keep `'use no memo'` and the existing eslint disable.
- [ ] **Step 4: Run the new test plus the existing callers' tests.** `npx vitest run src/components/ui src/components/COAExplorer src/components/OrderExplorer src/components/documents src/components/explorer`. Expected: new tests pass; caller tests unchanged.
- [ ] **Step 5: Commit** `feat(data-table): optional controlled sorting/sizing, resize commit, keyboard rows`.

---

### Task 4: Shared flag table cells

**Files:**

- Create: `src/components/flags/flag-table-cells.tsx`
- Modify: `src/components/flags/FlagTable.tsx` (rows compose the cells; header and `GRID_TEMPLATE` unchanged)
- Test: existing `src/components/flags/__tests__/FlagTable.test.tsx` (unchanged)

**Interfaces:**

- Produces (markup moved verbatim from `FlagTableRow`):
  - `UnreadAccentCell({ unread }: { unread: boolean })`
  - `EntityCell({ flag, kindLabels }: { flag: FlagResponse; kindLabels: Record<string, string> })` (includes the deep-link button and its `stopPropagation`)
  - `TypePillCell({ def }: { def: FlagTypeDef })`
  - `TitleCell({ flag, search }: { flag: FlagResponse; search?: FlagSearchMeta })`
  - `AssigneeCell({ flag, users, currentUserId }: { flag: FlagResponse; users: UserMap; currentUserId: number | null })`
  - `StatusCell({ status }: { status: string })`
  - `DueCell({ flag }: { flag: FlagResponse })`
  - `DateTimeCell({ iso, align }: { iso: string; align?: 'start' | 'end' })`

- [ ] **Step 1: Run the FlagTable tests on the base** to record the green baseline: `npx vitest run src/components/flags/__tests__/FlagTable.test.tsx`.
- [ ] **Step 2: Move the cell markup** into `flag-table-cells.tsx` and rewrite `FlagTableRow` to use it. No class, text or attribute changes.
- [ ] **Step 3: Run the same tests plus the flags folder.** `npx vitest run src/components/flags`. Expected: identical pass set to the base.
- [ ] **Step 4: Commit** `refactor(flags): share FlagTable cells (no output change)`.

---

### Task 5: Flyout "return to page" marker

**Files:**

- Modify: `src/store/ui-store.ts` (state, `openFlagThread`, `closeFlagThread`, `closeFlagsFlyout`, and the other flyout openers)
- Modify: `src/components/flags/FlagsFlyout.tsx` (thread `tabLabel`, line 269)
- Modify: `src/lib/hash-navigation.ts` (`applyNavToStore`, `?flag=` branch)
- Test: `src/store/ui-store.test.ts`, `src/lib/__tests__/hash-navigation-flag.test.ts`

**Interfaces:**

- Produces: state `flagsThreadReturnTo: 'page' | null` (initial `null`); `openFlagThread(id: number, opts?: { returnTo?: 'page' }) => void`. Consumed by Tasks 8 and 9.
- Rules: `openFlagThread` sets `returnTo` to `opts.returnTo` when given, else keeps the current value if the flyout is already open, else `null`. `closeFlagThread` with `returnTo === 'page'` does everything `closeFlagsFlyout` does; otherwise it behaves as today. `closeFlagsFlyout`, `openFlagsFlyout`, `openFlagsForEntity` and `openFlagsForSamples` set it to `null`.

- [ ] **Step 1: Write the failing tests** in `ui-store.test.ts`:

```ts
it('closeFlagThread with the page marker closes the flyout', () => {
  s().openFlagThread(5, { returnTo: 'page' })
  s().closeFlagThread()
  expect(s()).toMatchObject({
    flagsFlyoutOpen: false,
    flagsThreadId: null,
    flagsThreadReturnTo: null,
  })
})
it('marker survives opening another thread while the flyout is open', () => {
  s().openFlagThread(5, { returnTo: 'page' })
  s().openFlagThread(6)
  expect(s().flagsThreadReturnTo).toBe('page')
})
it('a plain open from a closed flyout has no marker', () => {
  s().closeFlagsFlyout()
  s().openFlagThread(7)
  expect(s().flagsThreadReturnTo).toBeNull()
})
it('opening the flyout list clears the marker', () => {
  s().openFlagThread(5, { returnTo: 'page' })
  s().openFlagsFlyout()
  expect(s().flagsThreadReturnTo).toBeNull()
})
```

and in `hash-navigation-flag.test.ts`:

```ts
it('#tasks/overview?flag=42 opens the Tasks page with the thread marked', () => {
  window.location.hash = '#tasks/overview?flag=42'
  // apply as the existing tests do
  expect(useUIStore.getState()).toMatchObject({
    activeSection: 'tasks',
    flagsThreadId: 42,
    flagsThreadReturnTo: 'page',
  })
})
```

The existing `closeFlagThread() drops the thread but keeps the flyout open` test must stay green unchanged.

- [ ] **Step 2: Run to verify failure.** `npx vitest run src/store/ui-store.test.ts src/lib/__tests__/hash-navigation-flag.test.ts`.
- [ ] **Step 3: Implement the store rules.** Add `'tasks'` to `ActiveSection` and to `VALID_SECTIONS` in this task (the hash test needs it). In `applyNavToStore`: `store.openFlagThread(flagId, section === 'tasks' ? { returnTo: 'page' } : undefined)`. In `FlagsFlyout`: `tabLabel={flagsThreadReturnTo === 'page' ? 'Tasks' : activeTabLabel}`.
- [ ] **Step 4: Run the two files plus `src/components/flags`, then `npm run typecheck`.** Expected: pass; flags folder unchanged; no type errors from the widened `ActiveSection` union (fix any exhaustive `Record<ActiveSection, ...>` maps it breaks).
- [ ] **Step 5: Commit** `feat(flags): threads opened from the Tasks page return to it`.

---

### Task 6: Separate filter scope and the page's list hook

**Files:**

- Modify: `src/components/flags/use-flag-filter.ts`
- Create: `src/components/tasks/use-task-list.ts`, `src/components/tasks/tasks-tabs.ts`
- Test: `src/components/flags/__tests__/use-flag-filter.test.ts`, `src/components/tasks/__tests__/use-task-list.test.ts`

**Interfaces:**

- Produces: `useFlagFilter(tab: string, scope: string = 'flags')`; storage key `` `${scope}:filter:${tab}` ``; defaults still from `defaultFlagFilter(tab)` (bare tab).
- Produces in `tasks-tabs.ts`: `type TasksTab = 'assigned' | 'raised' | 'watching' | 'all_open' | 'unread' | 'activity'`; `TASKS_TABS: { value: TasksTab; label: string }[]` with the flyout's labels and order (Assigned to me, Raised by me, Watching, All open, Unread, Activity); `DEFAULT_TASKS_TAB: TasksTab = 'assigned'`.
- Produces: `useTaskList(tab: TasksTab, filter: FlagFilterState): TaskList` where `TaskList = { total: number; visibleFlags: FlagResponse[]; searchMeta: Map<number, FlagSearchMeta>; isLoading: boolean; isError: boolean; refetch: () => void; searchPending: boolean; unreadIds: Set<number>; unreadCount: number; buckets: ReturnType<typeof unreadBuckets> }`. Same derivation as the flyout's un-scoped path (`FlagsFlyout.tsx` tab query, Unread list, `filterFlags`, debounced `useFlagSearch` at 3+ chars, `mergeSearchHits`). For `activity` it returns an empty list (the page renders the feed). `// ponytail: duplicates FlagsFlyout's un-scoped derivation; switch the flyout to this hook in a later change.`

- [ ] **Step 1: Write the failing tests.**

```ts
it('scope keeps a separate storage key with the same defaults', () => {
  const { result } = renderHook(() => useFlagFilter('assigned', 'tasks'))
  expect(result.current[0].status).toBe('all_open')
  act(() => result.current[1]({ ...result.current[0], status: 'all' }))
  expect(localStorage.getItem('tasks:filter:assigned')).toContain(
    '"status":"all"'
  )
  expect(localStorage.getItem('flags:filter:assigned')).toBeNull()
})
```

`use-task-list.test.ts` (mock `@/hooks/use-flags`): returns the tab query's flags filtered by status; `unread` tab returns the unread list; a 3+ char search merges a comment-only hit; `activity` returns `visibleFlags: []`.

- [ ] **Step 2: Run to verify failure.** `npx vitest run src/components/flags/__tests__/use-flag-filter.test.ts src/components/tasks`.
- [ ] **Step 3: Implement** the scope argument and the two new files.
- [ ] **Step 4: Run again plus `src/components/flags`.** Expected: pass; flyout tests unchanged.
- [ ] **Step 5: Commit** `feat(tasks): separate filter scope and list hook for the Tasks page`.

---

### Task 7: Settings client and `useTasksPageSettings`

**Files:**

- Create: `src/lib/ui-settings-api.ts`, `src/components/tasks/tasks-page-settings.ts`
- Test: `src/components/tasks/__tests__/tasks-page-settings.test.tsx`

**Interfaces:**

- Consumes: Task 1 routes; `TasksTab` and `TASKS_TABS` from Task 6.
- Defines `TASK_COLUMN_LIMITS` here (Task 8 imports it), so this task has no forward dependency.
- Produces:
  - `type UiSettingKey = 'tasks.page'`; `getUiSetting(key: UiSettingKey): Promise<Record<string, unknown> | null>`; `putUiSetting(key: UiSettingKey, value: Record<string, unknown>): Promise<void>` (both via `apiFetch`).
  - `TASK_COLUMN_LIMITS: Record<TaskColumnId, { size: number; min: number; max: number }>` with `item {150,90,400}`, `type {110,80,300}`, `title {360,160,900}`, `assignee {150,90,400}`, `status {120,90,300}`, `due {100,80,300}`, `last_activity {140,110,400}`, `created {140,110,400}`; `type TaskColumnId = keyof typeof TASK_COLUMN_LIMITS`.
  - `interface TasksPageSettings { v: 1; tab: TasksTab; sorting: SortingState; columnSizing: ColumnSizingState }`; `DEFAULT_TASKS_SETTINGS` (`tab 'assigned'`, `sorting []`, `columnSizing {}`).
  - `parseTasksSettings(raw: unknown): TasksPageSettings`.
  - `useTasksPageSettings(): { ready: boolean; settings: TasksPageSettings; update: (patch: Partial<Omit<TasksPageSettings, 'v'>>) => void }`. Query key `['ui-settings', 'tasks.page']`, `retry: false`, `staleTime: Infinity`. **The query cache is the source of truth** (the page remounts on every visit through `navigationKey`, so component state would show a stale layout on return): `settings = parseTasksSettings(query.data)`; `update` merges the patch into the current settings, writes the merged value with `queryClient.setQueryData(['ui-settings', 'tasks.page'], merged)` at once, and schedules one `putUiSetting` of the latest merged value 500 ms after the last call. `ready` once the query succeeds or fails; failure means defaults. A pending save flushes on unmount; a failed save calls `toast.error("Couldn't save your table settings")`.

- [ ] **Step 1: Write the failing tests.**

```ts
it('parseTasksSettings sanitizes bad input', () => {
  expect(parseTasksSettings(null)).toEqual(DEFAULT_TASKS_SETTINGS)
  expect(parseTasksSettings([1])).toEqual(DEFAULT_TASKS_SETTINGS)
  const p = parseTasksSettings({
    v: 1,
    tab: 'gone',
    sorting: [{ id: 'nope', desc: true }],
    columnSizing: {
      title: 99999,
      type: 10,
      item: 0,
      due: -5,
      status: Number.NaN,
      ghost: 200,
    },
  })
  expect(p.tab).toBe('assigned')
  expect(p.sorting).toEqual([])
  expect(p.columnSizing).toEqual({ title: 900, type: 80 }) // positive values clamped; <= 0, NaN and unknown ids dropped
})
it('keeps only the first sort entry', () => {
  expect(
    parseTasksSettings({
      sorting: [
        { id: 'due', desc: false },
        { id: 'title', desc: true },
      ],
    }).sorting
  ).toEqual([{ id: 'due', desc: false }])
})
it('loads a saved value once and applies it', async () => {
  /* getUiSetting resolves {tab:'watching'} -> ready, settings.tab 'watching' */
})
it('load failure falls back to defaults without saving', async () => {
  // getUiSetting rejects -> ready true, settings equal DEFAULT_TASKS_SETTINGS, putUiSetting not called
})
it('debounces saves into one PUT of the merged value', async () => {
  // fake timers: update({ tab: 'raised' }); update({ sorting: [{ id: 'due', desc: true }] }); advance 499 -> 0 calls; advance 1 -> 1 call
  expect(put).toHaveBeenCalledWith(
    'tasks.page',
    expect.objectContaining({
      v: 1,
      tab: 'raised',
      sorting: [{ id: 'due', desc: true }],
    })
  )
})
it('a failed save shows one toast', async () => {
  /* put rejects -> toast.error called once with the exact copy */
})
it('a remount shows the updated value without a second GET', async () => {
  // shared QueryClient: mount, update({ tab: 'raised' }), unmount, mount again
  expect(result.current.settings.tab).toBe('raised')
  expect(get).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Run to verify failure.** `npx vitest run src/components/tasks/__tests__/tasks-page-settings.test.tsx`.
- [ ] **Step 3: Implement.** No component state for the settings themselves; derive from the query cache (query data is not an impure read, so the React Compiler is safe). Timer and the latest pending value in `useRef`s.
- [ ] **Step 4: Run again.** Expected: pass.
- [ ] **Step 5: Commit** `feat(tasks): account-saved Tasks page settings`.

---

### Task 8: `TasksTable`

**Files:**

- Create: `src/components/tasks/task-columns.tsx`, `src/components/tasks/TasksTable.tsx`
- Test: `src/components/tasks/__tests__/TasksTable.test.tsx` (mock `flag-users` exactly as `FlagTable.test.tsx` does)

**Interfaces:**

- Consumes: Task 3 `DataTable` props; Task 4 cells; Task 5 `openFlagThread(id, { returnTo: 'page' })`; Task 7 `TASK_COLUMN_LIMITS`, `TaskColumnId`.
- Produces: `TasksTable(props: { flags: FlagResponse[]; unreadIds: Set<number>; searchMeta: Map<number, FlagSearchMeta>; sorting: SortingState; onSortingChange: (s: SortingState) => void; columnSizing: ColumnSizingState; onColumnSizingChange: (s: ColumnSizingState) => void; onColumnSizingCommit: (s: ColumnSizingState) => void })`.
- `interface TaskColumnContext { users: UserMap; typesMap: Record<string, FlagTypeDef>; kindLabels: Record<string, string>; currentUserId: number | null; unreadIds: Set<number>; searchMeta: Map<number, FlagSearchMeta> }`. `TasksTable` builds it from the same hooks `FlagTable` uses (`useFlagUsers`, `useFlagTypesMap`, `useItemKindLabels`, `useAuthStore(s => s.user?.id ?? null)`) plus its props.
- `buildTaskColumns(ctx: TaskColumnContext): ColumnDef<FlagResponse>[]`, header labels `Item, Type, Title, Assignee, Status, Due, Last activity, Created`, preceded by an `accent` column (`enableSorting: false`, `enableResizing: false`, size 6). Every data column: `sortDescFirst: false`, `size/minSize/maxSize` from `TASK_COLUMN_LIMITS`. Sort values: item, type, title, assignee are lowercased strings; assignee is `undefined` when unassigned; status is the index in `['open','in_progress','blocked','resolved','closed']`; due is the epoch ms or `undefined`; last activity and created are epoch ms of `updated_at` / `created_at`. Due and assignee use `sortUndefined: 'last'`.
- Row click and Enter/Space: `openFlagThread(flag.id, { returnTo: 'page' })`. `keyboardRowActivation` on.

- [ ] **Step 1: Write the failing tests.**

```tsx
it('renders every header label', ...)   // the eight labels above
it('clicking Due reports an ascending sort', () => {
  expect(onSortingChange).toHaveBeenCalledWith([{ id: 'due', desc: false }])
})
it('due sort keeps tasks with no due date last both ways', ...)       // sorting=[due asc] and [due desc]
it('assignee sort puts Unassigned last both ways', ...)
it('status sorts by workflow order, not alphabet', ...)               // open, in progress, blocked, resolved, closed
it('general tasks sort under Item without crashing', ...)             // entity_type 'general_task', entity_id null
it('a row click opens the thread with the page marker', () => {
  expect(useUIStore.getState()).toMatchObject({ flagsThreadId: 1, flagsThreadReturnTo: 'page' })
})
it('the Item deep-link button does not open the thread', ...)
```

- [ ] **Step 2: Run to verify failure.** `npx vitest run src/components/tasks/__tests__/TasksTable.test.tsx`.
- [ ] **Step 3: Implement** the columns and the table.
- [ ] **Step 4: Run again.** Expected: pass.
- [ ] **Step 5: Commit** `feat(tasks): sortable, resizable Tasks table`.

---

### Task 9: `TasksPage` and navigation

**Files:**

- Create: `src/components/tasks/TasksPage.tsx`
- Modify: `src/components/layout/MainWindowContent.tsx` (`case 'tasks': return <TasksPage />`), `src/components/layout/AppSidebar.tsx` (item `{ id: 'tasks', label: 'Tasks', icon: ListChecks }` directly after the dashboard item, no `adminOnly`)
- Test: `src/components/tasks/__tests__/TasksPage.test.tsx` (mock `useTasksPageSettings`, `useTaskList`, `FlagActivityFeed`, `RaiseFlagButton`, `FlagsFilterBar`)

**Interfaces:**

- Consumes: Tasks 5 to 8.
- Layout per spec section 2: header (title `Tasks`, Guide link `/guides/flags-system-guide.html`, `RaiseFlagButton` with a `New task` trigger), tab row from `TASKS_TABS` with the flyout's unread count and dots, `FlagsFilterBar` driven by `useFlagFilter(tab, 'tasks')` (shown on API tabs only, `showAssignee={tab !== 'assigned'}`), then the body. Count line `N of M` as in the flyout.
- Settings: wait for `ready` (show three `Skeleton` rows). Tab change calls `update({ tab })`; sort change calls `update({ sorting })`; widths live in page state during a drag and `onColumnSizingCommit` calls `update({ columnSizing })`.
- Copy: empty states `Nothing assigned to you.` (assigned), `You haven't raised any open tasks.` (raised), `You're not watching any tasks.` (watching), `No open tasks.` (all_open), `You're all caught up.` (unread); filtered out `No tasks match these filters.`; load error `Couldn't load tasks.` with a `Retry` button.

- [ ] **Step 1: Write the failing tests.**

```tsx
it('shows skeletons until settings are ready', ...)            // ready false -> no table, no tabs
it('opens on the saved tab, Assigned to me by default', ...)
it('switching tabs saves the tab', () => { expect(update).toHaveBeenCalledWith({ tab: 'raised' }) })
it('Activity renders the feed and no table', ...)
it('Unread hides the filter bar', ...)
it('empty and filtered-out states use the agreed copy', ...)
it('a column resize commit saves the widths', ...)              // TasksTable onColumnSizingCommit -> update({ columnSizing })
```

- [ ] **Step 2: Run to verify failure.** `npx vitest run src/components/tasks/__tests__/TasksPage.test.tsx`.
- [ ] **Step 3: Implement** the page and wire the section switch and sidebar item.
- [ ] **Step 4: Run the tasks, flags, layout and lib folders.** `npx vitest run src/components/tasks src/components/flags src/components/layout src/lib src/store`. Expected: new tests pass; the rest match base.
- [ ] **Step 5: Commit** `feat(tasks): Tasks page and sidebar entry`.

---

### Task 10: Gates, Docker build and devbox verification

- [ ] **Step 1: Frontend gates.** `npm run typecheck && npm run lint && npm run ast:lint && npm run format:check`. Expected: clean. Then `npx vitest run` and diff the failing-file set against base `ac316df2` (run the base in a scratch checkout or use the recorded baseline). Expected: no new failures.
- [ ] **Step 2: Backend suites touched.** `$PY -m pytest tests/test_ui_settings_routes.py tests/test_agents_route_matrix.py tests/test_slack_notify_messages.py tests/test_flags_* -q -p no:cacheprovider` (env prefix as above, one process). Expected: same failure set as base.
- [ ] **Step 3: Frontend Docker build** (release gate; the image's `tsc` has no `backend/`). Build the frontend image the way `deploy.sh` does. Expected: build succeeds.
- [ ] **Step 4: Devbox stack** via the `accumark-stack-platform` skill, on this branch. Check and screenshot: sort and resize, reload, same layout from a second browser login; tab restored; open a task and close it back to the page (back arrow reads Tasks); `#tasks/overview?flag=<id>` opens the page with the thread; header flag button still opens the flyout list and its back arrow returns to the list; flyout filters unaffected by page filters; DevTools shows one PUT per column drag; widening columns past the page scrolls the table inside its container, not the page; a Slack DM for a general task opens the Tasks page with the thread; an agent key gets 403 on `/api/ui-settings/tasks.page`.
- [ ] **Step 5: Write the PR's `## Verified` block** (stack name, commands, screenshots). Do not push or open the PR without the Handler's go-ahead. Destroy the stack when done.
