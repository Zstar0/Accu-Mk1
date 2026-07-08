# Sample-Details Read-Source Toggle (AR basic-info from Accu-Mk1)

*Design — 2026-07-08. Builds on the dual-write registry (#46) and the sample-registry debug panel (PR #50).*

## Goal

Let an admin flip the **source** of the sample-details page's **AR basic-info region** between live SENAITE and the Accu-Mk1 registry (`lims_samples`), from a toggle in the readout overlay. When set to Accu-Mk1, basic-info is served **registry-first with per-field SENAITE fallback**, and every field advertises which source it actually came from. This validates the mirror field-by-field and exercises the Accu-Mk1 read path end-to-end, in preparation for a real read-cutover later.

**Explicit non-goal:** this does NOT speed up the page. Analyses still come from SENAITE (they are not mirrored), so the SENAITE round-trips remain. Perf is a later slice (parent-analyses mirror, or a read cache).

## Scope

**In scope — the basic-info region only** (the fields the registry mirrors): client, contact, sample type, dates (created/sampled/received), status, declared analytes/composition, declared total quantity, lot, reference, COA meta, company logo, verification code, client order number, client sample id, `native_id`, external LIMS uid/system.

**Out of scope (this slice):**
- **Analyses / services / results** — not mirrored; always sourced from SENAITE regardless of toggle. (A parent-analyses mirror is a separate, larger slice: the schema — polymorphic `lims_analyses` — and the COA-resolver merge pattern are reusable, but continuous inbound freshness from SENAITE and coverage of un-promoted/legacy analyses are net-new and substantial. Not this slice.)
- **Sub-sample (vial) pages** — unchanged. The toggle applies to **parent** sample pages only.
- **Performance** — no cache, no removal of the SENAITE fetch.
- **Write paths** — read-only. No change to dual-write, editing, or reconcile.

## Architecture — Mk1-first, SENAITE-fallback per field

Reuses the merge shape already proven in `backend/coa/source_resolver.py` (Mk1-first, per-keyword SENAITE fallback for COA generation).

```
readout overlay toggle  ──sessionStorage('registryReadSource' = 'senaite' | 'mk1')
        │
        ▼
SampleDetails.resolveSampleData(parentId)
        │  toggle = 'mk1' ?
        ├── 'senaite' → lookupSenaiteSample(id)            (UNCHANGED path)
        └── 'mk1'     → lookupSenaiteSample(id, 'mk1')      (adds ?source=mk1)
                              │
                              ▼  backend
                   basic-info: registry row (lims_samples), per-field
                               SENAITE fallback where column is null/absent
                   analyses:   SENAITE (unchanged)
                   + field_sources: { <field>: 'mk1' | 'senaite' }
```

The backend still fetches the SENAITE AR in `mk1` mode — it is needed both for the analyses and as the per-field fallback source. That is why there is no perf win yet; it is intentional for the validation phase.

## Backend

### 1. Registry → display-shape mapper
`backend/sub_samples/registry_read.py` (new): `registry_row_to_display(row: LimsSample) -> dict` — produces the same basic-info keys the page consumes (the `SenaiteSample` shape built today in `lookup_senaite_sample`), from the `lims_samples` columns. This is the inverse of `_populate_basic_info`. Mapping (registry column → display field):

| Registry column | Display field(s) |
|---|---|
| `client_title` | `getClientTitle` |
| `client_id` | `ClientID` |
| `client_uid` | `ClientUID` |
| `contact_title` | `ContactFullName` |
| `contact_email` | `ContactEmail` |
| `contact_uid` | `ContactUID` |
| `sample_type` (UID) | `SampleType` |
| `sample_type_title` | `getSampleTypeTitle` |
| `client_sample_id` | `ClientSampleID` |
| `date_created` | `created` (ISO) |
| `date_sampled` | `DateSampled` |
| `date_received` | `DateReceived` |
| `status` | `review_state` |
| `verification_code` | `VerificationCode` |
| `client_order_number` | `ClientOrderNumber` |
| `analytes` (JSON) | `Analyte1..8Peptide` + `Analyte1..8DeclaredQuantity` (unpack slots) |
| `declared_total_quantity` | `DeclaredTotalQuantity` |
| `client_lot` | `ClientLot` |
| `client_reference` | `ClientReference` |
| `company_logo_url` | `CompanyLogoUrl` |
| `coa_meta` (JSON) | the `Coa*` keys, spread verbatim |
| `native_id`, `external_lims_uid`, `external_lims_system` | pass-through (diagnostic) |

A field whose column is `null`/absent is emitted as **absent** (not empty string), so the merge layer can tell "registry has nothing here" from "registry says empty".

### 2. Merge + source map
In the sample-lookup path, add a `source: 'senaite' | 'mk1'` parameter (default `'senaite'`). When `'mk1'`:
1. Load the `lims_samples` row; if no row exists, behave exactly as `'senaite'` mode and set every `field_sources` entry to `senaite` (with a top-level `registry_missing: true` flag).
2. Build basic-info as: **registry value if the mapper produced one, else the SENAITE value.** Record `field_sources[field] = 'mk1' | 'senaite'` accordingly.
3. Analyses, instruments, method/service resolution: unchanged (SENAITE).
4. Return the existing response shape **plus** `field_sources` and a `read_source: 'mk1'` marker.

`'senaite'` mode returns the current shape unchanged (no `field_sources`), so existing callers are unaffected.

Admin-gate the `source=mk1` branch (same admin check as the debug panel), since it is a diagnostic view.

## Frontend

### Toggle (in the overlay)
- Add a segmented control to `SampleRegistryDebug` header: **`SENAITE | Accu-Mk1`**.
- Persist to `sessionStorage['registryReadSource']`, default `'senaite'`. A small store/hook (`useReadSource`) exposes the value + setter so both the overlay and `SampleDetails` read the same state; changing it re-fetches the current sample.

### Read path
- `src/components/senaite/SampleDetails.tsx` `resolveSampleData`: for a **parent** id, when `registryReadSource === 'mk1'`, call `lookupSenaiteSample(id, 'mk1')`; otherwise the current call. Sub-sample branch unchanged.
- `src/lib/api.ts` `lookupSenaiteSample(id, source?)`: append `&source=mk1` when `source === 'mk1'`. Extend the response type with optional `field_sources?: Record<string,'mk1'|'senaite'>` and `read_source?: 'mk1'`.

### Source marking
- When `read_source === 'mk1'`, render a subtle per-field tag on the basic-info fields: `mk1` (emerald) / `sen` (zinc), driven by `field_sources`.
- A header summary chip: **"N/M fields from Accu-Mk1"** (count of `mk1` entries) — the at-a-glance coverage readout.
- When `registry_missing`, show a single banner ("no Accu-Mk1 registry row — showing SENAITE") instead of per-field `sen` noise.

## Error handling / edge cases

- **No registry row** → transparent SENAITE behavior + `registry_missing` banner (never a broken page).
- **Analytes/coa_meta JSON malformed** in the registry → treat as absent for those fields, fall back to SENAITE, tag `senaite`. Never throw.
- **SENAITE unreachable in `mk1` mode** → analyses + fallback fields fail exactly as today's SENAITE mode fails (same error surface); registry-sourced fields would still be renderable, but we do NOT special-case this in slice 1 — same failure behavior as `senaite` mode keeps it simple.
- **Toggle default off** → zero behavior change for anyone who never flips it. Non-admins never see the toggle and cannot pass `source=mk1`.

## Testing

- **Backend unit:** `registry_row_to_display` mapping (all columns incl. analyte-slot unpack, JSON shapes, None→absent); merge produces correct `field_sources` (mk1 where registry present, senaite where null); missing-row path returns senaite behavior + `registry_missing`; admin-gate rejects non-admin `source=mk1`.
- **Frontend unit (vitest):** toggle persists to sessionStorage and defaults `senaite`; parent page in `mk1` mode calls `lookupSenaiteSample(id,'mk1')` and renders source tags + the N/M summary; sub-sample page ignores the toggle.
- **Live stack validation (registry stack):** flip the toggle on `PB-0073` / `BW-0002`; confirm basic-info values match SENAITE, the source tags read as expected (`mk1` for mirrored fields, `sen` for any gap), and the analyses section is untouched.

## Future (explicitly deferred)

- Parent-analyses mirror (kills the 10s; the real read-cutover). Separate slice.
- Read cache over SENAITE analyses (cheaper perf win if that becomes the priority).
- Promoting `mk1` mode from diagnostic/admin to the default read path once coverage + freshness are proven.
