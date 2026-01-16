---
phase: 02-data-pipeline
plan: 02
subsystem: import
tags: [parser, txt, hplc, file-import, jobs, samples]

# Dependency graph
requires:
  - phase: 02-01
    provides: Settings model with column_mappings for parsing
provides:
  - TXT parser for HPLC tab-delimited files
  - Import API endpoints (preview, batch)
  - Jobs and Samples CRUD API
  - TypeScript client for import operations
affects: [02-03, 02-04, 03-review]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "ParseResult dataclass for structured parse output"
    - "Column mappings from settings control field extraction"
    - "input_data JSON field stores raw parsed rows on Sample"

key-files:
  created:
    - backend/parsers/__init__.py
    - backend/parsers/txt_parser.py
  modified:
    - backend/main.py
    - src/lib/api.ts

key-decisions:
  - "TXT-only parser first - CSV/Excel can be added later"
  - "Store raw parsed data in Sample.input_data JSON field"
  - "Preview returns first 10 rows without saving"
  - "Job status transitions: pending -> imported/completed_with_errors"

patterns-established:
  - "ParseResult: filename, rows, raw_headers, row_count, errors"
  - "Batch import creates Job -> Samples hierarchy with audit trail"
  - "Numeric conversion handles EU decimal format (comma separator)"

# Metrics
duration: 4min
completed: 2026-01-16
---

# Phase 02 Plan 02: File Import Backend Summary

**TXT parser with column mappings, import API creating Jobs and Samples, TypeScript client**

## Performance

- **Duration:** 4 min
- **Started:** 2026-01-16T06:36:22Z
- **Completed:** 2026-01-16T06:40:20Z
- **Tasks:** 3
- **Files created:** 2
- **Files modified:** 2

## Accomplishments

- TXT parser handles tab-delimited HPLC exports with column mappings
- Preview endpoint parses file without saving for user review
- Batch import creates Job with multiple Samples storing parsed data
- Jobs and Samples CRUD endpoints for querying imported data
- TypeScript types and API functions for all import operations

## Task Commits

Each task was committed atomically:

1. **Task 1: File Parser Module** - `f68af4a` (feat)
2. **Task 2: Import API Endpoints** - `e4c30ee` (feat)
3. **Task 3: Import TypeScript Client** - `20791a6` (feat)

## Files Created/Modified

**Created:**
- `backend/parsers/__init__.py` - Parser package init with exports
- `backend/parsers/txt_parser.py` - ParseResult dataclass and parse_txt_file function

**Modified:**
- `backend/main.py` - Added import, jobs, samples endpoints with schemas
- `src/lib/api.ts` - Added ParsePreview, ImportResult, Job, Sample interfaces and API functions

## Decisions Made

1. **TXT-only initially** - Parser supports tab-delimited format; CSV/Excel parsers can extend later
2. **Column mappings from settings** - Parsing uses `column_mappings` setting for field extraction
3. **input_data JSON storage** - Raw parsed rows stored on Sample for later processing
4. **Preview without saving** - `POST /import/file` returns preview without database writes
5. **Job status workflow** - pending -> imported (success) or completed_with_errors (partial)

## Deviations from Plan

None - plan executed exactly as written.

## API Endpoints Added

| Method | Path | Purpose |
|--------|------|---------|
| POST | /import/file | Preview file parse without saving |
| POST | /import/batch | Import files, create Job + Samples |
| GET | /jobs | List recent jobs |
| GET | /jobs/{id} | Get single job |
| GET | /jobs/{id}/samples | Get samples for job |
| GET | /samples | List recent samples |
| GET | /samples/{id} | Get single sample |

## Verification

Parser and API imports verified:
- Parser module loads correctly
- All 17 routes registered in FastAPI
- TypeScript types compile without errors

## Next Phase Readiness

- Import backend ready for UI integration
- Jobs/Samples structure ready for calculation workflow
- Parsed data accessible via input_data for downstream processing

---
*Phase: 02-data-pipeline*
*Completed: 2026-01-16*
