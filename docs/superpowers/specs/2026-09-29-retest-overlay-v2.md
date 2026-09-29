# Retest overlay v2: two jobs, explicit carry, itemised price

Date: 2026-09-29. Status: APPROVED (Handler, from the 2026-09-29 UX audit of the 1.29.1 overlay).
Supersedes the overlay section (4.1) of `2026-09-23-mk1-native-retest-design.md`. Wire contracts, lineage
and order creation are unchanged unless stated here.

## Why

The 1.29.1 overlay mixes two jobs (re-test an existing profile, sell a new service) in one form with one
Delta, hides what "Carry" means, lists unordered services at $0.00 in the order card, and omits catalog
services the shop sells. Audit findings 1 to 12 are all addressed here.

## Rulings

1. Two tabs, two specs. "Re-test" and "Add services" are separate jobs; each Create sends a spec with only
   its half populated. A single overlay session never mixes them.
2. Carry is explicit and optional. Every original profile row has "Re-test" and "Carry results" boxes. A
   verified row defaults to Carry. A row with neither box ticked is DROPPED: it is absent from the new
   sample (no marker row, no carried result). The spec records it under `drop`. The original sample and
   its COA are untouched as before.
3. Unverified rows cannot carry (existing rule). On the Re-test tab they show the reason inline and their
   Carry box is disabled.
4. The retest fee applies only on the Re-test tab and only when at least one row is re-tested. Add-ons are
   always billed at the listed price; the Add services tab has no Paid/Free choice.
5. The add-on list is the catalog, not the `is_addon` flag: every active catalog profile the original
   does not already have, priced when WordPress can sell it (else shown as "not sold post-order").
   WordPress gains Sterility USP-71 and Fentanyl Screening as post-order add-on types so they price and
   sell through the same path as endotoxin, PCR and heavy metals.
6. The order card shows what the customer bought: lines with a price above zero, display names from the
   shop, and the order's own total and status.

## Overlay layout

```
Re-test P-9001                                      [x]
+---------------------------------------------------------+
| Order 3134  ·  Forrest Parker · forrestp@outlook.com     |
| $250.00 · completed · 2/27/2026                          |
| HPLC Purity & Identity $250.00                           |
| Pending retest orders: 3270 $280 awaiting  [Copy] [Open]|
+---------------------------------------------------------+
[ Re-test ]  [ Add services ]

Re-test tab
  Profile              State            Re-test   Carry results
  HPLC Purity+Identity Verified 9/20     [ ]        [x]
  Heavy Metals         Verified 9/20     [ ]        [x]
  Endotoxin USP85 LAL  Not verified      [ ]        [ ] (cannot carry: not verified)
  "Rows not re-tested are carried as verified results linked to this sample. Untick Carry to leave a
   result off the new sample."
  Variance  [ ] points [3] @ $76.50/point   (only shown when an HPLC row is set to Re-test; helper
   "Requires an HPLC re-test" when HPLC exists but is not ticked)
  Retest fee   (o) Charged $50.00   ( ) Waived
  On arrival   [ ] Check in on creation (extra vial already on hand)
  Reason (required) [                                    ]
  Summary                                  Create disabled reason: "Tick at least one Re-test" /
    Retest fee (HPLC)         $50.00       "Enter a reason"
    Variance, 3 points       $153.00  (points minus one, as the shop bills)
    Total                    $203.00
  New sample: re-test HPLC; carry Heavy Metals; drop Endotoxin.
                                             [Cancel] [Create retest order]

Add services tab
  Service                        Price        Vials
  [ ] Rapid Sterility (PCR)      $230.00      1
  [ ] Endotoxin USP85 LAL        $200.00      1
  [ ] Heavy Metals               $200.00      2
  [ ] Sterility USP-71           $250.00      1
  [ ] Fentanyl Screening         $75.00       0
  "Add-ons are always billed at the listed price. Existing results are carried to the new sample."
  More options  >  Extra vials to ship [0]  (hint: added to the order at the per-vial price, no test)
                   [ ] Check in on creation
  Reason (required) [                                    ]
  Summary: lines + Total.   New sample: carry HPLC, Heavy Metals, Endotoxin; add PCR.
                                             [Cancel] [Create add-on order]
```

All Re-test boxes start unticked. Unverified rows therefore start as dropped (their Carry box is
disabled), and the "New sample:" line says so; the operator ticks Re-test to keep them. Variance is
priced as (points minus one) x point price, the same as the shop bills. Extra vials are priced by the
shop: the summary lists them as "Extra vials, N: price set by the shop" and the Total then reads
"Total (excluding extra vials)".

Titles are fixed per tab: "Re-test P-9001" and "Add services to P-9001". The intro paragraphs are gone;
the per-tab rule sentence and the "New sample:" line carry the explanation.

## Spec JSON (additive)

```
{ retest_of_sample_id, retest[], carry[], drop[], add{profiles[], variance_points, additional_vials},
  auto_checkin, fee, reason, requested_by_user_id, requested_at }
```

`drop` is new and optional (default []). Rule: `retest ∪ carry ∪ drop == original profiles`; a profile in
none of them is treated as dropped (backward compatible with 1.29 clients that omit `drop`, where the old
partition rule applied; the server no longer 400s on omission, it records the omission as drop). A
profile in two lists is a 400. Re-test tab sends `add = {profiles: [], variance_points: n|0,
additional_vials: 0}`. Add services tab sends `retest = []`, `carry = every carry-eligible original
profile`, `drop = original profiles that are not carry-eligible` (they cannot carry and are not being
re-tested), `fee = "paid"` (ignored: no retest line is created when `retest` is empty; existing
behaviour).

Mk1 persists `drop` in `catalog_snapshot["retest"]` and the activity event names dropped profiles
("dropped Endotoxin USP85 LAL (not carried to P-5001)").

## API changes

### Mk1 `GET /api/samples/{id}/retest-options`

- `profiles[]` gains `verified_at` (ISO or null) and `state_label` ("Verified 9/20", "Not verified",
  "Pending").
- `addons[]` is every active catalog profile whose key is not on the original, each with `key`, `name`,
  `vials`, `price` (number or null), `sellable` (bool: WordPress returned a price for this key). Order:
  sellable first, then by catalog sort order.
- `context.order.lines[]` passes through from WordPress unchanged (see below).
- `summary_lines` is NOT computed server side; the dialog builds it from prices it already has.

### WordPress `GET accumark/v1/retest-context`

- `order.lines[]`: only entries whose price is above zero; `label` from the `wc_test_services` row whose
  `wire_key` or `profile_key` matches, then the add-on type label, then the key. `order.total` and
  `order.status` come from the WooCommerce order (they already do).
- `addons{}` gains `sterility-usp71` and `fentanyl` when their products resolve.
- `Addon_Upgrades::ADDON_TYPES` gains `'sterility-usp71'` (label "Sterility USP-71", flat,
  catalog_match "usp-71", mk1_key "sterility-usp71") and `'fentanyl'` (label "Fentanyl Screening", flat,
  catalog_match "fentanyl", mk1_key "fentanyl"). `Retest::PROFILE_TO_ADDON` gains the two identity
  entries. The Add-on Upgrades admin box lists them too (same constant).

### Integration Service

No change: `retest-context` is passed through verbatim and `retest_spec` is stored as sent (the
`drop` key rides along; the `Sample.retest_spec` model allows extra keys).

## Backend rules (Mk1 `retest_carry.py`)

- `parse_retest_spec`: `drop` list, default [].
- `validate_retest_spec`: unknown keys 400; a key in more than one of retest/carry/drop 400; carry of a
  non-eligible profile 400 (unchanged); every original profile not in retest/carry is recorded as drop
  (no 400). `add.profiles` clash with the original 400 (unchanged). Variance needs HPLC in retest
  (unchanged).
- `apply_retest_spec`: unchanged for retest/carry/add; dropped profiles simply do not appear in the new
  sample's snapshot profiles nor as carried rows. The `retest_spec_warning` event is emitted when any
  profile is dropped, naming them, so the lab can see a result was deliberately left off.
- COA: the new sample's COA covers its snapshot profiles only (existing behaviour: union of retest and
  carry minus missing). Dropped profiles are not on it.

## Frontend

`RetestDialog.tsx` is rewritten around `Tabs` (shadcn). State: one object with `tab`, per-profile
`{retest: bool, carry: bool}`, `addons: Set<key>`, `variancePoints`, `varianceTicked`, `extraVials`,
`autoCheckin`, `fee`, `reason`. Derived: `spec` per tab, `summary` lines, `canCreate` and its reason
string, the "New sample:" sentence. Pending retest orders render above the tabs. Money formatting reuses
`formatMoney`. Existing chips, hooks and the toast are unchanged. `use-retest.ts` unchanged except the
request body type gaining `drop`.

Create button labels: "Create retest order" / "Create add-on order". Disabled reason text sits left of
the buttons.

## Tests

- Backend: `test_retest_spec.py` (drop parsing, omission recorded as drop, double membership 400),
  `test_apply_retest_spec.py` (dropped profile absent from snapshot and rows, warning event names it),
  `test_retest_routes.py` (addons from the catalog with `sellable`, `state_label`).
- Frontend: `retest-dialog.test.tsx` rewritten: tab switch, carry default and untick, drop sentence,
  fee only on Re-test, summary totals, disabled reasons, add-on list with unsellable row, fixed titles.
- WordPress: `RetestEndpointTest` (lines filtered and labelled, new addon keys), `AddonUpgrades` tests
  for the two new types, `RetestCreateFromSpecTest` for a USP-71 add-on line.
- Playwright `e2e/retest.spec.ts` updated to the tabbed DOM (both tabs, one Create on Re-test).

## Not in scope

Editing an existing pending retest order; per-vial choice of which result to carry (carry is per
profile); selling services WordPress has no product for.
