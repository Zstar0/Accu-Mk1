# Flag System — Flyout List/Table View Toggle + Aligned Columns (Phase 1, Plan 8)

> **For agentic workers:** frontend-only, TDD, one commit per task on `feat/flag-system-frontend`. Run IN the live `accumark-flagsfe` stack worktree; verify there. npm only. Use `superpowers:frontend-design`.

**Goal:** Give the flag flyout two display styles the user toggles between: (1) the **stacked list** (the pre-Plan-7 cards) and (2) an **aligned-columns table** (so the columns actually line up, unlike the current free-flow one-line rows). A persisted toggle in the header top-right switches them. Filters/search/width apply to both.

**Design (approved 2026-06-30):**
- **View toggle:** a compact segmented control (a list icon + a table/columns icon, `lucide` `List` / `Table2` or `Columns3`) in the flyout header, top-right (near "Add Flag"). State is `'list' | 'table'`, **persisted to `localStorage`** (key `flags:viewMode`, default `'table'`) so the choice sticks across sessions.
- **List view** = the stacked `FlagCard` that existed BEFORE Plan 7's one-line rebuild. **Recover it from git:** `git show 65c9e92:src/components/flags/FlagCard.tsx` is the stacked version (Plan-7 commit `c267104` replaced it). Restore that layout as the list renderer.
- **Table view** = a real aligned grid so columns line up regardless of chip/pill width. Use ONE shared column template for a header row + every data row — either a semantic `<table className="table-fixed w-full">` with a `<colgroup>`, or CSS grid rows that all share the SAME **fixed-width** `grid-template-columns` (fixed px / `minmax`, NOT `auto` — content-sized columns won't align across separate rows). Columns: **Entity · Type · Title · Sample/context · Assignee · Status · Age**. Title takes the flex space (`minmax(0,1fr)`); all other columns fixed-width; every cell truncates; nothing wraps. Include a subtle header row with column labels.
- **Flyout stays 880px wide for both** views (no resize on toggle). Filters + search (Plan 7) apply to both. The empty/"no matching" states work in both.

**Context (read first):** `src/components/flags/FlagsFlyout.tsx` (header ~:143-169, list render ~:172+, the filtered `flags` array, Plan-7 filter bar), `src/components/flags/FlagCard.tsx` (current one-line row — becomes the basis for the table ROW; the stacked list version is in git at `65c9e92`), `src/components/flags/flag-status.ts` (`STATUS_LABELS`/`STATUS_DOT`), `src/components/flags/flag-entity.ts`, `src/components/flags/flag-format.ts` (`relativeTime`), `src/lib/flags-api.ts` (`FlagResponse`). shadcn: `@/components/ui/{button,badge,tabs,table?}`.

## Global Constraints
- Frontend-only, additive; no API change. Zustand selector syntax. Reuse existing pieces.
- Both views must keep: row click → `openFlagThread`, entity-chip click → `navigateToEntity` (stopPropagation), the type color + status badge, and work in dark + light.
- Gates (don't gate on full `check:all` — ~19 known pre-existing vitest fails): per task `npm run typecheck` clean, lint/ast/format clean for your files, new tests green; at end `npm run build`. In-container: `docker compose -p accumark-flagsfe exec -T accu-mk1-frontend sh -c "cd /app && npm run typecheck"`.

---

### Task 1: persisted view toggle + restore the stacked list view

**Files:** create `src/components/flags/use-flag-view-mode.ts` (localStorage-backed `['list'|'table', setter]`) + test; `src/components/flags/FlagCard.tsx` (support BOTH layouts, or split into `FlagCard` = stacked + keep the row for Task 2); `src/components/flags/FlagsFlyout.tsx` (toggle UI + branch).

- [ ] **Step 1 (test first):** `useFlagViewMode` — defaults to `'table'` when localStorage is empty; persists a set value; reads it back. (Guard SSR/no-window.)
- [ ] **Step 2:** Restore the stacked card layout from `git show 65c9e92:src/components/flags/FlagCard.tsx` as the LIST renderer (keep the current one-line body available for Task 2's table row — e.g. rename the current one to `FlagTableRow` or keep both layouts behind a prop). Preserve click-to-thread + entity deep-link + the status badge.
- [ ] **Step 3:** `FlagsFlyout`: add the segmented toggle (List / Table icons, `aria-pressed`) in the header top-right; wire `useFlagViewMode`; in the list container, branch: `mode === 'list'` → stacked `FlagCard`s; `mode === 'table'` → Task-2 table (stub for now, e.g. still render rows). Both consume the same filtered `flags`.
- [ ] **Step 4:** typecheck + tests green. **Commit:** `feat(flags-ui): flyout list/table view toggle (persisted) + restore stacked list`

### Task 2: the aligned-columns table view

**Files:** create `src/components/flags/FlagTable.tsx` (+ `FlagTableRow` if not reused) + test; wire into `FlagsFlyout`.

- [ ] **Step 1:** `FlagTable` renders a header row + one row per flag, ALL sharing the same fixed column template so columns align. Suggested template: `Entity 150px · Type 130px · Title minmax(0,1fr) · Sample/context 170px · Assignee 150px · Status 120px · Age 52px` (tune to taste; keep title as the only flexible column). Each cell truncates (`truncate min-w-0`). Header labels muted/small; sticky under the filter bar if easy.
- [ ] **Step 2:** Row content per column: entity chip (icon+label, deep-link arrow), type pill (color from the managed catalog via the existing `flagTypeDef`/`useFlagTypesMap` path already in FlagCard), title (truncate), `entity.sample_id · analyses` context (muted, truncate), assignee (avatar + name, truncate), status badge (dot+label from `flag-status`), relative age. Row click → `openFlagThread`; entity chip → `navigateToEntity` (stopPropagation). Keep the left type-color accent bar.
- [ ] **Step 3:** Wire into `FlagsFlyout` for `mode === 'table'`. Verify the empty + "no matching filters" states render sensibly in table mode (e.g. header hidden or a single empty message).
- [ ] **Step 4:** typecheck + `npm run build` + tests green. **Commit:** `feat(flags-ui): aligned-columns table view for the flyout`

### Task 3: verification + live stack

- [ ] **Step 1:** all gates (typecheck, lint/ast/format on your files, new vitest, `npm run build`).
- [ ] **Step 2:** In the live stack: the header toggle switches between the stacked list and the table; in table mode the **columns line up** across rows regardless of chip/pill length (verify with the varied seeded data — BW-0010, Vial 90001, PB-0071-S01, Worksheet 6, etc.); the choice persists across a reload; filters/search still work in both modes. **Leave the stack UP.**
- [ ] **Step 3:** `git push` (updates PR #28). Final report: per-task results, gates, files, the final column template used, and any deviations.

## Self-Review
- Toggle persisted; list = restored stacked; table = shared fixed-column grid (aligned). ✓
- Both views keep click-to-thread + deep-link + status/type colors; filters apply to both. ✓
- Wide (880px) for both; no resize on toggle. ✓
