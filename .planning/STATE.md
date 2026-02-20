# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-19)

**Core value:** Streamlined lab workflow: guide tech through sample prep step-by-step with auto weight capture — stock prep, dilution, ready for HPLC injection.
**Current focus:** v0.11.0 — New Analysis Wizard, Phase 4 COMPLETE — full end-to-end wizard flow functional

## Current Position

Phase: 4 of 5 (Wizard UI) — COMPLETE
Plan: 3 of 3 in current phase — COMPLETE
Status: Phase 4 complete — all 5 wizard steps functional, Analysis History tabbed
Last activity: 2026-02-20 — Completed 04-03-PLAN.md (Step4Results, Step5Summary, WizardSessionHistory, AnalysisHistory tabs)

Progress: [███████░░░] 70%

## Performance Metrics

**Velocity:**
- Total plans completed: 7
- Average duration: ~4min per plan (estimated)
- Total execution time: ~34min

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-wizard-db | 2 | ~10min | ~5min |
| 02-scale-bridge | 1 | ~4min | ~4min |
| 03-sse-weight-streaming | 1 | ~10min | ~10min |
| 04-wizard-ui | 3/3 | ~9min | ~3min |

*Updated after each plan completion*

## Accumulated Context

### Decisions

- Use `Decimal` arithmetic from first formula — no retrofitting allowed
- Store only raw weights in DB; recalculate all derived values on demand
- ScaleBridge as singleton on `app.state` (not per-request connection)
- SSE via `StreamingResponse` (existing codebase pattern — 4 endpoints already using it)
- Re-weigh inserts new record + sets `is_current=False` on old (audit trail preserved)
- SCALE_HOST env var controls scale mode; absent = manual-entry mode (no crash)
- Scale IP confirmed: 192.168.3.113 (remote network — not currently accessible)
- `calc_results` signature: `(calibration_slope, calibration_intercept, peak_area, actual_conc_ug_ml, actual_total_vol_ul, actual_stock_vol_ul)` — slope first
- `_build_session_response` in `main.py` fixed to use correct `calc_results` arg order (b1d441c) — resolved during 01-01 execution
- ScaleBridge stored on `app.state` (singleton), SCALE_HOST absent = `bridge is None` not an error
- `_parse_sics_response` raises `ValueError` for all MT-SICS error codes; ConnectionError for TCP drops
- `asyncio.Lock` per-bridge guards concurrent SI command/response cycles on shared TCP stream
- SSE poll rate 4 Hz (asyncio.sleep(0.25)) — balance between responsiveness and CPU load
- SSE error events do NOT break loop — bridge reconnects, client stays connected
- Stability detection is pure frontend rolling window (5 readings, max-min <= 0.5 mg) — server stays stateless
- WeightInput uses local state only (not Zustand) — transient UI, not shared, not persisted
- `stepStates` stored as Zustand field (not computed selector) — stable reference, only re-renders when set() provides new object
- `deriveStepStates` exported as pure function callable outside the store
- `setCurrentStep` silently no-ops if target step is locked (no error thrown)
- `listWizardSessions` returns flat array `Promise<WizardSessionListItem[]>` (not paginated envelope)
- Step1SampleInfo: if `session !== null` show read-only summary — form not re-shown after session created
- Sub-step done check: `session.measurements.find(m => m.step_key === KEY && m.is_current)` — same pattern for Step2 and Step3
- Re-weigh: local boolean flag resets sub-step display to WeightInput; next Accept inserts new measurement (server handles audit trail)
- `const sessionId = session.id` captured before async handlers — TypeScript narrowing lost across async closures
- Step 2 transfer confirmation: `transferConfirmed || meas2d != null` — loaded vial weight implies transfer occurred
- AnalysisHistory early return converted to conditional render inside TabsContent — tabs persist in detail view
- Step5Summary resetWizard before navigateTo — wizard always resets regardless of navigation

### Key Source Files

- `backend/main.py` — FastAPI app, all endpoints, lifespan setup, scale bridge singleton
- `backend/scale_bridge.py` — ScaleBridge class with asyncio TCP client and read_weight()
- `src/lib/scale-stream.ts` — useScaleStream hook (SSE consumer with stability detection)
- `src/components/hplc/WeightInput.tsx` — dual-mode weight input (scale SSE / manual)
- `src/components/hplc/PeptideConfig.tsx` — reference SSE consumer pattern
- `src/store/wizard-store.ts` — PrepWizardStore with stepStates field, deriveStepStates pure function, WIZARD_STEPS constant
- `src/lib/api.ts` — All API functions including 6 new wizard endpoints
- `src/components/hplc/CreateAnalysis.tsx` — WizardPage split-panel layout (all 5 steps wired)
- `src/components/hplc/wizard/WizardStepList.tsx` — Step sidebar with 4-state indicators
- `src/components/hplc/wizard/WizardStepPanel.tsx` — Animated content wrapper
- `src/components/hplc/wizard/steps/Step1SampleInfo.tsx` — Session creation form (peptide dropdown + targets)
- `src/components/hplc/wizard/steps/Step2StockPrep.tsx` — Stock prep 4-sub-step weighing with calcs
- `src/components/hplc/wizard/steps/Step3Dilution.tsx` — Dilution 3-sub-step weighing with actual calcs
- `src/components/hplc/wizard/steps/Step4Results.tsx` — Peak area input with calculated results card
- `src/components/hplc/wizard/steps/Step5Summary.tsx` — Full read-only summary + Complete Session button
- `src/components/hplc/wizard/WizardSessionHistory.tsx` — Completed wizard sessions table
- `src/components/hplc/AnalysisHistory.tsx` — Tabbed: HPLC Import + Sample Prep Wizard tabs

### Blockers/Concerns

- Phase 2/3 hardware test deferred: scale at 192.168.3.113 on remote network; `test_scale.py` ready to run when accessible. WeightInput falls back to manual mode automatically when scale is offline.
- Phase 5 (SENAITE): requires live instance access — fetch a known sample with `?complete=yes` to identify peptide name and declared weight field names before building search UI

### Pending Todos

None.

## Session Continuity

Last session: 2026-02-20T05:17:38Z
Stopped at: Completed 04-03-PLAN.md (Phase 4 plan 03 — Step4Results, Step5Summary, WizardSessionHistory, AnalysisHistory tabs)
Resume file: None
