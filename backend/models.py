"""
SQLAlchemy models for Accu-Mk1 database.
Uses SQLAlchemy 2.0 style with mapped_column.
"""

from datetime import datetime
from typing import Optional
from sqlalchemy import String, Text, Float, Boolean, DateTime, ForeignKey, JSON
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


class Peptide(Base):
    """
    Peptide reference data for HPLC analysis.
    Stores expected retention time, tolerance, and diluent density.
    """
    __tablename__ = "peptides"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    abbreviation: Mapped[str] = mapped_column(String(50), nullable=False, unique=True)
    reference_rt: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    rt_tolerance: Mapped[float] = mapped_column(Float, default=0.5)
    diluent_density: Mapped[float] = mapped_column(Float, default=997.1)  # mg/mL for water
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    calibration_curves: Mapped[list["CalibrationCurve"]] = relationship(
        "CalibrationCurve", back_populates="peptide", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:
        return f"<Peptide(id={self.id}, abbreviation='{self.abbreviation}')>"


class CalibrationCurve(Base):
    """
    Calibration curve for a peptide.
    Stores linear regression parameters (slope, intercept, R²)
    and the original standard data used to derive them.
    """
    __tablename__ = "calibration_curves"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    peptide_id: Mapped[int] = mapped_column(ForeignKey("peptides.id"), nullable=False)
    slope: Mapped[float] = mapped_column(Float, nullable=False)
    intercept: Mapped[float] = mapped_column(Float, nullable=False)
    r_squared: Mapped[float] = mapped_column(Float, nullable=False)
    standard_data: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)  # {concentrations: [], areas: []}
    source_filename: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    peptide: Mapped["Peptide"] = relationship("Peptide", back_populates="calibration_curves")

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
