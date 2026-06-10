---
phase: "07"
plan: "02"
subsystem: "analysis-workflow"
tags: ["senaite", "refresh", "silent-fetch", "sample-details", "onTransitionComplete"]

dependency-graph:
  requires:
    - "07-01 — AnalysisTable onTransitionComplete prop + useAnalysisTransition hook"
    - "06-04 — SampleDetails imports AnalysisTable component"
  provides:
    - "refreshSample() silent re-fetch in SampleDetails (no loading spinner)"
    - "onTransitionComplete prop wired from SampleDetails to AnalysisTable"
    - "Post-transition sample-level aggregate refresh (status badge, progress bar, counters)"
  affects:
    - "07-03 — bulk transitions can reuse same refreshSample pattern"
    - "Phase 08 — sample list may also benefit from silent refresh after transitions"

tech-stack:
  added:
    - "None (all existing: lookupSenaiteSample, toast, setData)"
  patterns:
    - "refreshSample() silent variant: calls lookupSenaiteSample without setLoading(true), error → toast"
    - "fetchSample() full variant: setLoading(true), setError(null), error → replace page with error state"
    - "onTransitionComplete callback chain: AnalysisTable -> useAnalysisTransition -> refreshSample -> setData"

key-files:
  created: []
  modified:
    - "src/components/senaite/SampleDetails.tsx"

decisions:
  - decision: "refreshSample does not call setError(null) on entry"
    rationale: "Keeps current error state visible; a background refresh failure shows a toast overlay rather than replacing page content"
  - decision: "refreshSample replaces entire data object via setData(result)"
    rationale: "Full replacement (not partial merge) ensures all derived state — verifiedCount, pendingCount, progressPct, StatusBadge, analyses array — reflects server truth after any SENAITE state machine transition"

metrics:
  duration: "~3 min"
  completed: "2026-02-25"
  tasks-completed: 1
  tasks-total: 1
---

# Phase 07 Plan 02: Silent Sample Refresh After Analysis Transitions Summary

**refreshSample() silent re-fetch wired to AnalysisTable.onTransitionComplete, keeping sample-level status badge, progress bar, and counters in sync after any analysis transition without a loading spinner flash.**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-02-25T06:49:00Z
- **Completed:** 2026-02-25T06:52:16Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments

- Added `refreshSample(id)` function to SampleDetails: calls `lookupSenaiteSample` without `setLoading(true)`, errors show toast instead of replacing page
- Wired `onTransitionComplete={() => refreshSample(data.sample_id)}` to the existing `<AnalysisTable>` render
- Completes REFR-01 (parent sample re-fetched after any analysis transition) and REFR-02 (sample-level auto-transitions visible immediately)
- Combined with Plan 01, ALL Phase 07 requirements are complete (WKFL-01 through WKFL-07, REFR-01, REFR-02)

## Task Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | f6f3fad | feat(07-02): silent refreshSample + onTransitionComplete wiring |

## Files Created/Modified

- `src/components/senaite/SampleDetails.tsx` — Added `refreshSample()` function (lines 440-445) and `onTransitionComplete` prop on `<AnalysisTable>` (line 1073)

## Decisions Made

- `refreshSample` does not call `setError(null)` on entry: keeps current error state; background refresh failure shows toast overlay rather than replacing page content
- `refreshSample` replaces entire `data` object via `setData(result)`: full replacement ensures all derived state (verifiedCount, pendingCount, progressPct, StatusBadge, analyses array) reflects server truth after SENAITE state machine transitions

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

Phase 07 is now complete:
- All per-row workflow transitions (submit, verify, retract, reject) execute via DropdownMenu + AlertDialog
- Post-transition sample-level refresh is silent (no loading flash)
- Sample status badge, progress bar, verified/pending counters, and analyses array all update from fresh server data

Phase 08 (bulk transitions) can proceed. The ALLOWED_TRANSITIONS constants and useAnalysisTransition hook from Plan 01 are ready for reuse in bulk mode.

---
*Phase: 07-per-row-workflow-transitions*
*Completed: 2026-02-25*

## Self-Check: PASSED
