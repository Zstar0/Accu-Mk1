# HGH quantity in IU: display conversion

Handler ruling 2026-11-04: HGH defaults to IU going forward. The lab keeps entering mg.
No per-sample choice. I read "default it to UI" as IU; veto here if wrong.

## Rule

- The COA prints IU only, with no mg beside it (Handler ruling 2026-11-04).
- `lims_analyses` stays mg. Conversion happens at the COA wire build, after spec is judged on raw mg (same stance as `< LOQ`).
- One gate on the peptide record: `iu_per_mg` + `iu_from`. A sample converts when its peptide has both, and its order time (`date_created or created_at`) is on or after `iu_from`.
- Inert until both fields are set. A blend resolves to no peptide, so it never converts.
- Earlier samples never flip, regen included. The factor and cutoff lock (409) once the cutoff has passed. Before that a scheduled cutoff can be changed or cleared.
- A new cutoff cannot be in the past (422), a cutoff needs a factor (422), and a blend record refuses IU (422).
- A retest takes its original's order time through `retest_of_sample_id`, because it copies the original's declared amount. An original Mk1 does not hold stays mg.
- Removed rows (`retracted`, `rejected`, `cancelled`) do not count as a second peptide, so they cannot turn IU off.
- Standard factor is 3.0 IU/mg (WHO 98/574, Bristow & Jespersen, Biologicals 2001).
- From the cutoff the customer states the declared amount in IU. The label on the website is the customer-side cutoff.
- Prep guidance divides declared IU back to mg. Stored prep rows already hold mg.

## Converted

- Page 1 `PEPT-Total` and native `HPLC-QUANTITY` rows.
- Variance replicates, vial figures, analyte series, so the headline mean and vial labels match.
- Wizard declared weight, via `declared_prep_mg`, which divides the value the lookup shows. `declared_weight_mg` itself stays raw because SampleDetails edits it.

## Not converted

- `hplc_processor`, `prep_bridge`, stored results, spec judgement.
- Rows already in another unit (`IU`, `mg/mL`).

## Known ceilings

- HPLC-less HGH prints SAMPLE SIZE in mg (no measured IU to pair with). Same as today, not a regression.
- Orders in flight at the cutoff, sample transfers that copy an mg-era declared amount, and a pre-cutoff sample first seeded into Mk1 after the cutoff (it falls back to `created_at`).
- Spec bounds stay mg on the wire. Harmless while HGH quantity is informational. A numeric HGH quantity spec would print wrong percent deviations and needs converting first.
- `quantity_value` is NULL on IU COAs, so Analyte Trends and the IS Slack note show no quantity. Never a false number; adding IU to the strip list would mix units.
- Senaite-mode generation mixes units. Latent: prod runs `coa_generation=mk1`, so it only matters on a rollback.
- A raw non-mg vial row beside a converted parent. Prod vial rows have a NULL unit.
- Vendors label at about 2 to 2.5 IU/mg, so COAs read 120 to 155% of label and prep guidance lands high. Flagged to the lab.
- Customer API docs and admin tables still say mg. Follow-ups, named in the WP PR.
- Retest mirror (`functions.php:1598`), sample transfer (`OrderBuilder.php:139-154`), admin and add-on paths write no `declaredUnit`, so those samples read mg in the portal even when the original was IU.
- Order editor corners: swapping BPC-157 to HGH on a pre-launch order labels IU while Mk1 before its cutoff prints mg. Converting a blend to a lone HGH takes IU by the name rule on an amount typed in mg. An old order holding a stale HGH name must be re-selected before it can save (`validateAnalytes`), and that re-selection counts as a peptide change, so it takes IU. The prod option read shows whether any such names exist.
- A cart filled before the WP deploy keeps mg until the customer reopens that sample. Reopening shows the IU label and re-saving stamps IU on the number already there.

## Declared unit on the website

- Each sample stores the unit its amount field showed: `declaredUnit` on `_cart_sample_data` and `_sample_data`.
- Customer read-backs print the stored unit and never infer IU from the peptide name, because old HGH orders were typed under the mg label. No stamp reads mg, so old orders and carts filled before the WP deploy keep mg.
- Read sites: the portal "Declared Qty" line, the portal analyte chip, the chip refresh after an edit, the additional COA picker.
- In the order editor a sample keeps its stamped unit until its peptide rows differ from what the editor opened with, then the name rule applies. It compares against the opened rows, not the identity string, because the two can differ on old orders. The server forces mg on anything not Single Peptide, and a missing posted unit reads mg.
- The stamp stays in WP. IS and Mk1 never receive it, and Mk1 keeps its own cutoff.
- The WP label flips on the WP deploy, the COA on the Mk1 cutoff. Between them the portal says 36 IU (what was typed) and the COA prints 36.0 mg (today's behavior). Keep that gap short.

## Rollout

Before the cutoff is set, read the exact HGH option name in prod `wc_peptides_list`. The WP label matches `somatropin` or a bare `HGH`/`rHGH`. A prod name that misses it leaves the form saying mg while the COA prints IU.

1. Deploy coab, then Mk1 (inert), then WP.
2. Purge the Kinsta cache and confirm the live HGH form says IU.
3. Set the factor and a cutoff with real lead time (a day). It stays editable until it passes.

The two failure directions are not equal. A cutoff that lands early locks and prints false IU on amounts typed under the mg label. A late one only leaves more samples at today's behavior.

## Input paths checked

- Labeled: the order form and the order editor. Nothing else takes a declared amount for a single peptide.
- No API creates orders. `/client/*` is read-only. `js/create-order.js` and `templates/portal-create-order.php` still say mg, but nothing loads them.
- No upper bound assumes mg: WP checks `> 0`, IS passes the value through, the column is `DECIMAL(10,2)`.
- Admin retest "Change peptide" to HGH keeps the original number with no quantity field. Rare, admin only.
- Read surfaces that still say mg: the Customer API key `declared_mg`, the portal COA export header `Declared (mg)` (`functions.php:2365`), the admin table `declMg` (`accuverify-woocommerce/assets/js/admin-settings.js:951`), order notes (`SampleEditing.php:692,730,751`). Follow-ups, except the API note, which should go out before the cutoff.
- Bare number with no unit, not wrong: `thankyou.php:540`, `form-pay.php:1040`, `woocommerce/myaccount/view-order.php:299`, `portal-view-order.php:2216`, cart review, the `Sample Weight` item meta (`Sample_Submission.php:862`).
- The packing slip does not print the amount. No theme email builder reads the field, by code read only: stack Mailhog held no messages, so no email was rendered.
