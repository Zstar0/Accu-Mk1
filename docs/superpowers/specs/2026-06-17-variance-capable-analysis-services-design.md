# Variance-Capable Analysis Services — Design

*2026-06-17. Generalizes variance testing from the hardcoded peptide-HPLC bucket
model to a data-driven flag on the Analysis Service, so any analyte — starting
with Bacteriostatic Water's pH, Benzyl Alcohol, and Fill Volume — can be tested
in replicate and reported on the COA. Spans Accu-Mk1 (backend + admin UI),
COABuilder (`generic_assay_engine.py`), and the accumarklabs WP verify page.
**Baked into the Accumark 1.0 Platform Release** — the deploy waits on this.*

## Problem

Variance testing was built for the peptide HPLC path. Three things are hardcoded
to that assumption, and each silently drops a non-peptide analyte:

1. **Entitlement** — `sub_samples/service.py:812` `VARIANCE_BUCKET_KEYS` maps the
   three physical buckets to three literal WP service keys
   (`hplcpurity_identity`, `endotoxin`, `sterility_pcr`). A `bac_water_panel`
   variance count is read by nothing → zeroed.
2. **COA series (peptide)** — `coa/variance_series.py:35` `_category()` only
   recognizes purity/quantity/identity keywords; pH/BA/Fill Volume → `None` →
   skipped. The series is also keyed by **peptide name**, which BW analytes lack.
3. **COA render (BW)** — COABuilder's `GenericAssayEngine` handles BW conformance
   (via `baked_specs.lookup_spec`) but has **no variance machinery at all** — no
   replicate series, no stat line, no mean/range verdict.

The vial-assignment and subsample mechanics are already proven; an `hplc`-role
variance vial on a BW sample already seeds pH/BA/Fill Volume via the existing
mirror seeder. The gap is purely *what can vary* (hardcoded) and *how it reports*
(peptide-only).

## Decision summary

**Approach A (flag-driven, physical buckets retained).** Add a single
`variance_capable` boolean to the Mk1 `AnalysisService`. It becomes the one
source of truth for "this analyte can be tested in replicate." The hardcoded
`VARIANCE_BUCKET_KEYS` (entitlement) is replaced by reads of the flag; the
peptide `_category()` series is left intact and a **parallel** analyte-keyed
builder is added for the generic/BW path (additive — no peptide behavior change).
The physical vial *roles* (hplc / endo / ster) are unchanged — they're real
preparations. The peptide path's behavior is preserved by backfilling the flag
`= true` on existing HPLC services.

| Dimension | Decision |
|---|---|
| **Flag granularity** | Per individual `AnalysisService` (not service groups). |
| **Flag management** | Lab-managed toggle in Mk1 (Analysis Services admin), no deploy needed. |
| **Replicate count source** | WP purchase (per-sample) + lab override. Flag supplies *which* analytes; count supplies *how many*. |
| **BW conformance verdict** | **All replicates within `[spec_min, spec_max]`** — every measurement must pass; one out-of-range replicate fails the lot. (Diverges from the peptide mean rule by design — physical attributes are "every unit passes" QC.) |
| **BW identity gate** | None — BW has no identity analyte; all replicates count. |
| **Scope** | BW pH / Benzyl Alcohol / Fill Volume. Architecture is analyte-agnostic; other matrices follow by flagging their services. |
| **Sequencing** | Folded into the Accumark 1.0 launch (deploy gated on this). |

## Architecture

Three layers change; one (vial assignment/seeding) does not.

### Layer 1 — Data model & admin (Accu-Mk1)

- **Column.** `AnalysisService.variance_capable BOOLEAN NOT NULL DEFAULT FALSE`,
  added via an idempotent hand-rolled ALTER (matches Mk1's migration style).
- **Mk1-owned override.** Like `peptide_id` and `result_type`, this is a Mk1
  field that the SENAITE sync must **preserve on re-sync** — never reset to
  default. The sync upsert's preserved-column set gains `variance_capable`.
- **Backfill (migration, REQUIRED for safety).** Set `variance_capable = true`
  on the existing HPLC purity/quantity/identity services so peptide variance
  keeps working the instant Layer 2 switches from hardcoded keys to the flag.
  Also seed `true` on pH / Benzyl Alcohol / Fill Volume so BW works out of the
  box; the lab can adjust either set via the toggle afterward.
- **Admin toggle.** A "Variance Capable" switch in the `ServicePanel` slide-out
  of `AnalysisServicesPage.tsx`, persisted through a small endpoint mirroring the
  existing `updateAnalysisServiceResultType` pattern. The services table gains a
  column/badge so the flagged set is scannable.

### Layer 2 — Flow rewiring (Accu-Mk1, substitution not new machinery)

- **Entitlement.** `derive_variance_demand` (and the bucket gating around it) no
  longer matches three literal keys. A bucket's variance is in play iff that
  bucket contains at least one `variance_capable` service for the sample. The
  WP per-sample count + lab override still supply the number; the flag supplies
  the membership. BW rides the existing `hplc` (chromatography) bucket.
- **Assignment page.** `AssignStep` / `VarianceOverrideEditor` surface the
  variance drop-zones and the override input for a bucket whenever the bucket has
  flagged services and entitlement/override > 0 — no longer keyed to the literal
  "HPLC / Endo / Sterility" labels. A BW sample's chromatography bucket now
  lights up because pH/BA/Fill Volume are flagged.
- **Seeding — unchanged.** `lims_analyses/seeder.py` already mirrors the parent's
  Analytics set onto `hplc`-role vials, so a BW variance vial already receives
  pH/BA/Fill Volume.

### Layer 3 — COA generalization (Accu-Mk1 + COABuilder + WP)

- **Mk1 — new analyte series.** `build_variance_analyte_series(db, parent)`
  alongside the existing `build_variance_replicates`. Keyed by **analyte**, not
  peptide: `{analyte: {unit, values: [...] }}`, reading variance-vial results for
  `variance_capable` services. No peptide attribution, no purity/quantity/
  identity categories. (`_category()` in the peptide series is left for the
  peptide path; the new builder is the BW-and-beyond path.)
- **COABuilder — teach `GenericAssayEngine` variance.** `process()` accepts the
  analyte series (mirroring how `ConformanceEngine.process` takes
  `variance_replicates`). When an analyte has replicates, the result cell renders
  the same compact stat line `mean · SD · %RSD · n=N`, and a `variance_report_tests`
  entry is emitted for the customer-facing Variance Report page.
- **Shared stat core.** Lift `_variance_stats` / `_stat_line` out of
  `conformance.py` into a shared module so both engines compute statistics
  identically and the lab's "don't round before/after the mean" rule lives in
  one place.
- **WP verify page.** The per-row renderer already consumes `variance_report`
  tests with `spec_min` / `spec_max` / `domain`. BW analytes emit the same shape.
  The one new case to handle: a **two-sided** range (both `spec_min` *and*
  `spec_max` set) — peptide purity only ever sets `spec_min`.

## Conformance — BW (all-replicates-in-range)

Specs come from COABuilder `baked_specs.lookup_spec(matrix, keyword)`, which
already returns `min`/`max` for BW analytes and drives the single-cell BW verdict
today.

- **Display:** the stat cell shows `mean · SD · %RSD · n=N` (information only),
  same as peptide.
- **Verdict:** the analyte **conforms iff every replicate value ∈ [min, max]**.
  A single out-of-range replicate → `DOES NOT CONFORM` (slate `#444F5B`), fails
  the lot, and lands in `nonconformance_reasons`.
- **No identity gate:** BW has no identity analyte, so no replicate is excluded;
  all of them count toward the verdict.
- **Two verdict models on one COA, each labeled:** peptide variance stays
  mean-based (`mean ≥ spec`, lab-approved 2026-06-15); BW variance is
  all-in-range. They never co-occur on the same analyte, so there's no conflict —
  only a per-test wording difference.

The `variance_report_tests` entry for a BW analyte carries the per-replicate
`values`, `spec_min`/`spec_max`, a `domain` for the plot, and the
all-in-range `conforms` verdict, so the WP Variance Report shows the full spread
with each point's in/out status.

## Count source — phasing

Both purchase and override land in this milestone; override is the first
verifiable slice (zero WP dependency):

1. **Lab-override first.** The lab sets the chromatography-bucket variance count
   on the assignment page. This proves the entire flag → assignment → seed →
   COA flow end-to-end without touching WP.
2. **Purchasable BW variance** as the closing slice — a thin add mirroring the
   existing "Variance" shadow WC product + `wc_test_services` entry, carrying a
   variance count that maps to the `hplc` bucket for a BW order.

## Non-goals

- No per-analyte purchase model (count stays per-sample/per-bucket).
- No new physical vial bucket — BW rides the existing chromatography/`hplc` role.
- No change to peptide variance behavior (guarded by the HPLC backfill + existing
  tests).
- No %RSD gating for BW.
- No retroactive variance on already-published samples.

## Testing

- **Regression guard (must stay green):** existing peptide variance suites —
  Mk1 `test_variance_series.py`, `test_variance_demand.py`, `test_variance_set.py`,
  `test_variance_kind_gate.py`, `test_variance_verify.py`; COABuilder
  `test_variance_*` and `test_identity_fail_na.py`. The flag backfill is what
  keeps these passing.
- **New (Mk1):** flag-driven entitlement (BW sample lights the hplc bucket);
  `variance_capable` survives a SENAITE re-sync; admin toggle endpoint;
  `build_variance_analyte_series` shape.
- **New (COABuilder):** `GenericAssayEngine` renders the stat line; all-in-range
  verdict (pass, single-outlier fail, boundary); `variance_report_tests` emission
  for BW; shared stat core parity with the peptide path.
- **New (WP):** verify-page renderer handles a two-sided `spec_min`+`spec_max`
  range.
- **End-to-end:** a BW sample, flag pH/BA/Fill Volume, lab-set a 2-vial variance,
  assign + seed, enter replicate results, generate + publish, confirm the COA and
  WP verify page show the series + correct all-in-range verdict.

## Key files

| Repo | File | Change |
|---|---|---|
| Accu-Mk1 | `backend/models.py` | `variance_capable` column |
| Accu-Mk1 | `backend/database.py` (or migration path) | idempotent ALTER + backfill |
| Accu-Mk1 | `backend/sub_samples/service.py:812` | flag-driven `derive_variance_demand` / bucket gating |
| Accu-Mk1 | analysis-services routes/schemas + sync | toggle endpoint; preserve flag on re-sync |
| Accu-Mk1 | `backend/coa/variance_series.py` | `build_variance_analyte_series` |
| Accu-Mk1 | `src/components/hplc/AnalysisServicesPage.tsx`, `src/lib/api.ts` | toggle UI + client |
| Accu-Mk1 | `src/components/intake/ReceiveWizard/AssignStep.tsx` | label/visibility off the flag, not literals |
| COABuilder | `src/coabuilder_core/generic_assay_engine.py` | variance render + all-in-range verdict |
| COABuilder | `src/coabuilder_core/conformance.py` → shared stat module | lift `_variance_stats`/`_stat_line` |
| accumarklabs | WP verify-page per-row renderer | two-sided range |
