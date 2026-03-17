---
phase: 10
plan: 03
subsystem: hplc-standard-curve
tags: [hplc, calibration, standard-prep, linear-regression, flyout]
depends_on:
  requires: [10-01, 10-02]
  provides: [standard-curve-creation-ui, flyout-standard-detection]
  affects: [future-calibration-management]
tech-stack:
  added: []
  patterns: [client-side-regression-preview, conditional-branch-rendering]
key-files:
  created:
    - src/components/hplc/StandardCurveReview.tsx
  modified:
    - src/components/hplc/SamplePrepHplcFlyout.tsx
decisions:
  - Vial-to-injection mapping uses sorted index position (vial_number ascending, injection name natural sort)
  - Client-side linear regression is preview only — backend computes authoritative values
  - Standard branch is purely additive — non-standard flyout flow completely unchanged
  - First chromatogram trace used for provenance data on curve
metrics:
  duration: ~5 min
  completed: 2026-03-17
---

# Phase 10 Plan 03: HPLC Flyout Standard Curve Wiring Summary

**One-liner:** StandardCurveReview component with client-side regression preview, wired into HPLC flyout via is_standard detection and vial_data concentration extraction.

## What Was Done

### Task 1: StandardCurveReview Component
Created `StandardCurveReview.tsx` — a self-contained component that:
- Displays a data table of concentration/area/RT per level (font-mono numbers)
- Computes client-side linear regression for preview (slope, intercept, R-squared)
- Shows amber warning when R-squared < 0.99
- Shows error state when fewer than 3 valid data points
- Displays provenance info (source sample, vendor, instrument)
- Calls `createCalibrationFromStandard` endpoint on confirm
- Shows loading spinner during submission, success/error alerts after

### Task 2: HPLC Flyout Standard Detection
Modified `SamplePrepHplcFlyout.tsx` to:
- Detect `prep.is_standard === true`
- Show "Standard" / "Curve Created" badge in flyout header
- Extract concentration/area/RT triples by mapping sorted vial_data to sorted injections
- Extract chromatogram data from first valid DAD1A trace
- Render StandardCurveReview instead of normal calibration/weights section
- Track curve creation success state
- Non-standard flow entirely unaffected (additive conditional branch)

## Task Commits

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | StandardCurveReview component | 4d1e4e5 | StandardCurveReview.tsx |
| 2 | Wire standard detection into flyout | 6064905 | SamplePrepHplcFlyout.tsx |

## Decisions Made

1. **Vial-to-injection mapping by sorted index** — Vials sorted by vial_number ascending, injections by name (natural sort). Paired by position. This works because the wizard generates vials in dilution order and HPLC instruments inject in sequence.

2. **Client-side regression is preview only** — The displayed slope/intercept/R-squared are for user review before confirming. The backend endpoint computes the authoritative regression when the curve is created.

3. **Additive branching** — Standard detection is a pure `if (isStandard)` branch. No existing code paths were modified. The non-standard flow is identical to before.

## Deviations from Plan

None — plan executed exactly as written.

## Awaiting Human Verification

Task 3 is a `checkpoint:human-verify` gate. The full end-to-end flow needs manual testing:
1. Standard wizard session creation
2. HPLC flyout standard detection
3. Curve preview with regression stats
4. Curve creation via backend endpoint

## Self-Check: PASSED
