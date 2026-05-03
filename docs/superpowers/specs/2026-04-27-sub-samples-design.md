# Sub-Samples — Design

**Date:** 2026-04-27
**Scope:** Receive multiple vials per sample order as first-class sub-samples (mirroring SENAITE's native `AnalysisRequestSecondary`), with a grow-as-you-go receive wizard, per-vial photos, batch label printing, and a parent-detail surface that exposes sub-sample analyses for future result transcription.
**Repos touched:** `Accu-Mk1` only. `integration-service` is intentionally untouched. SENAITE-side configuration (existing) is consumed but not modified.

---

## Goals

- A parent SENAITE sample can have N sub-samples (one per physical vial received), each tied to the parent via SENAITE's native `IAnalysisRequestSecondary` marker and `getPrimaryAnalysisRequest()` linkage.
- A new receive wizard in Accu-Mk1 walks the receiver through receiving each vial: photo capture, optional remarks, save, repeat. Total vial count is not pre-declared; the receiver adds vials until done.
- Sub-samples can be added to a parent **after** the initial receive session is closed (re-open the same wizard from the parent detail page).
- Each sub-sample gets a printed label after the receive session ends. Printing is from the browser to the receiver's local Cab Mach 4S/600B printer via the OS print spool — no desktop-only path, no new local agent.
- All Accu-Mk1 UI surfaces that render a sample ID gain a parent-linkage badge for sub-sample IDs.
- Parent sample detail page gains a Sub-Samples section listing each child plus a Sub-Sample Analyses section showing per-child analyses and results (read-only in v1).
- Sub-sample data lands in an Accu-Mk1-local `sub_samples` table FK'd to a new stub `samples` master table, lazily populated. The `samples` table is the seed of the eventual SENAITE-replacement master table.

## Non-goals

- No worksheet vial-to-test assignment flow. Worksheets continue to operate against parent IDs in v1; the assignment-to-sub-sample work is a later phase.
- No automatic transcription of sub-sample results to parent. Tech enters parent results manually using the visible-on-page sub-sample results as reference; an explicit "pull from sub-sample" affordance is deferred.
- No Variance Addon. Future feature; v1 only enables the data shape it will need.
- No per-vial workflow rollup or cascade. Sub-samples have independent SENAITE workflow state; parent state transitions stay on their existing path (driven by the existing `/wizard/senaite/receive-sample` endpoint).
- No changes to the WP↔integration-service comms surface. integration-service does not learn about sub-samples in v1.
- No backfill of historical samples into the new `samples` table. Only parents touched by this feature get rows.
- No role gating on the wizard or after-the-fact entry point. All authenticated users in v1.
- No native JScript emission to the printer. Browser HTML print only.
- No printer-config UI. Browser print dialog handles printer selection.

## Architecture

**Sub-sample creation path:** Accu-Mk1 backend → SENAITE REST API. integration-service is not in the loop. This mirrors the existing receive endpoint pattern at `backend/main.py:10821-11054` and matches the project rule that integration-service is narrowly scoped to WP bridging while LIMS-internal SENAITE work lives in Accu-Mk1.

**Source of truth:** SENAITE remains canonical for sample hierarchy until the future master-table migration. Accu-Mk1's new tables are a local cache used for fast UI reads and as the seed of the eventual replacement schema.

**Forward-compatibility:** External-system references use neutral field names (`external_lims_uid`, `external_lims_system`) so the schema does not require renames when SENAITE is sunset. Sub-samples FK to the local `samples` table by primary key, not by external UID — that link survives SENAITE removal.

## Data model

Two new tables in the `accumark` database (SQLAlchemy ORM, `backend/models.py`).

### `samples` — stub master table

```
samples
─────────────────────────────────────
id                       pk
sample_id                str, unique         -- "P-0134"
external_lims_uid        str, indexed        -- SENAITE UID (nullable post-migration)
external_lims_system     str                 -- 'senaite' today
client_id                str?                -- cached
client_uid               str?
sample_type              str?
status                   str?                -- cached SENAITE workflow state
peptide_name             str?                -- cached, used widely in UI
client_sample_id         str?                -- client's own reference
date_sampled             timestamp?
date_received            timestamp?
is_retest                bool default false
created_at               timestamp
last_synced_at           timestamp
```

Lazy upsert: receive wizard's first action for parent P-0134 ensures a row exists. If missing, fetch parent metadata from SENAITE and insert. Subsequent sub-samples for the same parent skip the fetch.

### `sub_samples`

```
sub_samples
─────────────────────────────────────
id                       pk
parent_sample_pk         fk → samples.id     -- local FK; survives SENAITE removal
external_lims_uid        str, unique         -- SENAITE secondary UID
sample_id                str, unique         -- "P-0134-S02"
vial_sequence            int                 -- 1, 2, 3...
received_at              timestamp
received_by_user_id      fk → users
photo_external_uid       str?                -- SENAITE attachment UID
remarks                  text?
created_at               timestamp
```

Unique constraint on `(parent_sample_pk, vial_sequence)` to prevent duplicates.

### Existing tables — no changes

`worksheet_items`, `hplc_analyses`, `sample_priorities`, `sample_preps`, `sample_analyte_aliases` already reference samples by string ID. Sub-sample IDs (`P-0134-S02`) flow through them unchanged.

## SENAITE integration

**Create-secondary call:** Backend POST to SENAITE creating an `AnalysisRequest` in the parent's client folder, with the `IAnalysisRequestSecondary` marker applied and `setPrimaryAnalysisRequest(parent_uid)`. SENAITE auto-generates the `P-XXXX-SNN` ID via its own `idserver.py` logic (`get_secondary_count` + atomic counter). Photo is uploaded as a SENAITE attachment in the same flow as today's `receive-sample` endpoint.

**Exact payload shape** is unverified from the local Senaite repo and must be confirmed against the live SENAITE REST API at planning time. Two paths exist: direct Plone object creation via `@@API/senaite/v1` create, or a custom Accu-Mk1-side helper endpoint in SENAITE if the public API does not expose the marker-interface step. Implementation plan resolves this.

**Workflow state:** Sub-samples follow SENAITE's same workflow as parent ARs but transition independently. Accu-Mk1 does not cascade transitions in v1.

**Parent state:** First [Save Vial] in a brand-new wizard run also calls the existing `/wizard/senaite/receive-sample` endpoint on the parent so the parent transitions to "received" via the existing path that drives WP-sync comms. Subsequent vials and after-the-fact additions do not touch parent state.

## Receive wizard

### Entry points

1. **First receive** — From the existing intake list (`src/components/intake/ReceiveSample.tsx`), the receiver picks an unreceived parent and launches the wizard.
2. **After-the-fact** — From parent detail page (`SampleDetails.tsx`), an "Add Sub-Sample" button on the new Sub-Samples section opens the same wizard, parent pre-selected, vial sequence auto-incremented past existing children.

### Wizard structure

```
Wizard for parent P-0134
├── Sidebar (always visible)
│   ├── Lists all sub-samples for P-0134:
│   │   - This-session vials (editable)
│   │   - Prior-session vials (read-only, link to detail page)
│   └── Click navigates the main panel
├── Main panel — current vial
│   ├── Camera capture (required, 1 photo)
│   │   - Browser MediaDevices API
│   │   - Fallback: file picker if camera denied/unavailable
│   ├── Remarks textarea (optional)
│   └── [Save Vial]
│       → POST to backend
│       → Backend creates SENAITE secondary, uploads photo, returns assigned sample_id + vial_sequence
│       → Backend upserts samples row + inserts sub_samples row
│       → On success: sidebar refreshes, main panel resets to next vial
└── Footer
    ├── [Receive Another Vial] → reset main panel
    └── [Done — Print Labels] → exit-step
```

### Save semantics

Each [Save Vial] is its own atomic transaction. SENAITE creation happens first; only on SENAITE success does the local DB row land. If the tech closes the browser between vials, all saved vials persist; the in-flight unsaved vial is lost (no draft persistence in v1).

#### Single-vial check-in policy (revised 2026-05-01)

The **parent AR is vial 1**. Sub-samples (`-S01`, `-S02`, …) represent **additional vials beyond the first**. Concretely:

- 1 vial received → just the parent. Photo + remarks live on the parent's attachment + Remarks. **No sub-sample row is created.**
- 2 vials received → parent (vial 1) + `-S01` (vial 2).
- N vials received → parent + `-S01` … `-S(N-1)`.

The wizard's `[Save Vial]` for the *first* vial of a never-received parent calls only `/wizard/senaite/receive-sample` (parent transitions to received with photo). It does **not** call `create_sub_sample`. Subsequent vials in the same session, and "Add Additional Vial" launches from a parent detail page, call `create_sub_sample` as before — the new sub-sample's `vial_sequence` starts at 1 in the DB but conceptually represents the *second* physical vial. The tech does not re-record vial 1's data when adding subsequent vials; non-photo fields (compound, peptide name, client, lot) remain on the parent AR and the new sub-sample inherits them via the existing `extract_inheritable_fields` flow.

Backwards-compatibility: any pre-existing parents that were checked in under the old behavior (parent received + `-S01` redundantly created from the same vial) remain valid. The new `-S01` for those parents is treated as vial 2 on subsequent additions, even though it carries the same photo as the parent. No data migration is performed; the orphan `-S01` rows can be cleaned up manually if desired.

### Edit semantics

- This-session vials: photo and remarks editable. Last-write-wins; updates push to SENAITE attachment + remarks.
- Prior-session vials: read-only inside the wizard. Link out to dedicated sub-sample detail page (route below).
- Delete: this-session vials only. Removes SENAITE secondary + local row in one transaction.

### Print step

Reached via [Done — Print Labels]. Renders an HTML print page containing one label per vial received in the current session. Triggers `window.print()`. Receiver selects the Cab printer in the browser's print dialog; subsequent prints in the same session remember it.

[Skip Printing] is allowed; reprint is always available from the parent detail page's per-vial [Print Label] button.

### Vial sequence assignment

Backend assigns `vial_sequence` inside the same transaction as the `sub_samples` insert: `SELECT MAX(vial_sequence) + 1 FROM sub_samples WHERE parent_sample_pk = ?` with `FOR UPDATE` lock on the parent's `samples` row. Concurrent receivers serialize on the lock; both succeed with adjacent sequence numbers.

## Label print subsystem

**Path:** Browser HTML print → Windows print queue → Cab Mach 4S/600B Windows driver → printer. Same approach SENAITE uses today; the Cab driver handles bitmap-to-JScript translation.

**Print page:**
- Hidden iframe or new window with print-only HTML
- `@page { size: <physical media>; margin: 0 }` — exact size verified at planning time. SENAITE's "Code 39 40×20mm" template is taken as a settings reference; physical media (reported as 2"×0.25") is the contract if they conflict.
- One `<div class="label">` per vial
- Sample ID text + Code 39 barcode of the human-readable sample ID (`P-0134-S02`), rendered as SVG via JsBarcode

**Reprint:** Per-vial [Print Label] on parent detail re-opens the same print page with one label.

**Future option (not v1):** WebUSB direct-to-printer with raw JScript, only if browser-print precision becomes a real complaint.

## UI changes

### `<SampleIdBadge>` — shared component

```
<SampleIdBadge id="P-0134-S02" parentId="P-0134" vialSequence={2} />
  → "P-0134-S02 ↳ child of P-0134"

<SampleIdBadge id="P-0134" hasChildren={3} />
  → "P-0134 (3 vials)"

<SampleIdBadge id="P-0089" />
  → "P-0089"
```

Click on the parent ID navigates to parent detail. Hover tooltip shows full vial list.

**Swap-in sites (mechanical edits, ~25 callsites):**
- `src/components/senaite/SampleDetails.tsx:388, 2040, 2042`
- `src/components/COAExplorer.tsx:324`
- `src/components/explorer/OrderDetailPanel.tsx:364, 616, 924, 1033`
- `src/components/OrderStatusPage.tsx:248, 719, 1155, 1173`
- `src/components/hplc/SamplePreps.tsx`
- `src/components/hplc/SamplePrepHplcFlyout.tsx:346, 1006, 1303, 1331`
- `src/components/hplc/WorksheetDrawerItems.tsx:239, 404`
- `src/components/hplc/WorksheetsInboxPage.tsx:337`
- `src/components/intake/ReceiveSample.tsx`
- `src/components/AnalysisResults.tsx:152`
- `src/components/CalibrationPanel.tsx:287, 543, 764`
- `src/components/reports/PurityTrendView.tsx:59`
- `src/components/explorer/AddSamplesModal.tsx:134`

Final list confirmed at planning time via grep; the above is the research baseline.

### Parent sample detail page additions

In `SampleDetails.tsx`, appended after existing analyses display:

1. **Sub-Samples section**
   - Collapsed if zero children, expanded otherwise
   - Per-child row: vial sequence, sample ID, status, photo thumbnail (lightbox), received_at, received_by, [View Details], [Print Label]
   - Section header: [Add Sub-Sample] launches the wizard

2. **Sub-Sample Analyses section**
   - Read-only flat table grouped by sub-sample
   - Shows each child's analyses + current results
   - Collapsed if zero children
   - **In v1 this section will be empty for every parent**, because no analyses land on sub-samples until the deferred worksheet vial-to-test assignment phase ships. The section is built now so the worksheet phase only needs to populate it, not add the UI surface. v1 acceptance: the section renders correctly with zero analyses and degrades cleanly. Surface for future manual transcription; no write affordances in v1.

Photo thumbnails load eagerly.

### Sub-sample detail route

New route: `/samples/{sample_id}` resolving to a dedicated page mirroring the parent detail layout but for the sub-sample. Used by:
- [View Details] from parent's Sub-Samples section
- Barcode scan landing page (scanner emits sample_id, browser navigates to this route)
- Cross-references from worksheet UI in future phases

### Receive intake list

`ReceiveSample.tsx` continues to list parent samples only (sub-samples never appear here directly). Adds a vial-count indicator: "N vials received" once any vials exist for that parent. Clicking a partially-received parent re-enters the wizard at vial N+1 — same as the after-the-fact flow.

### Sample Prep pages

Badge swap only. No structural changes (group-by-parent, parent-vial filtering) in v1; defer until the worksheet phase makes sub-samples carry preps.

### Worksheet UI

Badge swap only. Vial-to-test assignment is the deferred phase.

## Error handling

### SENAITE create-secondary failure

Order of writes: SENAITE first; only on confirmed success do the Accu-Mk1 rows land. Photo held in browser state on failure, never lost. Wizard shows inline error with [Retry] / [Cancel This Vial] and does not advance.

### SENAITE-Accumk1 drift

When parent detail renders the Sub-Samples section, backend checks `samples.last_synced_at`. If older than threshold (5 min default), re-fetches from SENAITE and reconciles. Reconciliation rules:

- SENAITE is canonical until migration.
- On conflict (SENAITE has a child Accu-Mk1 doesn't): insert locally.
- Never delete a local row based on absence in SENAITE — surface to a human instead.

**Cache invalidation:** Backend updates `samples.last_synced_at = now()` on every successful sub-sample insert/edit/delete originating from Accu-Mk1, since those writes leave SENAITE and Accu-Mk1 in sync. Reads within the freshness window then trust the local cache without re-fetching. The freshness check exists for the case where SENAITE was mutated outside Accu-Mk1 (manual edit by a SENAITE operator, integration-service activity, etc.).

A discrepancy admin view (parents where SENAITE child count ≠ Accu-Mk1 child count) is **specified but not built** in v1. Add only if drift is observed in practice.

### Vial sequence collisions

Avoided via the row-level lock in the assignment transaction. See "Vial sequence assignment" above.

### Photo upload size / format

Client-side compression (canvas → JPEG, ~500 KB target). File-picker fallback accepts JPEG/PNG with the same compression path.

### Print failure

Does not block sub-sample persistence. [Retry] in the print step or reprint from parent detail page. Worst case: tech writes the ID on the vial in marker and reprints later.

### After-the-fact addition to a closed parent

Allowed unconditionally. Parent state untouched. Edge case: adding a vial to a parent with a published COA does not invalidate the COA; the new vial sits with no analyses until a worksheet routes it. v1 does not handle this case beyond accepting the data.

### Wizard interruption / resume

Saved vials persist atomically. In-flight unsaved vial is lost (no draft persistence). Tech reopens parent → wizard sidebar pre-populates with saved vials, ready to capture the next.

### Authorization

All authenticated users; no role gating in v1.

### Audit trail

`received_by_user_id` + `received_at` on the row IS the audit record. Edits within the same session overwrite (last-write-wins). Photo and remarks land in SENAITE attachments / remarks for SENAITE-side audit.

## Testing

### Backend unit tests (pytest)

- `samples` lazy upsert: cold cache, warm cache, stale cache paths
- `vial_sequence` collision: concurrent inserts under row lock yield 1, 2, 3 with no gaps
- `sub_samples` insert rolls back if SENAITE call fails (no orphan local rows)
- Sub-sample list endpoint returns correct shape for parent with 0, 1, N children

### Backend integration tests (against local SENAITE container)

- Create parent, create 3 secondaries, verify SENAITE returns `P-XXXX-S01..03` with correct `getPrimaryAnalysisRequest()` linkage
- Create secondary against a parent whose ID has a suffix (`P-0134-R01`) — verify SENAITE strips it and yields `P-0134-S01` (documented `idserver.py` behavior we depend on)
- After-the-fact add against an already-received parent — verify no parent state regression
- Photo attachment uploads and is retrievable

### Frontend unit tests (vitest)

- `<SampleIdBadge>` rendering matrix: parent only, child with parent, parent with N children, no hierarchy
- Wizard state machine: capture → save → next vial; capture → save → done → print
- Error states: SENAITE failure shows retry; photo capture failure shows fallback

### E2E (Playwright)

- Full happy path: intake list → select parent → vial 1 photo + save → vial 2 photo + save → done → print page renders → close
- After-the-fact: parent detail page (already-received) → Add Sub-Sample → capture → save → close → vial appears in Sub-Samples section
- Direct URL: navigate to `/samples/P-0134-S02` → sub-sample detail page renders correctly

### Manual smoke checklist

On the actual receiver workstation before declaring done:
1. Open Accu-Mk1 in browser
2. Run the full wizard with a real test sample
3. Print labels — verify alignment, density, barcode scannability with the lab's scanner
4. Reprint from parent detail page — verify same output

## Rollout

Additive feature, no flag. The existing receive flow stays operational; the new wizard is reachable from a new entry point. Fallback if the wizard breaks: existing receive path still works for parents without sub-samples; for parents that need them, sub-samples can be added after-the-fact once the wizard is fixed.

No data migration. New tables are empty at deploy and populate lazily.

## Observability

- Log every SENAITE create-secondary call: parent ID, response status, duration
- Log every print invocation: vial count
- WARN level on drift events (reconciliation finding new SENAITE-only sub-samples)

## Open items resolved at planning time

- Exact SENAITE REST payload for `AnalysisRequestSecondary` creation (verify against live SENAITE; fall back to a custom Accu-Mk1-side helper endpoint in SENAITE if the public API does not expose the marker-interface step)
- Reconcile SENAITE template "Code 39 40×20mm" against physical media stock "2"×0.25"" — measure actual labels, set print page CSS to physical truth
- Final list of `<SampleIdBadge>` swap sites — confirm via grep over current `main`
- Photo compression code path — reuse existing wizard photo flow in `ReceiveSample.tsx` if present, otherwise implement

## Future phases (named, not built)

- Worksheet vial-to-test assignment: when a vial gets routed to a test, instantiate a new analysis on the sub-sample
- Manual result transcription affordance on parent: "pull from sub-sample" buttons on parent's analyses
- Variance Addon: COA section aggregating results across selected sub-samples
- Per-vial workflow rollup / cascade
- Sample Prep grouping by parent
- Drift admin view if reconciliation surfaces real discrepancies
- Role gating on receive wizard / after-the-fact entry point
- WebUSB direct-to-printer if browser-print precision is insufficient
- Backfill of historical samples into the `samples` master table — this is a SENAITE-sunset migration concern, not a phase of this feature; called out here only because the lazy-upsert design assumes someone will eventually finish the table.
