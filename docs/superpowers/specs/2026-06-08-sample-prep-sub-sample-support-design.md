# Design: Sample Prep wizard — sub-sample (vial) support

*Created 2026-06-08. Branch `subvial/continue` (PR #9). Additive feature on the Mk1 sub-vial arc.*

## Problem

The HPLC **Sample Prep wizard** and the new **sub-sample (vial)** lifecycle are two parallel worlds that never touch:

- **World A (prep):** SENAITE `WorksheetItem` → "Start Prep" → `SamplePrep` / `WizardSession` (keyed by `senaite_sample_id` string + `peptide_id`) → results land in `hplc_analyses` via `HPLCAnalysis.sample_prep_id`.
- **World B (sub-sample):** `lims_sub_samples` (vials) → `lims_analyses` (`result_value` / `method_id` / `instrument_id` / `review_state`) → `submit` → `verify` → **`promote`** to parent.

`lims_analyses` carries **no** `sample_prep_id` and nothing joins it to `hplc_analyses`. The only bridge between the worlds is `worksheet_analyst.py`'s loose string-match (`WorksheetItem.sample_uid == lims_sub_samples.external_lims_uid`), used solely for analyst attribution.

Consequence: a prep computes an HPLC result in `hplc_analyses`, but the vial's *promotable* result is a different `lims_analyses` row that no prep feeds. To submit a vial today a bench tech must **manually re-type** the prep's result onto the vial's `lims_analyses` row. The prep is parent/peptide-scoped; the promotable result is vial-scoped.

Live grounding (2026-06-08, `accumark_mk1.sample_preps`): every existing prep maps to a **parent-form** id (P-0125, PB-0078, …); zero are vial-form; two parents already have multiple preps (re-preps, not vial-scoped). So the prep model is parent-keyed in practice with no notion of *which vial*.

## Goal

Additive. **Parent-sample preps keep working unchanged**, AND users can create preps for sub-samples, with a vial prep's HPLC result bridging onto that vial's promotable `lims_analyses` row (killing the manual double-entry).

## Decisions (locked with the Handler)

- **Scope:** per-vial prep, bridged to `lims_analyses` (option 1), additive over the existing parent-prep flow.
- **Entry points:** (a) the vial's worksheet-item "Start Prep", and (b) a new sub-sample picker in wizard Step1. **Not** a vial sample-details page action.
- **Result bridge:** **auto write-through on prep completion** — write `result_value` (+ method/instrument) onto the vial's `lims_analyses` row and run the existing `submit` transition automatically. Stops at `to_be_verified`; verify/promote stay the human gate.

## Approach (chosen: A — Direct FK + completion hook)

Tag a vial prep with the vial's `lims_sub_sample_pk` at start; on prep completion a bridge service writes the result onto that vial's `lims_analyses` row and reuses the existing `submit` transition.

- **A (chosen):** uses the exact vial identity we hold at start (lookup, not heuristic); additive (null pk = today's parent prep); reuses the tested state machine.
- **B (rejected):** no schema change, resolve the vial via keyword/identity join at completion — reintroduces the vial-overlay's known fragility when we already have the pk.
- **C (rejected):** reverse pull at the vial's submit step — contradicts the chosen push/auto write-through.

## Design

### 1. Data model (additive)

- `sample_preps.lims_sub_sample_pk INTEGER NULL` — idempotent `ALTER TABLE` (Mk1's hand-rolled migration pattern in `backend/mk1_db.py`). **Null = parent prep, zero behavior change.**
- `wizard_sessions.lims_sub_sample_pk INTEGER NULL` — same, to thread the vial through the wizard from session-create to prep-create.
- FE `SamplePrep` and `WizardSession` types (`src/lib/api.ts`) carry the new field.
- `lims_analyses` **unchanged** — it already has `result_value`, `method_id`, `instrument_id`, `lims_sub_sample_pk`.

### 2. Entry points

- **Vial worksheet "Start Prep"** (`WorksheetDrawer.tsx` `onStartPrep` → `startPrepFromWorksheet` → `Step1SampleInfo` prefill): resolve and carry the vial's `lims_sub_sample_pk` alongside the existing `sampleId`/`peptideId`, stamping it onto the session/prep. Parent worksheet items pass null (unchanged).
- **Wizard Step1 sub-sample picker** (`Step1SampleInfo.tsx`): a new Mk1 lookup that resolves a `P-XXXX-SNN` vial → vial pk + parent. Auto-populate peptide / declared-weight from the **parent's** SENAITE record (the vial inherits the parent compound) while tagging the vial pk. The existing parent-only `lookupSenaiteSample` path is untouched and remains the default for parent preps.

### 3. Result bridge (write-through)

New backend service (e.g. `backend/lims_analyses/prep_bridge.py` or a function in `lims_analyses/service.py`) fired when a **vial-scoped** prep (`lims_sub_sample_pk` not null) reaches result-finalized (the `hplc_complete` transition / the point the HPLC result is attached). It:

1. Resolves the target `lims_analyses` row on that vial by analyte keyword / peptide, using the same identity-naming bridge the vial-assignment overlay uses (`ID_*` parent ↔ generic `HPLC-ID` vial for single-peptide families).
2. Writes `result_value` + `method_id` + `instrument_id` onto the row.
3. Calls the existing `lims_analyses` `transition('submit')` → row moves to `to_be_verified`.

**Guards:**
- Idempotent — re-running on an already-bridged/submitted row is a no-op.
- Skip (with a surfaced warning, never guess) if there is no **unambiguous** matching `lims_analyses` row.
- Skip if the row is already past `submit`.
- Blend prep → match per component; skip ambiguous components.
- Keys on `lims_sub_sample_pk` directly → **no `mk1://` gating** (handoff gotcha: SENAITE-synced sub-samples carry a hex `external_lims_uid`, not `mk1://`).

### 4. Boundaries / non-goals

- Bridge stops at `submit` → `to_be_verified`. **Verify and promote stay the human gate** (consistent with the `promoted`-workflow design). No auto-verify/promote.
- Out of scope (remain in the deferred backlog): parent shadow / SENAITE phase-out, admin un-promote, COA Method/Instrument source question.
- Parent preps (`lims_sub_sample_pk` null): no new behavior, no bridge.

### 5. Testing

- **Backend unit:** bridge writes value + method + instrument and submits; null-pk prep is a no-op; ambiguous match skips with warning; idempotent re-run; blend per-component matching.
- **State machine:** a bridged row reaches `to_be_verified`; existing promote/retest tests (`test_lims_analyses_state_machine.py`, `test_promote_sets_source_promoted.py`, `test_vial_retest.py`) stay green.
- **FE:** Step1 sub-sample picker resolves a vial and tags the pk; worksheet "Start Prep" carries the pk.
- **Live verify** (Handler standing pref — tests/review missed the real bugs last arc): create a vial prep end-to-end → confirm the vial's `lims_analyses` gets the value and reaches `to_be_verified` → promote. Stack: Mk1 FE :5532, API :5530, Postgres `accumark_mk1`; login `forrest@valenceanalytical.com / test123`; sessionStorage overrides `accu_mk1_api_url_override='http://localhost:5530'` + `accu_mk1_wp_url_override='http://localhost:5535'`.

## Key files

| Concern | File |
|---|---|
| Prep table DDL + idempotent migration | `backend/mk1_db.py` |
| WizardSession model | `backend/models.py` (`wizard_sessions`) |
| Wizard session + prep create endpoints | `backend/main.py` (`/wizard/sessions`, prep create ~10105) |
| Prep completion / HPLC result attach | `backend/main.py` (`/hplc/analyses` ~4030, `scan_sample_preps_hplc` ~10302) |
| lims_analyses transitions (`submit`) | `backend/lims_analyses/service.py` (`transition`) |
| lims_analyses state machine | `backend/lims_analyses/state_machine.py` |
| Identity/keyword join helper | `src/lib/vial-assignment.ts` (FE), overlay logic in `SampleDetails.tsx` |
| Wizard Step1 (lookup + picker) | `src/components/hplc/wizard/steps/Step1SampleInfo.tsx` |
| Worksheet Start Prep | `src/components/hplc/WorksheetDrawer.tsx`, `src/store/ui-store.ts` |
| FE types | `src/lib/api.ts` (`SamplePrep`, `WizardSession`, `createWizardSession`) |

---

## Addendum 2026-06-11 — vial-only cutover

The additive phase above kept parent preps as the default. Cutover decisions:

1. **Step1 lookup is vial-only.** A parent-form id no longer creates a parent
   prep: the lookup lists that parent's vials (role + variance badges) and the
   tech picks one — each click re-runs the lookup as that vial. A parent with
   no vials gets a clear "check the sample in first" error. The manual-entry
   tab (standards / ad-hoc) is untouched. Worksheet "Start Prep" on parent
   items prefills the parent id and now lands in the picker.
2. **Vial preps get a Mk1 final step.** `SamplePrepHplcFlyout` renders the new
   `VialResultsView` when `prep.lims_sub_sample_pk != null` (parent/legacy
   preps keep `SenaiteResultsView` unchanged). It has no sample-ID input — the
   write target is the prep's vial. Shows the bridge outcome, hosts the same
   `AnalysisTable` the vial details page uses (manual entry + transitions),
   and an **Auto-fill** button backed by `POST /hplc/sample-preps/{id}/bridge`
   (`prep_bridge.rebridge_prep`) — re-runs the idempotent bridge over every
   HPLC analysis on the prep (404 unknown prep, 409 parent-scoped/no analyses).
3. **Chromatogram CSV still uploads to the PARENT AR** (COA reads it there),
   fired best-effort alongside Auto-fill.
