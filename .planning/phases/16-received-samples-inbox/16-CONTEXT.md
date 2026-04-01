# Phase 16: Received Samples Inbox - Context

**Gathered:** 2026-04-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Users see all SENAITE received samples in a live queue with aging timers and SLA color coding, can set priority and assign tech/instrument inline or in bulk, and can create a worksheet from selected samples in one action. This is the highest-value phase — replaces SENAITE's worksheet creation with a custom workflow.

</domain>

<decisions>
## Implementation Decisions

### Inbox Backend Architecture
- **D-01:** New dedicated endpoint `GET /worksheets/inbox` that queries SENAITE for `sample_received` samples, then enriches each with: (a) analyses from SENAITE joined to local service groups via keyword match, (b) local priority from `sample_priorities` table, (c) local analyst/instrument assignments from any existing worksheet_items. This is NOT a simple proxy — it's a composite view.
- **D-02:** The backend does the service group matching: for each analysis on a sample, match `SenaiteAnalysis.keyword` → `AnalysisService.keyword` → `service_group_members` → `ServiceGroup`. Unmatched analyses fall into the default group (is_default=true).
- **D-03:** Priority stored in local `sample_priorities` table (sample_uid PK, priority enum, updated_at). Endpoints: `PUT /worksheets/inbox/{sample_uid}/priority`.
- **D-04:** 30-second polling via TanStack Query `refetchInterval: 30000`. This is the first TanStack Query hook in the inbox section (admin pages use useState, but inbox is a live data view).

### Analyst Source
- **D-05:** Analyst dropdown populated from **AccuMark's local user list** (`GET /users` or similar), NOT from SENAITE LabContacts. Assignment is stored locally in worksheet_items only — no push to SENAITE. This was decided during Phase 15 live testing: SENAITE's Analyst field is read-only on Analysis objects.
- **D-06:** Instrument dropdown populated from local instruments table (`GET /instruments` — already exists).

### Expandable Row Design
- **D-07:** Each sample row is expandable (click chevron or row). Expanded view shows a sub-table of analyses grouped by service group. Each group has a colored badge (using `SERVICE_GROUP_COLORS` from `service-group-colors.ts`). Within each group: analyte name, keyword, method, declared quantity.
- **D-08:** Expansion state is local (React state), not persisted. Collapsing re-expanding is instant (data already loaded from the enriched inbox response).

### Priority System
- **D-09:** Three priority levels: `normal` (default, zinc badge), `high` (amber badge), `expedited` (red badge with pulse animation).
- **D-10:** Priority set via inline dropdown (shadcn Select component) in the table row. Change fires `PUT /worksheets/inbox/{sample_uid}/priority` immediately. Optimistic update — badge changes instantly, rolls back on error.
- **D-11:** PriorityBadge component with color-coded styling matching the spec. Reusable across inbox, worksheet detail, and worksheets list.

### Aging Timer / SLA
- **D-12:** AgingTimer component calculates time since `date_received` from SENAITE. Color coding: green <12h, yellow 12-20h, orange 20-24h, red >24h. Updates every minute via `setInterval`.
- **D-13:** Display format: "2h 15m" for under 24h, "1d 3h" for over 24h. Red state includes a subtle pulse animation to draw attention.

### Bulk Actions
- **D-14:** Checkbox column with header-level select-all (indeterminate state when partial). Selection state tracked in React state (Set of sample UIDs).
- **D-15:** Floating bulk toolbar appears at bottom of viewport when items are selected (same pattern as Phase 8 bulk selection toolbar from v0.12.0). Actions: "Set Priority" dropdown, "Assign Tech" dropdown, "Set Instrument" dropdown, "Create Worksheet" primary button.
- **D-16:** Bulk update endpoint `PUT /worksheets/inbox/bulk` accepts `{ sample_uids: string[], priority?: string, analyst_id?: number, instrument_uid?: string }`. Each field is optional — only set fields are updated.

### Worksheet Creation
- **D-17:** "Create Worksheet" from bulk toolbar opens a small dialog: auto-generated title (e.g., "WS-2026-04-01-001"), optional notes field, confirm button. Title is editable.
- **D-18:** `POST /worksheets` endpoint: accepts `{ title, sample_uids[], notes? }`. Backend validates each sample is still in `sample_received` state before accepting (stale data guard — INBX-10). If any sample has changed state, return 409 with the stale sample IDs.
- **D-19:** On success, selected items disappear from inbox (they're now in a worksheet). Toast confirmation with link to the new worksheet.
- **D-20:** Worksheet data model: `worksheets` table (id, title, status, assigned_analyst, notes, created_by FK to users, created_at, updated_at), `worksheet_items` table (id, worksheet_id FK, sample_uid, sample_id, analysis_uid nullable, service_group_id FK, priority, assigned_analyst_id FK to users, instrument_uid, notes, added_at).

### Table Columns (in order)
- **D-21:** Checkbox | Sample ID (monospace, clickable → navigates to SENAITE sample detail) | Client | Priority (inline Select → PriorityBadge) | Assigned Tech (inline Select) | Instrument (inline Select) | Age (AgingTimer) | Status (StateBadge)

### Claude's Discretion
- Exact table column widths and responsive behavior
- Loading skeleton design during initial fetch and polling
- Empty state design when no received samples exist
- Error state design when SENAITE is unreachable
- Whether to show a sample count badge on the "Inbox" nav item
- Exact dialog styling for worksheet creation modal

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing patterns to replicate
- `src/components/senaite/SenaiteDashboard.tsx` — Sample table with tabs, state badges, pagination (replicate table patterns)
- `src/components/senaite/AnalysisTable.tsx` — Analysis display within sample context
- `src/components/senaite/senaite-utils.ts` — StateBadge, formatDate helpers
- `src/lib/service-group-colors.ts` — SERVICE_GROUP_COLORS palette for group badges

### Phase 8 bulk selection pattern
- `.planning/phases/08-bulk-selection-floating-toolbar/` — Floating toolbar pattern from v0.12.0

### Navigation (already wired in Phase 15)
- `src/store/ui-store.ts` — WorksheetSubSection type, HPLCAnalysisSubSection
- `src/components/layout/MainWindowContent.tsx` — Render case for 'inbox' sub-section
- `src/components/hplc/WorksheetsInboxPage.tsx` — Placeholder page to replace

### Backend patterns
- `backend/main.py` — SENAITE sample listing endpoints (~line 9344), service group CRUD endpoints (~line 10160), existing update pattern
- `backend/models.py` — ServiceGroup model, service_group_members M2M, AnalysisService model

### API client
- `src/lib/api.ts` — getSenaiteSamples(), SenaiteSample interface, service group functions

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `getSenaiteSamples(reviewState, limit, bStart)` in api.ts — can be used as base, but inbox needs enrichment
- `StateBadge` from senaite-utils.ts — reuse for sample status column
- `formatDate` from senaite-utils.ts — reuse for date display
- `SERVICE_GROUP_COLORS` from service-group-colors.ts — reuse for group badges in expandable rows
- `Badge` component — extend with PriorityBadge variant
- `Select` component from shadcn/ui — for inline dropdowns
- `Checkbox` component — for multi-select
- `Table` components — shadcn/ui table primitives used throughout

### Established Patterns
- **Live data pages** use TanStack Query (this will be the pattern for inbox — NOT useState like admin pages)
- **Bulk selection** pattern from Phase 8: checkbox column, floating toolbar at viewport bottom, sequential processing
- **SENAITE data fetching**: backend proxies SENAITE API, returns enriched data to frontend
- **Inline editing**: click-to-edit pattern exists in AnalysisTable (v0.12.0 Phase 6)

### Integration Points
- `WorksheetsInboxPage.tsx` — replace placeholder with full inbox component
- `backend/main.py` — add inbox endpoint, priority endpoint, bulk endpoint, worksheet CRUD
- `backend/models.py` — add sample_priorities, worksheets, worksheet_items tables
- `src/lib/api.ts` — add inbox types and API functions
- `src/hooks/use-inbox-samples.ts` — new TanStack Query hook

</code_context>

<specifics>
## Specific Ideas

- User explicitly requested `/ui-ux-pro-max` skill for designing all worksheet screens — apply to the inbox page
- "Core HPLC" and "Microbiology" are the primary service group examples
- Aging timer colors match the spec exactly: green <12h, yellow 12-20h, orange 20-24h, red >24h
- Expedited priority badge should have pulse animation (attention-grabbing for urgent samples)
- Worksheet creation should feel like "one click" — minimal friction after selecting samples
- Stale data guard on worksheet creation is critical — lab workflow means samples can change state between inbox load and worksheet creation

</specifics>

<deferred>
## Deferred Ideas

- Auto-suggest tech assignments based on service group → analyst mapping (WAUT-01, future)
- Auto-prioritize samples nearing SLA breach (WAUT-02, future)
- Sample count badge on Inbox nav item — Claude's discretion
- Notification when worksheet items change state in SENAITE (WAUT-03, future)

</deferred>

---

*Phase: 16-received-samples-inbox*
*Context gathered: 2026-04-01*
