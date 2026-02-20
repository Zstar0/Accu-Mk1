---
phase: 04-wizard-ui
plan: 01
subsystem: ui
tags: [zustand, react, wizard, api, tailwind, animation, step-machine]

# Dependency graph
requires:
  - phase: 01-wizard-db
    provides: WizardSession and WizardMeasurement DB models, wizard endpoints in main.py
  - phase: 03-sse-weight-streaming
    provides: WeightInput component for step weight capture
provides:
  - PrepWizardStore with session state, stepStates field, step navigation, canAdvance()
  - 6 wizard API functions with TypeScript interfaces matching backend Pydantic schemas
  - WizardPage split-panel layout (step sidebar + animated content area)
  - WizardStepList with 4-state visual indicators
  - WizardStepPanel with directional slide animations
affects:
  - 04-02 (step components mount into this layout shell)
  - 04-03 (additional step components)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - stepStates as stable Zustand field (not computed fn) prevents render cascades
    - deriveStepStates pure function keeps stepStates in sync across all store actions
    - useWizardStore.getState() in click handlers per architecture rules
    - Directional animation via useRef tracking previous stepId

key-files:
  created:
    - src/store/wizard-store.ts
    - src/components/hplc/wizard/WizardStepList.tsx
    - src/components/hplc/wizard/WizardStepPanel.tsx
  modified:
    - src/lib/api.ts
    - src/components/hplc/CreateAnalysis.tsx

key-decisions:
  - "stepStates stored as Zustand field (not computed selector) for stable reference"
  - "deriveStepStates exported as pure function usable outside the store"
  - "setCurrentStep silently rejects locked target steps (no error thrown)"
  - "canAdvance() is a store method (reads current state via get()) not a selector"

patterns-established:
  - "Wizard store: startSession/updateSession both call deriveStepStates to keep stepStates in sync"
  - "WizardStepPanel: direction tracked in ref, key={stepId} forces remount for animation restart"
  - "Navigation footer: Next disabled when currentStep===5 OR !canAdvance()"

# Metrics
duration: 2min
completed: 2026-02-20
---

# Phase 4 Plan 1: Wizard Foundation Summary

**Zustand PrepWizardStore with sequential step state machine, 6 wizard API functions, and Stripe-style split-panel wizard layout with animated transitions and lock-aware navigation**

## Performance

- **Duration:** ~2 min
- **Started:** 2026-02-20T05:00:18Z
- **Completed:** 2026-02-20T05:02:36Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- PrepWizardStore with `stepStates` as a stable Zustand field (derived via `deriveStepStates` pure function on every session/step change), preventing render cascades
- 6 typed wizard API functions (createWizardSession, getWizardSession, listWizardSessions, recordWizardMeasurement, updateWizardSession, completeWizardSession) with 3 TypeScript interfaces matching backend Pydantic schemas
- Split-panel wizard layout: 64px step sidebar with WizardStepList, flex-1 content with WizardStepPanel, Back/Next navigation footer
- WizardStepList renders 5 steps with 4-state visual indicators (not-started: gray number, in-progress: blue filled, complete: green check, locked: gray lock icon)
- WizardStepPanel wraps content with directional slide animations: forward = slide-in-from-right, back = slide-in-from-left

## Task Commits

1. **Task 1: Wizard API functions and PrepWizardStore** - `a3542f0` (feat)
2. **Task 2: WizardPage layout, WizardStepList, and WizardStepPanel** - `5612cfe` (feat)

**Plan metadata:** (see docs commit below)

## Files Created/Modified

- `src/store/wizard-store.ts` - PrepWizardStore with stepStates field, deriveStepStates pure function, WIZARD_STEPS constant
- `src/lib/api.ts` - Added WizardMeasurementResponse, WizardSessionResponse, WizardSessionListItem interfaces + 6 API functions
- `src/components/hplc/CreateAnalysis.tsx` - Rewritten: split-panel layout with WizardStepList sidebar, WizardStepPanel content, Back/Next navigation
- `src/components/hplc/wizard/WizardStepList.tsx` - Vertical step sidebar with 4-state indicators, click handlers via getState()
- `src/components/hplc/wizard/WizardStepPanel.tsx` - Animated content wrapper with directional slide transitions via useRef direction tracking

## Decisions Made

- `stepStates` is a stored Zustand field (not a computed function) so components read a stable reference via selector — only re-renders when `set()` provides a new object
- `setCurrentStep` silently no-ops if target step is `locked` in current `stepStates` (avoids throwing for UI clicks on lock icons)
- `canAdvance()` is a store method reading `get()` at call time — used in click disabled condition with `!canAdvance()` pattern matching architecture rules
- `listWizardSessions` returns `Promise<WizardSessionListItem[]>` flat array (not paginated envelope) matching backend response

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Wizard shell is complete: store, API layer, layout, step list, animated panel all working
- Step 1 shows in-progress (blue), Steps 2-5 show locked (gray lock icon) on fresh load
- Back/Next buttons navigate correctly; Next disabled when locked or on Step 5
- Ready for 04-02: implement Step 1 (Sample Info) and Step 2 (Stock Prep) components to mount into the WizardStepPanel slot
- Step components should call `useWizardStore.getState().startSession()` / `updateSession()` after API calls to keep stepStates in sync

---
*Phase: 04-wizard-ui*
*Completed: 2026-02-20*

## Self-Check: PASSED
