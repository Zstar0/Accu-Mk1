# Add services to an in-progress sample (same sample, no retest)

Date: 2026-09-29. Status: APPROVED (Handler ruling after the P-5191 incident). Extends
`2026-09-29-retest-overlay-v2.md`; the Re-test tab and the published-sample add-on path are unchanged.

## Ruling

- If the original sample is **not published** (any status before `published`), the Add services tab adds
  the chosen profiles to **that same sample**: a WooCommerce add-on order is created against the
  original order, and when it is paid (or waived) the services are applied to the existing sample in
  WordPress, IS and Mk1. No new sample, no retest lineage, nothing carried or dropped.
- If the original **is published**, the Add services tab behaves as today: a retest-spec order that
  mints a new sample with existing results carried.
- The tab states which of the two will happen before Create, and the Create label matches:
  "Add services to P-5191" vs "Create add-on order (new sample)".

## Why

P-5191 (in progress) + USP-71 produced a spec that dropped HPLC and would have minted a second sample
carrying nothing. The lab's intent for an in-progress sample is "put this test on the sample we are
already running". WordPress already has that mechanism for staff (Add-on Upgrades on the order), but it
never reaches Mk1 and has no waiver.

## Flow (in-progress original)

```
Mk1 overlay  POST /api/samples/{id}/addon-order {profiles[], variance_points, additional_vials, fee, reason}
   -> IS     POST /api/service/addon-orders {sample_id, ...} (desktop key, Idempotency-Key)
   -> IS resolves (wp_order_id, sample_number) via retest_lookup.resolve_wp_order
   -> WP     POST /wp-json/accumark/v1/addon-order (HMAC, Idempotency-Key)
             {sample_id, wp_order_id, sample_number, profiles[], variance_points, additional_vials, fee, reason,
              requested_by_user_id}
   WP builds selections from PROFILE_TO_ADDON and calls Addon_Upgrades::create_addon_order (existing rules:
   parent must have _sample_data, profile not already on the sample, product priced). fee=free: every line
   zeroed after the price guard, note "Fees waived (Mk1 add-on) by user #n: reason; waived $sum",
   payment_complete() -> existing apply_addon_order + apply_to_lims run unchanged.
   Response {order_id, order_number, status pending|completed, payment_url|null, total}.
On payment or waiver (existing hooks):
   WP apply_to_lims -> IS POST /v1/webhook/order-services-updated (existing, replaces services on the
   stored submission) -> NEW: IS forwards to Mk1 POST /s2s/lims-samples/{sample_id}/services
   {services{...}, variance_value, event_id, order_id} (internal service token, same as other s2s calls)
   -> Mk1 adds every newly-true native profile to the sample via add_profile_to_parent (placeholder rows,
   host edges, vial rows), refreshes catalog_snapshot["profiles"], records an activity event
   ("Services added from WP order 8611: Sterility USP-71 (waived)"). Idempotent: profiles already on the
   sample are skipped, not 409. A published sample is refused (409) at Mk1 and IS logs it; the WP order stays
   as the record (the published path should have been used).
```

Mk1 also stores the pending add-on order on the original (`catalog_snapshot["addon_orders"]`, list of
{order_id, order_number, status, requested_at, profiles}) so the Orders tab lists it as kind "addon" with
"same sample" instead of a minted sample id; when the services arrive the entry is marked applied.

## Overlay changes

- Add services tab top line: in-progress -> "P-5191 is in progress: the selected services are added to
  this sample once the order is paid (or at once if waived)."; published -> "P-5191 is published: a new
  sample is created with the existing results carried." Create label per the ruling.
- In-progress mode sends no retest/carry/drop and does not show the "New sample:" line; the summary is
  the add-on lines only. Billing Charged/Waived applies (waived = whole add-on order free).
- Orders tab rows from the same-sample path show "same sample" in the Sample column until applied, then
  "applied".

## Contracts

- Mk1 `POST /api/samples/{id}/addon-order` body `{profiles[], variance_points, additional_vials, fee, reason}`;
  400 when the sample is published (use the retest route), when a profile is unknown/inactive/already on
  the sample, or when nothing is selected. Response = WP response. Idempotency-Key
  `addon:<sample>:<sha256 of body minus requested_at>[:16]`.
- IS `POST /api/service/addon-orders` body `{sample_id, profiles[], variance_points, additional_vials, fee,
  reason, requested_by_user_id, requested_at}`; 404 when the sample is in no order; forwards with the same
  Idempotency-Key. IS `order-services-updated` gains the Mk1 forward (fire-and-forget with logging; the WP
  side already retries on the next paid-status event) only for samples whose stored result says
  `lims == "mk1"`.
- WP `POST /wp-json/accumark/v1/addon-order` as above; 404 unknown order/sample; 409 `already_on_sample`,
  `addon_product_missing`; 400 `invalid_profile`.
- Mk1 `POST /s2s/lims-samples/{sample_id}/services` body `{services{key: bool}, variance_value, event_id,
  order_id}`; 404 unknown sample; 409 published; 200 `{added: [keys], skipped: [keys]}`.

## Tests

WP: RetestEndpointTest (addon-order paid -> pending order with add-on lines and payment_url; waived ->
completed, notes, apply hooks ran, `_addon_lims_synced`); Mk1 backend: addon-order route validations and
forward; s2s services route adds profiles, skips existing, refuses published, snapshot refreshed, event;
IS: addon-orders forward + lookup, services-updated forwards to Mk1 only for mk1 samples; frontend:
mode copy and labels, body shape, Orders tab "same sample"; Playwright: Add services on an in-progress
sample asserts the same-sample copy and creates the order.

## Rulings added during the build (2026-09-30)

- Variance is not sold on the same-sample route (400 pointing at the Re-test tab); the Add services tab hides it in that mode.
- Published AND terminal samples (cancelled, rejected) are refused by both the add-on route (400) and the s2s apply (409).
- IS forwards `added_keys` (false to true against its stored services) and keeps keys owed to Mk1 until a forward succeeds; Mk1 applies only `added_keys` when present.
- IS drops a sample's retest-context cache entry whenever one of its orders is created or its services change.
- The add-on offer list excludes profiles whose members already have live parent rows (same predicate as the route).
- Staff add-on orders (WP metabox, no Mk1 entry) show applied from the WooCommerce status.

## Not in scope

Editing a pending add-on order; vial shipping for add-ons beyond the existing `additional_vials` count.
