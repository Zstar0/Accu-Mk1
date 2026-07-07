from datetime import datetime
from typing import Optional, List
from pydantic import BaseModel


class CreateBoxRequest(BaseModel):
    order_key: str
    role: str  # hplc | endo | ster | xtra


class AssignVialsRequest(BaseModel):
    sub_sample_ids: List[str]


class BoxVial(BaseModel):
    sample_id: str
    parent_sample_id: Optional[str] = None
    assignment_role: Optional[str] = None
    vial_sequence: int


class BoxResponse(BaseModel):
    id: int
    order_key: str
    box_number: int
    role: str
    label_code: str
    vial_count: int
    printed_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    stored_at: Optional[datetime] = None
    vials: List[BoxVial] = []

    class Config:
        from_attributes = True
