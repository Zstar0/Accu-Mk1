# Flag System — At-a-Glance Indicators on Overview Surfaces (Phase 1, Plan 6)

> **For agentic workers:** execute task-by-task with TDD; one commit per task on `feat/flag-system-frontend`. You run IN the live, seeded `accumark-flagsfe` stack worktree — verify against it. **npm only, frontend-only plan.** Use `superpowers:frontend-design` for the compact visuals (match the existing chip/badge density).

**Goal:** Surface flags where users scan customer orders — the **Order Status page** (table + kanban) and **Customer detail** — with a small, colorized, always-clickable **FlagIndicator**. Flagged → a prominent colored flag + count (spot issues at a glance). Unflagged → a subtle flag that still opens the flyout so you can **raise** one from here. Order rows roll up flags across all their samples (+ vials).

**Approved design (2026-06-30):**
- **Frontend-only.** No backend change. Plan 4 already resolves each flag's parent `sample_id` (vials → parent) on the response, so a single `GET /api/flags?tab=all_open` fetch builds a page-wide map.
- **Identity:** `ExplorerOrder.sample_results[*].senaite_id` IS the human Sample ID = the `sample` flag `entity_id`. No id translation. Orders already embed their samples — no per-order query.
- **One shared query** (`useOpenFlagsBySample`) → `Map<sampleId, Rollup>`; every indicator reads the map (NOT a query per row). Colors come from **`useFlagTypesMap()`** (Plan 5 — managed catalog) so edited colors apply.
- **Always clickable:** colored flag + count when flagged; subtle/dim flag (brighten on hover) when not. Click → the flyout, scoped to that sample or that order, which **always offers "+ New flag"** (so a no-flag click can create one).
- **Order create** needs a **sample picker** (an order spans samples); single-sample create is prefilled.

**Context (read first):** `src/components/flags/{FlagsFlyout,RaiseFlagButton,EntityFlagButton,flag-catalog}.tsx/ts`, `src/hooks/use-flags.ts`, `src/services/flag-types.ts` (`useFlagTypesMap`), `src/store/ui-store.ts` (Plan-4 `flagsEntityFilter` + `openFlagsForEntity`). Mount targets: `src/components/explorer/OrderRow.tsx` (Order-ID cell ~:166-195, Sample Details cell ~:270-321), `src/components/explorer/SampleCard.tsx` (header row ~:110-122), `src/components/OrderStatusPage.tsx` (KanbanSampleCard ~:233-251; `ExplorerOrder` type at `src/lib/api.ts:812`). Visual precedents to match: `src/components/explorer/SampleSlaIndicator.tsx` (Tooltip + tiny chip), `helpers.tsx` `SampleStateBadge`/`AnalysisCounts`, the kanban `COL_PILL_CLASS` (`OrderStatusPage.tsx:108`).

## Global Constraints
- Additive, frontend-only. Reuse Plan 3/4/5 pieces; don't duplicate the raise compose — reuse `RaiseFlagButton`'s compose (extend it to accept a candidate-entity list for the order picker).
- Zustand selector syntax (ast-grep); TanStack Query; one shared flag query for the map (don't mount per-row `useEntityFlags`).
- Indicator colors via `useFlagTypesMap()` (includes inactive types — a deactivated type's open flags still color correctly).
- Gates (don't gate on full `check:all` — ~19 known pre-existing vitest fails): per task `npm run typecheck` clean, lint/ast/format clean for your files, new tests green; at end `npm run build`. Run in-container: `docker compose -p accumark-flagsfe exec -T accu-mk1-frontend sh -c "cd /app && npm run typecheck"`.

---

### Task 1: the shared rollup hook `useOpenFlagsBySample`

**Files:** create `src/hooks/use-open-flags-by-sample.ts` (or add to `use-flags.ts`); test `src/hooks/__tests__/use-open-flags-by-sample.test.tsx`.

- [ ] **Step 1 (test first):** given a mocked `all_open` list mixing `sample` flags and `sub_sample` flags (the latter carrying `entity.sample_id` of the parent), assert the hook returns a `Map<string, { count, flags, dominantType, dominantColor }>` keyed by sample id, where a vial flag is grouped under its parent `sample_id`, and `dominantType` is the most-severe open type (blocker>critical>waiting_on_customer>question>ready_for_verification). Provide a `rollupForSamples(map, ids[])` pure helper that merges several sample ids (for orders) → one aggregate rollup.
- [ ] **Step 2:** Implement: one query `useFlags({ tab: 'all_open' })` (reuse the existing list hook/key so SSE invalidation refreshes it). Build the map: for each open flag, key = `flag.entity.sample_id ?? (flag.entity_type === 'sample' ? flag.entity_id : null)`; skip null (e.g. worksheet flags don't roll into a sample). Resolve `dominantColor` via `useFlagTypesMap()`. Export `useOpenFlagsBySample()` returning `{ map, rollupForSamples }` and the `Rollup` type.
- [ ] **Step 3:** green. **Commit:** `feat(flags-ui): useOpenFlagsBySample — page-wide flag rollup from one query`

### Task 2: the `FlagIndicator` component

**Files:** create `src/components/flags/FlagIndicator.tsx` + `__tests__/FlagIndicator.test.tsx`.

- [ ] **Step 1 (test first):** render with a rollup of (a) zero flags → a subtle/dim flag button (still clickable, opens the scoped flyout), (b) some flags → a colored flag + count, color = dominant. Clicking calls the scope's open action (mock ui-store).
- [ ] **Step 2:** Implement `<FlagIndicator scope={ kind:'sample', sampleId } | { kind:'order', orderId, sampleIds, label } variant?: 'pill'|'glyph' />`:
  - Reads `useOpenFlagsBySample()`; computes the rollup (single sample, or `rollupForSamples(sampleIds)` for an order).
  - **Flagged:** a small colored flag (`Flag fill=currentColor`, `h-3.5 w-3.5`, color = `dominantColor`) + a tiny count when >1, matching `COL_PILL_CLASS`/`SampleSlaIndicator` density. Wrap in the `Tooltip` pattern (a short breakdown: "2 blockers · 1 question" or, for orders, "3 flags across 2 samples").
  - **Unflagged:** a dim `Flag` (`text-muted-foreground/40`, brightens to `/80` on hover), same hit target.
  - **Click:** sample scope → `useUIStore.getState().openFlagsForEntity('sample', sampleId, { includeDescendants: true })`; order scope → `openFlagsForSamples(label, sampleIds)` (Task 3). Keep it a real `<button>` (a11y).
- [ ] **Step 3:** green. **Commit:** `feat(flags-ui): FlagIndicator — compact colorized at-a-glance flag affordance`

### Task 3: scoped flyout + "+ New flag" (incl. order sample-picker)

**Files:** `src/store/ui-store.ts` (+test), `src/components/flags/FlagsFlyout.tsx`, `src/components/flags/RaiseFlagButton.tsx`.

- [ ] **Step 1 (test first):** ui-store — `openFlagsForSamples(label, sampleIds)` sets a `flagsSamplesFilter = { label, sampleIds }` and opens the flyout; `closeFlagsFlyout` clears it; it's mutually exclusive with the single-entity `flagsEntityFilter`.
- [ ] **Step 2:** ui-store: add `flagsSamplesFilter: { label: string; sampleIds: string[] } | null` + `openFlagsForSamples`. (Keep Plan-4 `flagsEntityFilter` for single-entity scope.)
- [ ] **Step 3:** `FlagsFlyout`:
  - When `flagsSamplesFilter` is set: header chip "Flags · {label} ✕"; list the open flags whose `entity.sample_id ∈ sampleIds` (filter the `all_open` data client-side, or reuse the rollup); a "clear" returns to tabs.
  - In BOTH scoped modes (single entity AND samples), and especially when the scoped list is **empty**, show a prominent **"+ New flag"** affordance (empty state reads "No flags on {label} yet — raise one").
  - "+ New flag" opens the raise compose: single-entity scope → prefilled `entityType`/`entityId`; samples scope → pass the candidate samples to the compose's picker (Step 4).
- [ ] **Step 4:** `RaiseFlagButton` (the compose): add an optional `candidates?: { entityType: string; entityId: string; label: string }[]` prop. When provided (order scope) and >1, the compose first shows a **"Which sample?"** select; with exactly one (or a prefilled entity) it skips straight to type/title/assignee/first-comment. Default behavior (existing single-entity callers) unchanged.
- [ ] **Step 5:** typecheck + tests green. **Commit:** `feat(flags-ui): order/sample-scoped flyout + create-from-flyout (sample picker)`

### Task 4: mount the indicator on the three surfaces

**Files:** `src/components/explorer/OrderRow.tsx`, `src/components/explorer/SampleCard.tsx`, `src/components/OrderStatusPage.tsx`.

- [ ] **Step 1: Order Status table (order rollup).** In `OrderRow.tsx` Order-ID cell (~:193, after the order `<a>`), mount `<FlagIndicator scope={{ kind:'order', orderId: order.order_id, sampleIds, label: '#'+order.order_number }} />` where `sampleIds = Object.values(order.sample_results ?? {}).filter(s => s.status !== 'failed').map(s => s.senaite_id)`. (This row also renders in **Customer detail** via the same `OrderRow` — covered automatically.)
- [ ] **Step 2: per-sample on the SampleCard.** In `SampleCard.tsx` header (~:119, by the `AlertTriangle`), mount `<FlagIndicator scope={{ kind:'sample', sampleId: <the card's senaite_id> }} />` so the Sample Details cell shows which specific sample is flagged.
- [ ] **Step 3: kanban card.** In `OrderStatusPage.tsx` `KanbanSampleCard` row 1 (~:241), mount `<FlagIndicator scope={{ kind:'sample', sampleId: item.sampleId }} />` next to the sample id button. (Optionally the grouped-swimlane order header ~:458 gets an order-scope indicator — do it if cheap.)
- [ ] **Step 4:** typecheck + `npm run build` green. **Commit:** `feat(flags-ui): mount FlagIndicator on order table, kanban, sample cards`

### Task 5: verification + live stack

- [ ] **Step 1:** all gates (typecheck, lint/ast/format on your files, new vitest, `npm run build`). Diff vs HEAD if unsure a failure is pre-existing.
- [ ] **Step 2:** In the live stack, open the Order Status page: confirm an order containing the seeded flagged sample shows a **colored** flag in its Order-ID cell, an unflagged order shows the subtle flag, both kanban + table; clicking a flagged one opens the scoped flyout listing those flags; clicking an unflagged one opens the flyout with a working **"+ New flag"** (order → sample picker). Verify Customer detail shows the same. Re-seed if data thinned. **Leave the stack UP.**
- [ ] **Step 3:** `git push` (updates PR #28). Final report: per-task results, gates, files, the exact mount lines used, and any deviations.

## Self-Review
- One shared query for the whole page (no per-row query storm). ✓
- Colors via `useFlagTypesMap()` (managed + inactive-inclusive). ✓
- Always clickable; unflagged click → create from flyout; order create has a sample picker. ✓
- Single `OrderRow` mount covers Order Status table + Customer detail. ✓
- Frontend-only; reuses Plan 3/4/5 flyout + compose + rollup. ✓
