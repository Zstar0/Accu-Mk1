---
phase: 04-wizard-ui
plan: 02
subsystem: ui
tags: [react, wizard, weighing, tauri, shadcn, zustand, api]

# Dependency graph
requires:
  - phase: 04-01
    provides: PrepWizardStore, wizard API functions, CreateAnalysis layout shell, WizardStepList, WizardStepPanel
  - phase: 01-wizard-db
    provides: wizard session DB model, measurements table, calculations derived on save
  - phase: 03-sse-weight-streaming
    provides: WeightInput component with scale SSE / manual modes

provides:
  - Step1SampleInfo: peptide dropdown, target params, createWizardSession call
  - Step2StockPrep: 4 sub-steps (empty vial, transfer confirm, diluent display, loaded vial) with inline calcs
  - Step3Dilution: 3 sub-steps (empty dil vial, add diluent, add stock) with inline actual calcs
  - CreateAnalysis wired with real step components for steps 1-3

affects: [04-03]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Sub-step locking: check session.measurements.find(m => m.step_key === 'key' && m.is_current)"
    - "Re-weigh: local boolean flag resets display to WeightInput, API inserts new measurement with is_current=True"
    - "Session ID captured as const before async handlers to avoid TypeScript null-narrowing issue in closures"
    - "Read-only step summary: if session !== null skip the form, show session data"

key-files:
  created:
    - src/components/hplc/wizard/steps/Step1SampleInfo.tsx
    - src/components/hplc/wizard/steps/Step2StockPrep.tsx
    - src/components/hplc/wizard/steps/Step3Dilution.tsx
  modified:
    - src/components/hplc/CreateAnalysis.tsx

key-decisions:
  - "sessionId captured as const before async handler definitions to fix TS null-narrowing in async closures"
  - "transferConfirmed OR meas2d exists = transfer done (entering loaded weight implies transfer)"
  - "Sub-step locking: step N locked if previous measurement not in session.measurements (same pattern both steps)"
  - "Re-weigh uses local boolean state, not API call — WeightInput shown again, next Accept inserts new measurement"

patterns-established:
  - "Sub-step done check: session.measurements.find(m => m.step_key === KEY && m.is_current)"
  - "Sub-step locking: opacity-50 on Card when locked, disabled Button when locked"
  - "Inline calcs summary card: border-green-500/40 bg-green-50/30 shown when allComplete && calcs"
  - "Required volumes display card: border-blue-500/30 shown at top of step when calcs available"

# Metrics
duration: 4min
completed: 2026-02-20
---

# Phase 4 Plan 02: Wizard Steps 1-3 Summary

**Session creation form with peptide dropdown (Step 1), 4-sub-step stock prep with WeightInput and inline stock_conc calculations (Step 2), and 3-sub-step dilution with inline actual_conc calculations (Step 3) wired to FastAPI wizard endpoints**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-02-20T05:07:07Z
- **Completed:** 2026-02-20T05:10:33Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Step1SampleInfo: peptide dropdown from GET /peptides, target conc/vol fields, createWizardSession on submit, read-only summary on revisit
- Step2StockPrep: 4 sequential sub-steps (empty vial weight, transfer confirmation, diluent volume display, loaded vial weight) with WeightInput + inline stock_conc/required_volume summary card
- Step3Dilution: 3 sequential sub-steps (empty dil vial, vial+diluent, final vial) with WeightInput + inline actual_conc/actual_volumes summary card
- CreateAnalysis.tsx wired to render real step components for steps 1-3

## Task Commits

Each task was committed atomically:

1. **Task 1: Step1SampleInfo — session creation form** - `206561b` (feat)
2. **Task 2: Step2StockPrep, Step3Dilution, wire CreateAnalysis** - `6046c2c` (feat)

## Files Created/Modified
- `src/components/hplc/wizard/steps/Step1SampleInfo.tsx` - Session creation form with peptide select, targets, read-only revisit view
- `src/components/hplc/wizard/steps/Step2StockPrep.tsx` - Stock prep step: 4 sub-steps, WeightInput, transfer confirm, inline calcs
- `src/components/hplc/wizard/steps/Step3Dilution.tsx` - Dilution step: 3 sub-steps, WeightInput, inline actual calcs
- `src/components/hplc/CreateAnalysis.tsx` - Imports and renders Step1-3 components (replaces placeholders)

## Decisions Made
- Captured `const sessionId = session.id` before async handler definitions to avoid TypeScript narrowing loss in async closures (TS18047 errors otherwise)
- `transferConfirmed || meas2d != null` for transfer done check — if loaded weight exists, transfer must have happened (idempotent on session reload)
- Re-weigh: local boolean state resets sub-step to show WeightInput again; next Accept call inserts new measurement via API (server sets is_current=True, old=False)
- Peptides loaded with useEffect + local state (matches codebase pattern in PeptideConfig.tsx — not TanStack Query)

## Deviations from Plan

None - plan executed exactly as written. One TypeScript type fix was needed (sessionId const extraction) but that was a straightforward implementation detail, not a plan deviation.

## Issues Encountered
- TypeScript error TS18047 (`session` possibly null in async handlers): fixed by capturing `const sessionId = session.id` before the handler functions — TypeScript doesn't maintain narrowing across async function boundaries.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Steps 1-3 are fully functional and wired to wizard store
- Step 4 (Results/Peak Area input) and Step 5 (Summary/completion) are next — plan 04-03
- Step 4 unlocks when `calculations.actual_conc_ug_ml` is populated (after Step 3 complete)
- WeightInput falls back to manual mode automatically when scale is offline

---
*Phase: 04-wizard-ui*
*Completed: 2026-02-20*

## Self-Check: PASSED
