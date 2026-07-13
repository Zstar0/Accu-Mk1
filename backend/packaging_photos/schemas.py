"""Pydantic schemas for the packaging-photo routes."""
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class PackagingPhotoCreate(BaseModel):
    photo_base64: str
    remarks: Optional[str] = None
    filename: Optional[str] = None
    content_type: Optional[str] = None


class PackagingPhotoUpdate(BaseModel):
    photo_base64: Optional[str] = None
    remarks: Optional[str] = None


class PackagingPhotoBulkCreate(BaseModel):
    parent_sample_ids: list[str] = Field(min_length=1, max_length=50)
    photo_base64: str
    filename: Optional[str] = None
    content_type: Optional[str] = None
    remarks: Optional[str] = None


class PackagingPhotoOut(BaseModel):
    id: int
    ordering: int
    remarks: Optional[str] = None
    content_type: Optional[str] = None
    created_at: datetime
    created_by_user_id: Optional[int] = None

    class Config:
        from_attributes = True
