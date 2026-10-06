"""Pydantic v2 wire models for the documents API (spec §5)."""
from __future__ import annotations

from datetime import date, datetime
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field


class CategoryOut(BaseModel):
    id: int
    name: str
    code_prefix: str
    description: Optional[str] = None
    sort_order: int
    active: bool
    document_count: int = 0
    created_at: datetime
    updated_at: datetime
    model_config = ConfigDict(from_attributes=True)


class CategoryCreate(BaseModel):
    name: str
    code_prefix: str
    description: Optional[str] = None
    sort_order: int = 0


class CategoryUpdate(BaseModel):
    """All-optional partial edit. No code_prefix — immutable once created."""
    name: Optional[str] = None
    description: Optional[str] = None
    sort_order: Optional[int] = None
    active: Optional[bool] = None


class SpaceOut(BaseModel):
    id: int
    slug: str
    name: str
    description: Optional[str] = None
    visibility: str
    is_active: bool
    sort_order: int
    document_count: int = 0
    can_write: bool = False
    created_at: datetime
    updated_at: datetime
    model_config = ConfigDict(from_attributes=True)


class SpaceCreate(BaseModel):
    slug: str
    name: str
    description: Optional[str] = None
    visibility: str = "company"
    sort_order: int = 0


class SpaceUpdate(BaseModel):
    """Partial. No slug: immutable."""
    name: Optional[str] = None
    description: Optional[str] = None
    visibility: Optional[str] = None
    is_active: Optional[bool] = None
    sort_order: Optional[int] = None


class SpaceGrantsReplace(BaseModel):
    group_ids: List[int]


class SpaceGrantsOut(BaseModel):
    space_id: int
    group_ids: List[int]


class DocumentOut(BaseModel):
    id: int
    code: str
    revision: int
    title: str
    description: Optional[str] = None
    category_id: int
    category_name: str
    category_prefix: str
    space_id: Optional[int] = None
    space_slug: str = "general"
    space_name: str = "General"
    status: str
    effective_date: Optional[date] = None
    activated_at: Optional[datetime] = None
    retired_at: Optional[datetime] = None
    supersedes_id: Optional[int] = None
    author: Optional[str] = None
    updated_by: Optional[str] = None
    co_author: Optional[str] = None
    source_session: Optional[str] = None
    created_by_user_id: Optional[int] = None
    content_type: str
    size_bytes: int
    content_sha256: str
    created_at: datetime
    updated_at: datetime
    revision_count: int = 1


class DocumentDetail(DocumentOut):
    revisions: List[DocumentOut] = Field(default_factory=list)


class DocumentListOut(BaseModel):
    items: List[DocumentOut]
    total: int
    page: int
    page_size: int


class DocumentCreate(BaseModel):
    title: Optional[str] = None       # required for a new code; a revision inherits
    html: str
    category: Optional[str] = None       # code prefix or name
    category_id: Optional[int] = None
    space: Optional[str] = None  # slug; default General
    space_id: Optional[int] = None
    description: Optional[str] = None
    code: Optional[str] = None           # existing code => next revision
    author: Optional[str] = None
    source_session: Optional[str] = None
    effective_date: Optional[date] = None
    activate: bool = True


class DocumentPatch(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    category_id: Optional[int] = None
    space_id: Optional[int] = None  # admin bearer only; moves every revision
    effective_date: Optional[date] = None
    updated_by: Optional[str] = None
