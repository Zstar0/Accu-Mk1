# HPLC native-born — slice 8: `legacy_hplc` COA archetype (page-1 routing is explicit), identity result as a select — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (Handler 2026-09-15) The Analysis Profile "COA Section" field gains a **Legacy (HPLC page 1)** option, and THAT is what decides how COABuilder renders a native profile's results: `legacy_hplc` → the current HPLC page-1 design (via Mk1's shim vocabulary); `limit_table` → a page-2 limit-table section; NULL → not reported. Today the HPLC profile is seeded NULL and the shim admits native HPLC rows by keyword alone, so the archetype is not the switch. Second fix from the same UAT: manual identity entry on `HPLC-IDENTITY` is free text (the Handler's P-5007 stored the peptide NAME while Mk1's spec is `equals "Conforms"`), so the identity service becomes a `select` with `Conforms` / `Does Not Conform`, like PCR.

**Architecture:** One new archetype value `legacy_hplc` in Mk1 only (`main.py:~2964 COA_ARCHETYPES`, the seed, the FE dropdown). COABuilder is untouched: `legacy_hplc` profiles never appear in `native_sections` (its `KNOWN_ARCHETYPES` stays `{limit_table}`); their rows ride `legacy_rows` exactly as today. The gate moves from "keyword ∈ TRIO" to "keyword ∈ TRIO AND the row's owning profile on THIS sample has archetype `legacy_hplc`", where the owning profile comes from the sample's ordered profiles (`native_sections._ordered_native_profiles(db, services, package, require_archetype=False)` + member services) — the same source `sample_meta` uses. `native_sections` treats `legacy_hplc` like NULL (skipped). Consequence: flipping the HPLC profile to `limit_table` routes the trio to a page-2 section built by the existing generic builder (identity `equals` string rule = the PCR precedent; purity `range`; quantity `informational`) and removes it from page 1; NULL removes it from both (COA generation then fails loudly at COABuilder's empty-results validation — acceptable, documented). Existing profiles: a guarded boot upgrade sets `hplc-purity-identity` from NULL → `legacy_hplc` once (additive; never touches a non-NULL value), and `HPLC-IDENTITY` from `result_type='string'` with no options → `select` + options once.

**Tech Stack:** FastAPI/SQLAlchemy 2 backend, TS/React frontend (npm), pytest on the shared dev Postgres (gate = failure-set diff), venv python `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\backend\.venv\Scripts\python.exe`.

**Spec:** `docs/superpowers/specs/2026-09-10-hplc-native-born-design.md` (M2 catalog seed, M7 shim) + Handler direction 2026-09-15 (this plan is the addendum). Evidence: devbox UAT P-5007 / COA JQKS-UZC4.

**Branch / worktree:** `feat/hplc-native-slice8` off `feat/hplc-native-slice7` (4be84bfe) at `C:\tmp\Accu-Mk1-hplc-slice8`.

## Global Constraints
- Additive only. SENAITE-born samples byte-identical (their rows are `service_origin == "senaite"` and never pass the native gate). COABuilder untouched; `legacy_hplc` must never reach a `native_sections` section (coab aborts on unknown archetypes).
- The boot upgrades are guarded single-shot data migrations in the existing seed module (idempotent; only act on the exact seeded state: archetype NULL / result_type `string` with NULL options); log via `catalog/change_log` like the seed does.
- Key/archetype literals live in ONE place each (`COA_ARCHETYPES`; a `LEGACY_HPLC_ARCHETYPE = "legacy_hplc"` constant in `coa/hplc_shim.py` imported by the seed, legacy_rows, native_sections, and the route).
- Identity-convergence guard (`tests/test_identity_convergence_guard.py`) never loosened; new keyword sites as inline tuples.
- Pathspec commits; trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; never `git stash`; keep each file's line-ending convention.
- Parallel dispatch: T1 (`main.py` route constant + `catalog/hplc_native_seed.py` + its test), T2 (`coa/hplc_shim.py`, `coa/legacy_rows.py`, `coa/native_sections.py`, `coa/sample_meta.py` if needed + tests), T3 (`src/**`) are file-disjoint. T2 defines the constant in `hplc_shim.py`; T1 imports it by the name above (if T1 lands first it may define it and T2 keeps it).

## File structure
| File | Responsibility |
|---|---|
| `backend/coa/hplc_shim.py` | `LEGACY_HPLC_ARCHETYPE`, `native_hplc_profile_archetype(db, parent, row) -> str | None` (owning profile's archetype for a native HPLC row on this sample; None when no ordered profile owns the service) |
| `backend/coa/legacy_rows.py` | native HPLC rows admitted only when archetype == `legacy_hplc` (in `build_legacy_rows` and the `_pin_row_identity`/blend paths that call `is_native_hplc_row`) |
| `backend/coa/native_sections.py` | skip `legacy_hplc` profiles on the COA path (like NULL); placeholder path unchanged |
| `backend/coa/sample_meta.py` | `_analyte_slots` native branch keyed the same way (identity titles only when the profile is `legacy_hplc`; otherwise the legacy SENAITE-form titles are irrelevant — read it and keep behaviour when `legacy_hplc`) |
| `backend/main.py:~2964` | `COA_ARCHETYPES = {"limit_table", LEGACY_HPLC_ARCHETYPE}`; error text lists both |
| `backend/catalog/hplc_native_seed.py` | seed profile with `coa_archetype=LEGACY_HPLC_ARCHETYPE`; `HPLC-IDENTITY` as `select` with `result_options=[{"value":"Conforms","label":"Conforms"},{"value":"Does Not Conform","label":"Does Not Conform"}]`; `upgrade_hplc_native_catalog(db)` guarded one-shot for both, called right after the seed in `database.py` (read how the seed is invoked ~165-172) |
| `src/components/hplc/AnalysisProfilesPage.tsx:~1054` | `<SelectItem value="legacy_hplc">Legacy (HPLC page 1)</SelectItem>` + the help text below explains the three values |
| `src/components/hplc/NewTestOnboardingGuide.tsx:~921` | mention the new value |
| Tests | `backend/tests/test_hplc_native_catalog_upgrade.py` (new), extend `backend/tests/test_hplc_native_coa_parity.py` / `test_legacy_rows*.py` / `test_native_sections*.py`, FE vitest for the dropdown values |

### Task 1: Catalog — archetype constant/route, seed, guarded upgrades, identity select
**Files:** `backend/main.py` (COA_ARCHETYPES only), `backend/catalog/hplc_native_seed.py`, `backend/database.py` (one call), `backend/tests/test_hplc_native_catalog_upgrade.py` (new; may extend `tests/test_hplc_native_catalog_seed.py` if it exists).
- [ ] Tests: fresh seed → profile `hplc-purity-identity` has `coa_archetype == "legacy_hplc"` and service `HPLC-IDENTITY` has `result_type == "select"` with the two options; upgrade on a DB where the profile is NULL and the service is `string`/no options → both set, change_log rows written, second run is a no-op; upgrade never touches a profile whose archetype is already `limit_table` or a service that already has options; `PATCH /analysis-profiles/{id}` accepts `legacy_hplc` and still rejects `bogus` (error text lists both allowed values); the identity-convergence guard stays at its known single failure.
- [ ] Implement; scoped run; commit — `feat(catalog): legacy_hplc COA archetype; HPLC-IDENTITY is a Conforms/Does Not Conform select; guarded upgrades for the seeded rows`.

### Task 2: COA routing by archetype
**Files:** `backend/coa/hplc_shim.py`, `backend/coa/legacy_rows.py`, `backend/coa/native_sections.py`, `backend/coa/sample_meta.py` (only if its native branch needs the same gate), tests.
- [ ] Tests (build parents with `tests/hplc_native_family.py::native_family`; set the profile archetype per test): (a) `legacy_hplc` → `build_legacy_rows` emits the shim rows exactly as today (existing parity tests keep passing unchanged) and `native_sections` has NO section for the HPLC profile; (b) `limit_table` → `build_legacy_rows` emits NO native HPLC rows and `native_sections` builds a section for the HPLC profile whose rows carry identity (`equals "Conforms"` string rule, conforms True for `Conforms`), purity (range ≥98) and quantity (informational) — assert the section shape the generic builder produces and that endo/PCR sections are unaffected; (c) NULL → neither path emits the trio (and `sample_meta` still builds; document the resulting coab abort in the report); (d) a SENAITE-born sample is byte-identical under all three (snapshot before/after).
- [ ] Implement `native_hplc_profile_archetype` (owning profile = the sample's ordered profiles whose member services include `row.analysis_service_id`; use `_ordered_native_profiles(..., require_archetype=False)`; if two owners disagree, prefer the one in `services` order and log once); wire the gate; commit — `feat(coa): native HPLC rows route by the profile's COA archetype — legacy_hplc = page 1 via the shim, limit_table = page-2 section, NULL = not reported`.

### Task 3: Frontend
**Files:** `src/components/hplc/AnalysisProfilesPage.tsx`, `src/components/hplc/NewTestOnboardingGuide.tsx`, a vitest (grep how other dropdown option lists are tested; if none, test a small exported `COA_ARCHETYPE_OPTIONS` constant you introduce and render from).
- [ ] Add the option and copy: `Legacy (HPLC page 1)` — help text: "Legacy: results render in the certificate's page-1 HPLC design. Limit table: results render as a page-2 section. Not reported: internal only." Keep `limit_table` label. `npx tsc --noEmit`, eslint on touched files (zero new), vitest. Commit — `feat(ui): COA Section gains Legacy (HPLC page 1)`.

### Task 4: Gate + PR (stacked)
- [ ] Backend full suite base (slice 7 @4be84bfe) vs branch back-to-back, failure-set diff; FE tsc/eslint/vitest failure-set diff. Push; `gh pr create --base feat/hplc-native-slice7` (no merge). Then mount on devbox `priority` (worktree `~/worktrees/mk1-hplc1`, restart backend+frontend) and confirm profile 6 shows `Legacy (HPLC page 1)` and P-5007's identity row offers the select.

## Self-review
Handler ask → T1 (option + seed) + T2 (archetype is the switch) + T3 (dropdown). Identity select → T1. Names consistent: `LEGACY_HPLC_ARCHETYPE`, `native_hplc_profile_archetype`, `upgrade_hplc_native_catalog`. COABuilder untouched by construction (T2 test (a) asserts no section for `legacy_hplc`).
