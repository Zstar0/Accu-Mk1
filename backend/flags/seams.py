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
    # Optional richer resolvers (Plan 4). `context` returns the serialized
    # entity-context dict (label/sample_id/analyses/lot/deep_link); `descendants`
    # returns the (entity_type, entity_id) pairs that roll up under this entity
    # (e.g. a sample's vials). Both are pure host-domain closures — the module
    # core never learns what a "vial" is.
    context: Optional[Callable[[Session, str], Optional[dict]]] = None
    descendants: Optional[Callable[[Session, str], list]] = None


_REGISTRY: dict[str, EntitySpec] = {}


def register_entity(entity_type: str, *, label, deep_link, can_flag,
                    context=None, descendants=None) -> None:
    _REGISTRY[entity_type] = EntitySpec(entity_type, label, deep_link, can_flag,
                                        context=context, descendants=descendants)


def is_registered(entity_type: str) -> bool:
    return entity_type in _REGISTRY


def get_entity_spec(entity_type: str) -> EntitySpec:
    return _REGISTRY[entity_type]  # raises KeyError if unknown


# --- entity-context resolution (Plan 4) ----------------------------------
def resolve_context(db: Session, entity_type: str, entity_id: str) -> Optional[dict]:
    """Resolve a flag's entity to a serialized context dict, or None.

    Stamps `entity_type`/`entity_id` onto whatever the registered closure
    returns. Returns None when the type is unregistered, has no `context`
    resolver, the row is gone, or the resolver fails — never raises into a
    request (a card without context is fine; a 500 is not).
    """
    spec = _REGISTRY.get(entity_type)
    if spec is None or spec.context is None:
        return None
    try:
        ctx = spec.context(db, str(entity_id))
    except Exception:  # noqa: BLE001 — context is best-effort decoration
        return None
    if ctx is None:
        return None
    return {"entity_type": entity_type, "entity_id": str(entity_id), **ctx}


def resolve_descendants(db: Session, entity_type: str, entity_id: str) -> list:
    """Resolve the (entity_type, entity_id) pairs that roll up under this
    entity (a sample's vials). Returns [] when unregistered, no resolver, or on
    failure — never raises into a request."""
    spec = _REGISTRY.get(entity_type)
    if spec is None or spec.descendants is None:
        return []
    try:
        return list(spec.descendants(db, str(entity_id)) or [])
    except Exception:  # noqa: BLE001 — rollup is best-effort
        return []


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
    """Register the Phase-1 flaggable entity types. Called at startup.

    ALL Mk1-specific knowledge — the human label, the sample↔vial hierarchy,
    which analyses belong to a vial, and how each type deep-links — lives in
    these closures. `service.py`/`routes.py` stay entity-agnostic and reach this
    only via `resolve_context`/`resolve_descendants`.
    """
    def _load_sample(db, eid):
        """Load a LimsSample by pk OR by human sample_id. The frontend has the
        Sample ID string (P-0071); Task-1 tests + the deep-link carry the pk —
        accept both."""
        from models import LimsSample
        row = db.get(LimsSample, int(eid)) if str(eid).isdigit() else None
        if row is None:
            row = db.query(LimsSample).filter(LimsSample.sample_id == str(eid)).first()
        return row

    def _sample_label(db, eid):
        row = _load_sample(db, eid)
        return getattr(row, "sample_id", None) or f"Sample {eid}"

    def _sub_sample_label(db, eid):
        from models import LimsSubSample
        row = db.get(LimsSubSample, int(eid)) if str(eid).isdigit() else None
        return getattr(row, "sample_id", None) or f"Vial {eid}"

    def _sample_context(db, eid):
        row = _load_sample(db, eid)
        if row is None:
            return None
        return {
            "label": row.sample_id,
            "sample_id": row.sample_id,
            "analyses": [],  # parent-level analyses omitted this round (Plan 4)
            "lot": None,     # deferred — lives only in SENAITE
            "deep_link": {"kind": "sample", "id": row.sample_id},
        }

    def _sample_descendants(db, eid):
        from models import LimsSubSample
        row = _load_sample(db, eid)
        if row is None:
            return []
        vials = db.query(LimsSubSample).filter(
            LimsSubSample.parent_sample_pk == row.id
        ).all()
        return [("sub_sample", str(v.id)) for v in vials]

    def _sub_sample_context(db, eid):
        from models import LimsSubSample, LimsAnalysis
        vial = db.get(LimsSubSample, int(eid)) if str(eid).isdigit() else None
        if vial is None:
            return None
        parent = vial.parent_sample
        parent_sample_id = getattr(parent, "sample_id", None)
        # De-dupe analysis titles, order-stable (first occurrence wins).
        titles, seen = [], set()
        for (title,) in db.query(LimsAnalysis.title).filter(
            LimsAnalysis.lims_sub_sample_pk == vial.id
        ).order_by(LimsAnalysis.id).all():
            if title not in seen:
                seen.add(title)
                titles.append(title)
        # Vials are viewed inside the parent sample page; deep-link there with
        # the parent's human Sample ID (fixes the Plan-3 suppressed-arrow gap).
        deep_link = ({"kind": "sample", "id": parent_sample_id}
                     if parent_sample_id else {"kind": "none", "id": str(eid)})
        return {
            "label": vial.sample_id,
            "sample_id": parent_sample_id,
            "analyses": titles,
            "lot": None,
            "deep_link": deep_link,
        }

    def _worksheet_context(db, eid):
        return {
            "label": f"Worksheet {eid}",
            "sample_id": None,
            "analyses": [],
            "lot": None,
            "deep_link": {"kind": "worksheet", "id": str(eid)},
        }

    # Deep links reconciled against the real frontend useHashNavigation routes
    # (Plan 3 Task 7). Hash format is `#<section>/<subsection>?id=<id>`.
    register_entity("sample",
                    label=_sample_label,
                    deep_link=lambda eid: f"/#senaite/sample-details?id={eid}",
                    can_flag=lambda user, eid: True,
                    context=_sample_context,
                    descendants=_sample_descendants)
    register_entity("sub_sample",
                    label=_sub_sample_label,
                    deep_link=lambda eid: f"/#senaite/sample-details?id={eid}",
                    can_flag=lambda user, eid: True,
                    context=_sub_sample_context)
    register_entity("worksheet",
                    label=lambda db, eid: f"Worksheet {eid}",
                    deep_link=lambda eid: f"/#hplc-analysis/worksheet-detail?id={eid}",
                    can_flag=lambda user, eid: True,
                    context=_worksheet_context)
