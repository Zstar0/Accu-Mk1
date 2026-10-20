# E2E evidence: forward pointer switched on at supersession (2026-09-29)

Feature: when a publish replaces a certificate, the Integration Service marks the old
generation superseded and switches its forward pointer on, so the old verification code
announces the new certificate (Handler ruling 2026-09-29). PRs: Accu-Mk1 #254, IS #45,
accumarklabs #89.

## Run

- Stack: `coarevoke` on the devbox (IS worktree `feat/coa-integrity-tier1`, WordPress
  worktree `feat/accuverify-verdict-render`, Mk1 worktree `feat/coa-forward-revoke-controls`,
  all mounted). Sample `PB-0069` (WP order 3166), read source Accu-Mk1.
- Command (laptop, Git Bash):
  `. /c/tmp/coarevoke-e2e.env && E2E_COA_SAMPLE_ID=PB-0069 E2E_KNOWN_SAMPLE_ID=PB-0069 node node_modules/@playwright/test/cli.js test --reporter=list`
- Result: `8 passed, 8 skipped (2.4m)`, 0 failed. See `suite-output.txt`. The skips are the
  customers spec's registered-customer cases (the stack only has guest customers) and the
  retest spec (needs `E2E_RETEST_SAMPLE_ID`; the overlay it drives is not on this branch).
- Two runs happened before this one and failed on the spec itself, not the feature: a row
  locator that stopped at the header line, a Playwright strict-mode clash between the
  "Regen & Republish" button and its "About Regen & Republish" help icon, and a card
  re-location race after the refetch. Fixed in the spec; the sample carries the extra
  generations those attempts minted (gens 18 and 19 became superseded with the pointer on,
  which is the feature working).

## What the files show

| File | Shows |
|------|-------|
| `01-mk1-primary-republished-old-row-superseded.png` | Generated COAs after Regen & Republish: gen 20 `584L-Q2LS` Published, gen 17 `7RE7-338Y` Superseded |
| `02-mk1-old-primary-manage-forward-on.png` | Manage popover on the old primary: Forward to current is ON without anyone touching it; the help text describes the new default |
| `03-wp-old-primary-code-announces-successor.png` | WordPress verify page for `7RE7-338Y`: Superseded banner with a link to `584L-Q2LS` |
| `04-wp-new-primary-code-verified.png` | WordPress verify page for `584L-Q2LS`: Authenticity Confirmed, no notice |
| `05-mailhog-coa-reissued-email.png` | The customer's "Certificate of Analysis Has Been Reissued" email for order 3166 naming the new code |
| `06-wp-old-primary-code-as-issued-after-lab-switched-off.png` | After the lab switched the pointer off in Mk1: the old code renders as issued, no notice (then switched back on) |
| `07-mk1-additional-old-code-forward-on.png` | Additional COA #1 after Regen: new code `5YFV-4AWH`; under Earlier versions the old `6RSP-FQSD` has Forward to current ON |
| `08-wp-old-additional-code-announces-successor.png` | WordPress verify page for `6RSP-FQSD`: Superseded banner linking to `5YFV-4AWH` |
| `run-notes.txt` | The IS public verdicts the spec read at each step (status, forward_enabled, current code) |
| `stack-logs-and-db-state.txt` | IS events (`generation_superseded`, `additional_coa_superseded`, `desktop_coa_forward_set` off then on, WordPress notify), Mk1 backend requests, WordPress `[COA Notify]` lines (Reissued email triggered), and the `coa_generations` and `wp_accumark_client_peptides` rows afterwards |
| `suite-output.txt` | Full Playwright list-reporter output |

## Configurations covered and not covered

Covered on the stack: the primary publish path (`publish_generation`) and the child publish
path (`_publish_additional_coas`, used by additional, per-vial and regular children) each
through the real Mk1 UI, COA Builder render, IS publish, WordPress notify and email; the IS
public endpoint; the WordPress verify page in all three states (announces, as issued, new
code verified); the lab's manual switch both ways; WordPress portal rows (old row stamped
`superseded_at`, new row live, in the DB capture).

Not covered here: per-vial and regular children end to end (same code path as the additional
COA, unit-tested), the SENAITE read-mode `PublishedCOACard` (same popover component; the
stack reads samples from Accu-Mk1), Kinsta's cache layers (not in the stack), and the
production database (the deploy-day census and rollout steps are on IS PR #45).

## Stack note

The stack's Integration Service had no `COA_BUILDER_URL`, so the additional-COA regenerate
route answered 503 "COA Builder unreachable". Fixed for this stack with an extra compose
override (`~/.accumark-stack/stacks/coarevoke/is-coabuilder.override.yml` setting
`COA_BUILDER_URL: http://coabuilder:5000`) and a recreate of the IS container with all
three compose files. That is a platform wiring gap, not a feature defect.
