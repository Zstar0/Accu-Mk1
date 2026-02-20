# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-19)

**Core value:** Streamlined lab workflow: guide tech through sample prep step-by-step with auto weight capture — stock prep, dilution, ready for HPLC injection.
**Current focus:** v0.11.0 — New Analysis Wizard, Phase 4 IN PROGRESS — wizard shell complete, step components next

## Current Position

Phase: 4 of 5 (Wizard UI) — In progress
Plan: 1 of 3 in current phase — COMPLETE
Status: In progress — 04-01 done
Last activity: 2026-02-20 — Completed 04-01-PLAN.md (PrepWizardStore, wizard API functions, split-panel layout with WizardStepList and WizardStepPanel)

Progress: [█████░░░░░] 50%

## Performance Metrics

**Velocity:**
- Total plans completed: 5
- Average duration: ~5min per plan (estimated)
- Total execution time: ~27min (Phase 1 + Phase 2 + Phase 3 + Phase 4 plan 1)

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-wizard-db | 2 | ~10min | ~5min |
| 02-scale-bridge | 1 | ~4min | ~4min |
| 03-sse-weight-streaming | 1 | ~10min | ~10min |
| 04-wizard-ui | 1/3 | ~2min | ~2min |

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

### Key Source Files

- `backend/main.py` — FastAPI app, all endpoints, lifespan setup, scale bridge singleton
- `backend/scale_bridge.py` — ScaleBridge class with asyncio TCP client and read_weight()
- `src/lib/scale-stream.ts` — useScaleStream hook (SSE consumer with stability detection)
- `src/components/hplc/WeightInput.tsx` — dual-mode weight input (scale SSE / manual)
- `src/components/hplc/PeptideConfig.tsx` — reference SSE consumer pattern
- `src/store/wizard-store.ts` — PrepWizardStore with stepStates field, deriveStepStates pure function, WIZARD_STEPS constant
- `src/lib/api.ts` — All API functions including 6 new wizard endpoints
- `src/components/hplc/CreateAnalysis.tsx` — WizardPage split-panel layout
- `src/components/hplc/wizard/WizardStepList.tsx` — Step sidebar with 4-state indicators
- `src/components/hplc/wizard/WizardStepPanel.tsx` — Animated content wrapper

### Blockers/Concerns

- Phase 2/3 hardware test deferred: scale at 192.168.3.113 on remote network; `test_scale.py` ready to run when accessible. WeightInput falls back to manual mode automatically when scale is offline.
- Phase 5 (SENAITE): requires live instance access — fetch a known sample with `?complete=yes` to identify peptide name and declared weight field names before building search UI

### Pending Todos

None.

## Session Continuity

Last session: 2026-02-20T05:02:36Z
Stopped at: Completed 04-01-PLAN.md (Phase 4 plan 01 — PrepWizardStore, wizard API functions, WizardPage split-panel layout)
Resume file: None
