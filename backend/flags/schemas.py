"""Pydantic request/response models for the flags API."""
from __future__ import annotations

from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

# `type` is now a DB-managed flag-type slug (Plan 5), validated server-side
# against flag_types — so it is a free string on the wire, not a closed Literal.
FlagStatus = Literal["open", "in_progress", "blocked", "resolved", "closed"]
FlagTab = Literal["assigned", "raised", "watching", "all_open"]


class CreateFlagRequest(BaseModel):
    entity_type: str
    entity_id: str
    type: str
    title: str
    assignee_id: Optional[int] = None
    first_comment: Optional[str] = None


class CommentRequest(BaseModel):
    body: str
    mention_ids: List[int] = Field(default_factory=list)


class AssignRequest(BaseModel):
    assignee_id: Optional[int] = None


class StatusRequest(BaseModel):
    to_status: FlagStatus


class WatcherRequest(BaseModel):
    user_id: int


class CommentResponse(BaseModel):
    id: int
    flag_id: int
    author_id: int
    body: str
    audience: str
    mentions: List[int] = Field(default_factory=list)
    created_at: datetime
    edited_at: Optional[datetime]
    model_config = ConfigDict(from_attributes=True)

    @field_validator("mentions", mode="before")
    @classmethod
    def _none_to_list(cls, v):
        return v or []


class EventResponse(BaseModel):
    id: int
    actor_id: Optional[int]
    event_type: str
    from_value: Optional[str]
    to_value: Optional[str]
    details: Optional[dict]
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class DeepLink(BaseModel):
    """How the frontend navigates to a flagged entity. `kind` ∈
    sample | worksheet | none; `id` is the navigator argument."""
    kind: str
    id: str


class EntityContext(BaseModel):
    """Server-resolved context for a flagged entity (Plan 4). Attached
    optionally onto flag responses; null when the registry can't resolve it.
    Produced by the Mk1 closures in `seams.register_mk1_entities`."""
    entity_type: str
    entity_id: str
    label: str
    sample_id: Optional[str] = None
    analyses: List[str] = Field(default_factory=list)
    lot: Optional[str] = None  # deferred — additive hook only (lives in SENAITE)
    deep_link: DeepLink


class FlagResponse(BaseModel):
    id: int
    entity_type: str
    entity_id: str
    kind: str
    type: str
    status: str
    title: str
    created_by: int
    assignee_id: Optional[int]
    created_at: datetime
    updated_at: datetime
    resolved_at: Optional[datetime]
    resolved_by: Optional[int]
    # Optional server-resolved entity context (label/sample_id/analyses/deep_link).
    entity: Optional[EntityContext] = None
    model_config = ConfigDict(from_attributes=True)


class WatcherOut(BaseModel):
    """A watcher participant on a flag (ids only — display resolves client-side
    via the shared user directory, keeping the flags module host-agnostic)."""
    user_id: int
    added_at: datetime
    added_by: Optional[int] = None
    model_config = ConfigDict(from_attributes=True)


class FlagDetailResponse(FlagResponse):
    comments: List[CommentResponse] = Field(default_factory=list)
    events: List[EventResponse] = Field(default_factory=list)
    watchers: List[WatcherOut] = Field(default_factory=list)


class ActivityItem(BaseModel):
    """One audit event + its (entity-resolved) flag — a row of the feed.
    `relevance` marks why this event is in the requesting user's feed."""
    id: int
    event_type: str
    actor_id: Optional[int] = None
    from_value: Optional[str] = None
    to_value: Optional[str] = None
    created_at: datetime
    flag: FlagResponse
    relevance: List[str] = Field(default_factory=list)


class ActivityPage(BaseModel):
    """One keyset page of the activity feed. `next_cursor` is null on the last."""
    items: List[ActivityItem]
    next_cursor: Optional[str] = None


class SummaryResponse(BaseModel):
    assigned_to_me: int
    by_type: dict


# --- flag types (Plan 5) -------------------------------------------------
class FlagTypeResponse(BaseModel):
    id: int
    slug: str
    label: str
    color: str
    kind: str
    is_blocking: bool
    is_active: bool
    sort_order: int
    entity_types: List[str] = Field(default_factory=list)
    is_builtin: bool
    created_at: datetime
    updated_at: datetime
    model_config = ConfigDict(from_attributes=True)


class FlagTypeCreate(BaseModel):
    label: str
    color: str
    kind: str  # 'issue' | 'signal'
    # Optional — generated from `label` when absent. Immutable once created.
    slug: Optional[str] = None
    is_blocking: bool = False
    is_active: bool = True
    sort_order: Optional[int] = None
    entity_types: List[str] = Field(default_factory=list)


class FlagTypeUpdate(BaseModel):
    """All-optional partial edit. No `slug` — the slug is immutable."""
    label: Optional[str] = None
    color: Optional[str] = None
    kind: Optional[str] = None
    is_blocking: Optional[bool] = None
    is_active: Optional[bool] = None
    sort_order: Optional[int] = None
    entity_types: Optional[List[str]] = None
