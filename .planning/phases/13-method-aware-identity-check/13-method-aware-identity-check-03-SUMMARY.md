---
phase: 13-method-aware-identity-check
plan: 03
subsystem: ui
tags: [typescript, react, hplc, identity-check, standard-injection]

# Dependency graph
requires:
  - phase: 13-method-aware-identity-check plan 01
    provides: backend parses _std_ files and returns standard_injections in HPLCParseResponse

provides:
  - StandardInjection TypeScript interface in api.ts
  - standard_injections field on HPLCParseResult
  - standard_injection_rts field on HPLCAnalyzeRequest
  - identity_reference_source / identity_reference_source_id fields on HPLCAnalysisResult
  - Flyout builds and passes standard_injection_rts to every runHPLCAnalysis call
  - Identity card in AnalysisResults shows reference source (standard injection with sample ID or calibration curve)

affects: [13-method-aware-identity-check plan 02 (backend consume standard_injection_rts)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Standard injection RT dict built from parseResult.standard_injections in runAllAnalyses, passed as standard_injection_rts to both blend and single-peptide API calls"
    - "Identity card uses two-line compact layout: RT delta on first line, reference source + peptide on second"

key-files:
  created: []
  modified:
    - src/lib/api.ts
    - src/components/hplc/SamplePrepHplcFlyout.tsx
    - src/components/hplc/AnalysisResults.tsx

key-decisions:
  - "stdInjRts is undefined (not empty object) when no standard injections present — backend receives no field, uses calibration curve path unchanged"
  - "identity_reference_source_id displayed in font-mono to distinguish sample IDs from prose text"
  - "Console log of found standard injections added at parse time for operator debug visibility"

patterns-established:
  - "Phase 13 fields annotated with // Phase 13: comment for grep-ability across the codebase"

# Metrics
duration: 5min
completed: 2026-03-19
---

# Phase 13 Plan 03: Frontend Wire-Through for Standard Injection Identity Check

**TypeScript types and flyout updated to pass standard injection RTs to analyze API; identity card now shows 'Ref: Standard injection (P-0111)' or 'Ref: Calibration curve' for full audit transparency.**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-03-19T19:58:12Z
- **Completed:** 2026-03-19T20:03:00Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Added `StandardInjection` interface and wired it through `HPLCParseResult`, `HPLCAnalyzeRequest`, and `HPLCAnalysisResult` types
- Flyout builds `standard_injection_rts` dict from parse result and passes it automatically to every `runHPLCAnalysis` call (both blend and single-peptide branches)
- Identity card in AnalysisResults displays reference source type and source sample ID in a compact two-line layout

## Task Commits

Each task was committed atomically:

1. **Task 1: Update TypeScript types and wire standard_injection_rts through flyout** - `2383239` (feat)
2. **Task 2: Display identity reference source in AnalysisResults identity card** - `de55576` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified
- `src/lib/api.ts` - StandardInjection interface, standard_injections on HPLCParseResult, standard_injection_rts on HPLCAnalyzeRequest, identity_reference_source/identity_reference_source_id on HPLCAnalysisResult
- `src/components/hplc/SamplePrepHplcFlyout.tsx` - build stdInjRts from parse result, pass to both runHPLCAnalysis calls, log standard injection count post-parse
- `src/components/hplc/AnalysisResults.tsx` - identity card two-line display with reference source and source sample ID

## Decisions Made
- `stdInjRts` is `undefined` (not `{}`) when no standard injections present — prevents sending an empty object that could confuse backend logic
- Source sample ID wrapped in `font-mono` span for visual distinction from prose labels
- Console log for found standard injections is `console.log` (not `push('info', ...)`) since parse occurs in `loadPeakData` outside the debug panel context

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] stdInjRts built but not yet passed to analysis calls**
- **Found during:** Task 1 (IDE diagnostics flagged TS error 6133 after building stdInjRts)
- **Issue:** Variable declared but never read — lint error would fail the build
- **Fix:** Immediately added `standard_injection_rts: stdInjRts` to both runHPLCAnalysis calls in the same task
- **Files modified:** src/components/hplc/SamplePrepHplcFlyout.tsx
- **Verification:** `npm run typecheck` passes cleanly
- **Committed in:** 2383239 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Fix was the intended next step in the same task; no scope creep.

## Issues Encountered
None beyond the blocking deviation above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Frontend fully wired: standard injection data flows parse → flyout state → analyze request
- Backend (Plan 02) must accept `standard_injection_rts` in HPLCAnalyzeRequest and return `identity_reference_source` / `identity_reference_source_id` in HPLCAnalysisResult
- Once Plan 02 lands, the identity card will automatically display the correct reference source on live runs

---
*Phase: 13-method-aware-identity-check*
*Completed: 2026-03-19*

## Self-Check: PASSED
