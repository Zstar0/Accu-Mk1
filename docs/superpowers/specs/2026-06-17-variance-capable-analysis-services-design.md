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
`variance_capable` boolean to the Mk1 `AnalysisService`. It becomes the source
of truth for "this analyte is a variance figure" — read by the new COA analyte
series and the assignment-page analyte participation. The peptide `_category()`
series is left intact and a **parallel** analyte-keyed builder is added for the
generic/BW path (additive — no peptide behavior change). The physical vial
*roles* (hplc / endo / ster) are unchanged — they're real preparations.

**Layer note — flag vs. entitlement (corrected 2026-06-17).** The flag lives on
Mk1 *analyte* services (`PH-DETERM`); the variance *count* comes from WP keyed by
*product* strings (`bac_water_panel`). These are different layers, so the flag
cannot literally "replace" `VARIANCE_BUCKET_KEYS`. Entitlement instead becomes
**BW-aware**: the `hplc` bucket reads `hplcpurity_identity` **or**
`bac_water_panel` (mirroring `derive_base_demand:839`). The lab-override MVP needs
no entitlement change at all — the existing HPLC override already sets the `hplc`
bucket for any matrix. Fuller flag-driven entitlement (deriving buckets from
service metadata) is a larger refactor; the WP-key-based-vs-flag-driven choice is
**deferred to the Phase 4 user decision**, not settled here.

| Dimension | Decision |
|---|---|
| **Flag granularity** | Per individual `AnalysisService` (not service groups). |
| **Flag management** | Lab-managed toggle in Mk1 (Analysis Services admin), no deploy needed. |
| **Replicate count source** | WP purchase (per-sample) + lab override. Flag supplies *which* analytes; count supplies *how many*. |
| **BW conformance verdict** | **pH and Benzyl Alcohol: all replicates within `[spec_min, spec_max]`** — every measurement must pass; one out-of-range replicate fails the lot. (Diverges from the peptide mean rule by design — physical attributes are "every unit passes" QC.) Fill Volume (`FILL-NET-CONTENT`) has **no baked spec** and renders informational (stat line, no pass/fail) unless/until a per-sample spec source is added. |
| **BW identity gate** | None — BW has no identity analyte; all replicates count. |
| **Scope** | BW pH / Benzyl Alcohol / Fill Volume. pH and Benzyl Alcohol carry baked specs and receive the all-in-range verdict; Fill Volume is informational (no baked spec). Architecture is analyte-agnostic; other matrices follow by flagging their services. |
| **Sequencing** | Folded into the Accumark 1.0 launch (deploy gated on this). |

## Architecture

Three layers change; one (vial assignment/seeding) does not.

### Layer 1 — Data model & admin (Accu-Mk1)

- **Column.** `AnalysisService.variance_capable BOOLEAN NOT NULL DEFAULT FALSE`,
  added via an idempotent hand-rolled ALTER (matches Mk1's migration style).
- **Mk1-owned override.** Like `peptide_id` and `result_type`, this is a Mk1
  field that the SENAITE sync must **preserve on re-sync** — never reset to
  default. The sync upsert's preserved-column set gains `variance_capable`.
- **Backfill (migration).** Seed `variance_capable = true` on the three BW
  analytes only — `PH-DETERM`, `Benzyl_Alcohol_Assay`, `FILL-NET-CONTENT` (group
  Analytics, ids 92–94 in the local catalog) — so BW works out of the box; the
  lab adjusts via the toggle afterward. **No HPLC backfill needed:** the peptide
  path runs through `build_variance_replicates` + `ConformanceEngine`, neither of
  which reads `variance_capable`, so peptide variance is untouched regardless of
  the flag. (The only consumer of the flag in this build is the new BW analyte
  series, and BW samples never dispatch to the peptide engine.)
- **Admin toggle.** A "Variance Capable" switch in the `ServicePanel` slide-out
  of `AnalysisServicesPage.tsx`, persisted through a small endpoint mirroring the
  existing `updateAnalysisServiceResultType` pattern. The services table gains a
  column/badge so the flagged set is scannable.

### Layer 2 — Flow rewiring (Accu-Mk1, substitution not new machinery)

- **Entitlement (Phase 4 / WP-purchase slice only).** `derive_variance_demand`
  becomes BW-aware: the `hplc` bucket reads `hplcpurity_identity` **or**
  `bac_water_panel`, mirroring `derive_base_demand:839`. The lab-override MVP
  (Phases 1–3) needs *no* entitlement change — the existing HPLC override already
  drives the `hplc` bucket for any matrix, BW included. BW rides the existing
  `hplc` (chromatography) bucket.
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
- **WP verify page — no code change (verified 2026-06-17).** `vr_value_conforms()`
  in `variance-charts.php` already checks `spec_min` and `spec_max` independently;
  `vr_range_strip()` draws a two-sided band with both ticks; `vr_derive_claim()`
  uses the midpoint when both bounds are set. BW analytes emit the same
  `variance_report` shape, so two-sided ranges and per-replicate dot coloring are
  already native. WP work is verification only (plus the optional Phase 4 product).

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
- **WP:** no new render code — confirm (manually / existing fixtures) the
  verify page draws the two-sided band + dots for a BW `variance_report`.
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
| COABuilder | `scripts/server.py`, `src/coabuilder_core/senaite_client.py` | `variance_analytes` request field + dispatch |
| accumarklabs | WP verify page | no change — verify only (two-sided already native) |
| ~~integration-service~~ | — | **no change** (COA path is direct Mk1→COABuilder) |
