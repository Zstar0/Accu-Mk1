---
title: "Test-Catalog v1 — Department / Service Group / Analysis Service hierarchy (Sterility tenant, SENAITE-free)"
date: 2026-06-29
status: draft
authors: [ZeroSignal, forrestp]
supersedes: "accumark-stack/docs/superpowers/specs/2026-05-07-pcr-fungi-bacteria-split.md (the parked hardcoded-extend approach)"
---

# Test-Catalog v1 — Department / Service Group / Analysis Service hierarchy

## Summary

Replace the ~20 scattered hardcoded test-grouping literals in Accu-Mk1 with a managed, UI-driven **test catalog**: a three-level hierarchy of **Department → Service Group → Analysis Service**, plus configurable vial requirements, SLA, and an "assignable" flag that drives the intake assignment page dynamically.

This spec delivers **v1 as a thin vertical slice (Option C):** stand up the catalog tables, seed them to reproduce *current* behavior exactly, and migrate the **Sterility** test family — and only Sterility — to be driven by the model. The two new sterility products (**Sterility Screening PCR** and **Sterility USP<71>**) ship as the first tenants of the new model. HPLC and Endotoxin keep their existing hardcoded routing for now and are migrated in later phases.

This slice also makes Sterility the **first SENAITE-free family** (decision: **Full B**). The new services live **only** in Accu-Mk1 — not SENAITE — results flow to the COA without SENAITE, and a sterility-only order creates **no SENAITE Analysis Request** at all. That pulls a sterility-sized slice of native COA sourcing forward and proves the SENAITE phase-out end-to-end on a contained, low-historical-data family, instead of birthing the new services in SENAITE as throwaway debt.

The new schema is the easy part. The load-bearing risk is the **cutover** — replacing live intake decision points and the COA result-source without changing a single physical or reported outcome, while real samples are mid-workflow. The migration is therefore parity-gated (including **COA-output** parity) and rehearsed in an isolated, data-realistic stack.

## Context & supersession

The parked spec `2026-05-07-pcr-fungi-bacteria-split.md` scoped the sterility addons as an **additive extension of the existing hardcoded `ster` bucket** (re-point `STER-PCR` → `PCR-FUNGI`+`PCR-BACTERIA`, add USP<71> wiring across ~7 backend literal maps), with the new services created **in SENAITE**. The business decision that blocked it is now resolved, and the LIMS approach has changed twice over:

- **Offer two sterility products**, not three: drop "Sterility Plate" entirely.
- **Sterility Screening PCR** — internally two assays (Fungi + Bacteria), one vial.
- **Sterility USP<71>** — single compendial sterility test, one vial.
- **Endotoxin is a separate, existing test and is out of scope** (untouched).
- **SENAITE-free (Full B):** the new services are **not** created in SENAITE; sterility reaches the COA natively.

This spec supersedes the parked approach: sterility ships *on* the catalog model and *off* SENAITE, rather than as more hardcoded SENAITE wiring. The parked spec remains the reference for the WP product/pricing specifics.

## Why now / why data-driven

A read-only blast-radius sweep found grouping/routing logic hardcoded in **~20 places** across backend and frontend (demand, seeding, HPLC-mirror exclude, stale-row cleanup, SLA tiers, inbox lane filtering, plus display). Adding each new test family means editing all of them. With **LCMS, heavy metals, vial vacuum, and moisture** all in the near-term pipeline, the marginal cost of the hardcoded pattern is now higher than the cost of the model. The catalog turns "edit 20 literals and pray" into "add rows in the Accu-Mk1 UI." Doing the SENAITE disconnection for these new services now (rather than later) avoids creating SENAITE artifacts we'd only have to unwind.

## Scope — this spec (Catalog v1)

In:

1. New catalog data model (Department, Service Group extensions, Analysis Service extensions).
2. Seed/reconcile the catalog to reproduce current behavior for **all existing groups** (so the assignment page can render from the model), with parity tests.
3. Route the **Sterility family only** — demand, seeding, HPLC-exclude, SLA, assignment visibility — through the model.
4. Convert the two safety-critical deny-by-default couplings (`_NON_HPLC_GROUPS`, inbox `id===1/2`) to model-driven, **failing closed**.
5. Ship the two sterility products end-to-end **with SENAITE out of the loop** — services defined in the Accu-Mk1 catalog only (**not** created in SENAITE), native order→analysis, native vial results, COA sourced from Accu-Mk1, WP products.
6. **SENAITE disconnection (Full B):** cut the three sterility↔SENAITE seams (promote write-back, order→AR creation, coabuilder result-read) and give coabuilder an Accu-Mk1 sterility source + native-sample anchor (see "SENAITE disconnection (Full B)").
7. The parity-gated migration & cutover procedure, including COA-output parity (see "Migration & cutover").

Out (later, separately specced — see "Decomposition"):

- Migrating HPLC + Endotoxin demand/seeding off their hardcoded maps.
- WP-product ↔ catalog **mapping UI** and the **order-flow inversion** (deriving vial demand from the catalog instead of WP-sent flags).
- Fully dynamic per-family assignment for non-sterility families.
- Native COA sourcing + section grouping for **non-sterility families** (HPLC, Endotoxin). Sterility's native COA source **is** in this slice; the rest is Phase 4.

## Decomposition (the broader platform → phased specs)

The Handler's full vision is a test-catalog platform. It is too large for one spec. Proposed phasing, each its own spec → plan → execution cycle:

| Phase | Deliverable | Why this order |
|---|---|---|
| **1 (this spec)** | Catalog model + Sterility tenant + safety-coupling conversion + **SENAITE-free sterility (Full B)** | Smallest blast radius; sterility half-exists already and has near-zero historical data; proves both the model and the phase-out |
| 2 | Migrate HPLC + Endotoxin routing onto the model; retire the hardcoded demand/seeder maps | Highest-traffic families; do only after the model is proven on sterility |
| 3 | WP-product ↔ catalog mapping UI + integration-service order-flow inversion (vial demand derived from catalog, not WP) | Changes the WP↔IS↔Mk1 contract; needs the catalog stable first |
| 4 | Native COA sourcing + section grouping for **HPLC/Endo and remaining families** (coabuilder/SENAITE alignment) | Couple with spec/validation-engine migration. **Note:** the Full-B decision pulls the *sterility* slice of native-COA-sourcing into Phase 1 |

## Target data model

> Naming below is indicative; final column names follow existing conventions in `backend/models.py`. LIMS-side tables keep the `lims_` prefix only where they are LIMS-workflow tables; the catalog tables are configuration, mirroring the existing `service_groups` naming.

### `departments` (new)

| Column | Type | Notes |
|---|---|---|
| `id` | PK | |
| `name` | unique | e.g. "Analytical", "Microbiology" |
| `sort_order` | int | assignment-page block order |
| `color` | str | display |
| `is_system` | bool | reserved for the "Xtra"/overflow pseudo-bucket (see below) |

The assignment page renders **one block per Department**. "Xtra" stays a **system overflow bucket**, not a real department (`is_system`), preserving today's behavior.

### `service_groups` (extend existing)

Add:

| Column | Type | Notes |
|---|---|---|
| `department_id` | FK → departments | a group belongs to exactly one department |
| `vials_required` | int nullable | base aliquots for the group as an assignable unit (see vial semantics) |
| `is_assignable` | bool | does this group appear as an assignment target on the intake page |

Existing columns retained: `name` (unique), `description`, `color`, `sort_order`, `is_default`, `sla_tier_id`.

### `analysis_services` (extend existing)

Add:

| Column | Type | Notes |
|---|---|---|
| `department_id` | FK → departments | **required, single** — the service's home bench. Drives routing; **not** derived from group membership |
| `vials_required` | int nullable | aliquots when the service is a standalone assignable unit |
| `is_assignable` | bool | standalone services that appear as their own assignment target |
| `sla_tier_id` | FK → sla_tiers, nullable | **per-service SLA override** (primarily standalone services; tightest-of-groups otherwise) |

Group membership stays the existing **many-to-many `service_group_members` junction** — no `group_id` column on the service, and **no single-group restriction**. Existing: `keyword`, `category`, `peptide_id`, etc. retained. `keyword` stays the cross-repo join key (coabuilder reads it).

### Invariants / rules

- **Department is a single, direct property of the service.** Every Analysis Service has exactly one `department_id` (its home bench). **Department — not group — drives the structural routing:** the assignment-page block, the HPLC-mirror allow-list, and the worksheet/inbox lane. This stays unambiguous no matter how many groups a service belongs to.
- **Service Groups are many-to-many reusable panels.** A service may belong to several groups (e.g. **pH** in a BacWater panel *and* a future buffer-QC panel) via the existing `service_group_members` junction — **no single-group restriction.** A group is a *product/panel template* (what is ordered together, how many aliquots), not the service's structural parent. The admin UI's current "hide services already in another group" behavior (`ServiceGroupsPage.tsx:240-249`) is relaxed to allow reuse.
- **SLA precedence:** `service.sla_tier_id ?? (tightest target_minutes among the service's groups) ?? default_tier`. This keeps the rule the codebase already implements (`sla-resolution.ts:80-97`, tightest-wins for multi-group) and realizes "SLA on the group, sometimes on the service." A standalone service uses its own tier or the default.
- **Assignable unit = a group, or a standalone service.** You assign "Sterility," never "Fungi" alone. `is_assignable` lives on the **group** (whole service set lands on the vial) and on **ungrouped services** — the catalog analog of the existing per-service "variance assignable" flag. An *assignable* group's member services must share a home department, so the group renders in exactly one department block.
- **Reuse refinement (deferred — Phase 2 / BacWater):** once a service is genuinely shared across groups, the clean way to make per-instance SLA and worksheet scoping unambiguous is to record the **panel (group) context on the ordered analysis instance** (which panel it was ordered under), instead of relying on tightest-wins. **v1 Sterility has no reuse** (Fungi/Bacteria live only in the Sterility PCR group; USP<71> is standalone), so v1 ships with tightest-wins and defers per-instance context until reuse actually lands.

### Vial-requirement semantics

`vials_required` represents **dedicated physical aliquots**, not test count — a single vial can host multiple analyses. Two relationships must be preserved:

1. **Variance composes on top.** The catalog value is the **base** demand; the existing variance model multiplies/adds aliquots for variance testing. Do not fold variance into the base count.
2. **Sum across ordered assignable units.** Total vial demand for a sample = Σ (base `vials_required` of each ordered group/standalone service) then variance applied — exactly how `derive_base_demand` sums `hplc`+`endo`+`ster` today.

**Resolved (Handler, 2026-06-29):** the legacy `ster: 2` is **two methods, not two aliquots-per-assay.** The lab currently runs **both** PCR and USP<71> on every sterility sample — one vial to each method. So:

- **Sterility PCR group** `vials_required = 1` — the single aliquot carries **both** Fungi and Bacteria qPCR assays (two analyses, one vial). Group membership bundles the *analyses*; it does not multiply *vials*.
- **USP<71>** standalone `vials_required = 1`.
- Ordering both → `1 + 1 = 2`, reproducing today's `ster: 2` as an additive per-product sum rather than a hardcoded constant.

This confirms vial demand is **per-product and additive**; the catalog stores `vials_required = 1` on each unit and sums across ordered units (then variance applies).

## Locked decisions

1. **Catalog shape (not a strict tree):** every service has one structural **home Department**; **Service Groups are many-to-many reusable panels** (a service can be in several); services may also be **standalone-assignable** under a department. Department drives routing; groups drive product composition + vial demand + SLA.
2. **Sterility Screening PCR** = a **Service Group** ("Sterility PCR" or similar) in the **Microbiology** department, containing two services: `PCR-FUNGI`, `PCR-BACTERIA`. Sold as one WP product; COA renders two rows.
3. **Sterility USP<71>** = a **standalone Analysis Service** under the **Microbiology** department (no group), with its **own SLA tier**. This is what makes USP<71>'s ~14-day turnaround expressible separately from the rapid PCR group — the per-service SLA override resolves the earlier group-level-SLA tension.
4. **Endotoxin untouched.** Separate existing test/family. Not in this slice.
5. **Reversal from the hardcoded-world advice:** creating the "Sterility PCR" group is correct *because* this slice removes the couplings that made it dangerous (see "Safety-coupling conversion"). Sequence: convert the couplings first, then create the group.
6. **Sequencing = Option C.** Sterility migrates onto the model; HPLC/Endo stay hardcoded until Phase 2.
7. **Additive cutover, not rip-and-replace.** New tables live alongside the old maps; cut over per-path behind a parity gate.
8. **Full B — SENAITE-free sterility.** The new sterility services are defined in the Accu-Mk1 catalog only and are **not** created in SENAITE. Sterility results reach the customer COA without SENAITE.
9. **Sterility-only orders are fully native** — no SENAITE Analysis Request (`mk1://` sample). Mixed orders (with HPLC) still create a SENAITE AR for the HPLC part; sterility is routed natively into Accu-Mk1.
10. **coabuilder stays the single COA merge point.** It gains an Accu-Mk1 sterility result source and the ability to **anchor on a native sample** (for the sterility-only case). One certificate, one builder, two sources — this is how the mixed-sample COA is kept whole.
11. **The promote SENAITE write-back is cut for sterility** — the native Mk1 parent-tier row becomes canonical. Sequenced *after* coabuilder can read native sterility, never before.

## Safety-coupling conversion (why the new group is now safe)

Two couplings are deny-by-default and must be converted *before* the Sterility group exists, or they bite silently:

- **HPLC-mirror exclude — `_NON_HPLC_GROUPS = ("Microbiology","Endotoxin")` (`backend/lims_analyses/seeder.py:109`).** This is a **deny-list**: the HPLC mirror copies the parent AR's analyte set onto HPLC vials *minus* services in those literally-named groups. Default for anything else = **leaks onto HPLC vials**. **Convert to a Department-scoped allow-list:** a service is mirrored onto an HPLC vial only if its Department is **Analytical**. Fails **closed** — a mis-tagged or ungrouped sterility service is excluded by default instead of contaminating chromatography vials. Lock with a regression test asserting no Microbiology service ever appears on an HPLC vial's seeded set.
- **Inbox lane filter — `serviceGroupId === 1 / === 2` (`src/lib/inbox-filters.ts:21-25`).** Hardcoded group ids. A new group (id 3+) → no bench lane. **Convert to read the service's single Department** from the catalog so any Microbiology group lands in the micro lane. This also eliminates the **multi-group inbox flip** — today SENAITE enrichment stamps an arbitrary last-wins group (`main.py:12071`), so a reused service's lane is non-deterministic; keying off the single Department removes that dependency entirely.

Also fold into the same slice (these are name-pinned and would miss the new group otherwise): `_ROLE_GROUP_NAMES` stale-row cleanup (`backend/sub_samples/service.py:31`), `ROLE_TO_GROUP_NAMES` worksheet inbox filter (`backend/main.py:13970`).

## Sterility as first tenant — concrete

| Item | Value |
|---|---|
| Department | Microbiology |
| Group | "Sterility PCR" — `is_assignable=true`, **`vials_required=1`** (one aliquot runs both qPCR assays), SLA = rapid micro tier |
| ├ Service | `PCR-FUNGI` (existing keyword, already a Microbiology member) |
| └ Service | `PCR-BACTERIA` (existing keyword, already a Microbiology member) |
| Standalone service | `USP<71> Sterility` — `STER-USP71` keyword, Department=Microbiology, `is_assignable=true`, **`vials_required=1`**, **own SLA tier (~14-day)** |
| Combined demand | PCR + USP<71> ordered → `1 + 1 = 2` vials (reproduces legacy `ster: 2`); single-product orders → 1 vial (confirmed: lab runs only what's ordered) |
| WP products | Two public products: `sterility-pcr` ("Sterility Screening PCR") and `sterility-usp71` ("Sterility USP<71>"). **No shadow products** — PCR is one product / one line item (Handler, 2026-06-29); the Fungi/Bacteria split stays purely internal. |
| SENAITE | **No new sterility ASs created.** Legacy `STER-PCR` AR lines stay readable for historical/in-flight samples; nothing new is added to SENAITE. |
| integration-service | Sterility routed **natively** — drop the `sterility_pcr`→SENAITE-profile attach (`order_validator.py:148`, `senaite.py:1820`). Mixed order → SENAITE AR for the HPLC part only + native sterility analysis in Mk1; **sterility-only order → no SENAITE AR** (`mk1://`). Replace `sterility_pcr: bool` with per-product flags; back-compat for in-flight `sterility_pcr=True`. |
| coabuilder | Sources sterility (`PCR-FUNGI`/`PCR-BACTERIA`/`STER-USP71`) from **Accu-Mk1**, not SENAITE; learns the new keywords (`ADDON_KEYWORDS`); **anchors on a native sample** when no SENAITE AR exists. HPLC stays SENAITE-sourced; the two sources merge in coabuilder. |

Demand & seeding become **addon-aware** within the existing `ster` bucket (driven by which products were ordered, sourced from the catalog), so a PCR-only order seeds Fungi+Bacteria and a USP<71>-only order seeds USP<71> — no cross-contamination. This replaces the role→all-keywords seeding in `ROLE_TO_KEYWORDS` (`seeder.py:76`).

## SENAITE disconnection (Full B)

Sterility becomes the first family to reach a customer COA with **SENAITE entirely out of the loop**. This is a deliberate scope addition (decision: Full B) — it pulls a sterility-sized slice of native COA sourcing into this phase to avoid birthing the new services in SENAITE as throwaway debt.

### Already native (no work)

- **Vial result entry + storage** — `lims_analyses` + `POST /api/lims-analyses` and `/transitions` (`backend/lims_analyses/routes.py:105,212`, `models.py:1074`). No SENAITE round-trip.
- **Flag-gated native vial creation** — `SUBSAMPLE_NATIVE_CREATE` mints an `mk1://` vial with no SENAITE secondary AR (`backend/sub_samples/native.py:25-46`, `service.py:151-177`). Enable for sterility.
- **Verify / publish / amendment** — already Accu-Mk1/integration-service-mediated; only the COA *content* originated in SENAITE.

### The seams to cut (hardest → easiest)

1. **coabuilder result-read (hardest).** coabuilder fetches the sterility result from the SENAITE AR and has **no** Accu-Mk1 results source — `coabuilder/src/coabuilder_core/senaite_client.py:244,306-318`, `addon_parsing.py:104,169` (`ADDON_KEYWORDS=("ENDO-LAL","STER-PCR")`). **Cut:** give coabuilder an Accu-Mk1 sterility result source and teach `ADDON_KEYWORDS` the new keywords.
2. **Promote write-back (load-bearing).** `promote_to_parent` is **fail-closed** on a SENAITE write-back of the result onto the parent AR line — `backend/lims_analyses/routes.py:345-357`, `senaite_writeback.py:241-277`. Until cut, no vial sterility result becomes a parent/COA result without SENAITE. **Cut:** make the native Mk1 parent-tier row canonical for sterility; stop writing back.
3. **Order → SENAITE AR.** Every order creates a SENAITE AR with the `sterility_pcr` profile — `integration-service/app/services/order_processor.py:437,523`, `senaite.py:1820`. **Cut:** route sterility natively; sterility-only orders create no SENAITE AR.
4. **coabuilder sample anchor.** `fetch_sample_data` finds a sample by **searching for its SENAITE AR** (`senaite_client.py:264-298`). A fully-native sterility-only sample has none. **Cut:** coabuilder anchors on a native Accu-Mk1 sample when no SENAITE AR exists — a one-time entry-level change every future SENAITE-free family reuses.

### Target native path

- **Order →** mixed order: SENAITE AR for the HPLC part **only** + native sterility analysis created in Accu-Mk1. Sterility-only order: **no SENAITE AR** (`mk1://` native sample).
- **Result entry →** native (already).
- **Parent rollup →** promote writes the native Mk1 parent-tier `LimsAnalysis` row (already does, `routes.py:305`); the SENAITE write-back is **removed** for sterility.
- **COA →** coabuilder sources sterility from Accu-Mk1, HPLC from SENAITE, and **merges both into one certificate** (it is already the merge point). Sterility-only certs anchor on the native sample.

### Mixed-sample COA merge

A sample with HPLC (SENAITE) + sterility (Accu-Mk1) stays **one certificate, one builder, two sources** — coabuilder gains the second source rather than a parallel render path. This is why coabuilder, not a separate native Accu-Mk1 COA surface, owns sterility rendering: it preserves single-certificate output for the common mixed case.

### Cut order & the top safety control

The seam-cut order is load-bearing and **must** be:

1. coabuilder can read sterility from Accu-Mk1 (and anchor on a native sample) — **first**.
2. **Then** remove the promote SENAITE write-back. Reversing this order silently drops sterility results from COAs.

**COA-output shadow-diff (top control).** Before cutting the write-back, render the sterility COA section **both ways** — SENAITE-sourced vs Accu-Mk1-sourced — on real samples and diff. Cut only on match. **A wrong sterility result on a customer certificate is the single worst failure in this effort — above the HPLC-leak.** This extends the migration's shadow-read discipline from intake demand to **COA output**. Diff scope differs by product: **PCR** has an existing SENAITE-sourced render → diff Accu-Mk1 vs SENAITE on real samples; **USP<71>** has never been on a COA → nothing to diff against, so validate its render against expected output + lab sign-off instead.

## Migration & cutover (the load-bearing section)

**The schema is greenfield and low-risk — nothing depends on the new tables yet. The risk is the cutover:** replacing live intake decision points (and, for Full B, the COA result-source) with reads from the model, on running-lab code, with samples mid-workflow, without changing any outcome.

### The hardcoded spots are live decisions, not labels

Each currently answers an intake question with a fast literal lookup; the model must return the **identical** answer:

| Decision | Today (hardcoded) | Wrong-migration failure |
|---|---|---|
| Vials to create at check-in | `derive_base_demand` → `ster: 2` (`backend/sub_samples/service.py:837`) | Real samples over/under-provisioned with physical vials |
| Tests seeded onto a vial | `ROLE_TO_KEYWORDS["ster"]=["STER-PCR"]` (`backend/lims_analyses/seeder.py:76`) | Vials get wrong/missing analyses |
| Excluded from HPLC vials | `_NON_HPLC_GROUPS` (`seeder.py:109`) | Sterility analyses **leak onto HPLC vials → onto COAs** |
| Stale-analysis cleanup on role flip | `_ROLE_GROUP_NAMES` (`service.py:31`) | Dead STER rows linger on a now-HPLC vial |
| SLA tier | client-side `src/lib/sla-resolution.ts` | Dashboards breach / under-report |
| Worksheet/inbox lane | `inbox-filters.ts` `id===1/2` (`:21`) | Samples vanish from a bench lane |
| **COA sterility result source (Full B)** | `coabuilder` reads SENAITE AR (`senaite_client.py`, `addon_parsing.py`) | **Wrong/missing sterility result on a customer certificate — top risk** |

None throw on error. They produce a subtly wrong **physical or reported** result on a real sample.

### Three dangers

1. **Current behavior is implicit and was scattered across ~20 literals.** No canonical "what's in Microbiology" was ever written down. The one confirmed apparent contradiction — endo→`{"Microbiology"}` in `_ROLE_GROUP_NAMES` (`service.py:31`) vs a separate `Endotoxin` group named in `_NON_HPLC_GROUPS` (`seeder.py:109`) — is **resolved**: the separate Endotoxin group was a local-only SLA experiment; prod keeps endo under Microbiology (Handler, 2026-06-29). The lesson stands — **reconcile any remaining literal disagreements into the seeded catalog and treat the catalog as the single source of truth.** Seeding an un-reconciled contradiction buries a latent defect in data (harder to find than in code).
2. **In-flight samples can't pause.** `lims_sub_samples.assignment_role` (`backend/models.py:797`) holds `hplc/endo/ster/xtra` on vials mid-test *now*; those vials were seeded under the **legacy** `STER-PCR` keyword and (for sterility) have a SENAITE AR. After cutover every in-flight vial must resolve to the *same* bucket/demand/SLA, and the legacy data must agree with the new model. Engine change while the car is moving.
3. **The HPLC-leak fails open.** A deny-list whose default is "contaminate the HPLC vial." It bites the instant a group is renamed, re-membered, or a service is briefly ungrouped — with **no error**, surfacing as wrong analytes on a chromatography vial, potentially on a customer COA. This is why the allow-list conversion (fail-closed) is a precondition, not a nicety.

Cross-cutting: the spots span **backend and frontend** and must move together, or the UI shows different buckets than the server computes.

### Safe-cutover procedure

1. **Build the catalog tables alongside the old maps.** Both live; nothing deleted.
2. **Reconcile + seed** the catalog to reproduce current behavior for all groups; assert with **parity tests** that the catalog returns the same bucket/demand/SLA the literals do.
3. **Shadow-read / parallel-run:** compute each answer **both ways** on real sample data, diff, and cut a path over only when outputs match. No flip-the-switch.
4. **Convert the fail-open couplings to fail-closed** (`_NON_HPLC_GROUPS` deny→Department=Analytical allow; inbox lane→Department) with dedicated regression tests.
5. **Migrate Sterility only.** HPLC/Endo stay on the literals → blast radius = one family.
6. **Keep the old maps as a fallback/parity check** until the model is proven, then retire in Phase 2.
7. **COA-output parity (Full B):** before cutting the SENAITE write-back, render the sterility COA section **both ways** (SENAITE-sourced vs Accu-Mk1-sourced) on real samples and diff. Cut only on match.
8. **Seam-cut order (Full B):** coabuilder must read sterility from Accu-Mk1 — and anchor on a native sample — **before** the promote write-back is removed, or COAs silently lose sterility results.

**Demand parity caveat — existing vs new orders.** Today every sterility sample is provisioned **2 vials** (lab runs PCR *and* USP<71> for all). Under per-product demand, a **single-product** new order intentionally provisions **1 vial**. So the parity gate must scope its diff to **existing/in-flight samples** (ordered under the old "always both" regime → must still resolve to 2) and **not** flag new single-product orders as regressions. Concretely: parity-test the catalog demand against the legacy `derive_base_demand` for orders carrying the **legacy `sterility_pcr` flag**, and treat the new per-product flags as new behavior outside the parity set. (Confirmed: the lab runs only what's ordered, so this caveat is live — new single-product orders legitimately demand 1 vial and must not be flagged as regressions.)

### Execution environment

Rehearse the cutover — including in-flight samples and the COA-output diff — against **production-shaped data in an isolated stack** (the accumark-stack platform spins up complete, data-realistic, isolated stacks per agent) so the migration never touches the live host until parity is proven. Invoke the `accumark-stack-platform` skill at execution time.

## Cross-repo touchpoints

- **integration-service:** order model expands (`sterility_pcr: bool` → per-product flags/addons list); back-compat for in-flight orders. **Full B:** stop attaching the `sterility_pcr` SENAITE profile (`order_validator.py:148`, `senaite.py:1820`); route sterility natively into Accu-Mk1; sterility-only orders skip SENAITE AR creation entirely. **Phase 3** later inverts the flow so vial demand is derived from the catalog mapping rather than WP-sent counts.
- **coabuilder:** **Full B:** gains an Accu-Mk1 sterility result source (today it is SENAITE-only — `senaite_client.py:244`, `addon_parsing.py:104,169`), learns `PCR-FUNGI`/`PCR-BACTERIA`/`STER-USP71` in `ADDON_KEYWORDS`, and anchors on a native sample when there is no SENAITE AR. HPLC remains SENAITE-sourced and merges with sterility in coabuilder. COA *section grouping* from the catalog (vs keyword) is still Phase 4.
- **WordPress:** two public products this slice. Mapping-management UI is **Phase 3**.

## ISO 17025 alignment

- **7.4.2 identification / traceability:** the catalog becomes the canonical, versioned definition of what each test *is* and which aliquots/analyses it entails — stronger traceability than scattered literals. The SENAITE-free path must preserve the same sample/analysis traceability natively (parent-tier `LimsAnalysis` + promotion link rows).
- **7.11.2 LIMS change validation:** the parity tests, shadow-read diffs, **and the COA-output shadow-diff** are the validation evidence for the intake-logic and COA-source changes; retain them.
- **7.5.2 / 8.4 traceable amendments & 8.3 document control:** managing test definitions in the UI is a change-control surface — record who changed catalog rows and when (audit fields). The USP<71> preliminary-then-amend COA flow (open question #8) must produce a traceable amendment, not a silent overwrite.

## Open questions / decisions-to-confirm

1. **Run-both vs run-ordered — RESOLVED (Handler, 2026-06-29):** the lab runs **only what's ordered**. PCR-only → 1 vial, USP<71>-only → 1 vial, both → 2. Vial demand is **per-product additive**. The demand-parity caveat below is therefore live (existing 2-vial samples vs new single-product 1-vial orders).
2. **COA reporting today — RESOLVED (Handler, 2026-06-29):** only **Sterility PCR** is on customer COAs today; USP<71> has been **internal-only**. This spec makes USP<71> a sold product that renders on the COA for the **first time** — so for USP<71> there is **no prior SENAITE-sourced COA render to shadow-diff against**; it is net-new COA content validated against expected output + lab sign-off. PCR *does* have an existing SENAITE-sourced render, so the COA-output shadow-diff (top control) applies to PCR.
3. **USP<71> SLA tier:** confirm target turnaround (~14-day?) for its per-service tier.
4. **PCR shadow products — RESOLVED (Handler, 2026-06-29):** **dropped.** PCR is one website product / one line item; no `pcr-fungi`/`pcr-bacteria` shadow children. The Fungi/Bacteria split stays purely internal (two analyses, one vial, one product).
5. **Reconciliation — NEEDS PROD VERIFICATION (conflict found 2026-06-29):** the Handler recalled the separate `Endotoxin` service group as a local-only SLA experiment. **`seeder.py:104-109` contradicts that** — its comment states Endotoxin is its *own* prod group containing `ENDO-LAL`, added to `_NON_HPLC_GROUPS` to fix a real leak (incident **BW-0015-S01**, an Endotoxin row on an HPLC vial). So whether prod has a distinct `Endotoxin` group is **unconfirmed** — confirm against prod's Service Groups before seeding (danger #1: never seed an assumption); **the seed must be derived from the live group rows, not hardcoded.** **Robustness note:** this does NOT block the Department model — `ENDO-LAL` maps to the **Microbiology department** either way (the assignment UI already nests Endo under Microbiology), so the Department-scoped HPLC allow-list excludes it correctly regardless of whether a distinct `Endotoxin` *group* (cosmetic/SLA) survives.
6. **Worksheet bench keying:** Department or Group? (Today: group.)
7. **Pricing:** real prices for both products (lab/accounting; not an engineering blocker).
8. **USP<71> COA timing (Full B / amendments):** USP<71> is ~14-day, PCR is rapid. Does the COA issue PCR results first as a **preliminary** certificate and **amend** when USP<71> completes, or hold the COA until both are done? Drives the native amendment flow (7.5.2).

## Effort & risk

- **Schema + seed + parity harness:** a few days (greenfield).
- **Sterility intake cutover + coupling conversion:** the existing-system bulk; risk concentrated in the shadow-read/parity work, not the new code.
- **Full B (SENAITE disconnection):** the largest *new* build — coabuilder Accu-Mk1 sterility source + native-sample anchor, integration-service native order→analysis branch, and cutting the fail-closed write-back. Concentrated in the **customer-facing COA pipeline**.
- **Top residual risk:** a **wrong sterility result on a customer certificate** during the COA-source cutover — *above* the HPLC fail-open leak. Mitigated by the COA-output shadow-diff, the strict seam-cut order (coabuilder reads native before the write-back is cut), and isolated-stack rehearsal. The HPLC-leak remains the #2 risk, mitigated by sequencing the allow-list conversion first.

## Cross-references

- Parked predecessor: `accumark-stack/docs/superpowers/specs/2026-05-07-pcr-fungi-bacteria-split.md`
- Backlog: `accumarklabs/.planning/ROADMAP.md` (Sterility Addons, Phase 999.2)
- Spec/validation-engine migration (couple with Phase 4): move conformance/spec logic into Accu-Mk1 Analysis Services result settings.
- accumark-stack platform (execution isolation): `accumark-stack/docs/superpowers/specs/2026-05-07-accumark-stack-platform-design.md`

## Out of scope

- Phases 2–4 (HPLC/Endo routing migration, WP-mapping UI + order-flow inversion, native COA sourcing **for non-sterility families**, COA catalog section-grouping). Sterility's native COA source is **in** this slice (Full B).
- Endotoxin changes.
- A generic "any future test split is config-only" abstraction beyond the three-level model.
