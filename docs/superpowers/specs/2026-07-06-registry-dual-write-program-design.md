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
3. **Native IDs mirror the SENAITE id's number and are retro-minted at backfill.** *(Revised 2026-07-07, supersedes the original internal-only/forward-only/no-retro-mint decision.)* `PB-0216` → `aPB-0216` (whole-id mirror, retests included), so existing samples carry a native id that lines up with what staff already know instead of a blind counter value. The prod backfill mints one for **every** row (nothing stays `native_id=∅`). A per-prefix counter exists **only** for SENAITE-free lines (which have no SENAITE number to mirror), seeded past each prefix's max SENAITE number after backfill (collision strategy (a); `native_id` `UNIQUE` is the backstop). SENAITE id stays stored (`external_lims_uid`) as the durable cross-ref in case it diverges. Still **internal-only** — customers keep seeing the SENAITE id until a line is SENAITE-free.
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

### Native-ID minting (revised 2026-07-07 — mirror-the-SENAITE-number)

> **Delta from slice 1 (dormant, so cheap to change now):** shipped `mint_native_id` uses a blind per-prefix counter for *every* mint, and the backfill leaves historical rows `native_id=∅`. This revision replaces the counter-for-linked path with SENAITE-number mirroring and makes the backfill retro-mint. None of it is in prod (nothing minted), so revising before the prod backfill costs nothing; after the backfill it would mean re-minting.

- **SENAITE-linked samples (the overwhelming majority) → mirror the number.** `native_id = "a" + <full SENAITE id>`: `PB-0216` → `aPB-0216`, retests included (`PB-0216-R01` → `aPB-0216-R01`). Deterministic, no counter draw, and unique because SENAITE ids are unique. (`-S\d+` secondaries are sub-samples, not parents — excluded from minting entirely, as today.)
- **SENAITE-free samples (future 1F native lines) → counter.** New table **`lims_native_id_sequences`** (`prefix` String PK, `next_value` Integer, `lims_` house prefix). Allocation under `SELECT … FOR UPDATE` on the prefix row (vial-sequence idiom); format `a{PREFIX}-{NNNN}` zero-padded to 4, growing past 9999. Prefix from a sample-type→prefix map (these lines have no SENAITE id to derive from).
- **Retro-mint at backfill.** The prod backfill mints `native_id` for **every** row it touches (mirror-derived), so the whole back-catalog lines up (`aPB-0216`) and nothing stays `∅`.
- **Collision strategy (a) — seed the counter past SENAITE.** After the backfill, seed each prefix's `next_value` to `max(mirrored SENAITE number for that prefix) + 1`. Note the sample-type map deliberately reuses `aP/aPB/aBW` — the same prefixes SENAITE mirrors — so the counter and the mirror are **not** disjoint by prefix; safety does NOT rest on a one-issuer-per-prefix invariant (an earlier draft claimed this; it was false). During the dual-write transition the counter simply never *draws* those prefixes in practice: every sample originates from a SENAITE AR and is mirror-minted, so no SENAITE-free line requests `aP/aPB/aBW`. The real backstops are (1) `native_id`'s `UNIQUE` constraint — any accidental overlap raises IntegrityError (loud), never a silent duplicate, and the counter path retries-and-bumps on conflict; and (2) **re-seeding the counter at each per-type cutover** — when a line's type goes SENAITE-free and SENAITE stops issuing that prefix, re-seed the counter to `max(existing native number for that prefix) + 1` at that moment, because the backfill-time seed is a stale snapshot the instant SENAITE issues the next id. The seed only becomes load-bearing at that cutover.
- **SENAITE id stays the cross-ref** (`external_lims_uid` + `sample_id`) so if SENAITE ever reissues/diverges, `native_id` remains the stable anchor.
- Minted **once per row**; never re-minted (idempotent signal/backfill leave an existing `native_id` untouched); never reused; internal-only in this program.

## The IS → Mk1 creation signal

**Endpoint:** `POST` on a new Mk1 server-to-server route (e.g. `/s2s/lims-samples`), **not** reachable via browser/customer auth. Auth: service-to-service using the existing shared-secret infrastructure (`JWT_SECRET` is already identical across IS/Mk1/COABuilder — exact token mechanics are a plan detail; requirement is: IS-only, no user session).

**When:** IS calls once per sample, immediately after it creates the SENAITE AR in order processing — so the payload carries **both** the SENAITE `sample_id`/`uid` and the full composition IS just authored the AR from.

**Payload (per sample):** order number; client block (title, uid — title derived from the WP order's customer email, same transform as SENAITE client resolution); contact block (full name from WP billing, email, uid); SENAITE sample id + uid; sample type uid; client sample id; dates (created = signal time; sampled from order; received null at creation); analyte slots 1–8 (name + declared quantity); declared total; lot; reference; `Coa*` map; company logo url; verification code. *(Amended 2026-07-07 post-build: the client id-slug and sample-type TITLE are not cleanly in IS scope — they are reconcile-filled from SENAITE on first family view / re-sweep; Slice 2 must treat them as nullable.)*

**Mk1 behavior:** upsert keyed on `sample_id` — create (mint `native_id` — mirror-derived from the SENAITE id, see Native-ID minting — apply the `container_mode` first-touch gate exactly as `_create_sample_row` does today — at creation time the state is pre-received, so new rows are container families, consistent with the wizard) or update (fill/refresh fields; `native_id` untouched). Returns the row's ids.

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

The existing script gains nothing structurally for the columns: `_populate_basic_info`'s extension means a re-run (delete checkpoint first) fills all new columns across history — the rehearsed `created 0, updated N` gap-fill. **New in the 2026-07-07 revision:** the backfill also **mints `native_id` for every row** (mirror-derived from the SENAITE id — see Native-ID minting), then **seeds each prefix counter** to `max(SENAITE number) + 1`. One full off-hours sweep after deploy.

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
