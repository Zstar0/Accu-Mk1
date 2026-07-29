---
title: "Analysis Catalog Foundation — Departments, Mk1-native Analysis Services, Analysis Profiles"
date: 2026-07-28
status: draft
authors: [ZeroSignal, forrestp]
supersedes_in_part: "docs/superpowers/specs/2026-06-29-test-catalog-hierarchy-design.md (keeps Department; rejects group-as-orderable-unit; adds Analysis Profile)"
part_of: "New-test-families program, spec 1 of 3 (foundation → COA sections → order routing)"
---

# Analysis Catalog Foundation

## Summary

Make the Accu-Mk1 analysis catalog **real, editable, and Mk1-owned**, so that new test families
(Heavy Metals, Moisture Content, Sterility USP<71>, à-la-carte pH, and the LCMS / vial-vacuum
pipeline behind them) can be defined from the admin UI instead of by editing literals across four
repositories.

This spec delivers the **structural foundation only**. Three things land:

1. **Departments** — the single structural home for a service (ported from PR #31), plus the
   fail-closed HPLC allow-list that conversion enables.
2. **Analysis Services get full CRUD**, Mk1-native. A service created in Accu-Mk1 is never written
   to SENAITE and never overwritten by a SENAITE sync.
3. **Analysis Profiles** — a new entity representing *the sellable test*: the parent of one or more
   Analysis Services, and the future carrier of COA section identity.

Everything here is **additive and parity-gated**. When this slice ships, no customer-visible
behavior changes: no COA renders differently, no order routes differently, no vial demand changes.
The catalog simply becomes a managed surface that reproduces today's hardcoded behavior from rows.

## Why now

A read-only sweep found test-family identity hardcoded in ~20 places across Accu-Mk1, Integration
Service, and COABuilder. Adding one family today means coordinated edits to all of them.

The clearest evidence that the pattern is actively spreading:
`src/lib/inbox-filters.ts:65-69` already contains
`{ value: 'moisture', label: 'Moisture Content', keyword: 'KF', titleRe: /moisture/i }` —
one of the three target families, half-implemented as a frontend constant, next to hand-written
entries for endotoxin and sterility.

Separately, `backend/sub_samples/product_registry.py` holds a `PRODUCT_REGISTRY` dict whose own
docstring reads *"Adding a product = add one ProductDef."* That file is the Analysis Profile
concept, already written, in Python instead of rows. This spec promotes it.

New services must not be born in SENAITE — that would create artifacts the phase-out program would
only have to unwind (see `2026-07-13-workflow-shadow-engine-design.md` and the phase-out section
order).

## Locked decisions (Handler, 2026-07-28)

1. **Service Groups keep their current meaning** — the bench/worksheet grouping. They are *not* the
   orderable unit. This reverses the 2026-06-29 spec's `vials_required` / `is_assignable` on
   `service_groups`.
2. **Analysis Profile is a new entity** — the sellable test, parent of 1..N Analysis Services.
3. **Analysis Services get full CRUD in Accu-Mk1.** Services created here never live in SENAITE.
4. **SENAITE sync is scoped, not switched off.** Peptide identity services are still born in
   SENAITE (`run_senaite_clone`, or a lab tech manually when `senaite_clone_enabled` is false), and
   COABuilder still reads peptide results from the SENAITE AR. Sync must survive for that legacy
   set while becoming non-destructive to Mk1-owned data.
5. **Spec limits stay in COABuilder for now** (`baked_specs.py` pattern), to ship the new families
   sooner. They move to Mk1 with the conformance-engine migration.
6. **One WooCommerce product maps to one Profile.** Bundles ("AccuShield") are WooCommerce
   *coupons* applied to separate line items — verified: no bundle plugin is installed, and
   `Sample_Submission.php:257-273` instantiates `new \WC_Coupon('AccuShield Panel')`. The bundle
   never crosses into the LIMS as a structure.
7. **Heavy Metals requires its own vial.**
8. **Bacteriostatic Water is left as-is.** It is discriminated by SENAITE `SampleTypeTitle`, not by
   any panel concept — a deliberate shortcut that is not the template for new work.
9. **Pricing on profiles is a future direction, not specced here.**

## Three concepts, one job each

The 2026-06-29 spec left Service Group meaning four things at once. This model gives each concept a
single job.

| Concept | Job | Drives | Example |
|---|---|---|---|
| **Department** | The structural home / bench | HPLC-mirror allow-list, inbox lane, assignment block, role-flip cleanup | Analytical, Microbiology |
| **Service Group** | The unit of bench work — what a tech runs together | Worksheet composition, SLA tier | Analytics, Microbiology |
| **Analysis Profile** | The unit of sale and of reporting | What is ordered, vial demand, COA section | Heavy Metals, pH Testing |

### Why Profile cannot be Service Group

Three structural reasons, each independently sufficient:

- **A product spans departments; a bench group cannot.** Bacteriostatic Water's panel is benzyl
  alcohol (Analytical, HPLC), pH, and `ENDO-LAL` (Microbiology). Making groups the sellable unit
  requires a group spanning two departments, which breaks the one-department-per-group invariant
  the fail-closed HPLC allow-list depends on.
- **The group is already the unit of bench work.** A worksheet item carries `service_group_id`
  (`backend/models.py:643`), and `worksheet_analyst._resolve()` selects that worksheet's analyses by
  joining `service_group_members` on it (`backend/lims_analyses/worksheet_analyst.py:34-54`). If pH
  is sold à la carte *and* is a member of a BacWater panel, group-as-product makes worksheet
  scoping ambiguous — reintroducing the non-deterministic last-wins behavior Departments exist to
  remove.
- **The COA section must derive from what was *ordered*, not from membership.** A service in two
  profiles renders in whichever profile the customer bought. Group membership cannot express that.

A `kind` discriminator (`'bench'` vs `'product'`) on a single table was considered and **rejected**:
service groups have seven live runtime consumers including the COA pre-flight blocking gate
(`backend/main.py:9779`), each of which would need a filter added. Missing one produces a silent
defect in an area with a documented fail-open incident history.

### Why a single-service test still gets a Profile

à-la-carte pH wraps one service. It still needs a Profile because the Profile — not the service —
carries the *reporting identity*: the COA section title, the render archetype, the row order, and
(later) the price. A bare service has nowhere to hang any of that.

## Data model

Accu-Mk1 uses `create_all` plus hand-rolled idempotent `ALTER` statements in `backend/database.py`
(see `architecture_db_migrations`). All additions below follow that pattern.

### `departments` (new — port verbatim from PR #31)

| Column | Type | Notes |
|---|---|---|
| `id` | PK int | |
| `name` | String(200), unique, NOT NULL | "Analytical", "Microbiology" |
| `sort_order` | int, NOT NULL, default 0 | assignment-page block order |
| `color` | String(50), NOT NULL, default "blue" | display |
| `is_system` | bool, NOT NULL, default false | reserved for the "Xtra" overflow pseudo-bucket |
| `created_at` / `updated_at` | DateTime | |

### `analysis_services` (extend)

| Column | Type | Notes |
|---|---|---|
| `department_id` | FK → departments, ON DELETE SET NULL, nullable | **From PR #31.** The service's single structural home. Drives routing. |
| `origin` | String(20), NOT NULL, server_default `'senaite'` | **New.** `'senaite'` \| `'mk1'`. Governs sync behavior and keyword rules. |
| `local_overrides` | JSONB, nullable | **New.** List of field names Mk1 owns for this row; sync skips them. Generalizes the existing local-wins behavior at `backend/main.py:3013-3016`. |

**Port only `department_id` from PR #31's service/group column additions.** PR #31 also adds
`vials_required`, `is_assignable`, and `sla_tier_id` to `analysis_services`, and
`vials_required`/`is_assignable`/`department_id` to `service_groups` — those came from the old
group-as-orderable-unit model. Under this design vial demand belongs to the **Profile** and SLA
stays on the **Group**, so those columns would ship dead. Leave them out; dead schema is how a
superseded model quietly becomes permanent. (`service_groups.department_id` *is* wanted — it is
what puts groups under departments.)

**Keyword uniqueness — the landmine.** `keyword` is nullable and non-unique today, and duplicates
exist in production: `backend/lims_analyses/parent_mirror.py:28` records that a sync re-run
"cloned two `PUR_TB500BETA4` rows." Keyword is simultaneously the cross-repo join key — COABuilder
indexes every result by SENAITE `Keyword`, and the baked spec limits this program depends on are
keyed by `(SampleTypeTitle, Keyword)`.

Resolution, additive and fail-safe:

- Add a **partial unique index** on `keyword` `WHERE origin = 'mk1'`. Legacy SENAITE-origin rows keep
  their current (broken) uniqueness; cleaning them is separate work and out of scope here.
- **Cross-origin collision check on create.** The partial index alone does not stop a native service
  from claiming a keyword a SENAITE-origin service already uses (`ENDO-LAL`, say). That collision is
  not cosmetic: in spec 2 COABuilder would receive the same keyword from the SENAITE add-on block
  *and* from a native section and print it twice. Creating or renaming an Mk1-origin service must be
  **refused if the keyword exists on any service of either origin**, active or not.
- Mk1-origin keywords are **validated on create** (non-empty, uppercase alphanumeric plus `-`/`_`,
  no leading digit) and **immutable once referenced** by any `lims_analyses` row.

### `service_groups` (extend)

| Column | Type | Notes |
|---|---|---|
| `department_id` | FK → departments, ON DELETE SET NULL, nullable | **From PR #31.** Puts groups under departments. |

No other change. The group keeps `name`, `description`, `color`, `sort_order`, `is_default`,
`sla_tier_id`, and its existing `service_group_members` junction, and keeps its current runtime
meaning.

### `analysis_profiles` (new)

| Column | Type | Notes |
|---|---|---|
| `id` | PK int | |
| `key` | String(100), unique, NOT NULL | The order key WordPress sends (e.g. `heavy_metals`). Immutable once referenced by an order. |
| `name` | String(200), NOT NULL | Customer-facing ("Heavy Metals") |
| `description` | Text, nullable | |
| `is_addon` | bool, NOT NULL, **no default** | Mirrors `ProductDef.is_addon`. Deliberately undefaulted: two of the five seeded profiles are primaries (`hplcpurity_identity`, `bac_water_panel`), and a default would silently demote a mis-seeded primary to an add-on. Always stated explicitly. |
| `vials_required` | int, NOT NULL, default 0 | Base dedicated aliquots. `0` = rides an existing vial. Variance composes on top; never fold it in. |
| `fulfillment_role` | String(50), nullable | Vial value that fulfills it — mirrors `ProductDef.fulfillment_role` |
| `fulfillment_dim` | String(20), NOT NULL, default `'role'` | `'role'` (assignment_role) or `'kind'` (assignment_kind) |
| `sort_order` | int, NOT NULL, default 0 | |
| `active` | bool, NOT NULL, default true | |
| `updated_by_id` | FK → users.id, nullable | ISO 17025 8.3 change control |
| `created_at` / `updated_at` | DateTime | |

**No `department_id` on the Profile.** Each member service already declares its own department, so
bench routing and vial fulfillment derive per-service. This handles a cross-department panel like
BacWater naturally rather than by special case, and keeps Department the single structural
authority the fail-closed allow-list trusts.

### `analysis_profile_members` (new junction)

| Column | Type | Notes |
|---|---|---|
| `analysis_profile_id` | FK → analysis_profiles, ON DELETE CASCADE, NOT NULL | |
| `analysis_service_id` | FK → analysis_services, ON DELETE CASCADE, NOT NULL | |
| `sort_order` | int, NOT NULL, default 0 | Row order within the COA section |

Unique constraint on `(analysis_profile_id, analysis_service_id)`.

Membership is **many-to-many on purpose**: pH belongs to a "pH Testing" profile *and* to a future
BacWater panel profile.

## Invariants

- Every Analysis Service has **exactly one** Department. Department — not group, not profile —
  drives structural routing.
- A service may belong to **several Service Groups** and to **several Profiles**.
- A **Profile may span Departments**; a Service Group may not.
- `keyword` is the cross-repo join key. Unique among Mk1-origin services; immutable once used.
- **Nothing in this spec creates, updates, or deletes any SENAITE object.**

## Safety-coupling conversion (PR #31 § 1B)

These must land with the model, because creating new catalog rows exposes them:

- **HPLC-mirror exclude.** `_NON_HPLC_GROUPS` (`backend/lims_analyses/seeder.py:109`) is a
  **deny-list** whose default for anything unrecognized is *leak onto the HPLC vial* — it has bitten
  before (incident BW-0015-S01, an Endotoxin row on an HPLC vial). Convert to a **fail-closed
  Department allow-list**: mirror a keyword only if its service's `department_id` is Analytical;
  abort the mirror entirely if the Analytical department is missing. Microbiology, NULL, and
  mis-tagged services are excluded by default.
- **Inbox lane filter.** `src/lib/inbox-filters.ts:21-25` tests `serviceGroupId === 1` and `=== 2` —
  magic integer primary keys. Convert to read the service's Department.
- **Role-flip stale cleanup.** `_ROLE_GROUP_NAMES` (`backend/sub_samples/service.py:33-39`) keys off
  group names. Convert to Department.
- **Keep `_micro_group_keywords`** for the COA-generation blocking gate (`backend/main.py:9779`).
  PR #31 already retains it with a fail-closed guard; do not remove it in this slice.

## Parity seed and gate

Nothing is invented. The catalog is seeded to reproduce current behavior, and a parity test proves it.

1. **Departments seeded from live group rows, not hardcoded.** Whether production has a distinct
   `Endotoxin` service group is unconfirmed (open gate G5 from the prior program) — the seed must
   derive from what is actually there. `ENDO-LAL` maps to Microbiology either way, so the allow-list
   is correct regardless.
2. **Backfill `department_id`** on every service. Ungrouped per-analyte services (`ANALYTE-N-*`) are
   tagged Analytical, or the fail-closed allow-list would drop exactly the rows the HPLC mirror
   exists to carry. PR #31 already implements and tests this.
3. **Seed Profiles from `PRODUCT_REGISTRY`** — the five service-key products (`hplcpurity_identity`,
   `bac_water_panel`, `endotoxin`, `sterility_pcr`, `variance`), each with its existing label,
   `is_addon`, and fulfillment fields.
4. **Parity gate:** `build_ordered_products(services, package)` must return byte-identical output
   whether it reads `PRODUCT_REGISTRY` or the `analysis_profiles` table, across every combination of
   services and package values. This is the single live read flipped by this slice; everything else
   is inert.

**Fail-open must survive the flip.** `build_ordered_products` today is deliberately fail-open: an
unregistered service key still renders, synthesised as
`ProductDef(key, _derive_label(key), True, None, "role")` with a log warning
(`backend/sub_samples/product_registry.py:87-89`), and unknown `package` values get the same
treatment at `:60-63`. That function feeds `GET /sub-samples/{id}/ordered-products` — the sample
page's PRODUCTS section. A table-backed lookup that raises or returns nothing on a miss converts a
cosmetic degradation into a 500 on a live sample page.

The profiles-backed read **must preserve the same synthesis-and-warn behavior for keys with no
matching profile row**, and that needs its own test — an equality assertion across known
combinations would pass while the unknown-key path silently regressed.

The `package` values (`core`, `accushield`) stay **display-only labels** and are not modelled as
profiles. They already have no functional effect beyond rendering a chip and suppressing a redundant
HPLC chip (`backend/sub_samples/product_registry.py:84-85`).

## Sync behavior after this slice

| Row | Sync behavior |
|---|---|
| `origin = 'senaite'` | Synced as today, **except** fields listed in `local_overrides`, which sync skips. |
| `origin = 'mk1'` | **Never touched by sync.** Not updated, not deactivated, not deleted. |

This is what makes "edit every field" safe without breaking peptide onboarding. Editing any
sync-owned field on a SENAITE-origin service adds that field name to `local_overrides`, so Mk1's
value wins from then on.

**Per-field, not per-row — decided.** This generalizes a pattern the codebase already runs:
`_apply_service_result_type` no-ops when `result_type` is already set (`backend/main.py:3013-3016`),
and `variance_capable` is never touched by sync at all. The coarser alternative — "Mk1 wins entirely
once a row is edited" — would freeze `title`, `unit`, and `category` the first time someone corrects
a `result_type`, quietly detaching that service from SENAITE for every field.

## Admin UI

Two pages, both following the existing `ServiceGroupsPage.tsx` patterns (create / edit / delete /
many-to-many membership), so this is largely composition rather than new interaction design.

- **Analysis Services** (`AnalysisServicesPage.tsx`) gains create and delete, and full-field edit.
  Delete is refused for any service referenced by a `lims_analyses` row — deactivate instead.
  SENAITE-origin and Mk1-origin rows are visually distinguished, since their edit semantics differ.
- **Analysis Profiles** — new page: profile CRUD plus service membership with row ordering.
- **Departments** — CRUD ported from PR #31.

## Deliberately deferred

- **COA rendering.** The Profile is the COA section carrier, but the `coa_*` columns and the render
  archetype vocabulary are defined in **spec 2**, alongside the renderer that consumes them.
  Specifying an archetype vocabulary before designing the renderer would be guessing.
- **Order routing.** WordPress products for the new families, and Integration Service resolving
  product keys against profiles instead of hardcoded booleans, are **spec 3**. `vials_required` and
  the fulfillment columns land here as inert data and are wired there.
- **Spec limits in Mk1.** Stays in COABuilder's `baked_specs.py` until the conformance-engine
  migration.
- **HPLC/Endotoxin demand migration** off `ROLE_TO_KEYWORDS` / `derive_base_demand`. Those literals
  stay live and authoritative.
- **BacWater rework**, legacy duplicate-keyword cleanup, pricing, and SENAITE sync removal.

## Risks

| Risk | Mitigation |
|---|---|
| Legacy duplicate keywords block a global unique index | Partial unique index scoped to `origin='mk1'`; legacy cleanup is separate work |
| Fail-closed allow-list under-includes if the backfill mis-tags a service | PR #31 tags ungrouped `ANALYTE-*` as Analytical, warns on NULL-department services, and locks it with a regression test asserting no Microbiology service appears on an HPLC vial |
| Group-name-pinned consumers not converted in this slice still miss new rows | This slice creates no *group* rows — only departments and profiles. `ROLE_TO_GROUP_NAMES` stays authoritative until spec 3 |
| Production `Endotoxin` group existence unconfirmed | Seed derived from live rows, never hardcoded |
| A UI-created service reaching a certificate without a spec limit | Out of scope here — no service created in this slice reaches a COA. Enforced in spec 2 |

## Testing

- **Parity:** `build_ordered_products` output identical from `PRODUCT_REGISTRY` vs the profiles
  table, across all service/package combinations.
- **Fail-open preserved:** a service key and a `package` value with no matching profile row each
  still render a synthesised chip with a logged warning — never an exception, never a dropped chip.
- **Regression (safety):** no Microbiology-department service ever appears in an HPLC vial's seeded
  set; the mirror aborts if the Analytical department is absent.
- **Keyword rules:** duplicate Mk1-origin keyword rejected; a native keyword colliding with an
  existing **SENAITE-origin** keyword rejected (the double-render hazard in spec 2); keyword edit
  refused once a `lims_analyses` row references it; format validation.
- **Sync non-destructiveness:** a full sync pass leaves `origin='mk1'` rows and every field named in
  `local_overrides` untouched.
- **Backfill idempotency:** re-running the department backfill is a no-op (PR #31 has this).
- **Additive proof:** gate on a failure-set diff against master in the same virtualenv, never on
  zero failures (see `architecture_mk1_test_baseline_failures`).

## Execution environment

Rehearse the backfill and the parity flip on a **production-shaped isolated devbox stack** via the
accumark-stack platform, not against the live host. Invoke the `accumark-stack-platform` skill at
execution time.

## ISO 17025 alignment

- **7.4.2 identification and traceability** — the catalog becomes the canonical, managed definition
  of what each test is and which analyses it entails, replacing scattered literals.
- **7.11.2 LIMS change validation** — the parity tests and the fail-closed regression tests are the
  validation evidence for this change; retain them.
- **8.3 document control** — managing test definitions in the UI is a change-control surface;
  `updated_by_id` and timestamps on catalog rows record who changed what and when.

## Open questions

1. **Do `fulfillment_role` / `fulfillment_dim` belong on the Profile now, or in spec 3?** Included
   here as inert columns so the `PRODUCT_REGISTRY` seed is faithful; no consumer reads them yet.
2. **Audit depth** — `updated_by_id` plus timestamps, or a full per-change audit row? The heavier
   option is likely warranted once limits move into Mk1, not before.

(The `origin` / `local_overrides` mechanism was an open question in draft and is now **decided** —
see "Sync behavior after this slice".)

## Cross-references

- `docs/superpowers/specs/2026-06-29-test-catalog-hierarchy-design.md` — prior program; Department
  concept retained, group-as-orderable-unit rejected
- PR #31 (`feat/test-catalog-v1`) — source of the Department model and the safety-coupling conversion
- `backend/sub_samples/product_registry.py` — the hardcoded registry this promotes
- Spec 2 (native result → COA section pipeline) and spec 3 (order routing) — the remaining slices
