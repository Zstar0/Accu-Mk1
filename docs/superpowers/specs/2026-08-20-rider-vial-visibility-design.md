# Rider Vial Assignment + Native Analyses Vial Visibility — Design

*2026-08-20. Approved by Handler in-session (scope: S1–S4, no manual rider-move control).*
*Code citations are against the arcitest composition, worktree `C:\tmp\Accu-Mk1-arcimerge`, branch `arcitest/methods-merge` @ `37955381`. The build branch cuts from that commit (the feature depends on unpushed code: spec-4 custody/ride-lists, native-manage-analyses `manage_native.py`, methods stack).*

## 1. Problem

Evidence sample: **P-0158 on arcitest** (parent pk 1154, vials `P-0158-S01` pk 1325 role `hplc`/core, `P-0158-S02` pk 1326 role `usp71`/core). Order = HPLC + Sterility <USP-71> + Fentanyl Screening (profile 9, key `fentanyl`, `fulfillment_role='fentanyl'`, `vials_required=0`, ride list `['hplc']`).

What worked: at check-in, `resolve_catalog_fulfillment` resolved fentanyl as a rider on the live `hplc` role and `write_custody_edges` wrote a `relation='rider'` custody edge onto S01 (edge id 15). The auto-assignment the Handler asked for **already exists at the custody layer**.

What's broken:

1. **The rider's analysis never seeds on the host vial.** `seed_analyses_for_vial` short-circuits for `hplc` — `backend/lims_analyses/seeder.py:627` returns `mirror_parent_hplc_analyses(...)` (SENAITE-keyword mirror) *before* the custody-edge-aware catalog branch at `:646`. S01 got its 3 HPLC analyses; no FENTANYL row. Since `endo`/`ster` are forbidden ride hosts (`_RIDE_HOST_FORBIDDEN`, `backend/main.py:2787`), `hplc` is the host that matters — and it's the one branch that ignores edges. Net: the parent FENTANYL placeholder (row 3767, `ordered`/`unassigned`) is stranded — nothing to run, nothing to promote.
2. **No UI shows where a rider landed.** `RiderChips` (`src/components/intake/ReceiveWizard/AssignStep.tsx:625`) is display-only per-role with no vial identity; `GET /sub-samples/{sample_id}/custody` (`backend/main.py:17658`) has zero FE consumers; Manage Analyses' `_host_vials` (`backend/lims_analyses/manage_native.py:107-114`) explicitly excludes riders → `no_host_vial: true` / "placeholder only".
3. **The native "Accu-Mk1 Analyses" card shows no vial linkage.** The SENAITE Analyses section's "sub-line" is really inline **vial chips** in the Analysis cell (`src/components/senaite/AnalysisTable.tsx:1497-1534`, click → `navigateToSample`), driven by the FE join `buildVialAssignmentMap` (`src/lib/vial-assignment.ts:153-232`). The join map is built **only from SENAITE parent rows** (`SampleDetails.tsx:3828-3845`), so native rows (FENTANYL, STERILITY-USP71) never get an entry — even when the vial row exists (S02's seeded STERILITY-USP71). Chips are *not* promotion-gated; they look promotion-gated because that's when the join finally has something to match.

## 2. Locked decisions (Handler, 2026-08-20)

- **No manual rider-move control in this slice.** Ride lists encode intent deterministically; a rider-move API/UI (edge supersede + reseed semantics) is deliberate future work if ever needed.
- **Standalone behavior is already correct and stays untouched**: a rider ordered with no live host self-mints under its own role (`catalog_demand.py:161-164`, `vials_required or 1` → 1 vial), gets its own spot, a `host` edge, and — being a catalog role — seeds correctly. Pinned by `test_standalone_rider_self_mints_own_role`.
- **S1 defaults**: riders skip `assignment_kind='variance'` vials; riders seed on **all core vials of the host role** (consistent with catalog-host behavior today, e.g. hm's 2 vials).
- Heal for existing stranded samples (P-0158) = re-run the vial's role assignment (or Manage Analyses resync once S2 lands); no data surgery.

## 3. Out of scope

- Ordering-side surfaces for selling fentanyl (or other riders) as addons: the IS declared-key line and the WP product/card + customer-facing vial count. WP's per-product vial number is static and cannot express "0 extra vials with HPLC, 1 if alone" — own slice when the product goes live.
- Standalone-profile spot display for lab-added profiles (`compute_vial_plan` demand does not union placeholders; a lab-added *standalone* profile still shows no spot until a role flip) — pre-existing, ledgered as follow-up. This slice unions placeholders for the **sections/fulfillment display resolve only**, not for demand/auto-assign.
- Manual rider re-assignment (see locked decisions).
- Any SENAITE surface (R0: zero new SENAITE coupling).

## 4. Design

### S1 — seed rider members on legacy-host vials (backend)

**File:** `backend/lims_analyses/seeder.py` (hplc branch `:627-640`), `backend/sub_samples/service.py` (`_drop_stale_role_rows` `:1736`).

In `seed_analyses_for_vial`, when `role == "hplc"` and a `sub_sample` is present:

1. Run the existing mirror (`mirror_parent_hplc_analyses`) unchanged.
2. Additionally, when `sub_sample.assignment_kind != 'variance'`: read `current_custody(db, sub_sample.id)`, keep `relation='rider'` edges, resolve their member services through the existing machinery (`_members_from_edges` restricted to rider edges — reuse its per-profile fail-closed origin gate `_members_through_origin_gate`; snapshot-aware via `parent.catalog_snapshot`), then create rows via `_seed_rows_from_services`, deduped against the branch's `existing_kw`/`existing_service_ids` sets (built at `:617-624`).
3. Return the combined count; commit semantics unchanged (the `commit` flag belongs to the caller, `set_assignment_role` seeds with `commit=False` inside its one transaction).

The seeded rider rows use the same shape as catalog-role seeding (review_state `unassigned`, provenance as `_seed_rows_from_services` writes today). `endo`/`ster` branches stay untouched (forbidden hosts).

**Stale-row awareness:** `_drop_stale_role_rows` must treat a vial row as **not stale** when a live rider custody edge covers its service (profile membership of a `relation='rider'` edge with `superseded_at IS NULL`); conversely, when a vial is re-assigned to a role where no live rider edge covers the profile, the rider's pristine rows drop like any stale rows. Ordering note: `set_assignment_role` supersedes+rewrites edges (`:1957-1960`) and flushes (`:1966`) *before* `_drop_stale_role_rows` (`:1971`) — so the staleness check reads the **new** edge set, which is exactly right.

**Known pre-existing edge (do not fix, ledger only):** `role_implies_seeding` gates the whole hplc branch on the order's wp_services; a vial manually flipped to `hplc` on an order that never bought HPLC skips seeding entirely (mirror included). Rider seeding lives inside the branch and inherits that gate.

### S2 — lab-added riders provision onto their host vial (backend)

**File:** `backend/lims_analyses/manage_native.py`.

1. `_host_vials(db, parent, profile)` becomes ride-aware. New resolution, mirroring `resolve_catalog_fulfillment` semantics:
   - non-`role` dim or no `fulfillment_role` → `[]` (unchanged);
   - if the profile has `profile_ride_hosts` rows: walk host role codes in priority order; the first role with ≥1 existing vial of that `assignment_role` (excluding `assignment_kind='variance'`) wins → return those vials **and mark them rider-hosted**;
   - fallback (no ride hosts, or none live): vials of the profile's own `fulfillment_role` (the standalone/self-mint case) → host-hosted, as today.
2. `_ensure_host_edge(...)` gains a `relation` parameter (default `"host"`, preserving both existing call sites' behavior). `add_profile_to_parent` and `resync_parent_from_order` pass `relation="rider"` when the hosting vial's role differs from the profile's own `fulfillment_role`. The edge stays additive/non-superseding (`_supersede_orphan_edges` semantics untouched).
3. Effect: adding a rider profile via Manage Analyses now mints the parent placeholder **and** the host-vial rows + a `rider` edge, instead of `no_host_vial: true`. `resync-from-order` heals the same way — making it the second heal path for stranded riders.

**Display/write parity fix:** `compute_vial_plan` resolves sections against the raw IS services dict (`backend/sub_samples/service.py:1540`), while `set_assignment_role` resolves edges against services ∪ live placeholder keys (`:1937-1951`). Union `placeholder_profile_keys(db, parent_row)` into the services passed to `_build_vial_plan_sections` (sections only — demand/auto-assign inputs unchanged, see §3). Lab-added riders then render their `· rider` chip.

### S3 — show the rider's landing (backend payload + FE)

**Backend:** in `_build_vial_plan_sections` (`backend/sub_samples/service.py:1544-1647`), rider profile dicts (`relation: "rider"`, built at `:1625-1628`) gain `host_vials: [<vial sample_id>, ...]` — the parent's current vials holding a live (`superseded_at IS NULL`) `relation='rider'` edge for that profile, ordered by `vial_sequence`. Host profiles don't need it (their spot shows its assigned vials already). One query for the whole parent, not per-profile. `VialPlanResponse.sections` is untyped server-side (`schemas.py:135`) — the dict just grows a key.

**FE:** `VialPlanRoleProfile` (`src/lib/api.ts:6138`) gains `host_vials?: string[]`. `RiderChips` (`AssignStep.tsx:625`) renders the landing after the marker: `Fentanyl Screening · rider → S01` (suffix after the parent id, i.e. `sample_id.split('-').pop()`; full sample_id in `title`); multiple vials comma-joined; absent/empty → chip renders exactly as today (covers pre-check-in and self-minted riders, which present as hosts anyway).

The Manage Analyses host chip (`NativeManageAnalysesBlock.tsx:164`, picker `:195-197`) starts working for riders for free — it renders `host_vials` from `native_profiles_for_parent`, which S2's `_host_vials` fix populates.

### S4 — vial chips on the "Accu-Mk1 Analyses" card (FE)

**Files:** `src/components/senaite/SampleDetails.tsx`, possibly `backend/lims_analyses/service.py` + `schemas.py` + `src/lib/api.ts` (one field).

Build a second join map for native rows and pass it to the native card:

1. In `SampleDetails`, read the native card's shaped rows via the **same query key** the card uses (`[NATIVE_PARENT_ANALYSES_QUERY_KEY, sampleId, 'senaite_shape']` → react-query dedupes; the card at `:3388-3393`).
2. Feed those rows through the existing `buildVialAssignmentMap(nativeRows, vialInputs, analyteNameMap)` with the **same** `vialInputs` already assembled at `:3778-3810` — no new vial queries.
3. Pass the resulting map as the native card's `vialAssignmentByKeyword` (`:3483`). The chips + `navigateToSample` click-through then render through the shared `AnalysisTable` path (`AnalysisTable.tsx:1497-1534`) with zero table changes, including the existing "hide the chip once promotion names that vial" filter.
4. Join tier: prefer tier 0 (`analysis_service_id` — exact, both tiers are mk1 rows). If the senaite-shape response does not already carry `analysis_service_id`, add the field (backend schema + TS mirror). Tier 1 exact-keyword equality is the natural fallback and already matches for native rows (identical keywords across tiers); **no new join tiers** (ast-grep rule `no-new-keyword-join-tiers` stands).

Result: `ordered` placeholders and canonical native rows both show their assigned vial pre-promotion. On P-0158, Sterility <USP-71> lights up immediately; Fentanyl lights up after the S1 heal.

## 5. Error handling

- Seeding additions are fail-closed per profile via the existing origin gate (a rider profile with any non-mk1 member seeds nothing, logged) and fail-soft at the vial-create seeding entry (`_seed_analyses_if_role`, best-effort, unchanged).
- `host_vials` computation failures must not break the vial plan: build inside the existing sections construction; no new exception paths that could 500 `GET /vial-plan`.
- S2's `_host_vials` change only widens which vials are found; `no_host_vial: true` remains the honest answer when neither ride-host nor own-role vials exist (placeholder-only, seeds at later role flip via the existing union hook).

## 6. Testing

- **Backend (pytest, TDD per task):**
  - S1: rider member seeds on hplc host vial alongside the mirror; dedupe against pre-existing rows; `assignment_kind='variance'` vial gets no rider rows; multi-vial host role seeds each core vial; re-assign same role is idempotent; re-assign away from the host role drops the pristine rider row; origin gate blocks a mixed-origin rider profile.
  - S2: `_host_vials` resolves ride hosts in priority order, skips variance vials, falls back to own role; `add_profile_to_parent` on a rider profile writes a `rider` edge + host-vial rows; `resync_parent_from_order` heals a stranded rider; existing host-profile behavior byte-identical (relation default).
  - S3: sections payload carries `host_vials` for riders with live edges, empty otherwise.
  - S4 (if backend field added): shaped response carries `analysis_service_id`.
- **FE (vitest):** AssignStep rider chip renders `→ S01` with `host_vials` and unchanged without (existing `assign-step.test.tsx` contract extended, not broken); native card passes a native-row join map and renders a clickable vial chip pre-promotion.
- **Gate:** full backend suite + FE suites + `tsc --noEmit`, judged by **failure-set diff against a baseline captured at worktree cut** (composition has a documented pre-existing `test_catalog_change_log` failure) — never zero-failures.
- **Live E2E (arcitest):** merge → devbox push → backend restart → heal P-0158 (re-assign S01's role or resync) → verify: FENTANYL row on S01; native card shows S01/S02 chips with click-through; AssignStep shows `· rider → S01`.

## 7. Follow-ups ledgered (not this slice)

1. Ordering-side fentanyl productization (IS key + WP card + conditional customer vial count).
2. Lab-added *standalone* profile spot display (demand union of placeholders in `compute_vial_plan`).
3. Manual rider-move control (edge supersede + reseed semantics), if ever needed.
4. `GET /sub-samples/{sample_id}/custody` remains FE-unused; retire or adopt later.
5. `role_implies_seeding` wp_services gate on manually-flipped hplc vials (pre-existing).
