# Vial Status Board — Design

- **Date:** 2026-08-31
- **Status:** Approved design, pre-implementation
- **Branch:** `feat/vial-status-board` (off `origin/master` @ `bdbcd352`)
- **UI mockups:** https://claude.ai/code/artifact/f091ce31-aa33-4cb4-be9e-f85f6ca18609
- **Route:** `#accumark-tools/vial-status`

## 1. Purpose

A department-level status page answering one question: **where is every open vial right now?** It clones the Order Status page's shell — search, filters, kanban ⇄ table toggle, localStorage persistence — but operates on sub-samples (`lims_sub_samples`) and their analysis stages, and adds what Order Status cannot show: the assigned tech and the worksheet. The audience is lab techs and supervisors working a department queue.

## 2. Locked decisions

| Decision | Choice |
|---|---|
| Stage placement | **Multi-column, Order Status pattern** — a vial card appears in every kanban column where it has ≥1 analysis in that state, with a count pill. Column counts count cards, so a split vial is counted in both columns. |
| Interactivity | **Read-only v1.** Cards click through to sample details. Stage changes stay in worksheets/verify flows. |
| Table view | **The tech's matrix concept** — rows = parent samples, one status column per catalog role in the selected department, plus Overall / Tech / Worksheet / Received. |
| Placement | **AccuMark Tools** section, sidebar entry next to Order Status. |
| Card style | **Compact vial chips** (assignment-page style: ID + mini role badge) with a micro meta row; analysis names behind a "Show analyses" toggle. |
| Data | **New read-only board endpoint** in `backend/sub_samples/` (approach A). No changes to the inbox endpoint. |

## 3. Codebase facts this design rests on (verified on `origin/master`)

1. **A vial has no stage column.** `lims_sub_samples` (`backend/models.py:905-931`) carries `sample_id`, `assignment_role`, `received_at`, `external_lims_uid` — no status, no analyst, no worksheet FK. A vial's stage is derived from its `lims_analyses.review_state` rows.
2. **Stage truth is the pure state machine** (`backend/lims_analyses/state_machine.py`, "No DB, no I/O") plus a DB CHECK on `lims_analyses.review_state`. Vial-tier lifecycle: `unassigned → assigned → to_be_verified → promoted`, plus `variance_verified`, `rejected`, `retracted`. Vial-tier rows never reach `verified`/`published` (parent-tier only).
3. **The workflow graph is shadow-only.** The Preferences → Workflow catalog (`lims_workflow_states` / `lims_workflow_transitions`) feeds the side-by-side engine (`backend/workflow/engine.py`), which observes and reports divergence but gates nothing until the authority swap. The board must NOT read it for truth in v1.
4. **Analyst is derived from worksheet membership.** `Worksheet.assigned_analyst_id or WorksheetItem.assigned_analyst_id` is stamped onto live vial-tier `lims_analyses.analyst_user_id` (`backend/lims_analyses/worksheet_analyst.py`), excluding `retracted`/`rejected` rows. The board displays it, never sets it.
5. **Worksheet linkage is a string match:** `WorksheetItem.sample_uid == LimsSubSample.external_lims_uid`. Worksheet "number" is the mutable `title` (`WS-YYYY-MM-DD-NNN` at generation).
6. **Departments and sub-chips are catalog-driven.** `GET /worksheets/inbox/lanes` (`backend/main.py:20091`, `backend/catalog/roles.py::inbox_lanes`) returns one lane per department owning ≥1 vial role; sub-chips are the lane's role codes. `xtra` (NULL department) is the reserved unassigned bucket, gated by a show-xtra toggle. The board reuses this endpoint — zero hardcoded departments.
7. **No cross-order vial endpoint exists.** `/worksheets/inbox` is eligibility-filtered (excludes worksheet-claimed vials — precisely the board's Assigned column) and `/api/sub-samples` is per-parent. Hence the new endpoint.

## 4. Backend — `GET /api/sub-samples/board`

Lives in the existing package: route in `backend/sub_samples/routes.py`, logic in `service.py`, response models in `schemas.py`. Auth via the standard `get_current_user` dependency. `async def`, read-only.

### Query params

| Param | Default | Meaning |
|---|---|---|
| `hide_test_orders` | `true` | Server-side exclusion of test-order parents (same rule the inbox uses). |
| `show_xtra` | `false` | Include `xtra`-role vials. |
| `lane` | absent | Optional lane key; server filters to that lane's role codes via the catalog. v1 frontend does not send it (filters client-side); it exists so scale never forces an API change. Unknown key → 400, matching the inbox's validation. |

### Inclusion rule

A vial is on the board while it has **≥1 vial-tier analysis in `unassigned`, `assigned`, or `to_be_verified`**. For included vials the response carries **all** their vial-tier analyses (including `promoted`, `variance_verified`, `rejected`, `retracted`), so the terminal columns render a vial's whole story while it is still in flight. Fully-promoted vials drop off the board (see Q1, §9). Vials whose only analyses are `retracted` are excluded. No parent-state filter: inclusion is driven entirely by analysis states (a cancelled order's analyses leave the live set and the vial drops off naturally).

### Response shape

```jsonc
{
  "total": 34,
  "vials": [
    {
      "id": 812,
      "sample_id": "PB-0463-S02",
      "external_lims_uid": "mk1://...",
      "assignment_role": "endo",
      "received_at": "2026-08-27T14:02:00Z",
      "parent": {
        "id": 401,
        "sample_id": "PB-0463",
        "label": "Semaglutide 5 mg",        // same display fields the inbox's parent summary exposes
        "priority": "high",                  // from sample_priorities
        "is_test_order": false
      },
      "analyses": [
        {
          "id": 9001,
          "title": "ENDO-LAL Endotoxin",     // display name, same formatting source as the inbox
          "review_state": "to_be_verified",
          "analyst_user_id": 7,
          "analyst_name": "J. Chen"          // users_display rule
        }
      ],
      "worksheet": { "id": 55, "title": "WS-2026-08-29-043", "status": "open" }  // or null
    }
  ]
}
```

### Query strategy (no N+1)

Five bulk queries: (1) candidate vials + parents via a join on live vial-tier analyses; (2) all vial-tier analyses for those vial PKs; (3) open worksheets claiming those `external_lims_uid`s (`WorksheetItem` join `Worksheet` where `status = 'open'`; if a vial appears on multiple open worksheets, take the most recent `added_at`); (4) users for analyst display names; (5) priorities. Assemble in Python. No server cache (mk1-native reads; the inbox's 30-min cache exists for its SENAITE source only). Include `total`; if the live set ever exceeds 2,000 vials, log a warning — never silently truncate.

## 5. Frontend

### Files

```
src/components/vial-board/VialStatusPage.tsx    // page shell: chips, filters, view toggle
src/components/vial-board/VialBoardKanban.tsx   // kanban view
src/components/vial-board/VialBoardMatrix.tsx   // matrix table view
src/lib/vial-board.ts                           // pure helpers: placement, counts, matrix aggregation, column config
src/lib/api.ts                                  // + getVialBoard() + types
```

OrderStatusPage's 1,300-line monolith is the anti-precedent; helpers stay pure so they unit-test like `inbox-filters.ts`.

### Registration

1. `src/store/ui-store.ts` — add `'vial-status'` to the AccuMark Tools sub-section union.
2. `src/components/AccuMarkTools.tsx` — `case 'vial-status'` → `<VialStatusPage/>`.
3. `src/components/layout/AppSidebar.tsx` — SubItem "Vial Status" next to Order Status.

No `hash-navigation.ts` change (existing `accumark-tools` section).

### Data & chips

- `getVialBoard()` via React Query, `refetchInterval: 30_000` (inbox parity), manual Refresh button.
- Department chips from the existing `useInboxLanes` hook; sub-chips from the lane's `role_codes` labeled via the vial-roles catalog hook; chip colors via the existing `ROLE_COLOR_BADGE` / `laneBadgeClass` pattern. Counts computed client-side from board rows.
- Lane persistence: `localStorage['accu_mk1_vial_board_lane']`, validated against the fetched lane set exactly like the inbox (a stale admin-deleted key must never 400). Sub-role selection is transient and resets on lane change (inbox precedent).

### Filters (persisted as `vial-board-filters`, Order Status pattern)

`activeStages[]`, vial/sample ID search, analyte text (matches analysis titles), tech (dropdown from `getWorksheetUsers`), worksheet (dropdown of open worksheet titles present in the data), `hideTestOrders` (default on), `showXtra` (default off), `showAnalyses` (default off), `collapsedCols[]` (default `['rejected']`), `viewMode` (`'kanban' | 'table'`), `groupBySample`, sort key + direction.

### Kanban view

- **Columns** (single source: `VIAL_STAGE_COLUMNS` in `vial-board.ts`): `unassigned`, `assigned`, `to_be_verified`, `promoted`, `variance_verified`, `rejected`. Labels and tints reuse `AnalysisTable.tsx`'s `STATUS_LABELS` / `STATUS_COLORS`. `retracted` rows never place cards (mirrors the analyst-stamping exclusion). Columns are collapsible; Rejected starts collapsed.
- **Placement:** card in column *C* iff ≥1 analysis has `review_state === C`; count pill = matching count, tinted with the column color. A vial placed in >1 column gets a subtle split-vial outline on all its cards.
- **Card (compact chip):** row 1 — mono vial ID, role mini-badge, priority marker, count pill; row 2 — analyst avatar + name, worksheet title chip, age since `received_at`. Unassigned column shows "no worksheet yet". With `showAnalyses` on, a third line lists the matching analysis titles; hover tooltip shows them regardless.
- **Grouping:** flat columns, or swimlane per parent sample (`groupBySample`, mirroring Order Status's `groupByOrder`).
- **Click:** the whole card navigates to the parent's sample details (existing `navigateTo` helper). Vial-level anchoring only if the details page already supports it — no new anchor plumbing in v1.

### Matrix view

- **Rows:** parent samples of the vials passing the current lane + filters.
- **Columns:** the selected lane's catalog roles (Analytical → HPLC / Heavy Metals / …; Microbiology → Endotoxin / Sterility / …). Switching lanes swaps columns; new catalog role → new column, no code change. Then: Overall, Tech, Worksheet, Received.
- **Cell status** for (parent, role), over all vial-tier analyses on that parent's vials with that role (`retracted` rows ignored, as in the kanban):
  - no analyses for the role → **"— not ordered"** (visually distinct from Not Started, so an empty cell never reads as forgotten work)
  - any `rejected` → **Rejected**
  - else all in `promoted`/`variance_verified` → **Complete**
  - else any `assigned`/`to_be_verified` → **In Progress**, sub-line `n/m promoted` (or `n/m submitted` when nothing is promoted yet)
  - else → **Not Started**
  - Sub-lines are counts only in v1 — per-analysis completion *dates* need a reliable timestamp and are deferred (the mockup's dates are illustrative).
- **Overall** (worst-of): any Rejected → **Issue**; else any ordered role not Complete → **In Progress**; else **Complete**.
- **Tech:** distinct analysts across the row's live analyses (show 2, then "+n"). **Worksheet:** distinct open worksheet chips. **Received:** earliest vial `received_at`.

### Stage truth & forward-compat

Column list, order, labels are defined once in `VIAL_STAGE_COLUMNS`. When the workflow catalog becomes authoritative (post authority-swap), that constant can flip to a catalog read (`label` / `category` / `sort_order` already exist on `lims_workflow_states`) without touching either view.

## 6. Error handling & edge cases

- Lanes or board fetch failure → error panel with Retry (existing pattern); never render half a board.
- Empty lane/filter result → friendly empty state naming the active filters.
- Stored lane key no longer in the lane set → fall back to first lane (inbox precedent).
- Vial with a NULL `assignment_role` (auto-assign not run) → excluded by the server, matching the inbox. `show_xtra` gates only the literal `xtra` role code (the reserved unassigned bucket) — the two are different things.
- Multiple open worksheets for one vial → most recent `added_at` wins (documented in the endpoint docstring).
- `variance_verified` analyses count as complete for matrix aggregation and render in their own kanban column.

## 7. Testing

**Backend** — `backend/tests/test_sub_samples_board.py`:
mixed-state vial appears with full analysis list; fully-promoted vial excluded; retracted-only vial excluded; `hide_test_orders` and `show_xtra` gating; `lane` filter + unknown-lane 400; worksheet join picks the open, most recent worksheet and ignores completed/staging; analyst names follow the display rule; a vial on no worksheet returns `worksheet: null`.

**Frontend** — `src/lib/__tests__/vial-board.test.ts`:
placement rule (multi-column + counts + retracted ignored); split-vial detection; matrix cell aggregation incl. not-ordered vs not-started and the rejected/complete/in-progress ladder; overall worst-of; filter application (stage toggles, tech, worksheet, analyte).

Gate: `npm run check:all` (frontend) and `pytest` (backend) green before merge.

## 8. Out of scope (v1)

- Drag-to-advance stage transitions.
- A "recently completed" shelf for fully-promoted vials (needs a completion timestamp — candidate source: `lims_sub_sample_events`).
- Per-vial rows in the matrix (rows stay at parent-sample level).
- Catalog-driven kanban columns (blocked on the workflow authority swap).
- Completion dates in matrix cells.
- Worksheet chip as a separate deep-link click target.
- One-tap "My vials" shortcut (tech filter dropdown covers it).

## 9. Open questions — defaults chosen, cheap to flip

| # | Question | v1 default |
|---|---|---|
| Q1 | Should fully-promoted vials linger before leaving the board? | They leave immediately; lingering is the "recently completed" follow-up. |
| Q2 | Worksheet chip as its own click target? | No — one click target per card (sample details). |
| Q3 | Rejected column collapsed by default? | Yes, collapsed (persisted per user once touched). |
| Q4 | "My vials" one-tap shortcut? | No — tech dropdown only. |

## 10. Non-goals & guarantees

Additive only: no changes to `/worksheets/inbox`, worksheets endpoints, the state machine, or the workflow shadow engine. No new tables, no migrations. Frontend stays npm-only. The board writes nothing.
