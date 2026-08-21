# S9 (wpstar): Stored Wire Key + Demand Single-Sourcing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every `wc_test_services` row a stored `wire_key`, retire the four competing name-normalizers that cause the 0-vials-no-line-item bug class, land the Handler-approved heavy-metals cart fix, and single-source the vial-demand constants (STERILITY 2→1 pairing with Mk1's `c4bb27e8`).

**Architecture:** The slice base is assembled first: the unpushed `feat/wizard-catalog-addon-cards` branch (dual-path `Vials::for_addon_names()`, `profile_key`/`vials` option keys, `STERILITY = 1`) is replayed onto current `origin/master` as a new branch — reimplementing on master would mint a third variant. On that base: a NEW `wire_key` option key (identity only — `profile_key` keeps its separate catalog-card meaning per the 2026-08-06 ruling), alias-tolerant readers (historical orders carry alias-keyed data forever), classifier sites converted to wire-key-first with name-substring fallback, JS demand fallbacks deleted (fail loud).

**Tech Stack:** WordPress theme PHP 8.1, vanilla JS (no test runner), PHPUnit 9.6 + wp-phpunit via `devkinsta_fpm` (overlay pattern — see Global Constraints).

**This plan lives in the Mk1 S9 worktree** (`C:\tmp\Accu-Mk1-s9-demand\docs\superpowers\plans\`) because the wpstar deploy checkout must stay clean (deploys tar gitignored files) and the wpstar S9 worktree is created by Task 0 below.

## Global Constraints

- **Repos/worktrees:** shared wpstar repo; master checkout `C:\tmp\wpstar-coa-export` (READ + fetch only — never commit or leave untracked files there); addon-cards branch checkout `C:\tmp\wpstar-addon-cards` (READ only — the original branch stays untouched as rollback reference); **slice worktree `C:\tmp\wpstar-s9`, branch `feat/s9-wpstar-wirekey`, created in Task 0**. Theme root inside each: `wp-content/themes/wpstar/`.
- **Base = `origin/master`, NOT local master.** Local checkout is stale at 2.37.5; prod theme is 2.40.0 (master==prod). Always `git fetch origin` first and branch from `origin/master`.
- **PHPUnit invocation (composer test is BROKEN — PHP 7.4 fatals on `match()`):**
  `docker exec devkinsta_fpm sh -c 'cd <theme-dir> && php8.1 vendor/bin/phpunit -c phpunit.xml.dist [--filter X]'`
  A worktree outside the DevKinsta mount SILENTLY TESTS THE LIVE THEME (`wp-tests-config.php` hardcodes ABSPATH; WP loads the active theme from it). Use the overlay pattern: mirror the worktree into an isolated tree inside `devkinsta_fpm` and redirect `WP_CONTENT_DIR` — a working `run-phpunit.sh` exists from the sample-transfer work; find it before Task 6 (search `C:\tmp\*sample-transfer*`/old SDD workspaces; if unrecoverable, rebuild per the pattern: ABSPATH→real core, WP_CONTENT_DIR→mirrored tree, borrow live `vendor/` only after diffing `composer.json`, symlink woocommerce read-only). The test DB (`accumarklabs_test`) is dropped/reinstalled every run — NEVER point config at the live DB.
- **Suite baseline:** 44 test classes (Prepaid-heavy), ZERO coverage of `Vials`/`wc_test_services`/wizard, NO CI, NO JS test runner. Gate PHP by failure-set diff vs a Task-0 baseline run; JS changes are verified by the new PHP round-trip tests where possible plus fixture scripts — flag everything else for Handler UAT on DevKinsta.
- **`wc_test_services` is a `wp_options` serialized array** (not a table — no dbDelta/ALTER anywhere). Schema = whatever `handle_save_services()` writes. **Data-loss trap:** the handler rebuilds rows from POST with a fixed key list and overwrites the option unconditionally — every new key MUST land in the render form AND the save handler in the same commit, plus a round-trip test.
- **Option-key tolerance is forever:** existing stored rows lack any new key until an admin re-saves; every reader uses `$svc['wire_key'] ?? <fallback>` indefinitely. Same for order meta: historical `_sample_data['services']` is keyed by the JS name-alias forever — readers accept wire key FIRST, legacy alias as fallback, and never rewrite stored order data.
- **`profile_key` keeps its meaning** (Handler ruling 2026-08-06): non-empty `profile_key` + `vials > 0` means "catalog add-on card that adds its own vials"; the five legacy services keep it EMPTY. `wire_key` is pure identity. Do not merge the two, do not populate `profile_key` on legacy rows.
- **Do not bump `style.css` version** — versioning happens at deploy via the accumark-deploy flow.
- **Never push, never open PRs; Handler directs pushes.** Commit style: `<type>(s9-wp): subject`, body explains why, end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- SDD ledger: `C:\tmp\Accu-Mk1-s9-demand\.superpowers\sdd\2026-08-14-s9-wpstar-wirekey\progress.md`.
- **Deploy coupling (for the record, not for this build):** Mk1 S9 deploys BEFORE or WITH the theme (sterility pairing); theme FE+BE of this slice is one deploy unit.

## Standing rulings this plan implements (do NOT re-litigate)

1. **Handler 2026-08-14:** heavy-metals cart fix approved (customer-visible change, sign-off given).
2. **Handler 2026-08-14:** endo/ster classifier datafy IN scope (W6/W7).
3. **Handler 2026-08-13/14:** Mk1 catalog is the demand source of truth; WP synced manually — so WP demand constants stay constants here, but become single-sourced (one PHP definition, zero JS shadows).
4. **Handler 2026-08-05/06:** sterility = 1 vial; legacy rows keep empty `profile_key`.

---

### Task 0: Assemble the slice base (branch replay onto current master)

**Files:**
- Create: worktree `C:\tmp\wpstar-s9` on new branch `feat/s9-wpstar-wirekey`

**Interfaces:**
- Produces: a worktree where `Vials.php` has the dual-path `for_addon_names()` and `STERILITY = 1`, the admin page has `profile_key` + `vials` columns, AND all of current master (2.40.0 lineage: auth 2.38.0, promo 2.39.0, 2.40.0) is present. Every later task builds here.

- [ ] **Step 1: Fetch + verify the real master**

```bash
git -C /c/tmp/wpstar-coa-export fetch origin
git -C /c/tmp/wpstar-coa-export log --oneline -3 origin/master
```
Expected: `origin/master` is AHEAD of local master (`baf87db1`, 2.37.5) and its tree carries theme version ≥ 2.40.0 (check `git show origin/master:wp-content/themes/wpstar/style.css | head -12`). If origin/master is NOT ahead, STOP and report — the 2.38-2.40 deploy history contradicts that and the discrepancy must be resolved before building.

- [ ] **Step 2: Enumerate the addon-cards commits to replay**

```bash
git -C /c/tmp/wpstar-addon-cards log --oneline --reverse $(git -C /c/tmp/wpstar-addon-cards merge-base origin/master feat/wizard-catalog-addon-cards 2>/dev/null || echo 3b412b7)..feat/wizard-catalog-addon-cards
```
Known members: `3641bf0` (profile_key on wc_test_services), `dd85603` (vials column), `10b3e92` (wire-key dual-path Vials + STERILITY=1). Record the FULL list in the ledger. Inspect each for a `style.css`/CHANGELOG version bump — those hunks get dropped during replay.

- [ ] **Step 3: Create the worktree and replay**

```bash
git -C /c/tmp/wpstar-coa-export worktree add /c/tmp/wpstar-s9 -b feat/s9-wpstar-wirekey origin/master
cd /c/tmp/wpstar-s9
git cherry-pick <each commit from Step 2, in order>
```
Conflict policy: content conflicts in `Vials.php`/admin page → resolve keeping BOTH sides' intent (master's 2.38-2.40 changes + the branch's catalog work); version-stamp/CHANGELOG conflicts → keep master's side, drop the branch's bump. Record every conflict + resolution in the ledger. If a cherry-pick conflicts beyond mechanical resolution (semantic overlap), STOP and report rather than guessing.

- [ ] **Step 4: Post-replay sanity**

```bash
cd /c/tmp/wpstar-s9/wp-content/themes/wpstar
php8.1 -l src/Front/Vials.php && php8.1 -l src/Front/Cart_Order.php && php8.1 -l src/Front/MyAccount/Sample_Submission.php && php8.1 -l src/Admin/MyAccount/Sample_Submission.php
grep -n "STERILITY = 1" src/Front/Vials.php
grep -n "profile_key" src/Admin/MyAccount/Sample_Submission.php | head -5
```
(If `php8.1` isn't on the Windows host PATH, lint inside the container: `docker exec devkinsta_fpm sh -c 'php8.1 -l /path'` after Step 5's mirror, or use plain `php -l` if host PHP ≥ 8.1.)
Expected: clean lint; `STERILITY = 1`; profile_key present in the admin form.

- [ ] **Step 5: Baseline PHPUnit run (overlay pattern)**

Locate/rebuild `run-phpunit.sh` per Global Constraints, mirror `C:\tmp\wpstar-s9`, run the FULL suite once. Record the failure set verbatim in the ledger — this is the baseline every later task diffs against. (Expect possible pre-existing failures; do not fix them.)

- [ ] **Step 6: Commit nothing** — Task 0 produces replayed commits only. Verify `git log --oneline -8` shows the replayed set on top of origin/master and `git status` is clean.

---

### Task 1: `wire_key` on `wc_test_services` (form + save handler + seed, one commit)

**Files:**
- Modify: `src/Admin/MyAccount/Sample_Submission.php` — `handle_save_services()` (~:598-619 pre-replay; re-locate), the render form's `<th>`/`<td>` block (~:640-680), `DEFAULT_SERVICES` (~:103-139)
- Test: `tests/phpunit/TestServices/WireKeyRoundTripTest.php` (new)

**Interfaces:**
- Consumes: Task 0's base (the admin page already gained `profile_key`/`vials` there — `wire_key` follows the exact `dd85603` two-sided pattern).
- Produces: option rows may carry `'wire_key' => string` (sanitized via `sanitize_key`); `DEFAULT_SERVICES` entries carry canonical wire keys: `hplcpurity_identity` (HPLC Purity & Identity), `bac_water_panel` (if a Bac Water row exists in DEFAULT_SERVICES — verify; skip if absent), `endotoxin` (Endotoxin), `sterility_pcr` (Sterility (PCR)), `samplevariance` (Sample Variance). Rows without a stored wire_key are legal FOREVER (`?? ''`).

- [ ] **Step 1: Write the failing round-trip test**

```php
<?php
/**
 * Pins the handle_save_services() data-loss trap: any option key not carried
 * through BOTH the form and the save handler is silently wiped on the next
 * admin save. wire_key must survive a save round-trip.
 */
class WireKeyRoundTripTest extends WP_UnitTestCase
{
    public function test_wire_key_survives_save_round_trip(): void
    {
        $admin = new \WpStar\Admin\MyAccount\Sample_Submission();
        $_POST = [
            '_wpnonce'             => wp_create_nonce('save_services_nonce'),
            'service_name'         => ['Endotoxin'],
            'service_price'        => ['200'],
            'service_tooltip'      => [''],
            'service_product_id'   => ['0'],
            'service_type'         => ['addon'],
            'service_coming_soon_label' => [''],
            'service_profile_key'  => [''],
            'service_vials'        => ['0'],
            'service_wire_key'     => ['endotoxin'],
        ];
        $method = new \ReflectionMethod($admin, 'handle_save_services');
        $method->setAccessible(true);
        $method->invoke($admin);

        $saved = get_option('wc_test_services');
        $this->assertSame('endotoxin', $saved[0]['wire_key'] ?? null,
            'wire_key wiped by handle_save_services — form/handler pair incomplete');
    }
}
```
Adjust namespace/class path and nonce handling to the real code (read the class first — `check_admin_referer` may need the admin user + nonce fixture idiom used by existing admin tests; if none exists, set current user to an administrator via `wp_set_current_user(self::factory()->user->create(['role' => 'administrator']))`).

- [ ] **Step 2: Run to verify failure** — filter on the class; expected FAIL (`wire_key` key absent from saved row).

- [ ] **Step 3: Implement all three sides** (handler line in the POST loop: `'wire_key' => sanitize_key($_POST['service_wire_key'][$i] ?? ''),`; form `<th>` + `<td><input name="service_wire_key[]">` following the profile_key column's exact markup; DEFAULT_SERVICES wire keys; admin help text: "Wire key: canonical service identity used by the wizard, cart, and LIMS handoff. Never change after the service has sold. Distinct from Profile Key (catalog add-on cards).").

- [ ] **Step 4: Run the test** — PASS. Run the full suite filter-free; diff vs baseline.

- [ ] **Step 5: Commit** — `feat(s9-wp): stored wire_key on wc_test_services (form + handler + seed)`.

---

### Task 2: Heavy-metals cart fix (wire key through to `for_addon_names`)

**Files:**
- Modify: `src/Front/Cart_Order.php` addon-collection loop (~:361-400 — re-locate post-replay)
- Test: `tests/phpunit/Vials/CartAddonWireKeyTest.php` (new)

**Interfaces:**
- Consumes: the dual-path `for_addon_names()` from Task 0's replayed `10b3e92` (accepts entries carrying `wire_key`; bare strings keep legacy behavior).
- Produces: the cart's vial count resolves add-ons by `_addon_type` wire key — `heavy_metals` counts its vials in the cart (was 0), `sterility_usp71` resolves by key instead of legacy-branch coincidence.

- [ ] **Step 1: Read the replayed `for_addon_names()`** in `C:\tmp\wpstar-s9` and record its exact entry shape for wire-key input (array entries with `name`/`wire_key`? separate param? — `10b3e92`'s message says bare strings stay legacy-compatible; quote the real signature + matching loop in the ledger before writing the test).

- [ ] **Step 2: Write the failing test** — construct a parent order item + child add-on items the way `Cart_Order` sees them (a `heavy_metals`-wire-keyed child whose display name is "Heavy Metals Panel", plus an endotoxin child), call the cart path (or extract: call `for_addon_names` with the same entries the fixed loop will now build), assert the heavy-metals vials are counted per the row's `vials`/catalog rules and endotoxin still counts 1. Follow the entry shape from Step 1. If driving the full `Cart_Order` path in wp-phpunit is impractical (cart session machinery), test the seam instead: a small extracted builder method (Step 3) that converts child items → `for_addon_names` entries, tested directly with mock `WC_Order_Item_Product` doubles.

- [ ] **Step 3: Implement.** In the addon push (~:381), carry the key: `'wire_key' => (string) $child_item->get_meta('_addon_type'),` alongside `name`; at the call (~:399) stop flattening to names — pass entries in the shape `for_addon_names` expects (per Step 1). Extract the child-item→entries conversion into a small private method if that's what Step 2 tests.

- [ ] **Step 4: Run** the new test (PASS) + full suite diff vs baseline.

- [ ] **Step 5: Commit** — `fix(s9-wp): cart passes _addon_type wire keys to for_addon_names -- heavy-metals vials count in cart (Handler-approved 2026-08-14)`. Body cites orders #3267/#3278 evidence and the `set_name`/`set_product` root cause (NOT fixed here — display-name ordering stays, the wire key bypasses it).

---

### Task 3: Retire the PHP name-normalizers (wire-key-first product map)

**Files:**
- Modify: `src/Front/Cart_Order.php` (`build_service_product_map()` ~:1768-1790; lookup ~:1559-1566)
- Modify: `src/Front/MyAccount/Sample_Submission.php` (mirror map ~:884-887 and its lookup)
- Test: `tests/phpunit/TestServices/ServiceProductMapTest.php` (new)

**Interfaces:**
- Consumes: Task 1's stored `wire_key`.
- Produces: the service→product map is keyed by wire_key when the row has one, with the SIX-CHAR-STRIP normalized name as a fallback key for rows without (dual-keyed map: both keys point at the same entry). Lookups try the incoming key verbatim (wire key), then the legacy normalize. Historical `_sample_data` alias keys (whitespace-only strip, parens kept) keep resolving via a wire-key alias table built from the option rows.

Design detail the implementer must honor: the lookup input `$key` comes from `_sample_data['services']` — historically the JS alias (`'rapidsterilityscreening(pcr)'`), in future the wire key (`'sterility_pcr'`, Task 4). The map must answer BOTH forever. Build one map with THREE key classes per row: `wire_key` (if set), JS-alias-derived from name (`strtolower(preg_replace('/\s+/','',$name))` — parens KEPT, matching JS), and the legacy 6-char-strip normalize (existing behavior). All resolve to the same entry. This retires the divergence (every historical key form resolves) without a data migration.

- [ ] **Step 1: Write failing tests** — rows with and without wire_key; assert lookups succeed for (a) wire key, (b) JS alias with parens (`'rapidsterilityscreening(pcr)'` against name "Rapid Sterility Screening (PCR)"), (c) legacy 6-strip form; assert a name rename does NOT break resolution when wire_key is present (the bug class).
- [ ] **Step 2: Verify failure** (case (b) fails today — the 6-strip map never contained the parens-kept alias).
- [ ] **Step 3: Implement** in `build_service_product_map()`; replace the Sample_Submission mirror with a call to the same builder (kill the "keep in sync by hand" comment pair — one implementation; if class coupling forbids calling across, extract to a small shared helper class/trait and have both call it).
- [ ] **Step 4: Run** new tests + suite diff.
- [ ] **Step 5: Commit** — `feat(s9-wp): wire-key-first service product map, one builder, alias-tolerant lookups`.

---

### Task 4: JS wizard reads wire keys (23 alias sites) + `ADDON_TYPES` re-key

**Files:**
- Modify: `js/sample-submission.js` (alias-derivation sites: 473-475, 480-482, 1275, 1279-1282, 1314, 1321, 2768, 2774, 3272, 3296-3297, 3310-3312, 3422-3423, 3895-3896, 3905-3908, 5649-5650, 5662, 7442-7443, 7456 — line numbers are PRE-replay master; re-grep `toLowerCase().replace(/\s+/g` after Task 0 and enumerate in the ledger; count must be ≥ 23 or explain)
- Modify: `src/Admin/Addon_Upgrades.php` (`ADDON_TYPES` :43-47 + consumers :675, :693, :704-729)
- Test: extend `tests/phpunit/TestServices/` coverage for the PHP side; JS verified via Task 6 fixtures + UAT

**Interfaces:**
- Consumes: `wcSampleForm.testServices` already carries the raw option rows (localization ships new keys automatically — NO payload change needed); Task 3's alias-tolerant PHP map.
- Produces: one JS helper `serviceKey(svc)` = `svc.wire_key || svc.name.toLowerCase().replace(/\s+/g, "")` — every alias-derivation site calls it; `_sample_data['services']` from NEW orders is wire-key-keyed when the row has one. `ADDON_TYPES` gains wire-key primary keys with the old alias keys retained as tolerated legacy input.

- [ ] **Step 1: Add `serviceKey()`** near the top of `sample-submission.js` with a comment stating the contract (wire key when stored; legacy alias fallback; the PHP map accepts both). Convert ALL enumerated sites to call it. Mechanical, but each site's surrounding context differs — convert one logical cluster at a time, re-reading each.
- [ ] **Step 2: `ADDON_TYPES`:** re-key entries by `mk1_key` (which IS the wire key: `endotoxin`, `sterility_pcr`; `samplevariance` keeps its key — it's already the wire form). Update `selection_wants`/`sample_has_addon`/`resolve_addon_product` to look up by wire key FIRST and fall back to the legacy alias key for historical `_sample_data` (keep a small `LEGACY_ALIAS_KEYS = ['rapidsterilityscreening(pcr)' => 'sterility_pcr']` map with a comment explaining it exists for stored data, not new writes). Write/extend a PHPUnit test: `sample_has_addon` true for BOTH a wire-key-keyed and an alias-keyed stored `_sample_data`.
- [ ] **Step 3: Trace the readers of `_sample_data['services']`** across PHP (`grep -rn "sample_data\['services'\]\|_sample_data" src/ templates/ woocommerce/`) — every reader must tolerate both key forms (most go through Task 3's map or Task 2's `ADDON_TYPES` paths; enumerate any that don't and fix with the same fallback idiom). Ledger the inventory.
- [ ] **Step 4: Lint + suite.** `php8.1 -l` every touched PHP file; run the suite diff. JS: `node --check js/sample-submission.js` (syntax only — no runner exists).
- [ ] **Step 5: Commit** — `feat(s9-wp): wizard and addon plumbing speak wire keys, legacy aliases tolerated for stored data`.

---

### Task 5: Classifier + demand single-sourcing (W6/W7 + W4/W5)

**Files:**
- Modify: `src/Front/Vials.php` (:67-74 classification; verify post-replay), `functions.php` (:845-855), `templates/portal-create-order.php` (:33-52), `templates/portal-submit-sample.php` (:55-77), `src/Front/MyAccount/Sample_Submission.php` (:333-351)
- Modify: `js/sample-submission.js` (:218-232 and :7298-7308 — delete the vialRules fallbacks)
- Test: `tests/phpunit/Vials/VialsClassificationTest.php` (new)

**Interfaces:**
- Consumes: Tasks 1-4 (stored wire keys + `serviceKey()`).
- Produces: one PHP helper (static on `Vials` or a small `ServiceClass` helper): `classify_service(array $svc): ?string` returning `'endotoxin'|'sterility'|'variance'|null` — wire_key first (`endotoxin`→endotoxin; `sterility_pcr`/`sterility_usp71`→sterility; `samplevariance`→variance), name-substring fallback (existing behavior verbatim, including 'plating') for rows without a wire key. All five W6/W7 sites call it. JS demand fallbacks are GONE: missing `wcSampleForm.vialRules` logs `console.error` and renders no count rather than a silently-wrong one.

- [ ] **Step 1: Write failing classification tests** — wire-keyed rows classify by key even when RENAMED (the W6 hazard: "renaming a service silently changes how many vials are provisioned"); key-less rows classify by substring exactly as today; a renamed key-less row documents the residual hazard (assert current behavior + comment).
- [ ] **Step 2: Implement the helper; convert the five sites.** `functions.php:852-854`'s silent else→`hplc-ipq` catch-all: KEEP the catch-all (additive doctrine — its removal is a behavior change out of scope) but add a `error_log` breadcrumb when it fires for a row that HAS a wire key and still fell through (should be impossible; loud if not). The two adjacent primary-selection substring sites (`'HPLC Purity'` at Sample_Submission:333 / portal-submit-sample:55) are IN — same helper, `'hplcpurity_identity'` wire key.
- [ ] **Step 3: Delete both JS `|| { primary: 1, endotoxin: 1, sterility: 2 }` fallbacks.** Replacement shape at both sites: `var rules = wcSampleForm && wcSampleForm.vialRules; if (!rules) { console.error('wcSampleForm.vialRules missing — vial count unavailable'); return/skip render; }` (match each site's control flow — one is a function `computeSampleVials`, one an inline block; the function returns 0 with the error logged, the block skips the count render). NOTE: these fallbacks still say `sterility: 2` while `Vials::STERILITY` is 1 post-replay — deleting them removes the last hardcoded 2 in the theme; grep `sterility: 2` and `STERILITY = 2` afterward to confirm zero hits.
- [ ] **Step 4: Lint, suite diff, JS syntax check.**
- [ ] **Step 5: Commit** — `feat(s9-wp): wire-key-first service classification, JS demand shadows deleted (ster=1 single-sourced)`.

---

### Task 6: Label-map dedupe + fixtures + closeout

**Files:**
- Modify: `src/Front/Cart_Order.php` (:1626-1629), `src/Front/MyAccount/Sample_Submission.php` (:988-991) — Map A pair
- Modify: `woocommerce/checkout/form-pay.php` (:1159-1164), `templates/portal-view-order.php` (:1250-1255) — Map B pair
- Create: `tests/vials-s9-fixture.php` (theme-root loose harness, following `vials-wirekey-fixture.php`'s precedent from the branch)
- Modify: SDD ledger

**Interfaces:**
- Consumes: everything prior.
- Produces: Maps A and B each defined ONCE (a small static helper, e.g. `Vials::variance_label($mk1_key)` / `Vials::addon_upgrade_label($addon_type)`), both call sites converted; primary-label ternaries (Map C) left as-is but LEDGERED (3 PHP + 2 JS sites + the JS 7304-vs-7208 disagreement — a display-consistency follow-up, not S9-critical).

- [ ] **Step 1: Dedupe Maps A and B** (write the helper, convert the four call sites, keep the `?? ucfirst(...)` / `?? $au['name']` fallbacks identical). Suite diff.
- [ ] **Step 2: Fixture script** — extend/emulate the branch's `vials-wirekey-fixture.php`: builds option rows (with + without wire keys), runs `for_addon_names` through Task 2's entry shape for the HM case, prints expected-vs-actual. Heed `10b3e92`'s warning: fixtures encode assumptions — the fixture asserts against the STORED behavior contract (wire key resolution), and its output goes in the ledger, not in place of the PHPUnit gate.
- [ ] **Step 3: Full-suite run + failure-set diff vs the Task 0 baseline.** Grep closeout checks: `grep -rn "sterility: 2\|STERILITY = 2" .` → zero; `grep -rn "keep the two maps in sync" src/` → zero (the comment died with Task 3); the 23-site JS enumeration from Task 4's ledger each shows `serviceKey(`.
- [ ] **Step 4: Ledger closeout** — replay commit list, every conflict resolution, normalizer site inventory, `_sample_data` reader inventory, fixture output, baseline diffs, deferred items (Map C ternaries; `effectivePrices` name-keying deliberately untouched; `functions.php` catch-all retained; rest-proxy peptide normalizer out of scope).
- [ ] **Step 5: Commit** — `refactor(s9-wp): dedupe variance/addon label maps; s9 fixture + closeout`.

---

## Deferred OUT of this plan (ledgered, not forgotten)

| Item | Why | Where it lands |
|---|---|---|
| WP reads demand from Mk1 (`vialRules` from catalog) | Handler ruling: deferred; manual sync for now | Future sync slice (pairs with S5/IS registry) |
| Map C primary-label ternaries + JS 7208/7304 disagreement | Display-only; five sites across PHP/JS; not load-bearing for wire keys | Follow-up cleanup |
| `effectivePrices` name-keying | Display-only, localized comment says so; converting risks pricing display regressions for zero S9 value | Leave; note in ledger |
| `functions.php` else→`hplc-ipq` catch-all | Removing is a behavior change beyond additive doctrine | Breadcrumb added (Task 5); ruling backlog |
| rest-proxy compound normalizer (W24) | Peptide domain, not service identity | Peptide-requests program |
| `set_name()`/`set_product()` ordering in the addon-item loop | Changes existing order display; needs its own sign-off (per `10b3e92`) | Handler backlog |
| **W9-W25 long tail** (variance-eligible allowlist, fallback prices W10-W12, bundle SKUs W13, exact-name landmines W14, admin-grid map W16, sterility wording W17, status-map dedupe W19, bounds W20, turnaround copy W21, beta gate W22, availability normalizer W24, line-item name parsing W25) | Not in the adopted carry order's items 1-6; each needs its own small ruling or rides a different program | S9 follow-up backlog after the arc merges, individually ruled |

## Post-build follow-ups (NOT tasks here)

- Handler UAT on DevKinsta: wizard vial counts (HPLC/endo/ster/HM/AccuShield/BW), cart-vs-pay-page agreement for `heavy_metals` and `sterility_usp71`, admin services save round-trip, a full order flow → `_sample_data` keys.
- Deploy: theme ships AFTER or WITH Mk1 S9 (sterility pairing, arc deploy plan); FE+BE one unit.
- After the arc merges: revisit Map C + the JS label disagreement.
