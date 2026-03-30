# Changelog

## v0.27.4 — 2026-03-30

### Sample Analysis Management

- **Manage Analyses panel**: New inline panel on Sample Details page lets lab staff add or remove analysis services from a sample before work begins
- **Add service**: Searchable picker lists all 87 active Senaite analysis services; already-attached services are filtered out
- **Remove service**: Trash button on each unassigned/registered analysis removes it via ZMI; locked analyses (verified, published) cannot be removed
- **Guard**: Button only appears on samples in `sample_received`, `sample_due`, or `sample_registered` state
- **Bug fix**: Removal correctly targets the Zope object id (e.g. `ID_AOD9604-1`) rather than the keyword, preventing silent failures when retracted analyses left behind a renamed duplicate

### Integration Service

- New `list_analysis_services`, `add_analysis_to_sample`, `remove_analysis_from_sample` methods on the Senaite adapter
- New `GET /analysis-services`, `POST /samples/{id}/analyses`, `DELETE /samples/{id}/analyses/{keyword}` endpoints in `desktop.py`

## v0.27.3 — 2026-03-27

### Sample Prep Workflow

- **Manual HPLC Complete**: Status no longer auto-set after analysis — user clicks "Mark HPLC Complete" button on the SENAITE results page
- **Curve Created status**: Standard preps auto-set to `curve_created` when calibration curve is created
- **Completed preps filter**: Sample Preps list hides `hplc_complete`, `completed`, and `curve_created` preps

### History Page

- **Production/Standards tabs**: Split completed preps into separate tabs
- **Flyout integration**: Clicking a history prep opens the same Process HPLC flyout
- **History mode**: Flyout loads chromatograms and peak data from stored analysis records instead of re-downloading from SharePoint
- **Removed legacy tabs**: HPLC Import and Sample Prep Wizard tabs removed
- **Removed Import Analysis**: Sidebar nav item removed

### Fixes

- **Standard file warnings**: `P-0136_Std_100_PeakData.csv` no longer triggers "wrong file in folder" warnings

---

## v0.27.2 — 2026-03-27

### Order Status — Kanban Enhancements

- **"Services" toggle**: Expand kanban cards to show individual analysis service names per column state
- **Analyte name rewriting**: "Analyte 1 (Purity)" displays as "BPC-157 (Purity)" using the same logic as Sample Details
- **Waiting Addon services**: Shows outstanding (incomplete) analyses — Endotoxin, Sterility, etc.
- **Tech display on cards**: Shows assigned analyst(s) on each kanban card (e.g. "Tech: Forrest")
- **Retracted analyses excluded**: No longer counted as "Pending" in state counts and progress bars
- **Published column**: Skips service expansion (not useful for completed items)

---

## v0.27.1 — 2026-03-27

### Order Status Page Improvements

- **New filter states**: Sample Due, Ready for Review, Published, Waiting Addon, Received — covers the full SENAITE sample lifecycle
- **Tooltips on filter buttons**: Hover to see what each state means in the SENAITE workflow
- **Count badges on filters**: Each filter button shows how many samples match that state
- **Progress column**: Replaced "Samples 0/7" with a progress bar showing verified analyses out of total
- **Left border state indicator**: Color-coded left border on each row shows the order's earliest (most behind) sample state
- **Dimmed completed orders**: Rows where all samples are verified/published fade to 45% opacity
- **Time since received**: Sample cards show color-coded processing time (white <24h, amber 24-48h, red >48h) with hover text explaining the goal
- **Sample Details page**: Same color-coded time-since-received display in the header
- **Kanban cards**: Same time and hover text on kanban board sample items

---

## v0.27.0 — 2026-03-27

### User Tracking & Audit Trail

- **Sample Preps**: Record `created_by` and `updated_by` (user ID + email) on every create/update
- **HPLC Analysis**: Record `processed_by` on every analysis run
- **Peptides**: Record `created_by` and `updated_by` on create/update
- **Calibration Curves**: Record `created_by` and `updated_by` on create/update/activate
- **Backfill**: Older records without `created_by` are automatically backfilled on first edit

### Instrument Selection

- Instrument selector now available for **all** sample preps (previously standard-only)
- Wizard resolves `instrument_id` → `instrument_name` on session create and update
- HPLC analysis calls now pass the sample prep's instrument ID to the analysis record
- Methods panel in wizard filters to the selected instrument

### UI Enhancements

- **Wizard info panel**: Shows lab tech (logged-in user) and instrument throughout all wizard steps
- **HPLC flyout**: Shows lab tech and instrument context at the top of the Process HPLC sheet
- **Sample Preps list**: Added "Created By" column
- **Calibration Curves**: Shows "Created By" and "Last Edited By" in curve detail view

### Fixes

- Fixed stale SENAITE result persisting when opening a different sample prep in the wizard
- Fixed `_cal_to_response` not including user tracking fields in list views

---

## v0.26.1 — 2026-03-20

### HPLC Audit Trail & Debug Persistence

- **Debug log persisted to DB** — `debug_log` JSON column on `hplc_analyses` captures the full processing context (sample prep, parse results, calibration selection, warnings) for every analysis run
- **Source file archival** — raw CSV contents + SHA256 checksums stored in `raw_data` for audit proof and offline reproduction
- **Debug panel warnings** — visible amber warnings for missing standard injections, unmatched analytes, missing chromatograms, missing vial data, identity fallbacks, and SharePoint errors
- **Warnings banner on flyout** — critical issues surfaced prominently above analysis results with action links
- **Add Alias modal** — unmatched analyte warnings have an "Add as alias" button that opens a modal with peptide dropdown to save the alias immediately
- **SharePoint folder links** — missing data warnings link directly to the SharePoint .rslt folder for investigation
- **`sha256Hex` utility** — browser-native Web Crypto SHA256 for file checksums (no dependencies)

### SENAITE Results Summary

- **Results summary card** — SENAITE submission page shows per-analyte purity, quantity, and identity at a glance before submitting
- **Blend purity calculation** — mass-weighted average of component purities: `Σ(qty × purity) / Σ(qty)`
- **Blend identity** — all analytes must conform for blend to conform
- **Peptide Total Quantity** — sum of all analyte quantities

### HPLC File Aliases

- **Aliases tab on peptide flyout** — new "File Aliases" tab alongside Instruments for managing alternate HPLC filename labels per peptide
- **Add/remove alias tags** — type an alias, press Enter, changes save immediately to DB
- **Live alias enrichment** — flyout loads current aliases from live peptide records, not stale `components_json` snapshots
- **`hplc_aliases` on PeptideUpdate** — backend accepts alias updates via PUT endpoint

### Fixes

- **Standard prep file detection** — `_is_standard_injection()` now distinguishes standard injection refs (`_Inj_1_std_BPC157_`) from standard prep concentration files (`_Std_1000_`) by checking if the part after `_std_` is numeric
- **DB reload tab stability** — saved results labels persist during background SharePoint load instead of flickering to filename labels
- **DB reload latest run only** — filters to most recent `run_group_id` instead of showing all historical runs as duplicate tabs
- **DB reload active analyte** — `setActiveAnalyte` called on DB load so blend tabs are interactive immediately
- **Warnings gated on fresh runs** — parse-dependent warnings (unmatched analytes, missing std injections) only show during fresh analysis, not when loading saved results from DB
- **Per-vial weight routing** — blend analysis uses correct vial weights from `vial_data` per component
- **SharePoint search LIMS-first** — `search_sample_folder` checks LIMS CSV folder before Peptides/Raw Data tree
- **Blend chromatogram filtering** — alias-aware trace matching for filenames like `_BPC_TB17-23.dx_DAD1A.CSV`
- **Chromatogram auto-fetch multi-concentration** — backfill stores all DAD1A files keyed by concentration, not just the first one

---

## v0.26.0 — 2026-03-19

### Standard Sample Preps & Calibration Curves

- **Standard sample prep toggle** — wizard Step 1 has a "Standard Sample" switch that reveals manufacturer, instrument, and concentration level fields; standard preps flow through the same wizard steps as production
- **Standard badge + filter** — sample preps list shows a visible "Standard" badge; filter dropdown supports standard vs production
- **Auto-create calibration curve from standard** — Process HPLC on a standard prep shows a curve preview with chart, data table, and regression; "Create Calibration Curve" button generates a fully-linked curve with provenance
- **Standard chromatogram on curves** — calibration curve expanded view shows the standard's chromatogram with per-concentration tabs (1, 10, 100, 250, 500, 1000 µg/mL) and an "All" overlay option

### HPLC Results Persistence

- **Full provenance on analysis results** — `hplc_analyses` now stores `calibration_curve_id`, `sample_prep_id`, `instrument_id`, `source_sharepoint_folder`, `chromatogram_data`, and `run_group_id`
- **Blend run grouping** — per-analyte analysis rows from the same Process HPLC session share a `run_group_id` UUID
- **DB-first flyout reload** — reopening Process HPLC loads saved results instantly from DB, then loads SharePoint data in the background for chromatogram + peak table detail
- **Re-run Analysis** — banner with button to clear saved results and re-scan SharePoint for a fresh analysis
- **`hplc_complete` status** — sample prep status auto-updates after successful analysis; teal badge in list

### Calibration Curve Backfill

- **Source Sample ID + Vendor fields** — edit form on calibration curves includes Source Sample ID and Vendor inputs
- **SharePoint chromatogram auto-fetch** — when a Source Sample ID is saved, backend auto-fetches DAD1A chromatogram files from SharePoint (LIMS CSV folder) and stores them on the curve
- **Multi-concentration storage** — chromatogram data stored keyed by concentration level for per-level viewing

### Chromatogram Overlay

- **Standard trace overlay** — Process HPLC flyout renders the active calibration curve's standard chromatogram as a dashed, semi-transparent reference trace behind the sample's solid trace
- **Per-trace styling** — `ChromatogramTrace` supports optional `style` field (dashed, opacity) for visual distinction
- **`extractStandardTrace` helper** — handles both old single-trace and new multi-concentration chromatogram formats; picks highest concentration for best visual reference

### Same-Method Identity Check

- **Standard injection detection** — parser detects `_std_` PeakData files in .rslt folders and extracts main peak RT per analyte
- **Same-method RT comparison** — identity check uses standard injection RT (same HPLC method) when available, falling back to calibration curve reference_rt
- **Reference source display** — identity card shows "Ref: Standard injection (P-0111)" or "Ref: Calibration curve" so techs know which reference was used
- **Alias-aware analyte matching** — `hplc_aliases` field on peptides enables matching chromatogram filename labels (e.g., "TB17-23") to peptide records (e.g., "TB500 (17-23 FRAGMENT)")

### Instrument FK Relationships

- **Proper `instrument_id` FK** on `CalibrationCurve`, `WizardSession`, and `hplc_analyses` — replaces raw string instrument fields
- **Dynamic instrument dropdowns** — CalibrationPanel edit form, wizard Step 1, and PeptideConfig flyout all load instruments from DB instead of hardcoded values
- **Backfill migration** — existing curves and sessions auto-populated with `instrument_id` from name matching at startup

### Fixes

- **Sample prep duplication** — wizard `setCurrentStep(0)` fixed to `setCurrentStep(1)`; `POST /sample-preps` is now idempotent (checks `wizard_session_id` before creating)
- **Calibration curve filter mismatch** — `CalibrationPanel` filter changed from exact string match to ID-based comparison; default `flyoutInstrument` changed from hardcoded `'1290'` to `'all'`
- **Per-vial weights in blend analysis** — flyout routes each blend component to the correct vial's dilution measurements from `vial_data`
- **DB reload race condition** — `dbCheckActiveRef` (synchronous ref) prevents SharePoint scan from firing before DB check completes
- **Blend chromatogram filtering** — alias-aware trace filtering matches filenames like `_BPC_TB17-23.dx_DAD1A.CSV` to the correct analyte tabs
- **SharePoint search** — `search_sample_folder` now checks LIMS CSV folder first (where HPLC machines dump raw data), then falls back to Peptides/Raw Data tree

### Backend

- Schema migrations for `instrument_id` on calibration_curves, wizard_sessions, hplc_analyses
- `GET /hplc/analyses/by-sample-prep/{id}` endpoint for flyout reload
- `_analysis_to_response()` helper eliminates response construction duplication
- PATCH calibration endpoint accepts `source_sample_id`, `vendor`; auto-fetches chromatogram from SharePoint
- Standard injection parser with `StandardInjection` dataclass and `StandardInjectionResponse` API model
- Identity calculation tracks `reference_source`, `reference_source_id`, `calibration_curve_rt` in trace

---

## v0.25.0 — 2026-03-12

### Multi-Vial Blend Prep Support

- **Multi-vial sample prep wizard** — blend peptides with `prep_vial_count > 1` generate per-vial Stock Prep and Dilution steps in the wizard
- **Per-vial target parameters** — each vial has its own declared weight, target concentration, and target volume stored in `vial_params` JSONB
- **Per-vial measurements** — stock prep and dilution measurements tracked per vial number
- **Per-vial calculations** — backend computes stock_conc, required_volumes, and actual_conc independently per vial via `vial_calculations`
- **Peptide config — Prep Vials section** — configure vial count and assign blend components to vials from the Peptide Config page
- **Wizard info panel** — new left-hand panel (30% width) showing SENAITE sample data, context-aware vial details, and method cards with all fields (instrument, SENAITE ID, size peptide, starting organic %, MCT temp, dissolution, notes)
- **Context-aware vial details** — info panel switches between "Vial 1 Details" / "Vial 2 Details" based on active wizard step, showing assigned analytes and per-vial targets
- **Blend method priority** — direct methods on the blend peptide take priority; component-level method matching is fallback only
- **Smarter SENAITE auto-detection** — multi-analyte SENAITE lookups search for an exact blend match before falling back to single peptide selection
- **Per-analyte declared quantities** — SENAITE card shows declared_quantity next to each analyte
- **Horizontal step navigation** — wizard steps moved from left sidebar to horizontal top bar for better use of screen space

### Fixes

- **Next Step button** — fixed permanent disable caused by chained display states in `deriveStepStates`; now checks session data directly for step prerequisites
- **Methods missing when editing** — `selectedPeptide` now set in the store when returning to Step 1 with an existing session
- **Editable session summary** — multi-vial sessions show per-vial declared weights and editable per-vial target fields when navigating back to Step 1

### Backend

- Added `prep_vial_count` column on peptides, `vial_number` on blend_components and wizard_measurements
- Added `vial_params` JSONB on wizard sessions, `vial_data` JSONB on sample preps
- Peptide update endpoint accepts `prep_vial_count` and component vial assignments
- Wizard session endpoints accept and return `vial_params` and `vial_calculations`
- `updateWizardSession` accepts `vial_params` for per-vial target edits

---

## v0.24.0 — 2026-03-08

### Order Status — Kanban Board View

- **Kanban view** — new view toggle (Table / Kanban) persisted to localStorage; Kanban shows four columns: Pending, Assigned, To Verify, Verified
- **Sample cards duplicate across columns** — a sample with both pending and to-verify analyses appears in both columns, each card showing the count for that specific state (e.g. "17 to verify")
- **Group by Order mode** — swimlane per order with header showing order ID, email, and processing time; samples distributed into columns within each swimlane
- **Flat mode** — columns of sample cards with order reference on each card
- **Card clarity improvements** — count shown as a labeled pill ("17 to verify") with column-color background; sample SENAITE state shown as "LIMS: Received" to distinguish from analysis state
- **Kanban sort** — when in Group by Order mode, sort by Order ID or Outstanding time (oldest first by default); click active sort to toggle direction
- **Analysis state filter hidden in Kanban** — switching to Kanban clears and hides the filter strip since columns already show all states
- **Order number links to Order Explorer** — clicking an order number in a Kanban card navigates to Order Explorer and auto-opens the flyout for that order

### Order Explorer

- **Hide test orders persisted** — checkbox state saved to localStorage

---

## v0.23.0 — 2026-03-08

### Order Status — Analysis State Filters & Persistent Filter State

- **Analysis state filter strip** — new button row above the Status Matrix: **Active** (clear all) | **Pending** | **Assigned** | **To Verify** | **Verified**; single-select, filters the Sample Details column within each order
- **Sample-level filtering** — when a filter is active, only sample cards matching that analysis state are shown within each order row; orders with no matching samples are hidden entirely
- **Text filters** — Order ID, Email, and Sample ID text inputs for quick lookup
- **Persistent filter state** — all filter settings (active state, text inputs, Hide Test Orders checkbox) are saved to `localStorage` and restored on next visit

---

## v0.22.0 — 2026-03-08

### Analysis Table — Identity (HPLC) Result Handling

- **Conforms/Does Not Conform display** — `Identity (HPLC)` analyses now render human-readable labels ("Conforms" / "Does Not Conform") instead of raw SENAITE values in both the active row and history rows
- **Identity dropdown in edit mode** — editing an `Identity (HPLC)` cell shows a dedicated two-option dropdown ("Conforms" / "Does Not Conform") instead of the generic result options selector; the conforming value is resolved from the analyte name map by slot number

### Senaite Lookup Caching

- **Sample details always fetches fresh** — `lookupSenaiteSample` now defaults to `no_cache=true`, bypassing the 15-min server-side cache for all callers except Order Status
- **Order Status page opts into cache** — `enqueueSenaiteLookup` explicitly passes `noCache=false` to avoid hammering Zope when polling many samples
- **Backend `no_cache` param** — `/wizard/senaite/lookup` accepts `?no_cache=true/false`; default is `true` (fresh fetch)

---

## v0.21.0 — 2026-03-06

### Blend Peptides

- **Blend peptide data model** — `is_blend` flag on peptides, `blend_components` junction table (many-to-many), component peptides linked with display order
- **Auto-derived analytes** — creating/editing a blend auto-generates analyte slots from each component peptide's primary analyte; manual analyte selection hidden for blends
- **Blend creation form** — "This is a blend" toggle in PeptideForm; multi-select component picker; shows auto-linked analyte info
- **Sidebar indicators** — blend peptides show a "Blend" badge in the peptide list

### Blend HPLC Processing

- **Per-component calibration curves** — HPLC flyout loads calibration curves for each component peptide independently
- **Label-to-component fuzzy matching** — parsed HPLC filename labels (BPC, GHK, TB500(17-23)) are matched to DB component abbreviations (BPC-157, GHK-CU, TB500 (17-23 FRAGMENT)) via 3-tier matching: exact → prefix → first-word prefix
- **Per-analyte analysis** — each component runs against its own calibration curve; analyte tabs show per-component results
- **Per-analyte chromatograms** — chromatogram traces filtered by active analyte label; blanks excluded

### Sample Prep Wizard — Blend Support

- **Blend info card in Step 1** — when a blend peptide is selected, shows component badges and blend indicator
- **Component calibration validation** — wizard session creation checks component peptides for active calibration curves (blends don't have their own)
- **Blend metadata on sample preps** — `is_blend` and `components_json` columns stored on sample_preps for downstream HPLC processing

### Debug Console

- **Terminal overlay in HPLC flyout** — terminal icon in the header opens a dark terminal-style overlay (matching ScanConsole aesthetic) with full diagnostic readout
- **Per-analyte diagnostics** — shows SharePoint files, parsed injections with peak-level detail (RT, area, area%, height, main peak markers), calibration curve info, weights, analysis results, and calculation trace
- **Color-coded output** — errors in red, warnings in amber, success in emerald; error messages in calculation trace auto-detected and highlighted
- **Keyboard dismiss** — Escape key or X button closes the overlay

### Bug Fixes

- **Solvent front false positive** — peak parser no longer marks the only peak as solvent front; fixes early-eluting peptides (e.g., GHK-Cu at RT 1.2) returning null purity/quantity
- **Wizard session creation for blends** — fixed "No active calibration curve found" error by checking component peptides instead of the blend itself

---

## v0.20.0 — 2026-03-05

### Per-User Senaite Authentication

- **Senaite credentials on Profile page** — users can store their Senaite password so write operations (field updates, result submissions, workflow transitions, COA publishing) are attributed to their own Senaite account instead of the admin user
- **Encrypted storage** — Senaite passwords are encrypted at rest using Fernet symmetric encryption keyed off `JWT_SECRET`; each environment has its own encryption key
- **Validate-before-save** — the backend authenticates against Senaite before storing credentials; wrong passwords are rejected immediately
- **Admin fallback** — if a user has no stored credentials (or decryption fails), write operations transparently fall back to the admin Senaite account
- **8 write operations updated** — `generate_sample_coa`, `publish_sample_coa`, `upload_senaite_attachment`, `update_senaite_sample_fields`, `set_analysis_result`, `set_analysis_method_instrument`, `transition_analysis`, `receive_senaite_sample`
- **Lightweight migration system** — `database.py` now runs `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` on startup before `create_all()`, solving the SQLAlchemy limitation where `create_all()` doesn't add columns to existing tables

### Profile Page

- **New Account → Profile page** — replaces the standalone Change Password page; consolidates user-specific settings in one place
- **Change Password section** — same functionality as before, now in a card layout
- **Senaite Integration section** — password input with verify/save flow, "Credentials configured" status with Remove/Update buttons

### Navigation Restructure

- **Analysis section** — renamed from "SENAITE"; now includes Samples, Receive Sample, and Event Log
- **LIMS section** (new) — Instruments, Methods, Peptides, and Analysis Services moved here from HPLC Analysis for better logical grouping
- **HPLC Automation** — renamed from "HPLC Analysis"; now focused on workflow: Overview, New Analysis, Import Analysis, History, Sample Preps

### Calibration Improvements

- **Import via SharePoint folder browser** — new "Browse Folder" mode in the peptide resync dialog; navigate SharePoint directories to pick a folder containing calibration CSVs
- **Manual entry mode** — enter calibration data points (concentration, area, RT) directly without a file
- **Notes field on calibration curves** — editable notes in the calibration edit form; displayed in the read-only view

### Blend Sample Prep Support

- **Per-analyte analysis in HPLC flyout** — blend peptides (e.g., "KPV + BPC-157") show analyte tabs; each analyte runs against its own calibration curve
- **Aggregated Senaite auto-fill** — `SenaiteResultsView` merges results from all analyte runs; per-analyte matches (e.g., "KPV Purity") are prioritized over generic matches ("Peptide Purity")

### Order Explorer

- **Slideout detail panel** — order details now open in a full-height sidebar panel with backdrop blur instead of an inline expansion
- **Order Status page** — new page for tracking order fulfillment status

### Backend

- **Senaite concurrency limiter** — frontend caps in-flight Senaite requests to 3 concurrent to avoid overwhelming the server
- **CalibrationDataInput** expanded — now accepts `rts`, `analyte_id`, `instrument`, and `notes` fields
- **`senaite_configured` flag** on user responses — frontend knows whether a user has stored Senaite credentials

---

## v0.19.0 — 2026-03-05

### HPLC Flyout Redesign

- **Single-page scrollable layout** — replaced multi-step wizard with a two-column flyout (1360px wide); left column shows results + data, right column shows sticky Calculation Trace
- **Auto-run analysis** — analysis runs automatically when data file + calibration are loaded; removed manual "Run Analysis" button
- **Consolidated chromatogram** — single chromatogram with peak table directly below; removed duplicate chart
- **`hideTrace` prop on AnalysisResults** — calculation trace can be hidden from the results card when rendered externally in the right column

### Senaite Results Submission

- **New `SenaiteResultsView` component** — second view in the HPLC flyout for submitting computed results to Senaite LIMS
- **"Submit Results" button** — navigates from analysis view to Senaite submission step
- **Sample ID selector** — load any Senaite sample by ID (needed for testing where local dev samples differ from SharePoint data files)
- **Auto-fill from HPLC** — matches computed purity, quantity, and identity values to Senaite analysis rows by title keyword; supports generic ("Peptide Purity (HPLC)", "Peptide Total Quantity") and per-analyte ("KPV Purity", "BPC-157 - Identity (HPLC)") naming conventions
- **One-click fill** — "Fill N results" button writes all matched values to Senaite via `setAnalysisResult` API with optimistic local updates and toast feedback

### Peptide & Calibration Management

- Enhanced `PeptideConfig` and `PeptideForm` with instrument tabs and expanded configuration options
- Improved `CalibrationPanel` with additional calibration curve management features
- Updated `MethodPanel` and `MethodsPage` with refined method management UI

### Backend

- Expanded HPLC backend endpoints and models
- Added SharePoint integration helpers

### Other

- New `CreateAnalysis` and `AnalysisServicesPage` components
- `DataPipelinePane` additions in preferences
- Sidebar and store updates for new navigation flows
- Wizard step improvements

---

## v0.18.0 — 2026-03-03

### Added

- **HPLC Scan on Sample Preps page** — new "Scan HPLC" button scans the `Analytical/LIMS CSVs and Endotoxin` SharePoint folder for peak data CSV files matching sample prep IDs; shows real-time progress in a console-style overlay that stays open until manually closed
  - Matching folders display a green "Process HPLC" button on the prep row
  - `GET /sample-preps/scan-hplc` SSE endpoint streams log lines, progress, and match events to the frontend
- **HPLC Flyout (`SamplePrepHplcFlyout`)** — opens when "Process HPLC" is clicked; three-step flow:
  - **Step 1 — Preview**: downloads peak + chromatogram CSVs from SharePoint, shows purity banner, chromatogram chart (above peak table), and full peak data table
  - **Step 2 — Configure**: displays sample prep weights (pre-filled from saved wizard measurements) and calibration curve selection
  - **Step 3 — Results**: runs analysis, shows full `AnalysisResults` with calculation trace
- **Self-healing chromatogram discovery** — flyout now detects `dx_DAD1A` chromatogram files even from stale scan results by browsing the SharePoint folder by item ID on the fly (`GET /sharepoint/folder-by-id/{id}/chrom-files`); no re-scan required
- **HPLC Methods** — new `HplcMethod` model and full CRUD API (`GET/POST/PATCH/DELETE /hplc/methods`); methods now link to an `Instrument` FK; peptides use a many-to-many `peptide_methods` junction table
- **Instruments** — `Instrument` model synced from SENAITE; new `Instruments` page in sidebar with `GET /instruments` and `POST /instruments/sync` endpoints; `InstrumentBrief` embedded in method responses
- **Calculation Trace reordering** — in analysis results, cards now stack vertically: Dilution & Stock Prep → Sample on Calibration Curve → Purity per Injection → Identity

### Fixed

- **New Analysis wizard step 2 "Next" button** — was permanently disabled because `canAdvance()` required `stock_conc_ug_ml` to be non-null (backend calculation dependent on all Step 1 fields being set); now unlocks as soon as both stock vial measurements are recorded regardless of calculation availability
- **New Analysis wizard step 3 "Next" button** — same fix applied: unlocks when all three dilution measurements are recorded
- **Sample prep weights showing "—" in flyout** — `list_sample_preps` SQL query was only selecting a subset of columns and omitting all five vial weight fields; expanded to `SELECT *` equivalent
- **Chromatogram file detection** — backend scan used `".dx_" in name` (literal period) which never matched actual filenames like `P-0248_Inj_1.dx_DAD1A.CSV`; fixed to `"dx_dad1a" in name.lower()` matching the same pattern used by the Import Analysis page
- **SENAITE analyte name fuzzy-matched to wrong peptide** — `_fuzzy_match_peptide` used a simple substring match; "Semaglutide" matched "Cagrilinitide + Semaglutide" because the blend name contains the substring; fixed with a 3-pass priority matcher: (1) exact normalized match, (2) substring against non-blend names only (skipping `+`), (3) abbreviation match
- **Diagnostic endpoint** — added `GET /wizard/senaite/raw-fields/{sample_id}` to expose raw SENAITE API field values for debugging analyte name mismatches

---

## v0.17.0 — 2026-03-03

### Added

- **Sample Preps** — new section in HPLC Analysis for saving and managing HPLC sample preparation records
  - Accessible from the left sidebar ("Sample Preps" under HPLC Analysis) and the HPLC Overview card
  - Sample prep records are persisted to the Integration-Services PostgreSQL database in a new `sample_preps` table
  - Sample IDs follow the `SP-YYYYMMDD-NNNN` format consistent with the rest of the integration DB
  - All wizard data is captured flat: declared weight, target params, all balance readings, and all derived concentrations/volumes
  - **Inline status selector** on each row — change status without opening the record; auto-saves to backend on change
  - Four statuses: 🔵 Awaiting HPLC · 🟢 Completed · 🟡 On Hold · 🟣 Review
  - **Click any row** to be taken back into the HPLC wizard at Step 3 (Dilution) pre-loaded with that session's data for review or re-weighing
  - Search bar filters by sample ID, SENAITE ID, or peptide
  - "New Prep" button navigates directly to the wizard
  - New Postgres-backed CRUD helpers in `integration_db.py`: `ensure_sample_preps_table`, `create_sample_prep`, `list_sample_preps`, `get_sample_prep`, `update_sample_prep`
  - New API endpoints: `POST /sample-preps`, `GET /sample-preps`, `GET /sample-preps/{id}`, `PATCH /sample-preps/{id}`
- **HPLC Wizard refinements**
  - Step 1 renamed to **"Peptide Vial Weight"**; declared weight input relabelled to "Sample Vial + cap + peptide (mg)"
  - Step 2 "Add Diluent" description updated to "Add 2000mL (enough to dissolve). Diluent volume will be calculated after vial weights are recorded."
  - Step 3.1 (first Dilution sub-step) renamed to **"Empty Autosample Vial + cap Weight"** with updated description and input label
  - Steps 4 (Results) and 5 (Summary) hidden from the wizard sidebar — visible step count is now 1–3
  - Final step's "Next Step" button replaced with **"Save Sample Prep"** — calls `POST /sample-preps` and navigates to the Sample Preps list on success, with spinner and error handling

### Infrastructure

- `ensure_sample_preps_table()` auto-migrates the new table on first API call — no migration script required

---

## v0.16.2 — 2026-03-02

### Added

- **Per-column search on SENAITE Samples** — replaced the general search bar with inline "Search…" inputs under Sample ID, Order #, and Verification Code column headers
- **Postgres-backed search for Order # and Verification Code** — SENAITE has no catalog indexes for these fields, so searches query the integration service's PostgreSQL database (ILIKE) for matching sample IDs, then fetch full sample data from SENAITE via `getId`; this scales to thousands of samples without bulk loading
- **`search_field` parameter on `/senaite/samples`** — backend accepts `search_field=verification_code` or `search_field=order_number` to route searches through Postgres; default (no field) uses SENAITE's `getId` catalog for sample ID lookup
- **`search_sample_ids_by_verification_code()`** and **`search_sample_ids_by_order_number()`** in `integration_db.py` — ILIKE queries against `ingestions`, `coa_generations`, and `order_submissions` tables

### Fixed

- **Order # search finds WP-prefixed numbers** — searches both `order_submissions.order_number` (bare "3066") and `ingestions.order_ref` (prefixed "WP-3066") so either format works

---

## v0.16.1 — 2026-03-02

### Fixed

- **SENAITE sample search finds all samples** — searching for older sample IDs like P-0177 now works; previously, search fetched the 500 most recent samples and filtered client-side, so anything older was invisible
- **Search moved to server-side** — search queries are now sent to the backend API instead of filtering a local cache; the backend uses SENAITE's `getId` catalog index for exact sample ID matches and a broad fetch with server-side filtering for order numbers, client names, and verification codes
- **SENAITE catalog quirks documented** — `SearchableText` tokenizes on hyphens (useless for sample IDs), `getClientOrderNumber` index returns all samples regardless of value, `getId` wildcards are not supported; only exact `getId` match is reliable

---

## v0.16.0 — 2026-02-26

### Added

- **Editable Method & Instrument in Analyses table** — pencil-to-edit UI on each analysis row for Method and Instrument fields; dropdowns are populated per-analysis from SENAITE's AnalysisService configuration so only the allowed options for that analysis type are shown
- **`POST /wizard/senaite/analyses/{uid}/method-instrument`** backend endpoint — saves Method and Instrument selections directly to SENAITE
- **WooCommerce order flyout on Sample Details** — "View Order Details" button opens an inline panel with the linked WooCommerce order (customer, line items, status, order notes) without leaving the page
- **SENAITE Samples search bar** — filters the samples list in real time by sample ID, client, or verification code
- **Samples pagination** — next/previous page controls with "X–Y of Z" count when results exceed one page
- **Hide test samples toggle** — checkbox on the Samples dashboard to suppress the internal test client from the list

### Changed

- **Samples default sort** changed from Date Received to Date Created (descending)

### Fixed

- **nginx upload limit** raised to 50 MB (`client_max_body_size 50M`) to support HPLC CSV and chromatogram uploads
- **Docker local WP routing** — added `accumarklabs.local` host alias to backend container so DevKinsta-hosted WooCommerce is reachable inside Docker
- **WordPress URL** corrected in `.env.docker` to local dev domain

---

## v0.15.0 — 2026-02-24

### Added

- **SENAITE promoted to top-level navigation** — SENAITE is now its own section in the sidebar (previously nested under Dashboard) with "Samples" and "Event Log" sub-items
- **Event Log page** — new table showing all sample workflow status transitions (receive, submit, verify, publish, retract, cancel, reinstate) fetched from the integration service's `sample_status_events` table
  - Color-coded transition badges and status badges per row
  - WP notification status (check/X icon) and WP status text columns
  - Clickable Sample ID links navigate directly to Sample Details
  - Sample ID filter with search input in card header and per-row filter icon toggle
  - Refresh button, loading spinner, empty states, and filtered-results empty state
- **`GET /explorer/sample-events`** backend proxy — forwards to integration service for cross-order event retrieval
- **`getAllSampleEvents()` API function** — frontend fetch wrapper for the new endpoint
- **Shared SENAITE utilities** — extracted `StateBadge`, `STATE_LABELS`, and `formatDate` into `senaite-utils.tsx` for reuse across SenaiteDashboard and SampleEventLog

### Changed

- **SENAITE components reorganized** — moved `SenaiteDashboard.tsx`, `SampleDetails.tsx`, and `EditableField.tsx` from `components/dashboard/` to `components/senaite/` for better cohesion
- **Navigation types updated** — `ActiveSection` now includes `'senaite'`; new `SenaiteSubSection` type; `navigateToSample()` routes to `senaite/sample-details` instead of `dashboard/sample-details`
- **Hash navigation** — `'senaite'` added to `VALID_SECTIONS`; deep links work at `#senaite/samples`, `#senaite/event-log`, and `#senaite/sample-details?id=XX`

## v0.14.0 — 2026-02-24

### Added

- **Inline editing for Sample Details** — click any editable field value to edit it in-place with save/cancel controls
  - New `EditableField` and `EditableDataRow` components with optimistic updates, loading spinners, and toast notifications
  - Editable fields: Order #, Client Sample ID, Client Lot, Date Sampled, Declared Qty, analyte peptide names, analyte declared quantities, and all COA branding fields (company name, website, email, address, verification code, logo URL, chromatograph BG URL)
  - Keyboard support: Enter to save, Escape to cancel, focus management on edit mode entry
  - Custom `onSave` prop allows reuse with non-SENAITE backends (used for additional COA configs)
- **Additional COAs section** in Sample Details — displays additional branded COA configurations from the Integration Service
  - Collapsible per-COA cards showing company name, status badge, and branding details
  - Inline editing of all additional COA fields (company name, website, email, address, logo URL, chromatograph BG URL)
  - Image thumbnails for logo and chromatograph background alongside text fields
  - `PATCH /explorer/additional-coas/{config_id}` backend proxy for updating additional COA branding
- **SENAITE field update endpoint** — `POST /wizard/senaite/samples/{uid}/update` proxies field writes to SENAITE
  - JSON-first strategy with form-encoded fallback to handle both extension fields and isDecimal-type fields
- **URL left-truncation** — `truncateStart` prop on editable fields shows the filename end of long URLs instead of the domain

### Fixed

- **Extension field saves now persist** — Logo URL and Chromatograph BG URL writes previously returned false success (SENAITE silently ignored form-encoded extension fields). Fixed with JSON-first approach that falls back to form-encoded on 400 errors.

## v0.13.0 — 2026-02-23

### Added

- **Sample Details page redesign** — complete UI overhaul of the SENAITE sample detail view
  - Two-column grid layout: sample info & order details on the left, analytes & COA info on the right
  - Analysis profile theming with color-coded chips (Peptide/violet, Endotoxin/teal, Sterility-PCR/rose)
  - Row-level status tinting in the analyses table (colored left border + subtle background per state)
  - New table columns: Retested indicator and Result Captured date
  - Integrated progress bar showing verified/pending analysis completion percentage
  - Collapsible sections with proper accessibility (`aria-expanded`, `aria-controls`)
  - Remarks rendered as sanitized HTML via DOMPurify (supports links, bold, italic)
- **Deep-linkable sample details** — hash navigation now supports query parameters (`#dashboard/sample-details?id=PB-0056`) for direct links to specific samples
- **Richer SENAITE analysis data** — backend returns `sort_key`, `captured` date, `retested` flag, and resolves selection-type results through SENAITE's ResultOptions mapping

### Fixed

- **SENAITE link follows active environment** — "Open in SENAITE" link now dynamically resolves based on the active API environment profile (local Docker vs production) instead of being fixed at build time
- **Docker env file separation** — `.env.docker` now targets local testing (SENAITE at localhost:8080); production builds use `--build-arg ENV_FILE=.env.docker.prod`
- **Sample ID normalization** — backend uppercases and trims sample IDs before SENAITE lookup

### Infrastructure

- Dockerfile accepts `ENV_FILE` build arg for switching between local and production env files
- docker-compose.yml passes `ENV_FILE` arg (defaults to `.env.docker`)

## v0.12.0 — 2026-02-21

### Added

- **Receive Sample wizard** — new 2-step intake workflow (Samples → Sample Details) for receiving samples from SENAITE
  - Step 1: Browse due samples with sortable table, search, and selection
  - Step 2: Dense single-card layout showing all SENAITE sample details, analytes, and collapsible COA information
  - **Photo capture** with live camera preview, guide overlay, auto-enhance (levels, contrast, white balance), and device selection
  - **Check-In to SENAITE** — uploads sample image, adds operator remarks, and transitions sample to "received" state in one click
  - "Check In Another Sample" button after successful receive to quickly process the next sample
- **`POST /wizard/senaite/receive-sample`** backend endpoint — performs image upload, remarks update, and workflow transition with CSRF handling and post-transition verification
- **SENAITE Dashboard** — embedded SENAITE view accessible from AccuMark Tools sidebar
- **Software Updates** section in Preferences — check for updates, download, and relaunch from within the app
- **Sidebar nav item** for Intake section with Receive Sample entry
- **Hash-based navigation** utility for SENAITE dashboard routing

### Changed

- **Docker Compose** — backend port now exposed directly (`ports` instead of `expose`) for easier local development
- **Tauri window lifecycle** — main window close now exits the full process (prevents hidden quick-pane window from keeping app alive)

### Fixed

- **SENAITE UID lookup** — backend now uses uppercase `UID` query parameter (SENAITE silently ignores lowercase `uid`, returning wrong sample)
- **SENAITE attachment upload** — `Analysis` form field set to `""` instead of literal "Attach to Sample" text (which caused 500 APIError)
- **CSRF token freshness** — always re-fetches CSRF token before workflow transition to prevent stale-token failures
- **Workflow state guard** — skip transition for samples already past `sample_due` state instead of failing

## v0.11.0 — 2026-02-19

## v0.10.0 — 2026-02-13

### Added

- **In Progress tab** in Order Explorer — shows samples awaiting COA publication with sample name, identity, lot code, SENAITE ID, and delivery/COA status
- **COA Explorer** — new standalone view for browsing COA generations across all orders, accessible from the sidebar
- **`sample_results` field** now returned from backend explorer orders endpoint, fixing the always-empty "Sample IDs" column in the orders table
- **`navigateToOrderExplorer()`** store action for cross-section navigation to Order Explorer
- **Integration Service network** added to Docker Compose for backend-to-Integration Service connectivity
- **`INTEGRATION_SERVICE_URL`** env var for proxying explorer requests
- **Per-peptide resync button** in Peptides list — re-imports a single peptide's calibration files from SharePoint without running a full import
- **`GET /hplc/peptides/{id}/resync/stream`** backend SSE endpoint for single-peptide resync

### Changed

- **Reference RT** now always updates from the active curve's retention times when switching curves via Set Active, full import, or single-peptide resync

- **Ingestions tab renamed** to "COAs Published" across all UI text (tab, loading, error, and empty states)
- **Order Explorer subtitle** updated from "Browse orders and ingestions" to "Browse orders and COAs"
- **AccuMark Tools** section refactored to route between Order Explorer and COA Explorer sub-sections

### Fixed

- **Sample IDs column** in orders table now shows SENAITE IDs (was always empty because `sample_results` wasn't queried from the database)
- **Set Active button** in Calibration Panel was silently failing due to wrong auth token localStorage key

## v0.9.0 — 2026-02-11

Calibration accuracy fixes, SharePoint reliability, analysis UX.

## v0.8.0 — 2026-02-05

Dashboard, Peptide Config UI overhaul, SharePoint improvements.

## v0.7.0

Docker deployment + production hosting.

## v0.6.0

JWT user authentication system.

## v0.5.0

HPLC peptide analysis pipeline.
