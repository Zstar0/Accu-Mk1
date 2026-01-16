---
phase: 02-data-pipeline
plan: 02-04
subsystem: calculations
tags: [python, fastapi, typescript, formulas, engine]
dependencies:
  requires: [02-02]
  provides: [calculation-engine, calculation-api, formula-framework]
  affects: [03-review-ui]
tech-stack:
  added: []
  patterns: [formula-registry, calculation-engine]
key-files:
  created:
    - backend/calculations/__init__.py
    - backend/calculations/engine.py
    - backend/calculations/formulas.py
  modified:
    - backend/main.py
    - src/lib/api.ts
decisions:
  - CalculationResult dataclass in formulas.py (single source of truth)
  - Formula registry pattern for type-based lookup
  - calculate_all runs applicable calculations based on settings
metrics:
  duration: ~4 min
  completed: 2026-01-16
---

# Phase 2 Plan 4: Calculation Engine Summary

**One-liner:** Formula-based calculation engine with accumulation/RF/DF formulas, REST API endpoints, and TypeScript client

## What Was Built

### Task 1: Calculation Framework
- Created `backend/calculations/` module with engine and formula base classes
- Implemented `CalculationEngine` class that orchestrates formula execution
- Defined `Formula` abstract base class with `execute()` and `validate()` methods
- Created `CalculationResult` dataclass for structured output with warnings/errors
- Added formula registry for type-based formula lookup

### Task 2: Core Formulas Implementation
- **AccumulationFormula**: Sums peak areas with optional RT window filtering
  - Handles missing/invalid values gracefully with warnings
  - Returns total_area, peak_count, and window_summary
- **ResponseFactorFormula**: Converts areas to concentrations (area / RF)
  - Validates RF is positive and non-zero
  - Can calculate from rows if total_area not provided
- **DilutionFactorFormula**: Adjusts concentrations (conc * DF)
  - Validates DF is positive
  - Accepts concentration from multiple input keys

### Task 3: Calculation API Endpoints
- `GET /calculations/types` - List available calculation types
- `POST /calculate/{sample_id}` - Run all calculations for a sample
  - Stores results in Result table
  - Creates audit log entries
  - Updates sample status to "calculated"
- `POST /calculate/preview` - Test calculations without saving
- `GET /samples/{sample_id}/results` - Get stored calculation results

### Task 4: TypeScript Client
- Added typed interfaces: `CalculationResult`, `CalculationSummary`, `StoredResult`
- Added API functions: `calculateSample()`, `getCalculationTypes()`, `previewCalculation()`, `getSampleResults()`

## Commits

| Hash | Description |
|------|-------------|
| 58ce9ef | feat(02-04): create calculation framework |
| 010bb97 | feat(02-04): add calculation API endpoints |
| b8f2544 | feat(02-04): add calculation TypeScript client |

## Verification

```bash
# Python module loads
python -c "from calculations import CalculationEngine; print(CalculationEngine.get_available_types())"
# Output: ['accumulation', 'response_factor', 'dilution_factor']

# Main module loads with new endpoints
python -c "from main import app; print('OK')"

# TypeScript compiles
npx tsc --noEmit src/lib/api.ts
```

## Deviations from Plan

None - plan executed exactly as written.

## Technical Decisions

1. **Single CalculationResult definition**: Defined in `formulas.py`, imported by `engine.py` to avoid duplication
2. **Formula registry pattern**: Dict mapping type strings to formula classes for extensibility
3. **calculate_all logic**: Accumulation always runs; RF and DF only run if their settings exist
4. **Validation-first execution**: Formulas validate inputs before executing, returning structured errors

## Next Phase Readiness

Phase 3 (Review UI) can now:
- Call `calculateSample()` to trigger calculations
- Display results using `getSampleResults()`
- Show calculation types via `getCalculationTypes()`

No blockers identified.
