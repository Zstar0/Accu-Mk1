# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-20)

**Core value:** Streamlined lab workflow: guide tech through sample prep step-by-step with auto weight capture — stock prep, dilution, ready for HPLC injection.
**Current focus:** Between milestones — v0.11.0 archived. Run `/gsd:new-milestone` to plan next.

## Current Position

Phase: —
Plan: —
Status: v0.11.0 milestone complete and archived (2026-02-20)
Last activity: 2026-02-20 — Archived v0.11.0 New Analysis Wizard milestone

Progress: [██████████] 100% — Milestone complete

## Performance Metrics

**Velocity (v0.11.0):**
- Total plans completed: 9
- Average duration: ~4min per plan (estimated)
- Total execution time: ~39min

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-wizard-db | 2 | ~10min | ~5min |
| 02-scale-bridge | 1 | ~4min | ~4min |
| 03-sse-weight-streaming | 1 | ~10min | ~10min |
| 04-wizard-ui | 3/3 | ~9min | ~3min |
| 05-senaite-sample-lookup | 2/2 | ~5min | ~2.5min |

## Accumulated Context

### Decisions

*(Archived to .planning/milestones/v0.11.0-new-analysis-wizard.md)*

### Key Source Files

- `backend/main.py` — FastAPI app, all endpoints, SENAITE integration, scale bridge singleton
- `backend/scale_bridge.py` — ScaleBridge class with asyncio TCP client and read_weight()
- `src/lib/scale-stream.ts` — useScaleStream hook (SSE consumer with stability detection)
- `src/components/hplc/WeightInput.tsx` — dual-mode weight input (scale SSE / manual)
- `src/store/wizard-store.ts` — PrepWizardStore with stepStates field, deriveStepStates pure function
- `src/lib/api.ts` — All API functions including wizard endpoints + SENAITE lookup functions
- `src/components/hplc/CreateAnalysis.tsx` — WizardPage split-panel layout (all 5 steps wired)
- `src/components/hplc/wizard/steps/Step1SampleInfo.tsx` — Two-tab SENAITE Lookup / Manual Entry form

### Blockers/Concerns

- Scale hardware test deferred: scale at 192.168.3.113 on remote network; `test_scale.py` ready to run when accessible
- SENAITE env vars need to be set for integration to function — see .env.example SENAITE section

### Pending Todos

None.

## Session Continuity

Last session: 2026-02-20
Stopped at: Archived v0.11.0 milestone — ready for next milestone planning
Resume file: None
