---
phase: 05-senaite-sample-lookup
plan: 02
subsystem: ui
tags: [react, senaite, tabs, wizard, step1, form, lookup]

# Dependency graph
requires:
  - phase: 05-01
    provides: getSenaiteStatus, lookupSenaiteSample, SenaiteLookupResult types in api.ts
  - phase: 04-wizard-ui
    provides: Step1SampleInfo base form, wizard store, createWizardSession
provides:
  - Two-tab Step1SampleInfo with SENAITE Lookup and Manual Entry
  - SENAITE sample search with auto-population of peptide, sample ID, declared weight
  - Blend analyte display with match/no-match indicators
  - Graceful degradation when SENAITE is disabled (manual tab only)
affects: [future SENAITE phases, wizard UX improvements]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "SENAITE status check on mount with cancellation flag pattern (same as loadPeptides)"
    - "Tabs UI with controlled activeTab state + handleTabChange clearing all cross-tab state"
    - "Shared form state (peptideId, sampleIdLabel, declaredWeightMg) populated by both tabs, consumed by same handleSubmit"
    - "lookupResult blue card vs session green card — distinct visual language for lookup vs confirmed state"

key-files:
  created: []
  modified:
    - src/components/hplc/wizard/steps/Step1SampleInfo.tsx

key-decisions:
  - "Tabs component controlled via activeTab state; handleTabChange clears all fields on switch per user decision"
  - "Manual entry shown directly (no tabs) when SENAITE disabled — checkingStatus guard prevents flash"
  - "checkingStatus loader shown while getSenaiteStatus() is in-flight to avoid tab flash"
  - "void handleLookup() used for onClick handlers to satisfy no-floating-promises pattern"
  - "Shared peptideDropdown and targetFields JSX variables to avoid duplication between tabs"

patterns-established:
  - "Pattern: SENAITE-gated tabs — check status on mount, show tabs or single form based on result"
  - "Pattern: Blue summary card for SENAITE lookup results (distinct from green session confirmation)"

# Metrics
duration: 3min
completed: 2026-02-20
---

# Phase 5 Plan 02: Step1SampleInfo SENAITE Lookup Tabs Summary

**Two-tab wizard Step 1 with SENAITE sample ID lookup, auto-population of peptide/weight/analytes, and graceful fallback to manual entry**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-02-20T06:48:18Z
- **Completed:** 2026-02-20T06:50:46Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments

- Rewrote Step1SampleInfo.tsx from 299 lines to 521 lines with full two-tab SENAITE lookup UI
- SENAITE Lookup tab: search field + Look Up button, blue result card showing sample ID, declared weight, and all analyte names with match indicators, peptide override dropdown, target conc/vol fields
- Manual Entry tab: identical to previous form — peptide dropdown, sample ID label, declared weight, target conc/vol
- getSenaiteStatus() on mount determines which UI is shown; checkingStatus guard prevents premature tab rendering
- Switching tabs clears all cross-populated state (per user decision from Phase 5 context)
- Session creation path (createWizardSession) unchanged regardless of which tab populated the fields
- Existing read-only green session summary unchanged

## Task Commits

Each task was committed atomically:

1. **Task 1: Rewrite Step1SampleInfo with SENAITE lookup tabs** - `80d4f17` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `src/components/hplc/wizard/steps/Step1SampleInfo.tsx` - Full rewrite: two-tab SENAITE/Manual UI, lookup flow, blue summary card, auto-population, graceful fallback

## Decisions Made

- `handleTabChange` clears `peptideId`, `sampleIdLabel`, `declaredWeightMg` on every tab switch — ensures no data leaks between entry modes
- Blue border/bg for SENAITE result card visually distinguishes from the green session-created card
- `checkingStatus` loading state prevents tabs from flashing before SENAITE status is known
- Analytes shown with checkmark (green) for matched peptide, circle (muted) for unmatched — clear visual
- `void handleLookup()` in event handlers satisfies ESLint floating-promises without async wrappers
- Shared `peptideDropdown` and `targetFields` JSX variables used across tab content — DRY

## Deviations from Plan

None — plan executed exactly as written. All implementation details from the plan spec were followed precisely:
- Zustand selector syntax throughout (no destructuring)
- Same `cancellation flag` pattern as existing `loadPeptides` used for `checkSenaiteStatus`
- `createWizardSession` path unchanged, same for both tabs
- Error messages use backend `detail` field directly (propagated from `lookupSenaiteSample`)

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required. SENAITE_URL env var documented in Phase 5 plan 01.

## Next Phase Readiness

Phase 5 is complete. Both plans executed:
- 05-01: SENAITE backend endpoints (GET /wizard/senaite/status, GET /wizard/senaite/lookup) + api.ts functions
- 05-02: Step1SampleInfo two-tab UI consuming those endpoints

The full SENAITE sample lookup flow is working end-to-end. Tech can now:
1. Type a SENAITE sample ID and click "Look Up"
2. See sample details auto-populate (ID, weight, analytes with match indicators)
3. Override the auto-selected peptide if needed
4. Fill in target conc/vol
5. Create session — which uses the identical path as manual entry

No blockers for future phases.

---
*Phase: 05-senaite-sample-lookup*
*Completed: 2026-02-20*

## Self-Check: PASSED
