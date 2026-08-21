"""Request/response models for the lims_analyses API.

Kept separate from the service-layer types so route-level Pydantic
validation is decoupled from internal data shapes.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


# ─── Task 5b: native parent analyses read shape ───────────────────────────────


class NativeParentAnalysisRow(BaseModel):
    """One current, origin='mk1' parent-tier row — read-only display shape for
    the sample-details page's "Accu-Mk1 Analyses" card. Deliberately thinner
    than AnalysisResponse: this is a display card, not an editable row."""
    keyword: str
    title: str
    result_value: Optional[str] = None
    result_unit: Optional[str] = None
    review_state: str
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# ─── Phase 4b: parent promotions read shapes ──────────────────────────────────


class PromotionSourceInfo(BaseModel):
    """One contributing vial-tier source in a ParentPromotionInfo."""
    sample_id: Optional[str] = None     # vial label, e.g. P-0143-S01
    contribution_kind: str


class ParentPromotionInfo(BaseModel):
    """One promotion: a parent-tier analysis row created from vial sources."""
    keyword: str
    parent_analysis_id: int
    result_value: Optional[str] = None
    promoted_at: datetime
    promoted_by_email: Optional[str] = None
    sources: List[PromotionSourceInfo]


# ─── Enums (string-literal aliases for documentation) ────────────────────────

ReviewState = Literal[
    "unassigned", "assigned", "to_be_verified", "parent_to_verify",
    "verified", "published", "rejected", "retracted",
]

TransitionKind = Literal[
    "assign", "submit", "verify", "retract", "reject",
    "retest", "publish", "reset", "auto", "variance_verify",
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


class SetMethodInstrumentRequest(BaseModel):
    """Phase 3.6: bench-tech picks a method + instrument for a Mk1 analysis.

    Either field may be None — caller can clear a previously-set choice or
    set just one. Field types match the FK columns on lims_analyses
    (Integer references to hplc_methods.id / instruments.id).
    """
    method_id: Optional[int] = None
    instrument_id: Optional[int] = None


class PromoteSourceRef(BaseModel):
    """One contributing vial-tier row for a promote_to_parent call."""
    analysis_id: int
    contribution_kind: Literal["chosen", "aggregated_in", "reference"]


class PromoteRequest(BaseModel):
    """Phase 4a: promote one or more vial-tier rows to a single parent-tier row.

    The parent's identity is derived from the sources' host — every source
    must share the same parent_sample_pk (directly or via sub-sample). The
    keyword must match every source's keyword.

    Caller supplies the chosen result_value + result_unit. method_id /
    instrument_id are optional copies onto the new parent-tier row.

    contribution_kind rules (enforced in the service):
      - Exactly one source with 'chosen'  OR  every source with 'aggregated_in'.
      - 'reference' may accompany 'chosen' but not 'aggregated_in'.
    """
    keyword: str
    result_value: str
    result_unit: Optional[str] = None
    method_id: Optional[int] = None
    instrument_id: Optional[int] = None
    sources: List[PromoteSourceRef] = Field(..., min_length=1)
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
    # Amendment audit: {"changed": {field: {before, after}}}; None on rows
    # that predate capture.
    details: Optional[dict] = None

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


# ─── SenaiteAnalysis-compatible response (Phase 3 adapter) ───────────────────


class SenaiteShapeMethodOption(BaseModel):
    """One method option in the dropdown. Matches SENAITE proxy shape."""
    uid: str
    title: str


class SenaiteShapeInstrumentOption(BaseModel):
    """One instrument option in the dropdown. Matches SENAITE proxy shape."""
    uid: str
    title: str


class SenaiteShapeResultOption(BaseModel):
    """One result option for selection-type analyses. Matches SENAITE shape."""
    value: str
    label: str


class SenaiteShapeAnalysisResponse(BaseModel):
    """lims_analyses row reshaped to match the FE's SenaiteAnalysis TS type.

    The FE (src/lib/api.ts) treats uid as opaque. We prefix Mk1 ids with
    'mk1:' so the FE's setAnalysisResult / transitionAnalysis dispatch
    functions can detect them and route to the Mk1 endpoints. SENAITE
    UIDs are 32-char hex and never carry the prefix, so the two address
    spaces don't collide.
    """
    uid: str                              # "mk1:144"
    keyword: Optional[str]
    title: str
    result: Optional[str]                 # the chosen result_value
    result_options: List[SenaiteShapeResultOption] = Field(default_factory=list)
    unit: Optional[str]
    method: Optional[str]
    method_uid: Optional[str]
    method_options: List[SenaiteShapeMethodOption] = Field(default_factory=list)
    instrument: Optional[str]
    instrument_uid: Optional[str]
    instrument_options: List[SenaiteShapeInstrumentOption] = Field(default_factory=list)
    analyst: Optional[str]
    due_date: Optional[str] = None        # not tracked in lims_analyses yet
    review_state: Optional[str]
    sort_key: Optional[int] = None
    captured: Optional[str]               # ISO string of captured_at
    retested: bool
    service_group_id: Optional[int] = None
    service_group_name: Optional[str] = None
    # Phase 4b: when this vial-tier row has been promoted to a parent-tier
    # canonical result, this is the parent-tier row's id. Joined from
    # lims_analysis_promotions.source_analysis_id. None for un-promoted
    # rows and for parent-tier rows themselves (only vial-tier rows can
    # be sources of a promotion).
    promoted_to_parent_id: Optional[int] = None
    # Result type + dropdown options, sourced from the analysis_service.
    result_type: Optional[str] = None
    # Task 5: AnalysisService.origin ('mk1' / 'senaite') for the row's
    # service, resolved from the already-bulk-loaded services map in
    # _serialize_senaite_shape_rows. None only when the service FK is
    # somehow unresolvable (should not happen in practice).
    service_origin: Optional[str] = None
    # S3 Task 7: the row's OWN analysis_service_id — the native identity key
    # the FE joins parent rows to vial rows on. Read off the row, never off
    # the resolved service (which service_origin above goes None on when the
    # FK doesn't resolve — the identity key still ships in that case).
    # Keyword stays alongside it as the display / compatibility alias.
    analysis_service_id: Optional[int] = None


# ─── Phase 4a: promote_to_parent response shapes ─────────────────────────────


class PromotionRow(BaseModel):
    """One lims_analysis_promotions row, returned in PromoteResponse."""
    id: int
    parent_analysis_id: int
    source_analysis_id: int
    contribution_kind: str
    promoted_by_user_id: Optional[int]
    promoted_at: datetime
    reason: Optional[str]

    model_config = ConfigDict(from_attributes=True)


class PromoteResponse(BaseModel):
    """Returns the new parent-tier row and the promotion link rows."""
    parent: AnalysisResponse
    promotions: List[PromotionRow]


# ─── Task 3: dedicated native parent-retest route ─────────────────────────────


class ParentRetestRequest(BaseModel):
    keyword: str
    # S3: the native identity key. When present it alone identifies the parent
    # row (keyword is ignored for the match); keyword stays the compatibility
    # alias and remains the only thing today's FE sends.
    analysis_service_id: Optional[int] = None
    reason: Optional[str] = None


class ParentRetestResponse(BaseModel):
    new_row_ids: list[int]
    parent_review_state: Optional[str] = None


# ─── Task 5: dedicated native vial-side (source) retest route ────────────────


class SourceRetestRequest(BaseModel):
    reason: Optional[str] = None


class SourceRetestResponse(BaseModel):
    new_row_id: int
    parent_unverified: bool
    parent_review_state: Optional[str] = None
