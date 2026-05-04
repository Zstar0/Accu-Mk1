"""Pydantic schemas for sub-samples API."""
from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


class CreateSubSampleRequest(BaseModel):
    parent_sample_id: str = Field(..., description="Parent SENAITE sample ID, e.g. 'P-0134'")
    photo_base64: str = Field(..., description="Photo as base64-encoded JPEG/PNG")
    remarks: Optional[str] = None


class UpdateSubSampleRequest(BaseModel):
    photo_base64: Optional[str] = None
    remarks: Optional[str] = None


class SubSampleResponse(BaseModel):
    id: int
    sample_id: str
    parent_sample_id: str
    vial_sequence: int
    received_at: datetime
    received_by_user_id: Optional[int]
    photo_external_uid: Optional[str]
    remarks: Optional[str]
    assignment_role: Optional[str] = None

    class Config:
        from_attributes = True


class ParentSampleSummary(BaseModel):
    sample_id: str
    external_lims_uid: Optional[str]
    peptide_name: Optional[str]
    status: Optional[str]
    sub_sample_count: int
    last_synced_at: datetime

    class Config:
        from_attributes = True


class SubSampleListResponse(BaseModel):
    parent: ParentSampleSummary
    sub_samples: list[SubSampleResponse]


class VialPlanItem(BaseModel):
    sample_id: str
    is_parent: bool
    vial_sequence: int
    assignment_role: Optional[str]


class VialPlanResponse(BaseModel):
    demand: dict
    wp_order_number: Optional[str] = None
    vials: list[VialPlanItem]
    is_unreachable: bool = False


class AssignmentPatchRequest(BaseModel):
    role: Optional[str]  # 'hplc' | 'endo' | 'ster' | 'xtra' | None


class AggregatesRequest(BaseModel):
    parent_sample_ids: list[str] = Field(
        ..., min_length=1, max_length=500,
        description="Parent SENAITE sample IDs to look up aggregates for"
    )


class ParentAggregate(BaseModel):
    vial_count: int = Field(
        ...,
        description="Total vials = parent + sub-samples. Zero when the parent "
                    "has no sub-samples (single-vial samples aren't interesting "
                    "on the list page; UI renders a dash)."
    )
    parent_role: str = Field(
        ...,
        description="The parent AR's assignment_role. The list page renders "
                    "this badge on the parent row; sub-sample roles are shown "
                    "on expansion. Defaults to 'hplc' if NULL in the DB."
    )


class AggregatesResponse(BaseModel):
    aggregates: dict[str, ParentAggregate] = Field(
        ...,
        description="Keyed by parent_sample_id. Sample IDs not present locally "
                    "(no row in lims_samples) are omitted from the response — "
                    "callers should treat absence as 'no sub-samples'."
    )
