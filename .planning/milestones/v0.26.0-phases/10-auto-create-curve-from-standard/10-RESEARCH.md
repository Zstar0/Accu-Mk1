# Phase 10: Auto-Create Curve from Standard - Research

**Researched:** 2026-03-16
**Domain:** HPLC calibration curve auto-creation from standard sample prep completion
**Confidence:** HIGH

## Summary

This phase automates calibration curve creation when HPLC processing completes on a standard sample prep. The system already has all the building blocks: `CalibrationCurve` model with full field set, `calculate_calibration_curve()` pure-Python linear regression, the `SamplePrepHplcFlyout` HPLC processing flow, and the `is_standard` flag on both `WizardSession` and `sample_preps`. The gap is: (1) the wizard only supports 1 stock + 1 dilution per vial (standards need 1 stock + N dilutions at different concentrations), and (2) there is no post-HPLC-completion hook that creates a CalibrationCurve from standard results.

The multi-dilution wizard is the hardest part. The current `buildWizardSteps()` generates steps based on `vialCount` (1 stock + 1 dilution per vial). For standards, the pattern is fundamentally different: 1 shared stock prep, then N independent dilution steps (one per concentration level). Each dilution produces a physical vial that gets injected on the HPLC, yielding a peak area at a known concentration. Together, all (concentration, area) pairs feed into `calculate_calibration_curve()`.

**Primary recommendation:** Extend `buildWizardSteps()` with a `standard` mode that generates `[SampleInfo, StockPrep, Dil@1000, Dil@500, Dil@250, Dil@100, Dil@10, Dil@1]`. After HPLC processing of all dilution vials, collect (concentration, area, RT) triples and call the existing `create_calibration` endpoint (or a new dedicated endpoint) to auto-create the curve.

## Standard Stack

No new libraries required. This phase uses existing infrastructure:

### Core (already in codebase)
| Library/Module | Purpose | Why Standard |
|----------------|---------|--------------|
| `calculations/calibration.py` | `calculate_calibration_curve()` - pure Python linear regression | Already computes slope, intercept, r_squared from conc/area pairs |
| `wizard-store.ts` | `buildWizardSteps()` - dynamic step generation | Already handles multi-vial step generation |
| `SamplePrepHplcFlyout.tsx` | HPLC processing flow with auto-run analysis | Already loads calibrations, runs analysis, displays results |
| `mk1_db.py` | `sample_preps` table CRUD | Already stores is_standard, manufacturer, standard_notes |
| `models.py` | `CalibrationCurve` model | Already has all needed fields including chromatogram_data, source_sample_id, vendor, notes |

### No New Dependencies
All computation is pure Python (no numpy/scipy needed). The existing `calculate_calibration_curve()` handles least-squares regression perfectly.

## Architecture Patterns

### Pattern 1: Multi-Dilution Wizard Steps for Standards

**What:** When `is_standard=true`, the wizard generates a different step sequence: 1 stock prep shared across all dilutions, then N dilution steps (one per concentration level).

**Current step builder:**
```typescript
// Current: per-vial pairs [SampleInfo, Stock1, Dil1, Stock2, Dil2, ...]
export function buildWizardSteps(vialCount: number): WizardStep[]
```

**Standard step builder (new):**
```typescript
// Standard mode: [SampleInfo, Stock, Dil@C1, Dil@C2, ..., Dil@CN]
// All dilutions share the SAME stock prep (vial 1)
// Each dilution has its own vial_number for measurement tracking
export type StepType = 'sample-info' | 'stock-prep' | 'dilution' | 'standard-dilution'

export function buildStandardWizardSteps(concentrations: number[]): WizardStep[] {
  const steps: WizardStep[] = [
    { id: 1, type: 'sample-info', label: 'Sample Info', vialNumber: 1 },
    { id: 2, type: 'stock-prep', label: 'Stock Prep', vialNumber: 1 },
  ]
  let id = 3
  concentrations.forEach((conc, i) => {
    steps.push({
      id: id++,
      type: 'standard-dilution',
      label: `Dilution — ${conc} ug/mL`,
      vialNumber: i + 1, // Each dilution is a separate physical vial
    })
  })
  return steps
}
```

**Key architectural decision:** Standard dilution steps share the stock measurements from vial 1 but each has its own dilution vial measurements. The `vial_number` on `WizardMeasurement` tracks which dilution vial the measurement belongs to.

### Pattern 2: Standard WizardSession Data Model

**What:** Store per-dilution target concentrations in `vial_params` JSON.

**Current vial_params format (blends):**
```json
{"1": {"declared_weight_mg": 5, "target_conc_ug_ml": 500, "target_total_vol_ul": 1000},
 "2": {"declared_weight_mg": 5, "target_conc_ug_ml": 500, "target_total_vol_ul": 1000}}
```

**Standard vial_params format:**
```json
{"1": {"target_conc_ug_ml": 1000, "target_total_vol_ul": 1000},
 "2": {"target_conc_ug_ml": 500, "target_total_vol_ul": 1000},
 "3": {"target_conc_ug_ml": 250, "target_total_vol_ul": 1000},
 "4": {"target_conc_ug_ml": 100, "target_total_vol_ul": 1000},
 "5": {"target_conc_ug_ml": 10, "target_total_vol_ul": 1000},
 "6": {"target_conc_ug_ml": 1, "target_total_vol_ul": 1000}}
```

Each dilution vial has its own target concentration. The stock prep step's concentration (`declared_weight_mg` dissolved in stock volume) is the starting point; serial dilutions produce each target concentration.

### Pattern 3: HPLC Scan Matching for Standards

**What:** The existing `scan-hplc` SSE endpoint scans SharePoint for folders matching `senaite_sample_id`. For standards, the folder will contain multiple `.dx` subfolders (one per concentration/injection).

**Current scan matching (from `scan_sample_preps_hplc`):**
```python
# Matches PeakData CSVs and DAD1A chromatogram CSVs
peak_files = [c for c in all_csvs if "_PeakData" in c["name"] and c["name"].endswith(".csv")]
chrom_files = [c for c in all_csvs if c["name"].lower().endswith(".csv") and "dx_dad1a" in c["name"].lower()]
```

**Standard naming convention:** Files like `P-0136_Std_1.dx`, `P-0136_Std_10.dx`, `P-0136_Std_100.dx` etc. Each `.dx` folder contains PeakData CSVs and DAD1A CSVs. The concentration is encoded in the filename (the number after `_Std_`).

**The existing `_build_curve_from_peakdata_csvs()` function already does exactly this:**
```python
def _build_curve_from_peakdata_csvs(files: list[tuple[str, bytes, str]]) -> dict | None:
    # Takes (concentration_str, file_bytes, filename) tuples
    # Returns {concentrations: [], areas: [], rts: []}
```

This can be reused directly for auto-curve creation from standard HPLC data.

### Pattern 4: Auto-Curve Creation Trigger

**What:** After HPLC processing completes on a standard sample prep, automatically create a CalibrationCurve.

**Trigger point:** The `SamplePrepHplcFlyout` already auto-runs analysis when peak data + calibration are loaded. For standards, after analysis completes for ALL dilution vials:

1. Collect (concentration, peak_area, retention_time) from each dilution's analysis
2. Call `calculate_calibration_curve(concentrations, areas)` to get slope/intercept/r_squared
3. POST to `/peptides/{id}/calibrations` with the data
4. Populate provenance fields: `source_sample_id`, `vendor`, `notes`, `chromatogram_data`

**Backend approach — new endpoint or extend existing:**
```python
# Option A: New dedicated endpoint
@app.post("/peptides/{peptide_id}/calibrations/from-standard")
async def create_calibration_from_standard(
    peptide_id: int,
    data: StandardCalibrationInput,  # sample_prep_id, concentration_area_pairs, chromatogram_data
):
    # 1. Validate standard sample prep exists and is_standard=True
    # 2. calculate_calibration_curve(concentrations, areas)
    # 3. Create CalibrationCurve with full provenance
    # 4. Deactivate existing curves, set new as active

# Option B: Extend existing create_calibration endpoint
# Add optional source_sample_id, chromatogram_data, etc. to CalibrationDataInput
```

**Recommendation:** Option A (new endpoint) for cleaner separation. The existing `create_calibration` endpoint handles manual entry; standard auto-creation has different validation and provenance requirements.

### Pattern 5: Calculations for Serial Dilutions

**What:** Computing required volumes for serial dilutions from a stock solution.

**Standard serial dilution formula:**
```
C1 * V1 = C2 * V2

Where:
  C1 = stock concentration (ug/mL) — from declared_weight_mg / stock_volume_mL * 1000
  V1 = volume of stock to pipette (uL) — what we solve for
  C2 = target dilution concentration (ug/mL) — user-specified per level
  V2 = total dilution volume (uL) — user-specified per level

V1 = (C2 * V2) / C1  — volume of stock (or previous dilution) to add
Diluent volume = V2 - V1
```

This is simpler than the existing dilution factor calculation because standards are prepared gravimetrically at known concentrations, not measured post-hoc.

### Recommended Project Structure (changes only)

```
backend/
  main.py                     # + New endpoint: POST /peptides/{id}/calibrations/from-standard
  calculations/
    calibration.py             # No changes needed — already works
  mk1_db.py                   # + Standard dilution data in vial_data JSON

src/
  store/
    wizard-store.ts            # + buildStandardWizardSteps(), standard step state logic
  components/
    wizard/
      StandardDilutionStep.tsx  # NEW: Dilution step for standard concentration levels
    hplc/
      SamplePrepHplcFlyout.tsx  # + Auto-curve creation after standard HPLC processing
      StandardCurveResults.tsx  # NEW: Display auto-created curve (conc vs area plot, regression)
```

### Anti-Patterns to Avoid
- **Separate wizard for standards:** Don't create a completely separate wizard. Extend the existing one with a `standard` mode. The `is_standard` flag already exists on `WizardSession`.
- **Computing regression on frontend:** Keep `calculate_calibration_curve()` in Python backend. The frontend only collects and displays; the backend computes and stores.
- **Per-injection separate analysis runs for standards:** Don't run the full `process_hplc_analysis` pipeline (purity/quantity/identity) for each standard injection. Standards only need peak area extraction per injection, not the full analysis. Use a lighter extraction path.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Linear regression | Custom matrix math | `calculate_calibration_curve()` in `calculations/calibration.py` | Already tested, handles edge cases (identical x, None filtering) |
| PeakData CSV parsing | Custom CSV parser for standards | `_parse_peakdata_csv()` and `_build_curve_from_peakdata_csvs()` in `main.py` | Already extracts area, RT, handles formatting |
| Chromatogram parsing | Custom DAD1A parser | `parseChromatogramCsv()` in `ChromatogramChart.tsx` | Already handles DAD1A CSV format |
| Dynamic wizard steps | Hardcoded step arrays | `buildWizardSteps()` pattern in `wizard-store.ts` | Already proven for multi-vial blends |

**Key insight:** Nearly all computational pieces exist. The phase is primarily about orchestrating existing components in a new sequence (standard workflow) and adding the auto-creation trigger.

## Common Pitfalls

### Pitfall 1: Shared Stock, Independent Dilutions
**What goes wrong:** Treating standard dilutions like blend vials where each has independent stock prep. Standards have ONE stock solution shared by ALL dilutions.
**Why it happens:** The existing multi-vial pattern (`buildWizardSteps`) creates stock+dilution pairs per vial.
**How to avoid:** Standard mode must generate 1 stock step + N dilution steps. All dilution steps reference the same stock measurements (vial_number=1 for stock measurements).
**Warning signs:** If each dilution step asks for stock vial weights, the architecture is wrong.

### Pitfall 2: Concentration Extraction from Filenames
**What goes wrong:** Failing to parse concentration from HPLC file names (`P-0136_Std_1.dx`, `P-0136_Std_10.dx`).
**Why it happens:** Filename patterns may vary (underscore vs space, "Std" vs "Standard", numeric precision).
**How to avoid:** Use a robust regex like `_Std_(\d+(?:\.\d+)?)` and also allow the wizard to store the expected concentrations per dilution vial, so matching is concentration-to-file rather than purely filename parsing.
**Warning signs:** Concentrations assigned to wrong files (1 vs 10 vs 100 confusion from prefix matching).

### Pitfall 3: Calibration Curve Without Enough Points
**What goes wrong:** Creating a curve with < 3 data points (existing `_build_curve_from_peakdata_csvs` requires >= 3).
**Why it happens:** Some injections may fail or have no detectable peak.
**How to avoid:** Validate minimum point count before creating curve. Display which dilutions were skipped and why.
**Warning signs:** `calculate_calibration_curve()` raises `ValueError` for < 2 points.

### Pitfall 4: Wizard Session Calculations Scope
**What goes wrong:** The existing `_compute_session_calcs()` in `main.py` (line ~6250) expects specific calculation flow: stock_conc -> required volumes -> actual volumes -> results. Standards don't follow this flow.
**Why it happens:** Standards don't have a single "dilution factor" — each dilution has its own known concentration.
**How to avoid:** For standard sessions, skip the normal calculation pipeline. Each dilution step simply records: "I made a vial at X ug/mL". The real computation happens after HPLC when we have (conc, area) pairs.
**Warning signs:** Trying to compute `actual_conc_ug_ml` per dilution using the normal DF formula.

### Pitfall 5: Multiple vial_data Rows vs Single sample_prep Row
**What goes wrong:** Standards produce N dilution vials but currently sample_preps stores one row per wizard session.
**Why it happens:** The existing `vial_data` JSON array handles multi-vial blends — each entry has its own measurements.
**How to avoid:** Extend `vial_data` to store per-dilution data for standards: `[{vial_number: 1, target_conc_ug_ml: 1000, dil_vial_empty_mg: ..., dil_vial_final_mg: ...}, ...]`. The stock prep measurements go in the main columns (they're shared).
**Warning signs:** Trying to create separate sample_prep rows per dilution.

## Code Examples

### Existing: Linear Regression (Backend)
```python
# Source: backend/calculations/calibration.py
def calculate_calibration_curve(concentrations: list[float], areas: list[float]) -> dict:
    # Returns: {"slope": float, "intercept": float, "r_squared": float, "n_points": int}
```

### Existing: Create Calibration Endpoint (Backend)
```python
# Source: backend/main.py:2344
@app.post("/peptides/{peptide_id}/calibrations", response_model=CalibrationCurveResponse, status_code=201)
async def create_calibration(peptide_id: int, data: CalibrationDataInput, ...):
    # CalibrationDataInput: concentrations, areas, rts, source_filename, analyte_id, instrument, notes
    regression = calculate_calibration_curve(data.concentrations, data.areas)
    curve = CalibrationCurve(
        peptide_id=peptide_id,
        slope=regression["slope"],
        intercept=regression["intercept"],
        r_squared=regression["r_squared"],
        standard_data={"concentrations": data.concentrations, "areas": data.areas, "rts": data.rts},
        ...
    )
```

### Existing: Build Curve from PeakData CSVs (Backend)
```python
# Source: backend/main.py:3179
def _build_curve_from_peakdata_csvs(files: list[tuple[str, bytes, str]]) -> dict | None:
    # files = [(concentration_str, file_bytes, filename), ...]
    # Returns: {"concentrations": [], "areas": [], "rts": []}
```

### Existing: Wizard Step Builder (Frontend)
```typescript
// Source: src/store/wizard-store.ts:25
export function buildWizardSteps(vialCount: number): WizardStep[] {
  const steps: WizardStep[] = [
    { id: 1, type: 'sample-info', label: 'Sample Info', vialNumber: 1 },
  ]
  let id = 2
  for (let v = 1; v <= vialCount; v++) {
    const suffix = vialCount > 1 ? ` — Vial ${v}` : ''
    steps.push({ id: id++, type: 'stock-prep', label: `Stock Prep${suffix}`, vialNumber: v })
    steps.push({ id: id++, type: 'dilution', label: `Dilution${suffix}`, vialNumber: v })
  }
  return steps
}
```

### Existing: CalibrationCurve Model Fields (Backend)
```python
# Source: backend/models.py:293-348
class CalibrationCurve(Base):
    # Core regression
    slope, intercept, r_squared: Float
    standard_data: JSON  # {concentrations: [], areas: [], rts: []}
    reference_rt: Float  # Average RT from standard

    # Provenance (already exist from Phase 09)
    source_sample_id: String(100)           # e.g. "P-0111"
    source_sharepoint_folder: String(1000)  # SharePoint folder path
    chromatogram_data: JSON                 # {times: [], signals: []}
    vendor: String(100)                     # Maps from manufacturer
    notes: Text                             # Maps from standard_notes

    # Wizard fields (already exist)
    standard_weight_mg, stock_concentration_ug_ml, diluent, column_type,
    wavelength_nm, flow_rate_ml_min, injection_volume_ul, operator: various types
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Manual calibration curve entry on Peptides page | Auto-creation from standard HPLC data | Phase 10 (this phase) | Eliminates manual transcription errors, ensures full provenance |
| Single stock + single dilution wizard | Multi-dilution wizard for standards | Phase 10 (this phase) | Supports N concentration levels in one session |
| Separate calibration import from SharePoint | In-app standard prep -> HPLC -> curve creation | Phase 10 (this phase) | Full traceability from sample prep to calibration |

## Open Questions

1. **Default concentration levels**
   - What we know: User mentioned 6 levels (1000, 500, 250, 100, 10, 1 ug/mL) as typical
   - What's unclear: Should these be configurable per session or is this a fixed set? Are they always serial dilutions from stock, or could some be parallel dilutions?
   - Recommendation: Default to 6 levels but let the user add/remove levels in Step 1 (Sample Info). Store as `vial_params` JSON.

2. **HPLC file-to-concentration mapping**
   - What we know: Standard HPLC files likely named with concentration info (e.g. `_Std_100.dx`)
   - What's unclear: Exact naming convention for the lab's standards. Could also be numbered injections with a run sequence.
   - Recommendation: Support both auto-detection from filenames AND manual mapping in the HPLC flyout. Let the user confirm/correct assignments before curve creation.

3. **Multiple injections per concentration level**
   - What we know: Normal samples have duplicate injections averaged together
   - What's unclear: Do standards also have duplicate injections per concentration? If so, average areas per concentration before regression.
   - Recommendation: Support it. Group injections by concentration, average areas within each group.

4. **When exactly does auto-creation trigger?**
   - What we know: `SamplePrepHplcFlyout` auto-runs analysis when data loads
   - What's unclear: Should curve creation be automatic (no confirmation) or require a "Create Curve" button click?
   - Recommendation: Show the computed curve (slope, intercept, r-squared, scatter plot) and require a "Create Calibration Curve" button click. Auto-creation without review would be risky for lab work.

5. **Standard dilution step measurements**
   - What we know: Normal dilutions record 3 weights (empty, +diluent, +stock aliquot)
   - What's unclear: Do standard dilutions follow the same 3-weight pattern? Or are they simpler (just record the target concentration and total volume)?
   - Recommendation: Keep the 3-weight gravimetric measurement pattern for traceability, but also display the target concentration prominently.

## Sources

### Primary (HIGH confidence)
- `backend/models.py` lines 293-348 - CalibrationCurve model with all fields
- `backend/calculations/calibration.py` - Full linear regression implementation
- `backend/main.py` lines 2344-2419 - create_calibration endpoint
- `backend/main.py` lines 3179-3216 - _build_curve_from_peakdata_csvs helper
- `backend/main.py` lines 6969-7086 - scan-hplc SSE endpoint
- `src/store/wizard-store.ts` - Full wizard step builder and state machine
- `src/components/hplc/SamplePrepHplcFlyout.tsx` - HPLC processing flow
- `backend/mk1_db.py` - sample_preps table DDL with is_standard, manufacturer, standard_notes
- `src/lib/api.ts` lines 2574-2608 - SamplePrep TypeScript interface

### Secondary (MEDIUM confidence)
- Phase 09 context about serial dilution workflow (user-confirmed design)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All components exist in codebase, verified by reading source
- Architecture: HIGH - Patterns directly extend existing wizard/HPLC infrastructure
- Pitfalls: HIGH - Derived from actual code analysis of calculation flows and data models
- Open questions: MEDIUM - Some depend on lab workflow details not in code

**Research date:** 2026-03-16
**Valid until:** 2026-04-16 (stable — internal codebase, no external dependency changes)
