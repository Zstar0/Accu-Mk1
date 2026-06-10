---
phase: 05-senaite-sample-lookup
plan: 01
subsystem: api
tags: [senaite, lims, httpx, fastapi, pydantic, typescript, wizard]

# Dependency graph
requires:
  - phase: 04-wizard-ui
    provides: wizard session endpoints and Step1SampleInfo UI that will consume SENAITE data
provides:
  - GET /wizard/senaite/status endpoint returning enabled bool
  - GET /wizard/senaite/lookup endpoint with 404/503 error differentiation
  - SENAITE env var configuration (SENAITE_URL, SENAITE_USER, SENAITE_PASSWORD)
  - Pydantic models: SenaiteAnalyte, SenaiteLookupResult, SenaiteStatusResponse
  - TypeScript functions: getSenaiteStatus, lookupSenaiteSample
  - TypeScript interfaces: SenaiteAnalyte, SenaiteLookupResult, SenaiteStatusResponse
affects:
  - 05-02 (Step1 UI SENAITE lookup tab — consumes these endpoints and api.ts functions)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "SENAITE optional integration: SENAITE_URL=None disables feature entirely, no crash"
    - "httpx.BasicAuth for SENAITE REST API authentication"
    - "Fuzzy peptide matching: case-insensitive contains (stripped_name in peptide.name.lower())"
    - "Analyte suffix stripping: re.sub to remove ' - Method (Type)' patterns"

key-files:
  created: []
  modified:
    - backend/main.py
    - backend/.env.example
    - src/lib/api.ts

key-decisions:
  - "SENAITE lookup errors differentiated: 404 for not-found, 503 for unavailable/timeout/5xx"
  - "Fuzzy match uses simple contains (not Levenshtein) — sufficient for exact peptide names"
  - "Em-dash used in 503 message: 'SENAITE is currently unavailable — use manual entry'"
  - "Analyte suffix regex: r'\\s*-\\s*[^-]+\\([^)]+\\)\\s*$' strips ' - Identity (HPLC)' style suffixes"
  - "SENAITE endpoints placed after wizard session endpoints, before scale endpoints in main.py"

patterns-established:
  - "Optional integration pattern: env var absent = feature disabled, same as SCALE_HOST"
  - "Error propagation: backend detail field passed through to frontend Error.message for direct display"

# Metrics
duration: 2min
completed: 2026-02-20
---

# Phase 5 Plan 01: SENAITE Backend Endpoints and Frontend API Summary

**SENAITE LIMS integration via httpx BasicAuth: two backend endpoints with 404/503 differentiation, analyte suffix stripping, fuzzy peptide matching, and typed TypeScript API client functions**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-20T06:41:53Z
- **Completed:** 2026-02-20T06:44:23Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Added `GET /wizard/senaite/status` returning `{enabled: bool}` based on SENAITE_URL env var presence
- Added `GET /wizard/senaite/lookup` with full error differentiation: 404 for sample not found, 503 for unavailable/timeout/error
- Implemented `_strip_method_suffix()` to clean SENAITE analyte names (e.g., "BPC-157 - Identity (HPLC)" -> "BPC-157")
- Implemented `_fuzzy_match_peptide()` using case-insensitive substring match against local peptides table
- Added typed TypeScript interfaces and functions in api.ts ready for Step1 UI consumption
- Documented SENAITE configuration in .env.example with Docker network URL

## Task Commits

Each task was committed atomically:

1. **Task 1: SENAITE backend endpoints and env config** - `d895c51` (feat)
2. **Task 2: Frontend SENAITE API types and functions** - `35d0ebd` (feat)

**Plan metadata:** (pending — docs commit follows)

## Files Created/Modified

- `backend/main.py` - SENAITE env vars, Pydantic models, helper functions, two new endpoints
- `backend/.env.example` - SENAITE configuration section with commented-out defaults
- `src/lib/api.ts` - SenaiteAnalyte/SenaiteLookupResult/SenaiteStatusResponse interfaces; getSenaiteStatus/lookupSenaiteSample functions

## Decisions Made

- **Error differentiation**: 404 for "Sample X not found in SENAITE"; 503 for unreachable/timeout/HTTP error/generic exception — matches CONTEXT.md specification exactly
- **Fuzzy match algorithm**: Simple case-insensitive `contains` (`stripped_name.lower() in peptide.name.lower()`) — sufficient for exact peptide names, no Levenshtein needed
- **Analyte suffix regex**: `r'\s*-\s*[^-]+\([^)]+\)\s*$'` handles all "BPC-157 - Method (Type)" patterns cleanly
- **Em-dash in 503 message**: Used Unicode em-dash (`\u2014`) as specified in CONTEXT.md decisions
- **Analytes 1-4 iteration**: Iterates `Analyte1Peptide` through `Analyte4Peptide` keys, skips null/empty values
- **DeclaredTotalQuantity parsing**: Converts decimal string to float, None if null/empty/unparseable

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None. Backend syntax check passed (`python -m py_compile`). TypeScript compilation passed (`npx tsc --noEmit`). Note: `python -c "import main"` fails outside Docker due to missing venv dependencies (jose, sqlalchemy, etc.) — this is expected and not a syntax issue.

## User Setup Required

**External services require manual configuration** to use SENAITE lookup in the wizard:

Environment variables to add to `backend/.env`:
- `SENAITE_URL` — Base URL of SENAITE instance (e.g., `http://senaite:8080`)
- `SENAITE_USER` — SENAITE admin username
- `SENAITE_PASSWORD` — SENAITE admin password

When `SENAITE_URL` is not set, the lookup tab will be hidden (Step1 UI — next plan).

## Next Phase Readiness

- Backend endpoints and TypeScript API functions are complete and ready for Step1 UI
- Next plan (05-02) implements the two-tab Step1 UI: "SENAITE Lookup" tab and "Manual Entry" tab
- No blockers — all artifacts match the must_haves specification

---
*Phase: 05-senaite-sample-lookup*
*Completed: 2026-02-20*

## Self-Check: PASSED
