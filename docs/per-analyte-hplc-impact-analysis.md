# Impact Analysis: Per-Analyte Prep Data on Process HPLC

## Context

We changed the New Analysis wizard to collect Declared Weight, Target Concentration, and Target Total Volume **per analyte** instead of per vial. This document analyzes the downstream impact on the "Process HPLC" pipeline.

---

## Result: No Direct Impact — No Changes Needed

The HPLC processing pipeline does **not consume** declared_weight_mg, target_conc_ug_ml, or target_total_vol_ul from the prep data. It re-derives everything from raw balance weights + calibration curves + peak data. Nothing breaks.

### What HPLC processing uses:
- 5 raw balance weights (from `vial_data[N]`) → dilution factor — **unchanged**
- Calibration curve (slope, intercept, reference_rt) → per-component for blends — **unchanged**
- Peak data from CSV → areas, retention times — **unchanged**

### What it does NOT use:
- declared_weight_mg, target_conc_ug_ml, target_total_vol_ul, stock_conc_ug_ml, actual_conc_ug_ml

The new `analyte_data[]` field on `vial_data` entries is additive — available for future use but not consumed by the current HPLC flow.

---

## Domain Context: RT Identity Checks and Method Differences

### Current state
- Blend-specific HPLC methods (e.g., GLOW) differ from single-analyte calibration methods
- For GHK-containing blends, the lab splits into 2 vials: one for GHK-Cu, one for remaining analytes
- The tech currently does visual RT comparison using Agilent PDF chromatograms (standard vs sample)
- Our system does absolute RT matching: `|avg_rt - reference_rt| <= rt_tolerance`

### Known limitation
When the blend method differs from the calibration standard method, organic % differences cause RT shifts. The absolute RT identity check may fail even though the analyte is correct. This is a real analytical chemistry constraint, not a bug.

### Future consideration: Relative Retention Time (RRT)
For multi-analyte vials, RRT (ratio of one analyte's RT to another in the same run) is more robust across method changes. Example: `RRT(BPC/TB) = 10.146 / 6.943 = 1.461` — stable regardless of method. For single-analyte vials (like GHK alone), RRT doesn't apply.

**Decision**: No action now. The tech's visual PDF check is the safety net. RRT is a future enhancement if/when the visual check becomes a bottleneck.
