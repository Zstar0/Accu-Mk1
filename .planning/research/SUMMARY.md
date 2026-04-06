# Project Research Summary

**Project:** Accu-Mk1 v0.30.0 Multi-Instrument Automation Framework
**Domain:** GMP lab instrument automation -- HPLC generalization + endotoxin (LAL) + sterility
**Researched:** 2026-04-05
**Confidence:** HIGH (codebase directly inspected; pharmacopeial standards cited; SQLAlchemy official docs)

---

## Executive Summary

AccuMark HPLC-only pipeline must be generalized into a multi-instrument framework handling three result shapes: multi-numeric chromatographic output (HPLC), single EU/mL numeric from log-log regression (LAL/endotoxin), and human-observed pass/fail over 14-day incubation (sterility). The recommended approach: (1) generalize HplcMethod into a Method table with method_type discriminator and JSON config; (2) introduce InstrumentResult as a shared result envelope while preserving HPLCAnalysis via forward FK; (3) promote FORMULA_REGISTRY into an INSTRUMENT_REGISTRY coupling parser and calculator per instrument type. Only one new dependency is needed: Alembic, to handle migrations that create_all() cannot.

The most time-critical work is structural, not feature-building. main.py is 11,785 lines and will become unworkable if new instrument routers are added inline. Router extraction must happen in Phase 1, before any new instrument code is written. Alembic must be introduced before new tables are created, because the current _run_migrations() pattern swallows exceptions silently (bare except at line 172 of database.py). HPLC regression tests must be written before the schema is touched, because the refactor renames tables and moves FKs on a production-critical code path with no existing test coverage.

The two highest-confidence risks: (a) schema design -- putting instrument-specific scalar values into Result.output_data JSON instead of typed columns permanently blocks analytics queries; (b) SENAITE field mapping -- pushing the wrong result type to the wrong analysis service UID is silent data corruption discoverable only by reading SENAITE UI. Both are preventable with upfront decisions.

---

## Key Findings

### Recommended Stack

The existing FastAPI / SQLAlchemy 2.0 / SQLite / Pydantic / openpyxl stack handles everything this milestone requires. No new runtime libraries are needed for instrument logic. The one addition is **Alembic >=1.13.0,<2.0** -- the official SQLAlchemy migration tool, supports SQLite batch mode for ALTER TABLE limitations, and 1.13+ is required for SQLAlchemy 2.0 mapped_column style (current stable: 1.18.4). All LAL CSV parsing uses stdlib csv and openpyxl already installed. Sterility is manual-entry only -- no parser needed.

**Core technologies:**
- **Alembic 1.13+** -- schema migrations -- the only new dependency; create_all() silently skips existing tables and cannot rename hplc_methods or add discriminator columns
- **SQLAlchemy 2.0 single-table approach** -- one instrument_results table filtered by instrument_type; enables cross-instrument analytics without UNION queries
- **Python typing.Protocol** -- plugin registry -- stdlib only; no pluggy or stevedore warranted for 3-6 known instrument types in a closed application
- **FastAPI BackgroundTasks** -- async ingest -- zero-dependency; no Redis or Celery for sub-second file processing
- **SQLite JSON1 (core since 3.38)** -- result_data and calculation_trace JSON columns for non-queryable structured data; scalar results in typed columns

**Critical version requirement:** Alembic 1.13+ for SQLAlchemy 2.0 compatibility. Current stable is 1.18.4.

### Expected Features

The milestone delivers framework plumbing plus two new instrument types. LAL file parsing (EndoScan-V/MARS CSV) is explicitly deferred to v0.31.0 because actual export files have not been obtained and column names are unverified.

**Must have (table stakes -- v0.30.0):**
- Generalized Method model replacing HplcMethod with method_type discriminator and JSON config -- HPLC backwards compatible
- Plugin parser/calculator registry keyed by instrument type, with HPLC refactored to register via shim
- InstrumentResult table with typed result_numeric, result_pass, result_unit columns plus JSON result_data and calculation_trace
- LAL manual entry path -- EU/mL + dilution factor + notes (no file parsing for MVP)
- LAL per-run standard curve -- slope, intercept, r-value; hard gate at r >= 0.980 (USP <85>)
- LAL PPC recovery validity check -- 50-200% range; hard block on invalid run approval (no soft-override)
- Sterility manual entry -- test initiation form, periodic observation recording, 14-day timed completion gate, pass/fail verdict
- SENAITE push for LAL (EU/mL numeric) and sterility (Pass/Fail text) to correct analysis service UIDs
- Analytics-ready schema -- indexed on instrument_type, analyte_id, created_at; reporting UI deferred
- Full audit trail via existing AuditLog for all new result types

**Should have (differentiators -- v0.30.0 if capacity allows):**
- LAL run validity dashboard -- r-value, PPC recovery %, green/red run validity indicator
- Sterility test age indicator -- days elapsed / 14 days with progress bar
- Cross-instrument result history per sample -- unified timeline across HPLC, LAL, sterility

**Defer to v0.31.0+:**
- LAL CSV file parser (EndoScan-V/MARS format) -- requires actual export files from lab; column names unverified
- Endotoxin limit comparison (EU/mL vs product spec limit) -- requires per-sample-type limit config
- Analytics / trending UI

**Hard anti-features (never build):**
- LAL standard curve regression on the frontend -- backend owns all scientific calculations
- Soft-override on PPC validity gate -- invalid LAL runs must be re-run, not approved with justification
- Automatic folder-watch for LAL files -- EndoScan-V requires manual export; file upload UI is correct
- Combining LAL and sterility into one microbiology instrument type -- incompatible result shapes and validity criteria

### Architecture Approach

The architecture is additive, not a rewrite. HPLCAnalysis, hplc_processor.py, and peakdata_csv_parser.py are left unchanged during the schema refactor. New tables are created alongside existing ones; HPLCAnalysis gains one FK column (instrument_result_id) linking forward to InstrumentResult for new analyses. Old records remain queryable with instrument_result_id = NULL. A two-migration strategy eliminates the risk of a destructive migration on production data.

**Major components:**
1. **backend/instruments/ package** -- registry.py (INSTRUMENT_REGISTRY dict), base.py (InstrumentPlugin Protocol, ParsedData, CalculatedResult dataclasses), per-type subdirectories (hplc/, endotoxin/, sterility/). HPLC plugin wraps existing processor via shim -- zero changes to existing files.
2. **Method model (methods table)** -- replaces HplcMethod; method_type discriminator + config JSON; new junction tables instrument_methods_v2 and analyte_methods; old junction tables preserved during transition.
3. **InstrumentResult model (instrument_results table)** -- typed columns result_numeric, result_pass, result_unit; JSON columns result_data, calculation_trace, raw_input; sample_prep_id integer preserved as cross-DB reference (no FK possible -- lives in separate accumark_mk1 DB).
4. **routers/ package** -- extracted from main.py; hplc.py, ingest.py, senaite.py, worksheets.py, admin.py, endotoxin.py, sterility.py; main.py becomes app setup + router includes only (<200 lines).
5. **Alembic migration chain** -- versioned scripts replacing _run_migrations() raw SQL; handles hplc_methods rename, new table creation, data backfill, junction table migration using SQLite batch mode.

### Critical Pitfalls

1. **JSON blob for scalar instrument results** -- putting EU/mL and pass/fail into Result.output_data JSON makes analytics impossible without full-table scans. InstrumentResult must have typed result_numeric and result_pass columns indexed for query. Decision must be made before any new instrument code is written -- retrofitting requires backfilling every existing row.

2. **Adding new routers to main.py** -- 11,785 lines already; adding endotoxin and sterility routers inline pushes it past 15,000 lines. Router extraction is Phase 1, strictly before new instrument code.

3. **Skipping HPLC regression tests before schema refactor** -- the refactor renames tables, moves FKs, and changes result storage on a production-critical code path with no existing test coverage. Integration tests (parse CSV -> analyze -> assert purity_percent) must gate all schema changes.

4. **SENAITE field mapping by instrument type** -- pushing EU/mL to a sterility analysis service, or pushing to the first analysis service UID rather than the correct one, is silent data corruption. InstrumentResult must store a senaite_result_value field computed at calculation time; the push endpoint reads this field, not raw numerics.

5. **Silent _run_migrations() failures** -- bare except at line 172 of database.py swallows all migration errors. Multi-instrument schema changes add 10-15 new migration statements. Introduce Alembic before writing new tables, or remove the bare except and number existing migration blocks sequentially.

6. **Cross-DB sample_prep_id reference lost during refactor** -- HPLCAnalysis.sample_prep_id is an integer with no FK because sample_preps lives in a separate DB (mk1_db.py), documented only in a code comment. InstrumentResult must carry this field explicitly with a cross_db_ref comment; whether LAL and sterility link to preps must be decided at schema-design time.

---

## Implications for Roadmap

All structural work must precede all feature work. The dependency chain: Alembic before schema, regression tests before schema, router extraction before new instrument routers, schema before plugin registration, plugin registration before ingest endpoints, ingest endpoints before SENAITE push.

### Phase 1: Foundation -- Alembic, Router Extraction, HPLC Regression Tests
**Rationale:** Three blockers must be cleared before any new instrument code is written. None deliver user-visible features. All three eliminate the most likely failure modes.
**Delivers:** Alembic initialized with current schema as baseline; main.py reduced to <200 lines; HPLC integration test suite covering parse -> analyze -> assert purity_percent.
**Addresses:** main.py monolith (Pitfall 2), _run_migrations() silent failures (Pitfall 5), HPLC regression risk (Pitfall 3).
**Research flag:** Standard patterns -- skip /gsd:research-phase. Alembic init and FastAPI router extraction are well-documented.

### Phase 2: Schema Generalization -- Method + InstrumentResult Models
**Rationale:** The table shapes are the foundation everything else builds on. If wrong, recovery requires backfilling every result row. Schema must be finalized before any plugin writes results.
**Delivers:** methods table with method_type discriminator and JSON config; new junction tables; instrument_results table with typed result columns and analytics indexes; HPLCAnalysis gains instrument_result_id FK; Alembic migration; sample_prep_id on InstrumentResult with cross_db_ref comment.
**Addresses:** JSON blob trap (Pitfall 1), HplcMethod generalization (Pitfall 2), cross-DB sample_prep_id (Pitfall 6), analytics schema design.
**Research flag:** Standard patterns -- skip /gsd:research-phase.

### Phase 3: HPLC Refactor -- Register in Plugin Framework
**Rationale:** HPLC must be registered in the new framework before adding new instrument types, to validate the framework and avoid maintaining two parallel ingest paths. The refactor is a wrapping shim -- existing processor files are not modified. Phase 1 regression tests gate this work.
**Delivers:** backend/instruments/ package with INSTRUMENT_REGISTRY; HplcPlugin wrapping existing parser and processor; new HPLC ingest path writes InstrumentResult first then HPLCAnalysis with instrument_result_id set; all Phase 1 regression tests pass post-refactor.
**Addresses:** Pluggable parser/calculator registry (table stakes), HPLC refactored to use framework (table stakes). Plugin Protocol kept to 3 methods: parse, calculate, supports_manual_entry.
**Research flag:** Standard patterns -- skip /gsd:research-phase.

### Phase 4: LAL (Endotoxin) -- Manual Entry MVP
**Rationale:** First new instrument type. Manual entry before file parsing because LAL export file format is unverified (LOW confidence on EndoScan-V column names). The LAL calculator is required even for manual entry because operators input onset times and the backend must compute EU/mL.
**Delivers:** endotoxin/ plugin (manual entry path); LAL calculator (log-log regression, EU/mL back-calculation, PPC 50-200% hard gate, r >= 0.980 standard curve gate); standard curve stored in result_data JSON; endotoxin router; SENAITE push for EU/mL to correct analysis service UID; LAL run validity display.
**Addresses:** LAL manual entry, LAL standard curve and PPC gate, SENAITE push for LAL (table stakes), LAL run validity dashboard (differentiator), SENAITE field mapping (Pitfall 4).
**Research flag:** LAL calculation logic is HIGH confidence (USP <85>). SENAITE analysis service keyword and field type for endotoxin MUST be verified in the lab SENAITE instance before push logic is wired.

### Phase 5: Sterility -- Manual Entry + 14-Day Observation Workflow
**Rationale:** Entirely manual entry -- no file parsing, no calculation. Complexity is the observation timeline UI and timed completion gate. Isolated from LAL; follows cleanly after the plugin framework is validated.
**Delivers:** sterility/ plugin (manual-entry only); sterility initiation form; observation recording in result_data JSON array; 14-day timed completion gate enforced server-side; pass/fail verdict with failing vessel detail; investigational_hold status; SENAITE push as Pass/Fail text; sterility test age indicator.
**Addresses:** Sterility manual entry and observations (table stakes), SENAITE push for sterility (table stakes), sterility age indicator (differentiator).
**Research flag:** USP <71> workflow is HIGH confidence. SENAITE field type for sterility pass/fail text needs same lab verification as Phase 4.

### Phase 6: LAL File Parser (v0.31.0)
**Rationale:** EndoScan-V and MARS CSV export formats are unverified. Building a parser against assumed column names creates a brittle artifact that breaks on the first real export file.
**Delivers:** endotoxin/parser.py for EndoScan-V and MARS CSV formats using can_parse() self-identification by column headers; file upload UI for LAL (not folder watch).
**Research flag:** NEEDS /gsd:research-phase. Obtain actual LAL export files from the lab before planning. Multiple InstrumentParser subclasses registered under endotoxin is the correct pattern -- not a single universal parser.

### Phase Ordering Rationale

- **Foundation before schema** -- Alembic and router extraction eliminate the highest-probability failure modes before any new code is written. Non-optional.
- **Schema before plugins** -- InstrumentResult shape determines what every plugin writes; changing it after plugins are built requires updating all plugins.
- **HPLC before new types** -- validates the plugin framework against a well-understood production-tested code path. Framework errors surface on HPLC before infecting new instrument code.
- **LAL before sterility** -- LAL has a quantitative calculator (verifiable); sterility is pass/fail. LAL validates the calculator interface more thoroughly.
- **LAL manual before LAL file** -- file format unverified; manual entry delivers immediate clinical value without parser risk.

### Research Flags

Needs deeper research during planning:
- **Phase 4 (LAL) and Phase 5 (sterility):** SENAITE analysis service keyword and field type for endotoxin and sterility -- verify in the lab SENAITE instance before implementing push logic. Pushing to wrong analysis UID is silent data corruption.
- **Phase 6 (LAL file parser):** Obtain actual EndoScan-V and MARS export files before planning. Do not estimate without real file samples.

Standard patterns (skip /gsd:research-phase):
- **Phase 1:** Alembic init, FastAPI router extraction -- official docs, well-trodden.
- **Phase 2:** SQLAlchemy 2.0, Alembic batch mode -- official docs, HIGH confidence.
- **Phase 3:** Python Protocol wrapping -- stdlib, HIGH confidence.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All claims verified against official SQLAlchemy 2.0, Alembic changelog, Python stdlib docs. Single new dependency (Alembic 1.13+) confirmed compatible with existing SQLAlchemy 2.0.35. |
| Features | HIGH (workflow) / LOW (LAL file format) | USP <85> and <71> are authoritative for workflow requirements. LAL CSV column names from EndoScan-V/MARS are unverified without actual export files. |
| Architecture | HIGH | All patterns verified against actual codebase: models.py (662 lines, 17 model classes), main.py (11,785 lines, 180+ endpoints), database.py (30+ raw SQL migrations with bare except at line 172), engine.py (FORMULA_REGISTRY), mk1_db.py (cross-DB boundary). No assumptions about code structure. |
| Pitfalls | HIGH | Derived from direct code inspection. Bare except in _run_migrations() confirmed at line 172. Cross-DB sample_prep_id confirmed in HPLCAnalysis. JSON blob in Result.output_data confirmed as current pattern. |

**Overall confidence:** HIGH for architecture and stack decisions. The one LOW-confidence area (LAL file format) is explicitly deferred to v0.31.0.

### Gaps to Address

- **LAL export file format:** EndoScan-V and MARS CSV formats unverified. Lab must provide actual export files before Phase 6 can be planned. Do not guess column names.
- **SENAITE analysis service config for LAL and sterility:** The specific keyword values and field types in the lab SENAITE instance are unknown. Must be verified before Phase 4/5 SENAITE push is implemented.
- **LAL and sterility linkage to sample preps:** Whether LAL and sterility results originate from prep workflows (requiring sample_prep_id on InstrumentResult) must be confirmed with lab workflow before Phase 2 schema is finalized.

---

## Sources

### Primary (HIGH confidence)
- SQLAlchemy 2.0 ORM Inheritance -- docs.sqlalchemy.org/en/20/orm/inheritance.html -- STI vs joined vs concrete tradeoffs
- Alembic 1.18.4 -- pypi.org/project/alembic/ + alembic.sqlalchemy.org -- version compatibility, SQLite batch mode
- Python typing.Protocol -- docs.python.org/3/library/abc.html -- plugin registry pattern
- USP <85> Bacterial Endotoxins Test -- LAL workflow, PPC 50-200%, r >= 0.980 requirement
- USP <71> Sterility Tests -- 14-day incubation, pass/fail, membrane filtration vs direct inoculation
- Direct codebase inspection -- backend/models.py (662 lines), backend/main.py (11,785 lines), backend/database.py, backend/calculations/engine.py, backend/mk1_db.py

### Secondary (MEDIUM confidence)
- Charles River EndoScan-V documentation -- CSV/XML export confirmed to exist; exact column names unverified
- Frederick Cancer Research -- Endotoxin Determination by Kinetic Chromogenic Testing
- Nelson Labs -- PPC, Inhibition and Enhancement guidance
- LAL Assay Validation -- PMC 8408548 -- validated regression procedure
- SENAITE 2.6.0 release notes -- text result fields for analysis services confirmed

### Tertiary (LOW confidence)
- LAL CSV export column names from EndoScan-V/MARS -- inferred from vendor docs; requires actual export files
- SENAITE pass/fail field type for sterility analysis service -- generic text results confirmed; exact config for this lab unverified

---
*Research completed: 2026-04-05*
*Ready for roadmap: yes*