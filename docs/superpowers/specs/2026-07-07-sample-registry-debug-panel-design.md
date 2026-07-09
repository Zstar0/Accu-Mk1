---
title: "Sample registry debug panel — observability for the dual-write registry"
date: 2026-07-07
status: draft
authors: [ZeroSignal, forrestp]
---

# Sample registry debug panel

## Summary

An admin-gated diagnostic panel on the sample details page that makes the behind-the-scenes registry work observable: does the local `lims_samples` record exist, does it agree with live SENAITE, and (post-cutover) which displayed values are sourced from Mk1 vs SENAITE. A small icon in the header toolbar opens a console-styled right-side Sheet — the same terminal aesthetic as `SampleActivityLog` — that renders a field-by-field registry-vs-SENAITE comparison plus linkage/origin/freshness/vial-sanity diagnostics.

**Why now:** the dual-write registry (base slice + dual-write slice 1) is entirely behind the scenes — nothing on the page reads from `lims_samples` yet (that's Slice 2), so there is no way to eyeball whether population, the creation signal, dual-write mirrors, or the backfill are actually working. This panel is that window.

**Framing (important):** the sample details page currently reads basic info from **SENAITE** (`lookupSenaiteSample`), with the `lims_samples` row riding alongside as a shadow copy. So the useful question *today* is **agreement/drift** between the two stores, not source attribution. When Slice 2 flips the page to read from Mk1, the same panel gains a per-field **source badge** (Mk1 / SENAITE-fallback). Same component, evolves with the cutover.

## Scope

**In:**
- Pure backend diff function comparing a stored `LimsSample` row against a fresh SENAITE meta dict.
- Admin-gated read endpoint `GET /debug/sample-registry/{sample_id}` (non-mutating).
- Optional admin-gated action endpoint `POST /debug/sample-registry/{sample_id}/refresh` (forces reconcile, re-diffs).
- A `SampleRegistryDebug` console Sheet + an admin-only header icon that opens it.
- API client function + types.

**Out:**
- Per-field source attribution badges (Mk1 vs SENAITE-fallback) — meaningful only after the Slice 2 read cutover; the field schema is designed to accept a `source` field later without restructuring.
- Any change to how the page loads or displays sample data.
- Non-admin visibility.
- Results/analyses comparison (registry covers basic info only).

## Decisions (resolved with Handler, 2026-07-07)

1. **Comparison now, source-attribution later** — today the panel shows registry-vs-SENAITE agreement/drift; the source badge lands with Slice 2's read cutover.
2. **Admin-gated, permanent, prod-included** — this is a supportability tool, not throwaway scaffolding; provenance questions outlive the cutover.
3. **Dedicated backend diff endpoint, not client-side diff** — load-bearing correctness reason below.

## Why a backend endpoint (not client-side diff)

The registry row is already partly available client-side via `listSubSamples().parent`, but that path calls `_reconcile_from_senaite` on staleness — which, since the dual-write slice, **refreshes basic info**, auto-healing drift before it could ever be displayed. A drift-detection tool that reads through the mutating path can never show drift. The debug read therefore must be a **non-mutating** path: read the raw row, do not reconcile. That, plus reusing the authoritative `_populate_basic_info` field mapping and comparing fields the display path doesn't otherwise fetch (`coa_meta`), makes a dedicated endpoint the right unit.

## Components

### 1. Pure diff function (backend, `sub_samples/registry_debug.py` new module)

`diff_registry_vs_senaite(row: LimsSample, meta: dict) -> dict` — no I/O, no session. For each basic-info field, compares the stored value against what `_populate_basic_info` **would** derive from `meta` (reusing the same extraction helpers — `_extract_uid`, `_extract_label`, `_parse_senaite_date`, `_parse_analyte_slots`, the `_COA_META_FIELDS` map). Returns:

```
{
  "fields": [
    {"field": "client_sample_id", "registry": "CS-1", "senaite": "CS-2", "status": "drift"},
    ...
  ],
  "summary": {"agree": int, "drift": int, "registry_null": int, "senaite_null": int},
}
```

`status` per field:
- `agree` — stored == derived-from-meta
- `drift` — both present, differ (e.g. `client_sample_id` after a SENAITE-side Replace-Analyte edit — the known real drift source)
- `registry_null` — stored is null, SENAITE has a value (reconcile-fill candidate; expected for the display fields IS can't send — `sample_type_title`, client id-slug — per the dual-write spec amendment)
- `senaite_null` — stored has a value, SENAITE doesn't

Field set = the full basic-info registry columns: `external_lims_uid`, `client_id`, `client_uid`, `contact_uid`, `sample_type`, `client_sample_id`, `peptide_name`, `date_received`, `date_sampled`, `status`, `client_title`, `contact_title`, `contact_email`, `sample_type_title`, `date_created`, `verification_code`, `client_order_number`, `analytes` (structural compare), `declared_total_quantity`, `client_lot`, `client_reference`, `company_logo_url`, `coa_meta` (map compare). Comparison normalizes types (dates → naive UTC on both sides; analytes/coa as parsed structures, not raw strings) so formatting differences don't read as drift.

### 2. Read endpoint (backend, `main.py`)

`GET /debug/sample-registry/{sample_id}`, `Depends(require_admin)`. Steps:
1. Load the `LimsSample` row by `sample_id` **directly** (`select`, no `ensure_sample_row`, no `list_sub_samples`, no reconcile). If absent → `load.exists=false` and return early with a clean partial payload (no SENAITE call needed to report "no row").
2. Fetch fresh `senaite.fetch_parent_metadata(sample_id)` (best-effort; on SENAITE error, return the row half with `senaite_error` set — the panel still shows the stored row).
3. `diff_registry_vs_senaite(row, meta)`.
4. Assemble the response blocks below.

Response shape:

```
{
  "sample_id": "P-0134",
  "load": {"exists": true, "native_id": "aP-0007"|null,
           "external_lims_system": "senaite"|"mk1"|null,
           "last_synced_at": iso|null, "age_seconds": int|null,
           "reconcile_due": bool},
  "linkage": {"registry_uid": "...", "senaite_uid": "...",
              "status": "match"|"mismatch"|"senaite_missing"},
  "origin": "creation-signal"|"native"|"lazy-or-backfill",
  "container": {"container_mode": bool, "assignment_role": "hplc"|...},
  "fields": [...],                       # from the diff fn
  "summary": {...},                      # from the diff fn
  "vials": {"local": int, "senaite": int,
            "status": "in_sync"|"local_extra"|"senaite_extra"},
  "verdict": {"linkage_ok": bool, "vials_ok": bool,
              "drift": int, "registry_null": int},
  "senaite_error": null|"...",
  "raw": {"registry": {...}, "senaite": {...}}   # for the JSON toggle
}
```

- **linkage**: `mismatch` when `row.external_lims_uid` != the uid SENAITE returns for this id — the phantom-vials-from-id-collision signal; surfaced prominently.
- **origin** inference: `native_id` set + `external_lims_system == "senaite"` → `creation-signal`; `external_lims_system == "mk1"` → `native`; `native_id` null → `lazy-or-backfill` (historical rows never got a native id, forward-only decision).
- **vials**: `count(lims_sub_samples where parent_sample_pk == row.id)` vs `len(senaite.fetch_secondaries(sample_id))` — one extra SENAITE call; skip gracefully (report `null`) if that call errors.

### 3. Refresh action endpoint (backend, `main.py`)

`POST /debug/sample-registry/{sample_id}/refresh`, `Depends(require_admin)` — loads the row, calls `_refresh_parent_from_senaite(db, row)`, commits, returns the same shape as GET (re-diffed). Lets an admin watch drift resolve. Distinct verb (POST) because it mutates; the panel wires it to an explicit "reconcile now" button, never automatic.

### 4. Console Sheet (frontend, `src/components/senaite/SampleRegistryDebug.tsx` new)

Mirrors `SampleActivityLog`'s shell exactly: right-side `Sheet`, `w-[600px]`, dark rounded frame, title bar with traffic-light dots + `$ accumark registry-inspect --sample {sampleId}`, refresh + close buttons, `bg-[#0d0d0d]` mono body, footer. Reuses its `levelColor` palette (info/dim/warn/success/error/accent). Body sections, each rendered as console lines:
- **status block**: load (exists/native_id/system), linkage (with `mismatch` in red), origin, freshness (`last_synced_at` + age, amber if `reconcile_due`).
- **field diff**: aligned mono columns `field · registry · senaite · glyph`, glyphs ✔ `agree` (emerald) / ⚠ `drift` (amber) / ○ `registry_null` (dim) / — `senaite_null` (dim); long values truncated with title-tooltip full value.
- **vials** line: `local N · senaite M` with status color.
- **verdict** footer: `N agree · N drift · N null · linkage ok · vials ok`, colored by worst status.
- **collapsible `> raw json`**: pretty-printed `raw.registry` and `raw.senaite`.
- **reconcile-now** button in the title bar (next to refresh) → POST refresh → re-render. Amber, with a one-word confirm affordance since it mutates.

### 5. Header icon (frontend, `SampleDetails.tsx`)

A small icon-only `Button` (lucide `Radar`, matching the toolbar's `size={12}` outline style) in the existing header toolbar next to the Activity button, rendered only when `useAuthStore(s => s.user?.role === 'admin')`. Opens the Sheet via a `registryDebugOpen` state, same pattern as `activityLogOpen`.

### 6. API client (frontend, `src/lib/api.ts`)

`getSampleRegistryDebug(sampleId: string): Promise<SampleRegistryDebug>` and `refreshSampleRegistry(sampleId: string): Promise<SampleRegistryDebug>` + the `SampleRegistryDebug` TypeScript type mirroring the response shape.

## Data flow

Admin clicks the header icon → Sheet opens → `getSampleRegistryDebug(sampleId)` → `GET /debug/sample-registry/{id}` → (non-mutating row read + fresh SENAITE fetch + pure diff) → structured JSON → console sections render. "Reconcile now" → `POST …/refresh` → same shape re-diffed → re-render (drift should drop to zero for reconcilable fields).

## Error handling

- Non-admin → 403 at the endpoint; the icon isn't rendered for non-admins either (defense in depth).
- Missing registry row → `load.exists=false`, clean partial payload, panel shows "no registry record for {id}" plus whatever SENAITE reports (so you can see a row that *should* exist but doesn't).
- SENAITE fetch fails → `senaite_error` set, diff omitted, panel shows the stored row alone with an error line (still useful).
- `fetch_secondaries` fails → `vials` null, rest intact.
- The GET path never writes; only the explicit POST refresh mutates.

## ISO 17025 alignment

- **7.11.2 LIMS change validation:** this panel is standing validation evidence for the registry migration — an operator can confirm, per sample, that the local record matches the authoritative source, and the drift/linkage checks are exactly the "did the system record what it should" question. Not a formal control, but supports the alignment posture.

## Testing

- **Pure diff (unit, no mocks):** agree; drift on `client_sample_id`; `registry_null` on `sample_type_title` (the reconcile-fill case); `senaite_null`; analyte structural drift (slot changed); coa_meta map drift; date normalization (offset string vs stored naive UTC → agree, not drift).
- **Endpoint (unit):** non-admin → 403; missing row → `exists=false`, 200, no SENAITE call required; **non-mutation assertion — `last_synced_at` is byte-identical before and after a GET** (the anti-reconcile guarantee); linkage `mismatch` when stored uid differs from SENAITE's; `senaite_error` path returns the row half.
- **Refresh endpoint (unit):** mutates (`last_synced_at` advances), returns re-diffed shape, non-admin → 403.
- **Frontend (component):** renders each glyph for its status; admin-gating hides the icon for a non-admin user; raw-json toggle shows/hides.

## Open items (fold into the plan)

- Confirm the exact `require_admin` dependency signature and the `select`-by-`sample_id` idiom already used elsewhere in `main.py`.
- Pick the header icon (lucide `Radar` vs `Bug` vs `Stethoscope`) to match toolbar tone.
- Decide whether `raw.senaite` is the full `complete=true` payload (large) or a trimmed projection — recommend full, since deep debugging is the point, behind the collapse.
