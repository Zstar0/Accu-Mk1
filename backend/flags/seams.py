"""Host seams for the flags module.

The module never imports host domain models directly for entity resolution —
the host registers entity types and supplies a user provider + event sink.
Defaults wire Mk1, but the core depends only on these callables.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

from sqlalchemy.orm import Session


@dataclass
class EntitySpec:
    entity_type: str
    label: Callable[[Optional[Session], str], str]
    deep_link: Callable[[str], str]
    can_flag: Callable[[object, str], bool]


_REGISTRY: dict[str, EntitySpec] = {}


def register_entity(entity_type: str, *, label, deep_link, can_flag) -> None:
    _REGISTRY[entity_type] = EntitySpec(entity_type, label, deep_link, can_flag)


def is_registered(entity_type: str) -> bool:
    return entity_type in _REGISTRY


def get_entity_spec(entity_type: str) -> EntitySpec:
    return _REGISTRY[entity_type]  # raises KeyError if unknown


# --- user provider -------------------------------------------------------
def resolve_user(db: Session, user_id: int) -> dict:
    """Default Mk1 provider: id -> {id, display, avatar}. Host-swappable."""
    from models import User
    u = db.get(User, user_id)
    if u is None:
        return {"id": user_id, "display": f"User {user_id}", "avatar": None}
    name = " ".join(x for x in [getattr(u, "first_name", None), getattr(u, "last_name", None)] if x)
    return {"id": u.id, "display": name or u.email, "avatar": None}


# --- event sink ----------------------------------------------------------
class InMemoryEventSink:
    """Default no-network sink. Plan 2 replaces with an SSE-backed sink."""
    def __init__(self) -> None:
        self.events: list[dict] = []

    def emit(self, event: dict) -> None:
        self.events.append(event)


EVENT_SINK: InMemoryEventSink = InMemoryEventSink()


def set_event_sink(sink) -> None:
    global EVENT_SINK
    EVENT_SINK = sink


# --- Mk1 registrations ---------------------------------------------------
def register_mk1_entities() -> None:
    """Register the Phase-1 flaggable entity types. Called at startup."""
    def _sample_label(db, eid):
        from models import LimsSample
        row = db.get(LimsSample, int(eid)) if str(eid).isdigit() else None
        return getattr(row, "sample_id", None) or f"Sample {eid}"

    def _sub_sample_label(db, eid):
        from models import LimsSubSample
        row = db.get(LimsSubSample, int(eid)) if str(eid).isdigit() else None
        return getattr(row, "sample_id", None) or f"Vial {eid}"

    # Deep links reconciled against the real frontend useHashNavigation routes
    # (Plan 3 Task 7). Hash format is `#<section>/<subsection>?id=<id>`.
    register_entity("sample",
                    label=_sample_label,
                    deep_link=lambda eid: f"/#senaite/sample-details?id={eid}",
                    can_flag=lambda user, eid: True)
    # NOTE: there is no dedicated vial/sub-sample route — vials are viewed inside
    # the parent sample page, and the sub-sample pk alone can't resolve the
    # parent here. The frontend suppresses the deep-link arrow for sub_sample
    # (documented gap); we point at the sample-details route as the closest
    # landing rather than the former non-existent `/#vials/{eid}`.
    register_entity("sub_sample",
                    label=_sub_sample_label,
                    deep_link=lambda eid: f"/#senaite/sample-details?id={eid}",
                    can_flag=lambda user, eid: True)
    register_entity("worksheet",
                    label=lambda db, eid: f"Worksheet {eid}",
                    deep_link=lambda eid: f"/#hplc-analysis/worksheet-detail?id={eid}",
                    can_flag=lambda user, eid: True)
