"""
SQLAlchemy models for Accu-Mk1 database.
Uses SQLAlchemy 2.0 style with mapped_column.
"""

from datetime import datetime
from typing import Optional
from sqlalchemy import String, Text, Float, Integer, Boolean, DateTime, ForeignKey, JSON, Column, Table, UniqueConstraint, CheckConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


class User(Base):
    """
    User account for authentication.
    Roles: 'admin' or 'standard'.
    """
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(1024), nullable=False)
    role: Mapped[str] = mapped_column(String(20), default="standard", nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    senaite_password_encrypted: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    def __repr__(self) -> str:
        return f"<User(id={self.id}, email='{self.email}', role='{self.role}')>"


class AuditLog(Base):
    """
    Audit log for all operations.
    Tracks every significant action for compliance and debugging.
    """
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    operation: Mapped[str] = mapped_column(String(100), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(50), nullable=False)
    entity_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    details: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    def __repr__(self) -> str:
        return f"<AuditLog(id={self.id}, operation='{self.operation}', entity_type='{self.entity_type}')>"


class Job(Base):
    """
    Represents a batch import job.
    A job contains multiple samples from a source directory.
    """
    __tablename__ = "jobs"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    status: Mapped[str] = mapped_column(String(50), default="pending", nullable=False)
    source_directory: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    # Relationship to samples
    samples: Mapped[list["Sample"]] = relationship("Sample", back_populates="job", cascade="all, delete-orphan")

    def __repr__(self) -> str:
        return f"<Job(id={self.id}, status='{self.status}')>"


class Sample(Base):
    """
    Represents a single sample within a job.
    Each sample corresponds to one HPLC export file.

    Status lifecycle: pending -> calculated -> approved/rejected
    """
    __tablename__ = "samples"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id"), nullable=False)
    filename: Mapped[str] = mapped_column(String(500), nullable=False)
    status: Mapped[str] = mapped_column(String(50), default="pending", nullable=False)
    input_data: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)  # Raw parsed data from file
    rejection_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # Reason when status=rejected
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    job: Mapped["Job"] = relationship("Job", back_populates="samples")
    results: Mapped[list["Result"]] = relationship("Result", back_populates="sample", cascade="all, delete-orphan")

    def __repr__(self) -> str:
        return f"<Sample(id={self.id}, filename='{self.filename}', status='{self.status}')>"


class Result(Base):
    """
    Calculation result for a sample.
    Stores input and output data for each calculation type.
    """
    __tablename__ = "results"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    sample_id: Mapped[int] = mapped_column(ForeignKey("samples.id"), nullable=False)
    calculation_type: Mapped[str] = mapped_column(String(100), nullable=False)
    input_data: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    output_data: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationship
    sample: Mapped["Sample"] = relationship("Sample", back_populates="results")

    def __repr__(self) -> str:
        return f"<Result(id={self.id}, calculation_type='{self.calculation_type}')>"


class Instrument(Base):
    """
    Laboratory instrument synced from Senaite.
    Each instrument can be associated with multiple HPLC methods.
    """
    __tablename__ = "instruments"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    senaite_id: Mapped[Optional[str]] = mapped_column(String(200), nullable=True, unique=True)
    senaite_uid: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    instrument_type: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)  # "HPLC"
    brand: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)  # "Agilent"
    model: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)  # "1290", "1260"
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def __repr__(self) -> str:
        return f"<Instrument(id={self.id}, name='{self.name}')>"


class AnalysisService(Base):
    """
    Senaite Analysis Service — master list of lab tests.
    Synced from Senaite's AnalysisService portal type.
    """
    __tablename__ = "analysis_services"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(300), nullable=False)  # "BPC157 – Purity (HPLC)"
    keyword: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)  # "BPC157-PURITY"
    category: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)  # "HPLC"
    unit: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)  # "%", "mg", "EU/mL"
    methods: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)  # [{uid, title}, ...]
    peptide_name: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)  # derived: "AICAR"
    senaite_id: Mapped[Optional[str]] = mapped_column(String(200), nullable=True, unique=True)
    senaite_uid: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def __repr__(self) -> str:
        return f"<AnalysisService(id={self.id}, title='{self.title}')>"


# M2M junction: peptide <-> method (one method per instrument per peptide, enforced at app level)
peptide_methods = Table(
    "peptide_methods",
    Base.metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("peptide_id", Integer, ForeignKey("peptides.id", ondelete="CASCADE"), nullable=False),
    Column("method_id", Integer, ForeignKey("hplc_methods.id", ondelete="CASCADE"), nullable=False),
    UniqueConstraint("peptide_id", "method_id", name="uq_peptide_method"),
)


class HplcMethod(Base):
    """
    HPLC analytical method definition.
    Stores instrument settings and run parameters that apply to groups of peptides.
    Methods are sourced from Senaite but metadata is stored locally.
    """
    __tablename__ = "hplc_methods"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    senaite_id: Mapped[Optional[str]] = mapped_column(String(200), nullable=True, unique=True)
    instrument_id: Mapped[Optional[int]] = mapped_column(ForeignKey("instruments.id"), nullable=True)
    size_peptide: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)  # "Extremely Polar", "3-9 (Very Polar)", etc.
    starting_organic_pct: Mapped[Optional[float]] = mapped_column(Float, nullable=True)  # Starting organic amount %
    temperature_mct_c: Mapped[Optional[float]] = mapped_column(Float, nullable=True)  # Mobile column temperature °C
    dissolution: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)  # e.g. "100% Water", "100 Water w/ 0.1% TFA"
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    instrument: Mapped[Optional["Instrument"]] = relationship("Instrument")
    peptides: Mapped[list["Peptide"]] = relationship("Peptide", secondary=peptide_methods, back_populates="methods")

    def __repr__(self) -> str:
        return f"<HplcMethod(id={self.id}, name='{self.name}')>"


# M2M junction: blend peptide <-> component peptides
blend_components = Table(
    "blend_components",
    Base.metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("blend_id", Integer, ForeignKey("peptides.id", ondelete="CASCADE"), nullable=False),
    Column("component_id", Integer, ForeignKey("peptides.id", ondelete="CASCADE"), nullable=False),
    Column("display_order", Integer, default=0),
    Column("vial_number", Integer, default=1),
    UniqueConstraint("blend_id", "component_id", name="uq_blend_component"),
)


class Peptide(Base):
    """
    Peptide reference data for HPLC analysis.
    Each peptide can be assigned one method per instrument.
    Per-curve parameters (reference_rt, rt_tolerance, diluent_density) live on CalibrationCurve.
    Blends (is_blend=True) group other peptides via blend_components junction table.
    """
    __tablename__ = "peptides"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    abbreviation: Mapped[str] = mapped_column(String(50), nullable=False, unique=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_blend: Mapped[bool] = mapped_column(Boolean, default=False)
    prep_vial_count: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    methods: Mapped[list["HplcMethod"]] = relationship("HplcMethod", secondary=peptide_methods, back_populates="peptides")
    calibration_curves: Mapped[list["CalibrationCurve"]] = relationship(
        "CalibrationCurve", back_populates="peptide", cascade="all, delete-orphan"
    )
    analytes: Mapped[list["PeptideAnalyte"]] = relationship(
        "PeptideAnalyte", back_populates="peptide", cascade="all, delete-orphan",
        order_by="PeptideAnalyte.slot",
        foreign_keys="[PeptideAnalyte.peptide_id]",
    )
    components: Mapped[list["Peptide"]] = relationship(
        "Peptide",
        secondary=blend_components,
        primaryjoin="Peptide.id == blend_components.c.blend_id",
        secondaryjoin="Peptide.id == blend_components.c.component_id",
        order_by="blend_components.c.display_order",
    )

    def __repr__(self) -> str:
        return f"<Peptide(id={self.id}, abbreviation='{self.abbreviation}')>"


class PeptideAnalyte(Base):
    """
    Junction row connecting a Peptide Standard to one AnalysisService.
    Each peptide has up to 4 analyte slots (slot 1-4).
    sample_id is the Senaite sample ID for the standard reference vial.
    """
    __tablename__ = "peptide_analytes"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    peptide_id: Mapped[int] = mapped_column(
        ForeignKey("peptides.id", ondelete="CASCADE"), nullable=False
    )
    analysis_service_id: Mapped[int] = mapped_column(
        ForeignKey("analysis_services.id", ondelete="CASCADE"), nullable=False
    )
    sample_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    slot: Mapped[int] = mapped_column(Integer, nullable=False)
    component_peptide_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("peptides.id", ondelete="SET NULL"), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("peptide_id", "slot", name="uq_peptide_analyte_slot"),
        CheckConstraint("slot >= 1 AND slot <= 4", name="ck_peptide_analyte_slot_range"),
    )

    peptide: Mapped["Peptide"] = relationship("Peptide", back_populates="analytes", foreign_keys=[peptide_id])
    analysis_service: Mapped["AnalysisService"] = relationship("AnalysisService")
    component_peptide: Mapped[Optional["Peptide"]] = relationship("Peptide", foreign_keys=[component_peptide_id])

    def __repr__(self) -> str:
        return f"<PeptideAnalyte(peptide_id={self.peptide_id}, slot={self.slot})>"


class CalibrationCurve(Base):
    """
    Calibration curve for a peptide standard.
    Stores linear regression parameters (slope, intercept, R²)
    and the original standard data used to derive them.
    """
    __tablename__ = "calibration_curves"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    peptide_id: Mapped[int] = mapped_column(ForeignKey("peptides.id"), nullable=False)
    peptide_analyte_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("peptide_analytes.id", ondelete="SET NULL"), nullable=True
    )
    # Per-curve parameters (moved from Peptide)
    reference_rt: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    rt_tolerance: Mapped[Optional[float]] = mapped_column(Float, nullable=True, default=0.5)
    diluent_density: Mapped[Optional[float]] = mapped_column(Float, nullable=True, default=997.1)  # mg/mL for water
    slope: Mapped[float] = mapped_column(Float, nullable=False)
    intercept: Mapped[float] = mapped_column(Float, nullable=False)
    r_squared: Mapped[float] = mapped_column(Float, nullable=False)
    standard_data: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)  # {concentrations: [], areas: [], rts: []}
    source_filename: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    source_path: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)  # Full SharePoint relative path
    source_date: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)  # File last-modified date from SharePoint
    sharepoint_url: Mapped[Optional[str]] = mapped_column(String(2000), nullable=True)  # Direct web URL from Graph API
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # --- Standard identification metadata (Phase 1: populated from filename/path on import) ---
    source_sample_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)  # Senaite sample ID (e.g. "P-0111")
    instrument: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)    # "1260" or "1290"
    vendor: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)       # Cayman, Targetmol, HYB, etc.
    lot_number: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)   # Vendor lot # (e.g. "27262", "#63162")
    batch_number: Mapped[Optional[str]] = mapped_column(String(100), nullable=True) # Secondary batch code (e.g. "T20561L")
    cap_color: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)     # Physical vial cap color
    run_date: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)   # Date standard was run (from filename)

    # --- Wizard fields (Phase 2: populated when creating standards directly in AccuMk1) ---
    standard_weight_mg: Mapped[Optional[float]] = mapped_column(Float, nullable=True)       # mg in supplier vial
    stock_concentration_ug_ml: Mapped[Optional[float]] = mapped_column(Float, nullable=True) # Calculated stock conc
    diluent: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)              # Dissolution solvent
    column_type: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)         # HPLC column used
    wavelength_nm: Mapped[Optional[float]] = mapped_column(Float, nullable=True)            # Detection wavelength
    flow_rate_ml_min: Mapped[Optional[float]] = mapped_column(Float, nullable=True)         # Flow rate
    injection_volume_ul: Mapped[Optional[float]] = mapped_column(Float, nullable=True)      # Injection volume
    operator: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)             # Who ran the standard
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)                       # Free-form notes

    # Relationships
    peptide: Mapped["Peptide"] = relationship("Peptide", back_populates="calibration_curves")
    analyte: Mapped[Optional["PeptideAnalyte"]] = relationship("PeptideAnalyte")

    def __repr__(self) -> str:
        return f"<CalibrationCurve(id={self.id}, peptide_id={self.peptide_id}, slope={self.slope})>"


class HPLCAnalysis(Base):
    """
    Complete HPLC analysis record.
    Stores all inputs, intermediate calculations, and final results.
    """
    __tablename__ = "hplc_analyses"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    sample_id_label: Mapped[str] = mapped_column(String(200), nullable=False)  # e.g., "P-0142"
    peptide_id: Mapped[int] = mapped_column(ForeignKey("peptides.id"), nullable=False)

    # Tech inputs: 5 balance weights (mg)
    stock_vial_empty: Mapped[float] = mapped_column(Float, nullable=False)
    stock_vial_with_diluent: Mapped[float] = mapped_column(Float, nullable=False)
    dil_vial_empty: Mapped[float] = mapped_column(Float, nullable=False)
    dil_vial_with_diluent: Mapped[float] = mapped_column(Float, nullable=False)
    dil_vial_with_diluent_and_sample: Mapped[float] = mapped_column(Float, nullable=False)

    # Intermediate calculations
    dilution_factor: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    stock_volume_ml: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    avg_main_peak_area: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    concentration_ug_ml: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    # Final results
    purity_percent: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    quantity_mg: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    identity_conforms: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    identity_rt_delta: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    # Full audit data
    calculation_trace: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    raw_data: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)  # Parsed injection data
    status: Mapped[str] = mapped_column(String(50), default="completed")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    peptide: Mapped["Peptide"] = relationship("Peptide")

    def __repr__(self) -> str:
        return f"<HPLCAnalysis(id={self.id}, sample='{self.sample_id_label}', purity={self.purity_percent})>"


class SharePointFileCache(Base):
    """
    Tracks SharePoint files already downloaded during peptide seeding.
    Prevents re-downloading files that don't produce calibration curves
    (e.g., sample data files, workbooks without standard data).
    """
    __tablename__ = "sharepoint_file_cache"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    source_path: Mapped[str] = mapped_column(String(1000), unique=True, nullable=False)
    peptide_abbreviation: Mapped[str] = mapped_column(String(100), nullable=False)
    produced_calibration: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    def __repr__(self) -> str:
        return f"<SharePointFileCache(path='{self.source_path}', cal={self.produced_calibration})>"


class Settings(Base):
    """
    Application settings stored as key-value pairs.
    Used for column mappings, report directory, and other configuration.
    """
    __tablename__ = "settings"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    key: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    value: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def __repr__(self) -> str:
        return f"<Settings(id={self.id}, key='{self.key}')>"


class WizardSession(Base):
    """
    Wizard session record. One session = one sample prep run.
    Status lifecycle: 'in_progress' | 'completed'

    declared_weight_mg is stored here (not as WizardMeasurement) because it is
    a manually entered text value, not a balance reading.
    """
    __tablename__ = "wizard_sessions"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    peptide_id: Mapped[int] = mapped_column(ForeignKey("peptides.id"), nullable=False)
    calibration_curve_id: Mapped[Optional[int]] = mapped_column(ForeignKey("calibration_curves.id", ondelete="SET NULL"), nullable=True)
    status: Mapped[str] = mapped_column(String(50), default="in_progress", nullable=False)

    # Step 1: Sample info
    sample_id_label: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    declared_weight_mg: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    # Step 1b: Target dilution parameters (manually entered)
    target_conc_ug_ml: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    target_total_vol_ul: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    # Multi-vial: per-vial target params (declared_weight, target_conc, target_vol per vial)
    # Keyed by vial number string: {"1": {...}, "2": {...}}
    vial_params: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

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
    calibration_curve: Mapped[Optional["CalibrationCurve"]] = relationship("CalibrationCurve")

    def __repr__(self) -> str:
        return f"<WizardSession(id={self.id}, status='{self.status}')>"


class WizardMeasurement(Base):
    """
    Individual balance reading within a wizard session.
    Re-weighing inserts a NEW record and sets is_current=False on the old one.
    This preserves the full audit trail.

    step_key values (exactly these 5 strings):
      'stock_vial_empty_mg'       - Empty stock vial + cap
      'stock_vial_loaded_mg'      - Stock vial after adding diluent
      'dil_vial_empty_mg'         - Empty dilution vial + cap
      'dil_vial_with_diluent_mg'  - Dilution vial after adding diluent
      'dil_vial_final_mg'         - Dilution vial after adding stock aliquot

    source: 'manual' (Phase 1) | 'scale' (Phase 2 adds this)
    """
    __tablename__ = "wizard_measurements"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("wizard_sessions.id"), nullable=False)
    step_key: Mapped[str] = mapped_column(String(50), nullable=False)
    weight_mg: Mapped[float] = mapped_column(Float, nullable=False)
    source: Mapped[str] = mapped_column(String(20), default="manual", nullable=False)
    vial_number: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    is_current: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    session: Mapped["WizardSession"] = relationship("WizardSession", back_populates="measurements")

    def __repr__(self) -> str:
        return f"<WizardMeasurement(session={self.session_id}, step='{self.step_key}', weight={self.weight_mg})>"
