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
    # Null anchor = a general task (Phase 2 slice 2).
    entity_type: Optional[str] = None
    entity_id: Optional[str] = None
    type: str
    title: str
    assignee_id: Optional[int] = None
    first_comment: Optional[str] = None
    due_at: Optional[datetime] = None


class DueRequest(BaseModel):
    due_at: Optional[datetime] = None


class CommentRequest(BaseModel):
    body: str
    mention_ids: List[int] = Field(default_factory=list)


class AssignRequest(BaseModel):
    assignee_id: Optional[int] = None


class StatusRequest(BaseModel):
    to_status: FlagStatus


class WatcherRequest(BaseModel):
    user_id: int


class AttachmentResponse(BaseModel):
    id: int
    flag_id: int
    comment_id: Optional[int] = None
    filename: str
    content_type: str
    size_bytes: int
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class ReactionAggregate(BaseModel):
    emoji: str
    count: int
    user_ids: List[int] = Field(default_factory=list)


class CommentResponse(BaseModel):
    id: int
    flag_id: int
    author_id: int
    body: str
    audience: str
    mentions: List[int] = Field(default_factory=list)
    created_at: datetime
    edited_at: Optional[datetime]
    reactions: List[ReactionAggregate] = Field(default_factory=list)
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
    # Nullable since Phase 2: a null anchor = a general task.
    entity_type: Optional[str] = None
    entity_id: Optional[str] = None
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
    due_at: Optional[datetime] = None
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


class EntityLinkOut(BaseModel):
    """A navigational entity reference link, with resolved context like the
    anchor. NOT counted in rollups/indicators (spec §2 link model b)."""
    id: int
    entity_type: str
    entity_id: str
    entity: Optional[EntityContext] = None
    model_config = ConfigDict(from_attributes=True)


class EntityLinkRequest(BaseModel):
    entity_type: str
    entity_id: str


class FlagLinkOut(BaseModel):
    """A related-flag link, resolved for the viewer. `flag_id` is THE OTHER
    flag (symmetric render); title/status/type pre-resolved for the chip."""
    id: int
    flag_id: int
    title: str
    status: str
    type: str


class FlagLinkRequest(BaseModel):
    flag_id: int


class FlagDetailResponse(FlagResponse):
    comments: List[CommentResponse] = Field(default_factory=list)
    events: List[EventResponse] = Field(default_factory=list)
    watchers: List[WatcherOut] = Field(default_factory=list)
    entity_links: List[EntityLinkOut] = Field(default_factory=list)
    flag_links: List[FlagLinkOut] = Field(default_factory=list)


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


class FlagSearchHit(BaseModel):
    """One comment/title search match (spec §7). `snippet` is a cleaned comment
    excerpt (empty on a title-only hit); `matched_in` ⊆ {"comment","title"}."""
    flag_id: int
    snippet: str = ""
    matched_in: List[str] = Field(default_factory=list)
    model_config = ConfigDict(from_attributes=True)


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


# --- recurring tasks (Slice 5) ------------------------------------------
class FlagRecurringResponse(BaseModel):
    id: int
    title: str
    body: Optional[str] = None
    type: str
    assignee_id: Optional[int] = None
    watchers: List[int] = Field(default_factory=list)
    entity_type: Optional[str] = None
    entity_id: Optional[str] = None
    cadence: str
    next_run_at: datetime
    active: bool
    skip_if_open: bool
    created_by: int
    created_at: datetime
    last_minted_flag_id: Optional[int] = None
    model_config = ConfigDict(from_attributes=True)

    @field_validator("watchers", mode="before")
    @classmethod
    def _none_to_list(cls, v):
        return v or []


class FlagRecurringCreate(BaseModel):
    title: str
    type: str
    cadence: str
    body: Optional[str] = None
    assignee_id: Optional[int] = None
    watchers: List[int] = Field(default_factory=list)
    entity_type: Optional[str] = None
    entity_id: Optional[str] = None
    skip_if_open: bool = True


class FlagRecurringUpdate(BaseModel):
    title: Optional[str] = None
    type: Optional[str] = None
    cadence: Optional[str] = None
    body: Optional[str] = None
    assignee_id: Optional[int] = None
    watchers: Optional[List[int]] = None
    entity_type: Optional[str] = None
    entity_id: Optional[str] = None
    active: Optional[bool] = None
    skip_if_open: Optional[bool] = None


# --- state-change watches (Plan 6) --------------------------------------
class WatchConditionModel(BaseModel):
    field: Literal["state"]
    equals: str


class WatchActionModel(BaseModel):
    kind: Literal["create_flag", "comment"]
    # create_flag
    type: Optional[str] = None
    title: Optional[str] = None
    assignee_id: Optional[int] = None
    # comment
    flag_id: Optional[int] = None
    body: Optional[str] = None


class ArmWatchRequest(BaseModel):
    entity_type: str
    entity_id: str
    condition: WatchConditionModel
    action: WatchActionModel
    watch_flag_id: Optional[int] = None


class WatchResponse(BaseModel):
    id: int
    entity_type: str
    entity_id: str
    condition: dict
    action: dict
    created_by: int
    watch_flag_id: Optional[int] = None
    status: str
    created_at: datetime
    fired_at: Optional[datetime] = None
    model_config = ConfigDict(from_attributes=True)
