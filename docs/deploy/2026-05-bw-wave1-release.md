# Deployment Guide — 2026-05 Wave 1 Release (BW order pipeline + CoA)

**Release scope:** Bacteriostatic Water (BW) order pipeline end-to-end. Customers can place BW + Endotoxin + Sterility orders, samples flow into SENAITE, the legacy single-vial receive wizard handles intake, coabuilder generates 2-page BW CoAs.

**Deferred to Wave 2:** Sub-Samples (Phase 24), Vial Assignment Step, Phase 2 highlight, samples-list collapse, sub-sample publish guards (UI/backend visible). The IS code includes inert sub-sample regex guards that no-op without sub-sample IDs in the system.

---

## Affected repos & target versions

| Repo | Wave 1 branch | From | To |
|---|---|---|---|
| `accumarklabs` (WP theme) | `release/2026-05-bw-wave1` | 2.23.0 | **2.23.1** |
| `accumarklabs` (AccuVerify plugin) | `release/2026-05-bw-wave1` | 1.2.2 | **1.2.3** |
| `integration-service` | `release/2026-05-bw-wave1` | 0.33.0 | **0.34.0** |
| `coabuilder` | `release/2026-05-bw-wave1` | 2.13.0 | **2.14.0** |
| `Accu-Mk1` | `release/2026-05-bw-wave1` | 0.31.0 | **0.31.1** |

---

## 1. Pre-deploy: Production SENAITE setup

**Required Analysis Services** (Setup → Analysis Services). All five must exist with these exact keywords:

| Keyword | Title (suggested) | Used by |
|---|---|---|
| `Benzyl_Alcohol_Assay` | Benzyl Alcohol Assay (HPLC) | BW core panel |
| `PH-DETERM` | pH Determination | BW core panel |
| `FILL-NET-CONTENT` | Fill / Net Content | BW core panel |
| `ENDO-LAL` | Endotoxin (LAL) | BW + addons |
| `STER-PCR` | Rapid Sterility Screening (PCR) | BW + addons |

> `Benzyl_Alcohol_Assay` uses **underscores**; the others use **dashes**. coabuilder's keyword lookup is exact-match.

**Required Analysis Profiles** (Setup → Analysis Profiles):

| Profile | Contains | Used by |
|---|---|---|
| `bac_water` | `Benzyl_Alcohol_Assay`, `PH-DETERM`, `FILL-NET-CONTENT` | BW orders (primary) |
| `endotoxin` | `ENDO-LAL` | BW + peptide add-on |
| `sterility_pcr` | `STER-PCR` | BW + peptide add-on |

**Required Sample Type:** `Bacteriostatic Water` (Setup → Sample Types). Title must match exactly — coabuilder's `senaite_client.py` matrix dispatch is title-keyed.

**Capture UIDs** for the IS env vars (section 3):

```bash
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

```bash
# WP-CLI: set BW Panel SKU on prod if missing
wp post meta update <BW_PANEL_PRODUCT_ID> _sku bac-water-panel
```

**Coupon `AccuShield Panel` allow-list** (WC → Coupons): must include the prod IDs of HPLC IPQ, Endotoxin LAL, Sterility PCR, **and Bac Water Panel**.

**`wp_options.wc_test_services` content**:
- Primary entry whose `name` begins with `HPLC Purity` (peptide path)
- Primary entry for **Bac Water Panel** (`type: primary`)
- Endotoxin and Sterility entries present as `type: addon`

---

## 3. Pre-deploy: Production env vars (integration-service)

Add to `/root/integration-service/.env`:

```env
# Bacteriostatic Water profile/type UIDs (capture from production SENAITE — section 1)
SENAITE_BAC_WATER_TYPE_UID=<prod uid for Bacteriostatic Water sample type>
SENAITE_BAC_WATER_PROFILE_UID=<prod uid for bac_water profile>

# Verify these match prod (defaults exist in app/core/config.py but should be set explicitly)
SENAITE_ENDOTOXIN_PROFILE_UID=<prod uid>
SENAITE_STERILITY_PROFILE_UID=<prod uid>
SENAITE_SINGLE_PROFILE_UID=<prod uid>
SENAITE_BLEND_PROFILE_UID=<prod uid>
```

Sanity check: integration-service raises a clear error at order-creation time if these are missing for a BW order.

---

## 4. Pre-deploy: Production Accu-Mk1 prep

### Database migrations (auto-run on backend startup)

Wave 1 adds three new migration statements in `backend/database.py::_run_migrations()`:

```sql
-- Analyte class discriminator (peptide | additive)
ALTER TABLE peptides ADD COLUMN IF NOT EXISTS analyte_class VARCHAR(20) NOT NULL DEFAULT 'peptide';

-- Rename short 'BA' abbreviation from earlier dev iterations (no-op on fresh installs)
UPDATE peptides SET abbreviation='Benzyl Alcohol' WHERE abbreviation='BA' AND name='Benzyl Alcohol';

-- Seed Benzyl Alcohol as a non-peptide analyte
INSERT INTO peptides (name, abbreviation, is_blend, analyte_class, active, created_at, updated_at)
VALUES ('Benzyl Alcohol', 'Benzyl Alcohol', FALSE, 'additive', TRUE, NOW(), NOW())
ON CONFLICT (abbreviation) DO NOTHING;

-- Bind Benzyl Alcohol to its SENAITE analysis service (slot 1) so the
-- Import Curves dialog populates BA. Silent no-op if the SENAITE-synced
-- analysis_services row hasn't arrived yet — retries on every startup.
INSERT INTO peptide_analytes (peptide_id, analysis_service_id, slot, created_at)
SELECT p.id, ans.id, 1, NOW()
FROM peptides p
JOIN analysis_services ans ON ans.keyword = 'Benzyl_Alcohol_Assay'
WHERE p.abbreviation = 'Benzyl Alcohol'
ON CONFLICT (peptide_id, slot) DO NOTHING;
```

**Migration isolation:** as of v0.31.1, `_run_migrations()` runs each statement in its own try/except with WARNING-level skip logging. After deploy, run:

```bash
docker logs accu-mk1-backend | grep migration_skipped  # should be empty
```

### Verification SQL

```sql
-- analyte_class column exists with NOT NULL + default 'peptide'
\d peptides

-- 1 'additive' row (Benzyl Alcohol), rest 'peptide'
SELECT analyte_class, COUNT(*) FROM peptides GROUP BY analyte_class;

-- BA peptide row exists
SELECT id, name, abbreviation, analyte_class, active FROM peptides WHERE name='Benzyl Alcohol';

-- BA peptide_analytes row exists (one row, slot 1, joining to keyword 'Benzyl_Alcohol_Assay')
SELECT pa.slot, p.abbreviation, ans.keyword, ans.title
FROM peptide_analytes pa
JOIN peptides p ON p.id = pa.peptide_id
LEFT JOIN analysis_services ans ON ans.id = pa.analysis_service_id
WHERE p.abbreviation = 'Benzyl Alcohol';
```

**If the BA `peptide_analytes` row is missing**, the prerequisite is the SENAITE-synced `analysis_services` entry with keyword `Benzyl_Alcohol_Assay` (section 1). Confirm SENAITE prod is set up and the Mk1 ↔ SENAITE service sync has run, then restart the backend — the migration retries on every startup.

### Production-only settings

Confirm production `.env` for the backend:
- `JWT_SECRET` — strong random, must match between Accu-Mk1 backend and integration-service
- `MK1_DB_*`, `INTEGRATION_DB_PROD_*`
- `SENAITE_URL`, `SENAITE_USER`, `SENAITE_PASSWORD`
- `INTEGRATION_SERVICE_URL`
- `ACCU_MK1_API_KEY` — must match a value in IS's `DESKTOP_API_KEYS` allowlist

---

## 5. Backfill operations

**None required.** Wave 1 is purely additive:
- `analyte_class` column adds with `DEFAULT 'peptide' NOT NULL` so all existing peptide rows are auto-backfilled.
- Benzyl Alcohol seed is idempotent via `ON CONFLICT (abbreviation)`.
- `peptide_analytes` seed is idempotent via `ON CONFLICT (peptide_id, slot)`.

No data migration scripts, no manual UPDATE queries, no row reconciliation. The migrations handle everything.

---

## 6. Deploy sequence

**Run in this order.** Each step is independent but the order minimizes the inconsistency window.

### 6.1 SENAITE setup (manual, one-time)

Complete section 1. Capture all UIDs.

### 6.2 WordPress (theme + plugin + product SKU)

```bash
# 1. SSH to prod WP host
# 2. Set SKU + verify coupon (section 2)
wp post meta update <BW_PANEL_PRODUCT_ID> _sku bac-water-panel

# 3. Deploy theme 2.23.1 + plugin 1.2.3 from release/2026-05-bw-wave1
cd /path/to/accumarklabs/wp-content/themes/wpstar
git fetch origin
git checkout release/2026-05-bw-wave1
# Theme is file-based — no DB writes on activate. WP picks up changes automatically.
```

**Smoke test:** open `/portal/new-order/`, switch to "Bacteriostatic Water" tab, place a test order with BW + Endotoxin + Sterility add-ons, verify cart total includes AccuShield 15% bundle discount.

### 6.3 Integration-service deploy → 0.34.0

```bash
cd integration-service  # release/2026-05-bw-wave1 branch
docker build -t ghcr.io/zstar0/integration-service:0.34.0 .
docker push ghcr.io/zstar0/integration-service:0.34.0

# On prod droplet:
scp .env.prod root@prod:/root/integration-service/.env
ssh root@prod
cd /root/integration-service
VERSION=0.34.0 docker compose -f docker-compose.prod.yml up -d
docker logs -f integration-service  # watch for "Application startup complete"
```

**Smoke test:** `docker logs integration-service | grep -i bac_water` should show config loaded; submit a test BW order from WP and verify SENAITE AR creation.

### 6.4 Coabuilder deploy → 2.14.0

```bash
cd coabuilder  # release/2026-05-bw-wave1 branch
docker build -t ghcr.io/zstar0/coabuilder:2.14.0 .
docker push ghcr.io/zstar0/coabuilder:2.14.0

# On prod droplet:
ssh root@prod
cd /root/coabuilder
VERSION=2.14.0 docker compose -f docker-compose.prod.yml up -d
```

**Smoke test:** Generate a CoA for a BW sample with Endotoxin and Sterility add-ons. Verify 2-page output (page 1 = BA + pH + Fill, page 2 = Endo + Sterility).

### 6.5 Accu-Mk1 backend → 0.31.1

```bash
cd Accu-Mk1  # release/2026-05-bw-wave1 branch
docker build -t ghcr.io/zstar0/accu-mk1-backend:0.31.1 ./backend
docker push ghcr.io/zstar0/accu-mk1-backend:0.31.1

# On prod droplet:
ssh root@prod
cd /root/accu-mk1
VERSION=0.31.1 docker compose -f docker-compose.prod.yml up -d backend
docker logs -f accu-mk1-backend  # confirm migrations ran
```

**Verify migrations landed** (run the SQL from section 4).

### 6.6 Accu-Mk1 frontend → 0.31.1

```bash
cd Accu-Mk1
npm run build  # or whatever the prod build target is
# Deploy to nginx / Tauri release pipeline
```

**Smoke test:** open a BW sample's detail page in the desktop app — verify "Benzyl Alcohol" shows in the Analytes panel after a fresh BW order is received.

---

## 7. Post-deploy verification checklist

### BW end-to-end smoke test

- [ ] Submit a BW WP order (Bac Water Panel + Endotoxin + Sterility), verify AccuShield 15% applied
- [ ] Confirm `wc-order-submitted` status in WC
- [ ] Confirm integration-service `order_submissions` row with `status=accepted`
- [ ] Confirm SENAITE AR created (e.g. `BW-XXXX`) with:
  - `ClientOrderNumber = WP-<order_id>`
  - `SampleTypeTitle = Bacteriostatic Water`
  - `Analyte1Peptide = "Benzyl Alcohol"`
  - 3 analyses + 2 add-ons attached
- [ ] Receive the BW sample in Accu-Mk1 via the **legacy single-vial receive wizard** → confirm row in `lims_samples` (parent only — Wave 1 has no sub-samples)
- [ ] Confirm "Benzyl Alcohol" shows in the Analytes panel
- [ ] Generate CoA → confirm 2 pages (core + add-ons)
- [ ] Publish CoA → confirm publish flow completes; if SENAITE state is `ready_for_initial_review`, expect a yellow toast warning (Wave 1 surfaces this as a warning rather than an error; verify the sample in SENAITE to advance the workflow)

### Wave 1-specific verification

- [ ] DB has Benzyl Alcohol peptide row with `analyte_class='additive'`
- [ ] All other peptide rows have `analyte_class='peptide'`
- [ ] Sample prep wizard, look up a peptide sample → dropdown shows peptides only (no BA)
- [ ] Sample prep wizard, look up a BW sample → dropdown shows only BA
- [ ] Receive wizard's PhotoCapture: revoke camera permission for the site → "Choose File" button appears next to "Try Again"; pick any image file → captures cleanly into the 500x496 preview shape

### What is intentionally NOT verified in Wave 1

These are Wave 2 features. **They will be missing or 404 in Wave 1**:

- ❌ Vial Assignment wizard step (Wave 2)
- ❌ Sub-sample creation on multi-vial receive (Wave 2)
- ❌ Sub-sample badge / collapse on samples list (Wave 2)
- ❌ Phase 2 primary-analysis highlight on sample detail (Wave 2)
- ❌ `lims_sub_samples` rows / `assignment_role` columns (Wave 2)
- ❌ `/api/sub-samples/*` endpoints (Wave 2 — should 404)
- ❌ IS `/explorer/orders/sample-services` endpoint (Wave 2 — should 404)

---

## 8. Rollback plan

Each repo can roll back independently. Order matters less for rollback than for forward deploy.

### accumarklabs theme + plugin
```bash
cd /path/to/accumarklabs/wp-content/themes/wpstar
git checkout v2.23.0
```
The DB SKU change (`bac-water-panel`) is harmless to leave — only consumed by 2.23.1+ code.

### integration-service
```bash
ssh root@prod
cd /root/integration-service
VERSION=0.33.0 docker compose -f docker-compose.prod.yml up -d
```
BW env vars become inert (no BW orders existed pre-deploy anyway).

### coabuilder
```bash
VERSION=2.13.0 docker compose -f docker-compose.prod.yml up -d
```
**Caveat:** rolling back coabuilder while integration-service is on 0.34.0 will break BW CoA generation (matrix-type dispatch is in 2.14.0). Pair the rollback.

### Accu-Mk1 backend + frontend
```bash
VERSION=0.31.0 docker compose -f docker-compose.prod.yml up -d backend
# Redeploy old frontend bundle
```

**DB:** the `analyte_class` column is forward-compatible — leave it in place. Old code ignores it. Rolling back the migrations themselves is **not recommended** (would require manual `ALTER TABLE peptides DROP COLUMN analyte_class` + delete BA seed). The peptides row + peptide_analytes seed are also harmless if left.

---

## 9. Known issues & latent bugs

1. **BW CoA publish from `ready_for_initial_review` state** ([backend/main.py](../../backend/main.py)). The local CoA + IS publish succeed but SENAITE workflow doesn't advance because `publish` isn't a valid transition from this custom state — only `verify` is. Wave 1 surfaces this as a yellow `toast.warning` (not an error). Operator should manually run "Verify" in SENAITE to advance the sample to `verified`, then it can be re-published cleanly. A SENAITE-side workflow fix (add `publish` exit-transition from `ready_for_initial_review`) is tracked as a follow-up.

2. **BW curve import requires `*_Std_*_PeakData.csv` filenames.** The peptide-config Import Curves dialog (Browse Folder mode) scans recursively and only matches files matching `^(.+?)_Std_(\d+(?:\.\d+)?)_.*PeakData\.csv$` (regex at [main.py:5844](../../backend/main.py#L5844)). For BA in particular, name standard prep files as `BA_Std_100_PeakData.csv`, `BA_Std_250_PeakData.csv`, etc. Or use Manual Entry mode. The dialog now surfaces "No *_Std_*_PeakData.csv files found in folder" in a destructive banner.

3. **Decimal-quantity fields don't inherit on SENAITE secondary ARs.** Plone-5's `isDecimal` validator rejects strings, ints, and floats from Python 3 clients on `Analyte{N}DeclaredQuantity` and `DeclaredTotalQuantity`. All other custom fields inherit; quantities can be set manually until validator is fixed server-side. Latent — only matters once Wave 2 ships sub-samples.

---

## 10. Post-deploy tasks (deferred / lab-driven)

These are **NOT** blockers for Wave 1 but should be tracked as follow-ups:

1. **Lab provides BA HPLC method params:**
   - Reference RT, RT tolerance window
   - Wavelength (nm), column model/size
   - Mobile phase / gradient (start %, dissolution solvent), column temp
   - Injection volume, flow rate
   - Which instrument(s) run BW samples

2. **Create `HplcMethod` row + `peptide_methods` + `instrument_methods` links for BA**, once params are in.

3. **Build BA calibration curve from a standard prep run** (existing standard-prep workflow; no code change needed).

4. **Refresh stale docs** — IS `SENAITE_INTEGRATION_GUIDE.md`, coabuilder `COA_LOGIC_GUIDE.md` for 2.14.0 addons-on-BW, accumarklabs `AE_ORDER_CREATION.md` for BW path.

5. **SENAITE workflow follow-up** — add `publish` as a direct exit-transition from `ready_for_initial_review` so the publish flow doesn't depend on a manual verify step. Plugin XML change in `senaite_sample_workflow/definition.xml`.

6. **Schedule Wave 2 deploy** — once Wave 1 is stable in production for ~1 week, ship the deferred sub-sample + vial-assignment work from `feat/vial-assignment-step`.

---

## 11. Deployment-day timeline (suggested)

All times in elapsed minutes from kickoff.

| T+ | Step | Owner | Verification |
|---|---|---|---|
| 00 | Tag freeze on all four repos. Notify lab to pause receiving for ~20 min. | DevOps | Slack/comms |
| 05 | Production SENAITE setup (section 1) — analyses, profiles, sample type | DevOps | UID capture into deploy notes |
| 15 | WordPress SKU + coupon (section 2) | DevOps | wp-cli read-back |
| 17 | Update IS production `.env` with BW UIDs (section 3) | DevOps | `cat /root/integration-service/.env \| grep BAC` |
| 20 | Deploy theme `2.23.1` + plugin `1.2.3` | DevOps | Browse `/portal/new-order/`, see BW tab |
| 22 | Deploy IS `0.34.0` | DevOps | `docker logs integration-service \| grep "Application startup complete"` |
| 25 | Deploy coabuilder `2.14.0` | DevOps | container healthy |
| 27 | Deploy Mk1 backend `0.31.1` — runs migrations on startup | DevOps | Section 4 verification SQL |
| 30 | Deploy Mk1 frontend `0.31.1` (Tauri or web build) | DevOps | Hard-refresh local app |
| 32 | Smoke test: place a fake BW order with all addons, follow it through (Section 7) | Lab + DevOps | Every checkbox in Section 7 ✓ |
| 50 | Lab resumes receiving real samples | Lab | — |
| +24h | Watch for: BW order failures in IS logs, missing `peptide_analytes` BA row, publish-from-ready_for_initial_review warnings | On-call | `docker logs integration-service`, Mk1 DB scans |

**Pre-cut go/no-go checklist** (T-30 minutes before kickoff):
- [ ] All four repos pass CI on `release/2026-05-bw-wave1`
- [ ] Production `.env` files staged on the target droplets (NOT yet swapped in)
- [ ] SENAITE prod is reachable from IS host
- [ ] WP DB backup snapshot taken
- [ ] Mk1 + IS DB backups taken (the `analyte_class` migration is forward-compatible but the snapshots cover any unrelated drift)
- [ ] On-call rotation confirmed
- [ ] Lab notified of the receiving pause window

---

## 12. Quick reference

| Component | Version | Wave 1 commit |
|---|---|---|
| accumarklabs (theme) | 2.23.1 | `eff7a9d` (release/2026-05-bw-wave1 tip) |
| accumarklabs (plugin) | 1.2.3 | same branch |
| integration-service | 0.34.0 | `cf03828` |
| coabuilder | 2.14.0 | `9efbff0` |
| Accu-Mk1 | 0.31.1 | `ab435da` |

**Production-only secrets that must rotate / match across services:**
- `JWT_SECRET` (Accu-Mk1 backend ↔ integration-service)
- `ACCU_MK1_API_KEY` on Mk1 backend ↔ `DESKTOP_API_KEYS` allowlist on IS — single value, must include the same string

---

## 13. Doc cross-links

- Wave 1 scope rationale and cherry-pick list: see internal Wave 1 scoping notes
- Bundled (Wave 1 + Wave 2) deploy guide: [`docs/deploy/2026-05-bw-subsamples-release.md`](2026-05-bw-subsamples-release.md) — keep on `feat/vial-assignment-step` for Wave 2 reference
- Wave 2 features remain on `feat/vial-assignment-step` branch, will be released post-Wave-1 stabilization
