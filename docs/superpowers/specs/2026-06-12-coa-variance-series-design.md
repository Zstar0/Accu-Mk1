# COA Variance Results Series — Design (Spec 2 of 2)

*2026-06-12. Builds on Spec 1 (`2026-06-12-coa-identity-gated-na-design.md`),
which establishes the per-figure identity→N/A primitive this spec applies to each
vial figure.*

## Problem

A variance order buys extra physical replicates of an analyte. Today the COA shows
a single value per cell (the parent's canonical result); the replicate values —
which live only in Mk1, on each variance vial's `lims_analyses` rows — never reach
the COA. The lab wants every replicate shown, comma-delimited, in a stable order:
**parent figure first, then variance vials by vial number**. E.g. a purity row for
an analyte with two variance add-ons:

```
98.25%, 99.1%, 97.21%
```

## Decisions (Handler-approved)

> **Revised 2026-06-12 (post-build):** two changes from review —
> (a) the identity row shows a **roll-up summary** (`Conforms 3/3` / `Mixed 2/3` /
> `Does Not Conform 0/3`), green when all conform and slate (`#444F5B`) otherwise,
> reusing the existing conformance colors — not a per-vial name list;
> (b) the variance series is **PDF-only**. Each variance row carries a `digital`
> single-value override (parent figure + parent status/conforms) that
> `_build_coa_data_json` renders, so the digital/verify COA is unchanged. The
> blend overall-identity composite reads the `digital` view to stay correct.

1. **Rows:** purity, quantity, **and identity** get the series. (Identity was
   re-added: the lab needs to see a per-vial identity mismatch — now as a roll-up.)
2. **Vial set:** the parent figure, then each `assignment_kind='variance'`
   sub-sample in `vial_sequence` order. A vial missing that analyte is skipped
   without shifting order.
3. **Parent figure source (style 2):** COABuilder prepends *its own* already-
   computed primary value as the first figure. Mk1 ships only the **raw vial
   replicate values**; COABuilder owns all display logic. This keeps the first
   figure identical to the status badge's source and centralizes conformance.
4. **Status/conformance:** driven by the **parent figure only**. The appended
   vial figures are display-only context; the CONFORMS / variance-% badge is
   unchanged.
5. **Identity display:** per figure, the conforming (alias) peptide name, or
   `Out of Spec` on a non-conforming vial — mirroring today's single identity cell.
6. **Per-figure N/A (from Spec 1):** if a figure's identity is non-conforming,
   that figure's purity and quantity position renders `N/A`. Applies to the parent
   figure (Spec 1) and each vial figure (this spec).

## Architecture

Mk1 already POSTs an `alias_body` to COABuilder's `/process/{sample_id}` (today
carrying `analyte_display_names`). The replicate values ride the same channel as a
new `variance_replicates` key — no SENAITE round-trip, no new endpoints. Variance
vials are native Mk1 (no SENAITE AR), so SENAITE cannot carry them; routing
through Mk1's direct body is the only additive path and matches the SENAITE
phase-out direction.

COABuilder assembles the displayed cell from `[parent figure] + [vial figures]`,
applies per-figure identity gating, and writes the joined string into
`AnalysisResult.result`. Both surfaces (PDF, digital) inherit it via the same
single-source path Spec 1 documents.

## Changes

### Mk1 — `backend/coa/variance_series.py` (new)

```python
def build_variance_replicates(db, parent) -> dict:
    """{ peptide_name: { "PURITY": [v1, v2, ...],
                         "QUANTITY": [...],
                         "IDENTITY": [...] } }

    Raw per-variance-vial result strings, vial_sequence order. Parent NOT
    included — COABuilder prepends its own primary figure (style 2). Only
    assignment_kind='variance' sub-samples; live-state rows only. peptide_name
    is the analysis_service's canonical peptide name; test_type via the existing
    _category() helper (PURITY/QUANTITY/IDENTITY only). A peptide/test with no
    variance figures is omitted entirely.
    """
```

Reads each variance vial's `lims_analyses` rows (states in
`_LIVE_RESULT_STATES` plus `variance_verified`; reportable; `retest_of_id IS NULL`),
buckets by `(peptide_name, test_type)`, orders values by the host vial's
`vial_sequence`. Quantity values keep their unit suffix; purity values keep `%`;
identity values are the raw `result_value` (peptide name or "Out of Spec"-shaped
string). Pure function, sqlite-testable.

### Mk1 — `backend/main.py` (generate-coa, ~L8906 alias_body assembly)

After building `alias_map`, call `build_variance_replicates(db, parent_lims_row)`
and, if non-empty, add `alias_body["variance_replicates"] = {...}`. Best-effort:
a builder exception logs and falls through (COA still generates without the
series). Parent row is loaded from `LimsSample` by `sample_id`; skip for sub-sample
COAs and when no parent row exists.

### COABuilder — `scripts/server.py` (ProcessSampleRequest, ~L490)

Add field `variance_replicates: Optional[Dict[str, Dict[str, List[str]]]] = None`,
normalize like `analyte_display_names`, thread into
`client.fetch_sample_data(..., variance_replicates=...)` →
`ConformanceEngine.process(..., variance_replicates=...)`.

### COABuilder — `src/coabuilder_core/conformance.py`

For each per-analyte identity/quantity/purity row, after computing the primary
cell (and Spec 1's primary N/A gating), if `variance_replicates[peptide_name]`
has values for this `test_type`:

- **Build the figure list.** Index 0 = the primary figure already computed
  (the cell's `result` before joining, or `"N/A"` if Spec 1 gated it). Indices
  1..N = the raw vial values in order.
- **Per-figure identity gating.** Compute each figure's identity conformance:
  index 0 from the primary `is_match`; each vial from matching its IDENTITY
  replicate against `peptide_name` via the same matching used for the primary
  (factor today's inline matcher into a reusable `_identity_matches(result_str,
  peptide_name) -> bool`). For purity/quantity, a figure whose identity fails →
  that position becomes `"N/A"`.
- **Identity row series.** Each figure: the conforming display name, or
  `"Out of Spec"`.
- **Join** with `", "` and assign to `result`. `status`, `conforms`,
  `status_color`, `delta_pct` remain the parent-driven values (decision 4).

Single-value (no replicates) path is untouched → non-variance COAs byte-identical.

### Surfaces

PDF and digital inherit the joined `result` string automatically (Spec 1's
single-source path). No additional wpstar work beyond Spec 1's N/A badge — a
joined string like `"98.25%, 99.1%, N/A"` renders verbatim in the value cell.

## Testing

Mk1 (`backend/tests/test_variance_series.py`, sqlite):
- variance-only filter (core/xtra vials excluded); `vial_sequence` ordering;
  per-test bucketing; missing-analyte skip; parent excluded; empty → omitted.

COABuilder (`tests/test_variance_series_render.py`, standalone):
- replicates present → purity/quantity cell = `parent, v1, v2` joined; parent
  figure first and equals the single-value result.
- a vial identity fails → that vial's purity/quantity position = `N/A`, others
  intact; identity row shows `name, name, Out of Spec`.
- status/conforms unchanged from the single-value case (parent-driven).
- no replicates → output identical to pre-change (regression).

Cross-surface: regenerate a variance sample; confirm PDF, `coa_data` JSON, and
verify page all show the same joined series + N/A positions.

## Out of scope

- Blend-level total rows (per Spec 1).
- GenericAssayEngine / non-peptide (BW) matrices — no peptide variance vials.
- Recomputing overall conformance across replicates (display-only, decision 4).
- Visually distinguishing parent vs vial figures (plain comma list for now).

## Risks / notes

- Depends on Spec 1 being merged first (per-figure N/A reuse + N/A badge).
- Mk1 must resolve each vial row to the **canonical peptide name** COABuilder
  keys on (real name, not alias) so the `(peptide_name, test_type)` join matches;
  alias rendering is applied separately by COABuilder's display-name overrides.
- If a future sample mixes per-substance (`PUR_X`) and legacy slot
  (`ANALYTE-N-PUR`) keywords on the same analyte, `_category()` already
  normalizes both to PURITY/QUANTITY/IDENTITY, so bucketing is stable.
