# Phase 18: Worksheets List - Context

**Gathered:** 2026-04-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Users can view all worksheets at a glance with KPI totals and per-worksheet summary stats, filter by status or analyst, and click any row to open that worksheet's detail view in the floating clipboard drawer. This is a read-only list page — all editing happens in the worksheet detail drawer (Phase 17).

</domain>

<decisions>
## Implementation Decisions

### KPI Row
- **D-01:** Four stat cards in a horizontal row at the top of the page: Open Worksheets (count), Items Pending (sum of item_count across open worksheets), High Priority (count of items with priority "high" or "expedited"), Avg Age (average time since earliest item `added_at` across open worksheets).
- **D-02:** All KPI values computed client-side from the `listWorksheets()` response — no new backend endpoint needed. The existing `WorksheetListItem` already contains `items[]` with `priority` and `added_at` fields.
- **D-03:** KPI cards use a simple card layout consistent with existing stat displays in the app.

### Worksheet Row Content
- **D-04:** Each worksheet is a table row with columns: Title (bold, truncated) | Analyst (email or "Unassigned") | Status (StateBadge) | Items (count) | Priority Breakdown (mini PriorityBadge pills: e.g., "3 normal - 1 high - 1 expedited") | Oldest Item (AgingTimer from earliest `added_at`).
- **D-05:** Reuse existing `PriorityBadge`, `AgingTimer`, and `StateBadge` components from Phase 16.
- **D-06:** Priority breakdown computed client-side from `WorksheetListItem.items[].priority`.

### Filtering
- **D-07:** Status filter as segmented control/tabs at top: `All | Open | Completed`. Default: Open. Uses the existing `listWorksheets(status?)` backend parameter.
- **D-08:** Analyst filter as a dropdown Select populated from unique analyst values extracted client-side from loaded worksheet data — no new endpoint.
- **D-09:** Default sort: newest first (backend already returns `ORDER BY created_at DESC`).
- **D-10:** Filter state is local React state — no URL persistence for v1.

### Click-to-Detail
- **D-11:** Clicking a worksheet row opens the Phase 17 floating clipboard drawer with that worksheet loaded. Sets `activeWorksheetId` in ui-store and opens the drawer. The list page stays visible behind the drawer overlay.
- **D-12:** No separate page navigation for worksheet detail — consistent with Phase 17 D-11 pattern.

### Data Fetching
- **D-13:** Use TanStack Query with `listWorksheets()` for data fetching. 30-second polling (`refetchInterval: 30000`) consistent with inbox pattern (Phase 16 D-04).
- **D-14:** Filter changes trigger re-fetch via query key invalidation (status filter uses backend param, analyst filter is client-side post-filter).

### Claude's Discretion
- Card layout dimensions and spacing for KPI row
- Loading skeleton design during initial fetch
- Empty state when no worksheets exist
- Responsive behavior for narrow viewports
- Whether to show a count badge on the "Worksheets" nav item

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing worksheet components
- `src/components/hplc/WorksheetsListPage.tsx` — Placeholder page to replace with full implementation
- `src/components/hplc/WorksheetsInboxPage.tsx` — Inbox page with TanStack Query polling, bulk actions, filter patterns
- `src/components/hplc/WorksheetDropPanel.tsx` — Worksheet cards in sidebar (item display patterns)

### Reusable display components
- `src/components/hplc/WorksheetsInboxPage.tsx` — PriorityBadge, AgingTimer usage patterns
- `src/components/senaite/senaite-utils.ts` — StateBadge component
- `src/lib/service-group-colors.ts` — SERVICE_GROUP_COLORS palette

### API and types
- `src/lib/api.ts` — `WorksheetListItem` interface (line 3732), `listWorksheets()` function (line 3765)
- `backend/main.py` — `list_worksheets` endpoint (line 11032), returns items with priority/added_at

### Navigation and drawer
- `src/store/ui-store.ts` — `worksheetDrawerOpen`, `activeWorksheetId` state (Phase 17)
- `src/components/layout/MainWindowContent.tsx` — Page routing for worksheets section

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `listWorksheets(status?)` in api.ts — API function ready, returns full `WorksheetListItem[]` with items
- `PriorityBadge` — built in Phase 16, color-coded priority display
- `AgingTimer` — built in Phase 16, calculates and displays time since date
- `StateBadge` from senaite-utils.ts — status display component
- `Table` components from shadcn/ui — used across all admin and data pages
- `Select` component from shadcn/ui — for analyst filter dropdown

### Established Patterns
- TanStack Query with 30s polling for live data (inbox pattern)
- shadcn/ui Table for data display with column headers
- Zustand selector pattern for UI state (no destructuring)
- All page components follow the same `flex-1 p-6` container pattern

### Integration Points
- `WorksheetsListPage.tsx` — replace placeholder with full implementation
- `ui-store.ts` — read `worksheetDrawerOpen` / set `activeWorksheetId` to open drawer on row click
- `MainWindowContent.tsx` — already routes to WorksheetsListPage for the 'worksheets' sub-section

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches using existing components and patterns.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 18-worksheets-list*
*Context gathered: 2026-04-01*
