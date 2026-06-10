# Substance-Correct Analyte Services — Design

*2026-06-09. Refinement of the HPLC vial analyte mirror (PR #9, `subvial/continue`).*

## Goal

When a blend sub-sample vial is assigned to HPLC, the mirrored purity/quantity rows must reflect the **actual substance** in each analyte slot (e.g. "GHK-Cu — Purity") rather than the generic "Analyte 1 (Purity)". We do this by seeding the **per-substance analysis service** (`PUR_<X>` / `QTY_<X>`) for each analyte, matching how identity already works (`ID_<X>`).

## Background (grounded facts)

- The catalog's per-analyte purity/quantity services today are **generic per-slot**: `ANALYTE-1..4-{PUR,QTY,IDENT}` (`peptide_id` NULL, title "Analyte N (…)"). These are ungrouped.
- Per-substance **identity** services already exist for every analyte peptide: `ID_<X>` with `peptide_id` set and title `"{Name} - Identity (HPLC)"` (e.g. `ID_GHKCU`→GHK-Cu, `ID_TB500BETA4`→TB500). They are in the **Analytics** group. The mirror already seeds these (correct substance).
- Per-substance **purity/quantity** services exist for only 3 entries today: `PUR_BPC157`, `QTY_BPC157` (title `"BPC-157 - Purity"` / `"… - Quantity"`, `peptide_id`=10), and `Benzyl_Alcohol_Assay`. GHK-Cu, TB500, and ~70 other peptides have none.
- The keyword suffix is **not derivable** from the peptide name (`ID_TB500BETA4` ≠ norm("TB500 (Thymosin Beta 4)")). It must be taken from the existing `ID_<X>` service.
- The parent SENAITE AR carries the generic `ANALYTE-{n}-PUR/QTY` keywords and aliases them to the substance via the `Analyte{N}Peptide` reference field. `fetch_parent_analyte_slots(parent_id) -> {n: "{Name} - Identity (HPLC)"}` already exists and is the chosen slot→substance source.
- `lims_analyses` has a `peptide_id` FK. `analysis_services` has a `peptide_id` FK. `ID_<X>`, `PUR_<X>`, `QTY_<X>` for one peptide share the same `peptide_id` and suffix.

## Decisions (locked with the user)

1. **Build out per-substance services for every peptide** (not alias, not hybrid).
2. **Slot→substance source = parent SENAITE `Analyte{N}Peptide`** (reuse `fetch_parent_analyte_slots`).
3. **Skip unmapped slots** — an `ANALYTE-{n}-*` parent keyword whose slot has no peptide is not seeded.
4. **Replace** generic `ANALYTE-N` with per-substance on NEW vials. `ANALYTE-N-*` services stay in the catalog for legacy vials and the bridge fallback.

## Design

### 1. Catalog migration — create `PUR_<X>` / `QTY_<X>` for every identity peptide

Idempotent migration in `backend/database.py` `_run_migrations` (Mk1's established pattern), derived from the existing identity services so the suffix + `peptide_id` are authoritative:

- For each `analysis_services` row with keyword `ID_<X>` (and a non-null `peptide_id`), ensure a `PUR_<X>` and a `QTY_<X>` row exist:
  - `keyword` = `'PUR_' || substring(id_keyword from 4)` (and `'QTY_' || …`).
  - `peptide_id` = the identity service's `peptide_id`.
  - `title` = `"{peptide.name} - Purity"` / `"{peptide.name} - Quantity"` (matches the existing `PUR_BPC157`/`QTY_BPC157` convention).
  - Other NOT NULL columns set to sensible defaults consistent with existing services.
  - Idempotent via the `analysis_services.keyword` uniqueness (`ON CONFLICT (keyword) DO NOTHING`, or `WHERE NOT EXISTS`).
- Add every `PUR_<X>`/`QTY_<X>` to the **Analytics** service group (membership rows, idempotent via `uq_service_group_member` `ON CONFLICT DO NOTHING`), consistent with `ID_<X>`.
- Safe no-op where the services already exist (`PUR_BPC157` etc.) or where there are no identity services (fresh installs).

This reaches production on deploy and is applied to the sandbox via `python -c 'from database import _run_migrations; _run_migrations()'`.

### 2. Mirror — seed per-substance services (`backend/lims_analyses/seeder.py`)

In `mirror_parent_hplc_analyses`, when a parent keyword is `ANALYTE-{n}-PUR` or `ANALYTE-{n}-QTY`:

1. Resolve slot *n* → substance via `fetch_parent_analyte_slots(parent_sample_id)` (fetched once per mirror, lazily — only when an `ANALYTE-*` keyword is present, to preserve test hermeticity and avoid an extra SENAITE call for non-blend vials).
2. If slot *n* has no peptide (title absent) → **skip** (unmapped slot).
3. Resolve the slot title → `peptide_id`: match the slot title to the `ID_<X>` service whose `title` equals it (exact), yielding its `peptide_id`. (Fallback: normalized name match against peptides, reusing the bridge's `_norm` + suffix-strip, if no exact title match.)
4. Look up the per-substance service: `analysis_services` where `peptide_id` = resolved id and `keyword LIKE 'PUR_%'` (or `'QTY_%'`). Seed THAT service onto the vial (set `lims_analyses.peptide_id` on the row too, for downstream consumers and bridge matching).
5. **Safety fallback:** if no per-substance service is found (shouldn't happen post-migration), log a warning and seed the generic `ANALYTE-{n}-*` so the analyte is never silently dropped.

Identity (`ID_<X>`), `BLEND-PUR`, `BLEND-IDENT`, `PEPT-Total`, `HPLC-ID` are mirrored unchanged. Exclude-Microbiology filtering unchanged. Idempotency unchanged (`existing_kw` + partial unique index — now keyed on the per-substance keywords).

Net for PB-0071 (slots GHK-Cu/BPC-157/TB500, `ANALYTE-4` empty): `PUR_GHKCU, QTY_GHKCU, PUR_BPC157, QTY_BPC157, PUR_TB500BETA4, QTY_TB500BETA4, ID_GHKCU, ID_BPC157, ID_TB500BETA4, BLEND-PUR, PEPT-Total` (and `HPLC-ID` if present) — 12 rows, slot-4 generic keywords skipped, no generic `ANALYTE-N` rows.

### 3. Bridge — match per-substance directly (`backend/lims_analyses/prep_bridge.py`)

- `_category`: classify `PUR_<X>` (`keyword LIKE 'PUR_%'`) → purity and `QTY_<X>` (`'QTY_%'`) → quantity, alongside the existing `HPLC-PUR`/`ANALYTE-N-PUR` (purity), `ID_*`/`HPLC-ID` (identity), `QTY_*`/`ANALYTE-N-QTY` (quantity).
- `_pick_target` purity/quantity priority:
  1. **Per-substance (primary):** the candidate row matching the prep's peptide — resolved by `peptide_id` (the prep's `peptide.id` → the `PUR_<X>`/`QTY_<X>` service via `analysis_services.peptide_id`, matched against the candidate row's keyword/`peptide_id`). Direct, no slot resolution. This is the robust join (avoids the non-norm-derivable suffix).
  2. **Legacy `ANALYTE-{slot}-*` (fallback):** existing lazy slot resolution, for vials seeded before this change.
  3. **Legacy generic (`HPLC-PUR`/`QTY_*`) (fallback):** existing single-row path.
- Identity routing unchanged (`ID_<X>` preferred over `HPLC-ID`).
- Slot resolution stays **lazy** — only invoked when a legacy `ANALYTE-*` candidate is present and no per-substance match was found, so per-substance vials and legacy generic vials never call SENAITE unnecessarily.

### 4. Backward compatibility

- Existing vials carrying `ANALYTE-N-*` or generic `HPLC-PUR`/`QTY_*` keep their rows and still bridge via the legacy fallbacks. Only new HPLC assignments get per-substance rows.
- The `ANALYTE-N-*` services remain in the catalog (not deleted).

## Edge cases

- **Empty analyte slot** (parent has `ANALYTE-4-PUR`, no `Analyte4Peptide`): skipped (decision 3).
- **Per-substance service missing post-migration:** safety fallback to generic `ANALYTE-{n}` + warning (§2.5).
- **Slot title not resolvable to a peptide:** treat as unmapped → skip + warning.
- **Non-blend / single-peptide HPLC vial:** parent carries generic `HPLC-PUR`/`HPLC-ID` (not `ANALYTE-N`); mirrored unchanged (no per-substance translation needed). Confirm this path is untouched.

## Testing

- **Migration (live DB):** after `_run_migrations`, every `ID_<X>` peptide has a `PUR_<X>` and `QTY_<X>` (same `peptide_id`, in Analytics); re-run is an idempotent no-op; `PUR_BPC157`/`QTY_BPC157` not duplicated.
- **Mirror (live catalog, monkeypatched SENAITE):** a blend parent's `ANALYTE-{n}-PUR/QTY` seed `PUR_<X>`/`QTY_<X>` for mapped slots; empty slot skipped; no generic `ANALYTE-N` rows; identity/blend/total unchanged; idempotent; isolated to a throwaway vial (no live-DB pollution — per the established pattern).
- **Bridge:** a prep for peptide P routes purity→`PUR_<P>` and quantity→`QTY_<P>` by `peptide_id`, leaving other analytes untouched; legacy `ANALYTE-{slot}-*` and generic `HPLC-PUR` vials still bridge (fallback); hermeticity preserved (no SENAITE call for per-substance or generic-only vials).
- **Live E2E:** re-assign PB-0071-S01 to HPLC → per-substance rows present, slot-4 skipped; run a BPC-157 prep → lands on `PUR_BPC157`/`QTY_BPC157` + `ID_BPC157`, others untouched.

## Out of scope

- Customer-facing COA alias display (`SampleAnalyteAlias`, `display_aliases`) — separate concern.
- Deleting/retiring the generic `ANALYTE-N-*` services.
- Backfilling per-substance rows onto vials assigned before this change.
- The pre-existing identity-bridge suffix-norm fragility for divergent abbreviations (noted in prior review; separate fix).
