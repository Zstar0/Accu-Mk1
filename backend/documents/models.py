"""SQLAlchemy models for the documents library (spec §3).

Three tables, deliberately WITHOUT the lims_ prefix (not sample-hierarchy
entities): document_categories, documents (one row per REVISION),
document_code_counters (per-prefix minting sequence).
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Optional

from sqlalchemy import (Boolean, CheckConstraint, Date, DateTime, ForeignKey, Index,
                        Integer, String, Text, UniqueConstraint, text)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


class DocumentCategory(Base):
    """A managed category ("Artifact", "SOP", ...). `code_prefix` is immutable
    once any document uses it — the service enforces that, not the schema."""
    __tablename__ = "document_categories"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    code_prefix: Mapped[str] = mapped_column(String(10), unique=True, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True,
                                         server_default="true")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow,
                                                 nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow,
                                                 onupdate=datetime.utcnow, nullable=False)

    def __repr__(self) -> str:
        return f"<DocumentCategory(id={self.id}, name='{self.name}', prefix='{self.code_prefix}')>"


class DocumentCodeCounter(Base):
    """Next number to mint per prefix. Read + bumped under row lock (service)."""
    __tablename__ = "document_code_counters"

    prefix: Mapped[str] = mapped_column(String(10), primary_key=True)
    next_number: Mapped[int] = mapped_column(Integer, nullable=False, default=1)


class Document(Base):
    """One row per revision. Same controlled-document shape as hplc_methods
    (slice 3): (code, revision) unique, at most one 'active' row per code,
    supersedes_id chains revisions, content is never rewritten."""
    __tablename__ = "documents"
    __table_args__ = (
        UniqueConstraint("code", "revision", name="uq_documents_code_revision"),
        CheckConstraint("status IN ('draft','active','retired')",
                        name="ck_documents_status"),
        Index("uq_documents_code_active", "code", unique=True,
              postgresql_where=text("status = 'active'"),
              sqlite_where=text("status = 'active'")),
        Index("ix_documents_category_id", "category_id"),
        Index("ix_documents_status", "status"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(30), nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    category_id: Mapped[int] = mapped_column(
        ForeignKey("document_categories.id", ondelete="RESTRICT"), nullable=False)
    status: Mapped[str] = mapped_column(String(10), nullable=False, default="draft",
                                        server_default="draft")  # draft|active|retired
    effective_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    activated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    retired_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    supersedes_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("documents.id", ondelete="SET NULL"), nullable=True)
    author: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    source_session: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    created_by_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False,
                                              default="text/html; charset=utf-8")
    storage_key: Mapped[str] = mapped_column(String(500), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    content_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow,
                                                 nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow,
                                                 onupdate=datetime.utcnow, nullable=False)

    category: Mapped["DocumentCategory"] = relationship("DocumentCategory", lazy="joined")

    def __repr__(self) -> str:
        return f"<Document(id={self.id}, code='{self.code}', rev={self.revision}, status='{self.status}')>"
