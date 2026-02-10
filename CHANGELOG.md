# Changelog

## [0.5.0] - 2026-02-09

### Added

- **HPLC Analysis Pipeline** - Full purity, quantity, and identity analysis from Agilent HPLC output files
  - PeakData CSV parser supporting both plain PeakData and Report CSV formats
  - Purity calculation: averaged main peak Area% across injections (excluding solvent front)
  - Quantity calculation: calibration curve regression, dilution factor from 5 balance weights, final mass in mg
  - Identity check: retention time comparison against reference RT within configurable tolerance
  - Full calculation trace with step-by-step audit trail

- **Peptide Configuration** - Manage peptides and calibration curves
  - CRUD for peptides (name, abbreviation, reference RT, RT tolerance, diluent density)
  - Calibration curve management with linear regression (slope, intercept, R-squared)
  - Upload calibration from Excel or enter manually
  - Calibration scatter chart with regression line (recharts)
  - Seed script to bulk-import peptides and calibration data from lab Excel workbooks

- **New Analysis Workflow** - Multi-step guided analysis flow
  - Drag-and-drop folder support with recursive file scanning and progress bar
  - Auto-detection of sample ID from folder/file names (P-XXXX pattern)
  - Auto-extraction of balance weights from lab Excel workbooks
  - Auto-selection of peptide based on which peptide folder the sample was found in
  - Chromatogram visualization with LTTB downsampling (~30k points to 1.5k) and multi-trace overlay
  - Peak data tables with main peak highlighting and solvent front de-emphasis
  - Live-calculated dilution factor and stock volume from weight inputs
  - Result cards for Purity (%), Quantity (mg), and Identity (CONFORMS/DOES NOT CONFORM)

- **Calculation Visuals** - Interactive charts in the calculation trace
  - Purity bar chart with average reference line and RSD
  - Quantity scatter plot showing sample on calibration curve with step-by-step formula
  - Identity RT band visual with tolerance zone and sample marker
  - Dilution breakdown table with vial masses and volumes

- **Analysis History** - Browse and search past analyses
  - Searchable table with sample ID, peptide, purity, quantity, identity, date
  - Detail view reusing the full results display

- **Chromatogram Chart** - DAD1A signal visualization
  - Parses Agilent `.dx_DAD1A.CSV` chromatogram files client-side
  - LTTB (Largest Triangle Three Buckets) downsampling preserves peak shapes
  - Multiple injection traces overlaid with distinct colors
  - Optional peak RT reference lines
  - Displayed in both parse preview (Step 1) and final results (Step 3)

### Changed

- Sidebar navigation updated with HPLC Analysis section and sub-items
- `api.ts` extended with ~15 new types and ~10 new API functions
- UI store updated with `hplc-analysis` section and subsection routing

## [0.4.1] - 2026-02-08

- Chromatograph viewer improvements
- Sidebar navigation migration to shadcn

## [0.4.0] - 2026-02-07

- AccuMark Tools section
- API key and server selector in settings
- Chromatograph visualizer tool
