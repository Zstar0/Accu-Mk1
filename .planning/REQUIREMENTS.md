# Requirements: Accu-Mk1 v0.11.0 — New Analysis Wizard

**Defined:** 2026-02-19
**Core Value:** Guide lab tech through sample prep step-by-step with auto weight capture — stock prep → dilution → ready for HPLC injection

## v0.11.0 Requirements

Requirements for the New Analysis Wizard milestone.

### Session

- [x] **SESS-01**: Tech can start a new analysis session from the New Analysis page
- [x] **SESS-02**: Session state is autosaved after each step so tech can resume if they navigate away
- [x] **SESS-03**: All measurements, calculated values, and timestamps are persisted to DB on completion
- [x] **SESS-04**: Completed sessions appear in Analysis History

### Wizard UI

- [x] **WIZ-01**: Wizard displays vertical step list (left sidebar) + content panel (right) — Stripe-style layout
- [x] **WIZ-02**: Steps show 4 states: not-started, in-progress, complete, locked
- [x] **WIZ-03**: Steps advance sequentially — tech cannot skip ahead
- [x] **WIZ-04**: Tech can navigate back to review completed steps
- [x] **WIZ-05**: Transitions between steps are animated and fluid

### Sample Lookup

- [x] **SMP-01**: Tech searches for a sample by SENAITE sample ID
- [x] **SMP-02**: App displays retrieved details: sample ID, peptide name, declared weight (mg)
- [x] **SMP-03**: If SENAITE is unavailable, tech can enter sample details manually
- [x] **SMP-04**: Tech enters target concentration (µg/mL) and target total volume (µL)

### Stock Preparation

- [x] **STK-01**: Wizard instructs tech to weigh empty sample vial + cap; app captures weight
- [x] **STK-02**: Wizard instructs tech to transfer peptide; tech confirms when done
- [x] **STK-03**: App displays calculated diluent volume to add (in µL)
- [x] **STK-04**: Wizard instructs tech to add diluent then re-weigh vial; app captures weight
- [x] **STK-05**: App calculates and displays: actual diluent added (mL) and stock concentration (µg/mL)

### Dilution

- [x] **DIL-01**: App calculates and displays required diluent volume + stock volume for target conc/volume
- [x] **DIL-02**: Wizard instructs tech to weigh a new empty dilution vial + cap; app captures weight
- [x] **DIL-03**: Wizard instructs tech to add diluent volume then re-weigh; app captures weight
- [x] **DIL-04**: Wizard instructs tech to add stock volume then weigh final dilution vial; app captures weight
- [x] **DIL-05**: App calculates and displays actual concentration and actual total volume

### Scale Integration

- [x] **SCALE-01**: Backend connects to Mettler Toledo XSR105DU via TCP using MT-SICS protocol
- [x] **SCALE-02**: App streams live weight readings to the wizard UI via SSE
- [x] **SCALE-03**: App detects stable weight (5 consecutive readings within 0.5 mg) and signals the tech visually
- [x] **SCALE-04**: Tech can manually enter a weight at any step if scale is offline
- [x] **SCALE-05**: Scale IP and port are configurable in app settings

### Results

- [x] **RES-01**: After HPLC run, tech can enter the peak area for the injection
- [x] **RES-02**: App calculates determined concentration, dilution factor, peptide mass (mg), and purity (%)
- [x] **RES-03**: Results summary shows all prep measurements alongside the final HPLC results

## Future Requirements

### Wizard UI

- **WIZ-F01**: Keyboard navigation through wizard steps
- **WIZ-F02**: Inline help text / SOP reference for each step

### Scale Integration

- **SCALE-F01**: Multiple injections tracked per session (batch of vials)
- **SCALE-F02**: Historical scale readings review per session

### Results

- **RES-F01**: Push results directly to SENAITE after HPLC run
- **RES-F02**: Generate prep sheet PDF for lab records

## Out of Scope

| Feature | Reason |
|---------|--------|
| Multiple samples per session | One-at-a-time keeps wizard focused; batch queuing is v2 |
| SENAITE results push | Requires result field mapping validation; deferred to v2 |
| Instrument control (HPLC start/stop) | App processes exports, doesn't talk to HPLC |
| Email/notification on completion | No email infra in v1 |
| PDF prep sheet export | Nice-to-have; wizard record in DB serves audit trail for v1 |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SESS-01 | Phase 1 — DB Models and Calculation Foundation | Complete |
| SESS-02 | Phase 1 — DB Models and Calculation Foundation | Complete |
| SESS-03 | Phase 1 — DB Models and Calculation Foundation | Complete |
| STK-05 | Phase 1 — DB Models and Calculation Foundation | Complete |
| DIL-01 | Phase 1 — DB Models and Calculation Foundation | Complete |
| DIL-05 | Phase 1 — DB Models and Calculation Foundation | Complete |
| RES-02 | Phase 1 — DB Models and Calculation Foundation | Complete |
| SCALE-01 | Phase 2 — Scale Bridge Service | Complete |
| SCALE-05 | Phase 2 — Scale Bridge Service | Complete |
| SCALE-02 | Phase 3 — SSE Weight Streaming | Complete |
| SCALE-03 | Phase 3 — SSE Weight Streaming | Complete |
| SCALE-04 | Phase 3 — SSE Weight Streaming | Complete |
| WIZ-01 | Phase 4 — Wizard UI | Complete |
| WIZ-02 | Phase 4 — Wizard UI | Complete |
| WIZ-03 | Phase 4 — Wizard UI | Complete |
| WIZ-04 | Phase 4 — Wizard UI | Complete |
| WIZ-05 | Phase 4 — Wizard UI | Complete |
| SMP-04 | Phase 4 — Wizard UI | Complete |
| STK-01 | Phase 4 — Wizard UI | Complete |
| STK-02 | Phase 4 — Wizard UI | Complete |
| STK-03 | Phase 4 — Wizard UI | Complete |
| STK-04 | Phase 4 — Wizard UI | Complete |
| DIL-02 | Phase 4 — Wizard UI | Complete |
| DIL-03 | Phase 4 — Wizard UI | Complete |
| DIL-04 | Phase 4 — Wizard UI | Complete |
| RES-01 | Phase 4 — Wizard UI | Complete |
| RES-03 | Phase 4 — Wizard UI | Complete |
| SESS-04 | Phase 4 — Wizard UI | Complete |
| SMP-01 | Phase 5 — SENAITE Sample Lookup | Complete |
| SMP-02 | Phase 5 — SENAITE Sample Lookup | Complete |
| SMP-03 | Phase 5 — SENAITE Sample Lookup | Complete |

---
*Requirements defined: 2026-02-19*
*Last updated: 2026-02-20 — Phase 5 requirements marked Complete*
