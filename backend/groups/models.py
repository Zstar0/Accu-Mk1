"""User groups (spec 2026-09-26 §4.1, §4.2). Groups are the unit of access for boards
and, through board nodes, for flags. No lims_ prefix: not sample-hierarchy entities."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import (Boolean, DateTime, ForeignKey, Index, Integer, String, Text,
                        UniqueConstraint)
from sqlalchemy.orm import Mapped, mapped_column

from database import Base


class UserGroup(Base):
    """`slug` is the stable wire key and is immutable (service enforces)."""
    __tablename__ = "user_groups"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    slug: Mapped[str] = mapped_column(String(60), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True,
                                            server_default="true")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow,
                                                 nullable=False)

    def __repr__(self) -> str:
        return f"<UserGroup(id={self.id}, slug='{self.slug}')>"


class UserGroupMember(Base):
    """One row per (group, user). user_id is a plain integer (flags convention)."""
    __tablename__ = "user_group_members"
    __table_args__ = (
        UniqueConstraint("group_id", "user_id", name="uq_user_group_members_pair"),
        Index("ix_user_group_members_user_id", "user_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    group_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("user_groups.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[int] = mapped_column(Integer, nullable=False)
