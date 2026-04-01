---
phase: 17-worksheet-detail
plan: "01"
subsystem: worksheet
tags: [backend, api, zustand, tanstack-query, worksheet]
dependency_graph:
  requires: []
  provides: [worksheet-complete-endpoint, worksheet-reassign-endpoint, worksheet-drawer-state, use-worksheet-drawer-hook]
  affects: [src/lib/api.ts, src/store/ui-store.ts, backend/main.py]
tech_stack:
  added: []
  patterns: [tanstack-query-mutations, zustand-selector-syntax, fastapi-endpoint-pattern]
key_files:
  created:
    - src/hooks/use-worksheet-drawer.ts
  modified:
    - backend/main.py
    - src/lib/api.ts
    - src/store/ui-store.ts
decisions:
  - Per-item analyst email resolution batches all unique analyst IDs in a single query per worksheet list call (not N+1)
  - completeMutation callback uses useUIStore.getState().closeWorksheetDrawer() per project getState-in-callbacks rule
  - useWorksheetDrawer uses selector syntax for activeWorksheetId (not destructuring) per project ast-grep rule
metrics:
  duration_seconds: 260
  completed_date: "2026-04-01"
  tasks_completed: 2
  files_modified: 4
---

# Phase 17 Plan 01: Backend Endpoints + API Layer + Drawer State Summary

**One-liner:** Two new FastAPI worksheet endpoints (complete, reassign) plus extended TypeScript API types, Zustand drawer state, and a useWorksheetDrawer TanStack Query hook.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Backend — complete, reassign endpoints + extend WorksheetUpdate + item serialization | 9fff065 | backend/main.py |
| 2 | API types + Zustand drawer state + useWorksheetDrawer hook | edff570 | src/lib/api.ts, src/store/ui-store.ts, src/hooks/use-worksheet-drawer.ts |

## What Was Built

### Backend (main.py)

- `WorksheetUpdate` Pydantic model extended with `notes: Optional[str] = None`
- `update_worksheet` handler now persists `data.notes` when provided
- `list_worksheets` item serialization extended with `instrument_uid`, `assigned_analyst_id`, `assigned_analyst_email`, `notes` per item; top-level `notes` field also added to worksheet response
- Per-item analyst email resolution uses a batched query (single `User.id.in_(item_analyst_ids)` lookup per worksheet), not N+1
- `ReassignRequest(BaseModel)` with `target_worksheet_id: int`
- `POST /worksheets/{id}/complete` — transitions open worksheet to completed, raises HTTP 400 if already completed/other status
- `POST /worksheets/{id}/items/{uid}/{gid}/reassign` — validates item exists and target worksheet is open before moving item

### API Layer (api.ts)

- `WorksheetListItem.items` type extended with `instrument_uid`, `assigned_analyst_id`, `assigned_analyst_email`, `notes`
- `WorksheetListItem` top-level now includes `notes: string | null`
- `updateWorksheet` data param accepts `notes?: string`
- `completeWorksheet(worksheetId)` — POST to complete endpoint
- `reassignWorksheetItem(worksheetId, sampleUid, serviceGroupId, targetWorksheetId)` — POST to reassign endpoint with body

### Zustand Store (ui-store.ts)

- `worksheetDrawerOpen: boolean` — tracks drawer open state
- `activeWorksheetId: number | null` — which worksheet is displayed in drawer
- `worksheetPrepPrefill: { sampleId, peptideId, method } | null` — prefill for starting prep from worksheet item
- `openWorksheetDrawer(worksheetId?)` — opens drawer, optionally sets active worksheet
- `closeWorksheetDrawer()` — closes drawer
- `setActiveWorksheetId(id)` — switches active worksheet without opening drawer
- `startPrepFromWorksheet(prefill)` — sets prefill, closes drawer, navigates to new-analysis
- `clearWorksheetPrepPrefill()` — clears prefill after consumption

### useWorksheetDrawer Hook (src/hooks/use-worksheet-drawer.ts)

- Queries all worksheets with 30s poll / staleTime:0 (matches inbox live-queue pattern)
- Derives `activeWorksheet`, `openWorksheets`, `totalOpenItems` from query data
- Exports: `updateMutation`, `removeMutation`, `completeMutation`, `reassignMutation`, `addItemMutation`
- `removeMutation` invalidates both `['worksheets']` and `['inbox-samples']` so inbox stays in sync
- `completeMutation` calls `useUIStore.getState().closeWorksheetDrawer()` in `onSuccess`
- All mutations show toast on error; success toasts where user-facing

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- FOUND: src/hooks/use-worksheet-drawer.ts
- FOUND: backend/main.py (modified)
- FOUND: src/lib/api.ts (modified)
- FOUND: src/store/ui-store.ts (modified)
- FOUND commit 9fff065: backend endpoint changes
- FOUND commit edff570: TypeScript API/state/hook changes
