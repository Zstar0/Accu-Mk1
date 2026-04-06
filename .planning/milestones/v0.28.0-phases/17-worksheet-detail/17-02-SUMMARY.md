---
phase: 17-worksheet-detail
plan: "02"
subsystem: worksheet-drawer-ui
tags: [worksheet, drawer, FAB, ui-components, react]
dependency_graph:
  requires: [17-01]
  provides: [WorksheetDrawer, WorksheetDrawerHeader, WorksheetDrawerItems, AddSamplesModal]
  affects: [MainWindow, app-shell]
tech_stack:
  added: []
  patterns: [Sheet overlay, AlertDialog confirmation, Tabs for multi-worksheet, Popover for reassign, TanStack Query for users/inbox, Zustand selector syntax, debounced textarea auto-save, prepStartedItems computed from notes JSON]
key_files:
  created:
    - src/components/hplc/WorksheetDrawer.tsx
    - src/components/hplc/WorksheetDrawerHeader.tsx
    - src/components/hplc/WorksheetDrawerItems.tsx
    - src/components/hplc/AddSamplesModal.tsx
    - src/components/hplc/__tests__/WorksheetDrawer.test.tsx
    - src/components/hplc/__tests__/WorksheetDrawerItems.test.tsx
  modified:
    - src/components/layout/MainWindow.tsx
decisions:
  - AgingTimer uses dateReceived prop (not receivedAt as spec suggested) — matched actual component interface
  - SERVICE_GROUP_COLORS returns Tailwind class string (not {bg,text,border} object) — used class string directly; color mapped deterministically by char-code hash of group_name
  - InboxSample is InboxResponse.items (InboxSampleItem[]) with analyses_by_group — AddSamplesModal flattens to per-group rows for per-item add UX
  - Alert component used for error state in drawer (imported from @/components/ui/alert)
metrics:
  duration_minutes: 5
  completed_date: "2026-04-01"
  tasks_completed: 2
  files_changed: 7
requirements: [WSHT-01, WSHT-02, WSHT-03, WSHT-04, WSHT-05]
---

# Phase 17 Plan 02: Worksheet Drawer UI Summary

**One-liner:** FAB + Sheet drawer with inline title edit, tech dropdown, per-item actions (remove/reassign/start-prep), add-samples modal, and prep_started persistence via worksheet notes JSON.

## What Was Built

### WorksheetDrawerHeader (`src/components/hplc/WorksheetDrawerHeader.tsx`)

Drawer header sub-component with:
- Inline title edit via click — Input + save/cancel icons, Enter/Escape keyboard shortcuts; empty title validation restores previous
- Status badge with per-status Tailwind color classes (open: emerald, completed: zinc, cancelled: red)
- Item count and formatted created date beside the status badge
- Tech Select dropdown calling `onUpdate({ assigned_analyst })` on change
- Notes Textarea with 800ms debounce on keystroke + immediate save on blur
- Complete read-only mode: static text for title, tech, and notes; no click-to-edit

### WorksheetDrawerItems (`src/components/hplc/WorksheetDrawerItems.tsx`)

Scrollable items list sub-component with:
- Per-item row: sample ID (font-mono), service group badge (group_name satisfies WSHT-03 "analysis" column), PriorityBadge, assigned tech email, instrument UID, AgingTimer (compact)
- Hover-reveal actions: X remove button, MoveRight reassign button (opens Popover with Select of other open worksheets), Start Prep button
- Reassign button disabled with tooltip when no other open worksheets exist
- Start Prep calls `onStartPrep` — parent (WorksheetDrawer) handles notes persistence
- prepStartedItems Set computed from worksheet notes JSON by parent; shows "Prep started" indicator (italic) in place of Start Prep button
- Empty state with ClipboardX icon and descriptive text
- Completed worksheets: all action buttons hidden, read-only display

### WorksheetDrawer (`src/components/hplc/WorksheetDrawer.tsx`)

Main container component at app shell level:
- FAB: `fixed bottom-8 right-4 z-40`, ClipboardList icon, `bg-destructive` badge showing `totalOpenItems` (per Open Question 3: always total across all open worksheets, not per-worksheet)
- Sheet controlled by `worksheetDrawerOpen` Zustand state
- Worksheet tabs (Tabs/TabsList/TabsTrigger) appear only when `openWorksheets.length >= 2`; tab switching calls `setActiveWorksheetId`
- Loading skeleton and destructive Alert error states
- Action row: "Add Samples" button + AlertDialog for "Complete Worksheet" confirmation (destructive) with "Keep Worksheet" cancel
- Completed worksheet banner: "View only — worksheet is completed"
- `prepStartedItems` Set computed via useMemo from `activeWorksheet.notes` JSON; `onStartPrep` handler merges `prep_started:{key}=true` into notes JSON and calls `updateMutation` before navigating
- "No active worksheet" fallback when drawer is open but no activeWorksheetId matches any worksheet

### AddSamplesModal (`src/components/hplc/AddSamplesModal.tsx`)

Mini inbox Dialog with:
- Queries `getInboxSamples` (enabled only when open) — flattens InboxSampleItem.analyses_by_group into per-(sample, group) rows
- Filters against `existingItems` by `sample_uid-service_group_id` key
- Empty state: "No unassigned samples in the inbox."
- AddSampleCard inline sub-component: shows sample_id, group badge, PriorityBadge; click calls `onAdd`; checkmark overlay shown after click (local `added` state)

### MainWindow.tsx

Added `<WorksheetDrawer />` between `<PreferencesDialog />` and `<Toaster>` in the global UI components block (app shell level mount, D-01).

### Test Stubs

- `WorksheetDrawer.test.tsx` — 5 pending tests: FAB badge (WSHT-01), sheet open, header render (WSHT-01), complete dialog (WSHT-07), complete confirm (WSHT-07)
- `WorksheetDrawerItems.test.tsx` — 6 pending tests: item row fields (WSHT-03), remove (WSHT-05), reassign popover (WSHT-06), reassign confirm (WSHT-06), empty state, completed read-only mode

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] AgingTimer prop name mismatch**
- **Found during:** Task 1
- **Issue:** Plan instructed `<AgingTimer receivedAt={item.added_at} />` but actual AgingTimer component uses `dateReceived` prop
- **Fix:** Used `dateReceived={item.added_at}` matching the actual component interface
- **Files modified:** `src/components/hplc/WorksheetDrawerItems.tsx`

**2. [Rule 1 - Bug] SERVICE_GROUP_COLORS returns class strings, not style objects**
- **Found during:** Task 1
- **Issue:** Plan instructed using inline styles `{ backgroundColor, color, borderColor }` but `SERVICE_GROUP_COLORS` values are Tailwind class strings
- **Fix:** Applied class strings directly to `className` prop; used deterministic char-code hash of `group_name` to pick a color key consistently
- **Files modified:** `src/components/hplc/WorksheetDrawerItems.tsx`, `src/components/hplc/AddSamplesModal.tsx`

**3. [Rule 1 - Bug] getInboxSamples returns InboxResponse (not InboxSample[])**
- **Found during:** Task 2
- **Issue:** Plan referenced `InboxSample[]` from `getInboxSamples()` but actual return type is `InboxResponse` with `items: InboxSampleItem[]`, each item having `analyses_by_group: InboxServiceGroupSection[]`
- **Fix:** AddSamplesModal flattens the nested structure into per-(sample, service_group) rows before rendering
- **Files modified:** `src/components/hplc/AddSamplesModal.tsx`

**4. [Rule 2 - Missing functionality] Alert import for error state**
- **Found during:** Task 2
- **Issue:** WorksheetDrawer's error state used `Alert`/`AlertTitle`/`AlertDescription` which needed an import
- **Fix:** Added import from `@/components/ui/alert`
- **Files modified:** `src/components/hplc/WorksheetDrawer.tsx`

## Known Stubs

None — all plan-required fields are wired to live data from `useWorksheetDrawer` and `getInboxSamples`. Test stubs are intentionally pending (it.todo) per plan spec for a future testing pass.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| Task 1 | d2bea7c | feat(17-02): WorksheetDrawerHeader, WorksheetDrawerItems sub-components + test stubs |
| Task 2 | 1b7958b | feat(17-02): WorksheetDrawer container + AddSamplesModal + MainWindow wiring |

## Self-Check: PASSED
