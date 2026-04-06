---
phase: 16-received-samples-inbox
plan: "04"
subsystem: ui
tags: [react, typescript, tailwind, inbox, worksheets, bulk-actions, tanstack-query]

dependency_graph:
  requires:
    - 16-01 (backend inbox + worksheet endpoints)
    - 16-02 (useInboxSamples, useBulkUpdateMutation, useCreateWorksheetMutation, api types)
    - 16-03 (InboxSampleTable, WorksheetsInboxPage with selection state)
  provides:
    - InboxBulkToolbar: floating fixed bottom-center toolbar for bulk sample operations
    - CreateWorksheetDialog: worksheet creation modal with auto-generated title and 409 stale guard
    - WorksheetsInboxPage fully wired with bulk actions and worksheet creation
  affects:
    - Phase 17 (worksheet detail view — created worksheets land here)

tech-stack:
  added: []
  patterns:
    - Fixed bottom floating toolbar with animate-in slide-in-from-bottom-4
    - Dialog with useEffect-driven field reset on open (fresh title each time)
    - Mutation onSuccess/onError callbacks in call-site for per-invocation side effects
    - 409 staleUids: partial Set update to remove only stale UIDs from selection

key-files:
  created:
    - src/components/hplc/InboxBulkToolbar.tsx
    - src/components/hplc/CreateWorksheetDialog.tsx
  modified:
    - src/components/hplc/WorksheetsInboxPage.tsx

key-decisions:
  - "CreateWorksheetDialog resets title/notes in useEffect on open — generates fresh WS-YYYY-MM-DD-001 each open"
  - "Mutation callbacks (onSuccess/onError) passed at call-site in WorksheetsInboxPage for selection/dialog state side effects — hook-level callbacks handle toast only"
  - "Floating toolbar conditioned on selectedUids.size > 0 — rendered outside the samples.length > 0 guard so it stays visible even if table re-renders"

metrics:
  duration: "~4 minutes"
  completed: "2026-04-01"
  tasks_completed: 3
  files_modified: 3
---

# Phase 16 Plan 04: Bulk Toolbar and Worksheet Creation Summary

**Floating bulk action toolbar and worksheet creation dialog completing the Received Samples Inbox — users can select samples, apply bulk priority/tech/instrument updates, and create worksheets with a 409 stale-guard that removes changed samples from selection.**

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create InboxBulkToolbar and CreateWorksheetDialog | 2aa1ac2 | src/components/hplc/InboxBulkToolbar.tsx, src/components/hplc/CreateWorksheetDialog.tsx |
| 2 | Wire bulk toolbar and dialog into WorksheetsInboxPage | 51d12ee | src/components/hplc/WorksheetsInboxPage.tsx |
| 3 | Verify complete inbox workflow (auto-approved: skip_checkpoints=true) | — | — |

## What Was Built

### Task 1 — InboxBulkToolbar (src/components/hplc/InboxBulkToolbar.tsx)

Floating toolbar fixed to `bottom-6 left-1/2 -translate-x-1/2 z-50`:

- Animates in with `slide-in-from-bottom-4`
- Selection count display
- Set Priority dropdown: Normal / High / Expedited
- Assign Tech dropdown: lists users by email, disabled when empty
- Set Instrument dropdown: lists instruments by title, disabled when empty
- "Create Worksheet" primary Button (variant="default")
- "Clear" ghost Button

### Task 1 — CreateWorksheetDialog (src/components/hplc/CreateWorksheetDialog.tsx)

Worksheet creation modal:

- Auto-generates `WS-YYYY-MM-DD-001` title on each open (editable input)
- Optional notes textarea with placeholder "Add notes..."
- Sample count in DialogDescription
- Loading state: Loader2 spinner + disabled Create button while isPending
- Cancel button closes dialog; Create disabled when title is empty
- 409 stale guard handled in parent — dialog just calls onConfirm(title, notes)

### Task 2 — WorksheetsInboxPage wiring (src/components/hplc/WorksheetsInboxPage.tsx)

- `useCreateWorksheetMutation` added alongside existing mutations
- `worksheetDialogOpen` boolean state via useState
- `<InboxBulkToolbar>` rendered when `selectedUids.size > 0` with all 4 actions wired
- `<CreateWorksheetDialog>` always rendered (controlled by `open` prop)
- On success: clears selectedUids to new Set(), closes dialog
- On 409 staleUids: removes stale UIDs from selection Set, toast handled in hook

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — all data flows are wired. Bulk mutations call real API functions. Worksheet creation calls real `POST /worksheets` endpoint.

## Self-Check: PASSED
