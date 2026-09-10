"""Pydantic shapes for the /priorities API (spec §5).

Key length: `priorities.key` is VARCHAR(40), but every key is also written into
`sla_priority_tiers.priority` which is VARCHAR(20) in prod. 20 is therefore the
binding cap for anything we generate or accept.
"""
from __future__ import annotations

import re
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator

from models import PRIORITY_COLORS, PRIORITY_ICONS

Icon = Literal["chevrons-up", "chevron-up", "minus", "chevron-down", "chevrons-down", "flame"]
Color = Literal["red", "amber", "emerald", "sky", "violet", "zinc"]
Level = Literal["customer", "order", "sample", "vial"]
KEY_MAX = 20
KEY_RE = re.compile(r"^[a-z][a-z0-9_-]{0,19}$")

# Drift guard: the Literals above must stay in step with the model constants
# the DB and the frontend share.
assert set(Icon.__args__) == set(PRIORITY_ICONS)
assert set(Color.__args__) == set(PRIORITY_COLORS)


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    # Slice first, then re-strip: the cut can leave a trailing hyphen.
    return s[:KEY_MAX].strip("-") or "priority"


class PriorityOut(BaseModel):
    key: str
    name: str
    rank: int
    icon: str
    color: str
    pulse: bool
    is_default: bool
    is_active: bool
    sla_tier_id: Optional[int] = None


class PriorityCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    rank: int = 0
    icon: Icon = "minus"
    color: Color = "zinc"
    pulse: bool = False
    sla_tier_id: Optional[int] = None


class PriorityPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    rank: Optional[int] = None
    icon: Optional[Icon] = None
    color: Optional[Color] = None
    pulse: Optional[bool] = None
    is_active: Optional[bool] = None
    # tri-state: omitted = leave; null = clear the global tier row; int = set
    sla_tier_id: Optional[int] = None
    model_config = {"extra": "forbid"}


class AssignIn(BaseModel):
    level: Level
    id: str
    priority_key: Optional[str] = None
    note: Optional[str] = None

    @field_validator("priority_key")
    @classmethod
    def _key(cls, v):
        if v is not None and not KEY_RE.match(v):
            raise ValueError("bad priority key")
        return v


class AssignOut(BaseModel):
    level: str
    id: str
    old_key: Optional[str]
    new_key: Optional[str]
    affected_sample_pks: list[int]


class BulkAssignIn(BaseModel):
    items: list[AssignIn] = Field(min_length=1, max_length=500)


class ResolveIn(BaseModel):
    sample_pks: list[int] = Field(default_factory=list, max_length=2000)
    sub_sample_pks: list[int] = Field(default_factory=list, max_length=5000)


class EffectiveOut(BaseModel):
    key: str
    rank: int
    source_level: str
    source_id: Optional[str] = None


class ResolveOut(BaseModel):
    samples: dict[str, EffectiveOut]
    sub_samples: dict[str, EffectiveOut]


class CustomerPriorityOut(BaseModel):
    wp_customer_user_id: int
    priority_key: str
    note: Optional[str]
    updated_at: Optional[str]
    customer_name: Optional[str]
    customer_email: Optional[str]


class CustomerSeenOut(BaseModel):
    wp_customer_user_id: int
    customer_name: Optional[str]
    customer_email: Optional[str]
    last_order_at: Optional[str]
