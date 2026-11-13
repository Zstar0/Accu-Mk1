"""Agent credentials (spec 2026-10-12 section 3.2). The agent itself is a `users` row with
role 'agent'; this row holds its key hash and switches. One row, one live key, per agent."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from database import Base


class AgentCredential(Base):
    __tablename__ = "agent_credentials"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    key_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    key_hint: Mapped[str] = mapped_column(String(8), nullable=False)
    lab_tools: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    # Honoured only together with lab_tools (agents/access.scopes_for).
    coa_publishing: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False,
                                                 server_default="false")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    created_by_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    rotated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_used_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
