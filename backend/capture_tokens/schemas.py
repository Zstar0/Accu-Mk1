from typing import Optional
from pydantic import BaseModel, Field, model_validator


class CaptureSampleContext(BaseModel):
    sample_id: str
    lot: Optional[str] = None
    analytes: Optional[str] = None


class CaptureTokenCreate(BaseModel):
    """Two mutually-exclusive mint shapes share this table/hash/expiry
    machinery: a sample-scoped packaging-photo token (samples, the
    original shape) and a station-scoped bench scan-in token (station_id,
    spec 4 Task 12 — see capture_tokens/routes.py's mint branch). Exactly
    one of the two must be supplied.
    """
    samples: list[CaptureSampleContext] = Field(default_factory=list, max_length=50)
    order_label: Optional[str] = None
    station_id: Optional[int] = None

    @model_validator(mode="after")
    def _require_scope(self):
        if self.station_id is None and not self.samples:
            raise ValueError("either samples or station_id is required")
        return self


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
