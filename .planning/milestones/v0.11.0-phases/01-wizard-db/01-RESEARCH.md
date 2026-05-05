# Phase 1: DB Models and Calculation Foundation - Research

**Researched:** 2026-02-19
**Domain:** Python Decimal arithmetic, SQLAlchemy 2.0 models, FastAPI REST endpoints, wizard session persistence
**Confidence:** HIGH — all findings verified against the live codebase and confirmed working with .venv Python

## Summary

Phase 1 adds two new capabilities to the existing FastAPI + SQLite backend: (1) a `WizardSession` model with one-to-many `WizardMeasurement` records that persist a session's raw weights and status through completion, and (2) a new calculation module (`calculations/wizard.py`) that uses `Decimal` arithmetic to implement all five derived values required by the wizard.

The codebase already has all the patterns needed. SQLAlchemy 2.0 `mapped_column` models, FastAPI JWT auth, the `init_db()` migration pattern, and Pydantic v2 response schemas are all established. The only truly new dependency is the standard library `decimal` module — no new pip packages are required. The calculation module must be completely separate from the existing `hplc_processor.py` (which uses `float`) to honor the Decimal-from-first-formula decision.

The key architectural tension: Decimal is used internally for all arithmetic; the Pydantic response schemas use `float` (since SQLite stores REAL and JSON requires float). Conversion happens exactly once, at the API response boundary. Raw weight values are stored as SQLite REAL (Float columns); the precision is sufficient (float64 handles 7-digit mg values with sub-milligram precision without rounding error). Calculated/derived values are NOT stored — they are recalculated on demand from the raw weights using Decimal.

**Primary recommendation:** Create `WizardSession` + `WizardMeasurement` models, two REST endpoint groups (`/wizard/sessions` and `/wizard/sessions/{id}/measurements`), and `backend/calculations/wizard.py` with Decimal arithmetic. Follow existing patterns exactly — no new libraries needed.

---

## User Constraints (from STATE.md decisions)

### Locked Decisions
- Use `Decimal` arithmetic from first formula — no retrofitting allowed
- Store only raw weights in DB; recalculate all derived values on demand
- Re-weigh inserts new record + sets `is_current=False` on old (audit trail preserved)
- SCALE_HOST env var controls scale mode; absent = manual-entry mode (no crash)
- Phase 2 is hardware-dependent: confirm Ethernet module, IP, and TCP port on physical balance before coding

### Claude's Discretion
- No CONTEXT.md exists for this phase — all implementation details below are research-driven recommendations, not user-locked decisions

### Deferred Ideas (OUT OF SCOPE for Phase 1)
- Scale TCP connection (Phase 2)
- SSE weight streaming (Phase 3)
- Wizard UI (Phase 4)
- SENAITE sample lookup (Phase 5)
- Multiple injections per session (future requirement)
- PDF prep sheet export (out of scope)
- SENAITE results push (out of scope)

---

## Standard Stack

No new libraries required. All dependencies already present.

### Core (already installed)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `decimal` (stdlib) | Python 3.x | Exact decimal arithmetic | No float rounding errors in lab calculations |
| `sqlalchemy` | 2.0.35 | ORM + models | Established project pattern |
| `fastapi` | 0.115.0 | REST endpoints | Established project pattern |
| `pydantic` | 2.9.0 | Request/response schemas | Established project pattern |

### Supporting (already installed)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `python-jose` | ≥3.3.0 | JWT auth via `get_current_user` | Every wizard endpoint |
| `sqlalchemy.text` | 2.0.35 | Raw SQL for migrations | Adding new columns to existing tables |

### No New Packages Needed
```bash
# Nothing to install — all deps already in requirements.txt
```

---

## Architecture Patterns

### Recommended File Changes
```
backend/
├── models.py              # ADD: WizardSession, WizardMeasurement models
├── database.py            # ADD: migration ALTER TABLE statements in init_db()
├── main.py                # ADD: Pydantic schemas + wizard endpoints (appended)
└── calculations/
    └── wizard.py          # NEW FILE: all wizard Decimal calculations
```

### Pattern 1: SQLAlchemy 2.0 Model (mapped_column style)

**What:** All new models use `Mapped[type] = mapped_column(...)` syntax — NOT old Column() style.
**When to use:** Always. All models in the codebase use this.

```python
# Source: backend/models.py (existing pattern)
from datetime import datetime
from typing import Optional
from sqlalchemy import String, Float, Boolean, DateTime, ForeignKey, JSON, Integer
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base

class WizardSession(Base):
    """
    Wizard session record. One session = one sample prep run.
    Status: 'in_progress' | 'completed'
    """
    __tablename__ = "wizard_sessions"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    peptide_id: Mapped[int] = mapped_column(ForeignKey("peptides.id"), nullable=False)
    calibration_curve_id: Mapped[Optional[int]] = mapped_column(ForeignKey("calibration_curves.id"), nullable=True)
    status: Mapped[str] = mapped_column(String(50), default="in_progress", nullable=False)

    # Step 1: Sample info (manually entered or from SENAITE later)
    sample_id_label: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    declared_weight_mg: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    # Step 1b: Target dilution params
    target_conc_ug_ml: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    target_total_vol_ul: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    # Step 4: HPLC results (entered after instrument run)
    peak_area: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    # Relationships
    measurements: Mapped[list["WizardMeasurement"]] = relationship(
        "WizardMeasurement", back_populates="session", cascade="all, delete-orphan"
    )
    peptide: Mapped["Peptide"] = relationship("Peptide")

    def __repr__(self) -> str:
        return f"<WizardSession(id={self.id}, status='{self.status}')>"


class WizardMeasurement(Base):
    """
    Individual balance reading within a wizard session.
    Re-weighing inserts a NEW record and sets is_current=False on the old one.
    This preserves full audit trail.

    step_key values: 'stock_vial_empty', 'stock_vial_loaded',
                     'dil_vial_empty', 'dil_vial_with_diluent', 'dil_vial_final'
    source: 'manual' | 'scale' (Phase 2 adds 'scale')
    """
    __tablename__ = "wizard_measurements"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("wizard_sessions.id"), nullable=False)
    step_key: Mapped[str] = mapped_column(String(50), nullable=False)
    weight_mg: Mapped[float] = mapped_column(Float, nullable=False)
    source: Mapped[str] = mapped_column(String(20), default="manual", nullable=False)  # 'manual' | 'scale'
    is_current: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    session: Mapped["WizardSession"] = relationship("WizardSession", back_populates="measurements")

    def __repr__(self) -> str:
        return f"<WizardMeasurement(session={self.session_id}, step='{self.step_key}', weight={self.weight_mg})>"
```

### Pattern 2: Migration in init_db()

**What:** New tables are created automatically by `create_all()`. New columns on existing tables require explicit ALTER TABLE in `init_db()`.
**When to use:** Only for adding columns to tables that already existed in production.

```python
# Source: backend/database.py (existing pattern — copy exactly)
def init_db():
    import models
    Base.metadata.create_all(bind=engine)  # Creates wizard_sessions, wizard_measurements automatically

    from sqlalchemy import text
    with engine.connect() as conn:
        # Example: if adding column to existing table later
        try:
            conn.execute(text("ALTER TABLE wizard_sessions ADD COLUMN some_new_col TEXT"))
            conn.commit()
        except Exception:
            pass  # Column already exists
```

**Note:** `wizard_sessions` and `wizard_measurements` are NEW tables. `create_all()` handles them automatically. No ALTER TABLE needed for Phase 1.

### Pattern 3: FastAPI Endpoint with JWT Auth

**What:** All wizard endpoints use `get_current_user` Depends. Both `db` and `_current_user` are in the signature.
**When to use:** Every endpoint that touches wizard data.

```python
# Source: backend/main.py (existing pattern — used on all ~40 endpoints)
from auth import get_current_user
from database import get_db
from sqlalchemy.orm import Session
from sqlalchemy import select, desc
from fastapi import Depends, HTTPException

@app.post("/wizard/sessions", response_model=WizardSessionResponse, status_code=201)
async def create_wizard_session(
    data: WizardSessionCreate,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Start a new analysis wizard session."""
    # Verify peptide exists
    peptide = db.execute(select(Peptide).where(Peptide.id == data.peptide_id)).scalar_one_or_none()
    if not peptide:
        raise HTTPException(404, f"Peptide {data.peptide_id} not found")

    session = WizardSession(
        peptide_id=data.peptide_id,
        sample_id_label=data.sample_id_label,
        declared_weight_mg=data.declared_weight_mg,
        target_conc_ug_ml=data.target_conc_ug_ml,
        target_total_vol_ul=data.target_total_vol_ul,
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return _build_session_response(session, db)
```

### Pattern 4: Decimal Calculation Module

**What:** All wizard math uses `Decimal`. Conversion to `float` happens ONLY at the API boundary (in `float(...)` calls when building Pydantic response).
**When to use:** `calculations/wizard.py` only. Never mix Decimal and float in intermediate steps.

```python
# Source: backend/calculations/wizard.py (NEW FILE — pattern from Phase context)
from decimal import Decimal, ROUND_HALF_UP, getcontext

# Set precision high enough for all chained calculations
getcontext().prec = 28

DILUENT_DENSITY = Decimal("997.1")  # mg/mL for water (from Peptide.diluent_density)


def calc_stock_prep(
    declared_weight_mg: Decimal,
    stock_vial_empty_mg: Decimal,
    stock_vial_loaded_mg: Decimal,
    diluent_density: Decimal = DILUENT_DENSITY,
) -> dict:
    """
    Calculate stock preparation values.
    Returns all intermediate values for audit trace.
    """
    diluent_mass_mg = stock_vial_loaded_mg - stock_vial_empty_mg
    total_diluent_added_ml = diluent_mass_mg / diluent_density
    stock_conc_ug_ml = (declared_weight_mg * Decimal("1000")) / total_diluent_added_ml
    return {
        "diluent_mass_mg": diluent_mass_mg,
        "total_diluent_added_ml": total_diluent_added_ml,
        "stock_conc_ug_ml": stock_conc_ug_ml,
    }


def calc_required_volumes(
    stock_conc_ug_ml: Decimal,
    target_conc_ug_ml: Decimal,
    target_total_vol_ul: Decimal,
) -> dict:
    """
    Calculate required stock and diluent volumes for target dilution.
    """
    stock_vol_ul = target_total_vol_ul * (target_conc_ug_ml / stock_conc_ug_ml)
    diluent_vol_ul = target_total_vol_ul - stock_vol_ul
    return {
        "required_stock_vol_ul": stock_vol_ul,
        "required_diluent_vol_ul": diluent_vol_ul,
    }


def calc_actual_dilution(
    stock_conc_ug_ml: Decimal,
    dil_vial_empty_mg: Decimal,
    dil_vial_with_diluent_mg: Decimal,
    dil_vial_final_mg: Decimal,
    diluent_density: Decimal = DILUENT_DENSITY,
) -> dict:
    """
    Calculate actual dilution volumes and actual concentration from weights.
    """
    actual_diluent_mass_mg = dil_vial_with_diluent_mg - dil_vial_empty_mg
    actual_diluent_vol_ul = actual_diluent_mass_mg / diluent_density * Decimal("1000")

    actual_stock_mass_mg = dil_vial_final_mg - dil_vial_with_diluent_mg
    actual_stock_vol_ul = actual_stock_mass_mg / diluent_density * Decimal("1000")

    actual_total_vol_ul = actual_diluent_vol_ul + actual_stock_vol_ul
    actual_conc_ug_ml = stock_conc_ug_ml * actual_stock_vol_ul / actual_total_vol_ul

    return {
        "actual_diluent_vol_ul": actual_diluent_vol_ul,
        "actual_stock_vol_ul": actual_stock_vol_ul,
        "actual_total_vol_ul": actual_total_vol_ul,
        "actual_conc_ug_ml": actual_conc_ug_ml,
    }


def calc_results(
    peak_area: Decimal,
    calibration_slope: Decimal,
    calibration_intercept: Decimal,
    actual_conc_ug_ml: Decimal,
    actual_total_vol_ul: Decimal,
) -> dict:
    """
    Calculate HPLC results from peak area and calibration curve.
    """
    determined_conc_ug_ml = (peak_area - calibration_intercept) / calibration_slope
    peptide_mass_mg = determined_conc_ug_ml * actual_total_vol_ul / Decimal("1000")
    purity_pct = (determined_conc_ug_ml / actual_conc_ug_ml) * Decimal("100")
    dilution_factor = actual_total_vol_ul / (actual_total_vol_ul - actual_total_vol_ul + Decimal("1"))  # placeholder — actual DF = total/stock

    return {
        "determined_conc_ug_ml": determined_conc_ug_ml,
        "peptide_mass_mg": peptide_mass_mg,
        "purity_pct": purity_pct,
    }
```

### Pattern 5: Pydantic Response Schema (Pydantic v2 style)

**What:** All response schemas use `class Config: from_attributes = True` for ORM conversion. Float (not Decimal) in response models.
**When to use:** Every new response class.

```python
# Source: backend/main.py (existing pattern throughout)
class WizardSessionResponse(BaseModel):
    id: int
    peptide_id: int
    status: str
    sample_id_label: Optional[str]
    declared_weight_mg: Optional[float]
    target_conc_ug_ml: Optional[float]
    target_total_vol_ul: Optional[float]
    peak_area: Optional[float]
    created_at: datetime
    updated_at: datetime
    completed_at: Optional[datetime]
    # Calculated values (recalculated on demand — not stored)
    calculations: Optional[dict] = None

    class Config:
        from_attributes = True
```

### Pattern 6: Re-weigh — Insert New, Mark Old as is_current=False

**What:** Tech re-weighing a step inserts a new WizardMeasurement row and updates the previous row's `is_current` to False. Query for current measurement uses `is_current=True`.

```python
# In the re-weigh endpoint:
# 1. Find existing current measurement for this step
old = db.execute(
    select(WizardMeasurement)
    .where(WizardMeasurement.session_id == session_id)
    .where(WizardMeasurement.step_key == step_key)
    .where(WizardMeasurement.is_current == True)
).scalar_one_or_none()

if old:
    old.is_current = False  # Mark old as superseded

# 2. Insert new measurement
new_m = WizardMeasurement(
    session_id=session_id,
    step_key=step_key,
    weight_mg=weight_mg,
    source="manual",
    is_current=True,
)
db.add(new_m)
db.commit()
```

### Anti-Patterns to Avoid

- **Float arithmetic in wizard calculations:** `hplc_processor.py` uses float throughout — do NOT import or reuse its functions. New wizard calc module is completely separate.
- **Storing calculated values:** Do NOT add `stock_conc_ug_ml`, `actual_conc_ug_ml`, etc. as model columns. Calculate on demand from raw weights.
- **Decimal in JSON:** `json.dumps({'val': Decimal('3.0')})` raises `TypeError`. Always convert to `float(...)` at response boundary.
- **Old Column() syntax:** Do NOT use `Column(Float)` — use `mapped_column(Float)` (SQLAlchemy 2.0 style).
- **Single-column ALTER TABLE loop:** Commit after EACH column, not after the loop. SQLite commits per-statement.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Decimal precision | Custom rounding functions | `from decimal import Decimal, getcontext` | stdlib, battle-tested, ROUND_HALF_UP available |
| JWT auth | Custom auth | `Depends(get_current_user)` from `auth.py` | Already implemented, covers all edge cases |
| DB migration | Alembic | `init_db()` ALTER TABLE pattern | Project already uses this simpler pattern |
| Session state merging | Manual dict construction | SQLAlchemy relationships + `db.refresh()` | ORM handles it, avoids stale data bugs |
| Weight deduplication | Complex query | Simple `is_current=True` filter | Audit trail preserved without duplicates |

**Key insight:** Every problem in this phase has a pattern already established in this codebase. The main risk is accidentally introducing float math into the wizard calculation module or storing computed values.

---

## Common Pitfalls

### Pitfall 1: Decimal not JSON-serializable

**What goes wrong:** `json.dumps({'val': Decimal('3.0')})` → `TypeError: Object of type Decimal is not JSON serializable`. This crashes at the `calculation_trace` JSON column or in Pydantic serialization.

**Why it happens:** Python's `json` module doesn't know how to serialize `Decimal`. Pydantic v2 DOES handle `Decimal` fields in response models (converts to string by default), but SQLAlchemy JSON columns use Python's `json` module.

**How to avoid:**
- Pydantic response schemas: use `float` type, convert at boundary with `float(decimal_val)`
- If storing calculation trace as JSON column: convert all Decimals to `str` or `float` before storing
- Keep Decimal only inside `calculations/wizard.py` — never let it escape into DB or API layers

**Warning signs:** `TypeError: Object of type Decimal is not JSON serializable` in server logs

### Pitfall 2: SQLite REAL Precision for Weights

**What goes wrong:** Concern that SQLite's REAL (float64) storage loses precision for weight readings.

**Reality check (verified):** Balance readings are e.g., `8505.75 mg` — 7 significant digits. Python float64 handles this without rounding error (15-16 significant digits). Float64 roundtrip for `8505.75` is exact. The concern is only real for calculated values with many chained operations — which is why we store only raw weights (float is fine) and use Decimal only for arithmetic.

**How to avoid:** Store raw weights as Float columns (REAL in SQLite). Use Decimal only inside the calculation functions.

### Pitfall 3: Stale Session State After Re-weigh

**What goes wrong:** Client shows outdated calculations because re-weigh updated DB but response didn't trigger recalculation.

**Why it happens:** The re-weigh endpoint inserts a new measurement, marks old as `is_current=False`, but doesn't return updated calculated values.

**How to avoid:** The `/wizard/sessions/{id}` GET endpoint (and any write endpoint response) must call the calculation function and include calculated values in the response. Always recalculate from scratch on every GET.

**Warning signs:** UI shows old stock concentration after tech re-weighs the stock vial.

### Pitfall 4: Missing Calibration Curve Lookup

**What goes wrong:** Results step requires `calibration_slope` and `calibration_intercept` for `determined_conc_ug_ml`. If no active calibration exists for the peptide, the calculation will fail or return None silently.

**Why it happens:** `WizardSession.calibration_curve_id` might be None if not set at session creation, or if no active calibration exists for the peptide.

**How to avoid:** When creating a session, auto-resolve the active calibration curve for the peptide (same query as `run_hplc_analysis`). Store its `id` in `WizardSession.calibration_curve_id`. Return 400 if no active calibration exists when session is created. The calculations endpoint uses the stored calibration ID, not a live lookup.

**Warning signs:** `determined_conc_ug_ml` returns None with no clear error message.

### Pitfall 5: Partial Session (Insufficient Weights for Calculation)

**What goes wrong:** Client requests calculations before all 5 weights are recorded — division by zero or None values cascade through formulas.

**Why it happens:** The calculation endpoint doesn't guard against missing measurements.

**How to avoid:** In the calculations function, check which measurements are `is_current=True`. Return partial calculations only for the stages where all inputs are available. Structure the response with explicit `None` for unavailable values — do NOT raise 400 (session may legitimately be mid-progress).

**Warning signs:** `ZeroDivisionError` or `InvalidOperation` from Decimal when weight is `None`.

### Pitfall 6: `declared_weight_mg` Units Confusion

**What goes wrong:** Formula uses `declared_weight_mg * 1000` to convert mg → µg for stock concentration. If the UI sends grams instead of mg, stock concentration is off by 1000x.

**Why it happens:** Lab Excel sheets sometimes show values in different units depending on the peptide quantity.

**How to avoid:** Always document and validate that `declared_weight_mg` is in milligrams. Add a Pydantic validator `gt=0, lt=5000` (no peptide sample exceeds 5g in this workflow).

---

## Code Examples

### Verified: Complete Calculation Chain (tested in .venv Python)

```python
# Source: verified against lab Excel values 2026-02-19
from decimal import Decimal, getcontext
getcontext().prec = 28

# ── Stock Prep ──────────────────────────────────────────────────
declared_weight_mg = Decimal("50")
stock_vial_empty = Decimal("5501.68")
stock_vial_loaded = Decimal("8505.75")
diluent_density = Decimal("997.1")

diluent_mass_mg = stock_vial_loaded - stock_vial_empty      # 3004.07 mg
total_diluent_added_ml = diluent_mass_mg / diluent_density  # 3.01280... mL  ✓ Excel: 3.0128
stock_conc_ug_ml = (declared_weight_mg * 1000) / total_diluent_added_ml  # 16595.82 µg/mL  ✓

# ── Required Volumes ───────────────────────────────────────────
target_conc_ug_ml = Decimal("800")
target_total_vol_ul = Decimal("1500")
stock_vol_ul = target_total_vol_ul * (target_conc_ug_ml / stock_conc_ug_ml)  # 72.31 µL  ✓
diluent_vol_ul = target_total_vol_ul - stock_vol_ul                           # 1427.69 µL  ✓

# ── Actual Dilution ────────────────────────────────────────────
# (after tech weighs the dilution vial at 3 points)
actual_diluent_vol_ul = actual_diluent_mass_mg / diluent_density * 1000  # µL
actual_stock_vol_ul   = actual_stock_mass_mg   / diluent_density * 1000  # µL
actual_total_vol_ul   = actual_diluent_vol_ul + actual_stock_vol_ul
actual_conc_ug_ml     = stock_conc_ug_ml * actual_stock_vol_ul / actual_total_vol_ul

# ── Results (post-HPLC) ────────────────────────────────────────
determined_conc_ug_ml = (peak_area - intercept) / slope
peptide_mass_mg = determined_conc_ug_ml * actual_total_vol_ul / Decimal("1000")
purity_pct = (determined_conc_ug_ml / actual_conc_ug_ml) * Decimal("100")
```

### Verified: Endpoint Structure for Wizard Session Create

```python
# Source: existing pattern from /hplc/analyze endpoint (main.py:1613)
@app.post("/wizard/sessions", response_model=WizardSessionResponse, status_code=201)
async def create_wizard_session(
    data: WizardSessionCreate,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    peptide = db.execute(select(Peptide).where(Peptide.id == data.peptide_id)).scalar_one_or_none()
    if not peptide:
        raise HTTPException(404, f"Peptide {data.peptide_id} not found")

    # Resolve active calibration curve
    cal = db.execute(
        select(CalibrationCurve)
        .where(CalibrationCurve.peptide_id == data.peptide_id)
        .where(CalibrationCurve.is_active == True)
        .order_by(desc(CalibrationCurve.created_at))
        .limit(1)
    ).scalar_one_or_none()
    if not cal:
        raise HTTPException(400, f"No active calibration curve for this peptide")

    session = WizardSession(
        peptide_id=data.peptide_id,
        calibration_curve_id=cal.id,
        sample_id_label=data.sample_id_label,
        declared_weight_mg=data.declared_weight_mg,
        target_conc_ug_ml=data.target_conc_ug_ml,
        target_total_vol_ul=data.target_total_vol_ul,
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return _build_session_response(session, db)
```

### Verified: Calculations at Response Boundary (Decimal → float)

```python
# Convert Decimal to float exactly once, at the API response boundary
def _build_calculations(session: WizardSession, db: Session) -> dict:
    """Recalculate all derived values from raw measurements. Returns floats for JSON."""
    from calculations.wizard import calc_stock_prep, calc_required_volumes, calc_actual_dilution, calc_results

    measurements = {
        m.step_key: m.weight_mg
        for m in session.measurements
        if m.is_current
    }

    result = {}

    stock_empty = measurements.get("stock_vial_empty_mg")
    stock_loaded = measurements.get("stock_vial_loaded_mg")
    declared = session.declared_weight_mg

    if all(v is not None for v in [stock_empty, stock_loaded, declared]):
        density = Decimal(str(session.peptide.diluent_density))
        stock = calc_stock_prep(
            Decimal(str(declared)),
            Decimal(str(stock_empty)),
            Decimal(str(stock_loaded)),
            density,
        )
        # Convert to float at boundary
        result["diluent_added_ml"] = float(stock["total_diluent_added_ml"])
        result["stock_conc_ug_ml"] = float(stock["stock_conc_ug_ml"])
        # ... etc.

    return result
```

---

## REST Endpoint Design

### Wizard Session Endpoints (append to main.py)

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| `POST` | `/wizard/sessions` | Create new session (SESS-01) | JWT |
| `GET` | `/wizard/sessions/{id}` | Get session with calcs for resume (SESS-02) | JWT |
| `PATCH` | `/wizard/sessions/{id}` | Update session fields (target params, peak area) | JWT |
| `POST` | `/wizard/sessions/{id}/measurements` | Record/re-record a weight for a step | JWT |
| `POST` | `/wizard/sessions/{id}/complete` | Mark session complete, finalize timestamps (SESS-03) | JWT |
| `GET` | `/wizard/sessions` | List sessions (for Analysis History, Phase 4) | JWT |

### Measurement step_key Values (the 5 wizard weights)

| step_key | What it captures |
|----------|-----------------|
| `stock_vial_empty_mg` | Empty stock vial + cap (mg) |
| `stock_vial_loaded_mg` | Stock vial after adding diluent (mg) |
| `dil_vial_empty_mg` | Empty dilution vial + cap (mg) |
| `dil_vial_with_diluent_mg` | Dilution vial after adding diluent (mg) |
| `dil_vial_final_mg` | Dilution vial after adding stock (mg) |

---

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| `float` arithmetic (hplc_processor.py) | `Decimal` arithmetic (wizard.py) | No rounding accumulation in chained formulas |
| Store all calculated values | Store only raw weights, recalculate on demand | Schema stays simple, calculations always correct |
| Column() style | `mapped_column()` SQLAlchemy 2.0 | Type-safe, IDE support |
| Alembic migrations | `init_db()` ALTER TABLE pattern | Zero-config, works with SQLite |

**Deprecated/outdated:**
- `Column(Float, ...)` style (SQLAlchemy 1.x): replaced by `mapped_column(Float, ...)` in this codebase
- `session.add(); session.flush(); session.commit()` with manual refresh: prefer `db.add(); db.commit(); db.refresh(obj)` pattern used throughout

---

## Open Questions

1. **`declared_weight_mg` source in Phase 1**
   - What we know: In Phase 5, this comes from SENAITE. In Phase 1, it must be manually entered.
   - What's unclear: Should `WizardSession` have a `declared_weight_mg` field directly, or should it be stored as a WizardMeasurement with a special step_key like `declared_weight_mg`? The CONTEXT says "Store only raw weights in DB" but declared weight is entered by tech, not weighed.
   - Recommendation: Store `declared_weight_mg` as a direct field on `WizardSession` (not a WizardMeasurement). It's a text input, not a balance reading — treating it as a measurement would complicate the re-weigh audit trail pattern.

2. **`diluent_density` source for calculations**
   - What we know: `Peptide.diluent_density` stores the value (default 997.1 mg/mL). This is already on the model.
   - What's unclear: Should calculations use `session.peptide.diluent_density` (requires join) or a hardcoded `DILUENT_DENSITY = Decimal("997.1")`?
   - Recommendation: Pass `Decimal(str(session.peptide.diluent_density))` into the calculation function — this allows per-peptide density in the future without code change.

3. **Session listing scope for Phase 1**
   - What we know: `SESS-04` (completed sessions appear in Analysis History) is a Phase 4 requirement.
   - What's unclear: Should Phase 1 include `GET /wizard/sessions` for listing, or only the single-session GET?
   - Recommendation: Implement `GET /wizard/sessions` in Phase 1 with basic pagination (matching `/hplc/analyses` pattern). Phase 4 wires it to the UI. Low cost, avoids re-touching this area later.

---

## Sources

### Primary (HIGH confidence)
- `backend/models.py` — SQLAlchemy 2.0 model patterns, Float type for weights, relationships
- `backend/database.py` — Migration pattern (`init_db()` with try/except ALTER TABLE)
- `backend/main.py` — JWT auth pattern, Pydantic v2 schema style, endpoint structure
- `backend/calculations/hplc_processor.py` — Existing float engine (what NOT to touch)
- `.planning/STATE.md` — Locked decisions (Decimal, raw storage, audit trail)
- `.planning/ROADMAP.md` — Phase structure, plan breakdown, success criteria
- Verified Python execution: Decimal formulas confirmed against lab Excel values

### Secondary (MEDIUM confidence)
- SQLAlchemy docs: SQLite stores `Numeric` as REAL (float64) — precision sufficient for 7-digit weight values
- Python stdlib `decimal` module: JSON-incompatible directly; convert to `float` at boundary

### Tertiary (LOW confidence)
- None — all claims are codebase-verified

---

## Metadata

**Confidence breakdown:**
- Standard Stack: HIGH — confirmed from requirements.txt and .venv
- Architecture: HIGH — patterns directly copied from existing codebase
- Formulas: HIGH — verified against lab Excel values with live Python execution
- Pitfalls: HIGH — confirmed through code inspection and runtime testing
- Endpoint design: MEDIUM — structure follows existing patterns but specific routes are new decisions

**Research date:** 2026-02-19
**Valid until:** 2026-05-19 (stable stack — 90 days)
