---
phase: 16-received-samples-inbox
plan: "03"
subsystem: ui
tags: [react, typescript, tailwind, inbox, worksheets, tanstack-query]

dependency_graph:
  requires:
    - 16-01 (backend inbox endpoints)
    - 16-02 (useInboxSamples, usePriorityMutation, PriorityBadge, AgingTimer, api types)
  provides:
    - InboxSampleTable component with 9-column layout, expandable rows, inline editing
    - WorksheetsInboxPage full page with loading/error/empty states and 30s polling
  affects:
    - 16-04 (bulk toolbar will slot into WorksheetsInboxPage; useCreateWorksheetMutation already wired in hooks)

tech-stack:
  added: []
  patterns:
    - shadcn Checkbox checked="indeterminate" for header partial-selection state
    - Local Set<string> state for expandedUids — per D-08, no Zustand for transient UI
    - Select trigger with custom child (PriorityBadge) as display value
    - React useState for selectedUids (not Zustand) per D-14

key-files:
  created:
    - src/components/hplc/InboxSampleTable.tsx
  modified:
    - src/components/hplc/WorksheetsInboxPage.tsx

key-decisions:
  - "shadcn Checkbox supports checked='indeterminate' directly — no DOM ref workaround needed"
  - "Instrument dropdown maps Instrument.senaite_uid ?? String(id) as uid key — matches backend expectation"
  - "Bulk toolbar slot reserved as comment in WorksheetsInboxPage for Plan 04 to inject"

metrics:
  duration: "~3 minutes"
  completed: "2026-04-01"
  tasks_completed: 2
  files_modified: 2
---

# Phase 16 Plan 03: Inbox Table Page Summary

**Inbox table page with 9-column layout, expandable service-group rows, inline priority/tech/instrument selects, and full loading/error/empty page states wired to 30s polling.**

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Build InboxSampleTable with expandable rows and inline editing | 4012654 | src/components/hplc/InboxSampleTable.tsx |
| 2 | Replace WorksheetsInboxPage placeholder with full inbox page | 3f8c2f3 | src/components/hplc/WorksheetsInboxPage.tsx |

## What Was Built

### Task 1 — InboxSampleTable (src/components/hplc/InboxSampleTable.tsx)

Full table component with:

- **9 columns per D-21:** expand toggle, checkbox, Sample ID (font-mono), Client (prefers client_order_number), Priority (inline Select showing PriorityBadge), Assigned Tech (inline Select from users), Instrument (inline Select from instruments), Age (AgingTimer), Status (StateBadge)
- **Header checkbox:** Uses shadcn Checkbox `checked="indeterminate"` prop for partial-selection — no DOM ref workaround needed
- **Row expansion:** Local `expandedUids: Set<string>` state with ChevronRight rotating 90° when open
- **Expanded content:** Analyses grouped by `analyses_by_group`, each group has a colored badge using `SERVICE_GROUP_COLORS[colorKey]` (falls back to 'zinc' for unknown colors), mini-table with analysis title/keyword/method
- **Empty expansion:** "No analyses available" message when `analyses_by_group` is empty
- No `useCallback`, no Zustand destructuring (compliant with React Compiler + ast-grep rules)

### Task 2 — WorksheetsInboxPage (src/components/hplc/WorksheetsInboxPage.tsx)

Full page replacing the Phase 15 placeholder:

- **Header:** "Received Samples" title + total count badge + "Auto-refreshes every 30s" subtitle
- **Loading state:** Animated skeleton table (6 rows, matching column widths)
- **Error state:** Error message + Retry button wired to `refetch()`
- **Empty state:** `<Inbox>` icon + "No received samples" message
- **Data state:** `<InboxSampleTable>` with all props wired
- **Mutations:** `usePriorityMutation` for inline priority, `useBulkUpdateMutation` for tech/instrument assigns
- **Users:** `useQuery(['worksheet-users'], getWorksheetUsers)` — not admin endpoint (per D-05, Pitfall 6)
- **Instruments:** `useQuery(['instruments'], getInstruments)` using existing function, mapped to `{ uid, title }`
- **Selection:** `useState<Set<string>>` (not Zustand) per D-14
- **Bulk toolbar slot:** Reserved as comment for Plan 04

## Deviations from Plan

None — plan executed exactly as written. The shadcn Checkbox `checked="indeterminate"` prop worked directly (Pitfall 4 DOM ref workaround was not needed).

## Known Stubs

None — all data flows are wired. Instrument dropdown uses real `getInstruments()`. Users dropdown uses real `getWorksheetUsers()`. Priority, tech, and instrument mutations call real API functions.

## Self-Check: PASSED
