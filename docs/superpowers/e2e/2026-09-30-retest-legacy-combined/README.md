# Re-test overlay: legacy samples, combined re-test + add, visible reasons (stack `retest`, 2026-09-30)

Mounted: Accu-Mk1 feat/retest-legacy-and-combined @ dc62147b (backend + frontend). WordPress 2.60.0 and IS 1.0.33 unchanged (no server-side change needed: the retest spec already carried `retest` + `add`).

## 1 + 2. Legacy (SENAITE-era) sample, re-test + add services in ONE order (screenshot 01)

Fixture: P-9001 flipped to `published` and reshaped by `backend/scripts/dev/fabricate_legacy_sample.py` (snapshot profiles cleared, native parent rows retired, SENAITE-origin shadow rows HPLC-PUR / PEPT-Total / ID_BPC157 / ENDO-LAL / STER-PCR inserted). `retest-options` answered `profiles_source: "rows"` with three `legacy: true` profiles (hplc-purity-identity, rapid-sterility-pcr, endotoxin-usp85-lal), each "Published (SENAITE)", `carry_eligible: false`, reason "SENAITE-era result: cannot be carried, re-test it instead".

Overlay: Re-test tab shows the SENAITE-era tag on each row, the carry reason under the disabled Carry box, the rule-sentence suffix, and the new "Also add services" section. Ticked Re-test HPLC + Fentanyl Screening, Billing Waived. Summary: Retest fee (HPLC) + Fentanyl Screening, Total $0.00 (waived). Outcome: "At once: a new sample is created with HPLC Purity + Identity re-tested; Rapid Sterility Screening (PCR), Endotoxin USP85 LAL dropped; Fentanyl Screening added."

Create -> WooCommerce order 3290 (retest of 3134) with TWO lines: "Vial Re-Test" and "Fentanyl Screening [Add-on for Order #3134]"; spec `retest: [hplcpurity_identity], add.profiles: [fentanyl], drop: [rapid-sterility-pcr, endotoxin-usp85-lal]` -> Mk1 minted P-5005 (`retest_of` P-9001, order WP-3290) with snapshot profiles `[fentanyl, hplc-purity-identity]`, parent placeholders HPLC-IDENTITY / HPLC-PURITY / HPLC-QUANTITY / FENTANYL, retest block `retest: [hplc-purity-identity]`, events `retest_created` + `retest_spec_warning` (the drop).

Defect caught by this run and fixed before the evidence: the first attempt (P-5004) minted with NO HPLC rows because the legacy key resolved to the alias profile `hplcpurity_identity`, which on prod and stack is active but has no member services (the member-bearing `hplc-purity-identity` is inactive). Keys now resolve by "has mk1 members", and `canonical_retest_key()` maps alias spec keys to their twin, which also fixes retests of older prod samples whose snapshot carries the alias.

P-9001 was restored afterwards (17 parent rows, snapshot 3 profiles, status sample_received).

## 3. WooCommerce order deleted (screenshot 03)

Stack order 3268 (P-5001's) was force-deleted. IS answers 502 `{"error":{"code":"upstream_unavailable","message":"WordPress 404"}}`; `retest-options` -> `context_error: {kind: "order_missing", message: "WooCommerce order 3268 no longer exists (it was deleted), so no retest or add-on order can be created."}`. Overlay: amber note at the top, Create stays disabled with that reason after ticking a re-test, choosing Waived and entering a reason. Defect caught here: the first build classified every IS error as `unavailable` because IS replies with its error envelope, not `detail`.

## Gates on the merged tree
- backend pytest (retest routes, carry, effective profiles, addon-order, s2s services, apply-retest-spec): 117 passed
- vitest retest-dialog: 33 passed (42 with use-retest); tsc clean
