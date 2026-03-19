# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-16)

**Core value:** Streamlined morning workflow: import CSV -> review batch -> calculate purity -> push to SENAITE. One operator, one workstation, no friction.
**Current focus:** v0.27.0 — Method-Aware Identity Check

## Current Position

Phase: 13 of 13 (Method-Aware Identity Check)
Plan: 1 of ? in current phase (In progress)
Status: In progress
Last activity: 2026-03-19 — Completed 13-01-PLAN.md (_std_ PeakData detection + StandardInjection parser + HPLCParseResponse.standard_injections)

Progress: [██████████░] phase 13 in progress

## Performance Metrics

**Velocity:**
- Total plans completed: 8 (v0.26.0)
- Average duration: ~4.7 min
- Total execution time: ~0.5 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 09 | 1/2 | ~6 min | ~6 min |
| 10 | 3/3 | ~14 min | ~4.7 min |
| 10.5 | 2/2 | ~10 min | ~5 min |
| 11 | 2/? | ~4 min | ~2 min |
| 12 | 2/2 | ~5 min | ~2.5 min |
| 13 | 1/? | ~6 min | ~6 min |

**Recent Trend:**
- Last 5 plans: 11-02 (~2 min), 12-01 (~2 min), 12-02 (~3 min), 13-01 (~6 min)
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
- Standard wizard uses separate buildStandardWizardSteps (1 stock + N dilutions), production flow untouched
- Concentration levels sorted descending for serial dilution order, minimum 3 enforced
- Standard-dilution steps reuse Step3Dilution component (same measurement flow per vial)
- Vial-to-injection mapping uses sorted index position (vial_number ascending, injection name natural sort)
- Client-side regression is preview only — backend computes authoritative values
- Standard branch in flyout is purely additive — non-standard flow unchanged
- sample_prep_id on hplc_analyses is plain INTEGER (no FK) — sample_preps lives in separate accumark_mk1 DB
- calibration_curve_id on hplc_analyses persisted from resolved cal.id, not from request — guarantees correctness
- FastAPI route ordering: static-segment routes must be registered before parameterized routes to prevent literal-as-integer matching
- _analysis_to_response() helper introduced in main.py for HPLCAnalysis ORM → HPLCAnalysisResponse conversion
- instrument_id passed as undefined from frontend — SamplePrep interface only has instrument_name; update when backend exposes instrument_id on /sample-preps response
- chromatogram_data persisted from chromTraces[0] only — shared injection set across blend analytes, one trace is correct
- Status update to hplc_complete is non-blocking (try/catch + console.warn) — analysis result must not fail due to status write
- DB-first flyout load: loadingSaved guard in loadPeakData handles race between async DB check and SharePoint effect
- Chromatogram backfill auto-fetch is best-effort: PATCH succeeds even if SharePoint is unreachable; warning logged on failure
- Only fetch chromatogram when source_sample_id actually changes (skip no-op updates on repeated PATCHes)
- vendor displayed below stats grid in view mode (not inline in header) — consistent with notes pattern, header already crowded
- source_sample_id already rendered in header row Sample field — Task 3 only added vendor conditional block, no duplication
- ChromatogramTrace optional style field: dashed traces get strokeWidth 1 vs 1.5 for visual hierarchy; strokeDasharray "6 3"
- extractStandardTrace picks highest concentration key for multi-conc calibration data (tallest peaks = best alignment reference)
- extractStandardTrace returns null (not throws) for empty/invalid chromatogram_data — callers skip cleanly
- Style hardcoded in extractStandardTrace (dashed + 0.4 opacity) — visual hierarchy enforced at extraction point, not left to callers
- Standard trace prepended at index 0 in displayChromTraces — Recharts renders in order, standard behind sample traces
- selectedCal in displayChromTraces dependency array — blend analyte tab switches update standard trace automatically
- chromatogram_data cast to Record<string, unknown> in flyout — bridges TS interface (old shape) vs runtime multi-conc format
- Standard injection files detected by _std_ in filename (case-insensitive) — never mixed into sample injections list
- Analyte label extracted between _std_ and _PeakData in filename — supports hyphenated labels (TB17-23)
- Source sample ID stripped at first _Inj_ in "Sample name:" metadata line — produces bare ID (P-0111)
- standard_injections defaults to [] on HPLCParseResponse — backward compatible API addition

### Key Source Files

- `backend/models.py` — CalibrationCurve model, WizardSession, WizardMeasurement
- `backend/main.py` — All endpoints, SENAITE integration, HPLC analysis, wizard sessions
- `backend/calculations/hplc_processor.py` — HPLC calculation engine
- `src/components/hplc/SamplePrepHplcFlyout.tsx` — HPLC processing flyout (+ standard detection)
- `src/components/hplc/StandardCurveReview.tsx` — Standard curve preview + creation UI
- `src/components/hplc/SamplePreps.tsx` — Sample preps table
- `src/components/hplc/wizard/steps/Step1SampleInfo.tsx` — Wizard step 1 (+ concentration editor for standards)
- `src/components/hplc/CreateAnalysis.tsx` — Wizard step routing (renderStep + navigation)
- `src/store/wizard-store.ts` — Wizard state, step builders, unlock/complete logic
- `src/lib/api.ts` — All TypeScript types and API functions
- `src/components/hplc/ChromatogramChart.tsx` — ChromatogramTrace interface, downsampleLTTB, parseChromatogramCsv, extractStandardTrace, ChromatogramChart
- `backend/parsers/peakdata_csv_parser.py` — StandardInjection dataclass, _is_standard_injection, parse_standard_injection, separate standard_injections list in HPLCParseResult

### Roadmap Evolution

- Phase 10.5 inserted after Phase 10: HPLC Results Persistence (URGENT) — existing `hplc_analyses` table stores partial results but missing calibration_curve_id, sample_prep_id, chromatogram traces, instrument, blend run grouping, and flyout reload path. Enriching this enables result comparison and audit before continuing to chromatogram overlay work.

### Blockers/Concerns

None.

### Pending Todos

None.

## Session Continuity

Last session: 2026-03-19
Stopped at: Completed 13-01-PLAN.md (standard injection detection and parsing in place)
Resume file: None
