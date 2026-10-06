"""Planning boards (spec 2026-09-26 §4.3 to §4.6). A board is a spatial index over
things Mk1 already tracks; nodes point at flag entities or are generic objects.
No lims_ prefix: not sample-hierarchy entities. User ids are plain integers."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import (JSON, Boolean, CheckConstraint, DateTime, Float, ForeignKey, Index,
                        Integer, String, UniqueConstraint)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from database import Base

BOARD_KINDS = ("map", "org", "training", "custom")
VISIBILITIES = ("company", "restricted")
NODE_KINDS = ("frame", "text", "note", "link", "entity", "person", "widget")
EDGE_KINDS = ("related", "reports_to", "depends_on", "next")

_JSON = JSONB().with_variant(JSON(), "sqlite")


def _in(col: str, values: tuple, name: str) -> CheckConstraint:
    quoted = ",".join(f"'{v}'" for v in values)
    return CheckConstraint(f"{col} IN ({quoted})", name=name)


class Board(Base):
    """`slug` is immutable (service enforces). `visibility` decides who may VIEW;
    grants decide who may EDIT (and, for restricted boards, also who may view)."""
    __tablename__ = "board_boards"
    __table_args__ = (
        _in("kind", BOARD_KINDS, "ck_board_boards_kind"),
        _in("visibility", VISIBILITIES, "ck_board_boards_visibility"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    slug: Mapped[str] = mapped_column(String(60), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False, default="custom")
    visibility: Mapped[str] = mapped_column(String(20), nullable=False, default="company")
    created_by: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    default_viewport: Mapped[Optional[dict]] = mapped_column(_JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow,
                                                 nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow,
                                                 onupdate=datetime.utcnow, nullable=False)

    def __repr__(self) -> str:
        return f"<Board(id={self.id}, slug='{self.slug}', visibility='{self.visibility}')>"


class BoardGrant(Base):
    __tablename__ = "board_grants"
    __table_args__ = (UniqueConstraint("board_id", "group_id", name="uq_board_grants_pair"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    board_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("board_boards.id", ondelete="CASCADE"), nullable=False)
    group_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("user_groups.id", ondelete="CASCADE"), nullable=False)
    can_edit: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False,
                                           server_default="false")


class BoardNode(Base):
    """One object on a board. `id` (stringified) is the `board_node` flag anchor.
    `x`/`y` are relative to the parent frame when `parent_id` is set (xyflow)."""
    __tablename__ = "board_nodes"
    __table_args__ = (
        _in("kind", NODE_KINDS, "ck_board_nodes_kind"),
        Index("ix_board_nodes_board_id", "board_id"),
        Index("ix_board_nodes_entity", "entity_type", "entity_id"),
        Index("ix_board_nodes_parent_id", "parent_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    board_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("board_boards.id", ondelete="CASCADE"), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    label: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    parent_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("board_nodes.id", ondelete="SET NULL"), nullable=True)
    x: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    y: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    w: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    h: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    z: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    entity_type: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    entity_id: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    data: Mapped[Optional[dict]] = mapped_column(_JSON, nullable=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_by: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    updated_by: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow,
                                                 nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow,
                                                 onupdate=datetime.utcnow, nullable=False)


class BoardEdge(Base):
    __tablename__ = "board_edges"
    __table_args__ = (
        UniqueConstraint("board_id", "source_id", "target_id", "kind", name="uq_board_edges"),
        _in("kind", EDGE_KINDS, "ck_board_edges_kind"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    board_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("board_boards.id", ondelete="CASCADE"), nullable=False)
    source_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("board_nodes.id", ondelete="CASCADE"), nullable=False)
    target_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("board_nodes.id", ondelete="CASCADE"), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False, default="related")
    label: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
