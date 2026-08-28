# COA Legacy-Family Rows from Accu-Mk1 (seam 4, slice 1) — Design

*2026-08-26. Handler-approved design (conversation of 2026-08-25/26). Program: SENAITE phase-out §6 prelude / family-migration seam 4.*

## Problem

COABuilder anchors every COA generation on SENAITE: `/process/{sample_id}` and
`/process-additional/{sample_id}` open with `SenaiteClient.fetch_sample_data()`,
which searches for the AR and reads all result lines from SENAITE
(`_Analyses_Detailed`). Native-first entry in Mk1 makes SENAITE lines
progressively less authoritative, and the eventual disconnect makes them
disappear. This slice moves the **legacy-family result rows** (core HPLC,
endotoxin ENDO-LAL, sterility STER-PCR, bac-water panel) onto the proven
native-sections wire document, sourced from Mk1's `lims_analyses`
(shadow-mirror + canonical rows), while keeping COABuilder's spec engine and
rendering **byte-identical**.

## Non-goals (explicitly out of scope this slice)

- The no-AR anchor: `/process` still 404s without a SENAITE AR. Becomes real
  work only when a-la-carte ordering / seam 3 ships.
- Branding (`CoaCompanyName` etc.), sample metadata, and attachments still come
  from the AR via `fetch_sample_data`.
- The SENAITE PDF write-back tee is unchanged.
- No change to identity-gate / verdict semantics (BKSA-5TC2's N/A purity+qty on
  non-conforming identity is the spec engine working as designed).
- No IS code changes (the S2S document endpoint carries the new block for free).

## Design

### 1. Wire document extension (Mk1 → COABuilder)

`build_native_sections`'s document gains an optional top-level block:

```json
{
  "sample_id": "P-0161",
  "ordered_profiles": ["heavy_metals"],
  "sections": [ ... ],
  "legacy_rows": {
    "source": "mk1",
    "rows": [
      {
        "uid": "mk1:144",
        "Keyword": "HPLC-PUR",
        "Title": "Peptide Purity (HPLC)",
        "ServiceTitle": "Peptide Purity (HPLC)",
        "Result": "12",
        "Unit": "%",
        "review_state": "published",
        "ResultCaptureDate": "2026-08-25T04:26:00+00:00"
      }
    ]
  }
}
```

- **Field contract** (SENAITE-cased, exactly what the coab engines read from
  `_Analyses_Detailed`): `uid`, `Keyword`, `Title`, `ServiceTitle`, `Result`,
  `Unit`, `review_state`, `ResultCaptureDate`. `Title` and `ServiceTitle`
  carry the same value (the analysis/service title). `Result` may be
  `None`/empty — pending micro lines are legal and the engines own pending
  semantics (unlike native-section rows, where an empty result aborts).
  No retest fields: supersession is resolved on the Mk1 side.
- **Row selection** reuses `list_parent_analyses_senaite_shape(db, sample_id)`
  (backend/lims_analyses/service.py) verbatim — current-row resolution, retest
  supersession, tier guard, shadow `mirror_review_state` resolution, and the
  cross-provenance keyword collapse (canonical wins) are already implemented
  there. The projection filters to `service_origin == 'senaite'` (legacy
  families only — native-family rows already ride as native sections; ordered
  placeholders are native-family and drop with the same filter) and re-cases to
  the contract above.
- **Fail-closed**: in mk1 mode, zero legacy rows aborts assembly
  (`NativeSectionsError`) — until pure-native samples exist, an empty list can
  only mean a broken mirror, and an empty results table on a certificate is the
  exact silent failure this program exists to prevent. Revisit when a-la-carte
  ships. A row whose `service_origin` is unresolvable (`None` — service FK
  broken) also aborts rather than being silently dropped: a one-row-short
  certificate is the same failure class as an empty one. (Amended 2026-08-26
  after task review — the original `== 'senaite'` filter silently excluded
  `None`.)
- **Skip states are part of the wire contract** (amended 2026-08-26 after the
  final whole-branch review): the producer excludes rows whose emitted
  `review_state` is in `{"retracted", "rejected", "cancelled"}` BEFORE the
  zero-row check — mirroring the SENAITE path's `_SKIP_STATES` in
  `_collect_analyses_details`, which the wire path bypasses. Without this, a
  removed legacy analysis (A7 cascade marks its shadow `rejected` forever) or
  a mid-correction retracted line would reappear on an mk1-mode certificate.
  A row whose `review_state` is `None` aborts producer-side
  (`NativeSectionsError`, same treatment as a missing keyword) — the
  consumer requires a string and the producer must fail with its own clear
  message, not a downstream 422. Belt-and-braces: COABuilder's
  `extract_legacy_rows` REJECTS skip-state rows (422) — a skip-state row
  arriving means a producer bug, and fail-closed beats silently rendering it.
- The parity twin discipline from spec-ownership slice 1 applies: the field
  contract is pinned by twin tests in both repos
  (Mk1 `backend/tests/test_legacy_rows_contract.py` ↔ coab
  `tests/test_legacy_rows_contract.py`) that must move together.

### 2. COABuilder substitution at engine input

- New module `src/coabuilder_core/legacy_rows.py`:
  `extract_legacy_rows(doc) -> Optional[list[dict]]`. Returns `None` when the
  document is absent or carries no `legacy_rows` (legacy caller → current
  SENAITE path, unchanged). Fail-closed validation
  (raises `NativeSectionsValidationError`, mapped to 422 by the existing server
  handlers): `legacy_rows` must be a dict with a list `rows`; every row must be
  a dict with a non-empty string `Keyword` and a string `review_state`.
- `SenaiteClient.fetch_sample_data(..., legacy_rows=None)`: when provided,
  **skip `_collect_analyses_details` entirely** (no per-analysis SENAITE
  round-trips) and set `sample_json["_Analyses_Detailed"] = legacy_rows`. Also
  skip the analysis-level attachment fallback scan (wire rows carry no
  `Attachment` links); mk1 mode relies on AR-level attachments, which Mk1's
  pre-flight gate already guarantees before generation.
- Both `/process` and `/process-additional` extract from
  `body.native_sections` and pass through. Engines (ConformanceEngine,
  GenericAssayEngine, addon parsing), spec dicts, templates: untouched.
- **Drift detector**: `/process` and `/process-additional` responses gain
  `"data_sources": {"legacy_rows": "mk1" | "senaite"}`. Mk1 logs a WARNING
  when the toggle says mk1 but the response says otherwise (old coab deployed,
  or the block was dropped en route). Deploy order stays coab-before-Mk1
  (established BEFORE/WITH rule); 2.32.0's validator ignores unknown doc keys,
  so the toggle default (`senaite`) is the real safety.

### 3. Mk1 toggle + assembly

- The Data Source settings map (`Settings` key `registry_read_source`, value =
  JSON object) gains key `"coa_generation": "senaite" | "mk1"`. Default
  (absent / malformed JSON / unknown value) = `senaite`. New backend reader
  `backend/coa/source_setting.py::coa_generation_source(db)` (the backend has
  never read this map before — the page keys are FE-driven; this key is
  backend-driven, and the FE's per-session page overrides deliberately do NOT
  apply to it).
- New `backend/coa/legacy_rows.py::build_legacy_rows(db, parent) -> list[dict]`
  (the projection of §1).
- New assembly wrapper `backend/coa/wire_document.py::build_coa_wire_document(db, parent) -> dict`
  = `build_native_sections(db, parent)` + (when `coa_generation_source(db) ==
  'mk1'`) the `legacy_rows` block. Replaces `build_native_sections` at all four
  call sites in backend/main.py: `generate_sample_coa`,
  `_maybe_emit_regular_coa_child`, `regen_primary_coa`, and the S2S
  `GET /samples/{sample_id}/coa-sections` (IS-driven additional COAs inherit
  with zero IS changes). The per-vial loop in `generate_vial_coas` (which today
  sends only `vial_figures` + remarks) newly attaches a **legacy-only**
  document in mk1 mode — `{"sample_id": ..., "ordered_profiles": [],
  "sections": [], "legacy_rows": {...}}` via
  `build_vial_wire_document(db, parent) -> Optional[dict]` (None in senaite
  mode = unchanged body). Vial certificates have never rendered native
  sections and must not start now; only their base row sourcing follows the
  toggle.

### 4. FE visibility

- `src/lib/read-source.ts`: new exported key `coa_generation` handled OUTSIDE
  `PAGE_KEYS` (no session-override machinery) — a parse helper + a hook that
  reads the global settings map.
- `DataSourcePane.tsx`: a "COA generation" section with the same
  SENAITE/Accu-Mk1 buttons, writing the same settings map.
- Sample-details Actions dropdown: the "Generate COA" and "Generate Vial COAs"
  items carry a source suffix — "· SENAITE" / "· Accu-Mk1" — read from the
  global setting (what the backend will actually do).

## Testing & rollout

- TDD in both repos; Mk1 gates on failure-set diff vs stash baseline (never
  zero-failures), eslint zero-new via stash-compare; coab tests run via host
  python (`python -m pytest`).
- Engine-level parity: substituting identical rows must produce identical
  `results_table` + `addon_results` (coab test drives ConformanceEngine both
  ways). Cross-repo shape parity is pinned by the twin contract tests.
- Rollout: deploy coab first, then Mk1; arcitest flips `coa_generation=mk1`
  first with UAT across a peptide blend + endo/sterility + bac-water sample
  (diff coa_data/PDF against a senaite-mode generation of the same sample);
  prod default stays `senaite` until the Handler flips it in Data Source.
