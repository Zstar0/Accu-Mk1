# Customer Variance Report Page — Design

*2026-06-12. A customer-facing page that shows the replicate spread for a
sample's variance-tested analytes. Reuses the COA-publish data rail and the
"row button" pattern established by Lab Remarks; renders the C-then-B concepts
from the Claude Design handoff (`accumark-labs-design-system/templates/variance-report/`).*

## Problem

A variance order buys extra physical replicates of an analyte. Today the values
exist (parent + variance vials, the `variance_replicates` we already build) and
appear comma-delimited on the PDF, but the customer has no proper view of the
*spread* — how tightly the replicates agree, whether all landed in spec. The lab
wants a dedicated, branded **Variance Report** the customer reaches from their
order page.

## Design source

Claude Design bundle, file `templates/variance-report/Variance Report Concepts.html`
(four concepts A–D in `comps.jsx`, chart primitives in `varicharts.jsx`). We
implement a **C-then-B** stack:

- **C — Replicate dashboard cards** (lead): one card per test — a radial
  precision gauge (%RSD), the big mean, a run sparkline, and Min/Max/Range tiles.
  Identity renders as a "N / N match reference" checkmark card.
- **B — Range & conformance plot** (below): per-test horizontal track with the
  in-spec band shaded, every replicate as a dot, the min→max connector, and the
  mean diamond; big mean + %RSD + Δ% on the right.

Chart primitives to port: `stats` (mean/%RSD/min/max/range), `RadialGauge`,
`Sparkline`, `RangeStrip`. These are pure SVG math.

## Decisions (Handler-approved)

1. **Customer tone — adapt the prototype** (it's a QC-internal mock):
   - Status pill reads **"Conforms" / "Does Not Conform"** (COA language), never
     "Investigate."
   - **Coral is reserved for genuinely out-of-spec values only.** A high-but-
     passing %RSD stays calm (teal/green). The `RadialGauge` `good` param is
     driven by *conformance*, not %RSD magnitude — so a passing test's gauge is
     never red. (This overrides the prototype, where Endotoxin's gauge goes coral
     at 20% %RSD despite passing.)
   - Keep `%RSD` (the audience is technical buyers; brand guide uses domain
     abbreviations freely) but add a one-line plain-language explainer on the
     page: "%RSD measures how tightly the replicate results agree — lower is
     tighter."
2. **Replicate labels:** "Result 1 … N" (Result 1 = the primary; Results 2…N =
   the variance vials, in vial order). Not the prototype's lab-injection "R1–R4."
3. **Dedicated page**, not a modal. Reached from a "Variance Report" button on
   the order-page COA row (primary rows only, only when variance data exists).
4. **Push rail** (same as Lab Remarks): a compact `variance_report` block rides
   `coa_data` → IS notify payload → WP order meta. The page renders from order
   meta — no live IS round-trip. Re-publish refreshes it.

## Architecture / data flow

```
Mk1 variance_replicates (already sent in /process body)
  └─ COABuilder build_variance_report() → coa_data["variance_report"]   (only when replicates exist)
       └─ IS COANotificationPayload.variance_report (nested obj, in to_dict when present)
            └─ WP /coa/notify → _accumark_coas[sample_id]["variance_report"]
                 ├─ order page: "Variance Report" button (when present) → /variance-report/?order&sample&nonce
                 └─ new page: VarianceReport front controller → variance-report-content.php (C-then-B, server-rendered SVG)
```

`variance_report` shape (server-authored by COABuilder, customer-tone applied):

```json
{
  "sample": { "name": "MOTS-c", "lot": "GPP260424-PR7304" },
  "tests": [
    { "key": "purity", "name": "Purity", "method": "HPLC · DAD 220nm",
      "unit": "%", "qualitative": false,
      "spec_text": "≥ 98.0%", "spec_min": 98.0, "spec_max": null,
      "domain": [97.5, 100.2], "values": [99.89, 99.76, 99.91, 99.82],
      "conforms": true, "status": "Conforms" },
    { "key": "identity", "name": "Identity", "method": "LC–MS",
      "qualitative": true, "spec_text": "MOTS-c",
      "values": ["MOTS-c","MOTS-c","MOTS-c"],
      "match_count": 3, "total": 3, "conforms": true, "status": "Conforms" }
  ]
}
```

Stats (mean/%RSD/min/max/range) and deviations are computed **at render time in
PHP** from `values` — not pushed. `domain`, `spec_*`, `conforms`, `status` are
server-authored by COABuilder (it already computes conformance + knows specs).
Numeric `values` are parsed by COABuilder from its primary figure + the
`variance_replicates` strings (strip unit/`%`). A test is included only when it
has ≥2 values (primary + ≥1 variance vial).

## Changes

### COABuilder (`feat/coa-identity-na-variance`)

- New `build_variance_report(...)` (in `conformance.py` or a small sibling),
  assembling the block above from the per-analyte loop's primary numeric +
  `variance_replicates` (parsed to numbers), with customer-tone `conforms`/
  `status`. Returns `{}` when no test has replicates.
- `CoAData.variance_report: dict` (default `{}`); `process()` populates it;
  `_build_coa_data_json` adds `coa_data["variance_report"]` when non-empty.
- Not rendered on the PDF (digital-only, like the series' digital override).
- Version bump (2.18.0) + CHANGELOG.

### Integration Service (`feat/variance-services-map`)

- `COANotificationPayload.variance_report: dict | None`; in `to_dict()` when
  truthy. Populated from `coa_data.get("variance_report")` in all three publish
  paths (ingestion / desktop / additional-COA), mirroring `lab_remarks`.

### WordPress (wpstar theme)

- `COAEndpoint`: extract `variance_report` (array) from the notify body, store
  in `_accumark_coas[sample_id]['variance_report']`.
- **Order page** (`portal-view-order.php`, primary rows): a "Variance Report"
  button next to "Lab Remarks", shown only when
  `$coa_dl['variance_report']` is non-empty. Links to
  `/variance-report/?order={id}&sample={sid}&nonce=…`.
- **New page**: `src/Front/VarianceReport.php` front controller (mirror
  `VerifyCOA.php`): registers the `/variance-report/` route, verifies the
  logged-in user owns the order (same ownership check as the COA download),
  reads the sample's `variance_report` from order meta, renders
  `templates/variance-report-content.php`.
- **Template** `templates/variance-report-content.php`: brand header + the
  C-then-B layout, server-rendered SVG. PHP helpers port `stats`, `RadialGauge`,
  `Sparkline`, `RangeStrip` (pure functions emitting SVG markup). Brand tokens
  from the theme's existing CSS vars (`#2ABFC4`/`#1B4B8C`/`#FF6B5B`/`#10B981`,
  Poppins/Open Sans/JetBrains Mono). New `css/variance-report.css`.
- Print-friendly (server-rendered SVG; no JS dependency for the charts).

## Customer-tone adaptations (explicit delta from the prototype)

| Prototype (QC-internal) | Customer page |
|---|---|
| Status pill "Investigate" | "Does Not Conform" |
| Gauge coral when %RSD high (even if passing) | Gauge coral only when out-of-spec |
| "R1–R4" run labels | "Result 1 … N" |
| Canvas of 4 concepts | C-then-B stacked, one report |
| No metric explainer | One-line "%RSD = how tightly replicates agree" |

## Layout

Single-column page, max-width ~900px, centered, brand header (sample name + lot +
verification code). **Section 1: Replicate Summary** — the C dashboard-card grid
(2-col on desktop, 1-col mobile). **Section 2: Spread & Conformance** — the B
range-strip rows + legend (Replicate dot / Mean diamond / In-spec band).
Footer: the %RSD explainer + an "Authenticated by Accumark Labs" trust line.

## Out of scope

- Concepts A and D (table, deviation small-multiples) — not built.
- Rendering the report on the PDF or the public verify page.
- D's deviation bars / A's spread table primitives.
- A standalone (no-account) public variance link — the page requires order
  ownership for now (revisit if customers want to share it).

## Testing

- COABuilder (standalone): `build_variance_report` shape — values parsed to
  numbers, primary first then vials, spec/domain/status present, customer-tone
  status strings, `{}` when no replicates, identity as match-count. 
- IS: `variance_report` in `to_dict` when set, absent otherwise; populated from
  coa_data in the publish paths (extend the existing `test_lab_remarks_payload`
  pattern).
- WP: no theme test harness — `php -l` the new files; manual: button appears only
  with data, page renders C-then-B, ownership check blocks other users, prints
  cleanly.

## Risks / notes

- The page reads order meta (push), so it's a snapshot at publish — re-publish
  refreshes it (same model as Lab Remarks). If the report ever outgrows "small,"
  switch the page to pull `coa_data` live from the IS public endpoint (the data
  already lives there) — the button-flag + page-route stay the same.
- PHP-porting the SVG chart math is the bulk of the work; the primitives are
  deterministic and small (`varicharts.jsx` is 175 lines). Match the SVG output,
  not the JS structure (per the design bundle README).
- Numeric parsing of `variance_replicates` strings ("99.1%", "10.1 mg") must be
  robust — strip unit/`%`, keep sign/decimal. COABuilder owns this so WP/IS never
  parse.
