---
title: "Catalog Order Routing — WooCommerce products to Analysis Profiles, catalog-driven vial demand"
date: 2026-07-28
status: draft
authors: [ZeroSignal, forrestp]
depends_on:
  - "docs/superpowers/specs/2026-07-28-analysis-catalog-foundation-design.md (spec 1)"
  - "docs/superpowers/specs/2026-07-28-native-coa-sections-design.md (spec 2)"
part_of: "New-test-families program, spec 3 of 3 (foundation → COA sections → order routing)"
---

# Catalog Order Routing

## Summary

Close the loop: let a customer **buy** a new test family, and let that purchase drive vial demand and
analysis seeding from the catalog instead of from hand-synced literals.

Four changes, one per layer:

1. **WordPress** carries an explicit, stable profile key on the product instead of deriving it from
   the product's display name.
2. **Integration Service** stops silently discarding service keys it doesn't recognise and rejects
   them loudly at ingest.
3. **Accu-Mk1** derives vial demand by summing `vials_required` over the ordered Analysis Profiles,
   and seeds a vial's analyses from profile membership.
4. **Vial roles stay a code-level enum** — a deliberate, bounded residual, documented as a checklist
   rather than pretended away.

After this, adding a family is: create the services and profile in the Mk1 admin UI, add one role
literal, add one key to the Integration Service map, and publish a WooCommerce product with the
profile key on it. No hand-synced demand maps, no keyword whitelists, no display-name coupling.

## Why now

`backend/main.py:15589-15590` carries this comment above `ROLE_TO_GROUP_NAMES`:

> *Hardcoded — the lab has had Analytics + Microbiology for years and a 2-entry mapping doesn't
> deserve a table.*

That was a reasonable call when it was written. Its premise — that the set is small and stable — is
exactly what this program invalidates. Heavy Metals, Moisture, à-la-carte pH, USP<71>, LCMS, and
vial vacuum are all in the pipeline.

`backend/lims_analyses/seeder.py:62-64` makes the cost explicit about its own maps:

> *These mirror the keys consumed by `derive_demand()` … **kept in sync by hand**. If a key is added
> there … mirror the addition here.*

Two hand-synced maps, in two files, that must agree or vials are provisioned wrongly.

## The headline: unknown service keys are silently discarded

**This is the most dangerous finding in the program, and it must be fixed before any new product is
published.**

`SampleServices` (`integration-service/app/models/order.py:110-155`) declares one typed boolean per
service and sets only `class Config: populate_by_name = True`. It sets **no `extra` policy**, so
Pydantic's default — `extra='ignore'` — applies.

If WordPress sends `heavy_metals: true` before Integration Service has a field for it, the key is
**dropped without error**. The order succeeds. The customer is charged. No vial is provisioned, no
analysis is seeded, and nothing anywhere records that a paid test was requested. The first sign of
trouble is a customer asking where their heavy-metals result is.

**Fix: capture extras and reject unknown keys at ingest**, failing the order loudly.

Rejection is a well-handled path, not a new failure mode: Integration Service already returns
**422** for order-validation failures (`app/api/webhook.py:457`, `:664-667`), and
`order_submissions` records per-sample `success` / `partial` / `failed` status with retry attempts
(`app/services/order_processor.py:802-807`). A rejected order is loud, recorded, and retryable.

**Validate against Integration Service's own declared key set — do not call Mk1 to validate.** Adding
a catalog fetch to order ingest would put a new cross-service dependency on the order path, where a
failure loses a customer order. That is the same objection that made spec 2 choose push over pull,
and it is worse here. Integration Service already owns `SERVICE_TO_PROFILE`
(`app/services/order_validator.py:142-151`); extending it is a one-line change per family and is
required regardless.

## Locked decisions

1. **Vial demand becomes catalog-driven. The role vocabulary stays a code-level enum.** See
   "Vial roles" — this is a deliberate, bounded residual, not an oversight.
2. **WordPress sends an explicit profile key**, never a mangled display name, for new families.
3. **Integration Service rejects unknown service keys with 422** rather than ignoring them.
4. **Deploy order is load-bearing:** Integration Service first, then Accu-Mk1, then the WordPress
   product publish. Publishing a product before Integration Service knows its key is precisely the
   silent-drop failure above.
5. **Spec 2 ships before any new product goes on sale.** A family a customer can buy but that cannot
   print on a certificate is worse than one they cannot buy yet.

## Layer 1 — WordPress: an explicit profile key

Today the wire key is derived from the product's **display name** by lossy string mangling:

```php
$normalized_key = strtolower(str_replace([' ', '-', '_', '&', '(', ')'], '', $key));
```

(`wp-content/themes/wpstar/src/Front/Cart_Order.php:1407`, and again at `:1627` for the service map.)

So `"Rapid Sterility Screening (PCR)"` becomes `rapidsterilityscreeningpcr`, while Integration
Service's field is `sterility_pcr` with alias `rapidsterilityscreening(pcr)`. That family of
mismatches is the "load-bearing WP fix" the prior program flagged — and worse, **renaming a product
silently changes its wire key**, breaking routing with no error anywhere.

**Fix:** a WooCommerce product meta field, `_accumark_profile_key`, holding the Mk1 profile key
verbatim. WordPress sends that value untouched.

- The normalizer **stays** for the existing five keys — back-compat for in-flight orders and for
  products that predate this change. It is not removed in this slice.
- **New families never go through it.** A product without `_accumark_profile_key` falls back to the
  legacy normalizer; a product with one bypasses it entirely.

New products: Heavy Metals, Moisture Content, pH (à la carte). Pricing is lab/accounting-owned
(gate G-P) and can be scaffolded with a placeholder, but not published without it.

## Layer 2 — Integration Service: accept, validate, pass through

- **Capture unknown keys** rather than ignoring them, and **reject** any key not in the declared set
  with a 422 naming the offending key.
- **Extend `SERVICE_TO_PROFILE`** with the new keys. New families are Mk1-native and have **no
  SENAITE profile**, so they must map to a sentinel that means "native — do not attach a SENAITE
  profile," never to a profile UID. The SENAITE profile-attach branches
  (`app/adapters/senaite.py:1773`, `:1826`) must skip them.
- **Existing typed fields stay untouched.** No change to `hplcpurity_identity`, `endotoxin`,
  `sterility_pcr`, `bac_water_panel`, `residualsolvents`, `samplevariance`, or `variance`.
- **`published_coa_result` gets no new per-family columns** (Handler ruling, carried from spec 2).

## Layer 3 — Accu-Mk1: catalog-driven demand and seeding

### Demand

`derive_base_demand` (`backend/sub_samples/service.py:1187`) hardcodes three buckets and the literal
`ster: 2`. The catalog resolver instead sums `vials_required` across the ordered profiles, then
variance composes on top as it does today — **never fold variance into the base**.

**Parity discipline, same as spec 1:** the catalog resolver is built alongside the legacy function
and shadow-read against it before anything flips. Parity is asserted for **the five existing service
keys only**; new profile keys are new behavior and sit outside the parity set by construction, since
no legacy path ever produced demand for them.

### Seeding

`ROLE_TO_KEYWORDS` (`backend/lims_analyses/seeder.py:76-80`) whitelists `ENDO-LAL` for `endo` and
`STER-PCR` for `ster`. The catalog path resolves a vial's analyses from
`analysis_profile_members` for the profiles that fulfil that role.

HPLC is deliberately absent from `ROLE_TO_KEYWORDS` and stays absent — HPLC vials **mirror** the
parent's Analytical analyte set (`mirror_parent_hplc_analyses`) rather than seeding a whitelist.
Spec 1's fail-closed Department allow-list already governs that path.

### Resolve the two hand-synced maps

`ROLE_TO_WP_KEYS` exists to answer "does this role's work appear on this order?"
(`role_implies_seeding`). Once demand reads the catalog, keeping a hand-synced copy of the same
knowledge is a live inconsistency — exactly what its own comment warns about.

**`role_implies_seeding` derives its answer from the catalog** (does any ordered profile fulfil this
role?). `ROLE_TO_WP_KEYS` is retired for catalog-backed profiles and retained only as the legacy
fallback for the five existing keys until they are migrated. **The catalog is authoritative; the map
is a fallback.** State that in the code, so the next reader is not left guessing which wins.

## Vial roles: a deliberate, bounded residual

**Adding a test family that needs its own vial adds one role literal. Vial roles are not catalog-driven.**

Making them dynamic would require every site below to read a union of hardcoded and catalog roles,
and a miss in any one of them is **silent** — the same failure class as the deny-lists this program
has been converting. That is its own spec, not a rider on order routing.

Heavy Metals uses role code **`hm`**. The column is `VARCHAR(8)` on both
`lims_samples.assignment_role` (`backend/models.py:744`) and `lims_sub_samples.assignment_role`
(`backend/models.py:920`), so a code must be ≤ 8 characters. `hm` fits; **the column is not widened
in this slice.**

### Checklist — every site a new role must touch

Verified against `origin/master`. This list exists so the next family is a checklist, not an
archaeology exercise.

| # | Site | What to add |
|---|---|---|
| 1 | `backend/sub_samples/service.py:1187` `derive_base_demand`, plus `_BUCKET_PRIORITY` / `_REAL_BUCKETS` | The bucket (catalog-driven after this spec; the tuples still enumerate) |
| 2 | `backend/lims_analyses/seeder.py:65-70` `ROLE_TO_WP_KEYS` | Legacy fallback only — new roles resolve from the catalog |
| 3 | `backend/lims_analyses/seeder.py:76-80` `ROLE_TO_KEYWORDS` | Legacy fallback only — as above |
| 4 | `backend/sub_samples/service.py:33-39` `_ROLE_GROUP_NAMES` | Department-keyed after spec 1; confirm the new role maps |
| 5 | `backend/main.py:15591-15605` `ROLE_TO_GROUP_NAMES`, `VALID_INBOX_ROLES`, `ROLE_TO_VIAL_ROLES` | Inbox lane membership for the new role |
| 6 | `src/lib/inbox-filters.ts` | Frontend lane + `MICRO_CATEGORIES` if applicable |
| 7 | `backend/database.py:344-345`, `:369` | **Variance exclusion keys off role *values*.** A heavy-metals vial is not an HPLC-purity replicate, so `hm` must be added to the excluded set or it will be wrongly eligible for variance |

Site 7 is the easiest to miss and the only one that changes a *physical* outcome.

## Deploy and cutover order

Reversing any of these produces the silent-drop or an unsellable product:

1. **Integration Service** — accept and validate the new keys (deployed, key present, still unsold).
2. **Accu-Mk1** — catalog demand shadow-read, parity proven, then flipped; role literal added;
   seeding path live.
3. **Spec 2 already shipped** — the family can render on a certificate.
4. **WordPress** — create the product with `_accumark_profile_key`, price signed off, **then**
   publish.

Publishing the product is the point of no return: it is the first moment a customer can buy the
test.

## Deliberately deferred

- **Dynamic vial-role vocabulary.** A separate spec if it is ever wanted; the checklist above is the
  interim contract.
- **Migrating the five existing keys** off the legacy normalizer and fallback maps. They keep
  working; only new families take the catalog path.
- **Pricing in Mk1**, `published_coa_result` rework, mixed-origin profiles, BacWater rework.

## Risks

| Risk | Mitigation |
|---|---|
| **A paid test silently vanishes** (unknown key ignored at ingest) | Reject with 422 at ingest; deploy Integration Service before the WordPress product exists. This is the ordering constraint, not a preference |
| A product rename silently changes its wire key | `_accumark_profile_key` product meta; new families never touch the name-derived normalizer |
| A new role literal missed at one of seven sites | The checklist above, plus a test asserting a `hm` vial is variance-excluded and appears in exactly one inbox lane |
| Demand regression on existing orders | Shadow-read against legacy `derive_base_demand`; parity asserted for the five existing keys before the flip |
| Two hand-synced maps disagreeing | Catalog declared authoritative, maps demoted to explicit legacy fallback, stated in code |
| A native family accidentally attached to a SENAITE profile | `SERVICE_TO_PROFILE` maps native keys to a "native — no SENAITE profile" sentinel; the profile-attach branches skip them |
| **ENDO-LAL unit divergence** (`EU/mg` in the Mk1 catalog vs `EU/mL` hardcoded in COABuilder) | Still unresolved. This is the slice where a profile containing `ENDO-LAL` could first be created and sold. **Fix the catalog unit before any profile containing it is published** |

## Testing

- **Unknown key rejected:** an order carrying an undeclared service key returns 422 naming the key,
  and is recorded as `failed` — never silently accepted.
- **Explicit key wins:** a product with `_accumark_profile_key` routes on it; a product without falls
  back to the legacy normalizer with byte-identical behavior for the five existing keys.
- **Demand parity:** catalog resolver reproduces `derive_base_demand` for every combination of the
  five existing keys, including `sterility_pcr` → 2 vials.
- **New-family demand:** an order for Heavy Metals alone provisions exactly one `hm` vial.
- **Seeding:** an `hm` vial is seeded with exactly the Heavy Metals profile's member services, and no
  others; no `hm` service ever appears on an HPLC vial (spec 1's allow-list regression, re-asserted).
- **Role coverage:** an `hm` vial is variance-excluded (site 7) and appears in exactly one inbox lane.
- **No SENAITE profile attached** for a native-only order.
- **Additive proof:** failure-set diff against master in the same virtualenv, never zero-failures
  (`architecture_mk1_test_baseline_failures`).

## Execution environment

Cross-repo (WordPress + Integration Service + Accu-Mk1). Rehearse on a fresh isolated devbox stack
mounting all three; the WordPress layer needs an SSH local-forward for the stack's WP port. Never the
live host. Invoke the `accumark-stack-platform` skill at execution time. Integration Service must
pass `ruff check . && mypy app`.

## Handler / lab gates

- **G-P — pricing** for Heavy Metals, Moisture, and pH. Lab/accounting-owned; not an engineering
  blocker, but a product cannot be published without it.
- **G-V — vial counts.** Heavy Metals is confirmed at one dedicated vial. Confirm Moisture and pH
  before their profiles are seeded (`vials_required = 0` means "rides an existing vial", which is a
  lab-protocol question, not an engineering one).
- **G-PUB — product publish** is a production-behavior change and the point of no return. Explicit
  Handler sign-off, after spec 2 has shipped.
- **G-ENDO — ENDO-LAL catalog unit** must be resolved before any profile containing it is sold.

## Open questions

1. **Does Moisture need its own vial, or can it share one?** Determines `vials_required` and whether
   it needs a role literal at all. A profile with `vials_required = 0` needs no new role.
2. **Where does à-la-carte pH run?** If it rides an existing Analytical vial it needs no role; if it
   needs its own aliquot it does. Lab call.
3. **Should the five legacy keys eventually migrate to `_accumark_profile_key`?** Not required, but
   it would let the name-derived normalizer be deleted rather than carried indefinitely.

## Cross-references

- Spec 1 — `docs/superpowers/specs/2026-07-28-analysis-catalog-foundation-design.md`
- Spec 2 — `docs/superpowers/specs/2026-07-28-native-coa-sections-design.md`
- `integration-service/app/models/order.py`, `app/services/order_validator.py` — the ingest layer
- `wp-content/themes/wpstar/src/Front/Cart_Order.php:1407,1627` — the name-derived normalizer
- `backend/sub_samples/service.py`, `backend/lims_analyses/seeder.py` — demand and seeding
