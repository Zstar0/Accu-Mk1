from typing import Optional
from pydantic import BaseModel, Field


class CaptureSampleContext(BaseModel):
    sample_id: str
    lot: Optional[str] = None
    analytes: Optional[str] = None


class CaptureTokenCreate(BaseModel):
    samples: list[CaptureSampleContext] = Field(min_length=1, max_length=50)
    order_label: Optional[str] = None


class CaptureTokenOut(BaseModel):
    id: int
    token: str
    expires_at: str


class CaptureContextOut(BaseModel):
    order_label: Optional[str]
    samples: list[CaptureSampleContext]
    photo_count: int
    expires_at: str


class CapturePhotoIn(BaseModel):
    photo_base64: str


class CapturePhotoOut(BaseModel):
    created: int
    photo_count: int
