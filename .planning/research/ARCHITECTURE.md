# Architecture Research: Multi-Instrument Automation Framework

**Domain:** Lab instrument automation — polymorphic result storage, plugin parser/calculator pipeline
**Milestone:** v0.30.0 — Multi-Instrument Architecture
**Researched:** 2026-04-05
**Confidence:** HIGH (all claims verified against actual codebase files)

---

## Executive Summary

The core architectural challenge is extending an HPLC-only pipeline into one that supports multiple instrument types (endotoxin EU/mL, sterility pass/fail, and future types) without rewriting the working HPLC pipeline and without sacrificing query-ability for cross-sample analytics.

The existing codebase already has latent generalization. The `Instrument` model has `instrument_type`. The `AnalysisService` model has `category`. The `Result` model has `calculation_type` and JSON fields for input/output. The `engine.py` has a `FORMULA_REGISTRY` dict. These are all seeds of the plugin pattern — they just need to be elevated into a coherent framework.

**The recommended approach is three coordinated changes:**

1. **Rename `HplcMethod` → `Method`** (or introduce a `Method` supertype) with a `method_type` discriminator and a `config` JSON column for type-specific settings. Keep the existing HPLC-specific columns on a `hplc_method_config` substructure within config, so no data is lost and no migrations break HPLC operation.

2. **Introduce `InstrumentResult`** as the generalized result table, replacing the HPLC-specific `HPLCAnalysis` for new types. Keep `HPLCAnalysis` intact and add a `result_id` FK to it pointing at an `InstrumentResult` row. This avoids migrating 100% of HPLC records on day one while giving all new types a shared schema.

3. **Promote the `FORMULA_REGISTRY` pattern in `engine.py` into a proper plugin registry** with a defined interface: `parse(files) → ParsedData`, `calculate(parsed, context) → ResultData`, `validate(result) → errors`. Each instrument type registers a parser + calculator pair. The ingest endpoint becomes type-agnostic.

---

## Current Architecture Audit

### Existing Models (Verified Against `backend/models.py`)

| Model | Table | HPLC-Specific Columns | Generalization Status |
|-------|-------|-----------------------|-----------------------|
| `Instrument` | `instruments` | `instrument_type` (currently only "HPLC") | Already generic — just needs values populated |
| `HplcMethod` | `hplc_methods` | `size_peptide`, `starting_organic_pct`, `temperature_mct_c`, `dissolution` | Fully HPLC-specific — needs generalization |
| `HPLCAnalysis` | `hplc_analyses` | All columns (5 weights, purity, quantity, identity, dilution) | Fully HPLC-specific — keep but link to new generic table |
| `AnalysisService` | `analysis_services` | `category` field (e.g., "HPLC") | Already generic |
| `Result` | `results` | `calculation_type`, `input_data` JSON, `output_data` JSON | Already generic, underused |

### Existing Pipeline (Verified Against `backend/calculations/`)

```
Current HPLC Pipeline:
  peakdata_csv_parser.py  →  HPLCParseResult (typed dataclass)
        ↓
  hplc_processor.py       →  process_hplc_analysis(AnalysisInput) → dict
  [also: engine.py has FORMULA_REGISTRY — separate older path, underused]
        ↓
  HPLCAnalysis row created in main.py (inline, ~3000-line file)
        ↓
  SENAITE push (httpx POST to integration-service or direct)
```

**Key observation:** `hplc_processor.py` is already pure-function — it takes typed inputs and returns a dict. It has no database access. This is the correct shape for a plugin calculator. The parser (`peakdata_csv_parser.py`) returns typed dataclasses (`HPLCParseResult`). The problem is these typed outputs are HPLC-specific and wired directly into the ingest endpoint logic in `main.py` rather than through an abstraction layer.

### Existing Registry Seed (Verified Against `backend/calculations/engine.py`)

`engine.py` already has:
```python
FORMULA_REGISTRY: dict[str, type[Formula]] = {
    "accumulation": AccumulationFormula,
    "response_factor": ResponseFactorFormula,
    "dilution_factor": DilutionFactorFormula,
    "compound_id": CompoundIdentificationFormula,
    "purity": PurityFormula,
}
```

This registry is the correct pattern. It's not yet connected to the HPLC-specific parser/processor path — the `hplc_processor.py` bypass doesn't go through `engine.py`. The new framework should extend this registry pattern (or introduce a parallel instrument-type registry that references both parsers and calculators).

### M2M Table Hard-Coding Problem

The junction tables reference `hplc_methods` directly:

```python
# instrument_methods table — FK to hplc_methods.id
Column("method_id", Integer, ForeignKey("hplc_methods.id", ondelete="CASCADE"))

# peptide_methods table — FK to hplc_methods.id
Column("method_id", Integer, ForeignKey("hplc_methods.id", ondelete="CASCADE"))
```

Any generalization of `HplcMethod` → `Method` must address these FKs.

---

## Recommended Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  Ingest Layer (instrument-type-agnostic endpoint in main.py)     │
│  POST /ingest/{instrument_type}  OR  POST /ingest/manual         │
├──────────────────────────────────────────────────────────────────┤
│  Plugin Registry                                                  │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐     │
│  │  HPLC Plugin   │  │ Endotoxin Plug │  │ Sterility Plug │     │
│  │  parser: csv   │  │  parser: csv   │  │  parser: none  │     │
│  │  calc: hplc_   │  │  calc: lal_    │  │  calc: pass_   │     │
│  │  processor.py  │  │  processor.py  │  │  fail.py       │     │
│  └────────────────┘  └────────────────┘  └────────────────┘     │
├──────────────────────────────────────────────────────────────────┤
│  Generalized Result Storage                                       │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  InstrumentResult  (instrument_type, analyte_id, values) │    │
│  │  ├── hplc_analyses.result_id → FK to InstrumentResult    │    │
│  │  └── Future types link here directly                      │    │
│  └──────────────────────────────────────────────────────────┘    │
├──────────────────────────────────────────────────────────────────┤
│  Method Layer                                                     │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  Method  (method_type discriminator + config JSON)        │    │
│  │  ├── hplc_methods view / compat shim for existing FKs    │    │
│  │  └── instrument_methods / analyte_methods junction tables │    │
│  └──────────────────────────────────────────────────────────┘    │
├──────────────────────────────────────────────────────────────────┤
│  Existing Models (unchanged)                                      │
│  Instrument, AnalysisService, Peptide, CalibrationCurve,         │
│  WorksheetItem, Worksheet, SamplePriority, User                   │
└──────────────────────────────────────────────────────────────────┘
```

---

## Pattern 1: Method Generalization — Single Table with Discriminator + JSON Config

**What:** Rename `HplcMethod` to `Method`, add `method_type` discriminator column, move HPLC-specific columns into a `config` JSON column. Keep existing HPLC columns as columns (not JSON) during a transition period by using a migration that populates `config` from existing values, then drops the old columns after HPLC is confirmed working through the new path.

**Why not table-per-type (concrete table inheritance):** Breaks the existing M2M junction tables and doubles schema complexity. Every new instrument type requires a new table + new junction tables.

**Why not abstract base + joined-table inheritance:** SQLAlchemy supports this (polymorphic_on + joined tables) but requires JOINs for every method query and adds FK complexity. For 3-5 instrument types with small config differences, JSON config outperforms joined inheritance on simplicity.

**Why not pure JSON config (no typed columns):** Analytics and filtering need typed columns for commonly-queried fields. A hybrid is correct: discriminator column stays typed, HPLC-specific params go into `config` JSON.

**SQLAlchemy pattern (HIGH confidence — matches SQLAlchemy 2.0 mapped_column syntax already used):**

```python
class Method(Base):
    __tablename__ = "methods"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    method_type: Mapped[str] = mapped_column(String(50), nullable=False)  # "hplc", "endotoxin", "sterility"
    senaite_id: Mapped[Optional[str]] = mapped_column(String(200), nullable=True, unique=True)
    config: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    # config shape per type:
    # hplc:       {"size_peptide": "...", "starting_organic_pct": 5.0, "temperature_mct_c": 40.0, "dissolution": "..."}
    # endotoxin:  {"mvd": 10.0, "clsi_threshold": 5.0, "reagent_lot": "..."}
    # sterility:  {"incubation_days": 14, "media_type": "TSB"}
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    instruments: Mapped[list["Instrument"]] = relationship(
        "Instrument", secondary="instrument_methods_v2", back_populates="methods"
    )
```

**Migration strategy for HPLC backwards compatibility:**

1. Create `methods` table with the shape above.
2. Copy all `hplc_methods` rows into `methods` with `method_type="hplc"` and HPLC-specific columns marshalled into `config` JSON.
3. Create new junction tables `instrument_methods_v2` and `analyte_methods` pointing at `methods.id`.
4. Copy existing `instrument_methods` and `peptide_methods` rows into the new tables.
5. Add `legacy_hplc_method_id` FK column on `Method` for cross-reference during transition.
6. Keep `hplc_methods` table intact (read-only, no new writes) until all HPLC code paths are migrated.

This is a two-migration approach: first migration creates and populates new tables, second migration (after HPLC refactor is validated) drops the old tables.

---

## Pattern 2: Generalized Result Storage — InstrumentResult + Type-Specific Extension

**What:** Introduce `InstrumentResult` as the common result record. HPLC gets a FK on `HPLCAnalysis` pointing to its `InstrumentResult` row. New types (endotoxin, sterility) store everything in `InstrumentResult` directly (no separate table).

**Why not one table for everything:** Some type-specific queries benefit from typed columns (HPLC purity_percent is frequently queried for trending). A pure-JSON approach makes those queries `json_extract` which is slower and unindexable in SQLite without generated columns.

**Why not completely separate tables per type:** Cross-type analytics (e.g., "all results for sample P-0142 across all tests") require UNIONs or a dispatch layer. A common base table makes those queries trivial.

**Why keep `HPLCAnalysis` instead of migrating it:** It has 20+ columns, CalibrationCurve FKs, sample_prep_id references, chromatogram_data, debug_log, and is the source of truth for all existing HPLC records. Migrating it in-place is high risk, low benefit during this milestone. Instead, link it forward.

**SQLAlchemy pattern:**

```python
class InstrumentResult(Base):
    """
    Generalized result record for any instrument type.
    HPLCAnalysis links to this via result_id FK.
    New types (endotoxin, sterility) store results here directly.
    """
    __tablename__ = "instrument_results"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    instrument_type: Mapped[str] = mapped_column(String(50), nullable=False)  # "hplc", "endotoxin", "sterility"
    sample_id_label: Mapped[str] = mapped_column(String(200), nullable=False)  # e.g. "P-0142"

    # Foreign keys to context
    instrument_id: Mapped[Optional[int]] = mapped_column(ForeignKey("instruments.id"), nullable=True)
    method_id: Mapped[Optional[int]] = mapped_column(ForeignKey("methods.id"), nullable=True)
    analyte_id: Mapped[Optional[int]] = mapped_column(ForeignKey("peptides.id"), nullable=True)  # Peptide for HPLC; None for endotoxin/sterility if test-level
    analysis_service_id: Mapped[Optional[int]] = mapped_column(ForeignKey("analysis_services.id"), nullable=True)

    # Provenance
    # NOTE: sample_prep_id is plain INTEGER — lives in separate accumark_mk1 DB, no FK possible
    sample_prep_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    ingest_source: Mapped[str] = mapped_column(String(50), nullable=False, default="file")  # "file" | "manual"
    source_filename: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    run_group_id: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)  # Groups multiple results from one ingest

    # Typed result columns — populated based on instrument_type
    # Numeric result (EU/mL for endotoxin, purity % for HPLC summary, etc.)
    result_numeric: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    result_unit: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)  # "EU/mL", "%", "mg"
    # Pass/fail result (sterility, identity check)
    result_pass: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    # Full calculation output with audit trace
    result_data: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)  # All calculated values
    calculation_trace: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)  # Step-by-step trace for audit

    # Raw input captured for re-processing
    raw_input: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    # Workflow
    status: Mapped[str] = mapped_column(String(50), default="pending", nullable=False)  # pending | calculated | approved | rejected
    rejection_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    senaite_pushed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    debug_log: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)

    # User tracking
    created_by_user_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_by_email: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    instrument_obj: Mapped[Optional["Instrument"]] = relationship("Instrument", foreign_keys=[instrument_id])
    method_obj: Mapped[Optional["Method"]] = relationship("Method", foreign_keys=[method_id])
    analyte: Mapped[Optional["Peptide"]] = relationship("Peptide", foreign_keys=[analyte_id])
    analysis_service: Mapped[Optional["AnalysisService"]] = relationship("AnalysisService")
```

**HPLCAnalysis link:**

Add one FK column to the existing `HPLCAnalysis` model:

```python
# Add to HPLCAnalysis:
instrument_result_id: Mapped[Optional[int]] = mapped_column(
    ForeignKey("instrument_results.id", ondelete="SET NULL"), nullable=True
)
```

When HPLC analyses are created through the new framework, an `InstrumentResult` row is written first, then `HPLCAnalysis` is written with `instrument_result_id` set. Old pre-migration HPLC records have `instrument_result_id = NULL` — they're still queryable, just not linked to the new table.

**Cross-sample analytics query pattern (SQLite compatible):**

```python
# All results for a peptide, all instrument types, last 90 days
session.query(InstrumentResult).filter(
    InstrumentResult.analyte_id == peptide_id,
    InstrumentResult.created_at >= ninety_days_ago,
    InstrumentResult.status == "approved"
).order_by(InstrumentResult.created_at.desc()).all()

# Purity trending — HPLC only, indexed on result_numeric
session.query(InstrumentResult).filter(
    InstrumentResult.instrument_type == "hplc",
    InstrumentResult.analyte_id == peptide_id,
    InstrumentResult.result_numeric.isnot(None)
).order_by(InstrumentResult.created_at).all()
```

---

## Pattern 3: Plugin Registry for Parsers and Calculators

**What:** A `INSTRUMENT_REGISTRY` dict in a new `backend/instruments/registry.py` module. Each entry maps an instrument type string to a plugin object that implements two methods: `parse()` and `calculate()`.

**Why not separate parser/calculator registries:** Parser output must match calculator input exactly. Coupling them in a single plugin object enforces that contract. A plugin knows both what it can parse and what it produces.

**Why not class-based with ABC:** Python protocol (structural typing) is lighter and doesn't force inheritance on existing code like `hplc_processor.py`. The existing HPLC processor can be wrapped with a thin shim.

**Recommended module structure:**

```
backend/
├── instruments/
│   ├── __init__.py
│   ├── registry.py         # INSTRUMENT_REGISTRY dict + registration decorator
│   ├── base.py             # InstrumentPlugin Protocol definition
│   ├── hplc/
│   │   ├── __init__.py
│   │   ├── plugin.py       # HplcPlugin — wraps existing parser + processor
│   │   ├── parser.py       # Thin import shim → parsers/peakdata_csv_parser.py
│   │   └── calculator.py   # Thin import shim → calculations/hplc_processor.py
│   ├── endotoxin/
│   │   ├── __init__.py
│   │   ├── plugin.py       # EndotoxinPlugin
│   │   ├── parser.py       # LAL instrument CSV/TXT parser (new)
│   │   └── calculator.py   # EU/mL calculation (new)
│   └── sterility/
│       ├── __init__.py
│       ├── plugin.py       # SterilityPlugin
│       └── calculator.py   # Pass/fail logic (new; no parser — manual entry)
├── parsers/
│   ├── peakdata_csv_parser.py   # Unchanged
│   └── txt_parser.py            # Unchanged
└── calculations/
    ├── hplc_processor.py        # Unchanged
    ├── engine.py                # Unchanged (FORMULA_REGISTRY stays)
    ├── calibration.py           # Unchanged
    ├── formulas.py              # Unchanged
    └── wizard.py                # Unchanged
```

**Protocol definition (`backend/instruments/base.py`):**

```python
from typing import Protocol, runtime_checkable
from dataclasses import dataclass

@dataclass
class ParsedData:
    """Normalized output from any parser. Plugin-specific data goes in 'data' dict."""
    instrument_type: str
    raw_files: list[dict]    # [{filename: str, content: str}]
    data: dict               # Type-specific parsed data
    errors: list[str]
    warnings: list[str]

@dataclass
class CalculatedResult:
    """Normalized output from any calculator."""
    instrument_type: str
    result_numeric: float | None    # Primary numeric result (purity%, EU/mL, etc.)
    result_unit: str | None
    result_pass: bool | None        # For pass/fail types
    result_data: dict               # Full result dict (all calculated values)
    calculation_trace: dict         # Step-by-step trace for audit
    errors: list[str]

@runtime_checkable
class InstrumentPlugin(Protocol):
    instrument_type: str  # class attribute

    def parse(self, files: list[dict]) -> ParsedData:
        """Parse raw instrument files into normalized intermediate form."""
        ...

    def calculate(self, parsed: ParsedData, context: dict) -> CalculatedResult:
        """
        Run calculations on parsed data.
        context: {method_config, calibration, peptide_params, ...}
        """
        ...

    def supports_manual_entry(self) -> bool:
        """True if this type allows manual entry without file upload."""
        ...
```

**Registry (`backend/instruments/registry.py`):**

```python
from instruments.base import InstrumentPlugin

_REGISTRY: dict[str, InstrumentPlugin] = {}

def register(plugin: InstrumentPlugin) -> None:
    _REGISTRY[plugin.instrument_type] = plugin

def get_plugin(instrument_type: str) -> InstrumentPlugin:
    if instrument_type not in _REGISTRY:
        raise ValueError(f"No plugin registered for instrument type: {instrument_type!r}")
    return _REGISTRY[instrument_type]

def registered_types() -> list[str]:
    return list(_REGISTRY.keys())
```

**HPLC plugin shim (wraps existing code with zero changes to existing files):**

```python
# backend/instruments/hplc/plugin.py
from instruments.base import InstrumentPlugin, ParsedData, CalculatedResult
from parsers.peakdata_csv_parser import parse_hplc_files, HPLCParseResult
from calculations.hplc_processor import (
    process_hplc_analysis, AnalysisInput, WeightInputs, CalibrationParams, PeptideParams
)

class HplcPlugin:
    instrument_type = "hplc"

    def parse(self, files: list[dict]) -> ParsedData:
        result: HPLCParseResult = parse_hplc_files(files)
        return ParsedData(
            instrument_type="hplc",
            raw_files=files,
            data={
                "injections": [inj.__dict__ for inj in result.injections],
                "standard_injections": [std.__dict__ for std in result.standard_injections],
            },
            errors=result.errors,
            warnings=result.warnings,
        )

    def calculate(self, parsed: ParsedData, context: dict) -> CalculatedResult:
        # Build typed inputs from context + parsed data (same as current main.py logic)
        weights = WeightInputs(**context["weights"])
        calibration = CalibrationParams(**context["calibration"])
        peptide = PeptideParams(**context["peptide"])
        analysis_input = AnalysisInput(
            injections=parsed.data["injections"],
            weights=weights,
            calibration=calibration,
            peptide=peptide,
        )
        output = process_hplc_analysis(analysis_input)
        return CalculatedResult(
            instrument_type="hplc",
            result_numeric=output.get("purity_percent"),
            result_unit="%",
            result_pass=output.get("identity_conforms"),
            result_data=output,
            calculation_trace=output.get("calculation_trace", {}),
            errors=[],
        )

    def supports_manual_entry(self) -> bool:
        return False
```

**Endotoxin plugin (new, EU/mL calculation):**

```python
# backend/instruments/endotoxin/plugin.py
class EndotoxinPlugin:
    instrument_type = "endotoxin"

    def parse(self, files: list[dict]) -> ParsedData:
        # LAL reader instrument exports CSV with Sample ID, EU/mL value, pass/fail flag
        # Parser TBD based on actual instrument export format
        ...

    def calculate(self, parsed: ParsedData, context: dict) -> CalculatedResult:
        # EU/mL result from instrument is already calculated — validate against MVD
        eu_ml = parsed.data.get("eu_ml_raw")
        mvd = context.get("method_config", {}).get("mvd", 10.0)
        clsi_threshold = context.get("method_config", {}).get("clsi_threshold", 5.0)
        conforms = eu_ml is not None and eu_ml <= clsi_threshold
        return CalculatedResult(
            instrument_type="endotoxin",
            result_numeric=eu_ml,
            result_unit="EU/mL",
            result_pass=conforms,
            result_data={"eu_ml": eu_ml, "mvd": mvd, "clsi_threshold": clsi_threshold},
            calculation_trace={"raw_eu_ml": eu_ml, "threshold_check": f"{eu_ml} <= {clsi_threshold}"},
            errors=[],
        )

    def supports_manual_entry(self) -> bool:
        return True  # Manual EU/mL entry allowed alongside file import
```

**Sterility plugin (pass/fail, manual entry only):**

```python
class SterilityPlugin:
    instrument_type = "sterility"

    def parse(self, files: list[dict]) -> ParsedData:
        # Sterility has no file import — manual entry only
        return ParsedData(instrument_type="sterility", raw_files=[], data={}, errors=[], warnings=[])

    def calculate(self, parsed: ParsedData, context: dict) -> CalculatedResult:
        # context must contain {"pass_fail": True/False, "observation": "No growth observed"}
        result_pass = context.get("pass_fail")
        observation = context.get("observation", "")
        return CalculatedResult(
            instrument_type="sterility",
            result_numeric=None,
            result_unit=None,
            result_pass=result_pass,
            result_data={"pass_fail": result_pass, "observation": observation},
            calculation_trace={"manual_entry": True, "observation": observation},
            errors=[] if result_pass is not None else ["pass_fail must be provided"],
        )

    def supports_manual_entry(self) -> bool:
        return True
```

---

## Data Flow: Generalized Ingest Pipeline

### File Import Flow (HPLC, Endotoxin)

```
POST /ingest/{instrument_type}
  body: {files: [{filename, content}], method_id, context: {...}}
      ↓
  plugin = get_plugin(instrument_type)
      ↓
  parsed = plugin.parse(files)                          # ParsedData
  if parsed.errors: return 422
      ↓
  result = plugin.calculate(parsed, context)            # CalculatedResult
      ↓
  Write InstrumentResult row
    (instrument_type, sample_id_label, method_id, result_numeric,
     result_unit, result_pass, result_data, calculation_trace, raw_input)
      ↓
  [HPLC only] Write HPLCAnalysis row with instrument_result_id FK
      ↓
  Return InstrumentResult.id + summary to frontend
```

### Manual Entry Flow (Endotoxin, Sterility)

```
POST /ingest/manual
  body: {instrument_type, method_id, manual_data: {...}}
      ↓
  plugin = get_plugin(instrument_type)
  if not plugin.supports_manual_entry(): return 422
      ↓
  parsed = ParsedData(instrument_type, raw_files=[], data=manual_data, ...)
  result = plugin.calculate(parsed, context)
      ↓
  Write InstrumentResult row (ingest_source="manual")
      ↓
  Return InstrumentResult.id + summary to frontend
```

### SENAITE Push Flow (Unchanged Pattern)

```
POST /results/{instrument_result_id}/push-senaite
      ↓
  Load InstrumentResult
  Load AnalysisService for this result's analysis_service_id
      ↓
  httpx POST to integration-service or direct SENAITE:
    keyword = analysis_service.keyword
    result_value = instrument_result.result_numeric or str(instrument_result.result_pass)
      ↓
  Update InstrumentResult.senaite_pushed_at
```

---

## Component Boundaries

### New vs. Modified vs. Unchanged

| Component | Status | Change |
|-----------|--------|--------|
| `backend/instruments/registry.py` | NEW | Plugin registry dict + get_plugin() |
| `backend/instruments/base.py` | NEW | Protocol definitions |
| `backend/instruments/hplc/plugin.py` | NEW | Thin shim wrapping existing parser + processor |
| `backend/instruments/endotoxin/plugin.py` | NEW | EU/mL plugin |
| `backend/instruments/sterility/plugin.py` | NEW | Pass/fail plugin |
| `backend/models.py` — `Method` | NEW (rename+extend) | Replaces `HplcMethod`; add `method_type`, `config` JSON |
| `backend/models.py` — `InstrumentResult` | NEW | Generic result table |
| `backend/models.py` — `HPLCAnalysis` | MODIFIED (additive) | Add `instrument_result_id` FK only |
| `backend/models.py` — `Instrument` | UNCHANGED | `instrument_type` field already exists |
| `backend/models.py` — `AnalysisService` | UNCHANGED | `category` field sufficient |
| `backend/parsers/peakdata_csv_parser.py` | UNCHANGED | Wrapped by HplcPlugin shim |
| `backend/calculations/hplc_processor.py` | UNCHANGED | Wrapped by HplcPlugin shim |
| `backend/calculations/engine.py` | UNCHANGED | FORMULA_REGISTRY stays for legacy path |
| `backend/main.py` | MODIFIED | Add new ingest endpoints; existing HPLC endpoints stay intact during transition |
| Junction tables `instrument_methods` | MODIFIED | Point at `methods.id` instead of `hplc_methods.id` |
| Junction tables `peptide_methods` | MODIFIED | Point at `methods.id` |

### Integration With Existing Worksheet Flow

`WorksheetItem` has `instrument_uid` (SENAITE instrument UID) but no FK to local `Instrument`. No change needed — the worksheet tracks assignment intent; `InstrumentResult` records the actual execution. Link is through `sample_id_label` matching `WorksheetItem.sample_id`.

### Integration With Existing AnalysisService → Instrument → Method Chain

Current state: `AnalysisService` → `Peptide` (via `peptide_id`), `Peptide` → `HplcMethod` (via `peptide_methods`), `HplcMethod` → `Instrument` (via `instrument_methods`).

Post-migration state: Same chain but `HplcMethod` → `Method` (renamed). The `method_type` discriminator on `Method` lets the frontend and backend filter methods to only show HPLC methods for HPLC analysis services, endotoxin methods for endotoxin services, etc.

New query pattern:
```python
# Get methods valid for a specific instrument type
methods = session.query(Method).filter(
    Method.method_type == "endotoxin",
    Method.active == True
).all()
```

---

## Build Order (Dependency-Aware)

This order ensures HPLC never breaks during migration.

### Phase 1: Schema Foundation (No App Logic Change)

1. Add `Method` table (new, separate from `hplc_methods`)
2. Add `InstrumentResult` table (new)
3. Seed `Method` rows from existing `hplc_methods` rows (data migration)
4. Add new junction tables `instrument_methods_v2`, `analyte_methods` pointing at `methods.id`
5. Seed junction rows from existing `instrument_methods`, `peptide_methods`
6. Add `instrument_result_id` FK to `HPLCAnalysis` (nullable, no existing rows break)
7. Update `Instrument.methods` relationship to use `instrument_methods_v2`

**Verify:** All existing HPLC endpoints still function. No regressions.

### Phase 2: Plugin Registry (No Schema Change)

1. Create `backend/instruments/` module structure
2. Define `base.py` Protocol
3. Create `registry.py` with `register()` and `get_plugin()`
4. Create `HplcPlugin` shim wrapping existing parser + processor
5. Register `HplcPlugin` at app startup in `main.py`

**Verify:** `get_plugin("hplc")` returns the plugin; `parse()` and `calculate()` produce correct results on known HPLC test data.

### Phase 3: New Ingest Endpoints (HPLC via new path, legacy path stays)

1. Add `POST /ingest/hplc` endpoint that uses `HplcPlugin` + writes `InstrumentResult` + writes `HPLCAnalysis` with `instrument_result_id`
2. Keep existing HPLC ingest endpoint alive (don't delete, just don't use it for new ingests)
3. Add `GET /results/instrument/{id}` endpoint returning `InstrumentResult`

**Verify:** New HPLC ingest writes both `InstrumentResult` and `HPLCAnalysis` rows. Old HPLC ingest endpoint still works.

### Phase 4: Endotoxin (New Plugin + Manual Entry)

1. Create `EndotoxinPlugin` with CSV parser for LAL instrument format
2. Register `EndotoxinPlugin`
3. Add `POST /ingest/endotoxin` and `POST /ingest/manual` endpoints
4. Add endotoxin-specific `Method` admin UI (frontend)
5. Add endotoxin result review page (frontend)

**Verify:** Endotoxin CSV ingests produce `InstrumentResult` rows with `result_numeric` (EU/mL) and correct `result_pass`.

### Phase 5: Sterility (Manual Entry Only)

1. Create `SterilityPlugin` (no parser)
2. Register `SterilityPlugin`
3. Wire sterility through `POST /ingest/manual` (no new endpoint needed)
4. Add sterility result entry UI (frontend)

**Verify:** Manual sterility entry produces `InstrumentResult` with `result_pass = True/False`.

### Phase 6: Decommission Legacy HPLC Path (Optional, After Validation)

1. Remove old `hplc_methods` table (after confirming all methods migrated to `methods`)
2. Remove old junction tables
3. Remove old HPLC-specific ingest endpoint

---

## Anti-Patterns to Avoid

### Using SQLAlchemy Polymorphic Inheritance for Result Types

**What people do:** Define `InstrumentResult` with `__mapper_args__ = {"polymorphic_on": "instrument_type"}` and create `HPLCResult(InstrumentResult)`, `EndotoxinResult(InstrumentResult)` subclasses.

**Why it's wrong:** SQLAlchemy's joined-table inheritance requires a JOIN for every query on the parent table. Cross-type analytics queries (the primary goal of this milestone) become slow and complex. The union of typed columns that vary by type is best handled by JSON config + a few typed columns for commonly-queried fields — not inheritance.

**Do this instead:** Single `InstrumentResult` table with `instrument_type` discriminator, `result_numeric`, `result_pass`, and `result_data` JSON. No inheritance.

### Migrating HPLCAnalysis In-Place

**What people do:** ALTER TABLE `hplc_analyses` to rename it to `instrument_results`, drop HPLC-specific columns, move data to JSON.

**Why it's wrong:** `HPLCAnalysis` has 25+ columns, cross-references from `CalibrationCurve`, `WizardSession`, a separate-database `sample_prep_id` (no FK possible), chromatogram data, and debug logs. An in-place migration touches every existing HPLC record. One mistake corrupts years of results.

**Do this instead:** Create `InstrumentResult` as a new table alongside `HPLCAnalysis`. Add one FK column (`instrument_result_id`) to `HPLCAnalysis`. New ingests write both tables; old records remain queryable via `HPLCAnalysis` directly.

### Embedding Instrument Logic in main.py

**What people do:** Add a new `if instrument_type == "endotoxin": ... elif instrument_type == "sterility": ...` block directly in the ingest endpoint in `main.py`.

**Why it's wrong:** `main.py` is already ~3000 lines. Adding per-type branches makes each new instrument type a 3000-line-file modification. Testing individual instrument types requires the full app context.

**Do this instead:** Plugin registry with one file per type. `main.py` ingest endpoint calls `get_plugin(instrument_type).parse()` and `.calculate()`. Adding a new type = create a new plugin file, register it. No changes to `main.py`.

### Hardcoding Instrument Types as Enums Checked Everywhere

**What people do:** `InstrumentType = Literal["hplc", "endotoxin", "sterility"]` referenced in 15 places across the codebase.

**Why it's wrong:** Every new instrument type requires grep-and-update across all those files.

**Do this instead:** `registered_types()` from the registry is the single source of valid instrument types. Validation at the ingest endpoint: `if instrument_type not in registered_types(): raise HTTPException(422)`. Nothing else needs to know the list.

### Separate Parse and Calculate Registries

**What people do:** `PARSER_REGISTRY["hplc"] = HplcParser` and `CALCULATOR_REGISTRY["hplc"] = HplcCalculator` as separate dicts.

**Why it's wrong:** Parser output shape must match calculator input shape exactly. Separating them allows mismatched pairs to be registered without detection until runtime.

**Do this instead:** One plugin per type that owns both `parse()` and `calculate()`. The plugin is the contract between parsing and calculation for that type.

---

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| SENAITE LIMS | HTTP POST via httpx, same as current | `InstrumentResult` → `AnalysisService.keyword` → SENAITE update; no changes to SENAITE integration layer |
| Integration-service | HTTP proxy from Accu-Mk1 backend | Unchanged; integration-service doesn't know about `InstrumentResult` |
| accumark_mk1 PostgreSQL DB | `sample_prep_id` integer column, no FK | Unchanged; `InstrumentResult.sample_prep_id` follows same pattern as `HPLCAnalysis.sample_prep_id` |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| `main.py` ↔ plugin registry | `get_plugin(type)` → Protocol methods | Only boundary: parse() and calculate(). Registry imported at startup. |
| Plugin ↔ existing parsers/calculators | Direct Python import | HplcPlugin imports from `parsers/peakdata_csv_parser.py` and `calculations/hplc_processor.py`. No interface changes. |
| `InstrumentResult` ↔ `HPLCAnalysis` | FK: `hplc_analyses.instrument_result_id` | Nullable FK. Old HPLC records: NULL. New records: populated. |
| `Method` ↔ existing `Instrument` | `instrument_methods_v2` junction table | New junction table replaces `instrument_methods` |
| `Method` ↔ `Peptide` | `analyte_methods` junction table | New junction table replaces `peptide_methods` |
| Frontend ↔ `InstrumentResult` | TanStack Query → FastAPI REST | New endpoints return `InstrumentResult` shape; frontend types updated in `api.ts` |

---

## Scalability Considerations

This is a local-first lab desktop app. Scalability concerns are about data volume and query performance, not HTTP load.

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 1-2 instrument types, <1000 results | Current approach works. No indexes needed beyond PK. |
| 3-5 instrument types, 10k+ results | Add index on `(instrument_type, analyte_id, created_at)` for trending queries. SQLite handles this well. |
| Cross-sample analytics with date ranges | Add index on `(sample_id_label, instrument_type)` for sample-level lookups. Consider a `result_date` column if `created_at` isn't reliable. |
| Large `result_data` JSON | Keep calculation traces in `calculation_trace` JSON column; keep primary results in typed `result_numeric`/`result_pass` columns. Analytics queries never touch the JSON. |

---

## Sources

All claims verified against actual codebase files on 2026-04-05.

| Claim | Source | Confidence |
|-------|--------|------------|
| `HplcMethod` columns | `backend/models.py` lines 228-253 | HIGH |
| `HPLCAnalysis` columns | `backend/models.py` lines 420-476 | HIGH |
| `instrument_methods` FK points at `hplc_methods.id` | `backend/models.py` lines 206-214 | HIGH |
| `peptide_methods` FK points at `hplc_methods.id` | `backend/models.py` lines 217-225 | HIGH |
| `FORMULA_REGISTRY` pattern in `engine.py` | `backend/calculations/engine.py` lines 19-26 | HIGH |
| `hplc_processor.py` is pure-function (no DB access) | `backend/calculations/hplc_processor.py` — no SQLAlchemy imports | HIGH |
| `sample_prep_id` is plain Integer (cross-DB, no FK) | `backend/models.py` line 459, comment on line 458 | HIGH |
| `Instrument.instrument_type` field exists | `backend/models.py` line 129 | HIGH |
| `AnalysisService.category` field exists | `backend/models.py` line 153 | HIGH |
| `Result` table has `calculation_type` + JSON fields | `backend/models.py` lines 104-115 | HIGH |
| SQLAlchemy 2.0 `mapped_column` style used throughout | `backend/models.py` — all models use `Mapped[T]` | HIGH |

---
*Architecture research for: Multi-instrument automation framework (Accu-Mk1 v0.30.0)*
*Researched: 2026-04-05*
