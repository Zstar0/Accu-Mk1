# Feature Landscape: Multi-Instrument Automation Framework

**Domain:** Lab instrument automation — generalized ingest pipeline, polymorphic result types, endotoxin (LAL) and sterility testing
**Milestone:** v0.30.0 — Multi-Instrument Architecture
**Researched:** 2026-04-05
**Confidence:** HIGH (domain procedures), MEDIUM (LIMS schema patterns)

---

## Context

The existing HPLC pipeline is instrument-specific: `HplcMethod`, `peakdata_csv_parser`, `hplc_processor`, and the `FORMULA_REGISTRY` in `engine.py` are all HPLC-only. This milestone generalizes that into an instrument-agnostic framework and proves it with two new instrument types: endotoxin (LAL) and sterility. The framework must handle three fundamentally different result shapes:

- **HPLC:** multiple numeric outputs (purity %, quantity mg, identity pass/fail) derived from chromatographic peak data
- **LAL:** a single EU/mL numeric value derived from a log-log regression against a standard curve run in the same plate
- **Sterility:** a pass/fail verdict derived from 14-day timed observations of growth media — no calculation, pure human-observed judgment

The key architectural constraint: **all three must flow through a shared result storage model** that supports cross-sample analytics (trending, QC charting) and pushes to SENAITE using the same API mechanism.

---

## Result Type Taxonomy

Before feature classification, the result types must be clearly defined:

| Type | Example | Storage Shape | Calculation |
|------|---------|---------------|-------------|
| **Numeric (single)** | EU/mL = 0.42 | `{value: 0.42, unit: "EU/mL"}` | Backend regression |
| **Numeric (multi)** | Purity %, Quantity mg, RF | `[{key, value, unit}, ...]` | Backend formula chain |
| **Pass/Fail (derived)** | Sterility test | `{verdict: "pass", notes: "..."}` | Manual observation |
| **Pass/Fail (calculated)** | Identity check, PPC recovery | `{verdict: "pass", criterion: "50-200%", actual: 112}` | Backend threshold check |
| **Multi-point curve** | LAL standard curve | `{points: [{conc, onset_time}], r: 0.994, slope, intercept}` | Backend regression |
| **Qualitative** | Growth organism ID (future) | `{organism: "E. coli", confidence: "confirmed"}` | Manual entry |

The generalized framework must store all of these without requiring schema changes per instrument type. JSON columns in SQLite serve this role cleanly (already used in `Result.output_data`).

---

## Table Stakes

Features users expect when the framework launches. Missing these means the new instrument types cannot be used in production.

| Feature | Why Expected | Complexity | Existing Anchor |
|---------|--------------|------------|-----------------|
| **Generalized Method model** | Current `HplcMethod` is HPLC-specific with fields like `starting_organic_pct` and `size_peptide`. New instrument types need their own config. Framework must not force HPLC concepts onto non-HPLC instruments. | MEDIUM | `HplcMethod` model — needs generalization or a new `InstrumentMethod` with instrument-type-scoped config JSON |
| **Pluggable parser registry** | Each instrument type produces a different file format. The framework needs a `PARSER_REGISTRY` analogous to the existing `FORMULA_REGISTRY`, keyed by instrument type. | MEDIUM | `FORMULA_REGISTRY` in `engine.py` — the pattern exists, needs extraction to the right abstraction level |
| **Pluggable calculator registry** | Each instrument type has different calculation logic (regression vs formula chain vs none). A `CALCULATOR_REGISTRY` keyed by instrument type routes ingest to the right processor. | MEDIUM | `hplc_processor.py` is the only processor — the pattern to generalize |
| **Generalized result storage** | Results table already uses JSON `output_data` — this is the right shape. But the `calculation_type` field and lack of instrument-type scoping makes cross-instrument analytics hard. Needs `instrument_type`, `result_type`, and `analysis_service_id` fields. | MEDIUM | `Result` model already exists — needs column additions and migration |
| **Full audit trail on all result types** | GMP requirement. Every result must be traceable to who ran it, when, with what inputs, using what method and instrument. HPLC already does this via `AuditLog`. New types must match. | LOW | `AuditLog` table — already works, just needs callers for new types |
| **SENAITE push for new result types** | The whole point of the pipeline is pushing validated results to SENAITE. LAL pushes EU/mL as a numeric result. Sterility pushes Pass/Fail as text. Both must use the existing `POST /update/{uid}` mechanism. | LOW | `senaite.py` — push mechanism already exists, just needs the right value shape per analysis service |
| **Manual entry path** | Sterility has no file to import — results come from manual observation at 14 days. The framework needs a form-based ingest path, not just file import. LAL may also need manual entry when no software export is available. | HIGH | No existing pattern for manual ingest — new UI and API path required |
| **File import path (CSV/text)** | LAL plate readers (EndoScan-V, Softmax Pro) export CSV/text files with per-well onset times and calculated EU/mL values. The framework must accept these. | MEDIUM | `peakdata_csv_parser.py` and `txt_parser.py` — extend the pattern |
| **HPLC refactored to use the new framework** | The milestone requires HPLC to use the generalized pipeline without breaking existing functionality. This is a regression surface. | HIGH | `hplc_processor.py`, `engine.py`, `file_watcher.py` — all must be refactored |

---

## Endotoxin (LAL) Testing — Workflow and Required Features

LAL testing follows a defined pharmacopeial procedure (USP `<85>`, EP 2.6.14). The workflow shapes the feature requirements directly.

### LAL Workflow

1. Plate setup: standards run at multiple concentrations (typically 5 EU/mL → 0.005 EU/mL in 1:10 series, duplicates), plus unknowns and a Positive Product Control (PPC) well per unknown sample
2. Plate reader incubates at 37°C and measures absorbance (chromogenic: 405 nm) or turbidity kinetically
3. Software records onset time per well (the time to reach a defined OD threshold)
4. Standard curve: log(onset_time) vs log(concentration) — linear regression, r must be ≥ 0.980
5. Unknown EU/mL: back-calculated from the regression equation using each well's onset time
6. PPC check: spiked unknown must recover 50–200% of the spike concentration — if outside, the test is invalid and must be repeated
7. Maximum Valid Dilution (MVD): the sample cannot be diluted past the MVD without invalidating the claim; MVD = (endotoxin limit × weight or volume) / lambda (reagent sensitivity)
8. Final reported result: EU/mL for each sample, with validity flag

### LAL-Specific Feature Requirements

| Feature | Why Required | Complexity | Notes |
|---------|--------------|------------|-------|
| **Standard curve storage and r-value validation** | Every LAL run needs its own standard curve. The curve is run-specific, not a shared calibration artifact. r ≥ 0.980 is a hard validity gate. | MEDIUM | Similar to HPLC calibration curve — store slope, intercept, r per run. Block result approval if r < 0.980. |
| **Per-run validity gate: PPC recovery 50–200%** | If the PPC spike recovery is outside 50–200%, the entire plate run is invalid per USP `<85>`. System must enforce this, not just display it. | MEDIUM | Back-calculate PPC recovery: (PPC_result - unspiked_result) / spike_concentration × 100. Flag run as INVALID if outside range. |
| **EU/mL result per sample with provenance** | The final result is a single EU/mL value. But provenance includes: which standard curve was used, which well(s) the sample occupied, the onset times of each replicate, the dilution factor applied. | MEDIUM | Store in `output_data` JSON: `{eu_ml: 0.42, dilution_factor: 4, replicate_onset_times: [234, 241], standard_curve_id: 7}` |
| **Dilution factor input for MVD tracking** | If a sample required dilution before testing, the EU/mL in the diluted sample must be multiplied back by the dilution factor to report on the original sample. Operator inputs the dilution factor. | LOW | A field in the manual entry form or parsed from the export file |
| **CSV/text export parsing from EndoScan-V or MARS** | EndoScan-V (Charles River) exports CSV with onset times, calculated EU/mL per well, and standards. MARS (BMG) exports similar formats. Parsing must handle these. | HIGH | New parser in `parsers/` — no existing reference. Format must be researched from actual export files (flag for deeper research in roadmap). |
| **Manual EU/mL entry fallback** | When no software export is available (gel-clot method, or missing file), operator enters EU/mL directly with a note. Less common but required for completeness. | LOW | Simple form: numeric input + free text notes field |

---

## Sterility Testing — Workflow and Required Features

Sterility testing (USP `<71>`) is fundamentally different from HPLC or LAL: there is no instrument export, no calculation, and the result is only known after 14 days of incubation.

### Sterility Workflow

1. Test initiation: samples are inoculated into Fluid Thioglycollate Medium (FTM, for anaerobes) and Soybean-Casein Digest Medium (SCDB/TSB, for aerobes/fungi) — either by membrane filtration or direct inoculation
2. Incubation: 14 days minimum at controlled temperature (FTM: 30–35°C; SCDB: 20–25°C)
3. Observation schedule: observed "several times" during incubation and at 14 days — industry practice is daily reads
4. Growth observation: turbidity = growth detected (fail). No turbidity = no growth (pass criteria met, but final verdict at 14 days)
5. Final verdict: Pass (no growth at 14 days) or Fail (growth observed, plus investigation required). Invalid result is possible if environmental monitoring or positive control fails.
6. Fail investigation: OOS investigation, potential repeat test (once, with same unit count) if contamination is extrinsic

### Sterility-Specific Feature Requirements

| Feature | Why Required | Complexity | Notes |
|---------|--------------|------------|-------|
| **Test record initiation form** | No file to import. Operator must create a test record: sample ID(s), method (membrane filtration or direct inoculation), media lots, incubation start date, expected completion date. | MEDIUM | New form UI — no existing pattern in this app. Can reuse shadcn form components. |
| **Daily/periodic observation recording** | 14-day timeline with observation checkboxes or text entries per vessel. Each observation: date, observer, growth yes/no, notes. | HIGH | Requires a sub-table or JSON-array observation history in the result record. New UI pattern — a timeline or table of observations within the result detail. |
| **Timed completion gate** | Test cannot be called Pass until ≥14 days have elapsed since initiation. System must enforce this: disable "Complete as Pass" button until day 14 reached. | LOW | Compare `initiation_date + 14 days` to `now()` before allowing final verdict. |
| **Pass/Fail verdict with growth detail** | Final verdict: Pass or Fail. If Fail, which vessel showed growth, on which day, and what the growth looked like (turbidity, color change). | LOW | Output shape: `{verdict: "fail", failing_vessels: ["FTM-1"], growth_day: 7, notes: "..."}` |
| **Investigational hold status** | Failed sterility tests trigger an OOS investigation. System should flag the result as "Under Investigation" before a final disposition is made. | LOW | An additional status field on the sterility result: `pending_investigation` state. |
| **SENAITE push as text/pass-fail value** | SENAITE analysis service for sterility will expect a string ("Pass" or "Fail") or a numeric flag. The push must send the right field type. | LOW | Verify with SENAITE analyst service configuration — pass/fail is a text result in SENAITE |

---

## Differentiators

Features that go beyond the minimum, adding workflow value specific to this app's operator-centered design.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **LAL run validity dashboard** | At-a-glance view of standard curve r-value, PPC recovery %, and a green/red run validity indicator. Saves the operator from interpreting raw numbers. | LOW | Derived from stored curve parameters — display only |
| **Endotoxin limit comparison** | Display the product's endotoxin limit (EU/mL or EU/mg) alongside the measured result, with a pass/fail indicator. Lab techs currently check this manually against a spec sheet. | MEDIUM | Requires storing the endotoxin limit per analysis service or per sample type — new config field |
| **Sterility test age indicator** | For in-progress sterility tests, show days elapsed / 14 days with a progress bar. Tests are easy to lose track of with multiple concurrent runs. | LOW | Computed from `initiation_date` — display only |
| **Cross-instrument result history per sample** | When reviewing a sample, show all result types (HPLC purity, LAL EU/mL, sterility verdict) in a unified timeline. Currently only HPLC results are visible. | MEDIUM | Requires `instrument_type` on the result model and a unified result display component |
| **Analytics schema for trending** | Design the result schema with analytics queries in mind: index by `sample_type`, `instrument_type`, `analysis_service_id`, `result_date`. Even if the reporting UI is deferred, the schema should not block it. | MEDIUM | Schema design only — no reporting UI in v0.30.0 |

---

## Anti-Features

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Instrument-specific UI pages per type** | If sterility gets its own page and LAL gets its own page, adding the 4th instrument type (LCMS) requires yet another page. This explodes maintenance surface. | Use a single `InstrumentResultDetail` component that renders different sections based on `instrument_type`. Result shape differences go in the data, not in the route tree. |
| **Recalculating the LAL standard curve on the frontend** | Log-log regression is non-trivial to get right in TypeScript, and it would violate the project's core rule: backend owns all scientific calculations. | Backend receives onset times and concentrations, returns EU/mL. Frontend shows the result. Never implement regression in JS. |
| **Soft-blocking result approval based on PPC recovery** | The urge is to let operators override the PPC gate "with justification." This creates a path to approving invalid tests. | Hard-block approval of invalid runs. If a run is invalid, it must be re-run. Allow the run to be marked "Invalid" with a reason, but not approved. |
| **Building a 14-day observation scheduler / reminder system** | Email/push reminders for daily sterility observations are out of scope and require notification infrastructure (email SMTP, push service). | Show the current test status and age prominently in the UI. Operators check the app as part of their daily routine. |
| **Storing raw plate reader kinetic data (full absorbance time series)** | Full kinetic traces can be megabytes per well, multiplied across 96-well plates. Storing this in SQLite creates bloat and serves no query purpose. | Store only the derived onset time per well, the curve parameters, and the final EU/mL. Raw traces stay in the instrument software or are exported separately if needed for audit. |
| **Automatic instrument file discovery for LAL** | The folder-watch pattern works for HPLC because Agilent/Waters exports CSVs to a watched directory automatically. LAL plate reader software (EndoScan-V) requires manual export. | File upload/browse UI for LAL, not folder watch. Keep folder watch for HPLC only. |
| **Combining LAL and sterility into one "microbiology" instrument type** | They share a department but have completely different result shapes, workflow timelines, and validity criteria. Conflating them would force one to compromise for the other. | Separate instrument types: `"LAL"` and `"STERILITY"`. Shared service group is fine; shared instrument type is not. |

---

## Feature Dependencies

```
Generalized Method model
    └──requires──> New DB schema migration (replace/extend HplcMethod)
    └──requires──> Instrument model gains instrument_type enforcement

Pluggable parser registry
    └──requires──> Generalized Method model (to know which parser to invoke)
    └──requires──> LAL CSV parser (new, EndoScan-V/MARS format)
    └──requires──> Sterility has no parser (manual entry path instead)

Pluggable calculator registry
    └──requires──> Generalized Method model
    └──requires──> LAL calculator (log-log regression → EU/mL)
    └──requires──> Sterility has no calculator (verdict is entered directly)
    └──requires──> HPLC calculator refactored to register in new framework

Generalized result storage model
    └──requires──> DB migration: add instrument_type, result_type, analysis_service_id to Result
    └──required_by──> LAL EU/mL result storage
    └──required_by──> Sterility pass/fail result storage
    └──required_by──> HPLC result storage (refactored)
    └──required_by──> Cross-instrument analytics schema

LAL standard curve (per-run)
    └──requires──> New model or JSON structure: StandardCurveRun
    └──requires──> LAL calculator (uses curve to back-calculate EU/mL)
    └──required_by──> PPC validity check
    └──required_by──> EU/mL result provenance

LAL result with PPC validity
    └──requires──> LAL standard curve (per-run)
    └──requires──> LAL calculator
    └──requires──> Manual or file-parsed onset times for PPC well

Sterility test record
    └──requires──> Manual entry UI (no file import)
    └──requires──> Observation sub-table (daily reads)
    └──requires──> Timed completion gate (≥14 days)
    └──required_by──> Sterility pass/fail result

HPLC refactor
    └──requires──> Generalized Method model (backwards compatible)
    └──requires──> Pluggable calculator registry
    └──requires──> All existing HPLC tests passing after refactor

SENAITE push (all instrument types)
    └──requires──> Generalized result storage (to know what value to push)
    └──requires──> Existing senaite.py push mechanism (no new infra needed)
```

---

## MVP Definition

### Must-Build for v0.30.0

- [ ] Generalized Method model — replaces `HplcMethod` with instrument-type config; HPLC backwards compatible
- [ ] Parser/calculator registry — pluggable by instrument type; HPLC registers in it
- [ ] Generalized result storage — `Result` gains `instrument_type`, `result_type`, `analysis_service_id`; JSON `output_data` remains the value bag
- [ ] HPLC refactored to use the framework — no regression in existing behavior
- [ ] LAL manual entry path — EU/mL + dilution factor + notes; no file parsing required for MVP
- [ ] LAL standard curve storage (per-run) — slope, intercept, r; r ≥ 0.980 gate enforced
- [ ] LAL PPC validity check — 50–200% recovery gate enforced
- [ ] Sterility manual entry path — test initiation form, daily observation recording, 14-day gate, pass/fail verdict
- [ ] SENAITE push for LAL (EU/mL numeric) and sterility (Pass/Fail string)
- [ ] Analytics schema design — indexes and FKs are set; reporting UI deferred

### Defer to v0.31.0+

- [ ] LAL CSV file parser (EndoScan-V/MARS format) — requires actual export files from the lab; flag for research
- [ ] Endotoxin limit comparison (EU/mL vs spec limit) — requires spec limit config per sample type
- [ ] Sterility observation reminder / age alert
- [ ] Cross-instrument result timeline in sample detail
- [ ] Analytics / trending UI

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Generalized Method model | HIGH | MEDIUM | P1 |
| Parser/calculator registry | HIGH | MEDIUM | P1 |
| Generalized result storage | HIGH | MEDIUM | P1 |
| HPLC refactor (framework migration) | HIGH | HIGH | P1 |
| LAL manual entry + EU/mL result | HIGH | MEDIUM | P1 |
| LAL standard curve + PPC gate | HIGH | MEDIUM | P1 |
| Sterility manual entry + observations | HIGH | HIGH | P1 |
| SENAITE push for new types | HIGH | LOW | P1 |
| Analytics schema design | MEDIUM | LOW | P1 |
| LAL CSV file parser | MEDIUM | HIGH | P2 |
| Endotoxin limit comparison | MEDIUM | MEDIUM | P2 |
| Cross-instrument result timeline | MEDIUM | MEDIUM | P2 |
| Sterility age indicator | LOW | LOW | P2 |
| Analytics/trending UI | HIGH | HIGH | P3 |

---

## Confidence Assessment

| Area | Confidence | Source |
|------|------------|--------|
| LAL workflow (standards, PPC, r-value gate, EU/mL calculation) | HIGH | USP `<85>`, EP 2.6.14, Charles River EndoScan-V docs, validated PMC study |
| Sterility workflow (USP `<71>`, 14-day, membrane/direct, pass/fail) | HIGH | USP `<71>` text, multiple accredited lab procedure docs |
| LAL CSV export format (EndoScan-V, MARS) | LOW | Confirmed CSV/XML export exists; exact column names and format require actual file samples from the lab |
| HPLC refactor risk | HIGH | Existing codebase read — `engine.py`, `hplc_processor.py` are well-structured; registry pattern already present |
| SENAITE push for pass/fail as text | MEDIUM | SENAITE analysis services accept text results; confirmed by existing integration; exact field type for sterility needs lab config verification |
| Generalized result storage via JSON `output_data` | HIGH | Existing `Result` model already uses JSON columns — confirmed in `models.py` |

---

## Sources

- USP `<85>` Bacterial Endotoxins Test — pharmacopeial standard
- EP 2.6.14 — European Pharmacopoeia endotoxin chapter
- [Endotoxin Determination by Kinetic Chromogenic Testing — Frederick Cancer Research](https://frederick.cancer.gov/sites/default/files/2022-03/Endotoxin_Determination_by_Kinetic_Chromogenic_Testing_Using_Charles_River_LAL_System.pdf)
- [EndoScan-V Software — Charles River](https://www.criver.com/products-services/qc-microbial-solutions/endotoxin-testing/endotoxin-testing-software-instrumentation/endoscan-v)
- [Nelson Labs — PPC, Inhibition and Enhancement](https://www.nelsonlabs.com/what-is-a-ppc-what-is-inhibition-and-enhancement/)
- [LAL Assay Validation — PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC8408548/)
- [FDA Guidance: Pyrogen and Endotoxins Testing](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/guidance-industry-pyrogen-and-endotoxins-testing-questions-and-answers)
- [USP `<71>` Sterility Tests — Certified Laboratories Guide](https://certified-laboratories.com/blog/step-by-step-guide-to-usp-71-sterility-testing-methods/)
- [Sterility Testing — Direct Inoculation vs Membrane Filtration — ContractLaboratory](https://contractlaboratory.com/sterility-testing/)
- [SENAITE 2.6.0 Release Notes — multi-result analysis specifications](https://pypi.org/project/senaite.core/)
- Existing codebase: `backend/models.py`, `backend/calculations/engine.py`, `backend/calculations/hplc_processor.py`

---
*Feature research for: multi-instrument lab automation (LAL + sterility + HPLC generalization)*
*Researched: 2026-04-05*
