---
phase: 10-auto-create-curve-from-standard
plan: 02
subsystem: wizard-ui
tags: [wizard, standard-prep, concentration-editor, step-routing]
dependency-graph:
  requires: [09-01]
  provides: [standard-wizard-flow, concentration-editor, standard-step-builder]
  affects: [10-03]
tech-stack:
  added: []
  patterns: [standard-dilution-step-type, buildStandardWizardSteps]
key-files:
  created: []
  modified:
    - src/store/wizard-store.ts
    - src/components/hplc/wizard/steps/Step1SampleInfo.tsx
    - src/components/hplc/CreateAnalysis.tsx
decisions:
  - Standard wizard uses buildStandardWizardSteps (1 stock + N dilutions) separate from production buildWizardSteps
  - Concentration levels sorted descending for serial dilution order
  - Each standard dilution gets its own vialNumber for measurement tracking
  - Minimum 3 concentration levels enforced at submit
  - Default total volume per dilution is 1000 uL
  - Standard-dilution steps reuse Step3Dilution component (same measurement flow)
  - Target conc/vol fields hidden for standards (replaced by concentration level editor)
metrics:
  duration: ~5 min
  completed: 2026-03-17
---

# Phase 10 Plan 02: Standard Wizard Step Builder + Concentration Editor Summary

Standard multi-dilution wizard flow with configurable concentration levels, standard step builder generating 1 stock + N dilution steps, and step routing in the stepper.

## Task Commits

| # | Task | Commit | Key Changes |
|---|------|--------|-------------|
| 1 | Standard step builder + store updates | 05db361 | buildStandardWizardSteps, standard-dilution type, unlock/complete logic, startSession branching, setStandardConcentrations action |
| 2 | Concentration editor + stepper routing | 0d19ce0 | Concentration level editor in Step1 amber container, standard vial_params building, stepper routing for standard-dilution |

## Decisions Made

1. **Separate builder function** -- `buildStandardWizardSteps` is completely separate from `buildWizardSteps`, keeping production flow untouched.
2. **Descending sort** -- Concentrations sorted highest-first for serial dilution order.
3. **vialNumber per dilution** -- Each standard-dilution step gets its own vialNumber (1-based index) for independent measurement tracking.
4. **Minimum 3 levels** -- Enforced at submit time with user-facing error message.
5. **Reuse Step3Dilution** -- Standard-dilution steps render the same dilution component, since the measurement flow is identical per-vial.
6. **CreateAnalysis.tsx is the stepper** -- Plan referenced `WizardStepper.tsx` which doesn't exist; the actual step routing lives in `CreateAnalysis.tsx`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] WizardStepper.tsx does not exist**
- **Found during:** Task 2
- **Issue:** Plan referenced `WizardStepper.tsx` for step routing, but the actual routing is in `CreateAnalysis.tsx`
- **Fix:** Applied all stepper changes to `CreateAnalysis.tsx` instead
- **Files modified:** src/components/hplc/CreateAnalysis.tsx

**2. [Rule 2 - Missing Critical] lastStepDone check didn't handle standard-dilution**
- **Found during:** Task 1
- **Issue:** The save button enablement in CreateAnalysis only checked for `'dilution'` step type
- **Fix:** Extended check to include `'standard-dilution'`
- **Files modified:** src/components/hplc/CreateAnalysis.tsx

**3. [Rule 2 - Missing Critical] canSubmit and target field visibility for standards**
- **Found during:** Task 2
- **Issue:** canSubmit required target conc/vol which standards don't use; target fields still showed for standards
- **Fix:** Added `standardReady` check, hid target/declared-weight fields when `isStandard` is true
- **Files modified:** src/components/hplc/wizard/steps/Step1SampleInfo.tsx

## Self-Check: PASSED
