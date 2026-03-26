# Deployment Checklist — v0.26.1

**Date:** 2026-03-23
**From:** v0.25.0 → v0.26.1
**Commits:** ~40
**Scope:** Standard sample preps, calibration chromatograms, HPLC results persistence, chromatogram overlay, same-method identity check, audit trail, debug persistence, SENAITE results summary, file aliases UI

---

## Deployment Steps

```bash
git pull
docker-compose build backend && docker-compose up -d backend
docker-compose build frontend && docker-compose up -d frontend
```

No manual migrations, no env var changes, no new dependencies. All DB migrations run automatically on backend startup.

---

## Auto-Migrations (on startup)

| Table | New Columns |
|-------|------------|
| `calibration_curves` | `instrument_id` (FK → instruments), widens `instrument` to VARCHAR(100) |
| `wizard_sessions` | `instrument_id` (FK → instruments), `instrument_name` |
| `hplc_analyses` | `calibration_curve_id` (FK), `sample_prep_id`, `instrument_id` (FK), `source_sharepoint_folder`, `chromatogram_data`, `run_group_id`, `debug_log` |
| `peptides` | `hplc_aliases` (JSON) |
| `sample_preps` | `instrument_id`, `instrument_name` (via mk1_db) |

Plus backfill queries that resolve existing `instrument` strings to `instrument_id` FKs on calibration_curves and wizard_sessions.

---

## Post-Deploy Testing

### HIGH Priority (core workflow)

- [ ] **Process HPLC — single peptide**
  - Open a non-blend sample (e.g., P-0136 Thymulin)
  - Run analysis, verify purity/quantity/identity results render
  - Risk: LOW (existing flow mostly unchanged)

- [ ] **Process HPLC — blend**
  - Open a blend sample (e.g., PB-0065 GLOW 17-23)
  - Verify all 3 analyte tabs appear and process
  - Verify per-vial weights differ between Vial 1 and Vial 2 components
  - Verify quantities match lab results (BPC-157: 9.85mg, GHK-CU: 50.10mg, TB17-23: 10.82mg)
  - Risk: MEDIUM (new vial routing, alias matching, per-analyte analysis)

- [ ] **Identity check with standard injections**
  - On PB-0065 (which has `_std_` files), verify identity shows "Ref: Standard injection (P-0111)" not "Ref: Calibration curve"
  - Verify BPC-157 identity CONFORMS (delta ~0.019 min) instead of DOES NOT CONFORM (delta ~6.6 min)
  - Risk: MEDIUM (new standard injection detection and RT comparison)

- [ ] **DB reload — close and reopen**
  - After running Process HPLC, close the flyout
  - Reopen Process HPLC for the same sample
  - Verify: saved results load instantly (no SharePoint re-scan)
  - Verify: correct number of tabs (no duplicates)
  - Verify: chromatogram and peak data fill in after background SharePoint load
  - Risk: MEDIUM (new DB-first load path)

- [ ] **Standard prep → create curve**
  - Open Process HPLC for a standard prep (e.g., P-0136)
  - Verify concentration data is detected (NOT the "Could not extract" error)
  - Verify curve preview shows with chart and Create button
  - Risk: MEDIUM (`_is_standard_injection()` parser change)

### MEDIUM Priority (new features)

- [ ] **Calibration curve edit — Source Sample ID + Vendor**
  - Open a peptide, expand a curve, click Edit
  - Enter a Source Sample ID (e.g., P-0309), save
  - Verify chromatogram auto-fetches from SharePoint
  - Verify Standard Chromatogram section appears with concentration tabs
  - Risk: LOW (best-effort, failures don't block save)

- [ ] **Chromatogram overlay**
  - Open Process HPLC for a sample whose curve has chromatogram_data
  - Verify two traces on the chromatogram chart: dashed standard + solid sample
  - Risk: LOW (additive, only renders when data exists)

- [ ] **Instrument dropdowns**
  - Edit a calibration curve, change instrument via dropdown, save
  - Verify instrument persists correctly (not hardcoded "1290"/"1260")
  - Risk: LOW (backwards compatible)

- [ ] **HPLC File Aliases tab**
  - Open a peptide flyout, click "File Aliases" tab
  - Add an alias, verify it saves
  - Remove an alias, verify it removes
  - Risk: LOW (isolated feature)

- [ ] **SENAITE Results Summary**
  - Run Process HPLC, click "Submit Results"
  - Verify summary card shows all analytes with purity/qty/identity
  - For blends: verify Blend Purity (mass-weighted avg), Total Quantity, Blend Identity
  - Risk: LOW (display only)

- [ ] **Warnings banner**
  - Open Process HPLC for a blend missing standard injections
  - Verify amber warnings appear with action links (SharePoint folder, Add Alias)
  - Click "Add as alias" button, verify modal opens with peptide dropdown
  - Risk: LOW (informational, non-blocking)

### LOW Priority (infrastructure)

- [ ] **Debug panel**
  - Open debug console (terminal icon) during Process HPLC
  - Verify it shows full log: sample prep, parse results, label matching, weights, formulas, results
  - On DB reload: verify debug panel still renders (from live buildDebugLines, not empty)
  - Risk: LOW

- [ ] **Audit trail in DB**
  - After running analysis, check DB:
    ```sql
    SELECT id, debug_log IS NOT NULL as has_log,
           raw_data->'source_files' IS NOT NULL as has_files
    FROM hplc_analyses ORDER BY created_at DESC LIMIT 5;
    ```
  - Verify `debug_log` and `source_files` are populated
  - Risk: LOW (new nullable fields)

- [ ] **hplc_complete status**
  - After running analysis, check sample prep in the list
  - Verify status badge shows teal "HPLC Complete"
  - Risk: LOW (non-blocking try/catch)

---

## Watch For

### SharePoint Connectivity
Several features now interact with SharePoint in new ways:
- Chromatogram auto-fetch on curve backfill (LIMS folder search)
- Standard injection file download during Process HPLC
- `search_sample_folder` now checks LIMS CSV folder first

All are best-effort (failures logged, don't block main flow). Test one end-to-end SharePoint interaction to verify auth/permissions work in production.

### Existing Data Compatibility
- Old `hplc_analyses` rows won't have `debug_log`, `source_files`, `run_group_id` — UI handles nulls gracefully
- Old `components_json` on sample preps won't have `hplc_aliases` — flyout fetches live aliases from peptide records
- Old calibration curves with `instrument = "HPLC 1290a"` string will be backfilled to `instrument_id` via migration

### Known Limitations
- `instrument_id` passed as `undefined` from frontend for sample preps (SamplePrep interface lacks the field)
- The "Add Alias" modal copies to clipboard for the alias text — the peptide dropdown lists non-blend peptides only
- Chromatogram overlay picks highest concentration trace from multi-conc data — no user selection in the flyout (available in the curve viewer)
