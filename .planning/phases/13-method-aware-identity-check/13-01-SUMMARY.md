---
phase: 13-method-aware-identity-check
plan: 01
subsystem: api
tags: [hplc, csv-parsing, peakdata, standard-injection, identity-check, fastapi, pydantic]

# Dependency graph
requires:
  - phase: 12-chromatogram-overlay
    provides: SamplePrepHplcFlyout with HPLC parse pipeline already wired
provides:
  - StandardInjection dataclass with analyte_label, main_peak_rt, source_sample_id
  - parse_hplc_files separates _std_ files from sample injections
  - HPLCParseResponse.standard_injections exposes reference RT data to frontend
affects: [13-method-aware-identity-check (plans 02+), SamplePrepHplcFlyout identity check logic]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "_is_standard_injection: filename-based routing before parse — keeps sample and standard lists clean"
    - "_extract_source_sample_id: metadata line parsing from post-peak-table content"

key-files:
  created: []
  modified:
    - backend/parsers/peakdata_csv_parser.py
    - backend/main.py

key-decisions:
  - "Standard files detected by _std_ in filename (case-insensitive) — consistent with naming convention PB-0065_Inj_1_std_BPC157_PeakData.csv"
  - "Analyte label extracted between _std_ and _PeakData — handles hyphenated labels like TB17-23"
  - "Source sample ID stripped by finding first _Inj_ suffix — produces bare ID like P-0111"
  - "Standard injections never enter injections list — purity calculation unaffected, backward compatible"
  - "standard_injections defaults to [] on HPLCParseResponse — no breaking API change"

patterns-established:
  - "parse_standard_injection reuses parse_peakdata_csv — same CSV format, no duplication"

# Metrics
duration: 6min
completed: 2026-03-19
---

# Phase 13 Plan 01: Standard Injection Detection and Parsing Summary

**_std_ PeakData files routed to a separate StandardInjection list in parser and exposed via HPLCParseResponse.standard_injections, keeping sample purity calculations clean while surfacing reference RTs for identity checks**

## Performance

- **Duration:** ~6 min
- **Started:** 2026-03-19T19:53:19Z
- **Completed:** 2026-03-19T20:00:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Parser now detects `_std_` files and routes them to a separate `standard_injections` list — sample injections list is never contaminated
- `StandardInjection` dataclass captures analyte_label, main_peak_rt, main_peak_area_pct, source_sample_id, filename
- `/hplc/parse-files` response includes `standard_injections` array (empty by default, backward compatible)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add standard injection detection and parsing to peakdata_csv_parser.py** - `beb44d2` (feat)
2. **Task 2: Expose standard injection data in HPLCParseResponse API** - `86e3191` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `backend/parsers/peakdata_csv_parser.py` - Added StandardInjection dataclass, _is_standard_injection, _extract_standard_info, _extract_source_sample_id, parse_standard_injection; modified parse_hplc_files to route _std_ files
- `backend/main.py` - Added StandardInjectionResponse Pydantic model; added standard_injections field to HPLCParseResponse; mapped result.standard_injections in endpoint

## Decisions Made

- `_is_standard_injection` uses case-insensitive `_std_` match — handles any capitalisation variant
- Analyte label extracted by slicing between `_std_` and `_peakdata` positions in lowercased name — supports hyphenated labels (TB17-23)
- Source sample ID stripped at first `_Inj_` occurrence — produces clean ID without injection suffix
- `standard_injections` defaults to `[]` on both HPLCParseResult and HPLCParseResponse — zero breaking change for existing callers

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Parser correctly identifies and separates standard injections from sample injections
- Standard injection RT and analyte label available in parse response
- Ready for Plan 02: use standard_injections RT data in identity check logic within the analyze endpoint

---
*Phase: 13-method-aware-identity-check*
*Completed: 2026-03-19*

## Self-Check: PASSED
