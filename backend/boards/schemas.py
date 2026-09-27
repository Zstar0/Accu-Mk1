"""Pydantic v2 wire models for /api/boards (spec §7.2, §7.3). Node `data` per kind
lives in KIND_DATA (Task 6 fills it)."""
from __future__ import annotations

from datetime import datetime
from typing import Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field


class ViewportIn(BaseModel):
    x: float
    y: float
    zoom: float = Field(ge=0.1, le=4)


class GrantIn(BaseModel):
    group_id: int
    can_edit: bool = False


class GrantOut(BaseModel):
    group_id: int
    group_slug: str
    group_name: str
    can_edit: bool


class BoardOut(BaseModel):
    id: int
    slug: str
    name: str
    kind: str
    visibility: str
    created_by: Optional[int] = None
    default_viewport: Optional[dict] = None
    node_count: int = 0
    can_edit: bool = False
    created_at: datetime
    updated_at: datetime
    model_config = ConfigDict(from_attributes=True)


class NodeOut(BaseModel):
    id: int
    board_id: int
    kind: str
    label: str
    parent_id: Optional[int] = None
    x: float
    y: float
    w: Optional[float] = None
    h: Optional[float] = None
    z: int
    entity_type: Optional[str] = None
    entity_id: Optional[str] = None
    data: Optional[dict] = None
    version: int
    created_by: Optional[int] = None
    updated_by: Optional[int] = None
    created_at: datetime
    updated_at: datetime
    context: Optional[dict] = None  # registry EntityContext for `entity` kinds
    model_config = ConfigDict(from_attributes=True)


class EdgeOut(BaseModel):
    id: int
    board_id: int
    source_id: int
    target_id: int
    kind: str
    label: Optional[str] = None
    model_config = ConfigDict(from_attributes=True)


class BoardDetail(BoardOut):
    nodes: List[NodeOut] = Field(default_factory=list)
    edges: List[EdgeOut] = Field(default_factory=list)
    grants: List[GrantOut] = Field(default_factory=list)


class BoardCreate(BaseModel):
    slug: str
    name: str
    kind: str = "custom"
    visibility: str = "company"


class BoardPatch(BaseModel):
    """No `slug`: immutable. An unknown field is a 422 (extra='forbid')."""
    name: Optional[str] = None
    kind: Optional[str] = None
    visibility: Optional[str] = None
    default_viewport: Optional[ViewportIn] = None
    model_config = ConfigDict(extra="forbid")


class EntityBoardRef(BaseModel):
    board_id: int
    board_slug: str
    board_name: str
    node_id: int
    node_label: str


# Filled by Task 6 (per-kind data models). Kept here so schemas is the single wire module.
KIND_DATA: Dict[str, type] = {}
