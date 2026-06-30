"""Pydantic request/response models for the flags API."""
from __future__ import annotations

from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

FlagType = Literal["blocker", "critical", "question", "waiting_on_customer", "ready_for_verification"]
FlagStatus = Literal["open", "in_progress", "resolved", "closed"]
FlagTab = Literal["assigned", "raised", "watching", "all_open"]


class CreateFlagRequest(BaseModel):
    entity_type: str
    entity_id: str
    type: FlagType
    title: str
    assignee_id: Optional[int] = None
    first_comment: Optional[str] = None


class CommentRequest(BaseModel):
    body: str


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
    created_at: datetime
    edited_at: Optional[datetime]
    model_config = ConfigDict(from_attributes=True)


class EventResponse(BaseModel):
    id: int
    actor_id: Optional[int]
    event_type: str
    from_value: Optional[str]
    to_value: Optional[str]
    details: Optional[dict]
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


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
    model_config = ConfigDict(from_attributes=True)


class FlagDetailResponse(FlagResponse):
    comments: List[CommentResponse] = Field(default_factory=list)
    events: List[EventResponse] = Field(default_factory=list)


class SummaryResponse(BaseModel):
    assigned_to_me: int
    by_type: dict
