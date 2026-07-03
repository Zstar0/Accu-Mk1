---
title: "LimsSample as the canonical basic-info registry (SENAITE-independent sample metadata)"
date: 2026-07-02
revised: 2026-07-03 (rev 2 — post-review: read-surface corrected, refresh wiring added)
status: draft
authors: [ZeroSignal, forrestp]
---

# LimsSample as the canonical basic-info registry

## Summary

Turn `lims_samples` (`LimsSample`) from a lazy, partial **cache** of SENAITE sample metadata into a **complete, canonical local registry** of each sample's *basic info* (client, sample type, client sample id, dates, peptide name, status), as deliberate SENAITE phase-out groundwork — the model was designed for it ("Designed to become the canonical sample registry once SENAITE is sunset, hence the neutral `external_lims_*` columns", `models.py:724-726`).

Three parts: (1) **consolidate population** so create/refresh/backfill all write the identical full basic-info set; (2) a **backfill script** that enumerates *all* SENAITE samples and populates the local registry (paged, throttled, resumable — never a bulk hammer); (3) **wire the full basic-info refresh into the existing 5-minute reconcile path** so registry rows are genuinely eventually-consistent instead of frozen at first-touch.

**What this slice does NOT do (honest scoping, rev 2):** no live SENAITE *read* moves off SENAITE yet. The app's real live basic-info read surface is in `main.py` (samples list / lookup / inboxes — see "Follow-up read surface" below); cutting those over to the registry is the *next* slice, enabled by this one. Rev 1 framed this slice as "cut the 3 `fetch_parent_metadata` read sites" — review found those 3 sites aren't cuttable reads (two are the registry's own writers; one reads non-basic-info inheritance fields feeding a SENAITE write).

**No schema change** — every column already exists. **Additive** — SENAITE stays authoritative for *edits*; this slice completes + localizes the *data* so future slices can localize the reads.

## Scope

**In:**
- The **basic-info field set** (see below): `external_lims_uid`/`external_lims_system`, `client_id`, `client_uid`, `contact_uid`, `sample_type`, `client_sample_id`, `peptide_name`, `date_received`, `date_sampled`, `status`.
- Complete population going forward + a one-time **backfill** of all existing samples.
- **Refresh wiring:** `_refresh_parent_from_senaite` extended to the full field set (via the consolidated helper) and invoked from the existing `_reconcile_from_senaite` 5-minute staleness path — an existing trigger, no new refresh event.

**Out (explicitly — separate efforts):**
- **The main.py read cutover** (samples list / lookup / inboxes — the actual live-read surface; see below). Next slice, enabled by this one.
- **Services / analyses composition** (`fetch_sample_services`, `fetch_parent_analysis_keywords`) and **results** (`fetch_results_by_keyword`) — a different canonical-ization; these stay SENAITE-read.
- **Native / sterility parent minting** (parked; there are no SENAITE-free samples today — sterility is always an HPLC addon, so every parent already has a SENAITE id).
- **SENAITE becoming read-only / moving edits to Mk1.** SENAITE remains the edit surface for basic info this slice.
- Schema changes (none needed).

## Current state (grounded in code, re-verified 2026-07-03)

- `ensure_sample_row(db, parent_sample_id)` (`sub_samples/service.py:48`) is a **lazy first-touch upsert**: it creates the `LimsSample` row only when something touches the sample (a vial op), populating from a live `senaite.fetch_parent_metadata()`. Untouched / pre-sub-samples samples have **no row**. It does **not** set `date_received`/`date_sampled`.
- `_refresh_parent_from_senaite` (`service.py:115`) refreshes only a **subset** (`external_lims_uid`, `client_uid`, `contact_uid`, `sample_type`, `status`) — it misses `client_id`, `client_sample_id`, `peptide_name`, and the dates. **It fires at exactly one call site** (`service.py:271`): the legacy create path's stale-UID repair, i.e. only when `uid_exists` fails. In practice an existing row's basic info almost never refreshes.
- `_reconcile_from_senaite` (`service.py:447`, triggered by `list_sub_samples` when `last_synced_at` exceeds the 5-minute `CACHE_FRESHNESS`) reconciles **sub-sample membership only** — it does not refresh parent basic info today.
- The three `fetch_parent_metadata` call sites (`service.py:61`, `:117`, `:291`) are **not** three cuttable reads: `:61` *is* the lazy-populate write, `:117` *is* the refresh helper, and `:291` reads **non-basic-info** `INHERITABLE_FIELDS` (`senaite.py:372` — ClientOrderNumber, Profiles, DeclaredTotalQuantity, the 8 analyte slots, Coa\*, …) to copy onto a SENAITE secondary. `:291` stays a live read: it serves a SENAITE *write* (legacy dual-write path) and dies with native routing anyway.

### Follow-up read surface (NOT this slice — the next one)

The live basic-info reads a future cutover slice will move to the registry are in `main.py`:
- `lookup_senaite_sample` (`main.py:12005`)
- `list_senaite_samples` (`main.py:12833`)
- `get_worksheets_inbox` (`main.py:14726`) + `_build_native_vial_inbox_items` (`main.py:14610`)

These build responses directly from live SENAITE items (`client_id`, `date_received`, `client_sample_id`, `sample_type` at ~12561, 12911, 14698, 15373). Their blockers today are exactly what this slice fixes: missing/partial rows and no freshness story (list/inbox need current `status`).

## The canonical basic-info field set + source

| `LimsSample` column | SENAITE source (`fetch_parent_metadata` meta) | Notes |
|---|---|---|
| `external_lims_uid` | `uid` | SENAITE UID (linkage) |
| `external_lims_system` | (literal `"senaite"`) | native discriminator hook for the future |
| `client_id` | `ClientID` | |
| `client_uid` | `ClientUID` / `Client` (uid-extracted) | |
| `contact_uid` | `ContactUID` / `Contact` (uid-extracted) | |
| `sample_type` | `SampleType` (uid-extracted) | |
| `client_sample_id` | `ClientSampleID` | **the one real drift source** (edited in SENAITE — Replace-Analyte case) |
| `peptide_name` | `Analyte1Peptide` (label-extracted) | display label; NULL for non-peptide |
| `date_received` | `DateReceived` | **already in the payload** — `fetch_parent_metadata` returns the raw `complete=true` item wholesale (`senaite.py:237-258`); needs ISO-string → DateTime parsing |
| `date_sampled` | `DateSampled` | same — parsing, not fetching, is the work |
| `status` | `review_state` | snapshot semantics — see drift |

`is_retest` (`models.py:743`) is **deliberately out**: nothing writes or consumes it today (the `is_retest` hits in `main.py` are `order_samples`, a different table); sourcing it (SENAITE `RetestOf` vs order flow) is not this slice's problem.

## Design

### 1. Consolidate population into one helper
Introduce `_populate_basic_info(row: LimsSample, meta: dict) -> None` that writes the **full** field set above from a `fetch_parent_metadata` payload. It owns all SENAITE→local normalization: uid-extraction (`_extract_uid`), label-extraction (`_extract_label`), and **date parsing** (SENAITE ISO-8601 strings with TZ offset → naive UTC DateTime, matching the columns' `datetime.utcnow()` convention; None-safe). Refactor **all three** writers to use it:
- `ensure_sample_row` (create path) → `_populate_basic_info` (now also sets the dates it currently omits).
- `_refresh_parent_from_senaite` (refresh path) → `_populate_basic_info` (now refreshes the full set, not the 5-field subset).
- The backfill script (below) → `_populate_basic_info`.

This guarantees create, refresh, and backfill produce identical, complete rows — closing the "partial row" gap and making the field set defined in exactly one place. `container_mode` / `assignment_role` / variance fields are **not** basic info and stay owned by their existing logic (do not fold them in).

### 2. Backfill script — enumerate all SENAITE samples (paged, throttled, resumable)
A management command (`backend/scripts/backfill_lims_sample_basic_info.py`) that:
1. **Enumerates all SENAITE samples** via the jsonapi search for `portal_type=AnalysisRequest`, **paged** (e.g. `b_size` batches with `b_start` cursor).
2. For each sample id: fetch meta **once** via `fetch_parent_metadata`, then create-if-missing + `_populate_basic_info` with that single payload. (Do not double-fetch: `ensure_sample_row`'s internal fetch serves the lazy path; the backfill passes `meta` explicitly.) Idempotent — re-running only fills gaps / refreshes; never duplicates.
3. **Throttles** between pages/requests and is **resumable** via a persisted checkpoint (last `b_start` / last-processed id), so an interrupted run continues rather than restarting.
4. Logs coverage (total, created, updated, skipped-complete, errors) and never aborts the whole run on one sample's error.

**Backfill = mass first-touch:** creating rows for never-touched samples fires `ensure_sample_row`'s `container_mode` state-gate en masse. Verified semantics are identical to natural first-touch (pre-received → container family, received-or-later → legacy) — the plan still carries an explicit verify step for this.

**SENAITE bulk-scan safety (load-bearing):** SENAITE runs a **single Zope core**; a bulk jsonapi sweep over the full sample set (~1,200+ ARs) can **peg it and take it down** (observed: ~15 min outage from an over-eager bulk `complete=yes` sweep). The script therefore MUST: page in modest batches, sleep between requests, cap concurrency at 1, and be runnable off-hours. This is a hard operational constraint, not a nicety.

### 3. Refresh wiring + drift strategy
Make eventual consistency real by extending **existing** triggers (no new refresh event, no per-read SENAITE calls):
- `_refresh_parent_from_senaite` → full field set via `_populate_basic_info` (rev 1 left it a 5-field subset).
- Invoke it from `_reconcile_from_senaite` — the existing 5-minute staleness path that already makes SENAITE round-trips when a family is viewed — for parents with an `external_lims_uid`. Cost: one extra GET per stale family view. Interaction with the Model-D guard (native families skip the sub-sample pull) is a plan-level detail; basic-info refresh applies only to SENAITE-linked parents.
- The rare stale-UID repair site (`service.py:271`) keeps working, now writing the full set.

**Drift:** basic info rarely changes after first-touch. The one real drift source is **`client_sample_id`** (edited in SENAITE, e.g. the Replace-Analyte flow); `status` changes throughout the workflow but with the reconcile wiring carries a concrete freshness bound: **fresh within 5 minutes of any family view**. Samples nobody views stay stale until next touch — acceptable because nothing consumes registry `status` as live today, and the main.py cutover slice must design its own freshness story for list/inbox anyway. SENAITE stays authoritative for edits; a future slice can make Mk1 the edit surface and drop the SENAITE dependency entirely — out of scope here.

## ISO 17025 alignment
- **7.4.2 identification / traceability:** a complete local sample registry is *stronger* traceability than scattered live reads — every sample's client/type/dates are recorded and versioned locally. The backfill is a one-time capture; retain the coverage log as evidence.
- **7.11.2 LIMS change validation:** backfill parity (local value == SENAITE value at backfill time) is the validation evidence; retain the backfill report + the tests.

## Testing
- **Unit:** `_populate_basic_info` writes the full field set from a mocked meta, incl. date parsing (offset ISO string → naive UTC; None/missing dates safe); the three writers all route through it; `_reconcile_from_senaite` staleness path refreshes basic info (mocked SENAITE) and respects the Model-D guard; the backfill is idempotent (re-run creates 0, updates only gaps), fetches once per sample, and paginates/throttles (assert sleep + cursor advance with a mocked client); one-sample error doesn't abort the run.
- **Live-PG (stack):** backfill a real sample → every basic-info column populated; a second backfill run is a no-op on complete rows; a stale family view refreshes basic info.
- **Bulk-safety:** assert the script's request cadence (batch size cap, inter-request sleep) so a regression can't turn it into a hammer.

## Decisions (resolved with Handler)
1. **Backfill source = enumerate ALL SENAITE samples** via a script (not just existing rows with gaps) — full coverage, incl. never-touched samples.
2. **Drift = extend the EXISTING triggers only** — full-field refresh piggybacks on the existing 5-minute reconcile path + the stale-UID repair site; no new refresh event; per-read SENAITE calls remain forbidden (defeats the purpose). *(Rev 2 supersedes rev 1's "keep implicit re-sync as-is," which rested on an overstated view of current coverage — the re-sync fires at one rare repair site only, so "as-is" meant frozen-at-first-touch.)*
3. **Scope = basic info only** — services/results canonical-ization is a separate effort; SENAITE stays the edit surface.
4. Ambition **C**, reframed *(rev 2)*: complete + backfill + refresh wiring now; the **read cutover itself moves to a follow-up slice** targeting the main.py surface (review found the 3 rev-1 "read sites" aren't cuttable reads).

## Open items (fold into the plan)
- ~~Confirm `fetch_parent_metadata` returns `DateReceived`/`DateSampled`~~ **RESOLVED**: it returns the raw `complete=true` item wholesale; the open work is the date parser + TZ normalization in `_populate_basic_info`.
- Backfill delivery form: standalone management command vs admin-gated endpoint (recommend a command runnable off-hours, given the throttle/duration).
- Exact SENAITE jsonapi search shape + page size for the enumeration (respect the bulk-scan cap).
- Model-D guard × basic-info refresh interaction detail in `_reconcile_from_senaite`.

## Out of scope
- The main.py read cutover (samples list / lookup / worksheets + vial inboxes) — next slice.
- Services/analyses + results canonical-ization.
- Native/SENAITE-free sample minting (1F concern).
- Making SENAITE read-only / relocating edits to Mk1 (future slice).
