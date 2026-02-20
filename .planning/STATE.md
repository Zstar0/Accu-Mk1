# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-19)

**Core value:** Streamlined lab workflow: guide tech through sample prep step-by-step with auto weight capture — stock prep, dilution, ready for HPLC injection.
**Current focus:** v0.11.0 — New Analysis Wizard, Phase 1 COMPLETE — ready for Phase 2

## Current Position

Phase: 1 of 5 (DB Models and Calculation Foundation) — COMPLETE
Plan: 2 of 2 in current phase
Status: Phase complete — both plans (01-01 and 01-02) done
Last activity: 2026-02-20 — Completed 01-02-PLAN.md (wizard calculation engine)

Progress: [██░░░░░░░░] 20%

## Performance Metrics

**Velocity:**
- Total plans completed: 2
- Average duration: ~5min per plan (estimated)
- Total execution time: ~10min (Phase 1)

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-wizard-db | 2 | ~10min | ~5min |

*Updated after each plan completion*

## Accumulated Context

### Decisions

- Use `Decimal` arithmetic from first formula — no retrofitting allowed
- Store only raw weights in DB; recalculate all derived values on demand
- ScaleBridge as singleton on `app.state` (not per-request connection)
- SSE via `StreamingResponse` (existing codebase pattern — 4 endpoints already using it)
- Re-weigh inserts new record + sets `is_current=False` on old (audit trail preserved)
- SCALE_HOST env var controls scale mode; absent = manual-entry mode (no crash)
- Phase 2 is hardware-dependent: confirm Ethernet module, IP, and TCP port on physical balance before coding
- `calc_results` signature: `(calibration_slope, calibration_intercept, peak_area, actual_conc_ug_ml, actual_total_vol_ul, actual_stock_vol_ul)` — slope first
- `_build_session_response` in `main.py` fixed to use correct `calc_results` arg order (b1d441c) — resolved during 01-01 execution

### Blockers/Concerns

- Phase 2 (Scale Bridge): requires physical balance access — confirm Ethernet module installed, get static IP and configured TCP port before coding begins
- Phase 5 (SENAITE): requires live instance access — fetch a known sample with `?complete=yes` to identify peptide name and declared weight field names before building search UI

### Pending Todos

None.

## Session Continuity

Last session: 2026-02-20T02:43:29Z
Stopped at: Completed 01-01-PLAN.md and 01-02-PLAN.md (Phase 1 complete — both plans done in parallel wave 1)
Resume file: None
