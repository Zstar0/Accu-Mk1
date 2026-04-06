---
phase: 17-worksheet-detail
plan: "03"
subsystem: ui
tags: [hash-navigation, worksheet, drawer, tauri, react, zustand]

# Dependency graph
requires:
  - phase: 17-worksheet-detail plan 01
    provides: openWorksheetDrawer action in ui-store + useWorksheetDrawer hook + backend endpoints
  - phase: 17-worksheet-detail plan 02
    provides: WorksheetDrawer component, WorksheetDrawerItems, WorksheetDrawerHeader, AddSamplesModal, all drawer UI wired into MainWindow
provides:
  - Hash route #hplc-analysis/worksheet-detail?id=X opens floating worksheet drawer with specified worksheet active
  - Start Prep workflow with sample ID, peptide, and SENAITE tab pre-filled from worksheet item
  - prep_started indicator per item persisted via corrected prepKey (sample_id not sample_uid)
  - User notes separated from internal prep_started metadata in worksheet notes JSON
  - Human-verified end-to-end worksheet drawer workflow (all 11 steps passing)
affects: [future phases that deep-link to worksheets, any feature consuming worksheet navigation]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Hash nav drawer pattern: applyNavToStore adds drawer-open case without touching buildHash or subscribe — prevents feedback loop"
    - "Notes JSON separation: user-facing notes key distinct from internal metadata keys in the same JSON store"
    - "PrepKey identity: sample_id (not sample_uid) is the correct stable key for prep_started flags in worksheet items"

key-files:
  created: []
  modified:
    - src/lib/hash-navigation.ts
    - backend/main.py
    - src/components/hplc/WorksheetDrawer.tsx
    - src/components/hplc/WorksheetDrawerHeader.tsx
    - src/components/hplc/WorksheetDrawerItems.tsx
    - src/components/hplc/wizard/steps/Step1SampleInfo.tsx
    - src/lib/api.ts

key-decisions:
  - "Hash nav for drawer uses one-way parse only: #hplc-analysis/worksheet-detail?id=X opens the drawer, but FAB clicks produce no hash change — avoids feedback loop per Pitfall 4"
  - "prepKey must be sample_id not sample_uid — sample_uid is the SENAITE UID (alphanumeric), sample_id is the stable local ID used consistently across prep_started flag storage and lookup"
  - "Notes JSON stores user text under 'notes' key; prep_started flags stored under 'prep_started' key in same JSON — prevents raw metadata leaking into notes textarea"
  - "Peptide pre-fill sourced from worksheet item's service group analysis service linkage — requires peptide_id added to item serialization in backend"

patterns-established:
  - "Hash navigation drawer pattern: extend applyNavToStore with new case, leave buildHash and subscribe unchanged"

requirements-completed: [WSHT-06, WSHT-07, WSHT-01, WSHT-04]

# Metrics
duration: ~60min (including E2E verification and 3 bug fixes)
completed: 2026-04-01
---

# Phase 17 Plan 03: Worksheet Hash Navigation + E2E Verification Summary

**Hash route #hplc-analysis/worksheet-detail?id=X wired to open floating worksheet drawer; Start Prep workflow pre-fills sample ID, peptide, and SENAITE tab; 3 E2E bugs fixed and all 11 verification steps passed by human**

## Performance

- **Duration:** ~60 min
- **Started:** 2026-04-01T13:00:00Z
- **Completed:** 2026-04-01T14:01:43Z
- **Tasks:** 2 (1 auto + 1 human-verify checkpoint)
- **Files modified:** 7

## Accomplishments

- Extended `applyNavToStore` in hash-navigation.ts with worksheet-detail route handling — entering `#hplc-analysis/worksheet-detail?id=X` in the URL bar opens the floating drawer with that worksheet active, with no feedback loop and no hash change on FAB click
- Fixed 3 bugs discovered during E2E Playwright verification: prepKey mismatch preventing the Prep Started indicator from ever matching, notes textarea displaying raw JSON metadata, and Start Prep not pre-filling peptide from service group
- Added `peptide_id` to worksheet item serialization in the backend so the prefill payload carries the peptide through to Step1SampleInfo
- Human verified the complete worksheet drawer workflow across all 11 verification steps — feature ships

## Task Commits

1. **Task 1: Hash navigation drawer route** - `0ed2a28` (feat)
2. **Bug fixes post-checkpoint** - `b7269e1` (fix) — prepKey mismatch, notes JSON leak, peptide pre-fill

## Files Created/Modified

- `src/lib/hash-navigation.ts` — Added `worksheet-detail` case to `applyNavToStore`; `buildHash` and subscribe left unchanged
- `backend/main.py` — Added `peptide_id` to worksheet item serialization via service group → analysis service lookup
- `src/components/hplc/WorksheetDrawer.tsx` — Fixed notes JSON separation (user notes vs prep_started metadata); fixed prepKey to use `sample_id`
- `src/components/hplc/WorksheetDrawerHeader.tsx` — Notes display isolation fix
- `src/components/hplc/WorksheetDrawerItems.tsx` — Minor display fix for notes rendering
- `src/components/hplc/wizard/steps/Step1SampleInfo.tsx` — Consume `worksheetPrepPrefill` to pre-fill sample ID, peptide, and SENAITE tab; preserve peptide selection across tab switches when prefill active
- `src/lib/api.ts` — Added `peptide_id` field to worksheet item type

## Decisions Made

- Hash navigation for the drawer is one-way parse only: the route opens the drawer but the drawer does not write back to the URL hash. This is intentional per Pitfall 4 in the research notes — the subscribe condition watches `activeSection`/`activeSubSection` only, preventing a feedback loop where opening the drawer would push a new hash that re-fires applyNavToStore.
- `prepKey` must match `sample_id` (the local stable ID used at assignment time) not `sample_uid` (the SENAITE alphanumeric UID). The bug was silent — the indicator stored under one key and looked up under a different one.
- Notes JSON uses a `notes` key for user text and a `prep_started` key for internal flags. Storing them in the same JSON column is acceptable; they just need distinct keys so neither leaks into the user-facing textarea.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed prepKey mismatch causing Prep Started indicator to never appear**
- **Found during:** Task 2 (human-verify E2E)
- **Issue:** `WorksheetDrawerItems` stored prep_started flags under `sample_uid` (SENAITE alphanumeric) but the indicator lookup used `sample_id` (local numeric ID). They never matched, so the indicator never rendered after Start Prep.
- **Fix:** Standardized on `sample_id` throughout — storage and lookup now use the same key
- **Files modified:** src/components/hplc/WorksheetDrawer.tsx, src/components/hplc/WorksheetDrawerItems.tsx
- **Verification:** Start Prep click followed by drawer re-open showed "Prep started" indicator — E2E step 8 passed
- **Committed in:** b7269e1

**2. [Rule 1 - Bug] Fixed notes textarea displaying raw JSON metadata**
- **Found during:** Task 2 (human-verify E2E)
- **Issue:** The worksheet notes column stored a JSON blob `{"notes":"...","prep_started":{...}}`. The notes textarea was rendering the entire JSON string including the `prep_started` metadata section, visible to the user.
- **Fix:** Parse the JSON in WorksheetDrawerHeader and WorksheetDrawer; display only the `notes` key value; write back only the `notes` key on save (preserving other keys in the JSON)
- **Files modified:** src/components/hplc/WorksheetDrawerHeader.tsx, src/components/hplc/WorksheetDrawer.tsx
- **Verification:** Notes textarea shows clean user text; saving a note preserves existing prep_started flags — E2E step 4 passed
- **Committed in:** b7269e1

**3. [Rule 1 - Bug] Fixed Start Prep not pre-filling peptide ID from service group**
- **Found during:** Task 2 (human-verify E2E)
- **Issue:** `worksheetPrepPrefill` payload carried `peptideId: null` because the worksheet item serialization in the backend didn't include `peptide_id`. The analysis wizard Step1SampleInfo had no value to pre-fill.
- **Fix:** Added `peptide_id` to worksheet item serialization in `backend/main.py` via service group → analysis service lookup; updated `api.ts` type; wired the prefill value into Step1SampleInfo's peptide selector and ensured it persists across tab switches
- **Files modified:** backend/main.py, src/lib/api.ts, src/components/hplc/wizard/steps/Step1SampleInfo.tsx
- **Verification:** Start Prep click navigated to wizard with peptide pre-selected — E2E step 8 fully passed
- **Committed in:** b7269e1

---

**Total deviations:** 3 auto-fixed (all Rule 1 - Bug)
**Impact on plan:** All three bugs were silent failures discovered only under E2E conditions. Fixes were necessary for the feature to meet its acceptance criteria. No scope creep — all fixes directly within the worksheet drawer subsystem.

## Issues Encountered

All issues were caught and resolved during the human-verify checkpoint. The feature was not mergeable without the bug fixes — the checkpoint gate served its purpose correctly.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Phase 17 is complete. The floating worksheet clipboard drawer is fully shipped:
- Backend endpoints for worksheet CRUD, item management, completion, and reassignment
- Zustand drawer state with `openWorksheetDrawer`, `startPrepFromWorksheet`, `worksheetPrepPrefill`
- Full drawer UI: tabs, editable header, items list with all WSHT-03 fields, Add Samples modal, Complete Worksheet dialog
- Hash navigation: `#hplc-analysis/worksheet-detail?id=X` deep-links to a specific worksheet
- Start Prep → wizard pre-fill → Prep Started indicator loop working end-to-end

No blockers for subsequent phases.

---
*Phase: 17-worksheet-detail*
*Completed: 2026-04-01*
