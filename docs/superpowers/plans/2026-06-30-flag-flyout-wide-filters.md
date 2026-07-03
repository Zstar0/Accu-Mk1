# Flag System — Wide Flyout + Filters/Search (Phase 1, Plan 7)

> **For agentic workers:** frontend-only, TDD, one commit per task on `feat/flag-system-frontend`. Run IN the live `accumark-flagsfe` stack worktree; verify there. npm only. Use `superpowers:frontend-design` for the dense layout (match the app's dark look + shadcn tokens).

**Goal:** Turn the flag flyout into a real triage surface: **~2× wider**, flag rows laid out **cleanly on one line**, and a **filter/search bar** — free-text search (title + Sample ID), filter by **status**, filter by **entity type**. Applies to every tab (esp. Watching / All open) and the scoped views.

**Design (approved 2026-06-30):**
- Widen the flyout `SheetContent` from `w-[440px]` to roughly **double** (~`880px`, responsive: `w-[880px] max-w-[92vw] sm:max-w-[880px]`).
- **One-line flag rows:** a dense single-row `FlagCard` layout — `[type color bar] · [entity chip → link] · [type pill] · [title, flex-1 truncate] · [Sample ID + analytes, muted, truncate] · [assignee avatar] · [status badge] · [relative time]`. Everything on one row; the title takes the flex space and truncates. Keep click-to-open-thread + the entity-chip deep link.
- **Filter bar** (sticky, between the tabs/header and the list): a search `Input` (placeholder "Search title or Sample ID…") + a **Status** `Select` (All · Open · In progress · Blocked · Resolved · Closed) + an **Entity** `Select` (All · Sample · Vial · Worksheet). Client-side filtering over the already-fetched list — no new API. Show a small result count and a "No matching flags" empty state when filters exclude everything.
- Filters are **local flyout state** (ephemeral; reset when the flyout closes). They layer on top of whatever the current tab/scope returns.

**Context (read first):** `src/components/flags/FlagsFlyout.tsx` (Sheet width `:96`; header/tabs `:143-169`; list `:172+`; the `flags` array it maps), `src/components/flags/FlagCard.tsx` (current stacked layout — you add the one-line variant), `src/components/flags/flag-entity.ts` (`entityMeta`/label/`navigateToEntity`), `src/lib/flags-api.ts` (`FlagResponse` shape incl. `entity.{sample_id,analyses,label}`), `src/components/flags/FlagThread.tsx` (`STATUS_LABELS`/`STATUS_DOT` for status labels/colors). Use `@/components/ui/{input,select,badge}`.

## Global Constraints
- Frontend-only, additive; no API change. Zustand selector syntax; reuse existing components.
- Gates (don't gate on full `check:all` — ~19 known pre-existing vitest fails): per task `npm run typecheck` clean, lint/ast/format clean for your files, new tests green; at end `npm run build`. Run in-container: `docker compose -p accumark-flagsfe exec -T accu-mk1-frontend sh -c "cd /app && npm run typecheck"`.

---

### Task 1: filter bar + client filtering

**Files:** create `src/components/flags/FlagsFilterBar.tsx` + a pure `filterFlags(flags, { text, status, entityType })` helper (co-locate or in `flag-format`/a new `flag-filter.ts`); modify `FlagsFlyout.tsx`; tests for the predicate.

- [ ] **Step 1 (test first):** `filterFlags` — text matches case-insensitively against `title` OR the sample id (`entity?.sample_id ?? entity?.label ?? entity_id`); `status` filters by `flag.status` (or 'all'); `entityType` filters by `flag.entity_type` (or 'all'); empty filters → unchanged list. Test a few combinations.
- [ ] **Step 2:** `FlagsFilterBar` — controlled: `{ text, status, entityType, onChange }`. A search `Input` (with a leading search icon) + Status `Select` (All + the 5 statuses, labels/dots from `STATUS_LABELS`/`STATUS_DOT`) + Entity `Select` (All + Sample/Vial/Worksheet). Compact row, sticky under the tabs.
- [ ] **Step 3:** Wire into `FlagsFlyout`: local state `{ text:'', status:'all', entityType:'all' }` (reset on close via the existing close path); render `<FlagsFilterBar>` under the header/tabs (both the tabbed and scoped views); apply `filterFlags` to the `flags` array before mapping. Show a result count (`{n} of {total}`) and a "No matching flags — adjust filters" empty state distinct from the true-empty state.
- [ ] **Step 4:** typecheck + tests green. **Commit:** `feat(flags-ui): flyout filter bar — search + status + entity filters`

### Task 2: wide flyout + one-line flag rows

**Files:** `src/components/flags/FlagsFlyout.tsx` (Sheet width), `src/components/flags/FlagCard.tsx`; update `__tests__/FlagsFlyout.test.tsx` if it asserts width/layout.

- [ ] **Step 1:** Widen `SheetContent` (`:96`) to `w-[880px] max-w-[92vw] sm:max-w-[880px]`.
- [ ] **Step 2:** Give `FlagCard` a one-line row layout (make it the layout used by the flyout — a `dense`/row variant is fine, or just restructure since FlagCard is flyout-only): a single flex row, `[3px color bar] [entity chip w/ deep-link] [type pill] [title flex-1 truncate] [Sample ID · analytes, muted, hidden on very narrow] [assignee avatar+name] [status badge] [relative time]`. Preserve: row click → `openFlagThread`; entity-chip click → `navigateToEntity` (stopPropagation); the unread dot if present. Keep it readable in dark + light.
- [ ] **Step 3:** typecheck + `npm run build` + tests green. **Commit:** `feat(flags-ui): wider flyout + one-line flag rows`

### Task 3: verification + live stack

- [ ] **Step 1:** all gates (typecheck, lint/ast/format on your files, new vitest, `npm run build`). Diff vs HEAD if unsure a failure is pre-existing.
- [ ] **Step 2:** In the live stack open the flyout (it's ~2× wide): rows sit cleanly on one line; on **All open**/**Watching** try the search (by title and by Sample ID), the status filter, and the entity filter — confirm the list narrows and the count updates; scoped views (click an indicator) also show the bar. Re-seed a flag or two if the list is thin. **Leave the stack UP.**
- [ ] **Step 3:** `git push` (updates PR #28). Final report: per-task results, gates, files, and any deviations (esp. anything that didn't fit cleanly on one line and how you handled it).

## Self-Review
- Wide + one-line + filters on all tabs and scoped views. ✓
- Client-side filtering, no API change. ✓
- Filters ephemeral (reset on close). ✓
- Row keeps click-to-thread + entity deep-link. ✓
