# Waived billing + native routing E2E on devbox stack `retest` (2026-09-29)

Mounted: Mk1 feat/retest-waive-all (860c7506), accumarklabs feat/retest-waive-all (f26d0dc8), IS feat/native-retest-routing (ffc583d).

1. Add services tab, Fentanyl ticked, Billing = Waived: summary "$0.00 (waived $75.00)", Total "$0.00 (waived)". Create -> WooCommerce order 3279: total $0.00, line kept, notes "Fees waived (Mk1 retest spec) by user #1: ...; waived $75.00" then "Payment complete." No invoice email. IS accepted immediately.
2. Finding: with IS master the sample for 3279 was minted in SENAITE (P-0156) because IS routed to Mk1 only when native HPLC was demanded; an add-on-only or non-HPLC retest therefore never received the carry/drop spec. Fixed in IS ffc583d (a retest_spec routes to Mk1). Prod check: no retest orders since 2026-09-28, nothing misrouted there.
3. After the IS fix: waived PCR add-on -> order 3280 -> IS minted P-5003 in Mk1: snapshot profiles [rapid-sterility-pcr], carry = all three originals (8 verified rows carried), STERILITY-PCR pending, fee free, status sample_due.
