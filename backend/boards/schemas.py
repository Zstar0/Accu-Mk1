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


from urllib.parse import urlsplit

from pydantic import field_validator

FRAME_COLORS = ("slate", "red", "orange", "amber", "green", "teal", "blue", "purple")


class FrameData(BaseModel):
    color: str = "slate"
    model_config = ConfigDict(extra="forbid")

    @field_validator("color")
    @classmethod
    def _color(cls, v: str) -> str:
        if v not in FRAME_COLORS:
            raise ValueError(f"color must be one of {FRAME_COLORS}")
        return v


class TextData(BaseModel):
    size: str = "md"
    model_config = ConfigDict(extra="forbid")

    @field_validator("size")
    @classmethod
    def _size(cls, v: str) -> str:
        if v not in ("sm", "md", "lg"):
            raise ValueError("size must be sm, md or lg")
        return v


class NoteData(BaseModel):
    markdown: str = Field("", max_length=20_000)
    model_config = ConfigDict(extra="forbid")


class LinkData(BaseModel):
    url: str = Field(max_length=2048)
    description: Optional[str] = Field(None, max_length=500)
    model_config = ConfigDict(extra="forbid")

    @field_validator("url")
    @classmethod
    def _url(cls, v: str) -> str:
        v = (v or "").strip()
        parts = urlsplit(v)
        if parts.scheme.lower() not in ("http", "https") or not parts.netloc:
            raise ValueError("url must be http(s):// with a host")
        return v


class EntityData(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PersonData(BaseModel):
    user_id: int
    model_config = ConfigDict(extra="forbid")


class WidgetData(BaseModel):
    key: str = Field(max_length=60)
    model_config = ConfigDict(extra="forbid")


KIND_DATA: Dict[str, type] = {
    "frame": FrameData, "text": TextData, "note": NoteData, "link": LinkData,
    "entity": EntityData, "person": PersonData, "widget": WidgetData,
}


class NodeCreate(BaseModel):
    kind: str
    label: str = Field("", max_length=200)
    parent_id: Optional[int] = None
    x: float = 0.0
    y: float = 0.0
    w: Optional[float] = None
    h: Optional[float] = None
    z: int = 0
    entity_type: Optional[str] = None
    entity_id: Optional[str] = Field(None, max_length=200)
    data: dict = Field(default_factory=dict)
    model_config = ConfigDict(extra="forbid")


class NodePatch(BaseModel):
    """`version` is required (optimistic lock). `kind`, `entity_*` are immutable: a
    different kind is a new node. Unknown fields are 422 (extra='forbid')."""
    version: int
    label: Optional[str] = Field(None, max_length=200)
    parent_id: Optional[int] = None
    x: Optional[float] = None
    y: Optional[float] = None
    w: Optional[float] = None
    h: Optional[float] = None
    z: Optional[int] = None
    data: Optional[dict] = None
    model_config = ConfigDict(extra="forbid")


class PositionItem(BaseModel):
    id: int
    x: float
    y: float
    parent_id: Optional[int] = None  # only applied when present in the request
    version: int
    model_config = ConfigDict(extra="forbid")


class EdgeCreate(BaseModel):
    source_id: int
    target_id: int
    kind: str = "related"
    label: Optional[str] = Field(None, max_length=120)
    model_config = ConfigDict(extra="forbid")


class EdgePatch(BaseModel):
    kind: Optional[str] = None
    label: Optional[str] = Field(None, max_length=120)
    model_config = ConfigDict(extra="forbid")
