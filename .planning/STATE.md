# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-19)

**Core value:** Streamlined lab workflow: guide tech through sample prep step-by-step with auto weight capture — stock prep, dilution, ready for HPLC injection.
**Current focus:** v0.11.0 — New Analysis Wizard, Phase 3 COMPLETE — ready for Phase 4

## Current Position

Phase: 3 of 5 (SSE Weight Streaming) — COMPLETE
Plan: 1 of 1 in current phase — COMPLETE
Status: Phase complete — 03-01 done
Last activity: 2026-02-20 — Completed 03-01-PLAN.md (SSE weight streaming endpoint, useScaleStream hook, WeightInput component)

Progress: [████░░░░░░] 40%

## Performance Metrics

**Velocity:**
- Total plans completed: 4
- Average duration: ~7min per plan (estimated)
- Total execution time: ~25min (Phase 1 + Phase 2 + Phase 3)

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-wizard-db | 2 | ~10min | ~5min |
| 02-scale-bridge | 1 | ~4min | ~4min |
| 03-sse-weight-streaming | 1 | ~10min | ~10min |

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

### Key Source Files

- `backend/main.py` — FastAPI app, all endpoints, lifespan setup, scale bridge singleton
- `backend/scale_bridge.py` — ScaleBridge class with asyncio TCP client and read_weight()
- `src/lib/scale-stream.ts` — useScaleStream hook (SSE consumer with stability detection)
- `src/components/hplc/WeightInput.tsx` — dual-mode weight input (scale SSE / manual)
- `src/components/hplc/PeptideConfig.tsx` — reference SSE consumer pattern

### Blockers/Concerns

- Phase 2/3 hardware test deferred: scale at 192.168.3.113 on remote network; `test_scale.py` ready to run when accessible. WeightInput falls back to manual mode automatically when scale is offline.
- Phase 5 (SENAITE): requires live instance access — fetch a known sample with `?complete=yes` to identify peptide name and declared weight field names before building search UI

### Pending Todos

None.

## Session Continuity

Last session: 2026-02-20T04:33:00Z
Stopped at: Completed 03-01-PLAN.md (Phase 3 plan 01 — SSE weight stream endpoint, useScaleStream hook, WeightInput component)
Resume file: None
