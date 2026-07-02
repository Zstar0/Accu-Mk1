"""
SQLAlchemy models for Accu-Mk1 database.
Uses SQLAlchemy 2.0 style with mapped_column.
"""

from datetime import datetime, time, date
from typing import Optional, List
import uuid
from sqlalchemy import String, Text, Float, Integer, Boolean, DateTime, Time, Date, ForeignKey, JSON, Column, Table, UniqueConstraint, CheckConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
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
    first_name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    last_name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)

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

    # Relationships
    methods: Mapped[list["HplcMethod"]] = relationship("HplcMethod", secondary="instrument_methods", back_populates="instruments")

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
    # Result type + options, synced from SENAITE (local-wins) or curated locally.
    # result_type stores SENAITE's value verbatim (numeric/select/multiselect/string/...).
    # result_options is a list of {"value": str, "label": str} (select/multiselect only).
    result_type: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    result_options: Mapped[Optional[list]] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"), nullable=True
    )
    peptide_name: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)  # derived: "AICAR" (legacy)
    peptide_id: Mapped[Optional[int]] = mapped_column(ForeignKey("peptides.id", ondelete="SET NULL"), nullable=True)
    senaite_id: Mapped[Optional[str]] = mapped_column(String(200), nullable=True, unique=True)
    senaite_uid: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    # Mk1-owned override (like peptide_id / result_type): marks an analyte as a
    # variance figure. Read by the COA analyte series + assignment-page analyte
    # participation. Preserved across SENAITE re-sync (sync never writes it).
    variance_capable: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False, server_default="false"
    )

    # Relationships
    peptide: Mapped[Optional["Peptide"]] = relationship("Peptide", foreign_keys=[peptide_id])

    def __repr__(self) -> str:
        return f"<AnalysisService(id={self.id}, title='{self.title}')>"


class ServiceGroup(Base):
    """
    Service Group for grouping analysis services by department/discipline.
    Used for tech routing and worksheet organisation.
    """
    __tablename__ = "service_groups"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    color: Mapped[str] = mapped_column(String(50), nullable=False, default="blue")
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    sla_tier_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("sla_tiers.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    analysis_services: Mapped[list["AnalysisService"]] = relationship(
        "AnalysisService", secondary="service_group_members"
    )
    sla_tier: Mapped[Optional["SlaTier"]] = relationship("SlaTier")

    def __repr__(self) -> str:
        return f"<ServiceGroup(id={self.id}, name='{self.name}')>"


# M2M junction: service_group <-> analysis_service
service_group_members = Table(
    "service_group_members",
    Base.metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("service_group_id", Integer, ForeignKey("service_groups.id", ondelete="CASCADE"), nullable=False),
    Column("analysis_service_id", Integer, ForeignKey("analysis_services.id", ondelete="CASCADE"), nullable=False),
    UniqueConstraint("service_group_id", "analysis_service_id", name="uq_service_group_member"),
)


# M2M junction: instrument <-> method (methods can be shared across instruments of the same model)
instrument_methods = Table(
    "instrument_methods",
    Base.metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("instrument_id", Integer, ForeignKey("instruments.id", ondelete="CASCADE"), nullable=False),
    Column("method_id", Integer, ForeignKey("hplc_methods.id", ondelete="CASCADE"), nullable=False),
    UniqueConstraint("instrument_id", "method_id", name="uq_instrument_method"),
)


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
    size_peptide: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)  # "Extremely Polar", "3-9 (Very Polar)", etc.
    starting_organic_pct: Mapped[Optional[float]] = mapped_column(Float, nullable=True)  # Starting organic amount %
    temperature_mct_c: Mapped[Optional[float]] = mapped_column(Float, nullable=True)  # Mobile column temperature °C
    dissolution: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)  # e.g. "100% Water", "100 Water w/ 0.1% TFA"
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    instruments: Mapped[list["Instrument"]] = relationship("Instrument", secondary=instrument_methods, back_populates="methods")
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
    # Discriminator for peptide vs non-peptide HPLC analyte (e.g. Benzyl Alcohol = 'additive').
    # Filterable via GET /peptides?analyte_class=peptide — default unfiltered to preserve existing callers.
    analyte_class: Mapped[str] = mapped_column(String(20), nullable=False, default="peptide")
    prep_vial_count: Mapped[int] = mapped_column(Integer, default=1)
    hplc_aliases: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)  # ["TB17-23", "TB4"] — alternate names used in HPLC filenames
    display_aliases: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)  # ["Mounjaro", "GLP/GIP"] — approved customer-facing aliases for COA display
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # User tracking
    created_by_user_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_by_email: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)
    updated_by_user_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    updated_by_email: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)

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
    instrument: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)   # kept for legacy/display
    instrument_id: Mapped[Optional[int]] = mapped_column(ForeignKey("instruments.id"), nullable=True)
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

    # --- Phase 09: Chromatogram storage ---
    chromatogram_data: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)           # {times: number[], signals: number[]} from DAD1A CSV
    source_sharepoint_folder: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)  # SharePoint folder path

    # User tracking
    created_by_user_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_by_email: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)
    updated_by_user_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    updated_by_email: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)

    # Relationships
    peptide: Mapped["Peptide"] = relationship("Peptide", back_populates="calibration_curves")
    analyte: Mapped[Optional["PeptideAnalyte"]] = relationship("PeptideAnalyte")
    instrument_obj: Mapped[Optional["Instrument"]] = relationship("Instrument", foreign_keys="[CalibrationCurve.instrument_id]")

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

    # Phase 10.5: Provenance fields
    calibration_curve_id: Mapped[Optional[int]] = mapped_column(ForeignKey("calibration_curves.id", ondelete="SET NULL"), nullable=True)
    # NOTE: sample_prep_id is plain INTEGER — sample_preps lives in a separate database (accumark_mk1), no FK possible
    sample_prep_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    instrument_id: Mapped[Optional[int]] = mapped_column(ForeignKey("instruments.id"), nullable=True)
    source_sharepoint_folder: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    chromatogram_data: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)  # {times: number[], signals: number[]}
    run_group_id: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    debug_log: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)  # [{level, msg}] full debug log for audit trail

    # User tracking
    processed_by_user_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    processed_by_email: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)

    # Relationships
    peptide: Mapped["Peptide"] = relationship("Peptide")
    calibration_curve: Mapped[Optional["CalibrationCurve"]] = relationship("CalibrationCurve", foreign_keys="[HPLCAnalysis.calibration_curve_id]")
    instrument_obj: Mapped[Optional["Instrument"]] = relationship("Instrument", foreign_keys="[HPLCAnalysis.instrument_id]")

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
    lims_sub_sample_pk: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    declared_weight_mg: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    # Phase 09: Standard prep metadata
    is_standard: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    manufacturer: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    standard_notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    instrument_name: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    instrument_id: Mapped[Optional[int]] = mapped_column(ForeignKey("instruments.id"), nullable=True)

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
    instrument_obj: Mapped[Optional["Instrument"]] = relationship("Instrument", foreign_keys="[WizardSession.instrument_id]")

    def __repr__(self) -> str:
        return f"<WizardSession(id={self.id}, status='{self.status}')>"


class SamplePriority(Base):
    """
    Per-sample priority override for the Received Samples Inbox.
    Priority values: 'normal' | 'high' | 'expedited'
    """
    __tablename__ = "sample_priorities"

    sample_uid: Mapped[str] = mapped_column(String(50), primary_key=True)
    priority: Mapped[str] = mapped_column(String(20), nullable=False, default="normal")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def __repr__(self) -> str:
        return f"<SamplePriority(sample_uid='{self.sample_uid}', priority='{self.priority}')>"


class Worksheet(Base):
    """
    Custom AccuMark worksheet grouping received samples for analyst assignment.
    Replaces SENAITE worksheets for priority-based tech routing.
    Status lifecycle: 'open' | 'completed' | 'cancelled'
    """
    __tablename__ = "worksheets"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    status: Mapped[str] = mapped_column(String(50), default="open", nullable=False)
    assigned_analyst_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_by: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    completed_by: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def __repr__(self) -> str:
        return f"<Worksheet(id={self.id}, title='{self.title}', status='{self.status}')>"


class WorksheetItem(Base):
    """
    Individual sample row within an AccuMark worksheet.
    Stores per-item analyst assignment, service group, and instrument.
    """
    __tablename__ = "worksheet_items"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    worksheet_id: Mapped[int] = mapped_column(ForeignKey("worksheets.id", ondelete="CASCADE"), nullable=False)
    sample_uid: Mapped[str] = mapped_column(String(50), nullable=False)
    sample_id: Mapped[str] = mapped_column(String(100), nullable=False)
    analysis_uid: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    service_group_id: Mapped[Optional[int]] = mapped_column(ForeignKey("service_groups.id", ondelete="SET NULL"), nullable=True)
    priority: Mapped[str] = mapped_column(String(20), default="normal", nullable=False)
    assigned_analyst_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    instrument_uid: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    analyses_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON array of {title, keyword, peptide_name, method}
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    prep_status: Mapped[str] = mapped_column(String(20), default="ready", nullable=False, server_default="ready")
    date_received: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)  # SENAITE sample received date
    added_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    def __repr__(self) -> str:
        return f"<WorksheetItem(id={self.id}, worksheet_id={self.worksheet_id}, sample_uid='{self.sample_uid}')>"


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


class SampleAnalyteAlias(Base):
    """
    Per-sample, per-slot customer-facing alias pick for the COA.

    Denormalized alias text — stores the chosen string, not an FK to peptides.display_aliases.
    This way, changing or removing an entry from a peptide's approved alias list doesn't
    retroactively break historical COAs.

    Conformance logic still keys on the real peptide name; this table only drives display.
    """
    __tablename__ = "sample_analyte_aliases"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    senaite_sample_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    slot: Mapped[int] = mapped_column(Integer, nullable=False)
    alias: Mapped[str] = mapped_column(String(200), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    updated_by_user_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    updated_by_email: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)

    __table_args__ = (
        UniqueConstraint("senaite_sample_id", "slot", name="uq_sample_analyte_slot"),
        CheckConstraint("slot >= 1 AND slot <= 4", name="ck_sample_analyte_alias_slot_range"),
    )

    def __repr__(self) -> str:
        return f"<SampleAnalyteAlias(sample='{self.senaite_sample_id}', slot={self.slot}, alias='{self.alias}')>"


class LimsSample(Base):
    """Master sample record (parent of one or more LimsSubSample vials).

    Seeded lazily by the receive wizard from SENAITE today. Designed to become
    the canonical sample registry once SENAITE is sunset, hence the neutral
    `external_lims_*` columns rather than `senaite_*`.
    """
    __tablename__ = "lims_samples"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    sample_id: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    external_lims_uid: Mapped[Optional[str]] = mapped_column(String(100), index=True)
    external_lims_system: Mapped[Optional[str]] = mapped_column(String(50), default="senaite")
    client_id: Mapped[Optional[str]] = mapped_column(String(100))
    client_uid: Mapped[Optional[str]] = mapped_column(String(100))
    contact_uid: Mapped[Optional[str]] = mapped_column(String(100))
    sample_type: Mapped[Optional[str]] = mapped_column(String(100))
    status: Mapped[Optional[str]] = mapped_column(String(50))
    peptide_name: Mapped[Optional[str]] = mapped_column(String(200))
    client_sample_id: Mapped[Optional[str]] = mapped_column(String(200))
    date_sampled: Mapped[Optional[datetime]] = mapped_column(DateTime)
    date_received: Mapped[Optional[datetime]] = mapped_column(DateTime)
    is_retest: Mapped[bool] = mapped_column(Boolean, default=False)
    assignment_role: Mapped[str] = mapped_column(String(8), nullable=False, server_default="hplc")
    # TRUE = parent is a pure report depository (container-mode families,
    # 2026-06-10-container-parent-design.md): every physical vial is a
    # sub-sample (S01 = Vial 1), the parent never consumes demand and never
    # appears as a draggable vial. FALSE = legacy parent-is-vial-1 behavior.
    container_mode: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="false", default=False
    )
    # Variance set: parent shares the membership model — parent IS vial 1
    # (legacy families; container parents are never variance members).
    in_variance_set: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true", default=True)
    variance_exclusion_reason: Mapped[Optional[str]] = mapped_column(Text)
    variance_locked_at: Mapped[Optional[datetime]] = mapped_column(DateTime)
    variance_locked_by_user_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL")
    )
    # Variance addon: lab-side override until WP variance addon ships (Phase 3/4).
    # JSON-serialized map e.g. {"hplcpurity_identity": 3}; NULL means no override.
    variance_override: Mapped[Optional[str]] = mapped_column(Text)
    # Customer-facing remarks delivered with the published COA (snapshot at
    # COA generation; re-publish refreshes the customer copy). Distinct from
    # the SENAITE-backed internal Remarks field.
    customer_remarks: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # "Include with Publish?" — when False the remark is authored/saved but NOT
    # delivered with the COA (Mk1 omits lab_remarks + sends include_lab_remarks
    # false so COABuilder skips its non-conforming gate). Default TRUE preserves
    # the prior always-deliver-when-non-empty behavior.
    customer_remarks_include: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="true", default=True
    )
    # Set to utcnow() when a COA is successfully generated with remarks INCLUDED
    # (the snapshot/delivery moment Mk1 can observe). Surfaced as "Delivered on".
    customer_remarks_delivered_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    last_synced_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    sub_samples: Mapped[List["LimsSubSample"]] = relationship(
        "LimsSubSample", back_populates="parent_sample",
        cascade="all, delete-orphan", order_by="LimsSubSample.vial_sequence",
    )


class LimsSubSample(Base):
    """One physical vial received under a parent LimsSample. SENAITE id format
    `<parent>-S<NN>`, e.g. P-0134-S01."""
    __tablename__ = "lims_sub_samples"
    __table_args__ = (UniqueConstraint("parent_sample_pk", "vial_sequence", name="uq_lims_parent_vial_sequence"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    parent_sample_pk: Mapped[int] = mapped_column(Integer, ForeignKey("lims_samples.id", ondelete="CASCADE"))
    external_lims_uid: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    sample_id: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    vial_sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    received_by_user_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    photo_external_uid: Mapped[Optional[str]] = mapped_column(String(100))
    remarks: Mapped[Optional[str]] = mapped_column(Text)
    assignment_role: Mapped[Optional[str]] = mapped_column(String(8), nullable=True)
    # core | variance — workflow bucket set at check-in. NULL = not yet
    # designated. Orthogonal to in_variance_set (stats inclusion).
    assignment_kind: Mapped[Optional[str]] = mapped_column(String(8), nullable=True)
    box_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("lims_boxes.id", ondelete="SET NULL"))
    # Variance set membership (paired with lock state on parent LimsSample).
    in_variance_set: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true", default=True)
    variance_exclusion_reason: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    parent_sample: Mapped["LimsSample"] = relationship("LimsSample", back_populates="sub_samples")
    box: Mapped[Optional["LimsBox"]] = relationship("LimsBox", back_populates="vials")


class LimsBox(Base):
    """A physical check-in box/bin holding an order's vials of one test type.

    Keyed by `order_key` (the order number string as shown on labels, e.g.
    'WP-20066'; falls back to a parent sample_id for order-less receives).
    `box_number` runs 1..N per order_key across all of the order's samples.
    A box holds vials of exactly one role (color-coded bin).
    """
    __tablename__ = "lims_boxes"
    __table_args__ = (UniqueConstraint("order_key", "box_number", name="uq_lims_box_order_number"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    order_key: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    box_number: Mapped[int] = mapped_column(Integer, nullable=False)
    role: Mapped[str] = mapped_column(String(8), nullable=False)  # hplc | endo | ster | xtra
    created_by_user_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    printed_at: Mapped[Optional[datetime]] = mapped_column(DateTime)
    printed_by_user_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    # Close-out ("stored"): set when the box's testing life ends and it goes to
    # storage; its vials were returned to Unboxed. Active box = stored_at IS NULL.
    stored_at: Mapped[Optional[datetime]] = mapped_column(DateTime)
    stored_by_user_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("users.id", ondelete="SET NULL"))

    vials: Mapped[List["LimsSubSample"]] = relationship("LimsSubSample", back_populates="box")


class LimsSubSampleAttachment(Base):
    """An extra sample image attached to a vial (beyond the check-in photo,
    which lives on lims_sub_samples.photo_external_uid). Bytes are stored in
    the Mk1 photo store (sub_samples/photo_storage.py); storage_key is the
    raw key (no mk1:// prefix — these are always Mk1-stored).

    See docs/superpowers/specs/2026-06-11-subsample-attachments-design.md.
    """

    __tablename__ = "lims_sub_sample_attachments"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    sub_sample_pk: Mapped[int] = mapped_column(
        Integer, ForeignKey("lims_sub_samples.id", ondelete="CASCADE"), nullable=False
    )
    storage_key: Mapped[str] = mapped_column(String(255), nullable=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    user_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    sub_sample: Mapped["LimsSubSample"] = relationship("LimsSubSample")


class LimsPackagingPhoto(Base):
    """A packaging photo captured against a PARENT sample at check-in (and via
    the Manage Sub-Samples overlay). Distinct from vial check-in photos and
    sub-sample attachments: these document how the sample family arrived, so
    they hang off lims_samples, not a specific vial.

    Bytes live in the Mk1 photo store (sub_samples/photo_storage.py), keyed by
    the parent sample_id. storage_key holds the mk1://{key} URI (same
    convention as lims_sub_samples.photo_external_uid) so it stays consistent
    with the rest of the Mk1-native storage pointers.

    See docs/superpowers/specs/2026-06-30-packaging-photos-design.md.
    """

    __tablename__ = "lims_packaging_photos"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    parent_sample_pk: Mapped[int] = mapped_column(
        Integer, ForeignKey("lims_samples.id", ondelete="CASCADE"),
        index=True, nullable=False,
    )
    kind: Mapped[str] = mapped_column(String(20), default="packaging", nullable=False)
    storage_key: Mapped[str] = mapped_column(String(255), nullable=False)
    filename: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    content_type: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    ordering: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    remarks: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    created_by_user_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    parent_sample: Mapped["LimsSample"] = relationship("LimsSample")


class SlaTier(Base):
    """A named SLA turnaround target. Sub-project A (revised to tiers).

    Referenced by ServiceGroup.sla_tier_id and by SlaPriorityTier. Exactly one
    row has is_default=true (the catch-all, enforced by the partial unique index
    uq_sla_tier_single_default created in database._run_migrations).
    """

    __tablename__ = "sla_tiers"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    target_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    # Stored now; honored by the business-hours calendar in sub-project B.
    business_hours_only: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # D2: per-tier amber threshold. Sample is amber when remaining/target * 100 < this.
    amber_threshold_percent: Mapped[int] = mapped_column(
        Integer, nullable=False, default=20
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    def __repr__(self) -> str:
        return f"<SlaTier(id={self.id}, name='{self.name}', target_minutes={self.target_minutes})>"


class SlaPriorityTier(Base):
    """Priority -> SLA tier override, optionally scoped to a single service group.

    - service_group_id IS NULL: the row is a "global" override — applies to any
      group's analyses unless a more specific (priority, group_id) row exists.
    - service_group_id = <id>: applies ONLY when resolving analyses in that
      group; lets the lab express e.g. "expedited speeds up HPLC but does
      nothing for sterility (which still takes 7d)".

    Resolution precedence (per service-group): (priority, group_id) wins, then
    (priority, NULL), then the group's own tier, then the default tier. A row
    exists only for combinations that actually override; absence means no
    override at that precedence level.

    Schema notes: `priority` is no longer the primary key — multiple rows can
    share a priority (one per group + optionally one global). Two PARTIAL
    UNIQUE indexes enforce at most one global-per-priority and at most one
    per-(priority, group) row; see _run_migrations.
    """

    __tablename__ = "sla_priority_tiers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    priority: Mapped[str] = mapped_column(String(20), nullable=False)
    sla_tier_id: Mapped[int] = mapped_column(
        ForeignKey("sla_tiers.id", ondelete="CASCADE"), nullable=False
    )
    service_group_id: Mapped[int | None] = mapped_column(
        ForeignKey("service_groups.id", ondelete="CASCADE"), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    tier: Mapped["SlaTier"] = relationship("SlaTier")

    def __repr__(self) -> str:
        return (
            f"<SlaPriorityTier(id={self.id}, priority='{self.priority}', "
            f"service_group_id={self.service_group_id}, sla_tier_id={self.sla_tier_id})>"
        )


class BusinessHoursConfig(Base):
    """Singleton (id=1) global lab business-hours schedule (sub-project B).

    The business-minutes engine reads open/close/timezone/working_days; the
    per-tier business_hours_only flag (sub-project A) selects whether a tier uses
    it. Exactly one row, enforced by id=1 + the seed guard in _run_migrations.
    """

    __tablename__ = "business_hours_config"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=False)  # always 1; no sequence
    open_time: Mapped[time] = mapped_column(Time, nullable=False)
    close_time: Mapped[time] = mapped_column(Time, nullable=False)
    timezone: Mapped[str] = mapped_column(String(64), nullable=False, default="America/Los_Angeles")
    working_days: Mapped[list[int]] = mapped_column(JSON, nullable=False, default=lambda: [0, 1, 2, 3, 4])
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def __repr__(self) -> str:
        return f"<BusinessHoursConfig(open={self.open_time}, close={self.close_time}, tz='{self.timezone}')>"


class LabHoliday(Base):
    """A lab closure date — federal (seeded) or custom (user-added). Every row is
    removable; deleting a federal row means the lab works that day (sub-project B)."""

    __tablename__ = "lab_holidays"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    holiday_date: Mapped[date] = mapped_column(Date, nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    source: Mapped[str] = mapped_column(String(10), nullable=False, default="custom")  # 'federal' | 'custom'
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    def __repr__(self) -> str:
        return f"<LabHoliday(date={self.holiday_date}, name='{self.name}', source='{self.source}')>"


# ── COA roll-up (spec 2026-06-02-coa-rollup-override-design.md) ──


class CoaResultPin(Base):
    """
    Manager intent for which sub-sample's analysis result a parent's COA
    should report for a given analyte. Mutable — one row per
    (parent_sample_id, analyte_keyword), upserted by the override panel.
    Audit history lives in SampleActivityLog, not here.
    """

    __tablename__ = "coa_result_pins"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    parent_sample_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    analyte_keyword: Mapped[str] = mapped_column(Text, nullable=False)
    # 'pin' | 'auto' | 'variance_set'. CHECK constraint lives at the DB layer
    # in the migration; mirrored here as plain text so SQLAlchemy doesn't
    # complain about an Enum mismatch on different envs.
    mode: Mapped[str] = mapped_column(Text, nullable=False)
    source_sample_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    source_analysis_uid: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    pinned_by_user_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=True
    )
    pinned_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    __table_args__ = (
        UniqueConstraint(
            "parent_sample_id", "analyte_keyword",
            name="uq_coa_result_pins_parent_analyte",
        ),
    )

    def __repr__(self) -> str:
        return (
            f"<CoaResultPin(parent={self.parent_sample_id}, "
            f"analyte={self.analyte_keyword}, mode={self.mode})>"
        )


class CoaGenerationSource(Base):
    """
    Frozen per-generation manifest row. Written once at COA generation time;
    immutable afterwards. One row per (generation, analyte). `generation_id`
    references coa_generations.id in the integration DB (no FK because the
    two databases are separate).
    """

    __tablename__ = "coa_generation_sources"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    # UUID column on Postgres; falls back to String(36) on SQLite so the
    # test fixture in test_sub_samples_service.py (which targets SQLite)
    # can still create_all this table.
    generation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True).with_variant(String(36), "sqlite"),
        nullable=False, index=True,
    )
    generation_number: Mapped[int] = mapped_column(Integer, nullable=False)
    parent_sample_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    analyte_keyword: Mapped[str] = mapped_column(Text, nullable=False)
    source_sample_id: Mapped[str] = mapped_column(Text, nullable=False)
    source_analysis_uid: Mapped[str] = mapped_column(Text, nullable=False)
    result_value: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    result_unit: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    candidates_count: Mapped[int] = mapped_column(Integer, nullable=False)
    resolution_mode: Mapped[str] = mapped_column(Text, nullable=False)
    # Audit snapshot of the candidate list at generation time. Inlined so
    # historical-mode reads don't have to reconstruct from SENAITE. JSONB
    # on Postgres for native indexing potential; plain JSON on SQLite for
    # cross-dialect test fixtures.
    candidates_snapshot: Mapped[Optional[list]] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

    __table_args__ = (
        UniqueConstraint(
            "generation_id", "analyte_keyword",
            name="uq_coa_generation_sources_gen_analyte",
        ),
    )

    def __repr__(self) -> str:
        return (
            f"<CoaGenerationSource(gen={self.generation_id}, "
            f"analyte={self.analyte_keyword}, source={self.source_sample_id})>"
        )


class AnalysisReportable(Base):
    """
    Mk1-side sidecar for the "fit to report" boolean on a specific analysis
    instance. SENAITE analyses have no Mk1 mirror table, so the flag lives
    here keyed by (sample_id, analysis_uid). Default TRUE — absence of a row
    means the analysis IS reportable. Rows are only inserted when a tech /
    manager toggles the flag.
    """

    __tablename__ = "analysis_reportable"

    sample_id: Mapped[str] = mapped_column(Text, primary_key=True)
    analysis_uid: Mapped[str] = mapped_column(Text, primary_key=True)
    reportable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    changed_by_user_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=True
    )
    changed_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

    def __repr__(self) -> str:
        return (
            f"<AnalysisReportable(sample={self.sample_id}, "
            f"uid={self.analysis_uid}, reportable={self.reportable})>"
        )


# ── Mk1-native analyses (spec 2026-06-02-mk1-native-analyses-design.md) ──


class LimsAnalysis(Base):
    """
    Mk1-owned analysis instance. Polymorphic host: belongs to either a
    parent (lims_sample_pk) or a sub-sample (lims_sub_sample_pk) — CHECK
    constraint at the DB layer enforces exactly-one.

    Sub-sample analyses live entirely in Mk1 (no SENAITE round-trip).
    Parent analyses will migrate here in a future phase; today they
    still live in SENAITE.
    """

    __tablename__ = "lims_analyses"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)

    lims_sample_pk: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("lims_samples.id", ondelete="CASCADE"), nullable=True
    )
    lims_sub_sample_pk: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("lims_sub_samples.id", ondelete="CASCADE"), nullable=True
    )

    analysis_service_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("analysis_services.id"), nullable=False
    )
    keyword: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)

    result_value: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    result_unit: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    review_state: Mapped[str] = mapped_column(
        Text, nullable=False, default="unassigned", server_default="unassigned",
        index=True,
    )

    method_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("hplc_methods.id"), nullable=True
    )
    instrument_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("instruments.id"), nullable=True
    )
    analyst_user_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=True
    )

    captured_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    submitted_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    verified_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    published_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    retested: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    retest_of_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("lims_analyses.id"), nullable=True
    )

    reportable: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    reportable_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )
    created_by_user_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=True
    )

    transitions: Mapped[list["LimsAnalysisTransition"]] = relationship(
        "LimsAnalysisTransition",
        back_populates="analysis",
        cascade="all, delete-orphan",
        order_by="LimsAnalysisTransition.occurred_at",
    )

    def __repr__(self) -> str:
        host = (
            f"parent_pk={self.lims_sample_pk}" if self.lims_sample_pk is not None
            else f"sub_pk={self.lims_sub_sample_pk}"
        )
        return (
            f"<LimsAnalysis(id={self.id}, {host}, "
            f"kw={self.keyword!r}, state={self.review_state})>"
        )


class LimsAnalysisTransition(Base):
    """
    One row per state change on a LimsAnalysis. Append-only audit log.

    transition_kind tracks the verb that caused the state change (assign,
    submit, verify, retract, reject, retest, publish, reset, auto). The
    state-machine module enforces which kinds are legal from which
    from_states.
    """

    __tablename__ = "lims_analysis_transitions"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    analysis_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("lims_analyses.id", ondelete="CASCADE"), nullable=False
    )
    from_state: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    to_state: Mapped[str] = mapped_column(Text, nullable=False)
    transition_kind: Mapped[str] = mapped_column(Text, nullable=False)
    user_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=True
    )
    reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

    analysis: Mapped["LimsAnalysis"] = relationship(
        "LimsAnalysis", back_populates="transitions"
    )

    def __repr__(self) -> str:
        return (
            f"<LimsAnalysisTransition(analysis_id={self.analysis_id}, "
            f"{self.from_state}->{self.to_state} kind={self.transition_kind})>"
        )


class LimsSubSampleEvent(Base):
    """
    Lightweight event log for sub-sample actions that have no other audit trail.

    Writers (all in the same transaction as the action they record):
      - set_assignment_role   → event='role_assigned'   details={from, to}
      - update_sub_sample     → event='remarks_updated' details={preview}
      - delete_pristine_analysis → event='analysis_removed' details={keyword}

    user_id is nullable so automated / system-initiated paths can still write rows.
    """

    __tablename__ = "lims_sub_sample_events"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    sub_sample_pk: Mapped[int] = mapped_column(
        Integer, ForeignKey("lims_sub_samples.id", ondelete="CASCADE"), nullable=False
    )
    event: Mapped[str] = mapped_column(Text, nullable=False)
    details: Mapped[Optional[dict]] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"), nullable=True
    )
    user_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

    def __repr__(self) -> str:
        return (
            f"<LimsSubSampleEvent(id={self.id}, sub_sample_pk={self.sub_sample_pk}, "
            f"event={self.event!r})>"
        )


class LimsAnalysisPromotion(Base):
    """Phase 4a: one row per (parent-tier row, contributing vial-tier row).

    Written atomically by promote_to_parent. contribution_kind discriminates:
      'chosen' — this source's value was copied verbatim to the parent row.
      'aggregated_in' — this source was one of N inputs to a computed aggregate.
      'reference' — this source informed the decision but its value isn't part
                    of the parent's result (variance sibling not picked).
    """

    __tablename__ = "lims_analysis_promotions"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    parent_analysis_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("lims_analyses.id", ondelete="CASCADE"), nullable=False
    )
    source_analysis_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("lims_analyses.id", ondelete="CASCADE"), nullable=False
    )
    contribution_kind: Mapped[str] = mapped_column(Text, nullable=False)
    promoted_by_user_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=True
    )
    promoted_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    def __repr__(self) -> str:
        return (
            f"<LimsAnalysisPromotion(parent_id={self.parent_analysis_id}, "
            f"source_id={self.source_analysis_id}, kind={self.contribution_kind})>"
        )
