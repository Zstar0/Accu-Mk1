---
phase: 12-chromatogram-overlay
plan: 02
subsystem: ui
tags: [recharts, typescript, chromatogram, hplc, calibration, overlay]

# Dependency graph
requires:
  - phase: 12-01
    provides: extractStandardTrace() exported from ChromatogramChart; ChromatogramTrace style field
provides:
  - SamplePrepHplcFlyout displays overlaid standard (dashed) + sample (solid) chromatogram traces
  - displayChromTraces useMemo prepends standard reference trace from selectedCal.chromatogram_data
  - Standard trace auto-updates on analyte tab switch for blends
  - Graceful fallback to sample-only when chromatogram_data is null
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Standard trace prepended at index 0 in traces array — renders behind sample traces in Recharts"
    - "Type cast to Record<string, unknown> bridges TS interface vs runtime multi-conc format"

key-files:
  created: []
  modified:
    - src/components/hplc/SamplePrepHplcFlyout.tsx

key-decisions:
  - "Standard trace at index 0 (prepended) — Recharts renders in array order, so standard is visually behind sample"
  - "selectedCal added to displayChromTraces dependency array — blend tab switches trigger re-compute correctly"
  - "chromatogram_data cast to Record<string, unknown> — TS interface declares old single-trace shape but runtime may be multi-conc"
  - "Graceful null check: if extractStandardTrace returns null, sample-only traces returned unchanged"

patterns-established:
  - "Overlay trace injection pattern: prepend styled reference trace to filtered sample traces in useMemo"

# Metrics
duration: 3min
completed: 2026-03-18
---

# Phase 12 Plan 02: Standard Chromatogram Overlay Summary

**SamplePrepHplcFlyout now overlays the active calibration curve's chromatogram as a dashed 40%-opacity reference trace behind sample traces, with blend analyte tab switching updating the standard automatically**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-03-19T01:54:00Z
- **Completed:** 2026-03-19T01:57:06Z
- **Tasks:** 1 executed (Task 2 is checkpoint:human-verify — documented below, not blocking)
- **Files modified:** 1

## Accomplishments

- `extractStandardTrace` imported into `SamplePrepHplcFlyout` from ChromatogramChart
- `displayChromTraces` useMemo modified to prepend standard reference trace when `selectedCal.chromatogram_data` is present
- Standard trace renders dashed + 40% opacity (via style applied in `extractStandardTrace`) behind solid sample traces
- `selectedCal` added to useMemo dependency array — blend analyte tab switches update the standard trace automatically
- Type cast (`as unknown as Record<string, unknown>`) bridges the TypeScript interface (old single-trace shape) with the runtime multi-concentration format
- Zero new TypeScript errors

## Task Commits

Each task was committed atomically:

1. **Task 1: Import extractStandardTrace and wire standard overlay into displayChromTraces** - `4f53ac0` (feat)

**Plan metadata:** (committed with SUMMARY/STATE update)

## Files Created/Modified

- `src/components/hplc/SamplePrepHplcFlyout.tsx` - Added extractStandardTrace import; modified displayChromTraces useMemo to prepend standard trace

## Decisions Made

- Standard trace prepended at index 0 — Recharts renders lines in array order; index 0 renders first (visually behind), sample traces render on top
- `selectedCal` in dependency array — handles blend case where switching analyte tabs updates `selectedCalId` → new `selectedCal` reference → memo re-computes
- Graceful null path: if `selectedCal.chromatogram_data` is null/undefined OR `extractStandardTrace` returns null, the original `sampleTraces` array is returned unchanged

## Deviations from Plan

None - plan executed exactly as written.

## Checkpoint for Visual Verification

**Task 2 (checkpoint:human-verify) — not blocking, for user to verify post-execution:**

What was built: HPLC processing flyout now shows overlaid chromatogram traces when a calibration curve with chromatogram_data is selected.

How to verify:
1. Start the dev server (`npm run tauri dev`)
2. Open the Sample Preps view
3. Find a sample prep with HPLC data AND an active calibration curve that has chromatogram_data (from Phase 11 backfill)
4. Click "Process HPLC" to open the flyout
5. Verify the chromatogram chart shows TWO traces:
   - A dashed, lighter trace labeled something like "Std 100 µg/mL" (the standard)
   - A solid trace for the sample injection
6. Verify peaks visually align on the time axis
7. If you have a blend: switch analyte tabs and verify the standard trace updates
8. Find a sample with a calibration curve that has NO chromatogram_data — verify only the sample trace renders (no error)

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 12 complete. All v0.26.0 chromatogram overlay work is done.
- Standard trace overlay wired end-to-end: ChromatogramChart style infrastructure (12-01) → flyout useMemo integration (12-02)
- No blockers for release.

---
*Phase: 12-chromatogram-overlay*
*Completed: 2026-03-18*

## Self-Check: PASSED
