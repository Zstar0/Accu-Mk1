# Task: Standard Sample Preps & Calibration Curve Chromatograms

## Problem

The lab tech manually compares Agilent PDF chromatograms (standard vs sample) to visually confirm analyte identity during HPLC processing. This is especially important for blends where the HPLC method differs from the method used for individual calibration standards, causing RT shifts.

We have no way to show this comparison inline in the app during Process HPLC.

## Goal

1. Allow sample preps to be marked as **Standards** (e.g., Cayman reference standards)
2. When a standard's HPLC is processed, automatically create/attach a calibration curve to the matching peptide — including the chromatogram data
3. For existing calibration curves, allow linking a Sample ID so we can locate and display the standard's chromatogram from SharePoint
4. During Process HPLC on production samples, overlay the standard's chromatogram alongside the sample's chromatogram for visual identity confirmation

## Design

### 1. Sample Prep: "Standard" flag

- Add `is_standard: boolean` to SamplePrep (default false)
- In the New Analysis wizard (Step 1), add an option to mark the prep as a Standard
- Standards are single-peptide only (Cayman standards are individual peptides)
- Standard preps flow through the same wizard steps (stock prep, dilution, measurements)

### 2. Process HPLC for Standards → Auto-create calibration curve

When completing Process HPLC on a standard sample prep:
- The system already calculates concentration from peak area + existing curve
- For a standard, we know the declared concentration (it's a reference standard)
- Auto-create or update a CalibrationCurve for that peptide with:
  - slope, intercept, r_squared from the standard data points
  - reference_rt from the main peak's retention time
  - **chromatogram_data**: the raw chromatogram trace (signal vs time array from the `*dx_dad1a*.csv` file)
  - **source_sample_id**: link back to the standard's SamplePrep sample_id
  - **source_folder**: SharePoint path to the `.rslt` folder (e.g., `P-0136_Std_GreenCap_Cayman_20260313_Thymulin.rslt`)

### 3. CalibrationCurve schema additions

```
calibration_curves table:
  + source_sample_id: text | null       -- e.g., "P-0136" — links to the standard SamplePrep
  + chromatogram_data: jsonb | null     -- { times: number[], signals: number[] } from the DAD1A CSV
  + source_sharepoint_folder: text | null  -- SharePoint folder path for the .rslt data
  + manufacturer: text | null           -- e.g., "Cayman", "NxGen", "Chinese Supplier" — who made the standard
  + notes: text | null                  -- free-text notes per curve (method details, observations, etc.)
```

The `manufacturer` field tracks which vendor supplied the reference standard used to build the curve. This is important because different manufacturers may have different purity levels, salt forms, or formulations that affect the calibration.

### 4. Existing curves: backfill Sample ID

- Add a field on the CalibrationCurve edit UI to enter/link a Sample ID
- If a Sample ID is provided, the system can locate the chromatogram data in SharePoint (same scan logic used in Process HPLC)
- Fetch and store the chromatogram on save

### 5. Process HPLC flyout: chromatogram overlay

When processing a production sample:
- Load the active calibration curve for the peptide (or per-component for blends)
- If the curve has `chromatogram_data`, render it as a background trace
- Overlay the sample's chromatogram (already fetched from `chrom_files` in HplcScanMatch)
- The tech sees both traces — standard (lighter/dashed) vs sample (solid) — and can visually confirm peaks align
- This replaces the manual PDF comparison workflow

## Data Flow

```
Cayman Standard arrives
  → New Analysis (mark as Standard, select peptide)
  → Wizard: stock prep, dilution (same physical process)
  → Process HPLC: parse peaks, run analysis
  → On completion: auto-create CalibrationCurve with chromatogram_data + reference_rt
  → Curve attached to peptide, ready for production samples

Production sample arrives
  → New Analysis (normal flow)
  → Process HPLC
  → Flyout loads curve for peptide → has chromatogram_data
  → Overlay standard chromatogram vs sample chromatogram
  → Tech visually confirms identity, proceeds
```

## SharePoint folder pattern

Standard result sets follow the naming pattern:
```
P-{NNNN}_Std_{CapColor}_{Vendor}_{YYYYMMDD}_{PeptideName}.rslt
```
Example: `P-0136_Std_GreenCap_Cayman_20260313_Thymulin.rslt`

Contains:
- `*_PeakData.csv` — peak areas, RTs (already parsed by our system)
- `*dx_dad1a*.csv` — chromatogram trace data (DAD signal vs time)

## Files likely affected

- `backend/models.py` — CalibrationCurve model: add source_sample_id, chromatogram_data, source_sharepoint_folder
- `backend/main.py` — CalibrationCurve endpoints: accept/return new fields; auto-create from standard
- `backend/mk1_db.py` or migration — sample_preps table: add is_standard column
- `src/lib/api.ts` — CalibrationCurve type, SamplePrep type updates
- `src/components/hplc/wizard/steps/Step1SampleInfo.tsx` — Standard toggle
- `src/components/hplc/SamplePrepHplcFlyout.tsx` — Chromatogram overlay display
- `src/components/hplc/SamplePreps.tsx` — Standard badge/filter
- New component: ChromatogramOverlay (renders two traces on a shared time axis)
