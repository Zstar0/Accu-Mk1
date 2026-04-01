---
phase: 17-worksheet-detail
verified: 2026-04-01T00:00:00Z
status: human_needed
score: 13/13 automated must-haves verified
re_verification: false
human_verification:
  - test: "FAB visible on all pages (Dashboard, SENAITE, LIMS, HPLC)"
    expected: "Clipboard FAB with item count badge appears bottom-right on every page"
    why_human: "App-shell mount confirmed in code, but cross-page rendering requires a running Tauri app to confirm z-index, layout, and visibility across all page transitions"
  - test: "Inline title edit saves on Enter and persists on refresh"
    expected: "Clicking title makes it an Input; pressing Enter calls updateWorksheet; reopening drawer shows saved title"
    why_human: "Input + mutation logic is wired, but persistence through backend and re-fetch requires a running app"
  - test: "Notes save on blur and persist — user text only (no JSON metadata in textarea)"
    expected: "Notes textarea shows clean user text; raw JSON like prep_started keys never appear to the user"
    why_human: "JSON separation logic is verified in code (parses 'text' key, writes merged JSON), but correctness requires running app with a worksheet that has both notes and prep_started data"
  - test: "Start Prep navigates to wizard with sample ID and peptide pre-filled; Prep Started indicator appears on return"
    expected: "Start Prep click navigates to new-analysis, sample ID and peptide selector pre-filled; returning to drawer shows 'Prep started' indicator on that row"
    why_human: "prepKey logic, Zustand prefill, and Step1SampleInfo consumption all verified in code; end-to-end requires running app"
  - test: "Complete Worksheet confirmation dialog — cancel and confirm paths"
    expected: "AlertDialog opens on Complete click; Keep Worksheet cancels; confirm calls completeMutation, closes drawer, shows toast"
    why_human: "AlertDialog wiring and completeMutation confirmed in code; dialog interaction and toast display require running app"
  - test: "Hash navigation #hplc-analysis/worksheet-detail?id=X opens correct worksheet"
    expected: "Entering the URL in the Tauri app opens the drawer with the specified worksheet active"
    why_human: "applyNavToStore route case verified; actual URL parsing and drawer open in Tauri WebView requires running app"
---

# Phase 17: Worksheet Detail Verification Report

**Phase Goal:** Users can open any worksheet, view and edit its header and notes, manage its items (add, remove, reassign), and mark the worksheet complete when all work is done.
**Verified:** 2026-04-01
**Status:** human_needed — all automated checks pass; 6 behaviors require running app to confirm
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | PUT /worksheets/{id} accepts and persists a notes field | VERIFIED | `WorksheetUpdate` at line 11120 in main.py has `notes: Optional[str] = None`; `update_worksheet` handler persists it |
| 2 | GET /worksheets returns instrument_uid and assigned_analyst_id per item | VERIFIED | Item dict at lines 11108-11112 includes `"instrument_uid": it.instrument_uid`, `"assigned_analyst_id": it.assigned_analyst_id`, `"assigned_analyst_email"`, `"notes"`, `"peptide_id"` |
| 3 | POST /worksheets/{id}/complete transitions status to completed and rejects already-completed | VERIFIED | `complete_worksheet` at line 11333: raises HTTP 400 when `ws.status != "open"`, sets `ws.status = "completed"` |
| 4 | POST /worksheets/{id}/items/{uid}/{gid}/reassign moves an item to a target worksheet | VERIFIED | `reassign_worksheet_item` at line 11350: validates item exists, validates target is open, sets `item.worksheet_id` |
| 5 | TypeScript types and API functions exist for complete, reassign, and extended item fields | VERIFIED | `completeWorksheet` at line 3812, `reassignWorksheetItem` at line 3821 in api.ts; `WorksheetListItem` includes all extended fields including `peptide_id` |
| 6 | Zustand store has worksheetDrawerOpen, activeWorksheetId, and worksheetPrepPrefill state | VERIFIED | All three state fields + 5 actions declared in ui-store.ts lines 54-247 with devtools action names |
| 7 | TanStack Query hooks exist for worksheet drawer data fetching and mutations | VERIFIED | `useWorksheetDrawer` exports query + 5 mutations; uses selector syntax for activeWorksheetId |
| 8 | User sees a clipboard FAB in the bottom-right corner on every page | VERIFIED (code) | FAB at `fixed bottom-8 right-4 z-40` in WorksheetDrawer.tsx line 84; `<WorksheetDrawer />` mounted in MainWindow.tsx line 153; HUMAN NEEDED to confirm visual |
| 9 | FAB badge shows total open item count | VERIFIED (code) | `totalOpenItems` from useWorksheetDrawer displayed in badge; derived from all open worksheets, not per-worksheet count |
| 10 | Drawer header shows editable title, tech dropdown, status badge, date, item count, notes textarea | VERIFIED (code) | WorksheetDrawerHeader.tsx: inline title edit (editingTitle state), Select for tech, status badge, debounced notes Textarea; userNotes prop receives parsed user text only |
| 11 | Items list shows sample ID, analysis (group_name), service group badge, priority, tech email, instrument UID, age timer, remove, reassign, Start Prep | VERIFIED (code) | WorksheetDrawerItems.tsx lines 101-163: all WSHT-03 fields rendered; hover-reveal actions present |
| 12 | User can add samples from a mini inbox modal (click-to-add) | VERIFIED (code) | AddSamplesModal.tsx: Dialog, queries getInboxSamples, filters against existingItems, onAdd triggers addItemMutation |
| 13 | Hash route #hplc-analysis/worksheet-detail?id=X opens drawer | VERIFIED (code) | hash-navigation.ts line 77-78: `worksheet-detail` case in applyNavToStore calls `store.openWorksheetDrawer(Number(targetId))`; buildHash and subscribe unchanged (no feedback loop) |

**Score:** 13/13 truths verified programmatically (6 additionally require running app confirmation)

---

## Required Artifacts

| Artifact | Min Lines | Actual Lines | Status | Details |
|----------|-----------|--------------|--------|---------|
| `backend/main.py` | — | 11,400+ | VERIFIED | complete_worksheet + reassign_worksheet_item endpoints present; WorksheetUpdate extended |
| `src/lib/api.ts` | — | 3,900+ | VERIFIED | completeWorksheet, reassignWorksheetItem exported; WorksheetListItem extended with all fields |
| `src/store/ui-store.ts` | — | 250+ | VERIFIED | worksheetDrawerOpen, activeWorksheetId, worksheetPrepPrefill + all 5 actions present |
| `src/hooks/use-worksheet-drawer.ts` | — | 122 | VERIFIED | Exports useWorksheetDrawer; selector syntax; 5 mutations returned |
| `src/components/hplc/WorksheetDrawer.tsx` | 80 | 296 | VERIFIED | FAB + Sheet + Tabs + AlertDialog + prepStartedItems logic |
| `src/components/hplc/WorksheetDrawerHeader.tsx` | 60 | 185 | VERIFIED | Inline title edit, debounced notes, tech Select, status badge |
| `src/components/hplc/WorksheetDrawerItems.tsx` | 60 | 226 | VERIFIED | All WSHT-03 fields, hover actions, reassign Popover, Start Prep |
| `src/components/hplc/AddSamplesModal.tsx` | 40 | 140 | VERIFIED | Dialog, inbox query, filter against existing, click-to-add |
| `src/components/hplc/__tests__/WorksheetDrawer.test.tsx` | — | — | VERIFIED | 5 it.todo stubs for WSHT-01, WSHT-07 (intentionally pending per plan) |
| `src/components/hplc/__tests__/WorksheetDrawerItems.test.tsx` | — | — | VERIFIED | 6 it.todo stubs for WSHT-03, WSHT-05, WSHT-06 (intentionally pending per plan) |
| `src/components/layout/MainWindow.tsx` | — | — | VERIFIED | `<WorksheetDrawer />` at line 153 in app shell |
| `src/lib/hash-navigation.ts` | — | — | VERIFIED | worksheet-detail route case wired; no feedback loop |
| `src/components/hplc/wizard/steps/Step1SampleInfo.tsx` | — | — | VERIFIED | Consumes worksheetPrepPrefill; clears after application; peptide pre-fill wired |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `use-worksheet-drawer.ts` | `src/lib/api.ts` | imports completeWorksheet, reassignWorksheetItem, listWorksheets, updateWorksheet, removeWorksheetItem, addGroupToWorksheet | WIRED | Lines 1-12 of hook file confirm all imports |
| `use-worksheet-drawer.ts` | `src/store/ui-store.ts` | reads activeWorksheetId with selector syntax | WIRED | Line 16: `useUIStore(state => state.activeWorksheetId)` |
| `WorksheetDrawer.tsx` | `use-worksheet-drawer.ts` | imports useWorksheetDrawer | WIRED | Line 22: `import { useWorksheetDrawer } from '@/hooks/use-worksheet-drawer'` |
| `WorksheetDrawer.tsx` | `src/store/ui-store.ts` | reads worksheetDrawerOpen, closeWorksheetDrawer | WIRED | Lines 29-32: selector syntax for all drawer state |
| `MainWindow.tsx` | `WorksheetDrawer.tsx` | renders `<WorksheetDrawer />` at app shell | WIRED | Line 153 confirmed |
| `hash-navigation.ts` | `src/store/ui-store.ts` | calls openWorksheetDrawer on worksheet-detail route | WIRED | Lines 77-78; no buildHash entry; subscribe unchanged |
| `Step1SampleInfo.tsx` | `src/store/ui-store.ts` | reads worksheetPrepPrefill, calls clearWorksheetPrepPrefill | WIRED | Lines 151, 172 confirmed |

---

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `WorksheetDrawerItems.tsx` | items (WorksheetListItem.items[]) | useWorksheetDrawer → listWorksheets → GET /worksheets | Backend queries WorksheetItem via SQLAlchemy, serializes all fields including instrument_uid, assigned_analyst_email, notes, peptide_id | FLOWING |
| `WorksheetDrawer.tsx` | prepStartedItems | useMemo parsing activeWorksheet.notes JSON | Reads notes column from backend response; extracts prep_started:* keys | FLOWING |
| `WorksheetDrawer.tsx` | userNotes | useMemo parsing activeWorksheet.notes JSON | Extracts `text` key from JSON; plain text fallback | FLOWING |
| `AddSamplesModal.tsx` | flatItems | getInboxSamples → GET /inbox-samples | Backend query to inbox samples; enabled only when modal is open | FLOWING |
| FAB badge | totalOpenItems | useWorksheetDrawer: reduce(openWorksheets, item_count) | Derived from live worksheet query; 30s poll | FLOWING |

---

## Behavioral Spot-Checks

| Behavior | Command/Check | Result | Status |
|----------|---------------|--------|--------|
| useWorksheetDrawer exports all required members | grep count in hook file | 31 matches for all exported names | PASS |
| hash-navigation subscribe has no worksheetDrawerOpen reference | grep hash-navigation.ts | No match — no feedback loop | PASS |
| WorksheetDrawer mounted at app shell | grep MainWindow.tsx | `<WorksheetDrawer />` at line 153 | PASS |
| backend Python syntax valid | `python -c "import ast; ast.parse(...)"` | Python AST parse OK | PASS |
| TypeScript compilation | `npx tsc --noEmit` | Exit code 0 — no errors | PASS |
| complete_worksheet rejects non-open status | grep main.py for HTTP 400 logic | `raise HTTPException(400, f"Worksheet is already {ws.status}")` present | PASS |
| Notes JSON separation: user text vs prep_started metadata | grep WorksheetDrawer.tsx | `parsed.text = data.notes` on save; `parsed.text` extracted on read | PASS |
| prepKey uses sample_id (not sample_uid) | grep WorksheetDrawerItems.tsx | `prepKey = \`${item.sample_id}-${item.service_group_id}\`` at line 80 | PASS |

---

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| WSHT-01 | 17-02, 17-03 | User can view worksheet detail with header (title, analyst, status, created date, item count) | SATISFIED | WorksheetDrawerHeader renders all header fields; WorksheetDrawer wires data |
| WSHT-02 | 17-01, 17-02 | User can edit worksheet title and notes | SATISFIED | Inline title edit in WorksheetDrawerHeader; debounced notes Textarea; updateMutation persists both |
| WSHT-03 | 17-02 | Worksheet items table shows sample ID, analysis, service group, priority, tech, instrument, status | SATISFIED | WorksheetDrawerItems.tsx renders all 7 fields per row; AgingTimer for age/status context |
| WSHT-04 | 17-02, 17-03 | User can add samples to existing worksheet (mini inbox modal) | SATISFIED | AddSamplesModal with Dialog, getInboxSamples query, addItemMutation |
| WSHT-05 | 17-02 | User can remove items from a worksheet (items return to inbox) | SATISFIED | Remove button in WorksheetDrawerItems; removeMutation invalidates both worksheets + inbox-samples query keys |
| WSHT-06 | 17-01, 17-02, 17-03 | User can reassign items to a different worksheet | SATISFIED | Reassign Popover in WorksheetDrawerItems; reassignMutation backend endpoint validates target is open |
| WSHT-07 | 17-01, 17-02, 17-03 | User can mark a worksheet as completed | SATISFIED | AlertDialog confirmation in WorksheetDrawer; completeMutation; HTTP 400 guard on backend for already-completed |
| WSHT-08 | 17-01 | Worksheet data persists locally (worksheets + worksheet_items tables) | SATISFIED | All mutations persist to backend SQLite via FastAPI; notes, instrument_uid, assigned_analyst_id, status all stored in DB |

**All 8 phase requirements: SATISFIED**

No orphaned requirements found — all 8 WSHT-0x IDs claimed across Plan 01 + Plan 02 + Plan 03 and verified present.

---

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| WorksheetDrawerHeader.tsx | 157 | `placeholder="Assign tech..."` on SelectValue | INFO | Standard UI placeholder text — not a code stub; Select is wired to real data |
| WorksheetDrawerHeader.tsx | 175 | `placeholder="Add notes..."` on Textarea | INFO | Standard UI placeholder text — Textarea is wired to real notes data |
| WorksheetDrawerItems.tsx | 210 | `placeholder="Select worksheet..."` on SelectValue | INFO | Standard UI placeholder text — reassign Select is wired to openWorksheets list |
| WorksheetDrawer.test.tsx | 4-8 | `it.todo(...)` for 5 tests | WARNING | Intentional pending stubs per Plan 02 spec; no regression risk but tests are unimplemented |
| WorksheetDrawerItems.test.tsx | 4-9 | `it.todo(...)` for 6 tests | WARNING | Intentional pending stubs per Plan 02 spec; no regression risk but tests are unimplemented |

No blocker anti-patterns. The `it.todo` stubs are intentional — Plan 02 explicitly specified them as pending for a future testing pass. Placeholder strings are standard shadcn/ui Select/Textarea patterns, not code stubs.

---

## Human Verification Required

### 1. FAB Visibility Across All Pages

**Test:** Run the app. Navigate to Dashboard, SENAITE tab, LIMS tab, and HPLC Analysis tab. Confirm the clipboard FAB appears in the bottom-right corner on every page with the correct item count badge.
**Expected:** FAB visible on all pages; badge shows total open item count; badge absent when no open worksheets exist.
**Why human:** App-shell mount at MainWindow is confirmed in code, but actual rendering across page transitions — z-index conflicts, layout shifts — requires a running Tauri WebView.

### 2. Notes Persistence and JSON Isolation

**Test:** Open a worksheet with existing prep_started data. Edit the notes field, blur out. Refresh the app and reopen the drawer. Confirm: (a) notes saved correctly, (b) raw JSON like `{"text":"...","prep_started:{key}":true}` never appears in the textarea.
**Expected:** Only the user-written text appears in the notes textarea; no JSON metadata leaks.
**Why human:** The JSON separation logic (parse `text` key, merge on write) is verified in code, but correctness requires a worksheet that has both user notes and prep_started flags stored simultaneously.

### 3. Start Prep Full Loop (prefill + indicator persistence)

**Test:** From the worksheet drawer, click "Start Prep" on an item. Confirm the analysis wizard opens with the sample ID and peptide pre-selected. Navigate back to the drawer. Confirm the item shows "Prep started" italic text instead of the Start Prep button.
**Expected:** Prefill appears in Step1SampleInfo; prepKey matches (uses sample_id not sample_uid); indicator persists across drawer close/reopen.
**Why human:** prepKey bug was fixed during E2E (Plan 03), correctness requires the full navigation cycle in a running app.

### 4. Complete Worksheet Dialog + Toast

**Test:** Click "Complete Worksheet". Confirm AlertDialog appears. Test "Keep Worksheet" (cancel). Click again and confirm. Confirm: drawer closes, toast says "Worksheet completed", worksheet no longer shows in open tabs.
**Expected:** Both dialog paths work; mutation fires only on confirm; drawer closed via useUIStore.getState().closeWorksheetDrawer().
**Why human:** AlertDialog interaction and toast display require a running app.

### 5. Hash Navigation Deep-Link

**Test:** With the app running, type `#hplc-analysis/worksheet-detail?id={valid_id}` in the URL bar. Confirm the drawer opens with the correct worksheet selected.
**Expected:** Drawer opens, correct worksheet active, no URL hash change when FAB is subsequently clicked.
**Why human:** applyNavToStore route case is wired, but Tauri WebView URL parsing and popstate behavior require a running app.

### 6. Add Samples Modal + Item Appears in Drawer

**Test:** Click "Add Samples" in the drawer action row. Confirm Dialog opens with inbox items that are not already in the worksheet. Click one to add it. Confirm checkmark overlay appears. Close modal. Confirm the item now appears in the worksheet items list.
**Expected:** Filtering works (no duplicates); addItemMutation fires; worksheets query invalidates and re-fetches showing the new item.
**Why human:** Modal open/close, filter logic (existingSet), and query invalidation all require a running app with actual inbox data.

---

## Gaps Summary

No automated gaps. All 13 observable truths pass code-level verification across all four levels (exists, substantive, wired, data-flowing). TypeScript compiles clean. Python AST parses clean. All 8 requirements (WSHT-01 through WSHT-08) are satisfied.

The 6 human verification items above are standard end-to-end confirmation steps for a Tauri UI feature. They require a running app, not code fixes. The code is complete and correctly wired.

**Recommendation:** Human sign-off via the 6 test steps above completes Phase 17 verification.

---

_Verified: 2026-04-01_
_Verifier: Claude (gsd-verifier)_
