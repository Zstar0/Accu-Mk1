# COA Read-Independence — seam 4 slice 2 + resolver swap

**Date:** 2026-08-28 · **Status:** Handler-approved design, pre-plan
**Repos:** Accu-Mk1 (producer + routes) · coabuilder (consumer) · integration-service (verify-only)
**Predecessors:** 2026-08-26-coa-legacy-rows-mk1-source-design.md (slice 1, shipped
Mk1 1.10.0 / coab 2.33.0) · 2026-07-28-native-coa-sections-design.md

## 1. Goal and rulings

After this slice, with the Data Source map's `coa_generation` key set to `mk1`,
**COA generation performs zero SENAITE reads**: no AR search, no AR blob fetch,
no attachment downloads, no pre-flight attachment listing, no resolver HTTP.
A SENAITE outage cannot block or alter certificate generation.

Handler rulings (2026-08-28):

- **R1 — no SENAITE fallbacks in mk1 mode.** Generation is completely reliant
  on Mk1 data and **fail-closed**: a missing `sample_meta` block, a missing
  required attachment, or an unresolvable envelope aborts generation with an
  explicit error. It never silently falls back to a SENAITE read. Rollback is
  flipping the toggle to `senaite` (which keeps the slice-1 path bit-for-bit),
  never an automatic fallback.
- **R2 — chromatogram must look identical.** Satisfied by construction: the
  CSV coab renders today is built by Mk1 (`main.py` chromatogram push, from
  `HPLCAnalysis.chromatogram_data`) and snapshotted natively as
  `LimsParentAttachment(kind='chromatogram')` before SENAITE receives its
  copy. coab keeps its exact `ChromatogramRenderer`; only the CSV's source
  moves to Mk1's store. Same bytes → same renderer → identical image.
- **R3 — SENAITE writes continue unchanged.** Mirror, tees, attachment
  uploads, registration: untouched. This slice is reads only.
- **Scope:** parent COAs (primary, regular/Core child, regen-primary, IS
  additionals, per-vial). Sub-sample (`-SXX`) COAs stay on the SENAITE path
  (badge already says so) — parked for the per-vial rework. The conformance
  input adapter (`backend/conformance/senaite_input.py`) is slice 3, not here.

## 2. Wire contract — the `sample_meta` block

`build_coa_wire_document` (backend/coa/wire_document.py) adds, **in mk1 mode
only**, a `sample_meta` key beside `legacy_rows`. It rides all three parent
call sites unchanged and reaches IS additionals through the existing S2S
`GET /samples/{id}/coa-sections` verbatim pass-through.
`build_vial_wire_document` adds the same key to the vial doc in mk1 mode
(senaite mode still returns `None`).

```jsonc
"sample_meta": {
  "source": "mk1",
  // envelope scalars — key names are the AR-blob spellings coab's engines
  // already read, produced from the named native columns:
  "SampleID": "PB-0486",                  // lims_samples.sample_id
  "SampleTypeTitle": "Peptide Blend",     // lims_samples.sample_type_title
  "ClientSampleID": "...",                // lims_samples.client_sample_id
  "DateReceived": "2026-08-28T04:32:14",  // lims_samples.date_received (ISO)
  "DeclaredTotalQuantity": "20.0",        // lims_samples.declared_total_quantity
  "ClientLot": "...",                     // lims_samples.client_lot
  "BatchID": "...",                       // = ClientLot (peptide-engine alias)
  "Analyte1Peptide": "...",               // lims_samples.analytes slots 1..4
  "Analyte2Peptide": "...",               // (absent slots omitted)
  "CoaCompanyName": "...",                // lims_samples.coa_meta JSON
  "CoaEmail": "...",
  "CoaWebsite": "...",
  "CoaAddress": "...",
  "CompanyLogoUrl": "https://...",        // resolved ABSOLUTE via the
                                          // registry_details WP-host resolver
  "ChromatographBackgroundUrl": "https://...",  // may be null — see §6
  // attachment descriptors — replaces the AR Attachment walk:
  "attachments": [
    {
      "role": "sample_image",             // explicit role, no extension guessing
      "attachment_id": 123,
      "filename": "PB-0486-sample-image.png",
      "content_type": "image/png",
      "url": "https://accumk1.../s2s/samples/PB-0486/attachments/123"
    },
    {
      "role": "chromatogram_csv",
      "attachment_id": 124,
      "filename": "chromatogram_PB-0486.csv",
      "content_type": "text/csv",
      "url": "https://accumk1.../s2s/samples/PB-0486/attachments/124"
    }
  ]
}
```

Producer rules:

- Fields come from the columns above (the same set
  `sub_samples/registry_details.build_native_details` already serves with
  zero SENAITE HTTP). No field is fetched from SENAITE at assembly time.
- `DeclaredTotalQuantity`/`ClientLot`/`ClientSampleID` may be empty strings
  (their AR equivalents could be too); `SampleTypeTitle` empty **aborts**
  (matrix selects the engine — fail-closed rule 5 discipline).
- Attachment selection: newest `render_in_report`-eligible
  `kind='receive_image'` (or `attachment_type='Sample Image'`) row →
  `sample_image`; newest `kind='chromatogram'` row → `chromatogram_csv`.
  Deterministic (highest id wins). Only `storage='s3'` rows are eligible —
  a `storage='senaite'` row (none exist post-§4) is treated as missing.
- Customer remarks keep riding as the existing top-level `lab_remarks`
  fields — NOT duplicated in `sample_meta`.

Twin contract discipline: the key list, role vocabulary, and abort rules are
pinned by twin tests in both repos (same pattern as
`legacy_rows.FIELD_CONTRACT` / `SKIP_STATES`), moved together or not at all.

## 3. coab consumption — envelope synthesis, no AR fetch

In `fetch_sample_data`, when `sample_meta` is provided (arriving like
`legacy_rows` does, extracted and validated in a new
`src/coabuilder_core/sample_meta.py`):

1. **Skip the AR search and AR fetch entirely** (requests 1–3). Build
   `sample_json` from `sample_meta`'s scalars — the exact key spellings the
   engines read today (`SampleTypeTitle`, `getClientSampleID` ←
   `ClientSampleID`, `DateReceived`/`getDateReceived`, `ClientLot`,
   `getBatchID`/`BatchID`, `Analyte{n}Peptide`, `DeclaredTotalQuantity`,
   `Coa*`, `CompanyLogoUrl`, `ChromatographBackgroundUrl`) — so
   ConformanceEngine, GenericAssayEngine, addon parsing, and the CoAData
   mapping run byte-untouched.
2. **Skip the AR attachment walk** (requests 4–6). Download each
   `sample_meta.attachments[*].url` into `results/{sid}/attachments/` with
   the service-token header, and populate `att_files_map` from the explicit
   `role` field (no extension guessing). Client logo / watermark keep their
   existing WordPress download path.
3. **Fail-closed (R1):** `sample_meta` present but malformed → 422
   (`NativeSectionsValidationError` family, like `legacy_rows`); an
   attachment URL download failure → 422 (no SENAITE retry); `sample_meta`
   absent → the SENAITE path runs unchanged (senaite mode / legacy callers).
   `/process` responses echo `data_sources.sample_meta = "mk1"`, and Mk1's
   `warn_if_source_ignored` is extended to warn when the toggle said mk1 but
   the response reports otherwise.
4. Validation mirror: `legacy_rows` requires `sample_meta` when both ride
   (mk1 mode always sends both); a doc carrying `legacy_rows` **without**
   `sample_meta` is a producer bug once both sides deploy — consumer warns
   (not 422) for one release, then tightens (noted as a follow-up ratchet so
   old-Mk1/new-coab stays live during the deploy window).

New coab config: `ACCUMK1_SERVICE_TOKEN` (same shared secret as Mk1's
`ACCUMK1_INTERNAL_SERVICE_TOKEN`); URLs arrive per-attachment in the wire doc
so no base-URL config is needed.

## 4. Attachment bytes — new S2S route on Mk1

`GET /s2s/samples/{sample_id}/attachments/{attachment_id}`
— `Depends(require_internal_service_token)` (`X-Service-Token`), body/streaming
logic cloned from the existing user-JWT download route
(`/registry/sample/{id}/attachments/{id}/download`): bytes from the photo
storage backend (S3 or filesystem — `storage_key` addressed), Content-Type
and filename from the DB row (never the key extension — `.bin` trap),
`storage != 's3'` → 404. Serves both storage backends; no SENAITE branch.

## 5. Pre-flight gates and resolver — native in mk1 mode

- **Attachments gate:** `_parent_attachment_kinds` gains an mk1-mode branch
  reading `lims_parent_attachments` (same image-required /
  chromatogram-for-non-micro semantics, same blocker wording). No SENAITE
  listing. Fail-closed: no native rows → blocked with a native-worded error.
- **Resolver:** in mk1 mode `generate_sample_coa` constructs a new
  `ShadowAnalysesReader` (backend/coa/) instead of
  `SenaiteAnalysesHttpReader`. It serves the reader Protocol from
  `list_parent_analyses_senaite_shape` rows with three parity requirements:
  `retest_of_uid = f"mk1:{retest_of_id}"` when set (else superseded originals
  resurface as spurious `needs_decision` blockers); `reportable` surfaced
  from the native column (candidates default True; the SENAITE-uid sidecar
  lookup is a no-op for `mk1:` uids by design); `review_state=None` aborts
  producer-side. Canonical-backed keywords already never reach the reader
  (`_resolve_mk1_parent_tier` shadows them), so the reader only serves
  SENAITE-only fall-through keywords.
- `families/routes.py`'s reader dependency swaps to the same
  `ShadowAnalysesReader` in mk1 mode (second consumer of the Protocol).
- **Pin parity:** `CoaResultPin` has no write route; planning includes a prod
  count probe — expected 0 rows, in which case SENAITE-hex pin staleness is
  moot. If rows exist, they are enumerated and migrated to `mk1:` uids in the
  same window.

## 6. Known gaps and their treatments

- **`ChromatographBackgroundUrl` is not captured natively today.** Producer
  adds it to the `coa_meta` capture set (`_populate_basic_info` +
  field-edit mirror) with a one-time backfill from SENAITE run BEFORE the
  flip (a write-window task, not a runtime read). Until backfilled, the wire
  carries null and coab's existing watermark fallback (client logo — a
  WordPress URL, not SENAITE) applies. This is the only fallback in the
  design and it never touches SENAITE.
- **Historical chromatogram CSV coverage.** Samples processed before the
  native snapshot capture may lack a `kind='chromatogram'` row. Planning
  includes a coverage probe; gaps get a backfill script that rebuilds the
  CSV from `HPLCAnalysis.chromatogram_data` with the same CSV builder the
  push path uses (pure Mk1 data) and mints the attachment row. Samples
  still lacking data fail the gate honestly (R1).
- **IS verbatim forwarding is spec-asserted, not code-verified.** Plan task
  zero: read `integration-service/app/api/webhook.py` and confirm the wire
  doc passes through untouched for `/process-additional`; if IS filters
  keys, an IS PR joins the train.
- **Regular-child and per-vial POSTs** already rebuild the wire doc via the
  same chokepoint — they inherit `sample_meta` for free; the per-vial doc
  addition is one line in `build_vial_wire_document`.

## 7. Testing and UAT

- **Twin contract tests** (both repos): `sample_meta` key list, role
  vocabulary, fail-closed rules — byte-pinned pairs.
- **Envelope parity test** (Mk1): for a fixture sample, the synthesized
  envelope equals the AR-blob values field-for-field (and a live-probe
  script for arcitest parity across real samples).
- **coab unit tests**: sample_meta-built `sample_json` drives both engines
  identically to an AR-built one; attachment role routing; 422 matrix.
- **S2S route tests**: token required, both storage backends, DB-row
  content-type, senaite-storage 404.
- **Resolver reader tests**: retest supersession via `mk1:` links,
  reportable propagation, None-state abort — plus the existing resolver
  suite running against the new reader unchanged.
- **The definitive UAT (arcitest): stop the SENAITE container and generate**
  — primary + regular child + additional + per-vial on a peptide sample and
  a BW sample; certificates render correctly, chromatogram pixel-identical
  (rendered from the same CSV), zero drift warnings, and generation FAILS
  with the native error wording when a required attachment row is removed.

## 8. Rollout

Deploy **coab first** (ignores unknown `sample_meta` key until Mk1 ships;
new env token configured at deploy), then Mk1. The toggle already being
`mk1` in prod means the block starts riding on the first post-deploy
generation — the coab-first order plus the presence-driven consumer keeps
every intermediate state safe. `warn_if_source_ignored` extension is the
drift tell. Version targets: coab 2.34.0, Mk1 1.12.0.

## Out of scope

Sub-sample (`-SXX`) COA generation (parked to per-vial rework) ·
conformance input adapter (slice 3) · registration flip / native-born
samples · bench/vial read surfaces · any SENAITE write path.
