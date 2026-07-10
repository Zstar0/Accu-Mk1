"""SQLAlchemy models for the flags module.

Anchors to host entities by opaque (entity_type, entity_id) — NO FK to host
tables. User references are INTEGER with no FK (the user-provider seam resolves
display). Tables use the neutral `flag_` prefix.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import Integer, Text, DateTime, ForeignKey, JSON, UniqueConstraint, Boolean
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


class FlagFlag(Base):
    """A flag = a task/thread anchored to one work-product entity."""
    __tablename__ = "flag_flags"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    # Nullable since Phase 2: a NULL anchor = a "general task" (spec §5).
    entity_type: Mapped[Optional[str]] = mapped_column(Text, nullable=True, index=True)
    entity_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True, index=True)
    kind: Mapped[str] = mapped_column(Text, nullable=False)          # 'issue' | 'signal'
    type: Mapped[str] = mapped_column(Text, nullable=False)          # 'blocker' | ...
    status: Mapped[str] = mapped_column(Text, nullable=False, default="open",
                                        server_default="open", index=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    created_by: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    assignee_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow,
                                                 onupdate=datetime.utcnow, nullable=False)
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    resolved_by: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # Optional deadline (Phase 2 slice 2). Overdue is computed, never stored.
    due_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, index=True)

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
    actor_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
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


class FlagEntityLink(Base):
    """A navigational 'related item' reference — NOT a rollup anchor (spec §2)."""
    __tablename__ = "flag_entity_links"
    __table_args__ = (UniqueConstraint("flag_id", "entity_type", "entity_id",
                                       name="uq_flag_entity_link"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    flag_id: Mapped[int] = mapped_column(Integer, ForeignKey("flag_flags.id", ondelete="CASCADE"),
                                         nullable=False, index=True)
    entity_type: Mapped[str] = mapped_column(Text, nullable=False)
    entity_id: Mapped[str] = mapped_column(Text, nullable=False)
    added_by: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)


class FlagLink(Base):
    """Flag↔flag 'related' link, one row per unordered pair (lo/hi normalized)."""
    __tablename__ = "flag_links"
    __table_args__ = (UniqueConstraint("flag_id", "linked_flag_id",
                                       name="uq_flag_link"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    flag_id: Mapped[int] = mapped_column(Integer, ForeignKey("flag_flags.id", ondelete="CASCADE"),
                                         nullable=False, index=True)
    linked_flag_id: Mapped[int] = mapped_column(Integer, ForeignKey("flag_flags.id", ondelete="CASCADE"),
                                                nullable=False, index=True)
    relation: Mapped[str] = mapped_column(Text, nullable=False, default="related",
                                          server_default="related")
    added_by: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)


class FlagAttachment(Base):
    """An uploaded image on a flag. Linked to a comment (comment_id) once the
    comment referencing {attachment:ID} is saved; unlinked rows are GC'd by the
    scheduler (Plan 5)."""
    __tablename__ = "flag_attachments"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    flag_id: Mapped[int] = mapped_column(Integer, ForeignKey("flag_flags.id", ondelete="CASCADE"),
                                         nullable=False, index=True)
    comment_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("flag_comments.id", ondelete="SET NULL"), nullable=True, index=True)
    uploaded_by: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    filename: Mapped[str] = mapped_column(Text, nullable=False)
    content_type: Mapped[str] = mapped_column(Text, nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    storage_key: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)


class FlagSchedulerRun(Base):
    """Per-job bookkeeping for the in-process scheduler. `name` is the PK so a
    restart reads the last run and never double-fires. `last_status` is a short
    'ok' / 'error: …' string for ops health (surfaced via a health route later)."""
    __tablename__ = "flag_scheduler_runs"

    name: Mapped[str] = mapped_column(Text, primary_key=True)
    last_run_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_status: Mapped[Optional[str]] = mapped_column(Text, nullable=True)


class FlagRecurring(Base):
    """A recurring-task template. The scheduler mints a flag from it each time
    `next_run_at` arrives, then advances `next_run_at` per `cadence`. Watchers are
    an opaque id list (no FK — same convention as the rest of the module)."""
    __tablename__ = "flag_recurring"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    body: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    assignee_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    watchers: Mapped[Optional[list]] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"), nullable=True)
    entity_type: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    entity_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    cadence: Mapped[str] = mapped_column(Text, nullable=False)  # daily | weekly:<0-6> | monthly:<1-28>
    next_run_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true", nullable=False)
    skip_if_open: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true", nullable=False)
    created_by: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    last_minted_flag_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)


class FlagCommentReaction(Base):
    """An emoji reaction on a comment. Social metadata — deliberately NOT in
    flag_events (spec §6); this table is the analytics source."""
    __tablename__ = "flag_comment_reactions"
    __table_args__ = (UniqueConstraint("comment_id", "user_id", "emoji",
                                       name="uq_flag_comment_reaction"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    comment_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("flag_comments.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id: Mapped[int] = mapped_column(Integer, nullable=False)
    emoji: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)


class FlagEntityWatch(Base):
    """An armed watch on a host entity's workflow state (Plan 6).

    A scheduler poller (flags/watches.py) evaluates `condition` against the
    `state` seam every ~2 min and fires `action` ONCE (one-shot v1; re-arm is
    manual). Anchors by opaque (entity_type, entity_id) like a flag — NO FK to
    host tables. `watch_flag_id` is set when armed from a flag thread (fire =
    comment on that flag); NULL for a standalone watch armed from an entity page
    (fire = mint a new flag)."""
    __tablename__ = "flag_entity_watches"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    entity_type: Mapped[str] = mapped_column(Text, nullable=False)
    entity_id: Mapped[str] = mapped_column(Text, nullable=False)
    condition: Mapped[dict] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"), nullable=False)
    action: Mapped[dict] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"), nullable=False)
    created_by: Mapped[int] = mapped_column(Integer, nullable=False)
    watch_flag_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("flag_flags.id", ondelete="CASCADE"),
        nullable=True, index=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="armed",
                                        server_default="armed", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    fired_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
