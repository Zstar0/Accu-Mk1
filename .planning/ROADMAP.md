# Roadmap: Accu-Mk1 v0.11.0 — New Analysis Wizard

## Overview

This milestone adds a guided 5-step sample preparation wizard to the existing FastAPI + React lab app. The wizard captures weighing data from a Mettler Toledo XSR105DU balance over TCP, performs stock prep and dilution calculations using Decimal arithmetic, and writes a complete audit-trail session record to SQLite. The build order — DB foundation first, scale bridge second, SSE integration third, UI fourth, SENAITE last — keeps every phase independently testable and de-risks the two external dependencies (hardware, LIMS) until the wizard core is solid.

## Phases

- [x] **Phase 1: DB Models and Calculation Foundation** — Session persistence, all calculation logic, REST endpoints, manual weight entry. No hardware required.
- [x] **Phase 2: Scale Bridge Service** — Singleton asyncio TCP service connecting to the Mettler Toledo XSR105DU via MT-SICS protocol.
- [ ] **Phase 3: SSE Weight Streaming** — SSE endpoint and frontend hook wiring the scale bridge into the wizard with live weight display and fallback.
- [ ] **Phase 4: Wizard UI** — Full CreateAnalysis.tsx wizard with Stripe-style step sidebar, all 5 wizard steps, and WeighStep components wired to scale SSE.
- [ ] **Phase 5: SENAITE Sample Lookup** — httpx SENAITE client with sample search UI in step 1 of the wizard and manual entry fallback.

## Phase Details

### Phase 1: DB Models and Calculation Foundation

**Goal**: Tech can run a complete sample prep wizard session using manual weight entry, with all measurements and calculated values persisted to the database.

**Depends on**: Nothing (no hardware or external services required)

**Requirements**: SESS-01, SESS-02, SESS-03, STK-05, DIL-01, DIL-05, RES-02

**Success Criteria** (what must be TRUE):
1. Tech can start a new wizard session and the session is immediately persisted to the database with a session ID.
2. Tech can enter weights manually for each of the 5 measurement steps and the database stores each raw weight with provenance (manual vs scale) and timestamp.
3. The calculations endpoint returns correct stock concentration, actual diluent added, required dilution volumes, actual concentration, dilution factor, peptide mass, and purity — all using Decimal arithmetic, all recalculated on demand from raw measurements.
4. A session in progress can be resumed after navigating away — the API returns all current measurements and calculated values needed to restore wizard state.

**Plans**: 2 plans

Plans:
- [x] 01-01-PLAN.md — DB models (WizardSession, WizardMeasurement), wizard_sessions/wizard_measurements tables, 6 REST endpoints for session lifecycle
- [x] 01-02-PLAN.md — Decimal calculation engine (calc_stock_prep, calc_required_volumes, calc_actual_dilution, calc_results) with TDD unit tests verified against lab Excel values

---

### Phase 2: Scale Bridge Service

**Goal**: Backend connects to the Mettler Toledo XSR105DU over TCP and correctly reads stable weights using MT-SICS protocol, with the scale status exposed via API.

**Depends on**: Phase 1

**Requirements**: SCALE-01, SCALE-05

**Success Criteria** (what must be TRUE):
1. A standalone test script (`test_scale.py`) can connect to the physical balance, send an SI command, and print a parsed weight reading with stability flag — with no FastAPI running.
2. `GET /scale/status` returns `connected` when SCALE_HOST is configured and the balance is reachable, and `disconnected` otherwise.
3. When SCALE_HOST is not set in the environment, the app starts normally and scale-dependent features degrade to manual-entry mode — no crash or startup error.
4. Scale IP and port are configurable via SCALE_HOST and SCALE_PORT environment variables, editable in app settings.

**Plans**: 1 plan

Plans:
- [x] 02-01-PLAN.md — ScaleBridge singleton, MT-SICS TCP client, FastAPI lifespan registration, status endpoint, settings, standalone test script

---

### Phase 3: SSE Weight Streaming

**Goal**: Tech sees live weight readings stream into the wizard UI in real time, with a clear stable-weight indicator, and can fall back to manual entry when the scale is offline.

**Depends on**: Phase 2

**Requirements**: SCALE-02, SCALE-03, SCALE-04

**Success Criteria** (what must be TRUE):
1. When tech clicks "Read Weight" on any wizard step, the UI immediately shows a live updating weight value streamed from the scale via SSE.
2. When 5 consecutive readings are within 0.5 mg of each other, the UI shows a stable-weight visual indicator and enables the "Accept Weight" button.
3. When the scale is offline or SCALE_HOST is not configured, the wizard step shows a manual weight entry input instead of the SSE live display — the tech can continue without a scale.

**Plans**: 1 plan

Plans:
- [ ] 03-01-PLAN.md — SSE weight stream endpoint, useScaleStream frontend hook with stability detection, WeightInput component with SSE/manual dual mode

---

### Phase 4: Wizard UI

**Goal**: Tech can navigate through the complete 5-step sample prep wizard — from sample info through stock prep, dilution, and results entry — with animated step transitions, sequential locking, and completed steps reviewable.

**Depends on**: Phase 3

**Requirements**: WIZ-01, WIZ-02, WIZ-03, WIZ-04, WIZ-05, SMP-04, STK-01, STK-02, STK-03, STK-04, DIL-02, DIL-03, DIL-04, RES-01, RES-03, SESS-04

**Success Criteria** (what must be TRUE):
1. The wizard displays a vertical step list (left sidebar) alongside the step content panel (right), where each step shows one of four states: not-started, in-progress, complete, or locked.
2. Tech cannot advance to a locked step but can navigate back to any completed step to review its captured data.
3. All 5 steps — sample info, stock prep (4 weighing sub-steps with calculated outputs displayed inline), dilution (3 weighing sub-steps), results entry, and summary — are reachable and functional.
4. Transitions between steps are animated. Completed sessions appear in Analysis History.

**Plans**: TBD

Plans:
- [ ] 04-01: PrepWizardStore (Zustand), WizardPage layout, step state machine, animated transitions
- [ ] 04-02: All 5 wizard step components wired to backend API and WeighStep SSE consumer

---

### Phase 5: SENAITE Sample Lookup

**Goal**: Tech can search for a SENAITE sample by ID in step 1 of the wizard and have sample details (ID, peptide name, declared weight) auto-populated, with a manual entry fallback when SENAITE is unavailable.

**Depends on**: Phase 4

**Requirements**: SMP-01, SMP-02, SMP-03

**Success Criteria** (what must be TRUE):
1. Tech can type a SENAITE sample ID into the search field in wizard step 1 and the app retrieves and displays the sample ID, peptide name, and declared weight (mg).
2. When SENAITE is unreachable or returns no match, the wizard shows a clear error state and lets tech enter sample details manually to continue.

**Plans**: TBD

Plans:
- [ ] 05-01: SENAITE httpx client, sample search endpoint, step 1 search UI

---

## Progress

**Execution Order:** 1 → 2 → 3 → 4 → 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. DB Models and Calculation Foundation | 2/2 | Complete | 2026-02-20 |
| 2. Scale Bridge Service | 1/1 | Complete | 2026-02-20 |
| 3. SSE Weight Streaming | 0/1 | Not started | - |
| 4. Wizard UI | 0/2 | Not started | - |
| 5. SENAITE Sample Lookup | 0/1 | Not started | - |

---

*Roadmap created: 2026-02-19*
*Milestone: v0.11.0 — New Analysis Wizard*
*Requirements: 31/31 mapped*
