# Order-sourced Products + assignment safety-net + activity legibility

- **Date:** 2026-06-27
- **Status:** Design — pending user review
- **Repos touched:** Accu-Mk1 (backend + frontend), integration-service (one small additive field)
- **Anchored decision:** live-read-from-IS (no persistence, no backfill this round)

## Problem

On the sample parent page, the ORDER DETAILS card has a **PRODUCTS** section. Two defects:

1. The product chips (e.g. "Peptide Single Package") are sourced from **SENAITE** profiles (`getProfilesTitleStr`, via `/wizard/senaite/lookup`) — they die when SENAITE is phased out.
2. The **"Variance" chip is derived from current vial assignment state**, not from the order:
   `hasVariance = subData.sub_samples.some(s => s.assignment_kind === 'variance')`
   (`src/components/senaite/SampleDetails.tsx:3409-3411`). Moving the 2nd vial to "Extra" sets `assignment_kind = null`, the chip vanishes, and the lab loses any signal that a variance addon was purchased.

### Incident this prevents
A customer purchased a Variance addon. The 2nd vial was never assigned to (or was moved out of) the variance bucket, so the Variance chip disappeared. The lab saw a plain Core HPLC sample, didn't run the second vial, and the variance addon went unfulfilled. The PRODUCTS section should reflect **what the customer ordered**, independent of vial assignment, and the page should make a purchased-but-unassigned addon impossible to miss.

## Goals

- PRODUCTS chips reflect the **customer's order**, SENAITE-independent.
- A purchased addon with no vial assigned to run it is **loudly flagged** on the sample page.
- Sub-sample assignment (bucket) moves are **legible** in the parent activity flyout.

## Non-goals (deferred)

- Implementing the **Sterility → PCR / USP<71>** split itself (new WP products, seeder/workflow changes). This spec ensures the Products UI **absorbs** it via one registry entry per new product (D0); the split ships on its own track.
- Persisting ordered products into the Mk1 DB + one-time backfill (chose live-read-from-IS).
- A durable, non-SENAITE order↔sample link for future native (`mk1://`) samples. Noted as a known limitation below; out of scope this round.
- Renaming `/wizard/senaite/lookup`.

## Key facts established during exploration

- **The order data is already reachable from Mk1, SENAITE-free.** `fetch_sample_services(sample_id)` (`backend/sub_samples/service.py:728`) calls IS `GET /explorer/orders/sample-services?sample_id=` (`integration-service/app/api/desktop.py:819-885`), which resolves the sample to its WP order's per-sample `services` dict by matching `OrderSubmissionRecord.sample_results[slot].senaite_id` and returning `payload.samples[slot-1].services`.
- The IS endpoint currently returns `{ services, analytical_test, wp_order_number }` — **not `package`** (core/accushield). It returns service **keys** (booleans + a `variance` map), not display labels.
- **Sub-sample moves are already logged.** Every assignment writes `LimsSubSampleEvent(event="role_assigned", details={from,to,kind_from,kind_to}, user_id)` in the same transaction (`backend/sub_samples/service.py:1197-1203`; model `backend/models.py:1203-1230`). The actor email + timestamp are resolved and attached as `by` + `timestamp`, and the flyout already styles `role_assigned` (cyan `accent`, `@user`) — `SampleActivityLog.tsx:55,140-146`.
- **BUT the parent flyout does not show them.** `GET /samples/{id}/activity` gates the whole vial section on `sub_row = LimsSubSample.sample_id == sample_id` (`backend/main.py:1015-1018`). The flyout is opened with the **parent** id (`SampleDetails.tsx:4946`), which is a `LimsSample`, not a `LimsSubSample` — so `sub_row` is `None` and Sections A+B are skipped. Today the parent flyout shows only parent/COA/status events; **no vial assignment history appears there at all.** Component 3 must add a family fan-out (verified 2026-06-27, correcting an earlier assumption).
- Secondary gap: the `role_assigned` label is `f"Role: {from} → {to}"` (`backend/main.py:1118`) — it ignores `kind_from`/`kind_to`, so a same-role variance→core/extra move reads `Role: hplc → hplc`.
- **Fulfillment is authoritatively mapped by the seeder:** `ROLE_TO_WP_KEYS` (`backend/lims_analyses/seeder.py:65-70`) = `hplc→{hplcpurity_identity, bac_water_panel}`, `endo→{endotoxin}`, `ster→{sterility_pcr}`, `xtra→{}`. This is the single source for "which vial role fulfills which purchased service" — the registry's `fulfillment_role` parity-checks against it.
- Variance machinery exists: `normalize_variance_entitlement` (`service.py:376`), `derive_variance_demand` (`service.py:819`), `VARIANCE_BUCKET_KEYS = {hplc, endo, ster}` (`service.py:812`).

## Decisions (locked unless flagged at spec review)

### D0 — Extensibility: one product registry drives chips + alerts (primary design driver)
Products will keep being added — imminently, **Sterility splits into PCR and USP<71> addon products** (see the parked PCR-split plan). The design must absorb a new product with **one data entry**, not edits scattered across label maps, alert logic, and role mappings.

- Introduce a single registry keyed by WP service key — the one source for both display and fulfillment:
  ```
  ProductDef = { key, label, is_addon, fulfillment_role }
  ```
  - `label` — chip text. Prefer the WP `wc_test_services` name if IS supplies it; the registry label is the fallback/override.
  - `is_addon` — drives alert eligibility and chip grouping (base vs addon).
  - `fulfillment_role` — the vial `assignment_role` (or `assignment_kind` for variance) that fulfills the product; drives the purchased-vs-assigned alert. `None` = base/always-run → never alerted.
- **Adding a product = add one `ProductDef`.** The Sterility split *will* become two entries (`sterility_pcr` → "Sterility (PCR)"; `sterility_usp71` → "Sterility (USP<71>)") with **zero logic changes** — but **not in this round**. This round ships the registry with **today's products only**: a single **Sterility** (`sterility_pcr` → "Sterility"). The point of D0 is that when the split is ready, it's a one-line registry edit per new product and nothing else — the machinery is in place now, the entries are added later.
- **Fail open on display.** A purchased service key with no registry entry (a product added in WP but not yet registered) still renders a chip with a derived Title-Case label, and is logged server-side (`unregistered_product_key`) so the team knows to register it. A purchased product is **never silently hidden** — that's the core safety property. Unknown keys get no alert (fulfillment unknown → no false alarms).
- Additive: existing scattered maps (`VARIANCE_BUCKET_KEYS` at `service.py:812`, the seeder's role→service keys) stay in place. Where they overlap the registry, a parity test asserts agreement; convergence onto the registry is a later, optional cleanup — not this round.

### D1 — Data source: live read from IS, no SENAITE fallback
The Products section fetches ordered products from IS at render time. If IS errors, **do not** fall back to SENAITE profiles — show an explicit error state (D6). The SENAITE `profiles` path is removed from this section.

### D2 — Label mapping (service key → display chip)
| Source field | Chip label | Addon? |
|---|---|---|
| `package == "core"` | **Core HPLC** | base |
| `package == "accushield"` | **AccuShield** | base |
| `services.endotoxin` | **Endotoxin** | addon |
| `services.sterility_pcr` | **Sterility** | addon |
| `services.variance` (non-empty map) | **Variance HPLC** | addon |
| `services.bac_water_panel` | **Bac Water** | base (BW samples) |

This table is the **registry's initial contents** (D0), not bespoke logic. `package` (`core`/`accushield`) is registered the same way as a synthetic base key. New products are added as registry rows; unknown keys fall back per D0.

- `hplcpurity_identity` does **not** get its own chip when a package is present — the package (Core HPLC / AccuShield) already implies it. If `hplcpurity_identity` is true with **no** package, show a standalone **HPLC** chip (avoids the redundant double-chip the user flagged).
- Chip order: base package first, then addons.
- **Variance "purchased" goes through the existing variance helpers — not a raw non-empty check.** `services.variance` is a per-service map, but the rest of the system treats variance as entitled only after `normalize_variance_entitlement` (`service.py:376`, ≥2-pairs floor) and after `fetch_sample_services` has merged the lab `variance_override`. So purchased-variance = `normalize_variance_entitlement(services)` non-empty. This keeps the chip/alert in agreement with the vial-plan/demand logic (`derive_variance_demand`) — a raw check could show "Variance HPLC" for a map the demand logic ignores. Round 1 collapses the (normalized) map into a single **Variance HPLC** chip + single alert (the incident case); per-service variance chips are a later refinement.

### D3 — Alert scope: every registered addon with a fulfillment role
Flag any **purchased addon with no vial assigned to run it**. Eligibility is data-driven: any `ProductDef` where `is_addon == true` and `fulfillment_role` is set is alert-eligible. Variance is the flagship (loud); Endotoxin and the Sterility product(s) ride the same path automatically; the PCR/USP<71> split inherits it the moment those registry entries exist. Base/always-run products (HPLC purity, package) have `fulfillment_role = None` → never alerted.

### D4 — Alert is computed generically in the frontend
The endpoint returns each ordered product enriched from the registry: `{ key, label, is_addon, fulfillment_role, fulfillment_dim }`, where `fulfillment_dim` is `"kind"` for variance (checked against `assignment_kind`) or `"role"` for everything else (checked against `assignment_role`). Both alert inputs already live on the page — `ordered_products` (new fetch) and `subData.sub_samples`. The FE runs one generic loop, no per-product branches:

```
for p of products where p.is_addon && p.fulfillment_role:
  assigned = sub_samples.some(s =>
    (p.fulfillment_dim === 'kind' ? s.assignment_kind : s.assignment_role) === p.fulfillment_role)
  if (!assigned) alert(p)
```

So variance → `assignment_kind === 'variance'` (the existing `hasVariance`, repurposed from chip-driver to alert-driver); endotoxin → `assignment_role === 'endo'`; sterility → `assignment_role === 'ster'`. No FE-side product list to maintain — the registry on the backend is the single source. A parity test asserts the registry's `fulfillment_role`s agree with the seeder's authoritative `ROLE_TO_WP_KEYS` (`seeder.py:65-70`), inverted to service→role.

### D5 — "No order found" (IS 404) ≠ error
A sample not tied to any order (e.g. manually created) is a normal state, not an error. Show an empty/quiet Products section ("no linked order") — **not** the error UI and **not** the retry button. Only transient/5xx/network failures get the error+retry treatment.

### D6 — Error UX for the Products fetch
On a real fetch failure (timeout / 5xx / network), the Products card shows:
- An inline error indicator: "⚠ Couldn't load ordered products".
- **Hover/click to view the full error** in a tooltip/popover, with a **Copy** button. The copied text includes: HTTP status, IS error body/message, `sample_id`, `wp_order_number` if known, and an ISO timestamp — enough for a tech to paste into a message.
- A **Retry** button that re-runs the fetch.
- When in the error state, the purchased-vs-assigned alert is **suppressed** (we can't know what was purchased — never render a false "no variance" all-clear).

## Architecture & data flow

```
WP order  ──(webhook)──>  IS order_submissions.payload (services, package, variance)
                                  │  + sample_results{slot: {senaite_id}}
                                  ▼
Mk1 backend GET /samples/{id}/ordered-products
  → fetch_sample_services(id)  (IS /explorer/orders/sample-services, now incl. package)
  → build_ordered_products(services, package)  [pure; PRODUCT_REGISTRY, D0/D2; unknown→fail-open]
  → { sample_id, wp_order_number, products:[{key,label,is_addon,fulfillment_role,fulfillment_dim}] }
                                  ▼
Mk1 FE  SampleDetails → <OrderedProducts> card
  own useQuery → loading | error(D6) | not_found(D5) | products
  chips from products; variance/endo/ster alert from products × subData (D3/D4)
```

## Components

### Component 1 — Order-sourced Products

**IS (additive):** extend `SampleServicesResponse` + `get_sample_services` (`desktop.py:876`) to also return `package` from `sample_payload.get("package")`. Pure addition; existing consumers ignore the new field.

**Mk1 backend:**
- New pure module `backend/sub_samples/product_registry.py`: the `PRODUCT_REGISTRY: dict[str, ProductDef]` (D0) — the single edit point for adding products — plus `build_ordered_products(services, package, wp_names=None) -> list[OrderedProduct]`. Each `OrderedProduct = {key, label, is_addon, fulfillment_role, fulfillment_dim}`. Registered keys use their `ProductDef`; unknown purchased keys fall open to a derived Title-Case label, `is_addon=true`, `fulfillment_role=None`, and a `logger.warning("unregistered_product_key", key=...)`.
- New endpoint (home: `backend/sub_samples/routes.py`): `GET /{sample_id}/ordered-products` → calls **`fetch_sample_services`** (`service.py:728`) and reads BOTH `services` and the new `package` from the full dict. **Do not** use `_fetch_wp_services_for_parent` (`service.py:366`) — it narrows to `raw.get("services")` and would drop `package`. Maps via the registry; returns `{sample_id, wp_order_number, products}`. Distinguish:
  - IS 404 → `404` (FE renders D5 "no linked order").
  - IS timeout/5xx/network → `502/503` with a structured detail `{message, upstream_status, sample_id}` (FE renders D6).
- Mk1 client + types in `src/lib/api.ts`.

**Mk1 FE:**
- Extract the Products block (`SampleDetails.tsx:3958-3970`) into `<OrderedProducts sampleId subData />` with its own `useQuery`.
- Render chips from `products` (reuse `ProfileChip`). Remove the SENAITE `data.profiles` + vial-`hasVariance` sourcing from this section.

### Component 2 — Purchased-vs-assigned safety net
- Inside `<OrderedProducts>`, compute unassigned purchased addons per D3/D4.
- Render a prominent amber/red banner row in the card, e.g.:
  - "⚠ Variance HPLC purchased — no vial assigned to the variance bucket."
  - "⚠ Endotoxin purchased — no vial assigned." (etc.)
- Suppressed while loading or in the D6 error state.

### Component 3 — Surface family vial activity in the parent flyout
**Primary change — family fan-out (`main.py:1013-1018`).** Today the vial section only runs when `sample_id` is itself a sub-sample. Change it so that when `sample_id` is a **parent** (`LimsSample`), it resolves the family (`LimsSubSample where parent_sample_pk == parent.id`, i.e. `parent.sub_samples`) and runs Sections A+B for **every vial**, tagging each event with the vial's identity (`sub_sample_id` / label) so "which vial moved" is visible. Preserve the existing single-sub-sample path when called with a vial id (backward compatible). Guard the loop count (families are small, but cap defensively).

**Label fix (`main.py:1116-1118`).** Surface the bucket: when `kind_from`/`kind_to` are set/differ, render e.g. `S02 · Bucket: Variance → Extra`; otherwise keep `Role: <from> → <to>`. Map raw values to friendly labels ("variance"→"Variance", null→"Extra"/"—").

**FE (`SampleActivityLog.tsx`).** Show the vial identity on each vial event (prefix/badge via `src/lib/vial-label.ts`); colorize a move **out of** the variance bucket as `warn` (amber) so the risky action stands out. `by @user` + timestamp already render.

**Note:** the family fan-out adds N× per-vial queries to the activity endpoint. Families are small (typically ≤ a handful of vials), but batch the per-vial queries where practical and cap the vial count.

## Error handling
- Products fetch failure → D6 (view/copy/retry), never blocks the rest of the page.
- IS 404 → D5 quiet empty state.
- Activity flyout unchanged except the label.

## Testing
- **Backend unit (`build_ordered_products` / registry):** mapping for core, accushield, BW, each addon, variance map non-empty vs empty, hplc-without-package → "HPLC", package-present → no redundant HPLC. **Fail-open:** an unregistered key → derived label, `is_addon=true`, `fulfillment_role=None`, warning logged. **Extensibility (the flexibility guarantee):** adding a synthetic `ProductDef` (e.g. a `sterility_usp71` stand-in — a **test-only fixture, never added to the live registry**) makes its chip render and its alert fire with **no other code change** — this test is the executable proof of D0. Parity: registry `fulfillment_role`s == seeder `ROLE_TO_WP_KEYS` (`seeder.py:65-70`), inverted.
- **Backend unit (activity):** **family fan-out** — `/samples/{parent_id}/activity` returns vial events from all family vials, each tagged with its vial identity; calling with a vial id still returns that vial's events (backward compatible). Improved `role_assigned` label — kind change vs role change vs initial assign.
- **Backend unit (endpoint):** IS-404 → 404; IS-error → 502/503 with structured detail.
- **FE:** chips render from `products`; the generic alert loop fires for any addon with an unmet `fulfillment_role` (variance via `assignment_kind`, endo/ster via `assignment_role`) and clears when assigned; D6 error renders with copy+retry and suppresses the alert; D5 renders quiet empty.

## ISO 17025 alignment
- **Attribution (7.5.1):** assignment changes already carry actor + timestamp; Component 3 makes bucket changes legible — strengthens traceability of who moved a vial and when.
- **Data integrity / completeness:** Component 2 guards against silently not running a paid-for test (the incident) — a control with a visible signal, not a manual checklist.
- No amendment to verified/published results is involved; this is intake/assignment-stage display.

## Known limitations
- The order↔sample lookup is keyed on the SENAITE id (`sample_results[].senaite_id`). Existing samples all have one; future native (`mk1://`) samples will not, so the live lookup will 404 for them → D5. Establishing a durable non-SENAITE link is deferred (Non-goals).

## Implementation notes
- Per Accu-Mk1 CLAUDE.md: run `gitnexus_impact` on touched symbols (`fetch_sample_services`, the Products render, the activity label builder) before editing; run `gitnexus_detect_changes()` before any commit.
- No unsolicited commits (AGENTS.md rule 9) — commit on request.
- Verify exact line numbers at implementation (`/wizard/senaite/lookup` ≈ `main.py:11532`, profiles parse ≈ `main.py:11628`) — they drift.
