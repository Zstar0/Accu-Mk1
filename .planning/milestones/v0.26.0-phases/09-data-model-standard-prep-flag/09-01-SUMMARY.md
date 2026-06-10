# Phase 09 Plan 01: Data Model + Standard Prep Flag Summary

**One-liner:** Schema columns for standard prep metadata and chromatogram JSON across CalibrationCurve, WizardSession, and sample_preps with full API/TypeScript sync.

## Task Commits

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Add CalibrationCurve + WizardSession + sample_preps schema columns | 158edfd | backend/models.py, backend/database.py, backend/mk1_db.py |
| 2 | Update API serialization and TypeScript types for new fields | 51188d7 | backend/main.py, backend/mk1_db.py, src/lib/api.ts |

## What Was Done

### Task 1: Schema Columns
- **CalibrationCurve** (SQLite ORM + PostgreSQL migration): Added `chromatogram_data` (JSON) and `source_sharepoint_folder` (VARCHAR 1000)
- **WizardSession** (SQLite ORM + PostgreSQL migration): Added `is_standard` (BOOLEAN, default FALSE), `manufacturer` (VARCHAR 200), `standard_notes` (TEXT)
- **sample_preps** (PostgreSQL raw DDL via mk1_db.py): Added `is_standard` (BOOLEAN, default FALSE), `manufacturer` (VARCHAR 200), `standard_notes` (TEXT)
- All migrations are idempotent -- PostgreSQL uses `IF NOT EXISTS`, SQLite uses existing try/except pattern

### Task 2: API + TypeScript
- **CalibrationCurveResponse**: Added `chromatogram_data` and `source_sharepoint_folder` fields
- **WizardSessionCreate/Update**: Added `is_standard`, `manufacturer`, `standard_notes` as optional fields
- **WizardSessionResponse**: Added `is_standard` (bool), `manufacturer`, `standard_notes` to response model and `_build_session_response` builder
- **create_wizard_session**: Passes new fields to WizardSession ORM constructor
- **create_sample_prep_endpoint**: Copies `is_standard`, `manufacturer`, `standard_notes` from session to sample prep data dict
- **mk1_db.create_sample_prep**: Added new columns to `cols` list
- **list_sample_preps**: Added `is_standard` filter parameter with WHERE clause support
- **list_sample_preps_endpoint**: Accepts and passes `is_standard` query param
- **TypeScript**: Updated `CalibrationCurve`, `WizardSessionResponse`, `SamplePrep` interfaces; updated `createWizardSession`, `updateWizardSession`, `listSamplePreps` function signatures
- TypeScript compilation passes with zero new errors

## Deviations from Plan

None -- plan executed exactly as written.

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Used `standard_notes` (not `notes`) on WizardSession | Avoids collision with existing `notes` field on SamplePrep |
| `is_standard` defaults to FALSE | Existing sessions are production preps; explicit opt-in for standards |
| list_sample_preps WHERE refactored to conditions list | Cleaner composition when combining search + is_standard filters |

## Verification

- `grep` confirms all 5 new column names present in models.py, database.py, mk1_db.py, main.py, api.ts
- `npx tsc --noEmit` passes with zero errors
- All migrations use idempotent patterns (safe to re-run)

## Metrics

- **Duration:** ~6 minutes
- **Completed:** 2026-03-16
- **Tasks:** 2/2

## Self-Check: PASSED
