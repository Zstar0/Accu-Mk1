"""Request/response models for the lims_analyses API.

Kept separate from the service-layer types so route-level Pydantic
validation is decoupled from internal data shapes.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


# ─── Enums (string-literal aliases for documentation) ────────────────────────

ReviewState = Literal[
    "unassigned", "assigned", "to_be_verified",
    "verified", "published", "rejected", "retracted",
]

TransitionKind = Literal[
    "assign", "submit", "verify", "retract", "reject",
    "retest", "publish", "reset", "auto",
]

HostKind = Literal["sample", "sub_sample"]


# ─── Create + response shapes ────────────────────────────────────────────────


class CreateAnalysisRequest(BaseModel):
    """
    Insert a new lims_analyses row. Caller must specify exactly one host
    (sample vs sub_sample); the polymorphic CHECK at the DB layer enforces.
    """
    host_kind: HostKind
    host_pk: int
    analysis_service_id: int
    keyword: str
    title: str
    result_value: Optional[str] = None
    result_unit: Optional[str] = None
    method_id: Optional[int] = None
    instrument_id: Optional[int] = None


class TransitionRequest(BaseModel):
    """Apply a state transition. result_value is required when kind='submit'
    on a row that doesn't already have one — service layer validates."""
    kind: TransitionKind
    result_value: Optional[str] = None
    reason: Optional[str] = None


class SetReportableRequest(BaseModel):
    reportable: bool
    reason: Optional[str] = None


class TransitionInfo(BaseModel):
    """One audit-log row."""
    id: int
    from_state: Optional[str]
    to_state: str
    transition_kind: str
    user_id: Optional[int]
    reason: Optional[str]
    occurred_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AnalysisResponse(BaseModel):
    """Full lims_analyses row shape, for GET endpoints."""
    id: int
    lims_sample_pk: Optional[int]
    lims_sub_sample_pk: Optional[int]
    analysis_service_id: int
    keyword: str
    title: str
    result_value: Optional[str]
    result_unit: Optional[str]
    review_state: str
    method_id: Optional[int]
    instrument_id: Optional[int]
    analyst_user_id: Optional[int]
    captured_at: Optional[datetime]
    submitted_at: Optional[datetime]
    verified_at: Optional[datetime]
    published_at: Optional[datetime]
    retested: bool
    retest_of_id: Optional[int]
    reportable: bool
    reportable_reason: Optional[str]
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AnalysisWithTransitions(AnalysisResponse):
    """AnalysisResponse + the full audit-log chain. Used by GET-by-id."""
    transitions: List[TransitionInfo] = Field(default_factory=list)
