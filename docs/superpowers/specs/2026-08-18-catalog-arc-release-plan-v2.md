# Catalog arc — consolidated release plan v2 (all four repos)

*2026-08-18. Supersedes the Mk1-only 2026-08-13 deploy plan (`2026-08-13-catalog-foundation-deploy-plan.md`) as the top-level map; that document's §3–§7 (Mk1 gates, backfills, verification, rollback) remain valid and are referenced, not repeated. Its §2 merge playbook is WRONG in two premises (found on arcitest 2026-08-14: the S3 guard passes unmodified — do NOT delete/reclassify entries; the S2×S4 test interaction is fixed on PR #100 pre-merge) — read §2 there as historical.*

*Legend: **FACT** = verified in code/logs/PR bodies; **HYP** = plausible, unverified; **CHECK** = the fastest way to settle it.*

---

## 0. What "the train" is today (2026-08-18)

Everything below is OPEN, review-clean, and HELD (Handler ruling: no master merges until the testing phase on `arcitest` is done). Live test surface: stack `arcitest` (devbox `100.73.137.3`, ports 5800–5819) — Mk1 `arcitest/mk1-full`, IS `arcitest/is-full`, coab `arcitest/coab-full`, wpstar `arcitest/wp-s9` (+ two hand-copied files for the badge slice, see §0.5).

### 0.1 Accu-Mk1 (`Zstar0/Accu-Mk1`) — prod 1.7.4, master == prod

| PR | Branch | Base | What | Notes |
|---|---|---|---|---|
| #87 | `docs/analysis-catalog-specs` | master | specs + plans (docs only) | |
| #88 | `feat/catalog-foundation` | #87 | spec 1: departments, service CRUD, profiles, admin UI | first boot builds the catalog layer on prod (absent today) |
| #89 | `feat/native-coa-sections` | #88 | spec 2: origin-gated promote, section builder, fail-closed attach | |
| #90 | `feat/catalog-order-routing` | #89 | spec 3: demand, seeding, hm role | pairs IS #20 + wpstar #20 |
| #91 | `feat/catalog-driven-bench` | #90 | spec 4: vial roles as catalog rows, ride lists, custody | 5 UAT deltas + CASCADE ruling pending |
| #93 | `feat/native-spec-ownership` | #91 | lab-owned specs + producer verdicts | pairs coabuilder #8 |
| #94 | `feat/s2s-catalog-keys` | #93 | S2S service-keys feed | pairs IS #27 |
| #95 | `feat/native-parent-analyses-table` | #94 | shared AnalysisTable | |
| #96 | `feat/native-parent-verification` | #95 | promote/verify flow | |
| #97 | `feat/native-parent-placeholders` | master (auto-retargets) | provenance `'ordered'` placeholders | mint ONLY via IS→Mk1 `/s2s/lims-samples` signal |
| #98 | `feat/analysis-amendment-audit` | #97 | ISO 7.5.2 before/after audit | 🔶 1 open ruling: `set_reportable` reason-only no-op |
| #99–#104 | S1/S4/S6/S8/S2/S3 | #98 (siblings off `b30d9fc0`) | roles-as-data · change log+snapshot · hygiene · adoption guard · worksheets off groups · identity convergence | **#100 needs the S2×S4 test fix pre-merge**; S3 has the pre-check gate |
| #105 | `feat/spec-ownership-s2-specs-editor` | #98 | specs editor + peptide tier | Handler veto window R4/R5/R6 + M-7 auth posture |
| #106 | `feat/coa-display-fields` | #105 | LOQ / basis / method / prep / footnotes on the wire; `< LOQ` censoring | pairs coabuilder #13; **deploy #106 before/with coab #13** |
| (unpushed) | `feat/s9-demand-dehardcode` @ `ebc46040` | `b30d9fc0` | S9: catalog IS the demand oracle; `MK1_DEMAND_LEGACY_WINS=1` kill switch | 4 standing deploy notes (§4.1); pairs wpstar S9 |

### 0.2 Integration Service (`ValenceAnalytical/accumark-integration-service`) — prod 1.0.18

| PR | Branch | Base | What | Notes |
|---|---|---|---|---|
| #19 | `feat/native-coa-sections` | master | fail-closed native-section fetch on both ACOA doors | **CHECK §3.2**: behavior when Mk1 has no native sections / no endpoint |
| #20 | `feat/catalog-order-routing` | #19 | declared service-key registry, recorded 422, native-only orders | |
| #27 | `feat/catalog-registry` | #20 | registry sync from Mk1 S2S feed | **REQUIRED pre-merge: replay `0f91eba` (alembic re-id `w1x2y3z4a5b6` → `x2y3z4a5b6c7`)** — else a fresh deploy fails "Revision present more than once" |
| #2 | `fix/coa-generations-sort-primaries-first` | master | unrelated fix | ride whenever |

### 0.3 COABuilder (`ValenceAnalytical/coabuilder`) — prod 2.30.2

| PR | Branch | Base | What | Notes |
|---|---|---|---|---|
| #5 | `feat/native-coa-sections` | master | validation, baked specs, paginated renderer | fail-closed only when sections are present |
| #6 | `feat/catalog-order-routing` | #5 | catalog-vs-baked unit divergence warning | |
| #8 | `feat/native-spec-wire` | #6 | trust Mk1-filled `specification`/`conforms` | pairs Mk1 #93 |
| #13 | `feat/native-coa-restyle` | #8 | restyle, adaptive columns, LOQ, method line, footnotes, digital contract (`native_sections` in `coa_data`) | **unit folding is unconditional → regenerating an existing HM/micro cert drops its per-row Unit column vs the issued PDF** (regen backlog awareness) |

### 0.4 WordPress theme + plugin (`Zstar0/accumarklabs`) — prod theme 2.42.0, plugin 1.5.4

| PR | Branch | Base | What | Notes |
|---|---|---|---|---|
| #20 | `feat/catalog-order-routing` | master | explicit `profile_key` wire keys on `wc_test_services` | pairs Mk1 #90 / IS #20 |
| (unpushed) | `feat/s9-wpstar-wirekey` @ `da95156` | master (83e0a66 + 30 replayed addon-cards commits) | wire_key column + guard, hm cart fix, Service_Product_Map, wizard tolerance | **UAT list is a MERGE CONDITION**; wire-key activation is a staged deploy-window step (§4.4) |
| #43 | `feat/accuverify-scoped-access` (2.43.0) | master | AccuVerify scoped keys P1 (ships inert) | 🔴 **runbook I-1**: wp-eval migrations + column-verify + existing-key smoke IMMEDIATELY post-file-land or every plugin key 401s; **`WPSTAR_VERSION` still 2.25.6 on that branch — fix in the runbook or its CSS never busts** |
| #44 | `feat/accuverify-native-sections` (2.44.0) | master | native sections on the verify page + table restyle | needs `native_sections` in `coa_data` (coab #13) to show anything; renders as today otherwise |
| (unpushed) | `feat/badge-native-sections` @ `e52bdd4` | #44 | badge v1.6.0 (XL C3, T1 ledger, mobile XL, full/md/sm/xs), endpoint allowlist, theme 2.45.0, plugin 1.6.0 pointer, verify page badge = md | PHPUnit `BadgeNativeSectionsTest` runs post-merge (container-only); plugin zip built at deploy |
| #28, #25, #21, #16, #15 | misc | master | edit-order addon restore · transfer docs · enterprise credits (flag OFF) · portal COA links · design-sync | NOT part of this arc — schedule separately |

### 0.5 What is on `arcitest` right now that is NOT in a PR
- wpstar `~/worktrees/wp-arcitest` carries hand-copied `src/Api/BadgeEndpoint.php`, `js/accuverify-badge-embed.js`, `js/badge/v1.6.0/`, and `templates/accuverify-content.php` (badge md) as UNCOMMITTED modifications on `arcitest/wp-s9`. Proper state = merge the badge branch into the composition once pushed. Any `git checkout --`/restore on the devbox drops them.

---

## 1. Merge order (per repo) and cross-repo deploy order

**Merge order** is forced by the stacks: Mk1 #87→…→#96, #97→#98, then #99–#106 in any order that respects their bases (S9 last on Mk1); IS #19→#20→#27; coab #5→#6→#8→#13; wpstar #20, then S9-wpstar, then #44→badge (and #43 whenever its own UAT is done — it is independent of the arc).

**Deploy order for the arc — Mk1 → IS → COABuilder → WordPress**, health-checked between each (`accumark-deploy` skill). This deliberately DIFFERS from the skill's generic stack order (IS→COA→Mk1→WP) because IS #27's registry sync pulls from Mk1's S2S feed (#94) and coab #8/#13 trust fields Mk1 fills — Mk1 must be up first. `JWT_SECRET` is untouched by every PR here (**FACT**: no rotation window needed; still verify the three copies match before starting, standing rule).

**Recommended waves** (rollback unit = wave):

| Wave | Contents | Why together | Blast radius on EXISTING prod orders |
|---|---|---|---|
| **W0 — display-only, can go first** | wpstar #44 + badge branch (theme 2.45.0 + plugin 1.6.0 pointer) | both are additive readers of `native_sections`, which prod payloads don't carry yet → they render exactly today's content; low risk, high visibility of the XL/mobile rework | none on orders; caches (§4.5) |
| **W0' — independent** | wpstar #43 (AccuVerify P1) | its own program; ships inert; hard runbook I-1 | none on orders; **plugin keys 401 until migrations land** — I-1 |
| **W1 — the arc core** | Mk1 chain (#87…#106 + S9) as ONE Mk1 release; then IS #19/#20/#27 (with the re-id fix); then coab #5/#6/#8/#13; then wpstar #20 + S9-wpstar (theme bump), with the staged wire-key activation | the catalog layer, registry, wire, renderer and storefront keys are one contract | see §3 |
| **W2 — cleanup** | shadow-period retirements one release after W1 (S9 divergence log; demand ternary), regen backlogs (blank-logo certs, unit="text" variance COAs, HM certs re-render) | separate programs | regen mints new codes — sign-off per program |

W0 before W1 is safe **because** the badge/verify page treat an absent `native_sections` as "render as today" (pinned in coabuilder tests + WP mapper defaults). W1 could also carry W0; the split just buys a low-risk rehearsal of the theme+plugin path.

---

## 2. Hard pre-MERGE fixes (three known + one new)

1. **IS #27 alembic re-id** — replay `0f91eba` onto `feat/catalog-registry` (rename file, chain after `transfer_columns`). Gate: `alembic heads` shows one head on the merged tree.
2. **Mk1 #100 S2×S4 test interaction** — fix on #100 (documented in the arcitest ledger). Gate: `pytest` failure node-id set == baseline 68F/14E (never "zero failures").
3. **Deploy-plan §2 correction** — the S3 guard passes unmodified; do NOT delete/reclassify entries when S2/S1 merge (arcitest proof 2026-08-14).
4. **wpstar #43 `WPSTAR_VERSION`** — bump `functions.php:21` (2.25.6 → 2.43.x) so its CSS busts (#44/badge already set 2.44.0/2.45.0; resolve the ordering: whichever merges last owns the higher number).

---

## 3. What can break EXISTING orders in prod — component by component

The design rule across the arc is *additive-only* (new tables/columns/rows; no destructive migrations; keyword identity grandfathered; back-compat owed to existing prod samples). Below is where that rule is load-bearing and what to check.

### 3.1 Accu-Mk1
- **FACT — prod has NONE of the catalog layer** (memory `project_catalog_layer_not_in_prod`). First boot of W1 creates departments/vial_roles/profiles/change_log/snapshot columns, seeds, and runs `backfill_departments`, S1 role seeds, S6 PUR_/QTY_ reconciler, S2 worksheet department backfill, S3 indexes, S8 flag seed (2026-08-13 plan §4). Existing `lims_samples`/`lims_analyses`/results rows are not rewritten. Expected boot noise: `migration_skipped` for the stale `review_state` CHECK (benign) and a first-pass ordering skip that self-heals on the second boot (arcitest first boot 2026-08-14 — restart mops it up).
- **S3 identity indexes** — the one *manual* backfill class: run `scripts/s3_identity_precheck.py --env-label prod` (read-only, via `docker exec -w /app -i accu-mk1-backend python < script`) BEFORE deploy; `exit 3` = would-be violations → human dedupe; `exit 2` = the existing keyword index is missing → stop. **HYP:** prod exit 0 (no mk1-origin catalog rows exist yet). **CHECK:** run it now — it is read-only.
- **S6 PUR_/QTY_ reconciler** touches Mk1-LOCAL auto-derived rows only (never SENAITE) — reads the counts report post-boot. **HYP:** no visible change for lab staff. **CHECK:** boot report + `GET /debug/catalog-departments`.
- **S9 demand flip (catalog prevails)** — changes vial-plan/box-label numbers wherever WP and the Mk1 catalog disagree. Known divergence: sterility 2→1 (Handler ruling; s3rehe verified). For **in-flight** samples the box-label view recomputes on read: an order quoted at 2 sterility vials shows 1 after the flip. `demand_divergence` ERROR fires per call on a drifted env (observability, not incident). Rollback = `MK1_DEMAND_LEGACY_WINS=1` (strict `1`), BUT run the standing-note SELECT first (§4.1 #3) — post-flip families anchored on legacy roles zero-clamp while the switch is on.
- **S2 worksheets** — FE+BE must move together (inbox wire re-means `group_id`); a stale desktop client mid-window sends department ids as `service_group_id` → backend 400 (fail-visible). Cut the desktop release AFTER the web/backend, per the skill.
- **#97 placeholders / catalog family provisioning** — check-in-triggered, signal-minted; existing in-flight orders registered before W1 get no placeholders (expected; re-signal heals if wanted). Nothing changes on their COAs.
- **#98 amendment audit** — new rows on new transitions only. Open ruling (`set_reportable` reason-only no-op) is a production-behavior change awaiting nod.
- **Deploy mechanics traps (standing):** deploys tar GITIGNORED files → clean worktree first; `deploy.py` health/NR/backup-verify checks lie → retry/verify by hand; NEVER deploy from a stack worktree; prod pg is DO-managed (no pg container).

### 3.2 Integration Service
- **CHECK (blocking for W1 order):** IS #19 "fail-closed fetch on both additional-COA doors" — confirm what happens for a sample whose Mk1 returns no native sections (older orders) and for the window where Mk1 is already deployed but has no sections for the sample: expected = "no sections → proceed" (fail-closed only on a *malformed/failed* fetch). Prove on arcitest with a golden ACOA regen before W1. If it blocks, W1's Mk1→IS gap becomes a COA-publish outage for ACOAs.
- **#27 migration re-id** (§2.1) — deploy-blocker, not data risk.
- **#20 native-only orders + recorded 422** — new order shapes only; existing orders untouched.
- IS `.env` is prod-only (`/root/integration-service/.env`); never overwrite; the "IS tracks `.env local`" ledger item stands.

### 3.3 COABuilder
- Existing issued PDFs are immutable; risk is only on **regeneration**: coab #13's unit folding changes an existing HM/micro cert's layout on regen; regen also mints a new verification code (supersede) — this intersects the ~90 blank-logo + ~70 unit="text" backlogs. Rule: no bulk regen without sign-off; one-off regens are visible in the badge/verify chain within 60s (transient) + Kinsta TTL.
- Renderer contract: notes measured AND drawn in Helvetica; pagination pre-flight inside the 422 try (a layout abort precedes code minting) — both pinned by tests.
- Topology traps: wave1 hits the `:5000` baked image; deploy.sh tag/release/NR steps broken from worktrees (do by hand); detached HEAD intentional.

### 3.4 WordPress (highest live-order exposure — orders live here)
- **S9-wpstar wire-key activation is a TWO-STEP deploy-window procedure** (merge condition from both final reviews): (1) deploy the theme; (2) in the same window populate `wire_key` on the **Sterility row = `sterility_pcr`** first, then other rows, **HPLC Purity & Identity primary LAST** (widest blast: flips primary service key + `Cart_Order` resolution). Helper code is dormant until rows carry keys. **Existing-order test that must pass live:** re-edit a HISTORICAL order after populating → add-on selection survives (the JS stored-data tolerance). Admin runbook rule: NEVER set `type=addon` on a coming-soon row without a `profile_key` (six rows are one dropdown from the sterility slot).
- **Money paths changed:** AccuShield bundle price (untested arithmetic restructure), heavy_metals now billed as a line item (was 0 vials / no line item on the cart path), variance labels at three call sites with no test coverage → live UAT on arcitest is the only proof; that is the merge condition list in `C:\tmp\Accu-Mk1-s9-demand\.superpowers\sdd\2026-08-14-test-phase-checklist.md` §2.
- **#43 I-1** — the plugin's `/client/*` auth reads new columns; between file-land and `wp eval` migrations every customer key 401s. Run migrations + column-verify + existing-key smoke IMMEDIATELY after the theme lands (seconds, scripted). Existing keys grandfather to `all` (Handler-ruled backwards-compat).
- **#44 / badge (W0)** — display only. Existing orders/COAs unaffected; verify page's inline badge becomes md; homepage/TrustProblem `size="full"` showcase badges grow ~200px only when their code carries a native section (latent until W1); Full Report on phones changes from SM to a real mobile XL (behavior change, intended).
- **Kinsta:** never "Push to Production" with DB sync; page cache is header-deaf → after theme deploy `wp kinsta cache purge --all` (both `/accuverify/*` and `/badge/*` serve stale until TTL otherwise); `/client/*` bypass rule stays; `WPSTAR_VERSION` is the CSS/JS buster (style.css is not).
- **Plugin release (W0):** `PluginUpdateEndpoint` advertises 1.6.0 immediately → build + upload `accuverify-woocommerce-1.6.0.zip` (`php scripts/release.php`) BEFORE the theme deploy or customers see a dead update.

---

## 4. Deploy runbook per wave (checklists)

### 4.0 Before any wave
- [ ] `JWT_SECRET` identical across WP `wp-config.php` / IS `.env` / coab `.env` (skill §JWT) — verify, don't rotate.
- [ ] Clean worktrees; correct checkouts (`C:/tmp/wpstar-coa-export` = master pattern; NEVER the DevKinsta checkout).
- [ ] Prod backups verified by hand (deploy.py's check lies).
- [ ] Post-deploy purge/health commands staged in the terminal.

### 4.1 W1 — Mk1 (one release: 1.8.0)
- [ ] `s3_identity_precheck.py --env-label prod` → exit 0 (or human dedupe first); `s9_demand_precheck.py` → 4 legacy rows, `sterility_pcr vials_required=1` (seed can NEVER heal a wrong non-zero value).
- [ ] Deploy backend + web; watch boot: catalog tables + seeds; both S3 indexes present in `pg_indexes`; expected `migration_skipped` set only; restart once for the self-healing skip.
- [ ] Re-run both prechecks post-boot; department totality report; a catalog edit writes `catalog_change_log`.
- [ ] `MK1_DEMAND_LEGACY_WINS` UNSET (flip live); the standing SELECT (S9 note #3) recorded for the rollback runbook.
- [ ] Desktop release cut AFTER web/backend (S2 FE+BE coupling).
- [ ] Standing S9 notes: precheck pre+post; divergence ERROR per call is expected on a drifted env; kill switch is `1` not `true`.

### 4.2 W1 — IS (1.0.19)
- [ ] #27 re-id verified (`alembic heads` = 1); deploy; `/v1/healthz`; registry sync pulls keys from Mk1 (`/s2s` feed) — inspect the registry table; ACOA regen of a golden-style sample proceeds (§3.2 CHECK answered).

### 4.3 W1 — COABuilder (2.31.0)
- [ ] Deploy (by hand steps for tag/release/NR); `/health`; regenerate ONE non-native cert → byte-comparable to today's layout; ONE native (HM) cert → restyled section + digital contract present in `coa_data`.

### 4.4 W1 — WordPress (theme 2.4x, S9 + #20)
- [ ] Deploy theme; purge Kinsta; then the staged wire-key activation (Sterility → others → HPLC primary LAST) with the historical-order re-edit check after the first row.
- [ ] Money UAT re-confirmed on prod with a test order: AccuShield bundle total, HM line item, cart-vs-pay-page vial agreement (`heavy_metals` = 2 both surfaces).

### 4.5 W0 — theme #44 + badge, plugin 1.6.0
- [ ] Build/upload plugin zip; deploy theme (2.45.0 → `WPSTAR_VERSION` bumped — verify `?ver=2.45.0` on `accuverify-badge-embed.js` in page source); `wp kinsta cache purge --all`.
- [ ] Post-merge FIRST: `docker exec devkinsta_fpm sh -c 'cd /www/kinsta/public/accumarklabs/wp-content/themes/wpstar && php8.1 vendor/bin/phpunit -c phpunit.xml.dist --filter "BadgeNativeSections|AccuVerify|CoaDataMapping"'` (composer install first) — the theme's PHP tests are container-only.
- [ ] Smoke: `/wp-json/accumark/v1/badge/{a live code}` carries `native_sections: []`; verify page renders (md badge); Full Report XL opens; a customer plugin site still renders its badge (pinned to v1.5.4 until it updates).
- [ ] #43 (if in this wave): I-1 sequence within seconds of file-land; unscoped-key regression pass.

---

## 5. Rollback posture (per component)
- Mk1: code rollback is safe; S3 indexes may outlive it (never DROP by hand); S9 kill switch with the pre-switch SELECT; S2 FE+BE together. No destructive migrations exist.
- IS: image rollback; the re-id'd migration is additive.
- COABuilder: image rollback; issued PDFs untouched; regen'd certs stay superseded (new codes) — that is the irreversible part, hence sign-off per regen.
- WP theme: redeploy previous tag + purge; plugin: previous zip stays downloadable? — **CHECK** `PluginUpdateEndpoint` only advertises `CURRENT_VERSION`; rolling the constant back re-advertises 1.5.4 (sites already on 1.6.0 keep working — the badge JS is fetched from the theme URL that still exists). Wire-key rows populated in the window are data — rollback = clear them (documented recipe in the S9 wpstar ledger).

---

## 6. Open sign-offs (Handler) — the train stays HELD until these are cleared or explicitly waived
1. arcitest UAT merge-condition list (`…\2026-08-14-test-phase-checklist.md` §2–§3): AccuShield bundle price · HM cart vials/billing · labels at 3 call sites · wire-key activation recipe · S8 quarantine flow · S1/S2/S3/S4 items · HM capstone COA (done 2026-08-17 for P-0156).
2. S9 vetoable rulings (double-substring collapse · plating widening · uniform classifier) + sterility 2→1 as the catalog truth.
3. #98 `set_reportable` reason-only no-op; specs-editor R4/R5/R6 + M-7; #97 s3rehe verify-flow UAT.
4. #106/coab #13 display calls (LOQ `:g` vs 2 dp; centered vs right-aligned numerics) — cosmetic, all three surfaces.
5. #43 UAT on DevKinsta (staged at `024e8e8`) + its `WPSTAR_VERSION` fix.
6. Badge branch: push + PR (stacked on #44) — pushes are Handler-directed.
7. Unrelated but pending: promo-abuse mode LOG → enforce (21 groups awaiting review).

## 7. Recommended next step for de-risking prod
Do a **prod dress rehearsal on the stack platform**: fresh golden refresh from a current prod snapshot (`golden refresh` procedure; NEVER `pg_restore --clean` onto new images), then run §4.1–§4.4 in order against it exactly as written, timing each step and capturing the precheck outputs. That converts every **HYP** above into a **FACT** before anything touches `165.227.241.81` or Kinsta, and it is the only way to answer "will prod's first arc boot look like arcitest's" with evidence.
