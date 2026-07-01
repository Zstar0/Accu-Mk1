"""SQLAlchemy models for the flags module.

Anchors to host entities by opaque (entity_type, entity_id) — NO FK to host
tables. User references are INTEGER with no FK (the user-provider seam resolves
display). Tables use the neutral `flag_` prefix.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import Integer, Text, DateTime, ForeignKey, JSON, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


class FlagFlag(Base):
    """A flag = a task/thread anchored to one work-product entity."""
    __tablename__ = "flag_flags"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    entity_type: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    entity_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    kind: Mapped[str] = mapped_column(Text, nullable=False)          # 'issue' | 'signal'
    type: Mapped[str] = mapped_column(Text, nullable=False)          # 'blocker' | ...
    status: Mapped[str] = mapped_column(Text, nullable=False, default="open",
                                        server_default="open", index=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    created_by: Mapped[int] = mapped_column(Integer, nullable=False)
    assignee_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow,
                                                 onupdate=datetime.utcnow, nullable=False)
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    resolved_by: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    comments: Mapped[list["FlagComment"]] = relationship(
        "FlagComment", back_populates="flag", cascade="all, delete-orphan",
        order_by="FlagComment.created_at",
    )
    participants: Mapped[list["FlagParticipant"]] = relationship(
        "FlagParticipant", back_populates="flag", cascade="all, delete-orphan",
    )
    events: Mapped[list["FlagEvent"]] = relationship(
        "FlagEvent", back_populates="flag", cascade="all, delete-orphan",
        order_by="FlagEvent.created_at",
    )


class FlagComment(Base):
    __tablename__ = "flag_comments"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    flag_id: Mapped[int] = mapped_column(Integer, ForeignKey("flag_flags.id", ondelete="CASCADE"),
                                         nullable=False, index=True)
    author_id: Mapped[int] = mapped_column(Integer, nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    audience: Mapped[str] = mapped_column(Text, nullable=False, default="internal",
                                          server_default="internal")
    mentions: Mapped[Optional[list]] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    edited_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    flag: Mapped["FlagFlag"] = relationship("FlagFlag", back_populates="comments")


class FlagParticipant(Base):
    __tablename__ = "flag_participants"
    __table_args__ = (UniqueConstraint("flag_id", "user_id", name="uq_flag_participant"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    flag_id: Mapped[int] = mapped_column(Integer, ForeignKey("flag_flags.id", ondelete="CASCADE"),
                                         nullable=False, index=True)
    user_id: Mapped[int] = mapped_column(Integer, nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False, default="watcher",
                                      server_default="watcher")
    added_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    added_by: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    flag: Mapped["FlagFlag"] = relationship("FlagFlag", back_populates="participants")


class FlagEvent(Base):
    """Append-only audit log. One row per state-changing action."""
    __tablename__ = "flag_events"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    flag_id: Mapped[int] = mapped_column(Integer, ForeignKey("flag_flags.id", ondelete="CASCADE"),
                                         nullable=False, index=True)
    actor_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    from_value: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    to_value: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    details: Mapped[Optional[dict]] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    flag: Mapped["FlagFlag"] = relationship("FlagFlag", back_populates="events")


class FlagRead(Base):
    """Per-user last-read marker for a flag (drives unread state)."""
    __tablename__ = "flag_reads"
    __table_args__ = (UniqueConstraint("user_id", "flag_id", name="uq_flag_read"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    flag_id: Mapped[int] = mapped_column(Integer, ForeignKey("flag_flags.id", ondelete="CASCADE"),
                                         nullable=False, index=True)
    last_read_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
