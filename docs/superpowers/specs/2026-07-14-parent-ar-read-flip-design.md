# Parent-AR Read-Flip — native details builder + gap closures (DRAFT)

*Drafted 2026-07-14. Status: Handler-approved design, spec review pending.
SENAITE phase-out program, section-2 read-flip (spec lineage:
2026-07-12-workflow-state-system-design.md precedes; the shadow-engine spec
2026-07-13-workflow-shadow-engine-design.md follows this slice by Handler
sequencing decision — the flip hardens the mirror the engine will evaluate.)*

## 1. Context and program position

The parent-analysis mirror (slice 2, Mk1 1.2.0) is populated (7,965 shadows,
backfilled + hook-synced) and lifecycle-proven at 0 drift; the state system
(slice 3, Mk1 1.4.0) mirrors sample status with 3-source capture and healing.
Nothing reads the mirror yet.

The read path today: `/registry/sample/{sample_id}/details` in `mk1` mode is
a façade — it calls `lookup_senaite_sample` (the full SENAITE Zope
round-trip) and overlays registry basic-info fields on the result. Its own
docstring: "Analyses and everything else come from the unchanged SENAITE
lookup." Even `analytes` is skipped in the overlay (shape mismatch).

This slice makes `mk1` mode mean what it says: the details response is
assembled **entirely from Mk1-native data — zero SENAITE round-trip** — and
the three field-level gaps that would block parity are closed on the way, per
Handler decision (not deferred as visible holes).

**Why before the shadow engine:** the engine's requirement guards
(`analyses_all_in`, …) evaluate over the same native rows this slice makes
the lab live on. Flipping reads first hardens the mirror, so later shadow
divergence is attributable to requirements definitions, not mirror staleness.

## 2. Handler decisions (locked 2026-07-14)

1. **Close gaps on the way** — no "ship with visible gaps" flip.
2. **Method/instrument: full native authority now.** SENAITE's M/I fields are
   consumed by nothing (lab workflow ✗, COABuilder ✗ — verified: COABuilder's
   `senaite_client.py` never reads Method/Instrument). Route all M/I edits and
   reads to Mk1's native `instruments` / `hplc_methods` linkage. No SENAITE
   UID resolver, no SENAITE M/I backfill.
3. **Internal remarks: full native authority now.** Total SENAITE footprint is
   two sites (receive-flow write `main.py:13695`, lookup read `main.py:12527`);
   COABuilder/IS never read Remarks. Implement natively, backfill once, delete
   the SENAITE write.
4. **Parent-AR attachments: native record + dual-write.** COABuilder builds the
   COA PDF from the AR's `Attachment` list (`senaite_client.py:320-356`), so
   the SENAITE upload stays until the COABuilder re-wire (program section 5).
   Mk1 gains the native record and serves reads from it.
5. **Packaging: stacked PRs on one program branch** (`feat/parent-ar-read-flip`),
   per-layer tests, one registry-stack UAT at the end. Default read source
   stays `senaite`; the flip is a Handler Preferences change after parity
   eyeball, page by page — same rollout as samples-list/inbox.

## 3. Goals

1. `/registry/sample/{id}/details` (`mk1` mode) assembled 100% from Mk1
   tables + the IS DB (already-direct connection) — no SENAITE HTTP.
2. Method/instrument, internal remarks fully native-authoritative; parent-AR
   attachments natively recorded (dual-write to SENAITE for COABuilder only).
3. `field_sources` stays honest per field; `senaite` mode byte-compatible
   with today (fallback path unchanged until the Handler flips).
4. A reconcile rider replacing the drift-observer coverage that the retired
   display fetch provided.

## 4. Non-goals (later, separately-gated)

- No workflow authority changes (publish/verify still SENAITE; that's the
  shadow-engine → authority-flip track).
- No COABuilder changes; no SENAITE attachment-upload removal (section 5).
- No worksheets work (worksheet objects are already native; the inbox
  read-source shipped in 1.4.0 and flips independently).
- No removal of `senaite`-mode code paths — they retire only after the flip
  has soaked and the Handler says so.
- Registry-debug compare panel keeps reading SENAITE **by design** (it is the
  drift detector).
- `/wizard/senaite/attachment/{uid}` + `/report/{uid}` binary proxies stay —
  legacy attachment/report bytes live in SENAITE's ZODB; per-click cost only.

## 5. Layer 1 — method/instrument native-authoritative

**Ownership rule (the load-bearing change):** `lims_analyses.method_id` /
`instrument_id` become **Mk1-owned columns on every row, including
provenance='shadow'** — the slice-2 mirror hooks and
`backfill_parent_analysis_shadows.py` stop writing them (precedent:
`AnalysisService.variance_capable`, "preserved across SENAITE re-sync").
Without this, the Layer-4 reconcile rider would clobber native M/I edits back
to SENAITE's None.

- Native write path already exists and stays: vial picker + prep-bridge
  auto-stamp (fill-only-NULL) + `promote_to_parent(method_id, instrument_id)`
  → all via `service.set_method_instrument` (audited).
- FE editor: **no FE or model change needed.** `api.ts
  setAnalysisMethodInstrument` (Phase 3.6, shipped) already routes analysis
  uids of the form `mk1:<lims_analyses.id>` to the native PATCH with
  int-as-string option uids, and real SENAITE uids to the proxy. The Layer-4
  builder emits `mk1:<id>` uids + native option lists in the existing
  `{uid, title}` shape (`service.py:2017` precedent) and the routing follows.
  `senaite` mode keeps the existing UID proxy
  (`POST /wizard/senaite/analyses/{uid}/method-instrument`) untouched.
- The A4 SENAITE→shadow M/I mirror pass-through is removed **in this layer**
  (it is exactly the write the ownership rule forbids); the proxy keeps
  updating SENAITE only. Post-flip retirement (follow-up, not this slice):
  delete the proxy endpoint itself.
- No backfill: historical shadow M/I stays NULL — faithful, since SENAITE
  never held meaningful values (verified: nothing reads them).
- **Retest supersession blanks current-row M/I — by design.** A SENAITE-driven
  retest makes the mirror create a NEW current row (`method_id`/`instrument_id`
  NULL); natively-set M/I stays on the superseded row and does not carry
  forward. Correct lab semantics (a retest may run on different equipment);
  the analyst re-picks. The Layer-4 builder's analyses field-source row must
  note this: blank M/I after a SENAITE-side retest is expected, not drift.

## 6. Layer 2 — internal remarks native-authoritative

**Schema:** `lims_sample_remarks` (additive, `lims_` prefix, idempotent DDL):

    id, lims_sample_pk (FK lims_samples ON DELETE CASCADE),
    content TEXT NOT NULL,            -- HTML, matching SenaiteRemark.content
    author_user_id (FK users, NULL),  -- Mk1-era rows
    author_label TEXT NULL,           -- backfilled SENAITE user_id string
    created_at TIMESTAMP NOT NULL

A table, not a column: remarks are an append-only list with authorship and
timestamps (`SenaiteRemark {content, user_id, created}`).

- **Write flip:** the receive flow inserts natively; the SENAITE
  `update/{uid} {"Remarks": ...}` step (`main.py:13695`) is **deleted** in the
  same PR (no dual-write era — nothing else reads SENAITE Remarks).
- **Backfill:** one-time script, house shape (idempotent, `--dry-run`,
  checkpoint, throttled — one SENAITE query per sample with remarks, or ride
  the existing per-parent fetch pattern from the slice-2 backfill). Maps
  SENAITE `{content, user_id, created}` → `{content, author_label, created_at}`.
  Idempotency key: `(lims_sample_pk, created_at, md5(content))`.
- **Read:** both modes of the details endpoint serve native remarks once
  backfilled (`field_sources["remarks"]="mk1"` unconditionally — SENAITE's
  copy goes stale by design the moment the write flips). The receive-wizard
  remark entry keeps working unchanged from the user's perspective.
- Ordering note: the write flip and the backfill land in the same deploy
  window (write-flip first ⇒ new remarks native; backfill sweeps history;
  re-run backfill after to catch the gap window — idempotent).
- Third write site (closed at final review, 2026-07-14): the generic
  `POST /wizard/senaite/samples/{uid}/update` endpoint (`update_senaite_sample_fields`)
  also carries `Remarks` from both remark-entry forms — it now intercepts
  and pops `Remarks` before forwarding, writing it natively instead of
  reaching SENAITE.

## 7. Layer 3 — parent-AR attachments: native record + dual-write

**Schema:** `lims_parent_attachments` (additive):

    id, lims_sample_pk (FK lims_samples ON DELETE CASCADE),
    kind TEXT CHECK IN ('vial_image','packaging_image','manual'),
    source_sub_sample_pk (FK lims_sub_samples, NULL),  -- vial_image lineage
    filename TEXT, content_type TEXT,
    storage TEXT CHECK IN ('s3','senaite'),   -- where the bytes live
    storage_key TEXT NULL,                     -- S3 key when storage='s3'
    senaite_attachment_uid TEXT NULL,          -- dual-write linkage
    render_in_report BOOLEAN NOT NULL DEFAULT FALSE,
    created_by_user_id (FK users, NULL), created_at TIMESTAMP NOT NULL

- **Dual-write:** Select-Vial-Image and the receive-flow AR image upload keep
  posting to SENAITE (COABuilder dependency) AND insert a native row with the
  returned attachment uid. This also closes the lightbox follow-up (Mk1 keeps
  no record of Select-Vial-Image uploads — now it does, with actor+timestamp).
- **Backfill:** one-time sweep of AR `Attachment` lists → native rows with
  `storage='senaite'` (bytes stay in ZODB, served via the existing proxy).
  New-era rows whose bytes exist natively (vial/packaging photos in S3) point
  at S3 and never touch the proxy.
- **Read:** the builder assembles `attachments` from this table;
  `download_url` routes to the native photo endpoints for `storage='s3'` rows
  and to the existing `/wizard/senaite/attachment/{uid}` proxy for legacy rows.
- Deletion semantics: native row is the record — delete hard-deletes the
  native row, then best-effort deletes the SENAITE copy (failure logged,
  non-fatal; an orphaned SENAITE copy is acceptable mirror-era noise and
  shows up in the parity eyeball, never in mk1-mode reads).

## 8. Layer 4 — native details builder

New module `backend/sub_samples/registry_details.py` (mirrors the
`registry_inbox.py` idiom): `build_native_details(db, sample_id) ->
RegistrySampleReadResult`. The endpoint's `mk1` branch calls it and **never
touches SENAITE**; `senaite` mode keeps the current wrap-and-overlay behavior
verbatim — with one deliberate exception: `remarks` is served native in BOTH
modes (Layer 2 is an authority flip, not a read-source option; SENAITE's copy
is stale by design once the write flips).

Field-source matrix (the response shape is `SenaiteLookupResult`):

| Field(s) | Native source |
|---|---|
| sample_id/uid, client, contact, sample_type, dates, client_order_number, client_sample_id, client_lot, declared_weight_mg, profiles | `lims_samples` (basic-info registry — already the overlay set) |
| review_state | `lims_samples.status` (slice-3 mirrored + healed) |
| analytes | `lims_samples.analytes` JSON → typed `SenaiteAnalyte` adapter (the shape mismatch that blocked the old overlay gets a real adapter; verify field-by-field at build) |
| analyses | parent-tier `lims_analyses` (native rows: `review_state`; shadow rows: `mirror_review_state`), result/unit from the row, method/instrument **names via FK joins** (Layer 1), analyst via `users`, result_options + service-group enrichment from `analysis_services` (already native) |
| remarks | `lims_sample_remarks` (Layer 2) |
| attachments | `lims_parent_attachments` (Layer 3) |
| coa (COA info block), published_coa | IS DB `coa_generations` (Mk1 already queries the IS DB directly — v1.1.1 verification-code pattern); `download_url` via the existing report proxy for SENAITE-era reports, IS/S3 URL for native-era |
| senaite_url | constructed from `SENAITE_URL` + client/sample path fields on `lims_samples` (link-out stays useful mirror-era) |
| cached_at | now() — no cache in the native path (DB reads are cheap) |

**Analyses-row selection** must reuse the slice-2 read idiom (newest
non-retested line per keyword, retest supersession, `retested=False` current
row) — the exact bug class the slice-2 audit fixed three leaks of; the
builder imports the shared helper rather than re-deriving it.

**Reconcile rider:** flipping retires the display fetch the passive drift
observer piggybacks on. Compensator: scheduled in-backend job (same pattern as
the IS-sync tick) running `backfill_parent_analysis_shadows.py`'s reconcile
core on a nightly cadence, throttled, env-gated
(`MK1_PARENT_MIRROR_RECONCILE_ENABLED`, default on in stacks, Handler call at
prod deploy) — it already skips M/I per Layer 1's ownership rule. SENAITE-side
sample-status capture is unaffected (IS event stream, slice 3).

**Two-tier wiring:** page key `sample_details` in the existing DataSourcePane +
per-page settings; `lookupSenaiteSample(source)` already routes — the five
consumer pages + `senaite-lookup-map` service pick up the setting exactly like
the samples-list flip did. Default `senaite`.

## 9. Invariants and error handling

1. `senaite` mode responses byte-compatible with today (regression-gated),
   with exactly one carve-out: `remarks` comes from the native table in both
   modes (Layer 2 authority flip). M/I in senaite mode is untouched (proxy
   and UID option lists unchanged until post-flip retirement).
2. `mk1` mode performs zero SENAITE HTTP — enforced by test (SENAITE client
   mocked to raise; builder must succeed).
3. All schema additive (`lims_` prefix, idempotent DDL, monotonic CHECKs only
   — last-boot-wins lesson from slice 3).
4. Backfills idempotent + `--dry-run` + checkpointed (house shape).
5. Dual-write attachment failures: SENAITE upload failure keeps today's
   user-visible error behavior (COA dependency = fail loud); native-row
   insert failure after SENAITE success is logged + reconciled by the
   attachment backfill's idempotent re-run (never blocks the upload response).
6. Builder never raises for missing sub-resources — empty lists + honest
   `field_sources`, `registry_missing=True` when the `lims_samples` row is
   absent (unchanged semantics).

## 10. Testing

House pattern (live dev DB, TEST-prefixed rows, failure-set gate vs base):

- Layer 1: ownership rule (mirror + backfill leave M/I untouched — regression
  test on the backfill's update path), native PATCH in mk1 mode, senaite mode
  untouched.
- Layer 2: receive inserts native row + no SENAITE call (mock asserts zero
  HTTP), backfill dry-run/idempotency/mapping, lookup serves native remarks.
- Layer 3: dual-write linkage (uid captured), backfill sweep idempotency,
  download_url routing (s3 vs proxy), delete semantics.
- Layer 4: field-source matrix per field (golden-sample fixtures), zero-
  SENAITE enforcement, analyses selection parity vs the slice-2 shared helper
  (retest/supersession cases), analytes adapter shape, senaite-mode byte-
  compatibility, reconcile-rider tick (extends the sync-tick house tests).
- FE: lookup-source routing (extends `lookup-source.test.ts`), AnalysisTable
  M/I editor mk1-mode payload, DataSourcePane row.
- **Parity harness for the eyeball:** a small script that fetches both modes
  for N real samples and diffs field-by-field (the flip-readiness artifact —
  same role the divergence summary plays for the shadow engine).

## 11. Rollback

Everything additive + default-`senaite`. Rollback = flip the setting back
(instant, per page); image revert safe in either order. The only
deliberately irreversible piece is the remarks write-flip (SENAITE Remarks
goes stale from deploy) — acceptable because nothing reads it and the native
table is backfilled; a re-export script to SENAITE is trivial if ever needed.

## 12. ISO 17025 alignment

(Program posture: not accredited, aligning to pursue.)

- **Records (§7.5):** remarks and attachments gain attributable, time-stamped
  native records (author, created_at) — today's SENAITE remarks are a blob
  with a login string; attachment provenance (who selected the COA vial
  image, when) becomes recorded fact (closes the lightbox metadata gap).
- **Data integrity / traceability (§7.11):** the details view moves onto the
  system of record that survives SENAITE retirement; `field_sources` gives
  per-field provenance; the parity harness is documented verification
  evidence for the read cutover (change-control story).
- **Equipment records (§6.4):** M/I on analyses now always reference the
  native `instruments`/`hplc_methods` entities (single registry, audited
  assignment transitions) instead of unused SENAITE UIDs.

## 13. Follow-ups (out of slice)

- Post-flip retirements: SENAITE M/I proxy endpoint + A4 M/I mirror hook;
  `senaite`-mode lookup path itself once soaked (Handler-gated).
- COABuilder re-wire (section 5) → then delete the attachment SENAITE
  dual-write + the receive-flow AR image upload.
- Shadow engine (next slice, spec 2026-07-13) — burns in on the flipped
  mirror.
- Method/instrument on *shadow* history: stays NULL; if the lab ever wants
  historical M/I display, derive from vial-tier lineage via promotions —
  display-only, deliberately unbuilt now.
- `/wizard/senaite/lookup` residual consumers audit at retirement time
  (anything still calling it in senaite mode).
