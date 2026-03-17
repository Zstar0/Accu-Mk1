# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-16)

**Core value:** Streamlined morning workflow: import CSV -> review batch -> calculate purity -> push to SENAITE. One operator, one workstation, no friction.
**Current focus:** v0.26.0 — Standard Sample Preps & Calibration Curve Chromatograms

## Current Position

Phase: 10 of 12 (Auto-Create Curve from Standard)
Plan: 1 of 3 in current phase
Status: In progress
Last activity: 2026-03-17 — Completed 10-01-PLAN.md

Progress: [██░░░░░░░░] 20%

## Performance Metrics

**Velocity:**
- Total plans completed: 2 (v0.26.0)
- Average duration: ~5 min
- Total execution time: ~0.2 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 09 | 1/2 | ~6 min | ~6 min |
| 10 | 1/3 | ~4 min | ~4 min |

**Recent Trend:**
- Last 5 plans: 09-01 (~6 min), 10-01 (~4 min)
- Trend: stable/fast

## Accumulated Context

### Decisions

- Standards are single-peptide only (Cayman standards are individual peptides, not blends)
- Standards flow through the same wizard as production samples (no separate workflow)
- Chromatogram data stored as JSON on CalibrationCurve (times[] + signals[] from DAD1A CSV)
- Existing curves can be backfilled by linking a Sample ID -> locate chromatogram in SharePoint
- Manufacturer and notes fields added per curve for provenance tracking
- Sample chromatogram already displayed in HPLC flyout; standard overlay is the new addition
- Per-analyte prep data does NOT affect HPLC processing pipeline
- Used `standard_notes` (not `notes`) on WizardSession to avoid collision with SamplePrep.notes
- `is_standard` defaults to FALSE on all tables (existing data = production preps)
- Query sample_preps by sample_id string (not integer id) for standard validation — HPLC flyout uses prep identifiers like "P-0136"
- Used `_cal_to_response()` wrapper in from-standard endpoint for SharePoint URL resolution

### Key Source Files

- `backend/models.py` — CalibrationCurve model, WizardSession, WizardMeasurement
- `backend/main.py` — All endpoints, SENAITE integration, HPLC analysis, wizard sessions
- `backend/calculations/hplc_processor.py` — HPLC calculation engine
- `src/components/hplc/SamplePrepHplcFlyout.tsx` — HPLC processing flyout
- `src/components/hplc/SamplePreps.tsx` — Sample preps table
- `src/components/hplc/wizard/steps/Step1SampleInfo.tsx` — Wizard step 1
- `src/lib/api.ts` — All TypeScript types and API functions

### Blockers/Concerns

None.

### Pending Todos

None.

## Session Continuity

Last session: 2026-03-17
Stopped at: Completed 10-01-PLAN.md (backend endpoint + frontend API function)
Resume file: None
