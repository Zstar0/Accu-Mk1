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
    # Origin: 'wp' for WP-submitted requests (integration-service path),
    # 'manual' for lab-tech-created ClickUp tasks that were materialized
    # here by the taskCreated webhook handler. Defaults to 'wp' to match
    # the DB default and keep all pre-migration rows correct.
    source: Literal["wp", "manual"] = "wp"
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
    retired_at: Optional[datetime] = None


class PeptideRequestList(BaseModel):
    total: int
    limit: int
    offset: int
    items: list[PeptideRequest]


class PeptideRequestUpdate(BaseModel):
    """Partial update body for PATCH /lims/peptide-requests/{id}.

    Right now only sample_id is editable from the LIMS UI. The model exists
    so future editable fields (notes, priority, etc.) can be added without
    changing the route signature. sample_id=None is a valid input and
    clears the column + pushes "" to ClickUp.
    """
    sample_id: Optional[str] = Field(None, max_length=200)


class FixStatusPair(BaseModel):
    """One item in PeptideRequestSyncApplyRequest.fix_status_pairs.

    target_status is typed as a bare str (not the Status Literal) so the
    route can surface an explicit 400 / per-item error when a tech
    somehow submits an unknown status, rather than Pydantic rejecting
    the whole payload with a validation error. The sync service layer
    already serializes mapped_status values from the column_map, which
    are always drawn from the Status enum, so in practice this is a
    defensive widening."""
    row_id: UUID
    target_status: str = Field(..., min_length=1, max_length=64)


class FieldDriftResolution(BaseModel):
    """One item in PeptideRequestSyncApplyRequest.resolve_field_drift.

    ``field`` is typed as a bare str (not a Literal over the 5
    bidirectional fields) so an unknown / misspelled field surfaces as
    a per-item error in apply_actions, matching the widening pattern
    used by FixStatusPair.target_status. The sync layer re-checks the
    field against PeptideRequestRepository._UPDATE_FIELDS_WHITELIST
    before touching the DB.

    ``value_to_use`` picks which side wins:
      'db'      — push the DB value to ClickUp (set_custom_field).
      'clickup' — pull the fresh ClickUp value to the DB
                  (repo.update_fields).
    The route validates the literal up front so a typo fails the whole
    request rather than silently no-op'ing inside the sync layer.
    """
    row_id: UUID
    field: str = Field(..., min_length=1, max_length=64)
    value_to_use: Literal["db", "clickup"]


class PeptideRequestSyncApplyRequest(BaseModel):
    """Body for POST /lims/peptide-requests/sync/apply.

    All four arrays default to empty so callers can omit unused
    action kinds. The route passes the model_dump dict to
    peptide_request_sync.apply_actions unchanged."""
    materialize_task_ids: list[str] = Field(default_factory=list)
    retire_row_ids: list[UUID] = Field(default_factory=list)
    fix_status_pairs: list[FixStatusPair] = Field(default_factory=list)
    resolve_field_drift: list[FieldDriftResolution] = Field(default_factory=list)


class StatusLogEntry(BaseModel):
    id: UUID
    peptide_request_id: UUID
    from_status: Optional[Status] = None
    to_status: Status
    source: Literal["clickup", "accumk1_admin", "system"]
    clickup_event_id: Optional[str] = None
    actor_clickup_user_id: Optional[str] = None
    actor_accumk1_user_id: Optional[int] = None
    note: Optional[str] = None
    created_at: datetime
