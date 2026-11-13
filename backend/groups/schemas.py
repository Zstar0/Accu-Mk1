"""Pydantic v2 wire models for /api/groups (spec §7.1)."""
from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, ConfigDict


class GroupOut(BaseModel):
    id: int
    slug: str
    name: str
    description: Optional[str] = None
    is_active: bool
    member_count: int = 0
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class GroupRef(BaseModel):
    id: int
    slug: str
    name: str
    model_config = ConfigDict(from_attributes=True)


class GroupCreate(BaseModel):
    slug: str
    name: str
    description: Optional[str] = None


class GroupUpdate(BaseModel):
    """Partial. `slug` is accepted only when it equals the current slug (400 otherwise)."""
    slug: Optional[str] = None
    name: Optional[str] = None
    description: Optional[str] = None
    is_active: Optional[bool] = None


class GroupMembersOut(BaseModel):
    group_id: int
    user_ids: List[int]


class GroupMembersReplace(BaseModel):
    user_ids: List[int]
