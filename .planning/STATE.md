# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-19)

**Core value:** Streamlined lab workflow: guide tech through sample prep step-by-step with auto weight capture — stock prep, dilution, ready for HPLC injection.
**Current focus:** v0.11.0 — New Analysis Wizard, Phase 2 IN PROGRESS — plan 01 complete

## Current Position

Phase: 2 of 5 (Scale Bridge) — In progress
Plan: 1 of 1 in current phase — COMPLETE
Status: Phase complete — 02-01 done
Last activity: 2026-02-20 — Completed 02-01-PLAN.md (ScaleBridge TCP client and /scale/status)

Progress: [███░░░░░░░] 30%

## Performance Metrics

**Velocity:**
- Total plans completed: 3
- Average duration: ~5min per plan (estimated)
- Total execution time: ~15min (Phase 1 + Phase 2)

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-wizard-db | 2 | ~10min | ~5min |
| 02-scale-bridge | 1 | ~4min | ~4min |

*Updated after each plan completion*

## Accumulated Context

### Decisions

- Use `Decimal` arithmetic from first formula — no retrofitting allowed
- Store only raw weights in DB; recalculate all derived values on demand
- ScaleBridge as singleton on `app.state` (not per-request connection)
- SSE via `StreamingResponse` (existing codebase pattern — 4 endpoints already using it)
- Re-weigh inserts new record + sets `is_current=False` on old (audit trail preserved)
- SCALE_HOST env var controls scale mode; absent = manual-entry mode (no crash)
- Phase 2 is hardware-dependent: confirm Ethernet module and TCP port on physical balance before coding
- Scale IP confirmed: 192.168.3.113 (remote network — not currently accessible)
- `calc_results` signature: `(calibration_slope, calibration_intercept, peak_area, actual_conc_ug_ml, actual_total_vol_ul, actual_stock_vol_ul)` — slope first
- `_build_session_response` in `main.py` fixed to use correct `calc_results` arg order (b1d441c) — resolved during 01-01 execution
- ScaleBridge stored on `app.state` (singleton), SCALE_HOST absent = `bridge is None` not an error
- `_parse_sics_response` raises `ValueError` for all MT-SICS error codes; ConnectionError for TCP drops
- `asyncio.Lock` per-bridge guards concurrent SI command/response cycles on shared TCP stream

### Blockers/Concerns

- Phase 2 hardware test deferred: scale at 192.168.3.113 on remote network; `test_scale.py` ready to run when accessible
- Phase 5 (SENAITE): requires live instance access — fetch a known sample with `?complete=yes` to identify peptide name and declared weight field names before building search UI

### Pending Todos

None.

## Session Continuity

Last session: 2026-02-20T03:48:47Z
Stopped at: Completed 02-01-PLAN.md (Phase 2 plan 01 — ScaleBridge TCP client, /scale/status endpoint)
Resume file: None
