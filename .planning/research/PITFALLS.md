# Domain Pitfalls: Multi-Instrument Automation Architecture

**Domain:** Generalizing a single-instrument lab automation system (HPLC) to support multiple instrument types
**Researched:** 2026-04-05
**Confidence:** HIGH — based on direct inspection of AccuMark codebase + established patterns for polymorphic data modeling
**Context:** Accu-Mk1 v0.30.0 — Adding endotoxin (LAL) and sterility to an HPLC-only pipeline; generalizing method/result models; refactoring 11,785-line main.py

---

## Critical Pitfalls

### Pitfall 1: The JSON Blob Trap on `Result.output_data`

**What goes wrong:**
`Result.output_data` is already a JSON column. The temptation is to just dump each instrument's results into it — endotoxin stores `{"eu_per_ml": 0.45}`, sterility stores `{"pass_fail": "Pass", "observations": "No growth"}`, HPLC stores `{"purity_percent": 98.2, ...}`. This works for display but makes analytics impossible without scanning every row and parsing JSON. Any query like "all endotoxin results above the limit for peptide X last 30 days" becomes a full table scan with Python-side filtering.

**Why it happens:**
It is the path of least resistance. The `Result` model already exists, it already accepts JSON, and each new instrument just slots in. It feels like generalization but is actually per-instrument data hidden inside an opaque blob.

**How to avoid:**
Design typed result tables: `InstrumentResult` as the envelope (instrument_type, sample_id, method_id, status, created_at) plus per-type extension tables: `HplcResultDetail` (purity_percent, quantity_mg, identity_conforms, ...), `EndotoxinResultDetail` (eu_per_ml, kinetic_curve JSON, test_method), `SterilityResultDetail` (pass_fail, observation_text, incubation_days). The JSON column is acceptable for structured-but-non-queryable data (chromatogram arrays, kinetic curves, raw debug logs) — not for scalar values you will ever filter or aggregate.

**Warning signs:**
- You find yourself writing `WHERE output_data->>'eu_per_ml' > '0.5'` in any query
- Analytics requirements surface after the schema is locked
- Cross-instrument comparison requires loading all rows into Python

**Phase to address:** Schema design phase — before writing any endotoxin or sterility code. Retrofitting this after data exists requires a migration for every existing row.

---

### Pitfall 2: Treating `HplcMethod` as the Base Class Instead of Replacing It

**What goes wrong:**
`HplcMethod` has columns `size_peptide`, `starting_organic_pct`, `dissolution`, `temperature_mct_c` — HPLC-specific concepts. If you create `EndotoxinMethod` and `SterilityMethod` as separate tables with no shared parent, you now have three disconnected method tables, three sets of admin UI, three places to sync from SENAITE, and no way to answer "what methods does instrument X support" with a single query. If you instead bolt LAL-specific columns onto `HplcMethod` as nullable fields (dissolution = null for LAL, eu_threshold nullable), you get a god table where most columns are irrelevant for each row.

**Why it happens:**
Neither extreme feels obviously wrong until you hit the third instrument type. Under-generalizing (three silos) mirrors the existing HPLC-only code, so it seems safe. Over-generalizing (one table, all nullable) avoids new tables but produces an unmaintainable schema.

**How to avoid:**
Use a concrete table inheritance pattern: one `methods` table with shared columns (name, senaite_id, instrument_type, active, notes, created_at, updated_at), plus per-type detail tables `hplc_method_params` (size_peptide, starting_organic_pct, dissolution, temperature_mct_c) and `endotoxin_method_params` (test_method, incubation_temp_c, eu_threshold). The `methods` table is the single source for "list all methods", "assign method to instrument", and SENAITE sync. The detail tables are loaded only when the type is known. The existing `HplcMethod` rows migrate to `methods` + `hplc_method_params` with a single INSERT/SELECT migration.

**Warning signs:**
- Method admin UI requires an if/else branch per instrument type with unrelated fields
- `SENAITE sync_methods` endpoint has to check `instrument_type` to decide which table to write
- Adding a fourth instrument requires touching the `methods` table schema itself

**Phase to address:** Schema design phase. Also requires updating `instrument_methods` junction table (currently hardcoded to `hplc_methods.id`) to reference the new `methods.id`.

---

### Pitfall 3: The 11,785-Line `main.py` Getting Worse During Generalization

**What goes wrong:**
`main.py` is already 11,785 lines. Adding an endotoxin router, sterility router, and generic ingest router inline will push it past 15,000 lines. At that point, merge conflicts are constant, `grep` is the only navigation, and circular imports become likely when helper functions reference models that reference router-level code. The monolith doesn't break — it just becomes increasingly dangerous to touch.

**Why it happens:**
Each feature added to `main.py` was "just a router" and seemed contained. The generalization work is the right moment to split because you are already restructuring — but only if you do it first, before writing new instrument code.

**How to avoid:**
Router extraction before adding instrument types. The natural split is already visible in the function list:
- `routers/hplc.py` — `/hplc/*` endpoints (analyze, parse, calibration, etc.)
- `routers/ingest.py` — generic job/sample/calculate endpoints
- `routers/senaite.py` — all `/wizard/senaite/*` and SENAITE sync endpoints
- `routers/worksheets.py` — worksheet and inbox endpoints
- `routers/admin.py` — users, settings, service groups, instruments, methods
- `routers/endotoxin.py` — new instrument type
- `routers/sterility.py` — new instrument type

Each router is an `APIRouter` included into `app` in `main.py`. This is a mechanical refactor (move function, fix imports) with near-zero logic change. It should be Phase 1 of the milestone, not deferred.

**Warning signs:**
- New instrument feature PR touches `main.py` for 500+ lines
- You cannot find where a 404 is coming from without searching the full file
- Two developers editing `main.py` in parallel always produces conflicts

**Phase to address:** Phase 1 — monolith split. Do this before any new instrument code exists.

---

### Pitfall 4: Breaking Existing HPLC Automation During Generalization

**What goes wrong:**
HPLC automation works. The calibration pipeline, standard prep wizard, chromatogram overlays, and identity check all function correctly. During refactor, a renamed model, a changed FK, or a missed import silently breaks HPLC while the new instrument work tests green because there are no automated regression tests for HPLC analysis paths.

**Why it happens:**
The refactor targets `HplcMethod → Method + HplcMethodParams`, `HPLCAnalysis → InstrumentResult + HplcResultDetail`, and `main.py → routers/`. Each of these touches live HPLC code paths. Without test coverage, regressions are discovered by operators in production.

**How to avoid:**
Two safeguards before touching HPLC models:
1. Write integration tests for the critical HPLC happy path: parse CSV → run analysis → store HPLCAnalysis → assert purity_percent. These tests run against the existing schema and serve as the regression gate.
2. Preserve `HPLCAnalysis` as a read model (leave the table, keep existing rows) rather than migrating it away. New analyses go through `InstrumentResult + HplcResultDetail`. Old analyses remain queryable from `hplc_analyses`. The migration is additive, not destructive.

Also: keep `hplc_processor.py` and `peakdata_csv_parser.py` completely unchanged during schema refactor. The calculation logic is not the problem — only the storage layer changes.

**Warning signs:**
- You modify `HPLCAnalysis` model before writing tests
- SENAITE push path for HPLC results changes during refactor
- The calibration curve FK chain gets touched before verifying tests pass

**Phase to address:** Phase 1 (tests) and Phase 2 (schema). Tests gate the schema changes.

---

### Pitfall 5: Two Databases Creating Silent Cross-Database FK Violations

**What goes wrong:**
`HPLCAnalysis.sample_prep_id` is an INTEGER with a comment "no FK possible — sample_preps lives in a separate database." The two-database architecture (PostgreSQL for sample_preps via `mk1_db.py`, PostgreSQL for everything else via `database.py`/`models.py`) means cross-database referential integrity is impossible at the DB layer. When the generalized `InstrumentResult` model replaces `HPLCAnalysis`, this pseudo-FK must be carried forward. If it is missed or removed during refactor, the link from instrument results to sample preps silently breaks.

The deeper risk: new instrument types (endotoxin, sterility) that also have sample preps will need the same pattern. Without explicit documentation, developers will either forget the cross-DB reference or try to enforce a FK and get a runtime error.

**Why it happens:**
The two-database boundary is not visible in the schema — it is documented only in a comment on one column and in `mk1_db.py`. New developers, or the original developer six months later, will not remember this constraint.

**How to avoid:**
Document the boundary explicitly in code. Add a module-level comment to `models.py` listing all pseudo-FK columns and why they exist. Add an application-level integrity check: on startup, for every `InstrumentResult` with a `sample_prep_id`, verify the corresponding row exists in `sample_preps` (or accept that orphaned sample_prep_id is allowed on deletion). Name the pattern: call it `cross_db_ref` in comments consistently.

When adding `EndotoxinResult` or `SterilityResult`, decide at schema-design time whether these instrument types ever link to a sample prep, and if so, add `sample_prep_id` explicitly with the same comment pattern.

**Warning signs:**
- `sample_prep_id` column disappears during model refactor
- New instrument result model has no `sample_prep_id` column when the prep workflow applies
- Developers try to add a SQLAlchemy FK to `sample_preps` and wonder why it fails

**Phase to address:** Schema design phase — document the pattern before writing new models.

---

### Pitfall 6: Over-Generalizing the Parser/Calculator Registry Too Early

**What goes wrong:**
The goal is a "plugin registry" for parsers and calculators. The temptation is to design a maximally abstract interface upfront: a `BaseInstrumentPlugin` ABC with `parse()`, `calculate()`, `validate()`, `get_schema()`, `get_senaite_fields()` methods that every instrument type must implement. Endotoxin works fine. Sterility works fine. Then LCMS arrives and needs two parsers (file format A and file format B), multiple calculation steps, and a result that is a list of identified compounds rather than a single scalar. The ABC breaks down, you add `Optional` methods everywhere, and the registry becomes harder to extend than just writing a new router.

**Why it happens:**
Abstractions are designed for the known cases (HPLC, LAL, sterility) and the interface reflects those three. The fourth case invalidates the assumption.

**How to avoid:**
Start with a minimal registry, not a maximal ABC. The registry maps `instrument_type: str → {parser: Callable, calculator: Callable}`. Parsers and calculators are standalone functions (or simple classes) with typed signatures, not implementations of an abstract interface. Composition over inheritance. The registry is explicit — not dynamic discovery — because this is not an open-source plugin ecosystem and you control all the implementations.

For v0.30.0, the registry is: `{"hplc": hplc_parser + hplc_processor, "endotoxin": lal_parser + lal_calculator, "sterility": manual_entry + sterility_calculator}`. That is the entire scope. Do not design for LCMS until LCMS requirements exist.

**Warning signs:**
- The `BaseInstrumentPlugin` interface has more than 4-5 required methods
- You write `NotImplementedError` stubs for LCMS/GCMS before those instruments are scoped
- Adding endotoxin requires inheriting from a class and satisfying 8 abstract methods

**Phase to address:** Plugin system design phase — keep interface minimal and grow it at each new instrument.

---

### Pitfall 7: SENAITE Field Mapping Not Designed per Instrument Type

**What goes wrong:**
SENAITE analysis services have a `Result` field (string). For HPLC, this is purity_percent. For endotoxin, it is eu_per_ml. For sterility, it is "Pass" or "Fail". The current SENAITE push path (`set_analysis_result`) sends `{"Result": value}` to SENAITE. This will continue to work for endotoxin (send the numeric string) and sterility (send "Pass"/"Fail"), but the field mapping logic needs to know: for this instrument type and this analysis service keyword, which result field maps to `Result`?

The failure mode is pushing the wrong result. Sterility result pushed as `{"Result": "0.45"}` because the code reused the HPLC path. Or endotoxin EU/mL pushed for a purity analysis service keyword.

**Why it happens:**
The SENAITE push is one endpoint. The caller decides what value to send. As long as the UI sends the right value, it works. But when automation runs without UI intervention (file-watched batch), the server side must know the mapping.

**How to avoid:**
The `InstrumentResult` model (or `EndotoxinResultDetail`) must store a `senaite_result_value` field — the pre-formatted string to push to SENAITE. The ingest pipeline computes this at calculation time. The SENAITE push endpoint reads this field, not a raw numeric. This decouples "what the calculation produced" from "what SENAITE expects to receive."

Also: verify that the SENAITE analysis service `keyword` for endotoxin tests is not the same keyword as HPLC purity for the same peptide. If they are different services on the same SENAITE sample, the push must target the correct analysis UID, not just the sample UID.

**Warning signs:**
- SENAITE push logic for new instruments is copy-pasted from HPLC route
- There is no field that says "the value to push to SENAITE is X"
- You discover the wrong result was pushed because SENAITE shows "0.45" on a sterility test

**Phase to address:** Endotoxin and sterility ingest phases. Verify SENAITE field mapping before wiring up the push.

---

### Pitfall 8: `_run_migrations()` Pattern Not Scaling to Multi-Instrument Schema Changes

**What goes wrong:**
`database.py` has a `_run_migrations()` function containing 30+ raw SQL strings that run on every startup. This pattern works for additive column additions but becomes fragile when:
- A migration needs to create new tables that reference other new tables (ordering matters)
- A migration needs to backfill data that depends on application logic (not just SQL)
- Two developers add migrations simultaneously and get a list ordering conflict
- A failed migration silently passes because the `except: pass` on line 172 swallows errors

The multi-instrument refactor will add several new tables (methods, hplc_method_params, endotoxin_method_params, instrument_results, hplc_result_details, endotoxin_result_details). The current pattern will require 10-15 new migration strings in an already-long list, with silent failure risk.

**Why it happens:**
The `_run_migrations()` pattern was the right call for early-stage column additions when Alembic's overhead was not justified. At 30+ migrations, the risk of silent failures and ordering bugs has grown.

**How to avoid:**
Two options, in order of preference:
1. Introduce Alembic before writing new instrument tables. The migration history becomes versioned, ordered, and testable. The one-time cost is worth it at this scale.
2. If Alembic is deferred, at minimum remove `except: pass` from `_run_migrations()` — log errors and re-raise. Add sequential numbering comments to each migration block. Add table-creation migrations before column-addition migrations for the same table.

Do not add more silent-failure migrations for tables that do not yet exist.

**Warning signs:**
- A migration fails silently and the ORM throws a column-not-found error at runtime
- Two PRs both append to the migrations list and conflict
- A migration backfills data but silently skips rows because of the swallowed exception

**Phase to address:** Pre-schema phase — resolve migration strategy before designing new tables.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Store all instrument results in `Result.output_data` JSON | No schema changes needed | Analytics impossible, queries degrade to full scan | Never — analytics are a stated milestone requirement |
| Add LAL/sterility endpoints to `main.py` | No router refactor required | main.py exceeds 15k lines; conflicts constant | Never — refactor first |
| Keep `HplcMethod` and add separate `EndotoxinMethod`, `SterilityMethod` tables | Isolated, no migration needed | Three disconnected method registries, triple admin UI | Only acceptable if instruments are truly unrelated and will never be queried together |
| Skip Alembic, keep `_run_migrations()` for new tables | No migration tooling setup | Silent failures at scale; ordering bugs; no rollback | Acceptable only for column additions, not new tables |
| Skip HPLC regression tests before schema refactor | Faster start | Undetected regression discovered by operators | Never — HPLC is production-critical |
| Maximize `BaseInstrumentPlugin` ABC | Clean architecture on paper | Interface invalidated by fourth instrument type | Never for v0.30.0 — minimize the interface |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| SENAITE result push | Reuse HPLC push path for all instruments, sending raw calculated value | Store `senaite_result_value` on InstrumentResult at calculation time; push reads this field |
| SENAITE analysis service mapping | Assume one analysis service per sample for all instrument types | Verify endotoxin/sterility services are distinct keywords from HPLC purity on the same SENAITE sample |
| SENAITE method/instrument assignment | Send HPLC method UID when pushing endotoxin results | The `/method-instrument` endpoint must know the result type and look up the correct method UID |
| sample_preps (cross-DB) | Remove `sample_prep_id` from InstrumentResult during refactor | Preserve the cross-DB reference; document it as `cross_db_ref` pattern in comments |
| SENAITE instrument sync | `sync_instruments` only populates `instrument_type = "HPLC"` | Update sync to populate correct instrument_type from SENAITE instrument metadata when adding new types |
| File watcher (folder-based ingest) | Assume file watcher handles all instrument types by default | Endotoxin may produce CSV in a different schema; sterility has no file — design per-instrument ingest path explicitly |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Polymorphic query with `instrument_type` filter on `InstrumentResult` using JSON `output_data` | Analytics query takes >5s for 10k results | Typed result tables with indexed scalar columns | At ~5,000 results when scanning JSON columns |
| Loading all instruments into memory for every HPLC analysis to resolve instrument_id | Latency creeps up as instrument table grows | Cache instrument list (TTL 5 min) or resolve once at startup | Not a concern at lab scale (<100 instruments), but clean to avoid now |
| `_run_migrations()` running 30+ SQL statements on every startup | Cold start latency increases; migration errors swallowed silently | Alembic with versioned migrations | At ~40+ migrations, startup latency becomes noticeable |
| SENAITE sample lookup re-fetching all analyses for every worksheet item | Worksheet load time increases with worksheet size | Batch fetch analyses per sample in one request | At ~50 items per worksheet |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Storing endotoxin kinetic curve raw data (potentially large) in unvalidated JSON blob | Malformed file could inject oversized payload; SQLite DB bloat | Validate file size and array length at parser stage before storing |
| New instrument ingest endpoint without auth | Unauthenticated file upload/manual entry | All new routers must include `Depends(get_current_user)` — confirm this is not accidentally omitted during router extraction |
| Cross-DB reference via `sample_prep_id` allows orphaned result rows if prep is deleted | Result row references non-existent prep; misleads audit trail | Application-level check on result display: verify sample_prep exists before rendering prep link |

---

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Mixed ingest UI (file + manual) using the same form with optional fields | Operator confused about which fields apply to their instrument type | Separate ingest flows gated by instrument type selection; show only relevant fields |
| Sterility pass/fail result shown in same column as HPLC purity % | Meaningless comparison; operators misread results | Instrument-type-aware column configuration in the batch review table |
| Endotoxin EU/mL result displayed without the acceptance limit reference | Operator does not know if 0.45 EU/mL is pass or fail | Display result alongside the method's acceptance threshold |
| "Calculate" button on HPLC batch review appearing for endotoxin results | Operator clicks it, wrong calculation runs | Route calculate button to instrument-type-specific calculation endpoint |

---

## "Looks Done But Isn't" Checklist

- [ ] **Endotoxin ingest:** Parser handles both CSV export formats (some LAL analyzers produce different column names) — verify against actual export files before marking done
- [ ] **HPLC backwards compatibility:** All existing `hplc_analyses` rows still return correctly from the API after schema refactor — run the batch review UI against existing data
- [ ] **Method admin UI:** New method type selector works and only shows relevant fields per type — do not ship with HPLC-only fields visible for endotoxin methods
- [ ] **SENAITE push for new instrument types:** Verify result lands on the correct analysis service UID (not the first service on the sample) — check in SENAITE UI, not just API response
- [ ] **Router extraction:** All existing HPLC endpoints return the same responses after extraction to `routers/hplc.py` — run a request against every HPLC endpoint post-refactor
- [ ] **`sample_prep_id` on InstrumentResult:** Present and populated for endotoxin results that originate from a prep workflow — verify in DB, not just in the response model
- [ ] **Migration safety:** New table migrations are not silently swallowed — temporarily remove `except: pass` in dev to verify migrations succeed before deploying

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| JSON blob for result data — analytics requirement surfaces late | HIGH | Add typed result detail tables; write backfill migration to extract JSON values into columns; existing rows must be backfilled before analytics queries work |
| HPLC regression broken by schema refactor | MEDIUM | Revert `HPLCAnalysis` model changes (keep original table); re-run through new ingest path only for new analyses; keep old table as read-only archive |
| main.py split introduces import cycle | LOW | Move shared helpers (auth, db, models) to a `deps.py` module; import order: deps → models → routers → main |
| Wrong SENAITE result pushed for endotoxin | LOW | SENAITE allows re-setting Result value via the same API; push the corrected value; log the correction in AuditLog |
| `_run_migrations()` silent failure creates schema mismatch | MEDIUM | Check `information_schema.columns` to identify missing columns; run missing migrations manually; add logging to migration runner |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| JSON blob for result data | Schema design (before any new instrument code) | Can write `SELECT eu_per_ml FROM endotoxin_result_details WHERE ...` without JSON operators |
| HplcMethod as-is vs. generalized Method model | Schema design phase | `methods` table exists with `instrument_type` column; `hplc_method_params` is a separate table |
| main.py monolith | Phase 1: router extraction | `main.py` is under 200 lines (app setup + router includes only); all endpoints live in `routers/` |
| HPLC regression during refactor | Phase 1: write HPLC regression tests before touching models | Test suite passes; existing HPLC analyses still return correct purity_percent |
| Cross-DB FK violation | Schema design phase | `InstrumentResult.sample_prep_id` column exists; code comments say `cross_db_ref` |
| Over-abstracted plugin registry | Plugin system design phase | Registry is a dict with 3 entries; no ABC with >4 required methods |
| SENAITE field mapping per instrument | Endotoxin/sterility ingest phases | Endotoxin result pushes to endotoxin analysis service UID, not HPLC purity service UID |
| `_run_migrations()` pattern scaling | Pre-schema phase | Either Alembic is introduced or `except: pass` is removed and migrations are numbered |

---

## Sources

- Direct code inspection: `backend/models.py` (662 lines, 17 model classes), `backend/main.py` (11,785 lines, 180+ endpoints), `backend/database.py` (30+ raw SQL migrations), `backend/calculations/engine.py` (FORMULA_REGISTRY pattern), `backend/mk1_db.py` (cross-DB sample_preps)
- Architecture observation: `Instrument.methods` relationship hardcoded to `HplcMethod` via `instrument_methods` junction
- Architecture observation: `HPLCAnalysis.sample_prep_id` documented as no-FK cross-DB reference
- Architecture observation: `_run_migrations()` swallows all exceptions with bare `except: pass`
- Architecture observation: `Result.output_data` is an untyped JSON column shared across all calculation types

---
*Pitfalls research for: Multi-instrument automation architecture — AccuMark v0.30.0*
*Researched: 2026-04-05*
