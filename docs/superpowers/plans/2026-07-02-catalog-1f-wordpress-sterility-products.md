# Catalog 1F — Two Public Sterility WooCommerce Products (WordPress slice) Implementation Plan — STUB

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans when this stub is promoted to a full plan. **This is a STUB, not an executable plan.** It is the LEAST-urgent Catalog v1 phase and is **hard-blocked on Phase 1D** (per-product order flags in integration-service). Do not implement product wiring until 1D has defined the per-product signal contract and pricing (G4) is resolved. Steps that depend on 1D or on a gate are marked and described at *shape* depth only.

**Goal:** Ship the two customer-facing sterility products on the storefront — `sterility-pcr` ("Sterility Screening PCR") and `sterility-usp71` ("Sterility USP<71>") — so that a PCR-only, a USP71-only, or a both order each emits a **distinct per-product signal** that integration-service (1D) routes to native Accu-Mk1 sterility demand. **No shadow products** (spec locked decision #4): PCR is one product / one line item; the Fungi/Bacteria split stays purely internal.

**Architecture:** Additive changes to the `accumarklabs` WordPress theme (`wpstar`) plus a WP-side data change (two WooCommerce products + their `wc_test_services` registration). Three seams: (1) **Product definitions** — the two products, their slugs/titles/type, and the per-product key/meta each must carry. (2) **Product→order-signal mapping** — extend the wizard's current *binary* addon model (hardcoded `endotoxin | sterility` catch-all) so two distinct sterility products emit two distinct `services.*` flags in the WP→IS payload. (3) **Flow-through** — a PCR-only / USP71-only / both order reaches 1D's per-product demand with the correct signal. No SENAITE artifacts are created (spec decision #8, "Full B").

**Tech Stack:** WordPress / WooCommerce (PHP 8, `wpstar` theme), vanilla JS wizard (`sample-submission.js`), `wc_test_services` WP option registry. Deploy via the `accumark-deploy` skill (theme code) + a Handler-run WP-side op for product/option data (wp-cli or WC admin on Kinsta). No Accu-Mk1 backend changes here (those are 1C/1D). No coabuilder changes here (1E).

---

## ⚠️ SUPERSESSION NOTICE (read before touching anything)

This plan **supersedes** the parked spec `accumark-stack/docs/superpowers/specs/2026-05-07-pcr-fungi-bacteria-split.md`. The parked spec is the reference for **product/pricing bookkeeping only** — its *design* is stale on the points that matter here:

| Parked spec (STALE) | This plan (AUTHORITATIVE, per catalog spec) |
|---|---|
| **5** WC products: Plate + PCR + USP71 + 2 shadow children (`pcr-fungi`, `pcr-bacteria`) | **2** public products only: `sterility-pcr`, `sterility-usp71`. **Zero shadow products** (decision #4). |
| "Sterility Plate" as a third product | **Dropped.** No Plate product. |
| New ASs created **in SENAITE**; `ADDON_KEYWORDS` edits in `guards.py` | **SENAITE-free (Full B).** No SENAITE ASs, no `guards.py` edit. Sterility reaches the COA natively via Accu-Mk1 (1E). |
| PCR splits into two customer-visible sub-lines via shadow products | PCR is **one line item**; Fungi/Bacteria split is internal only (two analyses, one vial). |

A reader who only skims the parked spec must not implement the 5-product / shadow / SENAITE design. **When those conflict, this plan wins.**

---

## Global Constraints

- **Additive only; this is a production/external change → Handler-gated.** Publishing storefront products and changing prices is customer-facing production behavior (coherence note "Non-negotiables"). Product publish is a **Handler-gated checkpoint**, never an autonomous step. Build in draft/staging first.
- **Hard dependency on 1D (per-product order flags).** 1F cannot ship until integration-service accepts and routes **per-product** sterility signals. Today IS reads a single `services.sterility_pcr` (`integration-service/.../order_validator.py:148`, per catalog spec §166). 1F emits the signals; **1D defines the exact key strings and back-compat.** See "Dependency gate".
- **No shadow products** (spec decision #4). PCR = one product, one line item, one `services.*` flag. Do not create `pcr-fungi` / `pcr-bacteria` WC products.
- **New single-product orders demand 1 vial** (PCR-only → 1, USP71-only → 1, both → 2). This is NEW behavior arriving with 1D + 1F and is **explicitly outside the demand-parity set** (coherence note §20-24; spec §247). The client-side wizard vial estimate is **display-only** — authoritative demand is Mk1/1D.
- **JWT_SECRET unchanged.** The WP→IS order webhook uses HMAC (`X-Accumark-Signature`), not JWT; the JWT path (COA verify) is untouched. Keep JWT parity across IS + coabuilder + WP regardless.
- **Two surfaces, deployed separately** (see "Deployment note"): theme **code** ships via `accumark-deploy` (deploy.py is theme-only); the WooCommerce **product/option data** is a WP-side op the Handler runs on Kinsta. Never DevKinsta "Push to Production" with DB sync (destroys live orders — CLAUDE.md non-negotiable).
- **ISO 17025 alignment:** the product catalog and its `wc_test_services` registration are the customer-facing definition of what is ordered (7.4.2 identification/traceability); the USP<71> preliminary→amend COA flow (spec #8 / gate G2) is owned by 1E, not here.

---

## Dependency gate (HARD ORDERING — do not start until satisfied)

**1F is blocked on 1D.** The WP products are only useful once integration-service understands per-product sterility signals. Concretely, before 1F execution begins:

- [ ] **1D has landed** the per-product order-model change in integration-service (replaces the single `sterility_pcr: bool` with per-product flags — e.g. `sterility_pcr` + `sterility_usp71` — or an addons list, with back-compat for in-flight `sterility_pcr=True`). Catalog spec §166, §255.
- [ ] **1D has published the exact per-product key strings** that appear in the WP→IS payload `services` dict. 1F's product→signal mapping (Task 2) MUST emit *those* strings verbatim. Until 1D fixes them, treat the strings as `<1D:PCR_KEY>` / `<1D:USP71_KEY>` placeholders.
- [ ] **1C tenant is seeded** (done — the `Sterility PCR` group + native `STER-USP71` service exist in the Accu-Mk1 catalog) so 1D's native routing has real targets.

If any box is unchecked, **stop** — 1F wiring against an undefined IS contract will silently mis-route (wrong/absent vials on real orders). This gate is the whole reason 1F is sequenced last.

---

## The current WP→IS seam (what 1F must extend) — verified findings

The mapping a new product must plug into, traced in the live theme:

1. **Registry — `wc_test_services` WP option.** An array of `{name, price, tooltip, type: 'primary'|'addon'|'addon-coming-soon', product_id, coming_soon_label}`. Localized into the wizard as `wcSampleForm.testServices` (`src/Front/MyAccount/Sample_Submission.php:214,443`). *(The `test_service_type` taxonomy migration in `docs/TestServicesMigrationPlan.md` is **Proposed**, not live — the live registry is still the option. 1F targets the live option.)*
2. **Addon model is a hardcoded BINARY with a "sterility" catch-all.** The wizard recognizes exactly two addon slots: `endotoxin` and `sterility`. Everything that isn't endotoxin falls into `sterility` via `addonKey = svc.name.toLowerCase().includes('endotoxin') ? 'endotoxin' : 'sterility'` (`js/sample-submission.js:452-454,537,2298,2364,2449,2674`). The Step-1 cards are two hardcoded `data-addon="endotoxin"` / `data-addon="sterility"` blocks (`templates/portal-submit-sample.php:366,388`), and addon name/price are resolved by `stripos(name,'endotoxin')` / `stripos(name,'sterility')` (`portal-submit-sample.php:41-46`, defaults "Sterility (PCR)" / $180 at `:63-64`). **This binary is the core thing 1F must break** — two distinct sterility products cannot both live in one `sterility` slot.
3. **Payload service key is NAME-derived.** Per selected service the wizard stores `sample.data.services[key] = bool` where `key = svc.name.toLowerCase().replace(/\s+/g,'')` (`sample-submission.js:394,401,1197,2673`). So a product named "Sterility (PCR)" yields key `sterility(pcr)`.
4. **Line items.** `Cart_Order.php` / `Sample_Submission.php` build a `service_product_map` keyed by `strtolower(str_replace([' ','-','_','&','(',')'],'',name))` → `product_id`+`type` (`Sample_Submission.php:757-774`) and create one addon line item per selected service; the base item is the HPLC ghost product.
5. **Payload to IS.** `IntegrationService::build_order_payload()` → `build_services_with_variance()` sends the per-sample boolval'd `services` dict to `POST /v1/webhook/order-submitted`, HMAC-signed (`src/Integration/IntegrationService.php:285-309,411-426,232`).
6. **IS consumes** `services.sterility_pcr` today (`order_validator.py:148`). 1D generalizes this to per-product.

**The load-bearing mismatch:** name-derivation (`sterility(pcr)`) does **not** produce IS's canonical `services.sterility_pcr`. So 1F must ensure each product emits a *distinct, canonical* per-product key that equals 1D's contract string — via an explicit key/meta on the service registration (shape in Task 2), **not** by hoping a stripped product name matches. The exact strings are owned by 1D.

---

## Tasks (STUB depth)

### Task 1: Define the two WooCommerce products + settle the existing-product disposition

**Shape, not code — needs G4 (pricing) and a Handler decision on disposition before it is executable.**

Two public products, `type='addon'` in `wc_test_services`:

| Slug | Title | Type | Internal composition | Native Mk1 target (1C-seeded) | Price |
|---|---|---|---|---|---|
| `sterility-pcr` | **Sterility Screening PCR** | `addon` | One line item; internally Fungi + Bacteria qPCR (two analyses, **one vial**). No shadow children. | `Sterility PCR` group (`PCR-FUNGI` + `PCR-BACTERIA`) | ⛔ G4 |
| `sterility-usp71` | **Sterility USP\<71\>** | `addon` | Single compendial test, one vial; ~14-day SLA (Mk1-side). | native `STER-USP71` service | ⛔ G4 |

- [ ] **⛔ DISPOSITION DECISION (Handler) — resolve before writing any product op.** A live sterility addon **already exists** (`portal-submit-sample.php:63` defaults to "Sterility (PCR)" / $180; TestServicesMigrationPlan Phase 2 lists "Rapid Sterility Screening (PCR)"). 1F is therefore **not greenfield**. Decide, explicitly:
  - **`sterility-pcr` = the existing product, retitled** to "Sterility Screening PCR" — **reuse the existing `product_id`** so in-flight/historical orders and their line-item references stay intact (the migration doc's "keep product_id references intact" risk). Preferred default.
  - **vs. create-new + retire-old** — only if accounting needs a clean SKU break; requires a plan for open orders referencing the old product.
  - `sterility-usp71` is **genuinely net-new** either way.
  This decision changes the shape of the op (update vs create) and must be recorded before Task 1 runs.
- [ ] Each product carries the per-product signal key/meta from Task 2 (so the wizard and IS agree on a canonical key, not a stripped name).
- [ ] `⛔ HANDLER/ACCOUNTING GATE G4 — pricing.` Scaffold both products with a **placeholder price** (e.g. draft, $0 or a clearly-marked TBD) so wiring/UAT can proceed. **Real prices for both products are a lab/accounting decision (spec #7 / coherence G4), not an engineering blocker — but they are a hard gate before publish.** Do not publish either product at a placeholder price.

### Task 2: Map each product → a distinct per-product order signal (WP→IS contract)

**Shape, not code — the exact key strings are owned by 1D (Dependency gate). Describe the mechanism; fill strings when 1D lands.**

The two products must each emit a **distinct, canonical** flag in the WP→IS payload `services` dict that 1D routes:

- `sterility-pcr` selected → `services.<1D:PCR_KEY> = true` (expected `sterility_pcr`, preserving back-compat with today's flag).
- `sterility-usp71` selected → `services.<1D:USP71_KEY> = true` (expected `sterility_usp71`).
- Both selected → both flags true → 1D sums to 2-vial demand; each alone → 1-vial (new behavior, outside parity set).

- [ ] Attach an **explicit canonical service key** to each product's `wc_test_services` entry (e.g. a `mk1_key` / `service_key` field), rather than relying on the name-strip. This closes the mismatch documented above and is the durable fix — the wizard and payload builder read the explicit key. (Precedent: the variance path already carries explicit `mk1Key` values, e.g. `hplcpurity_identity`, `sample-submission.js:3311.`)
- [ ] Confirm `IntegrationService::build_services_with_variance()` passes the per-product keys through unchanged (it boolval's the `services` map and preserves keys — `IntegrationService.php:285-309`; no per-key allow-list to update, but re-verify no filter drops unknown keys).
- [ ] **Test shape:** given a synthetic order with each product combination, assert the built payload `services` dict contains exactly the expected 1D key(s). Concrete assertions wait on 1D's fixed strings.

### Task 3: Break the binary-addon model — wire PCR-only / USP71-only / both through the wizard

**Shape, not code — this is the real theme-side refactor of 1F. Depends on Task 2's keys.**

The wizard's `endotoxin | sterility` binary (see seam finding #2) must become an **enumerated, N-addon** model so two distinct sterility products render and toggle independently and carry distinct keys end-to-end.

- [ ] **`templates/portal-submit-sample.php`** — replace the two hardcoded `data-addon` cards + the `stripos(name,'sterility')` single-slot resolver (`:41-46,63-64,366,388`) with a loop over `type='addon'` services keyed by their explicit service key, so both sterility products get their own card, name, and price.
- [ ] **`js/sample-submission.js`** — replace every `addonKey = ...includes('endotoxin') ? 'endotoxin' : 'sterility'` branch and the `globalAddons = {endotoxin, sterility}` shape (`:99-102,452-454,537,2298,2364,2449,2653,2674`) with per-service-key handling. Each addon toggles its own `services[key]` + `prices[key]`. The AccuShield "select all addons" bundle (`:336-339`) must select both sterility products (or per the bundle's product-id list — verify against the `AccuShield Panel` coupon).
- [ ] **Client-side vial estimate (display-only).** `computeSampleVials` + `vialRules` currently hardcode `sterility: 2` (`sample-submission.js:156,165`). Update the estimate to reflect **per-product 1 vial** (PCR 1, USP71 1, both 2). This is a UX estimate only — authoritative demand is Mk1/1D; do not treat this as the demand source.
- [ ] **Flow-through test (manual/UAT on staging):** place a PCR-only order, a USP71-only order, and a both order; confirm (a) distinct line items, (b) correct `services.*` keys in the IS payload, (c) 1D derives 1 / 1 / 2 vials respectively. Automated coverage lands with 1D's fixed keys.

### Task 4: Publish gate

- [ ] `⛔ HANDLER GATE — product publish.` Publishing the two products (draft → publish) is a **production/external change**. Gate on: (a) **G4 real prices set** on both products; (b) **1D deployed** to prod IS (Dependency gate) so live orders route; (c) 1E native COA source proven for sterility (a USP71 order that can't render on a COA is a customer-facing gap — coordinate with 1E's seam-cut, coherence note THE SEAM-CUT ORDER); (d) staging UAT of all three order flows passed; (e) explicit Handler sign-off in the deploy window. **Draft/staging first; never publish autonomously.**

---

## Deployment note (two surfaces — do not conflate)

WP changes for 1F split across two deploy surfaces; the `accumark-deploy` skill owns ordering + JWT rules:

- **Theme CODE** (Tasks 2/3 — `portal-submit-sample.php`, `sample-submission.js`, and any `IntegrationService`/`Sample_Submission` wiring): shipped via `accumark-deploy` (deploy.py is **theme-only** — it does not touch plugins/mu-plugins or the DB). Deploy theme edits to BOTH dev surfaces during build (accumarklabs.local DevKinsta + the subvial stack) per the WP-dev-env note.
- **Product / option DATA** (Task 1 — the two products + their `wc_test_services` registration + prices + publish status): this is **WordPress DB/option data**, created/updated by a **Handler-run WP-side op** (wp-cli or WooCommerce admin on Kinsta), NOT by deploy.py. This is adjacent to the "never DevKinsta Push-to-Production with DB sync" landmine — treat product creation as a deliberate, Handler-gated prod-data op, separate from the code deploy.

Order: land theme code (dead until products exist) → Handler creates products in draft with placeholder prices → UAT on staging → G4 prices + publish gate → publish.

---

## Self-Review (against the coherence note + spec)

**Spec coverage (the WordPress slice of Catalog v1):**
- Two public sterility products, no shadow products (spec "Sterility as first tenant" WP-products row; decisions #2/#4) → Task 1 + Global Constraints. Supersession of the 5-product parked design stated up front.
- Product→per-product order signal, SENAITE-free (decisions #8/#9; spec §166,§255) → Task 2 (distinct canonical keys) + Task 3 (flow-through). No SENAITE artifacts, no `guards.py` edit.
- Per-product additive demand (PCR 1 / USP71 1 / both 2), outside the parity set (coherence §20-24; spec §247) → Task 3 vial-estimate + Task 2 both-flags. Client estimate flagged display-only; authoritative demand is Mk1/1D.
- Pricing = lab/accounting, not an eng blocker, but a publish gate (spec #7 / G4) → Task 1 placeholder + Task 4 gate.

**Hard 1D dependency (the reason 1F is last):** the whole slice is gated on 1D defining and deploying per-product IS flags. Every product→signal string is a `<1D:...>` placeholder until then; the Dependency gate blocks execution. Wiring against an undefined contract would silently mis-route real orders.

**Existing-product disposition (advisor point 1 — the biggest non-greenfield risk):** a live "Sterility (PCR)" addon already exists. Task 1 forces an explicit reuse-and-rename (keep `product_id`) vs create-new decision before any product op — not assumed greenfield.

**What is stubbed pending gates (deliberately NOT full TDD):**
- Concrete `services.*` key strings, payload assertions, and automated flow-through tests — **pending 1D** (Dependency gate). Shapes given.
- Real prices + publish — **pending G4 (Handler/accounting)** and the Task 4 publish gate.
- USP<71> preliminary→amend COA rendering and the sterility native-COA source — owned by **1E** (coherence G2/G3, seam-cut order); 1F only ensures the order signal exists so 1E has something to render.

**Placeholder scan:** intentional placeholders are all gate-marked (`⛔ G4` prices; `<1D:...>` keys; disposition decision). No un-marked stubs. This is a STUB plan by design — promote to full TDD once 1D lands and G4 resolves.
