"""
SQLAlchemy models for Accu-Mk1 database.
Uses SQLAlchemy 2.0 style with mapped_column.
"""

from datetime import datetime
from typing import Optional
from sqlalchemy import String, Text, DateTime, ForeignKey, JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


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
    """
    __tablename__ = "samples"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id"), nullable=False)
    filename: Mapped[str] = mapped_column(String(500), nullable=False)
    status: Mapped[str] = mapped_column(String(50), default="pending", nullable=False)
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
