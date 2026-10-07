---
title: Bac Water family to Mk1-native (new orders born native) + IS stops minting ARs for all-native samples
date: 2026-10-05
status: APPROVED by Handler 2026-10-05 (defaults R1-R6). Planning CORRECTIONS 1, 2 and 8 are PENDING Handler sign-off (lab-flow change, spec numbers, new guard); plan = plans/2026-10-05-bac-water-native-born.md
related: "specs/2026-09-10-hplc-native-born-design.md (the pattern this copies), specs/2026-09-23-mk1-native-retest-design.md, handoffs/2026-08-05-senaite-family-migration-assessment.md"
---

# Bac Water to Mk1-native, and no SENAITE AR for all-native samples

## Context (measured on prod 2026-10-05, read-only)

- Since the HPLC flip (week of 09-21), peptide parents are Mk1-born. In the week of 09-28 there were 130 mk1-born parents against 2 senaite-born P samples, and those 2 are likely flip-week stragglers.
- **Bacteriostatic Water is the only family still SENAITE-born:** all 15 BW parents created that week were senaite-born. The range since the flip is BW-0120..BW-0135.
- BW orders **already** run endotoxin and PCR on the native services, `ENDOTOXIN-USP85LAL` and `STERILITY-PCR`. Those results live in Mk1 beside the SENAITE AR. The only thing that still needs SENAITE is the panel itself: `PH-DETERM`, `Benzyl_Alcohol_Assay`, `FILL-NET-CONTENT` (all origin=senaite), on SENAITE profile `bac_water`.
- Mk1 has a `bac_water_panel` analysis profile with **no members**: role `hplc`, 1 vial, used for demand only.
- Native services never put rows into a SENAITE AR. Whether an AR is minted at all is decided in IS by the **primary** service:
  - `lims="mk1"` only for `hplc-purity-identity` or a native retest (IS `order_validator.py:382-416`).
  - Every other sample gets an AR, including a sample whose services are all native. That AR then carries no SENAITE profiles.

**Finish line:**
1. Every NEW BW order is minted, benched, promoted and COA'd in Mk1, with no SENAITE AR.
2. Any sample whose ordered services are all native is Mk1-born, whatever its matrix.
3. In-flight SENAITE BW samples finish on SENAITE and age out.
4. Never flip `origin` on existing rows.

## Corrections (2026-10-05, found while planning; these override the text below)

1. **Panel is VIAL-tier, not parent-tier.**
   - Parent-tier rows cannot `submit` (`state_machine.py:167-175`), and the COA certifies only promoted `canonical` rows (`native_sections.py:169-172`).
   - The BW panel seeds on the hplc vial at check-in. Results are entered on S01, then promoted and verified on the parent, the same as every native family.
   - Parent placeholders still mint at registration.
   - This supersedes "the panel is parent-tier" and MB4's "the vial seeds nothing".
2. **R4 specs mirror LIVE coabuilder, not the stale Mk1 vendored copy:**
   - pH 4.5-7.0, display "4.5 – 7.0".
   - Benzyl alcohol 0.72-1.08 in `% (v/v)`, display "0.9% (v/v) ±20%" (widened in 2.28.3 with Handler sign-off 2026-07-17).
   - Fill volume informational with display override U+2014, the glyph legacy BW prints in the Specification cell (status pill MEASURED on both). Corrected in final review 2026-10-05.
   - Titles and units copy the prod SENAITE services: "pH Determination"/pH, "Benzyl Alcohol Assay (HPLC)"/% (v/v), "Fill volume / Net content"/mL.
3. **`sla_tier_id=None`.**
   - Inactive profiles are ignored by every SLA resolver, and legacy `bac_water_panel` has no tier.
   - Native BW therefore resolves exactly like legacy BW. The "drop out of SLA" claim was wrong.
4. **MB6 dropped.** Nothing reads the BA peptide binding to route a result.
5. **The slot gate skips BW** rather than allowing only Peptide/Blend. Retest rows with a NULL title rely on slot resolution.
6. **IB2 fill volume** needs no change, since both paths already format `.2f`. **IB4** is verify-only.
7. **IB3:** a BW retest routes to mk1 only when the legacy panel field is absent (legacy BW orders already carry the native endotoxin key).
8. **New guard.** A SENAITE-born BW sample that arrives carrying the native key (IS valve off) must not get native placeholders, which would mean a second bench entry surface.
9. **T0 step 1, run on prod 2026-10-05:** zero of 1,833 SENAITE-born samples since 08-01 were all-native. Part B is forward protection only.

## Recommended defaults (Handler to confirm or override)

- **R1, profile key `bacteriostatic-water-panel`.** This is the WP `profile_key` on the "Bac Water Panel" row and the new Mk1 profile key. It is deliberately not `bac-water-panel`, which is one character away from the legacy `bac_water_panel` and the IS alias `bacwaterpanel`.
- **R2, native service keywords `PH-BW`, `BENZYL-ALCOHOL-BW`, `FILL-VOLUME-BW`.** These are distinct from the SENAITE keywords, as the cross-origin collision guard requires. Native rows get their section from their own profile. The keywords still keep the `PH-` / `BENZYL` / `FILL-` prefixes, so the display-side legacy classifier (`lims_analyses/service.py:1340-1345`) puts them in Bac Water if it ever sees them. No classifier change is needed.
- **R3, customer ids `BW-NNNN` with the counter seeded at `BW-1000`.** Recent prod BW ids are in the low hundreds; the classifier comment cites BW-0156. MB1 asserts the seed is above `max(BW-*)` at boot, which is the same guard as P/PB. This copies the PB-1000 ruling, with the same guarded insert and skip-forward.
- **R4, specs owned by Mk1.**
  - pH: range 4.5-7.0.
  - Benzyl alcohol: range 0.81-0.99.
  - Fill volume: informational, "As measured".
  - All are wildcard tier on the new services.
  - COABuilder honours the wire `specification`/`conforms` on BW rows, with its baked specs as the fallback only. That is the same move 2.35.0 made for `ConformanceEngine`.
- **R5, variance stays out of scope.** BW variance was pulled 2026-08-20.
  - The new pH and benzyl alcohol services carry `variance_capable=true`, so re-enabling later is a WP-only change.
  - Nothing in this spec sells or renders BW variance.
- **R6, Part B (all-native, no AR) ships behind its own T0 evidence step** and can land after Part A. See Part B.

## Part A: Bac Water native-born

### Key design decisions (why)

- **Switch = WP `profile_key=bacteriostatic-water-panel` on the "Bac Water Panel" test-service row, with vials kept at 0.**
  - WP needs no code: `serviceWireKey()` emits the profile key, and the BW product resolves by name (wp-content/themes/wpstar `js/sample-submission.js:73-77`, `src/Util/Service_Product_Map.php:68,117-127`).
  - Rollback = clear the field, and the legacy key resumes.
  - The IS valve `LIMS_NATIVE_ROUTING_DISABLED=1` also forces SENAITE.
- **Page 1 rides a Mk1-side vocabulary shim.** This is the same idea as `coa/hplc_shim.py`.
  - Native BW rows go out on the legacy-rows wire under the SENAITE keywords COABuilder's `GenericAssayEngine` already reads (`PH-DETERM`, `Benzyl_Alcohol_Assay`, `FILL-NET-CONTENT`).
  - Techniques, section layout, the variance keying and the baked-spec fallback all keep working unchanged.
- **The panel is parent-tier, not vial-tier.** The SENAITE trio is already parent-bench-only (`seeder.py:62-72`, `_PARENT_BENCH_ONLY_KEYWORDS`).
  - Native BW rows are minted as parent placeholders at registration by the existing generic `seed_parent_placeholders`, because the profile is all-mk1.
  - The BW hplc-role vial seeds nothing.

### Mk1 (Accu-Mk1)

- **MB1, catalog seed.** New `backend/catalog/bw_native_seed.py`, modelled on `hplc_native_seed.py`, with the same idempotency, collision abort and change-log rules.
  - **Services:** the three R2 services, department Analytical, numeric results with units pH / mg/mL / mL.
  - **Profile:** `bacteriostatic-water-panel`, seeded INACTIVE. It mirrors the legacy `bac_water_panel` demand: role `hplc`, 1 vial, `coa_archetype = "legacy_bw"`.
    - It **stays inactive at flip**, which matches prod `hplc-purity-identity` (`active=False`, verified 2026-10-05).
    - Inactive only hides a profile from the Manage Analyses picker (`hplc_native_seed.py` docstring). `catalog_demand` still fulfils it.
    - IS still learns the key, because `/s2s/catalog/service-keys` ships every profile key whether active or not (`main.py:25421`, "Do NOT filter on active").
  - **`sla_tier_id`:** set it to the tier BW samples resolve to today. Tiers hang off profiles, and the legacy `bac_water_panel` profile has `sla_tier_id=None`. The plan verifies how SLA currently resolves a BW sample (v1.31.2 SLA-for-native-born path) before picking the value. Without it, native BW samples drop out of SLA.
  - **Department:** set Analytical explicitly on all three services. A NULL department hid every BW card from the worksheet inbox on 09-01 (BW inbox-invisible incident).
  - **Specs:** the R4 wildcard specs.
  - **Counter:** the guarded `BW` row in `lims_native_id_sequences` at 1000 (`database.py`, next to the P/PB inserts at ~2488).
- **MB2, BW key alias.** The demand, completion and seeder paths treat the new key as the BW primary, like `catalog/hplc_keys.py` does for HPLC:
  - `seeder.ROLE_TO_WP_KEYS["hplc"]`
  - `derive_variance_demand`, `derive_base_demand` and `derive_demand` (`sub_samples/service.py:1530-1637`)
  - `product_registry.py:39`, `demand_verify.py:37`
  - `product-completion.ts:125`
  - A key set (`BW_PRIMARY_KEYS = {"bac_water_panel", "bacteriostatic-water-panel"}`), not scattered literals.
  - **Legacy-keyword sites.** Full `git grep` of `PH-DETERM|Benzyl_Alcohol_Assay|FILL-NET-CONTENT` over `backend/` and `src/` at e5852180, outside tests. Each site gets a matching native keyword set (`BW_NATIVE_KEYWORDS`):
    - `lims_analyses/seeder.py:69` `_PARENT_BENCH_ONLY_KEYWORDS`: add the native trio as a belt-and-braces guard, so the department allow-list can never mirror them onto a vial.
    - `throughput.py:47` `BACW_KEYWORDS`: add the native trio, or the lab throughput report loses BW after the flip.
    - `database.py:1101`: the variance_capable backfill. Not needed, because MB1 sets the flag at seed.
    - `database.py:417`: the BA peptide binding. See MB6.
    - `conformance_vendored/baked_specs.py:30-61`: the vendored specs and techniques. Not touched, because the shim emits the legacy keywords.
    - `main.py:20230`: a comment only.
- **MB3, native-born intake.**
  - Add `"bacteriostatic water": "BW"` to `CUSTOMER_PREFIXES` (`sub_samples/native_id.py:81`) and remove the "BW stays SENAITE-born" comment.
  - The registry upsert (`sub_samples/service.py:367-381`) needs no change; `born_native = not sample_id` already applies.
  - **Slot logic is peptide-only.** `seed_parent_placeholders` runs `resolve_slot_peptides` and `flag_unresolved_slots` for any native-born parent (`parent_placeholders.py:~75-80, 140-150`), and an unresolved-slot flag blocks the COA.
    - Gate that block on Peptide / Peptide Blend, so a BW parent never resolves slots and never gets flagged.
    - The panel services are not in `TRIO`, so they mint with `slot=None` either way.
    - Pinned by a test: a native-born BW parent gets 3 placeholders and zero flags.
- **MB4, check-in.** The BW vial goes through the `role == "hplc"` branch at `seeder.py:735`. That branch currently forks only on `is_native_born` into `seed_native_hplc_rows`, which would try to build a peptide trio from "Benzyl Alcohol".
  - Fork first on the sample type: a native-born BW parent seeds nothing on the vial, because the panel is parent-tier.
  - Fail loud if a native-born BW parent has no `bacteriostatic-water-panel` placeholders.
- **MB5, COA wire.**
  - **`coa/bw_shim.py`:**
    - `is_native_bw_row`
    - keyword/title map native to legacy
    - `_rides_page_one` admits native BW rows when their profile archetype is `legacy_bw`. It uses the same `archetype_by_service` gate as HPLC (`coa/legacy_rows.py:~95-125`).
    - Native rows ship `specification`/`conforms` from `_native_spec_fields`, which already exists.
  - **`legacy_bw` archetype.** Every `legacy_hplc` / `LEGACY_HPLC_ARCHETYPE` site, from a full grep at e5852180:
    - `main.py:3154` `COA_ARCHETYPES`: add `legacy_bw`, or the profile PATCH 400s.
    - `src/components/hplc/coa-archetype-options.ts:7`: add "Legacy (Bac Water page 1)".
    - `coa/native_sections.py:136` `_ordered_native_profiles`: skip `legacy_bw` like `legacy_hplc`, so it rides page 1 and is never a page-2 section, since coab aborts on an unknown archetype.
    - `coa/legacy_rows.py:95-127` `_rides_page_one` / `archetype_by_service`: `native_hplc_service_archetypes` is HPLC-keyed. Add a BW equivalent, or generalize it to "native page-1 rows" keyed by archetype set. The plan picks one; generalizing is preferred if it stays a small diff.
    - `catalog/hplc_native_seed.py:183,241-249`: HPLC-only, untouched.
  - **`sample_meta`** keeps `SampleTypeTitle = "Bacteriostatic Water"`. That title is what makes COABuilder pick `GenericAssayEngine`.
  - **Variance:** `coa/variance_series.py:382` maps the native BW keywords through the shim, so a later variance re-enable keys correctly. Dormant today.
- **MB6, the Benzyl Alcohol analyte.** `database.py:395-421` binds the BA peptide to the SENAITE `Benzyl_Alcohol_Assay` service.
  - Add the binding to `BENZYL-ALCOHOL-BW` as well; do not move the existing binding, because legacy samples still need it.
  - The prep / standards lookup must resolve on either service.
- **MB7, frontend.** No change is expected. `endo-prep.ts:50-63` matches `/^BW-/` or the sample type, and both hold. The plan re-greps BW literals in `src/` before closing.

### IS (integration-service)

- **IB1, BW routing.**
  - `_validate_bac_water_sample` (`order_validator.py:615-713`) accepts the native BW key as the entry ticket in place of `bac_water_panel`.
  - With the native key and the valve on, it sets `lims="mk1"` and maps no SENAITE profile.
  - The legacy key keeps today's path byte-identical.
  - Native BW plus a legacy `endotoxin`/`sterility_pcr` field is rejected loudly, the same rule as native HPLC (`:398-414`). Prod BW orders already send the native endo/PCR keys.
- **IB2, BW native meta.**
  - `build_native_sample_meta` (`native_sample.py:87`) and `_registry_enrichment` (`order_processor.py:612`) take the sample type from the normalized sample. They set `"Bacteriostatic Water"` for BW, and keep Peptide / Peptide Blend otherwise.
  - The analyte slots mirror the SENAITE BW payload (`adapters/senaite.py:2178-2184`): `Analyte1Peptide = "Benzyl Alcohol"`, and the fill volume rides `DeclaredTotalQuantity`.
  - **The title must be exactly `"Bacteriostatic Water"`. It is load-bearing for the endotoxin spec.**
    - Native endotoxin on a BW sample resolves its spec through the matrix tier. Prod has ONE active `ENDOTOXIN-USP85LAL` tier with matrix `Bacteriostatic Water` (range 0-0.25 EU/mL), plus the wildcard 0-5 EU/mL (verified 2026-10-05).
    - A wrong title silently falls back to ≤5 and still prints.
    - Today's SENAITE-born BW samples carry the correct title and verify against 0.25. Prod results BW-0111..BW-0134 are all 0.2 EU/mL, published or verified.
    - IS test: a native BW meta carries the exact title. Mk1 test: a native-born BW sample's endotoxin row resolves the 0.25 tier.
- **IB3, retest.** BW currently returns before the `native_retest` check (`order_validator.py:325-329`). Move the lims decision so a BW sample with `retest_spec` plus a native key routes to mk1, like a peptide retest.
- **IB4, transfers.** `transfer.py:142-207` already returns 409 for any native sample, the same known limitation as HPLC. Old SENAITE BW orders re-send `bacwaterpanel`, which stays aliased.

### COABuilder

- **CB1.** `GenericAssayEngine._resolve_status` and `_apply_variance` (`generic_assay_engine.py:269,341`) prefer the row's wire `specification`/`conforms` when present.
  - They fall back to `lookup_spec(matrix, keyword)` only when it is absent.
  - Legacy BW samples carry no wire spec and render byte-identical.

### WordPress

- No code change. The flip is a data change: `profile_key` on the "Bac Water Panel" row, with vials 0 and the name unchanged.
- The BW-variance literal sites (`sample-submission.js:3964,4002`, `Addon_Upgrades.php:553,694`, `Cart_Order.php:1820`) stay dormant until BW variance returns. They are not in scope.

## Part B: IS mints no SENAITE AR for an all-native sample

- **Rule.** After the profile mapping, if the sample selected at least one native key, maps to **zero** SENAITE profiles, and the valve is on, then `lims="mk1"`. This applies to every matrix.
  - It generalizes today's `native_hplc or native_retest` test at `order_validator.py:395`, which stays as-is inside the new rule.
  - Mixed samples (a native key plus a SENAITE profile) keep minting an AR, as today.
- **Who it changes.** A sample whose services are all native but have no HPLC primary. Examples: a peptide sent in for endotoxin and PCR only, heavy metals only, fentanyl only, or USP71 only. Today these get a SENAITE AR that carries no profiles.
- **T0, evidence before code. Part B does not ship until this passes:**
  1. Count prod orders since 2026-08-01 that would take the new branch, by service combination.
  2. For each combination, prove that the Mk1 COA path renders a certificate for a native-born sample that has **no page-1 family**. `coa/legacy_rows.py` currently aborts on zero legacy rows (docstring: "Until pure-native samples exist ..."). Today's bare-AR samples either already hit that abort or render through some other path. T0 finds out which, from real samples, before anyone writes code.
  3. If a combination cannot render, Part B ships with an explicit exclusion list for it, rather than changing COA rendering in this spec.
- **Code.**
  - `order_validator.py` lims decision.
  - `_registry_enrichment` / `build_native_sample_meta` already handle peptide types; IB2 covers BW.
  - Mk1 needs no change for intake: placeholders, the status relay and `_senaite_has_no_ar` are already generic on `is_native_born`.

## Deploy and activation

- **Order:** Mk1 (MB1-MB7, everything dark because the profile is inactive and no order sends the key) → COABuilder (CB1) → IS (IB1-IB4; Part B in the same or a later release) → flip.
- **Flip runbook:**
  1. Do NOT activate the `bacteriostatic-water-panel` profile; leave it as prod HPLC is. Trigger the IS catalog sync, and confirm `bacteriostatic-water-panel` is in the registry's synced keys. An unsynced key rejects every BW order at `_service_extras_errors`.
  2. Set the WP `profile_key` on the "Bac Water Panel" row.
  3. Place a Handler test order that is BW plus endotoxin plus PCR. Walk it through check-in, bench, promote, COA PDF, the AccuVerify page and the portal, as was done with WP-7133 for endo/PCR.
- **Rollback:** clear the WP `profile_key`. New orders return to the legacy key. Native-born BW samples already minted finish on the Mk1 path. IS valve `LIMS_NATIVE_ROUTING_DISABLED=1` covers Part B too.
- Deploys happen after lab hours, following the 09-21 pg_dump incident rule.

## Testing

- **Mk1:**
  - seed idempotency and collision abort
  - BW counter mint and skip-forward
  - check-in fork (a native-born BW vial seeds nothing; a legacy BW sample is unchanged)
  - shim wire rows for a native BW sample, including specs and conforms
  - a legacy BW sample's wire output byte-identical
  - Gate on the failure-set diff against the baseline, not on zero failures.
- **IS:**
  - BW native key routes to mk1
  - legacy BW byte-identical
  - native BW plus legacy endo is rejected
  - BW retest routes to mk1
  - Part B rule matrix: all-native goes to mk1, mixed goes to senaite, valve off goes to senaite
  - `ruff check . && mypy app`.
- **COABuilder:** a wire-spec BW row overrides the baked spec, and a legacy BW sample is unchanged (golden PDF).
- **Rehearsal:** an accumark-stack with all four repos mounted, running one native BW order end to end and one legacy BW in-flight sample, before any prod deploy.

## Out of scope

- BW variance.
- Native sample transfer.
- Retiring the SENAITE `bac_water` profile, which happens after the legacy drain.

## Addendum (Handler rulings during build, 2026-10-05 to 2026-10-07)

These override the text above wherever they conflict.

1. **Route on the profile key, never on title matching.**
   - Mk1 decides "native-born Bac Water" with `lims_analyses.parent_placeholders.orders_native_bw(db, parent, services)`. It returns True when the parent is native-born and either:
     - the ordered services carry `bacteriostatic-water-panel`, or
     - the parent holds live ordered placeholders of that profile's members.
   - The profile is looked up by key, not through `placeholder_profile_keys`, which ignores inactive profiles.
   - It is used by the check-in hplc fork and by the placeholder slot gate.
   - `is_bw_sample` / title matching has been deleted.
2. **The `BW-` customer id is minted from the profile key.**
   - IS sends `meta["OrderedServiceKeys"]` on the native registry signal: a sorted list of the selected service keys, canonical names, booleans only. It is assigned after the enrichment overlay.
   - Mk1 mints `BW-` when that list contains `bacteriostatic-water-panel`.
   - Mk1 refuses two cases at registration (ValueError): a "Bacteriostatic Water" title without the key, and a non-list shape.
   - P/PB stay title-based, because Peptide and Peptide Blend share one HPLC key.
   - A per-profile prefix setting was considered and deferred until a third primary family exists.
3. **The spec matrix tier and the COABuilder engine choice stay matrix-keyed**, as they are platform-wide.
4. **The IS order-services-updated webhook** rejects the same primary-key conflicts as submit, through a shared helper: `order_validator.services_conflict_messages`.
5. **On the certificate**, the fill-volume Specification cell prints the legacy no-spec glyph U+2014, seeded as `display_override`.

