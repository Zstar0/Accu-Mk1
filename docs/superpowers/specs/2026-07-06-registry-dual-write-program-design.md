---
title: "Registry dual-write program — Mk1 as the sample record of reads (Slice 1: complete the copy + own creation)"
date: 2026-07-06
status: draft
authors: [ZeroSignal, forrestp]
---

# Registry dual-write program

## Summary

Evolve `lims_samples` from a *complete basic-info mirror* (the 2026-07-02 canonical basic-info slice, shipped in PRs #42/#43) into the **complete sample record Mk1 reads from**, under a **dual-write, migrating-reads** model:

- **Every write path writes both stores.** Order creation (IS) writes Mk1 and SENAITE; Mk1's existing field-edit paths add a local write beside the SENAITE call they already make. No sync engine — freshness by construction.
- **Reads migrate to Mk1 one consumer at a time** (samples list/lookup/inboxes, then corrections, then COABuilder metadata). SENAITE stays fully written and functional throughout; it just carries less read traffic until, line by line, the native cutover stops its writes too.
- **Status is the deliberate exception:** SENAITE authors `review_state` until a testing line goes native. Mk1 mirrors it (existing reconcile + the Slice-2 merge query). A richer Mk1-native lifecycle is a later decision, after we own the workflows.

**Why this program (the pains it kills):** the samples page takes ~10 s because it hits SENAITE with `complete=yes` per page; and post-verification corrections are locked behind SENAITE's guards, so staff escalate to the Handler for ZODB force-scripts. Read-from-Mk1 fixes the first directly and dissolves the second: a correction only *needs* to land where readers read.

## Program map (four slices; this spec fully defines Slice 1)

| Slice | Delivers | Depends on |
|---|---|---|
| **1 — Complete the copy + own creation** (this spec) | All missing columns; native IDs; IS creation signal; dual-write at existing edit sites; backfill re-sweep | Registry slice in prod (Mk1 1.0.25 + backfill) |
| **2 — Samples page cutover** | List/lookup/inboxes serve from Postgres + one light `uid+review_state` SENAITE merge query (freshness + new-sample safety net). Kills the 10 s page | Slice 1 |
| **3 — Corrections** | Permissioned Mk1 edit UI over canonical fields; audit trail (ISO 7.5.2/8.4); best-effort SENAITE write-through with drift flag; corrections on COA-issued samples flag the COA for regeneration | Slice 1 (independent of 2) |
| **4 — COABuilder metadata cutover** | COABuilder reads sample metadata (contacts, analytes, declared, branding, verification code) from Mk1 S2S; **results stay SENAITE-read** | Slice 1; benefits from 3 |

Later horizons, explicitly not in this program: status/workflow ownership (arrives per-line with the Test-Catalog native cutover), results canonical-ization, SENAITE retirement.

## Decisions locked (2026-07-06, Handler)

1. **Dual-write, migrating reads.** SENAITE keeps being written; no freeze, no bidirectional sync.
2. **Status: mirror SENAITE states to start**; vocabulary/ownership evolve later to fit lab workflows.
3. **Native IDs are internal-only and forward-only.** Customers keep seeing `P-xxxx` until a line is SENAITE-free. No retro-mint (nullable column; a later one-time script may retro-mint if ISO coverage ever wants it).
4. **Creation signal fires after SENAITE AR creation**, carrying both ids in one call. Rationale: `sample_id` is the registry's natural key; minting rows before SENAITE assigns `P-xxxx` and re-keying seconds later buys nothing. The endpoint accepts a missing SENAITE id so future SENAITE-free lines use the same contract with `sample_id = native_id`.
5. **`Coa*` custom fields land as one JSON map (`coa_meta`)**, not individual columns — COABuilder consumes the map in Slice 4; no schema churn per field.
6. **Corrections strategy** (Slice 3, recorded now): Mk1 edit + audit; SENAITE write-through best-effort; SENAITE refusal = logged drift flag, never a blocker. The force-script era ends because nothing user-facing reads the refused copy.

## Slice 1 — Scope

**In:**
- New nullable columns on `lims_samples` (below) + `lims_native_id_sequences` table.
- `_populate_basic_info` extended to the full field set (all writers — lazy first-touch, refresh/reconcile, backfill, creation signal — stay identical by construction).
- Native-ID minting.
- IS → Mk1 creation signal (new S2S endpoint + IS-side call after AR creation).
- Dual-write added to Mk1's existing field-edit paths.
- Backfill re-sweep to fill the new columns across history.

**Out (later slices / explicitly not now):** any reader flips; correction UI; COABuilder changes; status semantics; analyses/results; retro-minting; WP-side anything.

## Data model (all additive; Mk1 idempotent-ALTER path; no NOT NULL on existing rows)

### New columns on `lims_samples`

| Column | Type | Source (complete=true payload / IS signal) | Notes |
|---|---|---|---|
| `client_title` | String(200) | `getClientTitle` / IS client block | display name (page prefers over slug) |
| `contact_title` | String(200) | `Contact` dict title (key shape: plan-verify) / IS | |
| `contact_email` | String(320) | contact record (plan-verify key) / IS | COA-serving |
| `sample_type_title` | String(200) | `getSampleTypeTitle` (plan-verify on detail payload) / IS | existing `sample_type` stays the **UID** — load-bearing for secondary creation; do not repurpose |
| `date_created` | DateTime | `created` (ISO-parse, naive UTC) | AR creation time; distinct from row `created_at` |
| `verification_code` | String(50) | `VerificationCode` | XXXX-XXXX format |
| `client_order_number` | String(100) | `ClientOrderNumber` / order | search target |
| `analytes` | Text (JSON) | `Analyte1..8Peptide` + `Analyte1..8DeclaredQuantity` | ordered list of `{"name": str, "declared_quantity": str\|null}`; slots preserved; empty slots omitted. `peptide_name` stays = slot-1 label (back-compat) |
| `declared_total_quantity` | String(50) | `DeclaredTotalQuantity` | keep as string (SENAITE stores freeform) |
| `client_lot` | String(100) | `ClientLot` | |
| `client_reference` | String(200) | `ClientReference` | |
| `company_logo_url` | Text | `CompanyLogoUrl` | COA-serving |
| `coa_meta` | Text (JSON) | all `Coa*` custom fields, verbatim map | enumerate exact field names from a live payload at plan time |
| `native_id` | String(20), unique, nullable | minted by Mk1 | internal-only; see minting |

### Native-ID minting

- New table **`lims_native_id_sequences`** (`prefix` String PK, `next_value` Integer) — `lims_` prefix per house rule.
- Allocation under `SELECT … FOR UPDATE` on the prefix row (same idiom as vial-sequence assignment); format `a{PREFIX}-{NNNN}` zero-padded to 4, growing naturally past 9999.
- **Prefix derivation:** from the SENAITE id's own prefix at signal time (`P-1234` → `aP`, `PB-` → `aPB`, `BW-` → `aBW`) — zero configuration for the SENAITE-attached world. A sample-type→prefix map becomes necessary only for SENAITE-free lines (1F concern; the map slots in without schema change).
- Minted exactly once per row (idempotent signal never re-mints); never reused; never exposed customer-facing in this program.

## The IS → Mk1 creation signal

**Endpoint:** `POST` on a new Mk1 server-to-server route (e.g. `/s2s/lims-samples`), **not** reachable via browser/customer auth. Auth: service-to-service using the existing shared-secret infrastructure (`JWT_SECRET` is already identical across IS/Mk1/COABuilder — exact token mechanics are a plan detail; requirement is: IS-only, no user session).

**When:** IS calls once per sample, immediately after it creates the SENAITE AR in order processing — so the payload carries **both** the SENAITE `sample_id`/`uid` and the full composition IS just authored the AR from.

**Payload (per sample):** order number; client block (title, id-slug, uid); contact block (title, email, uid); SENAITE sample id + uid; sample type (uid + title); client sample id; dates (created/sampled; received null at creation); analyte slots 1–8 (name + declared quantity); declared total; lot; reference; `Coa*` map; company logo url; verification code.

**Mk1 behavior:** upsert keyed on `sample_id` — create (mint `native_id`, apply the `container_mode` first-touch gate exactly as `_create_sample_row` does today — at creation time the state is pre-received, so new rows are container families, consistent with the wizard) or update (fill/refresh fields; `native_id` untouched). Returns the row's ids.

**Failure handling:** the signal is best-effort from IS's perspective — a failed call logs + does **not** fail order processing; the sample is caught later by the existing lazy first-touch / reconcile / backfill machinery (which after this slice writes the identical full field set). Signal retries are safe (idempotent upsert).

**SENAITE-free future:** same endpoint, SENAITE id absent → `sample_id = native_id`, `external_lims_uid` null, `external_lims_system = "mk1"`. Nothing else changes. This is deliberately the 1F on-ramp.

## Dual-write at existing edit sites

Every Mk1 code path that currently updates sample fields in SENAITE (the sample-detail field-update UI and any sibling paths — enumerated at plan time) gains a same-transaction local write of the corresponding registry column(s). SENAITE call semantics unchanged. This keeps the copy fresh for fields edited post-creation without any new sync event.

## Freshness model after Slice 1

| Field class | Freshness mechanism |
|---|---|
| Creation-time data (identity, composition, COA-serving) | Written first-hand by the signal + dual-write edits — fresh by construction |
| `status` (review_state) | Follower: existing 5-min reconcile refresh; Slice 2 adds the light merge query for the list page |
| Everything, as safety net | Existing reconcile refresh + idempotent backfill re-sweep (drift detector, not the mechanism) |

## Backfill re-sweep

The existing script gains nothing structurally: `_populate_basic_info`'s extension means a re-run (delete checkpoint first) fills all new columns across history — the rehearsed `created 0, updated N` gap-fill. `native_id` stays NULL for historical rows (forward-only decision). One full off-hours sweep after deploy.

## ISO 17025 alignment

- **7.4.2 identification/traceability:** `native_id` gives every new sample a lab-owned identifier independent of the external LIMS; the complete local record strengthens sample traceability.
- **7.5.1 attribution:** the creation signal records the sample's origin (order, client, composition) at creation time from the authoring system, not reconstructed later.
- **7.5.2 / 8.4 traceable amendments:** deferred to Slice 3 (the correction UI's audit trail) — recorded here so the program keeps the requirement visible.
- **7.11.2 LIMS change validation:** stack rehearsal of the signal + re-sweep parity (local values == payload values) is the validation evidence; retain with the run records.

## Testing

- **Unit:** extended `_populate_basic_info` (all new fields incl. analyte pairs, JSON shapes, None-safety); native-ID allocation (prefix derivation, zero-pad, sequence isolation under concurrent mint — row-lock test); signal endpoint (create mints once, upsert never re-mints, idempotent repeat, SENAITE-id-absent form sets `sample_id = native_id`); dual-write edit sites write both stores; auth rejects non-S2S callers.
- **IS-side unit:** signal fired after AR creation with the full payload; signal failure does not fail order processing.
- **Stack rehearsal (isolated, per platform rules):** place a WP order end-to-end → row exists with native id + full fields before any Mk1 touch; backfill re-sweep fills history; list page (still SENAITE in this slice) unaffected.
- **Bulk-safety:** unchanged from the shipped backfill (already test-pinned).

## Open items (fold into the plan)

- Enumerate exact `Coa*` field names + `getSampleTypeTitle` / contact-title/email key shapes from a live detail payload (eyeball stack is up; same class as the `getClientID` catch).
- Enumerate Mk1's existing SENAITE field-edit sites for the dual-write additions.
- S2S auth mechanics (shared-secret JWT vs HMAC header — follow whatever the 1E-a S2S branch established if compatible).
- IS-side call placement in the order-processing flow + retry/timeout budget.
- Whether the signal also carries `date_received` updates later (receive-time signal) or reception stays first-touch — default: reception stays Mk1-observed (it already is, via the wizard).

## Out of scope

- Reader flips (Slices 2–4), correction UI (3), COABuilder (4).
- Status semantics/ownership; analyses/services/results; WP-side changes; retro-minting; SENAITE retirement.
