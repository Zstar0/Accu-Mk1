# Add services to an in-progress sample (same sample) on devbox stack `retest` (2026-09-30)

Mounted: Mk1 feat/addon-same-sample (backend merged), accumarklabs feat/addon-same-sample (2.60.0), IS feat/addon-same-sample (1.0.32). Fixture: P-9001 set to `sample_received` on the stack (it stays in progress there for the e2e suite; `E2E_ADDON_SAMPLE_ID=P-9001`).

1. Add services tab on P-9001 reads "P-9001 is in progress: the selected services are added to this sample once the order is paid (or at once if waived)."; Fentanyl ticked, Billing Waived, summary "$0.00 (waived $75.00)", Create label "Add services to P-9001" (screenshot 01).
2. Create -> Mk1 `POST /api/samples/P-9001/addon-order` -> IS `/api/service/addon-orders` -> WP `accumark/v1/addon-order` -> WooCommerce add-on order (3281, then 3286 on the final run): `_is_addon_order`, `_addon_for` 3134, waived note "Fees waived (Mk1 add-on) by user #1: ...; waived $75.00", `payment_complete`, `_addon_applied`, `_addon_lims_synced` -> IS `order-services-updated` with `added_keys: ["fentanyl"]` -> Mk1 `POST /s2s/lims-samples/P-9001/services` -> FENTANYL parent row + vial row on P-9001-S01, snapshot profiles gain `fentanyl`, `addon_orders` entry `applied: true`, events `addon_order_requested` and `addon_services_applied` ("Services added from WP add-on order 3286: Fentanyl Screening (waived)"). Fentanyl is no longer offered as an add-on for P-9001.
3. Playwright `e2e/retest.spec.ts`: 3 passed on the stack (Re-test create, Add services mode, same-sample waived create).

Traps fixed during the run: the Mk1 addon-order route overwrote the s2s snapshot writes with a stale copy because the waived chain completes inside its own IS call (fixed by reloading the sample); IS forwarded nothing when its stored services already had the key true (fixed by persisting keys owed to Mk1 until a forward succeeds); WordPress saved the idempotency meta only after `payment_complete` (fixed by ordering). Prod order 8611 (the P-5191 attempt) was left as the record and not resubmitted.

## "When you press Create" block (2026-09-30, head 25b48d38)

Stack `retest`, P-9001 in progress, no Create pressed. The Summary card now ends with a "When you press Create" block built from the same state as the request body:

- 02: Re-test tab, HPLC re-test + variance 3 points, Charged: "Creates a WooCommerce retest order for Forrest Parker against order 3134 ($203.00)." / "Once paid: a new sample is created with HPLC Purity + Identity re-tested (variance, 3 points); Heavy Metals, Endotoxin USP85 LAL carried as verified results." / "P-9001 is unchanged and stays linked to the new sample." / "The customer is emailed an invoice with the payment link." (the last two lines sit below the fold in the screenshot; the a11y snapshot recorded all four).
- 03: Add services, Fentanyl, Charged: "Creates a WooCommerce add-on order for Forrest Parker against order 3134 ($75.00)." / "Once paid: Fentanyl Screening added to P-9001." / "No new sample; P-9001 keeps its current results." / "No payment email is sent; copy the payment link from the Orders tab."
- 04: same with Billing Waived: "($0.00, waived $75.00)" / "At once: Fentanyl Screening added to P-9001." / "No payment is needed."

Unit: `src/test/retest-dialog.test.tsx` 24 passed (block asserted on the Re-test, published Add services, in-progress charged and waived paths, variance wording and the vial count); tsc clean.
