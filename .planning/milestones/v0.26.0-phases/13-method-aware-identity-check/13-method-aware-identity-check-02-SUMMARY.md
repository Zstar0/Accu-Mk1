---
phase: 13-method-aware-identity-check
plan: 02
subsystem: api
tags: [hplc, identity-check, calibration, python, fastapi]

# Dependency graph
requires:
  - phase: 13-method-aware-identity-check plan 01
    provides: StandardInjection dataclass, _std_ detection, HPLCParseResponse.standard_injections

provides:
  - calculate_identity prefers standard injection RT over calibration curve RT when available
  - PeptideParams extended with standard_injection_rt and standard_injection_source
  - /hplc/analyze endpoint accepts standard_injection_rts dict with alias-aware matching
  - HPLCAnalysisResponse exposes identity_reference_source and identity_reference_source_id
  - calculation_trace.identity records reference_source, reference_source_id, calibration_curve_rt

affects:
  - 13-method-aware-identity-check plan 03 (frontend wiring: pass standard_injection_rts, display source badge)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Alias-aware label matching: normalize by stripping non-alphanumeric chars + uppercase, then check hplc_aliases list"
    - "Effective RT selection: prefer standard_injection_rt (same-method), fall back to calibration curve reference_rt"
    - "Audit trail: calibration_curve_rt always included alongside used reference_rt in calculation trace"

key-files:
  created: []
  modified:
    - backend/calculations/hplc_processor.py
    - backend/main.py

key-decisions:
  - "standard_injection_rt takes priority over reference_rt in calculate_identity — eliminates cross-method RT delta (~6+ min false failures)"
  - "calibration_curve_rt always included in identity trace for audit, even when overridden by standard injection"
  - "Alias-aware matching normalizes labels (strip non-alphanumeric, uppercase) and also checks peptide.hplc_aliases"
  - "identity_reference_source and identity_reference_source_id extracted from calculation_trace.identity in _analysis_to_response — no new DB columns"
  - "standard_injection_rts keyed by analyte label (e.g. 'BPC157'), value is {rt, source_sample_id} dict"

patterns-established:
  - "RT source tracking: reference_source field in identity trace indicates 'standard_injection' or 'calibration_curve'"
  - "Backward compatibility: all new fields have Optional defaults — existing callers unaffected"

# Metrics
duration: 3min
completed: 2026-03-19
---

# Phase 13 Plan 02: Method-Aware Identity Check (Calculation Layer) Summary

**Identity checks now use same-method standard injection RTs when available, eliminating cross-method RT delta false failures (~6+ min delta reduced to ~0.02 min), with full audit trail of which reference was used.**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-03-19T14:17:59Z
- **Completed:** 2026-03-19T14:21:09Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- `PeptideParams` extended with optional `standard_injection_rt` and `standard_injection_source` fields (backward compatible defaults)
- `calculate_identity` now prefers `standard_injection_rt` over `reference_rt` — result includes `reference_source`, `reference_source_id`, and `calibration_curve_rt` for audit
- `/hplc/analyze` endpoint accepts `standard_injection_rts` dict, resolves per-analyte match using alias-aware normalization (strips non-alphanumeric, checks `hplc_aliases`)
- `HPLCAnalysisResponse` exposes `identity_reference_source` and `identity_reference_source_id` for direct frontend access

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend identity calculation to accept standard injection RT with source tracking** - `e7c04fb` (feat)
2. **Task 2: Wire standard injection RTs through the /hplc/analyze endpoint** - `0708479` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `backend/calculations/hplc_processor.py` - PeptideParams + calculate_identity extended with standard injection RT support
- `backend/main.py` - HPLCAnalyzeRequest, HPLCAnalysisResponse, _analysis_to_response, run_hplc_analysis endpoint updated

## Decisions Made

- `standard_injection_rt` takes priority over `reference_rt` in `calculate_identity` — eliminates cross-method RT delta (~6+ min) false "DOES NOT CONFORM" results
- `calibration_curve_rt` always included in identity trace for audit, even when overridden by standard injection RT
- Alias-aware matching normalizes labels by stripping all non-alphanumeric characters and uppercasing, then checks `peptide.hplc_aliases` list — handles "BPC157" matching "BPC-157"
- No new DB columns needed: `identity_reference_source` and `identity_reference_source_id` extracted from existing `calculation_trace` JSON field in `_analysis_to_response`
- `standard_injection_rts` dict format: `{"BPC157": {"rt": 10.165, "source_sample_id": "P-0111"}}`

## Deviations from Plan

None - plan executed exactly as written.

Minor cleanup: removed a redundant `import re` statement inside the function body since `re` is already imported at module level.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Calculation layer is complete and backward compatible
- Plan 03 (frontend) can now send `standard_injection_rts` in the analyze request and display `identity_reference_source` in the result
- No DB migration needed

---
*Phase: 13-method-aware-identity-check*
*Completed: 2026-03-19*

## Self-Check: PASSED
