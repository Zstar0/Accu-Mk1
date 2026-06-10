---
phase: 12-chromatogram-overlay
plan: 01
subsystem: ui
tags: [recharts, typescript, chromatogram, hplc, calibration]

# Dependency graph
requires:
  - phase: 10.5-hplc-results-persistence
    provides: chromatogram_data stored on hplc_analyses (traces shape established)
  - phase: 11-backfill-existing-curves
    provides: CalibrationCurve chromatogram_data backfill (single-trace and multi-conc formats)
provides:
  - ChromatogramTrace interface with optional style field (dashed, opacity)
  - ChromatogramChart renders per-trace visual styling via recharts Line props
  - extractStandardTrace() helper converts calibration chromatogram_data to styled trace
affects:
  - 12-02 (wire extractStandardTrace into SamplePrepHplcFlyout overlay)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Optional style field on trace interface — caller sets dashed/opacity, renderer applies"
    - "extractStandardTrace picks highest concentration key for multi-conc data"

key-files:
  created: []
  modified:
    - src/components/hplc/ChromatogramChart.tsx

key-decisions:
  - "Dashed traces get strokeWidth 1 vs 1.5 for visual hierarchy (thinner = background)"
  - "strokeDasharray '6 3' for clean dash pattern on standard reference traces"
  - "Highest concentration key selected for multi-conc overlays — tallest peaks = best alignment reference"
  - "extractStandardTrace returns null (not throws) for empty/invalid data — caller decides skip behavior"
  - "downsampleLTTB(raw, 5000) used in extractStandardTrace — consistent with StandardChromatogramViewer"
  - "Style hardcoded in extractStandardTrace to dashed+0.4 opacity — visual hierarchy enforced at extraction point"

patterns-established:
  - "Per-trace optional style on ChromatogramTrace — extend by adding fields to style object, not new props"

# Metrics
duration: 2min
completed: 2026-03-18
---

# Phase 12 Plan 01: Chromatogram Overlay Foundation Summary

**ChromatogramTrace extended with optional dashed/opacity style; recharts Line renders per-trace styling; extractStandardTrace() converts calibration chromatogram_data (single or multi-conc) to a dashed 40%-opacity reference trace**

## Performance

- **Duration:** ~2 min
- **Started:** 2026-03-19T01:51:45Z
- **Completed:** 2026-03-19T01:53:03Z
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments

- ChromatogramTrace interface now supports optional `style` with `dashed` and `opacity` fields — fully backward compatible (existing callers unaffected)
- ChromatogramChart Line rendering applies conditional `strokeDasharray="6 3"` and `strokeOpacity` per trace when style is present
- `extractStandardTrace()` exported helper handles both old `{times, signals}` single-trace format and new `{"1": {times, signals}, "10": {...}}` multi-concentration format
- For multi-conc data, highest numeric concentration key is selected for best visual reference alignment
- Returns `null` for empty/invalid data so callers can skip cleanly

## Task Commits

Each task was committed atomically:

1. **Task 1: Add optional style to ChromatogramTrace and update chart rendering** - `333d96b` (feat)
2. **Task 2: Add extractStandardTrace helper function** - `dbdd520` (feat)

**Plan metadata:** (committed with SUMMARY/STATE update)

## Files Created/Modified

- `src/components/hplc/ChromatogramChart.tsx` - Extended interface + Line style rendering + extractStandardTrace helper

## Decisions Made

- Dashed traces get strokeWidth 1 (vs 1.5 for solid) — thinner dashed line reads as background/reference
- `strokeDasharray="6 3"` — clean visual dash without looking noisy
- Highest concentration key picked for multi-conc: tallest peaks give best alignment reference, consistent with CalibrationPanel's StandardChromatogramViewer sort order
- `extractStandardTrace` returns null on empty/invalid — non-throwing, caller controls skip logic
- Style hardcoded at extraction point (dashed + 0.4 opacity) — enforces visual hierarchy convention, not left to callers

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Foundation complete for Plan 02: wire `extractStandardTrace` into `SamplePrepHplcFlyout` to overlay the standard chromatogram behind sample traces
- `extractStandardTrace` is exported and ready to import in the flyout
- No blockers

---
*Phase: 12-chromatogram-overlay*
*Completed: 2026-03-18*

## Self-Check: PASSED
