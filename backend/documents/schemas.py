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


class DocumentOut(BaseModel):
    id: int
    code: str
    revision: int
    title: str
    description: Optional[str] = None
    category_id: int
    category_name: str
    category_prefix: str
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
    open_comment_count: int = 0


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
    effective_date: Optional[date] = None
    updated_by: Optional[str] = None


class CommentLabelOut(BaseModel):
    id: str
    emoji: str
    text: str
    color: str
    tip: Optional[str] = None


class CommentCreate(BaseModel):
    parent_id: Optional[int] = None
    kind: str = "comment"                 # comment | suggestion
    anchor: Optional[dict] = None         # PersistedHtmlAnchor or null (document-level)
    label: Optional[str] = None
    body: str = ""
    suggested_text: Optional[str] = None


class CommentPatch(BaseModel):
    body: Optional[str] = None
    suggested_text: Optional[str] = None


class CommentAttachmentOut(BaseModel):
    id: int
    filename: str
    content_type: str
    size_bytes: int
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class CommentOut(BaseModel):
    id: int
    code: str
    document_id: int
    revision: int
    parent_id: Optional[int] = None
    number: Optional[int] = None          # top-level only; replies carry None
    kind: str
    anchor: Optional[dict] = None
    label: Optional[str] = None
    body: str
    suggested_text: Optional[str] = None
    author: str
    author_user_id: Optional[int] = None
    author_agent: Optional[str] = None
    status: str
    resolved_at: Optional[datetime] = None
    resolved_by: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    edited_at: Optional[datetime] = None
    attachments: List[CommentAttachmentOut] = Field(default_factory=list)
    replies: List["CommentOut"] = Field(default_factory=list)


CommentOut.model_rebuild()


class CommentListOut(BaseModel):
    items: List[CommentOut]
    code: str
    latest_revision: int
    open_count: int


class CommentIndexRow(BaseModel):
    id: int
    code: str
    title: str
    document_id: int
    revision: int
    number: Optional[int] = None
    kind: str
    label: Optional[str] = None
    author: str
    status: str
    created_at: datetime
    body_excerpt: str


class CommentIndexOut(BaseModel):
    items: List[CommentIndexRow]


class DocumentContentReplace(BaseModel):
    html: str
