# Stack Research

**Domain:** Multi-instrument lab automation framework (additive to existing FastAPI/SQLAlchemy/SQLite stack)
**Researched:** 2026-04-05
**Confidence:** HIGH for SQLAlchemy patterns (official docs); MEDIUM for LAL/sterility data formats (instrument-vendor specific, no universal standard)

---

## Context: What Already Exists (Do Not Re-evaluate)

| Layer | Current | Version |
|-------|---------|---------|
| API framework | FastAPI | 0.115.0 |
| ORM | SQLAlchemy | 2.0.35 |
| Database | SQLite (local-first) | bundled |
| Schema | No migration tool — `Base.metadata.create_all()` on startup | — |
| Validation | Pydantic | 2.9.0 |
| File parsing | openpyxl + stdlib csv | 3.1.0+ |
| Calculation engine | Custom `Formula` ABC + `FORMULA_REGISTRY` dict | internal |
| Parser registry | `parsers/` package, HPLC-only, no base protocol | internal |

The existing `FORMULA_REGISTRY` and `calculations/engine.py` already implement the core registry pattern. The new framework extends this pattern — it does not replace it.

---

## New Stack Additions Required

### Core: Schema Migration Tool

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| **alembic** | `>=1.13.0,<2.0` | SQLite schema migrations | v0.30.0 introduces new tables and renames `hplc_methods` to a generalized table. `create_all()` silently skips existing tables, so existing deployments will not get new columns without a migration tool. Alembic is the standard SQLAlchemy migration library, authored by the same team. Pin minor to `<2.0` to avoid API drift; current stable is `1.18.4` (released 2025-10-28). |

No other external additions are required. The existing SQLAlchemy 2.0, FastAPI, Pydantic, and openpyxl stack handles everything else.

### Supporting: No New Libraries Needed for Instrument Logic

The parser/calculator extension is achieved entirely through Python's stdlib `abc` module and a dict-based registry — both patterns already used in `calculations/engine.py`. No plugin framework library (pluggy, stevedore, importlib.metadata entrypoints) is warranted at this scale.

---

## SQLAlchemy Patterns for Polymorphic Result Storage

### Recommended: Single Table Inheritance (STI) with discriminator column

**Why STI over the alternatives:**

- **Joined table inheritance** requires a JOIN per query. Since result queries always filter by `instrument_type`, adding a JOIN adds unnecessary cost and complexity.
- **Concrete table inheritance** requires UNION queries for any cross-type reporting. The PROJECT.md explicitly calls for schema designed to support cross-sample analytics (trending, averages by peptide/blend) — UNION-based queries are hostile to this goal. The SQLAlchemy docs note concrete inheritance "presents more configurational challenges" and "is much more limited in functionality."
- **STI** keeps all results in one table, filtered by `instrument_type`. Instrument-type-specific fields stay in the same row. NULL columns for unused fields are acceptable at lab scale (hundreds to low thousands of results, not millions). Queries are simpler and faster.

**Implementation pattern (SQLAlchemy 2.0 mapped_column style):**

```python
class InstrumentResult(Base):
    """
    Polymorphic result storage for all instrument types.
    Discriminator: instrument_type ('hplc', 'lal', 'sterility', 'lcms', 'gcms', 'heavy_metals')
    """
    __tablename__ = "instrument_results"
    __mapper_args__ = {
        "polymorphic_on": "instrument_type",
        "polymorphic_identity": "base",
    }

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    instrument_type: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    worksheet_item_id: Mapped[Optional[int]] = mapped_column(ForeignKey("worksheet_items.id"), nullable=True, index=True)
    sample_id: Mapped[Optional[int]] = mapped_column(ForeignKey("samples.id"), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(50), default="pending", nullable=False)

    # Three result slots cover all instrument types without NULL sprawl
    result_value: Mapped[Optional[float]] = mapped_column(Float, nullable=True)      # numeric (EU/mL, purity %)
    result_pass_fail: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True) # pass/fail (sterility)
    result_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)          # complex/multi-point results

    raw_input: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)            # provenance: raw file data or manual entry
    ingest_source: Mapped[str] = mapped_column(String(20), default="file", nullable=False)  # 'file' | 'manual'
    ingest_file_hash: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)      # SHA-256 for idempotent re-import
    method_id: Mapped[Optional[int]] = mapped_column(ForeignKey("instrument_methods.id"), nullable=True)
    created_by_user_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class HplcResult(InstrumentResult):
    __mapper_args__ = {"polymorphic_identity": "hplc"}
    # HPLC detail (purity_pct, peak_area, calibration_curve_id) lives in result_json


class LalResult(InstrumentResult):
    __mapper_args__ = {"polymorphic_identity": "lal"}
    # EU/mL in result_value; dilution_factor and lot_number in result_json


class SterilityResult(InstrumentResult):
    __mapper_args__ = {"polymorphic_identity": "sterility"}
    # Pass/fail in result_pass_fail; incubation details and organism ID in result_json
```

**Key design decisions:**
- `result_value`, `result_pass_fail`, `result_json` — three slots cover all known instrument types without wide NULL columns
- `ingest_file_hash` enforces idempotency on file re-import (project audit requirement from PROJECT.md)
- `ingest_source` distinguishes file import from manual entry paths (both required per PROJECT.md)
- Index on `instrument_type` + `worksheet_item_id` supports the analytics queries the roadmap defers but the schema must accommodate

### Generalized Method Model

Replace `HplcMethod` (HPLC-specific columns) with `InstrumentMethod` (instrument-type-agnostic):

```python
class InstrumentMethod(Base):
    __tablename__ = "instrument_methods"
    # Rename from hplc_methods via Alembic migration

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    instrument_type: Mapped[str] = mapped_column(String(50), nullable=False, index=True)  # 'hplc', 'lal', 'sterility'
    config: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)  # instrument-type-specific config blob
    senaite_id: Mapped[Optional[str]] = mapped_column(String(200), nullable=True, unique=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    # ... timestamps, audit fields same as current HplcMethod
```

The `config` JSON blob replaces HPLC-specific sparse columns (`starting_organic_pct`, `temperature_mct_c`, `dissolution`). These become keys inside `config` under `"hplc": {...}`. This avoids null column sprawl as instrument types grow.

---

## Pluggable Parser/Calculator Registry Pattern

### No new libraries. Extend the existing pattern.

The existing `FORMULA_REGISTRY: dict[str, type[Formula]]` in `calculations/engine.py` is the correct model. Extend it to an `INSTRUMENT_REGISTRY` that maps instrument type to a (parser class, calculator class) pair.

**Base protocol (stdlib `abc` only):**

```python
# backend/instruments/base.py
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

@dataclass
class ParsedInput:
    """Normalized structure from any instrument file or manual entry."""
    instrument_type: str
    raw_data: dict          # preserves provenance
    normalized: dict        # standard keys for calculator
    ingest_source: str      # 'file' | 'manual'
    file_hash: str | None = None

@dataclass
class CalculatedOutput:
    """Result of calculator.calculate()."""
    result_value: float | None
    result_pass_fail: bool | None
    result_json: dict
    warnings: list[str]
    success: bool
    error: str | None = None


class InstrumentParser(ABC):
    @abstractmethod
    def can_parse(self, filename: str, content: bytes | None) -> bool:
        """Return True if this parser handles this input."""
        ...

    @abstractmethod
    def parse(self, source: Any) -> ParsedInput:
        ...


class InstrumentCalculator(ABC):
    @abstractmethod
    def calculate(self, parsed: ParsedInput, method_config: dict) -> CalculatedOutput:
        ...


# Registry: instrument_type -> (parser_class, calculator_class)
INSTRUMENT_REGISTRY: dict[str, tuple[type[InstrumentParser], type[InstrumentCalculator]]] = {}
```

**HPLC refactor (backwards compatible — wraps existing code, does not rewrite it):**

```python
# backend/instruments/hplc.py
from instruments.base import INSTRUMENT_REGISTRY, InstrumentParser, InstrumentCalculator
# Wrap existing parsers/peakdata_csv_parser.py and calculations/hplc_processor.py

class HplcParser(InstrumentParser):
    def can_parse(self, filename, content): ...   # wraps existing logic
    def parse(self, source): ...                  # delegates to existing parse_hplc_files()

class HplcCalculator(InstrumentCalculator):
    def calculate(self, parsed, method_config): ... # delegates to existing CalculationEngine

INSTRUMENT_REGISTRY["hplc"] = (HplcParser, HplcCalculator)
```

LAL and sterility become additional files in `backend/instruments/lal.py` and `backend/instruments/sterility.py`.

---

## LAL (Endotoxin) Data Format Assessment

**Confidence: MEDIUM** — No universal export standard exists across vendors.

| Vendor / System | Export Format | Key Fields |
|-----------------|---------------|-----------|
| Charles River EndoScan-V | CSV or XML | Sample ID, Result (EU/mL), Pass/Fail vs USP limit, Dilution, Lot # |
| Lonza Kinetic-QCL | Plate reader CSV | Well position, OD reading, calculated EU/mL per standard curve |
| Endosafe PTS cartridge | Proprietary PDF / CSV | EU/mL, %CV, Spike Recovery % |

**Practical implication:** LAL parser cannot be a single universal parser. The correct architecture is multiple `InstrumentParser` subclasses registered under `"lal"`, each implementing `can_parse()` to self-identify by file structure (column headers, file magic, etc.). A `LalManualParser` accepts a validated Pydantic model directly for manual entry — no file parsing needed.

**No new Python libraries are needed.** stdlib `csv` + `openpyxl` (already installed) covers all LAL export formats encountered in the field.

---

## Sterility Data Format Assessment

**Confidence: HIGH for result shape; MEDIUM for file format**

USP <71> sterility results are binary: Pass (no microbial growth) or Fail (growth observed). The result is qualitative — no numeric value. Core data to capture:
- Test lot/batch ID
- Incubation period (14 days minimum, per USP <71>)
- Observation: growth / no growth
- Organism identification (if fail)

**Practical implication:** Sterility is almost always manual entry — no instrument exports a structured file. The manual entry path is the primary ingest route. File import is a fallback for labs exporting from a LIMS or incubation monitor CSV.

`result_pass_fail` column in `InstrumentResult` is sufficient for the result. `result_json` stores incubation metadata and organism details for failed tests. No special library needed.

---

## SQLite Scalability Assessment

**Does SQLite scale for this use case? YES, without qualification.**

| Concern | Assessment |
|---------|------------|
| Row volume | Lab generates ~50-200 results/day. 10,000 rows = ~6 months. SQLite handles millions of rows without issue. |
| JSON column queries | SQLite 3.38+ (2022) ships JSON1 as core (not extension). SQLite 3.45+ (2024-01-15) adds JSONB binary format for faster JSON parsing. Both are available in Python 3.11+ bundled SQLite. |
| Concurrent writes | Single-operator workstation — no concurrent write contention. SQLite WAL mode handles read-while-write. |
| Analytics queries | Cross-sample trending on 10K rows with a `WHERE instrument_type = 'hplc' AND peptide_id = ?` index scan is sub-millisecond. |
| Schema migration | Alembic handles SQLite, including the `hplc_methods` rename. The SQLite `ALTER TABLE` limitation (no column drop in older versions) is handled by Alembic's batch mode. |

No case for PostgreSQL in this milestone. `psycopg2-binary` is already in requirements.txt and `migrate_sqlite_to_pg.py` exists — the migration path is ready when horizontal scaling is actually needed.

---

## Alembic Migration Strategy

### Why Alembic is required now (not optional)

`Base.metadata.create_all()` only creates tables that do not exist. It will not:
- Rename `hplc_methods` to `instrument_methods`
- Add `instrument_type` discriminator to renamed methods table
- Add `config` JSON column (replacing HPLC-specific columns)
- Create the new `instrument_results` table
- Update junction tables that FK to `hplc_methods`

Without Alembic, existing v0.28.x deployments require manual SQLite edits to upgrade.

### SQLite batch mode for ALTER TABLE

```python
# In the Alembic migration script for v0.30.0
op.rename_table('hplc_methods', 'instrument_methods')

with op.batch_alter_table('instrument_methods') as batch_op:
    batch_op.add_column(sa.Column('instrument_type', sa.String(50), nullable=True))
    batch_op.add_column(sa.Column('config', sa.JSON(), nullable=True))
    # Migrate HPLC-specific columns into config JSON in a data migration step
    # Then drop the old columns:
    batch_op.drop_column('starting_organic_pct')
    batch_op.drop_column('temperature_mct_c')
    batch_op.drop_column('dissolution')
    batch_op.drop_column('size_peptide')
```

Alembic batch mode (`with op.batch_alter_table`) is the documented workaround for SQLite's `ALTER TABLE` limitations and is supported in all Alembic 1.x versions.

---

## What NOT to Add

| Avoid | Why | Instead |
|-------|-----|---------|
| `pluggy` or `stevedore` | Plugin frameworks for discoverable third-party extensions. Overkill for a closed app with 3-6 instrument types known at build time. | Dict-based `INSTRUMENT_REGISTRY` (already the pattern in `FORMULA_REGISTRY`) |
| `celery` or `rq` for async ingest | Background task queue adds Redis dependency and operational complexity. File ingestion takes under 1 second. | FastAPI `BackgroundTasks` (zero-dependency, already in FastAPI) |
| `pandas` for LAL/sterility parsing | 30MB+ dependency for CSV parsing that `stdlib csv` + `openpyxl` already handle. | Keep existing file parsing approach |
| PostgreSQL migration in this milestone | Premature. SQLite handles the load. Migration script already exists. | Stay on SQLite; the path exists when needed |
| Joined-table or concrete-table inheritance | Joined requires JOINs per result query; concrete requires UNIONs for cross-type analytics. | Single table inheritance with discriminator |
| Separate `lal_results` and `sterility_results` tables | Prevents cross-instrument queries, duplicates status/audit columns, complicates ingest pipeline. | Single `instrument_results` table with STI |
| `pydantic-settings` or config file overhaul | Current settings pattern works. New instrument method config lives in `InstrumentMethod.config` JSON column. | No change needed |

---

## requirements.txt Delta (additions only)

```
# Add to backend/requirements.txt
alembic>=1.13.0,<2.0
```

That is the only pip addition required. All other new capabilities come from:
- SQLAlchemy 2.0 STI (already installed — new model definitions only)
- Python `abc` module (stdlib)
- Python `csv` module (stdlib)
- `openpyxl` (already installed — handles Excel-format LAL exports)

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| alembic 1.13-1.18 | SQLAlchemy 2.0.x | Alembic 1.13+ required for SQLAlchemy 2.0 `mapped_column` style support |
| SQLAlchemy 2.0.35 (current) | alembic 1.13+ | No version conflict |
| SQLite bundled with Python 3.11+ | Alembic batch mode | batch_alter_table handles SQLite ALTER TABLE limitations automatically |

---

## Sources

- [SQLAlchemy 2.0 Inheritance Docs](https://docs.sqlalchemy.org/en/20/orm/inheritance.html) — STI vs joined vs concrete tradeoffs, HIGH confidence
- [Alembic PyPI](https://pypi.org/project/alembic/) — current version 1.18.4 confirmed, HIGH confidence
- [Alembic Changelog](https://alembic.sqlalchemy.org/en/latest/changelog.html) — SQLAlchemy 2.0 compatibility in 1.13+, HIGH confidence
- [SQLite JSON Functions](https://sqlite.org/json1.html) — JSONB binary format in 3.45 (2024-01-15), HIGH confidence
- [Charles River EndoScan-V](https://www.criver.com/products-services/qc-microbial-solutions/endotoxin-testing/endotoxin-testing-software-instrumentation/endoscan-v) — CSV/XML export confirmed, MEDIUM confidence (no format spec published)
- [USP <71> Sterility overview](https://dsdpanalytics.com/regulatory-guidance/usp-71-sterility-tests/) — pass/fail result shape confirmed, HIGH confidence
- [Python ABC docs](https://docs.python.org/3/library/abc.html) — stdlib pattern, HIGH confidence
- [Alembic batch operations](https://alembic.sqlalchemy.org/en/latest/ops.html) — SQLite ALTER TABLE workaround confirmed, HIGH confidence

---
*Stack research for: Accu-Mk1 v0.30.0 Multi-Instrument Architecture*
*Researched: 2026-04-05*
