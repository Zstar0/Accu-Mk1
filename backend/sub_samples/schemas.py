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
