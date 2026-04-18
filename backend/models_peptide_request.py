"""Pydantic models for peptide requests. Shape matches
docs/superpowers/specs/2026-04-17-peptide-request-contracts.md."""
from datetime import datetime
from typing import Literal, Optional
from uuid import UUID
from pydantic import BaseModel, Field, EmailStr


CompoundKind = Literal["peptide", "other"]
Status = Literal[
    "new", "approved", "ordering_standard", "sample_prep_created",
    "in_process", "on_hold", "completed", "rejected", "cancelled",
]


class PeptideRequestCreate(BaseModel):
    """Request body for POST /api/peptide-requests (called by integration-service)."""
    compound_kind: CompoundKind
    compound_name: str = Field(..., min_length=1, max_length=200)
    vendor_producer: str = Field(..., min_length=1, max_length=200)
    sequence_or_structure: Optional[str] = Field(None, max_length=4000)
    molecular_weight: Optional[float] = Field(None, gt=0, le=100000)
    cas_or_reference: Optional[str] = Field(None, max_length=200)
    vendor_catalog_number: Optional[str] = Field(None, max_length=200)
    reason_notes: Optional[str] = Field(None, max_length=2000)
    expected_monthly_volume: Optional[int] = Field(None, ge=0, le=100000)
    # Caller-supplied identity (integration-service forwards from WP):
    submitted_by_wp_user_id: int
    submitted_by_email: EmailStr
    submitted_by_name: str = Field(..., min_length=1, max_length=200)


class PeptideRequest(BaseModel):
    """Full canonical shape returned by Accu-Mk1 endpoints."""
    id: UUID
    created_at: datetime
    updated_at: datetime
    submitted_by_wp_user_id: int
    submitted_by_email: str
    submitted_by_name: str
    compound_kind: CompoundKind
    compound_name: str
    vendor_producer: str
    sequence_or_structure: Optional[str] = None
    molecular_weight: Optional[float] = None
    cas_or_reference: Optional[str] = None
    vendor_catalog_number: Optional[str] = None
    reason_notes: Optional[str] = None
    expected_monthly_volume: Optional[int] = None
    status: Status
    previous_status: Optional[Status] = None
    rejection_reason: Optional[str] = None
    sample_id: Optional[str] = None
    clickup_task_id: Optional[str] = None
    clickup_list_id: str
    clickup_assignee_ids: list[str]
    senaite_service_uid: Optional[str] = None
    wp_coupon_code: Optional[str] = None
    wp_coupon_issued_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    rejected_at: Optional[datetime] = None
    cancelled_at: Optional[datetime] = None


class PeptideRequestList(BaseModel):
    total: int
    limit: int
    offset: int
    items: list[PeptideRequest]


class StatusLogEntry(BaseModel):
    id: UUID
    peptide_request_id: UUID
    from_status: Optional[Status] = None
    to_status: Status
    source: Literal["clickup", "accumk1_admin", "system"]
    clickup_event_id: Optional[str] = None
    actor_clickup_user_id: Optional[str] = None
    actor_accumk1_user_id: Optional[UUID] = None
    note: Optional[str] = None
    created_at: datetime
