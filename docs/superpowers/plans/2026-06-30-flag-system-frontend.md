# Flag System — Frontend Implementation Plan (Phase 1, Plan 3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILLS: `superpowers:subagent-driven-development` (execute task-by-task) and `superpowers:frontend-design` (for the visual components). Steps use checkbox (`- [ ]`) syntax. Run on the devbox inside your mounted, isolated stack. **This project is `npm` only — never pnpm.**

**Goal:** Build the Flag System frontend for Accu-Mk1 — the Flags entry button (segmented color count chips + glow-on-new), a full-height right slide-over flyout (4 triage tabs + flag cards), the flag thread view (interleaved audit+comment timeline + composer with comment slide-in), a "raise flag" compose, the SSE live-update client, and toast notifications with the fly-to-home animation. It consumes the Plan-1 REST API (`/api/flags*`) and the Plan-2 SSE stream (`/api/flags/stream`), both already on `master`.

**Context — what's already on `master` you build on:**
- **REST (Plan 1):** `GET/POST /api/flags`, `GET /api/flags/summary`, `GET /api/flags/{id}`, `POST /api/flags/{id}/comments`, `POST /api/flags/{id}/assign`, `POST /api/flags/{id}/status`, `POST /api/flags/{id}/watchers`, `DELETE /api/flags/{id}/watchers/{user_id}`. Field shapes are in `backend/flags/schemas.py` — **read it and mirror the types exactly.**
- **SSE (Plan 2):** `GET /api/flags/stream` — see the LOCKED wire contract below.
- **Vite `/api` proxy** is on `master`: in a mounted stack the frontend reaches the backend at a **relative** base. Use the existing `getApiBaseUrl()` / `apiFetch` — do **not** hardcode hosts.

**House patterns to MIRROR (read these first):**
| Need | Use / mirror |
|---|---|
| Typed REST calls (bearer auth, base URL) | `src/lib/api.ts` → `apiFetch<T>(path, init)` |
| SSE client (fetch + `getReader` + bearer; NOT `EventSource`) | `src/lib/scale-stream.ts` (`useScaleStream`) |
| Entry button beside Worksheets | `WorksheetHeaderButton` in `src/components/layout/MainWindow.tsx` |
| Full-height right slide-over | `src/components/hplc/WorksheetDrawer.tsx` + `src/components/ui/sheet.tsx` |
| Flyout open/close state (Zustand) | `src/store/ui-store.ts` (`openWorksheetDrawer`) — **selector syntax, see below** |
| Server data | TanStack Query hooks in `src/hooks/` (e.g. `use-inbox-samples.ts`) |
| Toasts / native notifications | `src/lib/notifications.ts` (`notify`, `notifications.*`) |
| Visual target | `docs/superpowers/specs/assets/2026-06-27-flag-system/flag-thread-dark.html` (approved dark look) + `toolbar-badge.html`, `flyout-form.html`, `toast-animation.html` |

## Global Constraints

- **`npm` only.** State onion: `useState` → Zustand (global UI) → TanStack Query (server data). **Zustand selector syntax is enforced by ast-grep:** `const x = useUIStore(s => s.x)` — NEVER destructure `const { x } = useUIStore()`. Use `useStore.getState()` inside callbacks.
- **React Compiler** handles memoization — no manual `useMemo`/`useCallback` unless profiling says so.
- **i18n:** user-facing strings via `useTranslation()` + `/locales/*.json` (follow `docs/developer/i18n-patterns.md`). If full i18n is heavy for v1, at minimum keep strings centralized; do not block the feature on translations — note any gap.
- **Theme:** must work in light AND dark; dark is the validated look. Use theme tokens / existing shadcn components, not hardcoded colors (except where mirroring the mockup's type-pill accents).
- **Quality gate per task and at the end:** `npm run check:all` (typecheck + lint + ast:lint + format + rust + tests). A headless worker cannot see the UI — your gates are `check:all`, `npm run build`, and the targeted component tests below. **Visual fidelity is verified by the user against the running stack** (keep it up at the end).
- Tests with Vitest + Testing Library, mirroring `src/components/hplc/__tests__/WorksheetDrawer.test.tsx`.

---

## SSE Wire Contract (LOCKED — consume EXACTLY; produced by Plan 2)

- **Endpoint:** `GET /api/flags/stream` (relative; via the vite `/api` proxy).
- **Auth:** `Authorization: Bearer <jwt>` header. Use the `fetch` + `response.body.getReader()` pattern from `scale-stream.ts` — **native `EventSource` cannot send headers, do not use it.**
- **Frames:** SSE — optional `id: <n>`, then `event: <event_type>`, then `data: <json>`, blank-line terminated. Comment lines (`: keepalive`) are heartbeats — ignore them.
- **`event_type`** ∈ `raised | assigned | unassigned | commented | status_changed | watcher_added | watcher_removed`.
- **`data` JSON:** `{ event_type, flag_id, actor_id, from_value, to_value, details, event_id, flag }` where `flag` = `{ id, title, type, kind, status, entity_type, entity_id, assignee_id, created_by }` (post-mutation snapshot — enough to render a toast / update a card without a refetch).
- **Scoping:** the server **broadcasts every event to every connected user**. The **client decides relevance**: an event is "mine" if `flag.assignee_id === currentUserId || flag.created_by === currentUserId || (I am watching that flag)`. "Mine" + flyout/thread NOT showing it → toast + badge bump; otherwise update any open list/thread in place. (Don't assume server-side filtering — it's intentionally a future swap.)
- **Reconnect:** on stream end, reconnect with `Last-Event-ID: <event_id>` and exponential backoff (cap ~30s). **De-dupe by `event_id`** (server may replay).
- **Writes go through REST**, never the stream.

---

## File Structure

**Create:**
- `src/lib/flags-api.ts` — TS types (mirror `schemas.py`) + `apiFetch`-based functions for every endpoint.
- `src/hooks/use-flags.ts` — TanStack Query hooks (`useFlagSummary`, `useFlagsList(tab)`, `useFlag(id)`) + mutations (`useCreateFlag`, `useAddComment`, `useAssignFlag`, `useChangeStatus`, `useAddWatcher`, `useRemoveWatcher`) with query-key invalidation.
- `src/lib/flag-stream.ts` — `useFlagStream(onEvent)` SSE client (adapt `scale-stream.ts`): bearer fetch, frame parse, de-dupe by `event_id`, reconnect w/ `Last-Event-ID` + backoff.
- `src/components/flags/FlagsHeaderButton.tsx` — entry button (mirror `WorksheetHeaderButton`).
- `src/components/flags/FlagsFlyout.tsx` — slide-over (mirror `WorksheetDrawer`), 4 tabs + cards.
- `src/components/flags/FlagCard.tsx` — one flag row.
- `src/components/flags/FlagThread.tsx` — thread view (timeline + controls + composer).
- `src/components/flags/RaiseFlagButton.tsx` — compose popover usable from an entity row/page.
- `src/components/flags/flag-catalog.ts` — type→{label,color,kind} map mirroring `backend/flags/catalog.py` FLAG_TYPES (single source for pill colors).
- `src/components/flags/__tests__/…` — tests per the tasks below.

**Modify:**
- `src/store/ui-store.ts` — add `flagsFlyoutOpen`, `flagsThreadId`, `openFlagsFlyout(threadId?)`, `closeFlagsFlyout()`, `openFlagThread(id)` (+ test in `ui-store.test.ts`).
- `src/components/layout/MainWindow.tsx` — render `<FlagsHeaderButton/>` beside `WorksheetHeaderButton`, mount `<FlagsFlyout/>`, and start `useFlagStream(...)` at app scope.
- `/locales/en.json` (+ siblings if you translate) — flag strings.

---

### Task 1: REST data layer — `flags-api.ts` + `use-flags.ts`

**Files:** Create `src/lib/flags-api.ts`, `src/components/flags/flag-catalog.ts`, `src/hooks/use-flags.ts`, `src/hooks/__tests__/use-flags.test.tsx`.

- [ ] **Step 1:** In `flags-api.ts`, define TS interfaces mirroring `backend/flags/schemas.py` (`FlagResponse`, `FlagDetailResponse`, `CommentResponse`, `EventResponse`, `SummaryResponse`) and `FlagType`/`FlagStatus`/`FlagTab` string unions. Then one `apiFetch` function per endpoint, e.g.:
  ```ts
  export const listFlags = (tab: FlagTab, params?: {...}) =>
    apiFetch<FlagResponse[]>(`/api/flags?tab=${tab}${...}`)
  export const createFlag = (body: CreateFlagBody) =>
    apiFetch<FlagResponse>('/api/flags', { method: 'POST', body: JSON.stringify(body) })
  // …getFlag, addComment, assignFlag, changeStatus, addWatcher, removeWatcher, getSummary
  ```
- [ ] **Step 2:** `flag-catalog.ts` — export `FLAG_TYPES` `{ blocker:{label:'Blocker',color:'#e5484d',kind:'issue'}, critical:{…#e8730a}, question:{…#3b82f6}, waiting_on_customer:{…#8b5cf6}, ready_for_verification:{…#22c55e,kind:'signal'} }` (copy values from `backend/flags/catalog.py`). This is the single source for pill colors + labels.
- [ ] **Step 3:** `use-flags.ts` — TanStack Query hooks with stable keys (`['flags','summary']`, `['flags','list',tab,params]`, `['flags',id]`). Mutations invalidate the relevant keys on success (e.g. `addComment` → invalidate `['flags',id]`; `changeStatus`/`assign` → invalidate `['flags',id]` + `['flags','list']` + `['flags','summary']`).
- [ ] **Step 4: Test** (`use-flags.test.tsx`): render a hook with a `QueryClientProvider` + mocked `flags-api` and assert query keys + that a mutation invalidates summary/list. Keep it light — this guards key wiring, not the network.
- [ ] **Step 5:** `npm run check:all` green for these files. **Commit:** `feat(flags-ui): REST data layer — flags-api + use-flags query hooks`

---

### Task 2: UI store wiring

**Files:** Modify `src/store/ui-store.ts`; test in `src/store/ui-store.test.ts`.

- [ ] **Step 1: Test first** — add cases to `ui-store.test.ts`: default `flagsFlyoutOpen === false`; `openFlagsFlyout()` sets it true; `openFlagThread(7)` sets `flagsThreadId === 7` and opens the flyout; `closeFlagsFlyout()` resets both.
- [ ] **Step 2:** Add `flagsFlyoutOpen: boolean`, `flagsThreadId: number | null`, and actions `openFlagsFlyout(threadId?: number)`, `openFlagThread(id: number)`, `closeFlagsFlyout()`. Follow the existing `openWorksheetDrawer` shape exactly.
- [ ] **Step 3:** `npm run check:all`. **Commit:** `feat(flags-ui): ui-store flyout + thread open state`

---

### Task 3: SSE client hook — `flag-stream.ts`

**Files:** Create `src/lib/flag-stream.ts`, `src/lib/__tests__/flag-stream.test.ts`.

- [ ] **Step 1: Test first** — extract a pure `parseSseChunk(buffer)` (or `parseFrames`) helper and unit-test it: feed a string with two complete frames + a partial; assert it yields the two parsed `{event_type, data}` objects and returns the leftover partial. Also test de-dupe: feeding the same `event_id` twice yields one logical event.
- [ ] **Step 2:** Implement `useFlagStream(onEvent: (e: FlagStreamEvent) => void)` by adapting `scale-stream.ts`:
  - `fetch(`${getApiBaseUrl()}/api/flags/stream`, { headers: { Authorization: `Bearer ${getAuthToken()}` , ...(lastEventId ? {'Last-Event-ID': lastEventId} : {}) }, signal })`.
  - Read with `body.getReader()` + `TextDecoder`; parse frames; ignore `:`-comment lines; track the latest `event_id` (for reconnect) and a seen-set for de-dupe.
  - On stream end/error (not Abort): reconnect with exponential backoff (250ms → cap 30s) carrying `Last-Event-ID`.
  - Teardown via `AbortController` on unmount.
- [ ] **Step 3:** `npm run check:all`. **Commit:** `feat(flags-ui): SSE client hook (reconnect + de-dupe)`

---

### Task 4: Flags entry button — `FlagsHeaderButton`

**Files:** Create `src/components/flags/FlagsHeaderButton.tsx`; modify `MainWindow.tsx`.

- [ ] **Step 1:** Mirror `WorksheetHeaderButton`. Use `useFlagSummary()`; render **segmented color count chips** from `summary.by_type` (one small pill per non-zero type, colored from `flag-catalog`, e.g. `2 · 1 · 4`), label "Flags". `onClick` → `useUIStore.getState().openFlagsFlyout()`. See `toolbar-badge.html` for the look.
- [ ] **Step 2: Glow-on-new** — accept a `hasNew` signal (a small piece of state bumped by the SSE glue in Task 7 when a relevant event arrives while the flyout is closed); apply a pulse/glow class that clears when the flyout opens. (Glow tied to NEW, not always-on.)
- [ ] **Step 3:** In `MainWindow.tsx`, render `<FlagsHeaderButton/>` next to `<WorksheetHeaderButton/>`.
- [ ] **Step 4:** `npm run check:all`. **Commit:** `feat(flags-ui): Flags header button (segmented chips + glow)`

---

### Task 5: Flyout + flag cards — `FlagsFlyout` / `FlagCard`

**Files:** Create `FlagsFlyout.tsx`, `FlagCard.tsx`, `__tests__/FlagsFlyout.test.tsx`; mount `<FlagsFlyout/>` in `MainWindow.tsx`.

- [ ] **Step 1:** `FlagsFlyout` — full-height right slide-over mirroring `WorksheetDrawer` (use `ui/sheet.tsx`), open-state from `useUIStore(s => s.flagsFlyoutOpen)`. Tabs: **Assigned to me · Raised by me · Watching · All open** → `useFlagsList('assigned'|'raised'|'watching'|'all_open')`. When `flagsThreadId` is set, render `<FlagThread/>` instead of the list (Task 6).
- [ ] **Step 2:** `FlagCard` — entity chip (icon by `entity_type` + label; deep-link arrow), colored type pill (`flag-catalog`), title, assignee avatar (initials; "YOU" when it's the current user), comment count, relative time, blue unread dot. Clicking → `openFlagThread(flag.id)`.
- [ ] **Step 3: Test** — render `FlagsFlyout` with mocked `useFlagsList`; assert tab switching calls the right tab and cards render titles; clicking a card sets the thread id.
- [ ] **Step 4:** `npm run check:all`. **Commit:** `feat(flags-ui): flyout (4 tabs) + flag cards`

---

### Task 6: Thread view — `FlagThread`

**Files:** Create `FlagThread.tsx`, `__tests__/FlagThread.test.tsx`. Visual target: `flag-thread-dark.html`.

- [ ] **Step 1:** `useFlag(id)` for detail (`comments` + `events`). Layout per the mockup: breadcrumb (`← Flags / <tab>`), entity chip + deep-link + **Resolve** button, title + type pill, a controls row — **status** select (`open/in_progress/resolved/closed` → `useChangeStatus`), **assignee** select (`useAssignFlag`), **watchers** count (`useAddWatcher`/`useRemoveWatcher`).
- [ ] **Step 2: Timeline** — merge `events` (grey system/audit lines: "🚩 X raised this", "Assigned to Y", "Status → In progress") and `comments` (avatar + author + time + body) into one list ordered by `created_at`. Map `actor_id`/`author_id`/`assignee_id` to display names; a user lookup is fine (reuse any existing users hook, or show "User N" if none — note the gap).
- [ ] **Step 3: Composer** — input + send (Enter submits) → `useAddComment`; new comment **animates in** (the `.enter`→`requestAnimationFrame` slide+fade from the mockup). `@mention` affordance optional for v1 (note if deferred).
- [ ] **Step 4: Test** — render with a mocked `useFlag`; assert audit lines + comments interleave in time order and that submitting the composer calls `useAddComment`.
- [ ] **Step 5:** `npm run check:all`. **Commit:** `feat(flags-ui): flag thread (timeline + controls + composer)`

---

### Task 7: SSE glue, live updates, raise-flag, toast

**Files:** modify `MainWindow.tsx`; create `RaiseFlagButton.tsx`; small additions to the button/flyout for live state.

- [ ] **Step 1: Mount the stream** — call `useFlagStream(onFlagEvent)` once at app scope (`MainWindow`). `onFlagEvent`:
  - Always `queryClient.invalidateQueries({queryKey:['flags']})` (cheap; refreshes lists/summary/open thread → in-place updates).
  - Compute relevance (`flag.assignee_id === me || flag.created_by === me || watching`). If relevant **and** the flyout is closed (or showing a different flag): set the button's `hasNew` glow and fire a **toast** via `notifications`/`notify` (title from `event_type` + `flag.title`).
- [ ] **Step 2: Raise-flag** — `RaiseFlagButton` opens a small compose (type select, title, optional assignee, optional first comment) → `useCreateFlag`. Wire it into at least the **sub-sample / vial** surface (the primary flaggable entity); a generic prop-driven component so other entity pages can drop it in. Confirm the entity deep-link hash routes used in `backend/flags/seams.py` (`sub_sample → /#vials/{id}`, `sample → /#senaite/sample-details?id=`, `worksheet → /#worksheets/{id}`) match the real `useHashNavigation` routes; fix the few that are wrong (this was explicitly left for Plan 3).
- [ ] **Step 3: Toast fly-to-home (best-effort, may be visually refined with the user).** Per `toast-animation.html`: toast springs up, dwells ~1.75s, then flies into the Flags button which bumps/glows/increments. Include an **Undo** grace window on raise before it commits (optimistic). If the full animation is hard to land headless, ship the toast + glow + increment solidly and leave the fly path as a follow-up — **note exactly what you implemented vs deferred.**
- [ ] **Step 4:** `npm run check:all` + `npm run build`. **Commit:** `feat(flags-ui): live SSE glue + raise-flag + toast`

---

### Task 8: Full verification + in-stack visual prep

**Files:** none (verification).

- [ ] **Step 1:** `npm run check:all` and `npm run build` both green from a clean state. Fix anything red.
- [ ] **Step 2:** You are in a mounted stack (vite dev server with the `/api` proxy). Confirm the frontend compiles in-container and the app loads. Seed **one or two flags** via the REST API (curl `POST /api/flags` with a token, or through the UI if reachable) so the reviewer sees populated chips + a thread. Report the stack's Mk1 URL (your block's `…52` port) so the user can click through. **Leave the stack UP.**
- [ ] **Step 3:** Final report.

---

## Self-Review (fill in before the PR)

- **Spec §7 coverage:** Flags button (segmented chips + glow), flyout (4 tabs + cards), thread (interleaved timeline + composer + slide-in), raise compose, toast (+ fly-to-home best-effort), dark+light. Note anything deferred.
- **Contracts:** types mirror `schemas.py`; SSE consumed exactly per the LOCKED contract; relevance computed client-side; de-dupe by `event_id`.
- **Patterns honored:** Zustand selector syntax (ast-grep clean), TanStack Query for server data, `apiFetch`, mirrored `WorksheetDrawer`/`WorksheetHeaderButton`, npm only.

## PR

When tasks pass: `git push -u origin feat/flag-system-frontend`, then `gh pr create --base master --title "feat(flags): frontend (Plan 3) — button, flyout, thread, SSE live updates, toast" --body "<task-by-task summary + what's deferred + the stack URL to review>"`. If `gh` fails, push anyway and report.

**Final message must report:** per-task pass/fail, `npm run check:all` + `npm run build` results, full file list, the PR URL (or manual-needed), the **stack Mk1 URL + that it's seeded and UP for visual review**, and every deferral/deviation (especially anything in Task 7 Step 3) with why.
