# Deployment Guide — 2026-05 Release

**Release content:**
1. Bacteriostatic Water (BW) order pipeline
2. Sub-Samples (Phase 24)
3. Benzyl Alcohol as a non-peptide analyte
4. COA addon page-2 routing
5. Sub-sample publish guards
6. **Vial Assignment Step** — new third phase in the receive wizard (HPLC / Microbiology(Endo+Sterility) / Xtra buckets, drag-and-drop, role short-name printed on labels)
7. **Phase 2 Highlight** — primary analysis emphasis on the sample detail page based on the vial's `assignment_role` (no filtering — vials can move between departments)
8. **Wizard UX iterations** — header showing expected vs received vial counts, vials list moved to right column, untruncated profiles, vial photo thumbnails, "Add Sub-Sample" promoted to detail-page header bar, footer cleanup

**Affected repos & target versions**

| Repo | Branch | Last release | Target |
|---|---|---|---|
| `accumarklabs` (WP theme) | `feat/bac-water-order-wizard` | 2.23.0 | **2.23.1** |
| `accumarklabs` (AccuVerify plugin) | `feat/bac-water-order-wizard` | 1.2.2 | **1.2.3** |
| `integration-service` | `feat/vial-assignment-step` (off `feat/bac-water-integration`) | 0.33.0 | **0.35.0** |
| `coabuilder` | `fix/is-generic-profile-bw` | 2.13.0 | **2.14.0** |
| `Accu-Mk1` | `feat/vial-assignment-step` (off `feat/sub-samples`) | 0.31.0 | **0.33.0** |

**Branch lineage notes (ahead of the original deploy plan):**

- Accu-Mk1's `feat/sub-samples` branch was committed (`938c034`) and a new branch `feat/vial-assignment-step` was created on top to land the wizard work + Phase 2 highlight (12 additional commits).
- IS's `feat/bac-water-integration` was committed (`15c03f6`) and a new branch `feat/vial-assignment-step` was created on top for the new `/explorer/orders/sample-services` endpoint.
- Theme (`bf4e16d`) and plugin (`aa320df`) shipped as documented; these don't change for the vial-assignment work.
- coabuilder shipped as `6d15a8a` and is unchanged by the vial-assignment work — it's a Mk1+IS-only feature.

---

## 1. Pre-deploy: Production SENAITE setup

**Required SENAITE Analysis Services** (Setup → Analysis Services). All five must exist with these exact keywords:

| Keyword | Title (suggested) | Used by |
|---|---|---|
| `Benzyl_Alcohol_Assay` | Benzyl Alcohol Assay (HPLC) | BW core panel |
| `PH-DETERM` | pH Determination | BW core panel |
| `FILL-NET-CONTENT` | Fill / Net Content | BW core panel |
| `ENDO-LAL` | Endotoxin (LAL) | BW + peptide add-on |
| `STER-PCR` | Rapid Sterility Screening (PCR) | BW + peptide add-on |

> **Naming convention reminder:** `Benzyl_Alcohol_Assay` uses **underscores**; the others use **dashes**. Don't mix them — coabuilder's keyword lookup is exact-match.

**Required SENAITE Analysis Profiles** (Setup → Analysis Profiles):

| Profile | Contains | Used by |
|---|---|---|
| `bac_water` | `Benzyl_Alcohol_Assay`, `PH-DETERM`, `FILL-NET-CONTENT` | BW orders (primary) |
| `endotoxin` | `ENDO-LAL` | BW + peptide add-on |
| `sterility_pcr` | `STER-PCR` | BW + peptide add-on |

**Required SENAITE Sample Type:** `Bacteriostatic Water` (Setup → Sample Types). Title must match exactly — coabuilder's `senaite_client.py` matrix dispatch is title-keyed.

### 1.b — Mk1 service-group membership (Phase 2 highlight prerequisite)

Phase 2 highlights "primary" analyses on the sample detail page based on each analysis's `service_group_id`. The local `analysis_services` ↔ `service_groups` mapping is what powers it. **Production must mirror dev's curated state** or no rows will light up as Primary.

Required state (`service_groups` + `service_group_members` in `accumark_mk1` DB):

| Service group | Required members |
|---|---|
| **Analytics** (id=1, `is_default=true`) | All HPLC services + BW analyses: `HPLC-PUR`, `HPLC-ID`, `PEPT-Total`, `Benzyl_Alcohol_Assay`, `PH-DETERM`, `FILL-NET-CONTENT`, all `ID_*` peptide identities, all `ANALYTE-*-IDENT/PUR/QTY`, both `BLEND-*`. |
| **Microbiology** (id=2) | `ENDO-LAL`, `STER-PCR`, `KF` (Moisture Content) |

**Bulk-assign SQL** for production (idempotent — joins to skip already-assigned services):

```sql
-- Put every ungrouped analysis service into Analytics, EXCEPT the three Microbiology ones.
INSERT INTO service_group_members (service_group_id, analysis_service_id)
SELECT 1, a.id
FROM analysis_services a
LEFT JOIN service_group_members m ON m.analysis_service_id = a.id
WHERE m.analysis_service_id IS NULL
  AND a.keyword NOT IN ('ENDO-LAL', 'STER-PCR', 'KF');

-- Make sure the three Microbiology services are in Microbiology (id=2).
INSERT INTO service_group_members (service_group_id, analysis_service_id)
SELECT 2, a.id
FROM analysis_services a
LEFT JOIN service_group_members m
  ON m.analysis_service_id = a.id AND m.service_group_id = 2
WHERE m.analysis_service_id IS NULL
  AND a.keyword IN ('ENDO-LAL', 'STER-PCR', 'KF');
```

**Verification SQL:**

```sql
-- Should show ~80 in Analytics, 3 in Microbiology, 0 ungrouped.
SELECT sg.name, COUNT(*) AS members
FROM service_groups sg
JOIN service_group_members m ON m.service_group_id = sg.id
JOIN analysis_services a ON a.id = m.analysis_service_id
GROUP BY sg.name;

SELECT COUNT(*) AS ungrouped
FROM analysis_services a
LEFT JOIN service_group_members m ON m.analysis_service_id = a.id
WHERE m.analysis_service_id IS NULL;
```

**Future note:** the create-AnalysisService endpoint does NOT auto-assign new services to the `is_default` group. Until that hook is wired, lab admins must manually add new services to Analytics (or whichever group fits) via the `/lims/service-groups` admin page. Watch for this when adding new instrument methods or new peptides post-deploy.

**After creating each in SENAITE, capture the UID** for the `.env.prod` step below:

```bash
# Inside the senaite container, on prod:
docker exec senaite_prod sh -c '
  curl -s -u admin:PROD_PASS \
    "http://localhost:8080/senaite/@@API/senaite/v1/SampleType?title=Bacteriostatic%20Water&complete=1" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)[\"items\"][0][\"uid\"])"
'
# Repeat for each AnalysisProfile (?title=...) — capture bac_water, endotoxin, sterility_pcr UIDs.
```

---

## 2. Pre-deploy: Production WordPress setup

**Product SKU verification** (WooCommerce → Products):

| Product | Required SKU |
|---|---|
| HPLC Identity, Purity & Quantity | `hplc-ipq` |
| Bac Water Panel | **`bac-water-panel`** (must be set; missing SKU silently disables AccuShield bundle for BW) |
| Endotoxin (LAL) | `endotoxin-lal` |
| Rapid Sterility Screening (PCR) | `sterility-pcr` |

**SQL to verify and set** (run via WP-CLI or DB admin):

```sql
-- Verify current SKUs
SELECT p.ID, p.post_title, pm.meta_value AS sku
FROM wp_posts p
LEFT JOIN wp_postmeta pm ON pm.post_id = p.ID AND pm.meta_key = '_sku'
WHERE p.post_status = 'publish'
  AND p.post_type IN ('product', 'product_variation')
  AND p.post_title IN (
    'HPLC Identity, Purity & Quantity',
    'Bac Water Panel',
    'Endotoxin (LAL)',
    'Rapid Sterility Screening (PCR)'
  );

-- If Bac Water Panel SKU is NULL on prod (it was on dev), set it:
INSERT INTO wp_postmeta (post_id, meta_key, meta_value)
VALUES ((SELECT ID FROM wp_posts WHERE post_title='Bac Water Panel' AND post_status='publish' LIMIT 1),
        '_sku', 'bac-water-panel')
ON DUPLICATE KEY UPDATE meta_value = 'bac-water-panel';
```

> Prefer WP-CLI: `wp post meta update <ID> _sku bac-water-panel`

**Coupon `AccuShield Panel` allow-list** (WC → Coupons):
- Discount: 15% percent
- Allowed products: must include the prod IDs of HPLC IPQ, Endotoxin LAL, Sterility PCR, **and Bac Water Panel**. Dev IDs are 2919, 2920, 2921, 3222 — verify prod numbering and edit if different.

**`wp_options.wc_test_services` content** (Settings page or via SQL):
- Must include a primary entry whose `name` begins with `HPLC Purity` (peptide path)
- Must include a primary entry for **Bac Water Panel** (`type: primary`)
- Endotoxin and Sterility entries must be present as `type: addon`

---

## 3. Pre-deploy: Production env vars (integration-service)

Add to `/root/integration-service/.env`:

```env
# Bacteriostatic Water profile/type UIDs (capture from production SENAITE — section 1)
SENAITE_BAC_WATER_TYPE_UID=<prod uid for Bacteriostatic Water sample type>
SENAITE_BAC_WATER_PROFILE_UID=<prod uid for bac_water profile>

# Verify these are correct for prod (defaults exist in app/core/config.py but should be set explicitly)
SENAITE_ENDOTOXIN_PROFILE_UID=<prod uid>
SENAITE_STERILITY_PROFILE_UID=<prod uid>
SENAITE_SINGLE_PROFILE_UID=<prod uid>
SENAITE_BLEND_PROFILE_UID=<prod uid>
```

> The dev `.env` value of `SENAITE_BAC_WATER_TYPE_UID` is `8b64a586...839c` and `SENAITE_BAC_WATER_PROFILE_UID` is `9fda4abd...939d`. **Production UIDs will be different.** Get them from production SENAITE (section 1).

**Sanity check:** integration-service raises a clear error at order-creation time if these are missing for a BW order — the BW path in `app/adapters/senaite.py` checks `config.bac_water_type_uid` and `config.bac_water_profile_uid` and refuses to proceed.

---

## 4. Pre-deploy: Production Accu-Mk1 prep

### Database migrations (auto-run on backend startup)

`backend/database.py::_run_migrations()` runs idempotent ALTER/INSERT statements on every startup. The new entries this release adds are:

```sql
-- 24, 25 (sub-samples Phase 24)
CREATE TABLE IF NOT EXISTS lims_samples (...);
CREATE INDEX IF NOT EXISTS ix_lims_samples_external_lims_uid ON lims_samples (external_lims_uid);
CREATE TABLE IF NOT EXISTS lims_sub_samples (...);
CREATE INDEX IF NOT EXISTS ix_lims_sub_samples_parent_pk ON lims_sub_samples (parent_sample_pk);

-- 26, 27, 28 (Phase A — Benzyl Alcohol as analyte)
ALTER TABLE peptides ADD COLUMN IF NOT EXISTS analyte_class VARCHAR(20) NOT NULL DEFAULT 'peptide';
UPDATE peptides SET abbreviation='Benzyl Alcohol' WHERE abbreviation='BA' AND name='Benzyl Alcohol';  -- one-off rename, no-op on fresh installs
INSERT INTO peptides (name, abbreviation, is_blend, analyte_class, active, created_at, updated_at)
VALUES ('Benzyl Alcohol', 'Benzyl Alcohol', FALSE, 'additive', TRUE, NOW(), NOW())
ON CONFLICT (abbreviation) DO NOTHING;

-- Phase 25 (Vial Assignment Step) — assignment_role columns on parent + sub-sample tables
-- Parent's role is pinned to 'hplc' by default + backfilled (preserves "primary always HPLC for now" rule).
-- Sub-sample's role is nullable; NULL = auto-assign hasn't run yet.
ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS assignment_role VARCHAR(8) DEFAULT 'hplc';
UPDATE lims_samples SET assignment_role = 'hplc' WHERE assignment_role IS NULL;
ALTER TABLE lims_sub_samples ADD COLUMN IF NOT EXISTS assignment_role VARCHAR(8);
```

> **Latent infrastructure bug to watch for:** `_run_migrations()` wraps the entire migration list in a single transaction with a broad `try/except Exception: pass`. If any single statement fails, the **whole transaction silently rolls back** without logging. After deploy, verify schema landed:
>
> ```sql
> -- Should show analyte_class column with NOT NULL + default 'peptide'
> \d peptides
>
> -- Should show 1 'additive' row (Benzyl Alcohol) and the rest 'peptide'
> SELECT analyte_class, COUNT(*) FROM peptides GROUP BY analyte_class;
>
> -- Should show: id, 'Benzyl Alcohol', 'Benzyl Alcohol', 'additive', t
> SELECT id, name, abbreviation, analyte_class, active FROM peptides WHERE name='Benzyl Alcohol';
>
> -- Sub-samples tables
> \d lims_samples
> \d lims_sub_samples
>
> -- Phase 25 (vial assignment) — assignment_role columns
> -- lims_samples should show: character varying(8), default 'hplc'::character varying
> -- lims_sub_samples should show: character varying(8), nullable, no default
> SELECT column_name, data_type, character_maximum_length, column_default, is_nullable
> FROM information_schema.columns
> WHERE table_name IN ('lims_samples', 'lims_sub_samples') AND column_name = 'assignment_role';
>
> -- Every existing parent should be backfilled to 'hplc'
> SELECT assignment_role, COUNT(*) FROM lims_samples GROUP BY assignment_role;
> ```

### Backfills

**No data backfill required for this release.**

The `analyte_class` column adds with `DEFAULT 'peptide' NOT NULL` so all existing peptide rows are auto-backfilled. Benzyl Alcohol seed is idempotent via `ON CONFLICT (abbreviation)`.

### Production-only settings

Confirm production `.env` for the backend:
- `JWT_SECRET` — strong random, must match between Accu-Mk1 backend and integration-service
- `MK1_DB_*`, `INTEGRATION_DB_PROD_*`
- `SENAITE_URL`, `SENAITE_USER`, `SENAITE_PASSWORD` — required for sub-samples adapter; no fallback
- `INTEGRATION_SERVICE_URL`
- **`ACCU_MK1_API_KEY`** — must match a value in IS's `DESKTOP_API_KEYS` allowlist. The receive-wizard's vial-plan path (`fetch_sample_services`) reads this env var **with fallback to `INTEGRATION_SERVICE_API_KEY`** for compatibility with older configs. main.py also rebinds the value to a Python constant named `INTEGRATION_SERVICE_API_KEY`, which is a confusing legacy. **In production, set `ACCU_MK1_API_KEY` as the canonical name.**

**Cross-service auth chain for the new vial-plan path:**

```
Mk1 frontend (JWT) → Mk1 backend (verify JWT)
                   ↓
Mk1 backend (X-API-Key: ACCU_MK1_API_KEY) → IS (verify_desktop_api_key from DESKTOP_API_KEYS allowlist)
                                          ↓
                                          IS reads order_submissions, returns services dict
```

If the receive wizard hangs on "Loading…" with no error, check:
1. `ACCU_MK1_API_KEY` is set on Mk1 backend
2. The same value (or a value from a comma-separated list) is in IS's `DESKTOP_API_KEYS`
3. `INTEGRATION_SERVICE_URL` resolves from inside the Mk1 backend container (e.g. `http://host.docker.internal:8000` for compose, or the prod IS URL)

---

## 5. Deploy sequence

**Run in this order.** Each step is independent but the order minimizes the window of inconsistency.

### 5.1 SENAITE setup (manual, one-time)

Complete section 1 above. Capture all UIDs.

### 5.2 WordPress (theme + product SKU)

```bash
# 1. SSH to prod WP
# 2. Set the SKU + verify coupon
wp post meta update <BW_PANEL_PRODUCT_ID> _sku bac-water-panel

# 3. Deploy theme 2.23.1
cd /path/to/accumarklabs/wp-content/themes/wpstar
git fetch origin
git checkout feat/bac-water-order-wizard  # or whatever branch carries 2.23.1
# Theme is file-based — no DB writes on activate. WP picks up changes automatically.
```

**Smoke test:** open the order wizard, switch to "Bacteriostatic Water" tab, place a test order with BW + Endotoxin + Sterility add-ons, verify cart total includes AccuShield 15% bundle discount.

### 5.3 Integration-service deploy → 0.34.0

```bash
# 1. Build & push image (or use CI)
cd integration-service
docker build -t ghcr.io/zstar0/integration-service:0.34.0 .
docker push ghcr.io/zstar0/integration-service:0.34.0

# 2. On prod droplet:
scp .env.prod root@prod:/root/integration-service/.env
ssh root@prod
cd /root/integration-service
VERSION=0.34.0 docker compose -f docker-compose.prod.yml up -d
docker logs -f integration-service  # watch for "Application startup complete"
```

**Smoke test:** `docker logs integration-service | grep -i bac_water` should show config loaded; submit a test BW WP order and verify SENAITE AR creation.

### 5.4 Coabuilder deploy → 2.14.0

```bash
# 1. Build & push image (src is baked, NOT bind-mounted in prod)
cd coabuilder
docker build -t ghcr.io/zstar0/coabuilder:2.14.0 .
docker push ghcr.io/zstar0/coabuilder:2.14.0

# 2. On prod droplet:
scp .env.prod root@prod:/root/coabuilder/.env
ssh root@prod
cd /root/coabuilder
VERSION=2.14.0 docker compose -f docker-compose.prod.yml up -d
```

**Smoke test:** Generate a COA for a BW sample with Endotoxin and Sterility add-ons. Verify 2-page output (page 1 = BA + pH + Fill, page 2 = Endo + Sterility).

### 5.5 Accu-Mk1 backend → 0.32.0

```bash
# 1. Build & push image (bind mount in prod is .env only, NOT src)
cd Accu-Mk1
docker build -t ghcr.io/zstar0/accu-mk1-backend:0.32.0 ./backend
docker push ghcr.io/zstar0/accu-mk1-backend:0.32.0

# 2. On prod droplet:
ssh root@prod
cd /root/accu-mk1
VERSION=0.32.0 docker compose -f docker-compose.prod.yml up -d backend
docker logs -f accu-mk1-backend  # confirm migrations ran
```

**Verify migrations landed** (run the SQL from section 4).

### 5.6 Accu-Mk1 frontend → 0.32.0

```bash
# 1. Build (Vite production bundle)
cd Accu-Mk1
npm run build  # or whatever the prod build target is

# 2. Deploy to nginx / Tauri release pipeline
```

**Smoke test:** open a BW sample's detail page in the desktop app — verify "Benzyl Alcohol" shows in the Analytes panel after a fresh BW order is received.

---

## 6. Post-deploy verification checklist

### BW end-to-end smoke test

- [ ] Submit a BW WP order (Bac Water Panel + Endotoxin + Sterility), verify AccuShield 15% applied
- [ ] Confirm `wc-order-submitted` status in WC
- [ ] Confirm integration-service `order_submissions` row with `status=accepted`
- [ ] Confirm SENAITE AR created (e.g. `BW-XXXX`) with:
  - `ClientOrderNumber = WP-<order_id>`
  - `SampleTypeTitle = Bacteriostatic Water`
  - `Analyte1Peptide = "Benzyl Alcohol"` (Phase C)
  - 3 analyses + 2 add-ons attached
- [ ] Receive the BW sample in Accu-Mk1 → confirm row in `lims_samples`, `Benzyl Alcohol` shows in Analytes panel
- [ ] Generate COA → confirm 2 pages (core + add-ons)

### Sub-samples

- [ ] Receive a fresh sample with 1 vial → confirm only parent row created (NO `-S01` row)
- [ ] Receive a fresh sample with 3 vials → confirm parent + 2 `-SNN` rows; vial 1 = parent, vials 2-3 = sub-samples
- [ ] Open a sub-sample detail page → confirm "Publish Accumark COA" menu item is **hidden**
- [ ] Attempt direct API call to `POST /wizard/senaite/samples/<parent>-S01/publish-coa` → **403 with sub-sample message**
- [ ] Attempt SENAITE button publish on a sub-sample → SENAITE shows error message; no transition; no garbage in IS DB

### Phase A (Benzyl Alcohol analyte)

- [ ] DB has Benzyl Alcohol peptide row, `analyte_class='additive'`
- [ ] All other peptide rows have `analyte_class='peptide'`
- [ ] Sample prep wizard, look up a peptide sample → dropdown shows peptides only (no BA)
- [ ] Sample prep wizard, look up a BW sample → dropdown shows only BA

### Vial Assignment Step (new wizard phase)

- [ ] `lims_samples.assignment_role` column exists, every existing parent backfilled to `'hplc'`
- [ ] `lims_sub_samples.assignment_role` column exists (nullable, no default)
- [ ] IS endpoint `GET /explorer/orders/sample-services?sample_id=BW-XXXX` returns 200 with `services` + `wp_order_number` (test with prod API key)
- [ ] Mk1 endpoint `GET /api/sub-samples/{parent}/vial-demand` returns demand counts
- [ ] Mk1 endpoint `GET /api/sub-samples/{parent}/vial-plan` returns demand + per-vial roles, runs auto-assign on NULL roles
- [ ] Mk1 endpoint `PATCH /api/sub-samples/{sample_id}/assignment` works for sub-sample (null → resets) and for parent (null → coerced to `'hplc'`)
- [ ] **Open the receive wizard for a real BW order with addons:**
  - [ ] Header shows expected vial count breakdown ("4 vials (1 HPLC · 1 ENDO · 2 STERYL)")
  - [ ] Right column shows VIALS list with photo thumbnails (parent + sub-samples)
  - [ ] Sample Info panel renders Profiles as wrapped chips (no truncation)
  - [ ] Capture step footer shows only "Continue →" (no Finished button)
  - [ ] Continue button advances to the assign step
  - [ ] Assign step shows three buckets: Analyses Dept. | Microbiology(Endo+Sterility nested) | Xtra
  - [ ] Auto-assign correctly distributes vials based on order's `services` dict
  - [ ] Drag a vial between buckets → PATCH succeeds, optimistic update sticks
  - [ ] "Reset to auto" link in a bucket NULLs sub-sample roles, parent stays `'hplc'`
  - [ ] Assign step footer: ← Back + Print labels →
  - [ ] Print step footer: ← Back + Print labels + Finished
  - [ ] Printed labels show 3rd line with role short-name (HPLC / ENDO / STERYL / XTRA)
  - [ ] Printed labels show "Vial X/Y" suffix on the order line
- [ ] **IS-unreachable fallback:** stop IS → reopen assign step → amber banner "Couldn't load order services…" appears, all vials in Xtra, print still works
- [ ] **Sample detail page:**
  - [ ] "+ Add Sub-Sample" button is in the top header bar (alongside HPLC Results / Activity / Actions), not the lower section
  - [ ] Header shows "Assigned to Analytical HPLC" / "Microbiology — Endotoxin" / etc. on the left of the progress bar
  - [ ] Right side shows verified count in emerald, "verified" label flips to amber when there's pending work, percent in emerald
  - [ ] Old "X Verified · Y Pending" pill is gone

### Phase 2 Highlight (primary analysis emphasis)

- [ ] Backend `lookup_senaite_sample` populates `service_group_id` + `service_group_name` per analysis (joined from `analysis_services` by keyword)
- [ ] Open a sub-sample with `assignment_role='endo'` → `ENDO-LAL` row gets the **amber left border + "★ Primary" pill** (filled star icon)
- [ ] Open a sub-sample with `assignment_role='ster'` → `STER-PCR` row gets it
- [ ] Open a sub-sample with `assignment_role='hplc'` → all Analytics-grouped analyses get it
- [ ] Open a sub-sample with `assignment_role='xtra'` → no rows get the highlight
- [ ] Open the parent AR's detail page → all Analytics-grouped analyses get the highlight (parent always `'hplc'`)
- [ ] Highlights are visual-only: all analyses still appear in the table, none are hidden

### Wizard sidebar thumbnails

- [ ] Sub-sample vials show 36px square photo thumbnails on the left of each entry
- [ ] Parent (vial 1) shows its photo thumbnail too (uses the extended `/photo` endpoint that falls back to `LimsSample` when sample_id isn't a sub-sample)
- [ ] "View details" link is gone from both parent and read-only sub-sample entries (it broke wizard flow)

---

## 7. Post-deploy tasks (deferred / lab-driven)

These are **NOT** blockers for the release but should be tracked as follow-ups:

1. **Lab provides BA HPLC method params:**
   - Reference RT, RT tolerance window
   - Wavelength (nm), column model/size
   - Mobile phase / gradient (start %, dissolution solvent), column temp
   - Injection volume, flow rate
   - Which instrument(s) run BW samples

2. **Create `HplcMethod` row + `peptide_methods` + `instrument_methods` links for BA**, once params are in.

3. **Build BA calibration curve from a standard prep run** (existing standard-prep workflow; no code change needed).

4. **Smoke test sub-sample publish guard with a real `-S01` sample** in production.

5. **Decide cleanup of orphan pre-Phase-24 `-S01` rows** (e.g. BW-0003-S01 if any). Design doc says optional; leave or DELETE manually.

6. **Wire auto-default service group on AnalysisService create.** Today the create-AnalysisService endpoint does NOT auto-assign new services to the `is_default` group — even though Analytics is flagged `is_default=true`. This means every new instrument method or peptide added post-deploy will silently land ungrouped, and Phase 2 highlight won't catch it. Small backend patch — see `Accu-Mk1/docs/superpowers/specs/2026-05-03-vial-assignment-step-design.md` Phase 3 prerequisites.

7. **Phase 3 — service_group ↔ instrument relationship.** Captured in the vial-assignment spec, deferred here. Adds a `service_group_instruments` join table + ORM relationship + admin-page UI for assigning instruments to groups. Worksheet planner consumer is its own follow-up phase. Design ref: [vial-assignment-step-design.md](../superpowers/specs/2026-05-03-vial-assignment-step-design.md).

8. **Refresh stale docs:**
   - integration-service: `docs/SENAITE_INTEGRATION_GUIDE.md`, `docs/PRODUCTION_DEPLOYMENT.md` — add BW env vars and product type
   - coabuilder: `docs/COA_LOGIC_GUIDE.md` — add 2.14.0 addons-on-BW addendum
   - accumarklabs: `docs/AE_ORDER_CREATION.md`, `docs/WORDPRESS_INTEGRATION_GUIDE.md` — describe BW path + AccuShield expansion
   - Accu-Mk1: refresh `docs/deployment-v0.26.1-checklist.md` for v0.33.0 (this guide replaces it). Also refresh receive-wizard userguide: it's now a 3-phase flow (capture → assign → print), the assign step has DnD + reset-to-auto, labels carry a 3rd line.

9. **Run an end-to-end live smoke test on a real production order** before ramping customer traffic — see Section 6 verification checklist.

---

## 8. Rollback plan

Each repo can roll back independently. Order matters less for rollback than for forward deploy.

### accumarklabs theme
```bash
# Revert to previous tag (theme is file-based)
cd /path/to/accumarklabs/wp-content/themes/wpstar
git checkout v2.23.0  # or whichever version was live
```
The DB SKU change (`bac-water-panel`) is harmless to leave in place — it's only consumed by the new theme code.

### integration-service
```bash
ssh root@prod
cd /root/integration-service
VERSION=0.33.0 docker compose -f docker-compose.prod.yml up -d
```
BW env vars become inert (no BW orders existed pre-deploy anyway). Sub-sample guard reverts.

### coabuilder
```bash
VERSION=2.13.0 docker compose -f docker-compose.prod.yml up -d
```
**Caveat:** rolling back coabuilder while integration-service is on 0.34.0 will break BW COA generation (matrix-type dispatch fix `339c287` is in 2.13.1, the addons page-2 in 2.14.0). Pair the rollback.

### Accu-Mk1 backend + frontend
```bash
VERSION=0.31.0 docker compose -f docker-compose.prod.yml up -d backend
# Redeploy old frontend bundle
```

**DB:** the `analyte_class` column is forward-compatible — leaving it in place is safe. Old code ignores it. Rolling back the migrations themselves is **not recommended** (would require manual `ALTER TABLE peptides DROP COLUMN analyte_class` + delete BA seed).

**Vial assignment columns (`assignment_role` on lims_samples + lims_sub_samples) are also forward-compatible:**
- Old Mk1 code (pre-vial-assignment) doesn't reference the columns — they sit unused.
- The new Mk1 endpoints (`/vial-plan`, `/vial-demand`, `/assignment`) become 404 on rollback, which is the right behavior.
- The Phase 2 highlight is purely a frontend feature; `service_group_id` / `service_group_name` enrichment in the SENAITE lookup adds two optional fields, ignored by older clients.
- **Service-group memberships added via the bulk-assign SQL stay in place** — they'd be reused if you roll forward again.

---

## 9. Known issues & latent bugs (for the on-call)

1. **Accu-Mk1 `_run_migrations()` swallows errors silently** ([backend/database.py:230-235](../../backend/database.py#L230-L235)). If a future migration fails, the whole transaction rolls back and nothing logs. **Mitigation:** always run the post-deploy schema verification SQL in section 4.

2. **`P-0138` missing from `lims_samples`** despite being in SENAITE and `sample_status_events`. Sibling `PB-0074` from the same order #3226 IS in `lims_samples`. Likely a race or skip in the multi-sample order ingest path. **Not blocking this release**; track as a follow-up bug.

3. **Decimal-quantity fields don't inherit to sub-samples.** SENAITE/Plone-5's `isDecimal` validator rejects strings, ints, and floats from Python 3 clients on `Analyte{N}DeclaredQuantity` and `DeclaredTotalQuantity`. All other custom fields inherit; quantities can be set manually until validator is fixed server-side.

4. **Worksheet inbox sub-sample handling deferred.** Sub-samples currently appear individually alongside parents; will need grouping work as multi-vial samples become common.

5. **Sub-sample publish design — Option A (forward-only).** Sub-samples never get their own customer-facing COA; only the parent's COA reaches WP. This is enforced by the publish guard. If product wants Option B (sub-samples publish as additional COAs on the same order line) later, it requires WP-side schema changes + a new phase.

---

## 10. Quick reference

| Component | Version | Branch / latest commit |
|---|---|---|
| accumarklabs (theme) | 2.23.1 | `feat/bac-water-order-wizard` — `bf4e16d` |
| accumarklabs (AccuVerify plugin) | 1.2.3 | `feat/bac-water-order-wizard` — `aa320df` |
| integration-service | 0.35.0 | `feat/vial-assignment-step` (off `feat/bac-water-integration`) — `0c67075` |
| coabuilder | 2.14.0 | `fix/is-generic-profile-bw` — `6d15a8a` |
| Accu-Mk1 | 0.33.0 | `feat/vial-assignment-step` (off `feat/sub-samples`) — latest tip on this branch |

**Latest Accu-Mk1 commits on `feat/vial-assignment-step`:**

| Commit | Purpose |
|---|---|
| `face38b` | docs: vial assignment step — spec + plan |
| `428fb96` | mk1: assignment_role columns on lims_samples + lims_sub_samples |
| `8da6db5` | mk1: assignment_role attr on ORM models |
| `7940f77` | mk1: fetch_sample_services IS client helper |
| `c85fa87` | mk1: derive_demand pure function |
| `8e85294` | mk1: auto_assign pure function |
| `0407d87` | mk1: GET /api/sub-samples/{parent}/vial-plan endpoint |
| `71c125b` | mk1: PATCH /api/sub-samples/{id}/assignment endpoint |
| `e9e9d3b` | fe: getVialPlan + patchVialAssignment client wrappers |
| `dbf2cfa` | fe: AssignStep with bucket layout + DnD |
| `a811bd8` | fe: wire 'assign' phase between capture and print |
| `cf8147b` | mk1: surface assignment_role on /sub-samples list + sidebar badge |
| `2a77108` | fe: label 3rd line for service short-name + Vial X/Y |
| `1ba6c0d` | mk1: ACCU_MK1_API_KEY env var name fix |
| `bcc75e8` | mk1: wizard UX iteration (header counts, right-side vials, untruncated profiles, footer cleanup) |
| `2f07be1` | fe: vial thumbnails + remove View details from sidebar |
| `28a2fd4` | mk1: parent AR photo thumbnail in sidebar |
| `c8b1d3d` | fe: move Add Sub-Sample to sample detail header bar |
| `a442b9d` | fe: assignment label + colored progress in sample header |
| `637072e` | mk1: Phase 2 — highlight primary analyses for vial assignment |
| `5dec95b` | docs: spec re-scope of Phase 2 + capture Phase 3 |
| `8bd9e3d` | fe: bump Primary pill to amber + star icon |

**Dev SENAITE UIDs (for reference, NOT for prod):**
- BW Sample Type: `8b64a58627494da88dda4abdb7b4839c`
- BW Profile: `9fda4abd727540c2ae2de6bec7a1939d`

**Production-only secrets that must rotate / match across services:**
- `JWT_SECRET` (Accu-Mk1 backend ↔ integration-service)
- `ACCU_MK1_API_KEY` on Mk1 backend (canonical) ↔ `DESKTOP_API_KEYS` allowlist on IS — single value, must include the same string
- Webhook signing secret (SENAITE custom button → IS)

---

## 11. Deployment-day timeline (suggested)

A practical clock for the on-call running the deploy. All times in elapsed minutes from kickoff.

| T+ | Step | Owner | Verification |
|---|---|---|---|
| 00 | Tag freeze on all four repos. Notify lab to pause receiving for ~30 min. | DevOps | Slack/comms |
| 05 | Production SENAITE setup (section 1.a) — analyses, profiles, sample type | DevOps | UID capture into deploy notes |
| 15 | Mk1 service-group bulk-assign SQL (section 1.b) | DevOps | Verification SELECTs return ~80 + 3 + 0 |
| 18 | WordPress SKU + coupon (section 2) | DevOps | wp-cli read-back |
| 20 | Update IS production `.env` with new BW UIDs (section 3) | DevOps | `cat /root/integration-service/.env \| grep BAC` |
| 22 | Deploy theme `2.23.1` + plugin `1.2.3` | DevOps | Browse `/portal/new-order/`, see BW tab |
| 25 | Deploy IS `0.35.0` | DevOps | `docker logs integration-service \| grep "Application startup complete"` + smoke `curl /explorer/orders/sample-services?sample_id=BW-XXXX` |
| 28 | Deploy coabuilder `2.14.0` | DevOps | container healthy |
| 30 | Deploy Mk1 backend `0.33.0` — runs migrations on startup | DevOps | Section 4 verification SQL |
| 33 | Deploy Mk1 frontend `0.33.0` (Tauri or web build) | DevOps | Hard-refresh local app, see new wizard step |
| 35 | Smoke test: place a fake BW order with all addons, follow it through the full flow (Section 6) | Lab + DevOps | Every checkbox in Section 6 ✓ |
| 60 | Lab resumes receiving real samples | Lab | — |
| +24h | Watch for: sub-sample publish guard 403s in IS logs, SENAITE secondary creation errors, missing `assignment_role` rows | On-call | `docker logs integration-service`, Mk1 DB scans |

**Pre-cut go/no-go checklist** (run T-30 minutes before kickoff):
- [ ] All four repos pass CI on the target branches/commits
- [ ] Production `.env` files staged on the target droplets (NOT yet swapped in)
- [ ] SENAITE prod is reachable from IS host (`curl -u admin:PASS http://senaite-prod:8080/senaite/@@API/senaite/v1/version`)
- [ ] WP DB backup snapshot taken (rolling back the SKU change is trivial but the snapshot is cheap insurance)
- [ ] Mk1 + IS DB backups taken (the assignment_role / service_group_members migrations are forward-compatible but the snapshots cover any unrelated drift)
- [ ] On-call rotation confirmed
- [ ] Lab notified of the receiving pause window

---

## 12. Production-only edge cases to monitor for the first week

1. **First real BW order.** Watch for SENAITE AR creation, `Analyte1Peptide = "Benzyl Alcohol"` set, `bac_water` profile attached, sample lands in Mk1 receive inbox.
2. **First sub-sample publish attempt.** Confirm 403 fires from each layer: Mk1 UI hides the menu, Mk1 backend returns 403 if hit directly, IS desktop endpoint returns 403, IS webhook returns 403 to SENAITE's custom button.
3. **First multi-vial check-in.** Header shows "Expected: N vials"; vials list on the right column populates with thumbnails as photos are taken; auto-assign produces the right buckets when Continue is pressed.
4. **First "Reset to auto"** — a tech drags then resets; verify sub-sample roles return to NULL→auto-assigned, parent stays `'hplc'`.
5. **First Phase 2 highlight.** Open a sub-sample after assignment — the `★ Primary` amber pill renders on the right rows. If it doesn't, the most likely cause is the analysis service not being in `service_group_members` (re-run the bulk-assign SQL or fix via admin UI).
6. **IS-unreachable failure mode.** If IS is down or slow, the receive wizard's assign step renders all vials in Xtra with the amber banner. Print still works. Verify the wizard is not blocked.
7. **Customer plugin auto-update.** Customer sites running `accuverify-woocommerce` 1.2.1 or 1.2.2 should see the "Update available 1.2.3" banner within 12 hours. Spot-check 2–3 sites.
8. **Real bank ACH order via Stripe Financial Connections.** First production payment with the new checkout polish; test mode currently — confirm Financial Connections is ACTIVE in live Stripe Dashboard before first ACH.

---

## 13. Doc cross-links

- Vial assignment step spec: [`docs/superpowers/specs/2026-05-03-vial-assignment-step-design.md`](../superpowers/specs/2026-05-03-vial-assignment-step-design.md) — covers the data model, endpoints, auto-assign algorithm, edge cases, Phase 2/3 plans
- Vial assignment step plan: [`docs/superpowers/plans/2026-05-03-vial-assignment-step.md`](../superpowers/plans/2026-05-03-vial-assignment-step.md) — task-by-task implementation plan as executed
- Sub-samples (Phase 24) spec: [`docs/superpowers/specs/2026-04-27-sub-samples-design.md`](../superpowers/specs/2026-04-27-sub-samples-design.md) — original sub-sample design + 4-layer publish guard
- Release handoff (this session): [`HANDOFF_2026-05-bw-subsamples.md`](../../HANDOFF_2026-05-bw-subsamples.md) — narrative roundup of everything in the May 2026 release
