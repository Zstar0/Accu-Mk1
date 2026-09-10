"""Effective-priority resolution (spec §4). Pure and DB-free; `load_effective`
in service.py feeds it. Mirrored in src/lib/priority-resolver.ts against the
shared fixture backend/tests/fixtures/priority_cases.json."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Optional

LEVELS = ("vial", "sample", "order", "customer")


@dataclass(frozen=True)
class PriorityInfo:
    key: str
    rank: int
    is_active: bool
    is_default: bool


@dataclass(frozen=True)
class Effective:
    key: str
    rank: int
    source_level: str  # vial | sample | order | customer | default
    source_id: Optional[str] = None

    def as_dict(self) -> dict:
        return {"key": self.key, "rank": self.rank,
                "source_level": self.source_level, "source_id": self.source_id}


def resolve(
    explicit: Mapping[str, Optional[str]],
    priorities: Mapping[str, PriorityInfo],
    explicit_ids: Optional[Mapping[str, str]] = None,
) -> Effective:
    """Most specific explicit ACTIVE key wins: vial > sample > order > customer;
    otherwise the default priority. An unknown or inactive key at a level is
    treated as NULL (inherit)."""
    for level in LEVELS:
        key = explicit.get(level)
        if not key:
            continue
        info = priorities.get(key)
        if info is None or not info.is_active:
            continue
        sid = (explicit_ids or {}).get(level)
        return Effective(info.key, info.rank, level, sid)
    for info in priorities.values():
        if info.is_default:
            return Effective(info.key, info.rank, "default", None)
    raise ValueError("no default priority configured")
