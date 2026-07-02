---
title: "LimsSample as the canonical basic-info registry (SENAITE-independent sample metadata)"
date: 2026-07-02
status: draft
authors: [ZeroSignal, forrestp]
---

# LimsSample as the canonical basic-info registry

## Summary

Turn `lims_samples` (`LimsSample`) from a lazy, partial **cache** of SENAITE sample metadata into a **complete, canonical local registry** of each sample's *basic info* (client, sample type, client sample id, dates, peptide name, status), so Accu-Mk1 stops depending on live SENAITE reads for that data. This is deliberate SENAITE phase-out groundwork — the model was designed for it ("Designed to become the canonical sample registry once SENAITE is sunset, hence the neutral `external_lims_*` columns", `models.py:757-759`).

Three parts: (1) **consolidate population** so create/refresh/backfill all write the identical full basic-info set; (2) a **backfill script** that enumerates *all* SENAITE samples and populates the local registry (paged, throttled, resumable — never a bulk hammer); (3) **cut the 3 live `fetch_parent_metadata` basic-info read sites** over to read from `LimsSample`.

**No schema change** — every column already exists. **Additive** — SENAITE stays authoritative for *edits*; this slice only completes + localizes the *reads*.

## Scope

**In:**
- The **basic-info field set** (see below): `external_lims_uid`/`external_lims_system`, `client_id`, `client_uid`, `contact_uid`, `sample_type`, `client_sample_id`, `peptide_name`, `date_received`, `date_sampled`, `status`.
- Complete population going forward + a one-time **backfill** of all existing samples.
- Cut the **3 `fetch_parent_metadata` read sites** (`sub_samples/service.py:63`, `:119`, `:293`) to read basic info from `LimsSample`.

**Out (explicitly — separate efforts):**
- **Services / analyses composition** (`fetch_sample_services`, `fetch_parent_analysis_keywords`) and **results** (`fetch_results_by_keyword`) — a different canonical-ization; these stay SENAITE-read.
- **Native / sterility parent minting** (parked; there are no SENAITE-free samples today — sterility is always an HPLC addon, so every parent already has a SENAITE id).
- **SENAITE becoming read-only / moving edits to Mk1.** SENAITE remains the edit surface for basic info this slice; drift is handled by the existing implicit re-sync, not by relocating edits.
- Schema changes (none needed).

## Current state (grounded in code)

- `ensure_sample_row(db, parent_sample_id)` (`sub_samples/service.py:50`) is a **lazy first-touch upsert**: it creates the `LimsSample` row only when something touches the sample (a vial op), populating from a live `senaite.fetch_parent_metadata()`. Untouched / pre-sub-samples samples have **no row**.
- Population is **inconsistent across the three writers**: `ensure_sample_row` sets most fields but **not `date_received`/`date_sampled`**; `_refresh_parent_from_senaite` (`:117`) refreshes only a **subset** (`external_lims_uid`, `client_uid`, `contact_uid`, `sample_type`, `status`) — it misses `client_id`, `client_sample_id`, `peptide_name`, and the dates. So even touched rows can be partially populated / stale on the missing fields.
- Live basic-info reads = **exactly 3** `fetch_parent_metadata` call sites (`:63`, `:119`, `:293`). (The larger live-SENAITE surface — `fetch_sample_services`, `fetch_parent_analysis_keywords`, `fetch_results_by_keyword` — is services/results, out of scope.)

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
| `date_received` | `DateReceived` | **not populated today** — add to `fetch_parent_metadata` + population |
| `date_sampled` | `DateSampled` | **not populated today** — add |
| `status` | `review_state` | |

(`fetch_parent_metadata` must be extended to return `DateReceived`/`DateSampled` if it does not already.)

## Design

### 1. Consolidate population into one helper
Introduce `_populate_basic_info(row: LimsSample, meta: dict) -> None` that writes the **full** field set above from a `fetch_parent_metadata` payload. Refactor **all three** writers to use it:
- `ensure_sample_row` (create path) → `_populate_basic_info` (now also sets the dates it currently omits).
- `_refresh_parent_from_senaite` (refresh path) → `_populate_basic_info` (now refreshes the full set, not the subset).
- The backfill script (below) → `_populate_basic_info`.

This guarantees create, refresh, and backfill produce identical, complete rows — closing the "partial row" gap and making the field set defined in exactly one place. `container_mode` / `assignment_role` / variance fields are **not** basic info and stay owned by their existing logic (do not fold them in).

### 2. Backfill script — enumerate all SENAITE samples (paged, throttled, resumable)
A management command (`backend/scripts/backfill_lims_sample_basic_info.py` or an admin-gated endpoint) that:
1. **Enumerates all SENAITE samples** via the jsonapi search for `portal_type=AnalysisRequest`, **paged** (e.g. `b_size` batches with `b_start` cursor).
2. For each sample id: `ensure_sample_row` (create-if-missing) + `_populate_basic_info` from `fetch_parent_metadata`. Idempotent — re-running only fills gaps / refreshes; never duplicates.
3. **Throttles** between pages/requests and is **resumable** via a persisted checkpoint (last `b_start` / last-processed id), so an interrupted run continues rather than restarting.
4. Logs coverage (total, created, updated, skipped-complete, errors) and never aborts the whole run on one sample's error.

**SENAITE bulk-scan safety (load-bearing):** SENAITE runs a **single Zope core**; a bulk jsonapi sweep over the full sample set (~1,200+ ARs) can **peg it and take it down** (observed: ~15 min outage from an over-eager bulk `complete=yes` sweep). The script therefore MUST: page in modest batches, sleep between requests, cap concurrency at 1, and be runnable off-hours. This is a hard operational constraint, not a nicety.

### 3. Read cutover (the 3 sites) + drift strategy
Replace each `fetch_parent_metadata`-for-basic-info read with a `LimsSample` read (via `ensure_sample_row`, which now returns a complete row):
- `service.py:63` is *already* the local-first path (returns existing row) — verify it now returns a complete row post-consolidation.
- `:119` (`_refresh_parent_from_senaite`) and `:293` — assess each: if the caller needs *fresh* data it stays a refresh (SENAITE read → local write), but downstream **consumers read the local columns**, not the live `meta` dict.

**Drift:** basic info rarely changes after first-touch. The one real drift source is **`client_sample_id`** (edited in SENAITE, e.g. the Replace-Analyte flow). Strategy (per Handler decision): **keep the existing implicit re-sync spots** (`_refresh_parent_from_senaite` already fires on defined operations) — do NOT add per-read SENAITE calls (that defeats the purpose) and do NOT add a new refresh event. Local reads are **eventually-consistent**: fresh as of the last implicit re-sync. SENAITE stays authoritative for edits; the local copy catches up on the next touchpoint. (A future slice can make Mk1 the edit surface + drop the SENAITE dependency entirely — out of scope here.)

## ISO 17025 alignment
- **7.4.2 identification / traceability:** a complete local sample registry is *stronger* traceability than scattered live reads — every sample's client/type/dates are recorded and versioned locally. The backfill is a one-time capture; retain the coverage log as evidence.
- **7.11.2 LIMS change validation:** the read-cutover parity (local value == SENAITE value at backfill time) is the validation evidence; retain the backfill report + the cutover tests.

## Testing
- **Unit:** `_populate_basic_info` writes the full field set (incl. dates) from a mocked meta; the three writers all call it; the backfill is idempotent (re-run creates 0, updates only gaps) and paginates/throttles (assert sleep + cursor advance with a mocked client); one-sample error doesn't abort the run.
- **Live-PG (stack):** backfill a real sample → every basic-info column populated; a cutover read returns the local value; a second backfill run is a no-op on complete rows.
- **Bulk-safety:** assert the script's request cadence (batch size cap, inter-request sleep) so a regression can't turn it into a hammer.

## Decisions (resolved with Handler)
1. **Backfill source = enumerate ALL SENAITE samples** via a script (not just existing rows with gaps) — full coverage, incl. never-touched samples.
2. **Drift = keep the existing implicit re-sync spots** — no new refresh event; local reads eventually-consistent; SENAITE still edits.
3. **Scope = basic info only** — services/results canonical-ization is a separate effort; SENAITE stays the edit surface.
4. Ambition **C** (full basic-info canonical-ization now: complete + backfill + cut the 3 reads) — tractable because the basic-info read surface is only 3 sites.

## Open items (fold into the plan)
- Confirm `fetch_parent_metadata` returns `DateReceived`/`DateSampled` (extend it if not).
- Backfill delivery form: standalone management command vs admin-gated endpoint (recommend a command runnable off-hours, given the throttle/duration).
- Exact SENAITE jsonapi search shape + page size for the enumeration (respect the bulk-scan cap).

## Out of scope
- Services/analyses + results canonical-ization.
- Native/SENAITE-free sample minting (1F concern).
- Making SENAITE read-only / relocating edits to Mk1 (future slice).
