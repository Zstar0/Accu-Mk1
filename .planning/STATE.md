# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-16)

**Core value:** Streamlined morning workflow: import CSV -> review batch -> calculate purity -> push to SENAITE. One operator, one workstation, no friction.
**Current focus:** v0.26.0 — Standard Sample Preps & Calibration Curve Chromatograms

## Current Position

Phase: 09 of 12 (Data Model + Standard Prep Flag)
Plan: 0 of 2 in current phase
Status: Ready to plan
Last activity: 2026-03-16 — Roadmap created for v0.26.0

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**
- Total plans completed: 0 (v0.26.0)
- Average duration: -
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**
- Last 5 plans: -
- Trend: -

## Accumulated Context

### Decisions

- Standards are single-peptide only (Cayman standards are individual peptides, not blends)
- Standards flow through the same wizard as production samples (no separate workflow)
- Chromatogram data stored as JSON on CalibrationCurve (times[] + signals[] from DAD1A CSV)
- Existing curves can be backfilled by linking a Sample ID -> locate chromatogram in SharePoint
- Manufacturer and notes fields added per curve for provenance tracking
- Sample chromatogram already displayed in HPLC flyout; standard overlay is the new addition
- Per-analyte prep data does NOT affect HPLC processing pipeline

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

Last session: 2026-03-16
Stopped at: Roadmap created for v0.26.0 (4 phases, 5 plans)
Resume file: None
