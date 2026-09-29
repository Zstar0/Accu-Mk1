# Retest overlay v2 E2E on devbox stack `retest` (2026-09-29)

Mounted: Mk1 feat/retest-overlay-v2 (b1e9a89e), accumarklabs feat/retest-overlay-v2 (d016e289), IS master 1.0.30.

1. Re-test tab on P-9001: HPLC Purity + Identity set to Re-test, Heavy Metals carried, Endotoxin USP85 LAL with neither box (dropped), variance 3 points, fee charged. Summary: Retest fee $50.00 + Variance, 3 points $153.00 = $203.00. Create -> WooCommerce order 3277 (pending, $203.00, lines "Vial Re-Test" and "Variance - HPLC (2 additional vials)"), `_retest_spec.drop = ["endotoxin-usp85-lal"]`.
2. `payment_complete()` on 3277 -> IS minted P-5002 -> Mk1: snapshot profiles `['hplc-purity-identity']`, retest block `{retest: [hplc], carry: [heavy_metals], drop: [endotoxin-usp85-lal]}`, rows: 4 heavy-metals results carried verified, 3 HPLC rows pending, no endotoxin rows; events `retest_created` and `retest_spec_warning` "dropped Endotoxin USP85 LAL (not carried to P-5002)"; `retested_as` on P-9001.
3. Add services tab: catalog add-ons Fentanyl Screening $75 and Rapid Sterility Screening (PCR) $230 sellable, Bac Water "not sold post-order" (no product on the stack shop); legacy alias profiles excluded. Fentanyl ticked -> Create add-on order -> WooCommerce order 3278 (pending, $75.00, line "Fentanyl Screening ... [Add-on for Order #3134]"), spec `retest: [], carry: [all three], add.profiles: ["fentanyl"]`.
4. Playwright `e2e/retest.spec.ts` (both tabs): 2 passed against the stack.

Stack notes: the devbox firewalld had wiped Docker's iptables chains; `sudo systemctl restart docker` (live-restore kept all 144 containers) repaired networking. Stack shop seeded with Heavy Metals / Sterility USP-71 / Fentanyl products (pids 3273-3275). Screenshots 01-04.
