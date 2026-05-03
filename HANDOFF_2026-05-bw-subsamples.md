# Handoff — 2026-05 Release: Bac Water + Sub-Samples + UI Polish

**Status:** All code changes complete and verified locally. **Uncommitted in all repos.** Ready for per-repo commit groupings + production deploy.

**Last updated:** 2026-05-03

---

## TL;DR

This release ships three intertwined feature sets:

1. **Bacteriostatic Water (BW) order pipeline** — new analytical test, end-to-end from WP wizard → SENAITE → coabuilder PDF → digital COA on AccuVerify page → embedded badge.
2. **Sub-Samples (Phase 24)** — vial-level receiving in Accu-Mk1 with parent/child linkage, 4-layer guard preventing sub-samples from publishing to WP and clobbering parent COAs.
3. **UI polish pass** — digital COA badge fixes (MEASURED color, BA spec, verification code on smaller sizes), portal new-order wizard attention cues, checkout payment styling overhaul.

---

## Workspace layout

```
c:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\
├── Accu-Mk1/                    Tauri desktop app + FastAPI backend (lab workflow)
├── coabuilder/                  Python COA PDF generator (FastAPI service)
├── integration-service/         FastAPI orchestration (WP ↔ SENAITE ↔ Mk1 ↔ coabuilder)
└── (no workspace-level repo — accumarklabs lives under DevKinsta volume)

\\wsl.localhost\docker-desktop-data\data\docker\volumes\DevKinsta\public\accumarklabs\
├── wp-content/themes/wpstar/    The accumarklabs WP theme
└── wp-content/plugins/accuverify-woocommerce/    Customer-installable embed badge plugin
```

---

## Current versions (post-release)

| Repo | File | Version |
|---|---|---|
| accumarklabs theme | `style.css`, `functions.php` (`WPSTAR_VERSION`) | **2.23.1** (uncommitted) |
| accuverify-woocommerce plugin | `accuverify.php` (`Version`, `ACCUVERIFY_VERSION`) | **1.2.3** (uncommitted) |
| theme `PluginUpdateEndpoint::CURRENT_VERSION` | `src/Api/PluginUpdateEndpoint.php` | **1.2.3** (uncommitted) |
| Plugin `ACCUVERIFY_BADGE_JS_URL` path | `accuverify.php` | `…/badge/v1.2.3/…` (uncommitted) |
| integration-service | `pyproject.toml`, `app/__init__.py` | **0.34.0** (uncommitted) |
| coabuilder | `src/coabuilder_core/__init__.py` | **2.14.0** (uncommitted) |
| Accu-Mk1 | `package.json` | **0.32.0** (uncommitted) |
| Plugin ZIP | `wp-content/uploads/accuverify/accuverify-woocommerce-1.2.3.zip` | built ✓ |

---

## What was built this cycle

### 1. Sub-Samples (Phase 24)

**Goal:** Capture vial-level (sub-sample) receiving in the lab without losing parent linkage. Each sub-sample has its own SENAITE record but inherits the parent's ClientOrderNumber.

**Key decisions:**

- **Sub-sample naming:** `<parent>-S\d{2}` (e.g. `BW-0006-S01`, `BW-0006-S02`). Canonical regex used across 4+ files for guard logic.
- **Inheritance via SENAITE `INHERITABLE_FIELDS`:** parent's `ClientOrderNumber` (the WP order ID) auto-flows to sub-samples. Set in [`Accu-Mk1/backend/sub_samples/senaite.py:322`](Accu-Mk1/backend/sub_samples/senaite.py).
- **Sub-samples never publish to WP — Option A.** Publishing a sub-sample's COA would clobber the parent's COA on the WP order (because both share the same `ClientOrderNumber` and WP receiver links by `order_ref + slot_index`). Implemented as a 4-layer defense:

  | Layer | File | Behavior |
  |---|---|---|
  | UI hide | [`Accu-Mk1/src/components/senaite/SampleDetails.tsx:2288-2296`](Accu-Mk1/src/components/senaite/SampleDetails.tsx) | Publish menu item wrapped in `{isParent && (...)}` |
  | Mk1 backend 403 | [`Accu-Mk1/backend/main.py:7847-7857`](Accu-Mk1/backend/main.py) | `publish_sample_coa` returns 403 for `-S\d{2}$` IDs |
  | IS desktop 403 | [`integration-service/app/api/desktop.py:1349-1370`](integration-service/app/api/desktop.py) | Early reject sub-sample IDs in publish endpoint |
  | IS webhook 403 | [`integration-service/app/api/webhook.py`](integration-service/app/api/webhook.py) | 403 at top of `/coa-ready` handler — catches SENAITE custom button via `urllib.urlopen` HTTPError → SENAITE shows error inline |

- **No SENAITE modification.** Earlier draft modified SENAITE's `coa_publisher.py` directly; refactored to use IS-side 403 so the SENAITE codebase stays vanilla.
- **Shared helper:** [`integration-service/app/utils/sub_sample.py`](integration-service/app/utils/sub_sample.py) exports `SUB_SAMPLE_RE`, `is_sub_sample_id()`, `SUB_SAMPLE_PUBLISH_BLOCKED_MSG`.

### 2. Bacteriostatic Water (BW) Order Pipeline

**Goal:** Add BW as a first-class analytical test alongside Single Peptide and Peptide Blend, end-to-end. BW samples test for Benzyl Alcohol Assay (BA), pH, and Fill Volume — plus optional Endotoxin (ENDO) and Sterility (STER) addons.

**Phase A — Accu-Mk1 schema/seed**

- New `peptides.analyte_class` column (`'peptide' | 'additive'`, default `'peptide'`).
- Benzyl Alcohol seeded as a peptide row with `analyte_class='additive'`. Idempotent migration in `_run_migrations()` ([backend/database.py:219-231](Accu-Mk1/backend/database.py)).
- BA gets `abbreviation='Benzyl Alcohol'` (full name, not "BA") because the wizard surfaces this directly.
- `GET /peptides` accepts opt-in `?analyte_class=` filter.
- Step1SampleInfo wizard filter: BW samples only see additive-class peptides (BA), peptide samples don't (so BA doesn't pollute peptide picker).

**Phase C — integration-service Analyte1Peptide**

- IS senaite adapter ([`adapters/senaite.py:1759-1767`](integration-service/app/adapters/senaite.py)) now sets `analyte_fields["analyte1_peptide"] = "Benzyl Alcohol"` for BW samples (was empty). This flows through to the SENAITE custom field, which coabuilder reads to identify the analyte.

**Coabuilder dispatch + rendering**

- **Matrix dispatch fix** (commit `339c287`): `_PEPTIDE_MATRICES = {"Peptide", "Peptide Blend"}` routes to `ConformanceEngine`; everything else → `GenericAssayEngine`. Was previously keyed on test_type, which silently dropped BW analytes.
- **Generic profile coa_data shape:** non-peptide samples emit `results: { tests: [...] }` (flat list, one per analysis) instead of peptide-style `purity/identity/quantity` buckets.
- **Shared addon parser:** `src/coabuilder_core/addon_parsing.py` owns ENDO/STER row construction. Both `ConformanceEngine` (peptide) and `GenericAssayEngine` (BW) call `parse_addon_results()` so Pass/Fail mappings can't drift.
- **Generic engine addon rollup:** failed addon → sample FAILED; pending addon → IN REVIEW.
- **2-page COA when BW + addons:** `resolve_templates()` returns `["Generic Page 1", "Blend Page 2 - 4 Analyte_Addons"]` when matrix is non-peptide AND `addon_results` is non-empty. Single-page BW (no addons) unchanged.
- **`sample_name` override fix** (this session): non-peptide override at [`senaite_client.py:539-548`](coabuilder/src/coabuilder_core/senaite_client.py) used to always set `sample_name = sample_code` (the SENAITE ID), masking the customer's typed name. Now only fires when `client_sample_id` is empty or literally equals `matrix_type`. Customer-typed names like "Bacteriostatic Water 111" now survive to PDF and digital COA. **Requires coabuilder image rebuild** (`docker compose up -d --build coabuilder`).

**Baked specs** ([`coabuilder/src/coabuilder_core/baked_specs.py`](coabuilder/src/coabuilder_core/baked_specs.py)):

| Matrix | Keyword | Spec |
|---|---|---|
| Bacteriostatic Water | `Benzyl_Alcohol_Assay` | 0.9% (v/v) ±10% |
| Bacteriostatic Water | `PH-DETERM` | 4.5 – 7.0 |
| Bacteriostatic Water | `FILL-NET-CONTENT` | (no spec — depends on label claim) |

> Naming convention: `Benzyl_Alcohol_Assay` uses underscores, `PH-DETERM` / `FILL-NET-CONTENT` / `ENDO-LAL` / `STER-PCR` use dashes. Don't mix — coabuilder's keyword lookup is exact-match.

### 3. Digital COA + Badge UI

**WP theme verify_code parser** ([`src/Integration/IntegrationService.php`](\\wsl.localhost\docker-desktop-data\data\docker\volumes\DevKinsta\public\accumarklabs\wp-content\themes\wpstar\src\Integration\IntegrationService.php)):

- Added `is_generic` branch alongside `is_blend` and single-peptide. Maps coabuilder's `results.tests` flat list into `core_panel_results` so BW renders BA/pH/Fill in the existing Core Panel table.
- Fill Volume specification blanked at parser (no baked spec, was shipping `"—"`).
- Biosafety Panel (ENDO/STER) was already wired through `results.addons` — no change needed.

**AccuVerify badge web component** ([`js/accuverify-badge-embed.js`](\\wsl.localhost\docker-desktop-data\data\docker\volumes\DevKinsta\public\accumarklabs\wp-content\themes\wpstar\js\accuverify-badge-embed.js)):

- **MEASURED status now black** (was warn-slate orange). New `colorClass: 'measured'` returned by `_resultStatus()`, with CSS rules `.fb-status.measured`, `.fb-value-status.measured`, `.dot.measured` using `var(--card-text)`.
- **Five render call sites** refactored to read `_s.colorClass` instead of inline `r.conforms ? 'pass' : 'warn'` ternaries.
- **BA spec restored on badge** — peptide-flavored `/identity|hplc/i` regex was incidentally hiding `"Benzyl Alcohol Assay (HPLC)"` spec. Now gated on `data.matrix_type` matching `^peptide(\s|$)`.
- **Verification code in top-right of smaller sizes** (was XL only). FULL/MD show "Verification Code" label + code stacked above status. SM shows just `#TEYQ-BM79` (label hidden, hash-prefix). XS still hides header-right (too narrow).
- **Versioned snapshot at v1.2.3:** `js/badge/v1.2.3/accuverify-badge.js` cut, byte-identical to the embed file. Plugin's `ACCUVERIFY_BADGE_JS_URL` now points here.

### 4. Plugin Release (accuverify-woocommerce 1.2.3)

- Bumped via `php release.php 1.2.3` from `plugins/accuverify-woocommerce/scripts/`.
- Updates `accuverify.php` Version + `ACCUVERIFY_VERSION` + `ACCUVERIFY_BADGE_JS_URL`, `readme.txt` Stable tag, builds the ZIP at `wp-content/uploads/accuverify/`, syncs the badge JS to `js/badge/v1.2.3/`.
- **Manual fix:** `PluginUpdateEndpoint::CURRENT_VERSION` was at `1.2.1` (drifted from prior plugin v1.2.2). Release script's find-replace `1.2.2 → 1.2.3` missed it. Bumped to `1.2.3` manually.
- **Customer plugins on WP** auto-discover the new version via `/wp-json/accumark/v1/plugin/info` (~12h cron cycle). Update notice appears in WP admin; one-click install pulls the new ZIP.

### 5. UI Polish

**Portal new-order wizard ([`/portal/new-order/`](https://accumarklabs.local/portal/new-order/)) Step 1:**

- "CHOOSE ANALYTICAL TEST" eyebrow enlarged 0.6875rem → 0.875rem, weight 600 → 700.
- Slow breathing/glow animation (text-shadow pulse, 2.6s ease-in-out infinite).
- Three downward triangle ticks (`::before` pseudo-elements on `.at-tab`, staggered 0.18s + 0.36s) bobbing above each test-type tab.
- All cues stop on first user click via `.user-touched` JS marker — `prefers-reduced-motion: reduce` honored.

**Checkout payment section** (covers both `/checkout/` block and `/checkout/order-pay/` classic):

- **Stripe Appearance API** wired via `wc_stripe_payment_element_options` + `wc_stripe_upe_params` filters in [`src/Front/Checkout.php`](\\wsl.localhost\docker-desktop-data\data\docker\volumes\DevKinsta\public\accumarklabs\wp-content\themes\wpstar\src\Front\Checkout.php). Themes inside Stripe iframes (card field, focus rings, error states, tabs) with brand tokens: `colorPrimary: #2abfc4`, Open Sans, 10px radius, branded focus ring `0 0 0 3px rgba(42,191,196,0.18)`.
- **New `css/checkout-block.css`** (~14 KB) — three parts:
  - **Part A:** WC Checkout Block markup (Gutenberg, used at `/checkout/`)
  - **Part B:** Classic markup (used at `/checkout/order-pay/`) — wraps payment block as a card, normalizes radio rows, soften test-mode notice, branded place-order button
  - **Part C:** Polish — outer `<li>` uses CSS Grid (`auto 1fr`) for deterministic radio | label alignment (fixed ACH gateway misalignment), custom radios via `appearance: none` (20px circle, teal border on hover, teal-filled inner dot when checked), custom checkboxes (teal fill + white check), saved-card list spacing
- **Payment box visual chrome reverted** — `.payment_box` had a styled bg/border that was hiding Stripe's "Connect bank account" trigger and breaking Financial Connections popup. Now grid-positioning only; Stripe owns the visuals inside.

---

## Existing docs (use these)

### Operational

- **`Accu-Mk1/docs/deploy/2026-05-bw-subsamples-release.md`** — **the master deploy guide.** 8 sections: pre-deploy SENAITE setup (analysis services + profiles + sample type, capture UIDs), pre-deploy WP setup (SKU `bac-water-panel` SQL), pre-deploy IS env vars, pre-deploy Mk1 prep, per-repo deploy sequence, post-deploy verification checklist, post-deploy lab tasks, rollback plan.

### Per-repo CHANGELOGs

- `accumarklabs/CHANGELOG.md` — `[2.23.1]` covers all theme changes (live preview, AccuShield rewrite, BW primary fix, digital COA parser, badge fixes, checkout polish, attention cues)
- `coabuilder/CHANGELOG.md` — `[2.14.0]` (BW addons page 2, addon_parsing module, sample_name fix) + `[2.13.1]` (matrix dispatch fix `339c287`)
- `integration-service/CHANGELOG.md` — `[0.34.0]` (BW pipeline, Phase C, sub-sample guards)
- `Accu-Mk1/CHANGELOG.md` — Sub-Samples + Bac Water Unreleased section
- `accumarklabs/wp-content/plugins/accuverify-woocommerce/readme.txt` — plugin changelog (Stable tag 1.2.3)

### Project planning

- `Accu-Mk1/.planning/ROADMAP.md` — milestone-level (v0.12 → v0.28 → v0.30). **Stale** — doesn't yet reflect sub-samples or BW.
- `Accu-Mk1/.planning/STATE.md` — current focus says v0.30.0 Multi-Instrument, last updated 2026-04-06. **Stale**.
- `Accu-Mk1/.planning/phases/24-…/` — sub-sample phase directory. **Empty (only `.gitkeep`)** — plan was never written.

### Memory (persists across sessions)

`C:\Users\forre\.claude\projects\c--Users-forre-…coabuilder\memory\`:

- `MEMORY.md` — index
- `project_concurrent_std_quantity.md` — concurrent standard injections for ratio quantity
- `senaite_keywords.md` — Analysis service keyword reference (BA underscores vs ENDO/STER dashes)
- `feedback_elementor_button_overrides.md` — Elementor button hijack defeat pattern
- `feedback_sample_name_autofill_policy.md` — sample-name autofill turns off on user keystroke
- **`project_published_coa_results_order_number.md`** *(new this session)* — IS pipeline gap: 217/217 rows have NULL order_number. Verify portal filter path before fixing.

---

## Local environment & access

**Docker containers (all currently running):**

```
accumark_postgres      — IS + Mk1 Postgres (DBs: accumark_integration, accumark_mk1)
devkinsta_db           — WP MariaDB (DB: accumarklabs, root password in env)
integration-service    — port 8000
coabuilder_service     — port 5000 (src/ NOT bind-mounted — rebuild on changes)
accu-mk1-backend       — Mk1 FastAPI
accu-mk1-frontend      — port 3101
senaite                — SENAITE LIMS
devkinsta_nginx        — accumarklabs.local
```

**DB access:**

```bash
# IS DB
MSYS_NO_PATHCONV=1 docker exec accumark_postgres psql -U postgres -d accumark_integration -c "..."
# Mk1 DB
MSYS_NO_PATHCONV=1 docker exec accumark_postgres psql -U postgres -d accumark_mk1 -c "..."
# WP MariaDB
MSYS_NO_PATHCONV=1 docker exec devkinsta_db mysql -u root -pnATwZadLfQeK5p2J accumarklabs -e "..."
```

**Test order with all the work in it:** **WP order #3229** — 3 samples (BPC-157 with newtest3 additional COA, BW-0006 with AccuShield bundle + test43 additional COA, BW-0007 BW-only). BW-0006 is the published sample (verification code `TEYQ-BM79` initial, `HNPU-FTMS` after sample_name regen). Use as your smoke-test reference.

---

## Deferred / future work

| Item | Status | Notes |
|---|---|---|
| Lab provides BA HplcMethod params (RT, wavelength, column, gradient, instruments) | Pending lab | Required before BA can be processed through Accu-Mk1's HPLC flow |
| BA calibration curve build (from standard prep run) | Pending lab | Practice A — static curves built once, used for all subsequent samples |
| BW analysis services assigned to a service group | TODO operational decision | None of `Benzyl_Alcohol_Assay`, `PH-DETERM`, `FILL-NET-CONTENT` are in any service group, so BW samples will appear ungrouped on Mk1's worksheet inbox. Decision: own group "Bac Water" or assign to "Core Panel"? |
| `Microbioligy` typo in `service_groups.id=2` | TODO 5-min data fix | `UPDATE service_groups SET name='Microbiology', updated_at=NOW() WHERE id=2;` |
| `published_coa_results.order_number` NULL on all 217 rows | Pre-existing gap | See memory `project_published_coa_results_order_number.md`. Verify which path WP client portal uses (this column or join through coa_generations) before fixing. |
| 6 stale draft generations on BW-0006 (gens 1–4) | Cosmetic | Each regen creates a new (primary, additional) pair; old pairs stay as `status='draft'`. Optional periodic prune of drafts older than N days. |
| Stale `.planning/ROADMAP.md` + `STATE.md` | Doc cleanup | Don't yet reflect sub-samples or BW. Update after release ships. |
| Empty Phase 24 planning dir | Doc cleanup | `Accu-Mk1/.planning/phases/24-…/` has only `.gitkeep`. Optional retroactive plan write-up. |
| `release.php` find/replace fragility | Tooling tweak | Script bumps `CURRENT_VERSION = '{old}'` → `'{new}'`, but old came from `accuverify.php` Version, while the constant lives in theme `PluginUpdateEndpoint.php` which can drift. Better: read old from the endpoint constant, not the plugin file. |

---

## How to commit + ship (suggested per-repo commit grouping)

**Order matters — coabuilder image rebuild is the only blocker if anyone tests publish before deploy.**

1. **accumarklabs (theme + plugin)** — split into:
   - Theme: `feat: BW order wizard + digital COA parser + checkout polish + badge fixes (v2.23.1)`
   - Plugin: `feat: AccuVerify plugin v1.2.3 + new badge v1.2.3 snapshot`
2. **integration-service** — `feat: BW pipeline + sub-sample publish guards (v0.34.0)`
3. **coabuilder** — split:
   - `fix: matrix dispatch keyed on matrix_type (v2.13.1, commit 339c287 already done)`
   - `feat: BW addons page 2 + shared addon_parsing module + sample_name override fix (v2.14.0)`
4. **Accu-Mk1** — `feat: Sub-Samples (Phase 24) + BW analyte support (v0.32.0)`

After commits, follow the **deploy guide** sequence verbatim. Don't skip the SENAITE/WP/IS env setup steps — production needs them before the code can do anything useful.

---

## Open questions / things to verify post-deploy

- [ ] Real-bank login through Stripe Financial Connections (test mode currently — confirm Financial Connections is ACTIVE in live Stripe Dashboard before first ACH order)
- [ ] Customer-side smoke test: place a BW order with ENDO+STER addons, receive in Mk1, generate COA, verify 2-page PDF, verify digital COA on AccuVerify page renders BA/pH/Fill + Biosafety, verify badge embed renders correctly across all sizes
- [ ] Customer plugin auto-update: a customer site running `accuverify-woocommerce` 1.2.1 or 1.2.2 should see the "Update available 1.2.3" banner within 12h of deploy
- [ ] Sub-sample publish guard verification: try publishing `BW-0006-S01` from each of the 4 layers (Mk1 UI, Mk1 backend direct, IS desktop direct, SENAITE custom button) — all should reject with the `SUB_SAMPLE_PUBLISH_BLOCKED_MSG`

---

## Quick reference

**ZeroSignal voice / Handler convention:** see `C:\Users\forre\.claude\CLAUDE.md` — terse, calm, technically precise; spine is allowed; verify-then-claim.

**Hooks gotcha:** the `PreToolUse:Edit` hook fires read-before-edit reminders even when files have been read. Edits succeed regardless. Don't be alarmed by the warnings.

**MSYS_NO_PATHCONV=1** — required prefix for `docker exec` commands containing `/app/...` paths via Git Bash; otherwise paths get mangled to `C:/Program Files/Git/app/...`.

**Coabuilder rebuild:** `docker compose up -d --build coabuilder` — `src/` is NOT bind-mounted, so source edits require image rebuild before they're live.
