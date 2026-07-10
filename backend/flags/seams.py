"""Host seams for the flags module.

The module never imports host domain models directly for entity resolution —
the host registers entity types and supplies a user provider + event sink.
Defaults wire Mk1, but the core depends only on these callables.
"""
from __future__ import annotations

import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional, Protocol

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
    # Optional state resolver (Plan 6 — state-change watches). Returns the
    # entity's current host-domain workflow state (e.g. a sample's status) or
    # None when unresolvable. ONLY entity types that register a `state` closure
    # are watchable; the rest 400 at arm time.
    state: Optional[Callable[[Session, str], Optional[str]]] = None
    # Optional typeahead resolver (Plan 6 follow-up — link pickers). Given a
    # query string, returns up to a handful of `{"entity_id", "label"}` hits for
    # a search-as-you-type picker. Pure host-domain closure; the core never
    # learns how a sample or worksheet is matched.
    search: Optional[Callable[[Session, str], list]] = None


_REGISTRY: dict[str, EntitySpec] = {}


def register_entity(entity_type: str, *, label, deep_link, can_flag,
                    context=None, descendants=None, state=None,
                    search=None) -> None:
    _REGISTRY[entity_type] = EntitySpec(entity_type, label, deep_link, can_flag,
                                        context=context, descendants=descendants,
                                        state=state, search=search)


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


def has_state_seam(entity_type: str) -> bool:
    """True when the entity type registered a `state` closure (→ watchable).
    Deliberately distinct from `resolve_state` returning None, which can mean
    'unresolvable right now'. Arm-time validation uses THIS."""
    spec = _REGISTRY.get(entity_type)
    return spec is not None and spec.state is not None


def resolve_state(db: Session, entity_type: str, entity_id: str) -> Optional[str]:
    """Current host state for an entity, or None (unregistered, no `state`
    closure, row gone, or resolver error). Best-effort — never raises into the
    poller (a transient None just means 'no match this tick')."""
    spec = _REGISTRY.get(entity_type)
    if spec is None or spec.state is None:
        return None
    try:
        return spec.state(db, str(entity_id))
    except Exception:  # noqa: BLE001 — state read is best-effort
        return None


def resolve_entity_search(db: Session, entity_type: str, q: str) -> list:
    """Typeahead hits for a registered entity type, as
    `[{"entity_id": str, "label": str}, …]`. Returns [] for an unregistered
    type, a type with no `search` resolver, or on resolver error — never raises
    into a request (mirrors resolve_context/resolve_state; a picker with no
    results is fine, a 500 is not)."""
    spec = _REGISTRY.get(entity_type)
    if spec is None or spec.search is None:
        return []
    try:
        rows = spec.search(db, str(q))
    except Exception:  # noqa: BLE001 — search is best-effort decoration
        return []
    return list(rows or [])


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


# --- virtual item kinds (Phase 2 slice 7) --------------------------------
def resolve_virtual_kind(db: Session, entity_type: str):
    """Return the active FlagItemKind row for `entity_type`, or None.

    A "virtual kind" is a user-managed category (general_task, purchase_task, …)
    a flag anchors to WITHOUT a registered entity seam and WITHOUT a Mk1 row —
    `entity_id` is NULL. This is the one place the create-flag validation
    consults so a kind slug passes the `is_registered` gate; watches/entity-links
    stay `is_registered`-only, so arming a watch or linking a related item on a
    kind still 400s / returns [] (no deep-link/state/search affordances). Only
    ACTIVE kinds resolve — a deactivated kind can't take new flags. Kept here
    (not in the pure core) so the module still reaches host models only through a
    seam, mirroring resolve_user."""
    from sqlalchemy import select
    from models import FlagItemKind
    return db.execute(
        select(FlagItemKind).where(
            FlagItemKind.slug == entity_type,
            FlagItemKind.is_active.is_(True),
        )
    ).scalar_one_or_none()


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


# --- attachment storage seam (Plan 3) ------------------------------------
# The flags module never imports boto3 or host storage modules. The host wires
# an S3-backed adapter (see main.py) that satisfies this Protocol; the default
# is a local filesystem store so dev/test work with zero config.
class AttachmentNotFound(LookupError):
    """fetch() could not locate a key."""


class AttachmentStorageError(RuntimeError):
    """Any storage-layer failure (bad key, write/read error)."""


class AttachmentStorage(Protocol):
    def save(self, flag_id: str, data: bytes, filename: str) -> str: ...
    def fetch(self, key: str) -> bytes: ...
    def delete(self, key: str) -> None: ...


def _attach_ext(filename: str) -> str:
    ext = Path(filename or "").suffix.lower()
    return ext if ext in {".png", ".jpg", ".jpeg", ".gif", ".webp"} else ".bin"


class InMemoryAttachmentStorage:
    """No-disk store for tests/dev. Key = 'flag_id/uuid.ext'."""
    def __init__(self) -> None:
        self._blobs: dict[str, bytes] = {}

    def save(self, flag_id: str, data: bytes, filename: str) -> str:
        key = f"{flag_id}/{uuid.uuid4().hex}{_attach_ext(filename)}"
        self._blobs[key] = data
        return key

    def fetch(self, key: str) -> bytes:
        if key not in self._blobs:
            raise AttachmentNotFound(key)
        return self._blobs[key]

    def delete(self, key: str) -> None:
        self._blobs.pop(key, None)


class FilesystemAttachmentStorage:
    """Prod default. One file per attachment under {root}/{flag_id}/{uuid}.{ext}."""
    def __init__(self, root: str | None = None) -> None:
        self.root = Path(root or os.environ.get("MK1_FLAG_ATTACH_DIR", "/data/flag_attachments"))
        self.root.mkdir(parents=True, exist_ok=True)

    def save(self, flag_id: str, data: bytes, filename: str) -> str:
        rel = f"{flag_id}/{uuid.uuid4().hex}{_attach_ext(filename)}"
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return rel

    def fetch(self, key: str) -> bytes:
        p = self._safe(key)
        if not p.exists():
            raise AttachmentNotFound(key)
        return p.read_bytes()

    def delete(self, key: str) -> None:
        p = self._safe(key)
        if p.exists():
            p.unlink()

    def _safe(self, key: str) -> Path:
        if not key or key.startswith("/") or ".." in key.split("/"):
            raise AttachmentStorageError(f"unsafe key: {key!r}")
        resolved = (self.root / key).resolve()
        try:
            resolved.relative_to(self.root.resolve())
        except ValueError as e:
            raise AttachmentStorageError(f"key escapes root: {key!r}") from e
        return resolved


_ATTACHMENT_STORAGE: "AttachmentStorage | None" = None


def get_attachment_storage() -> "AttachmentStorage":
    global _ATTACHMENT_STORAGE
    if _ATTACHMENT_STORAGE is None:
        _ATTACHMENT_STORAGE = FilesystemAttachmentStorage()
    return _ATTACHMENT_STORAGE


def set_attachment_storage(storage: "AttachmentStorage") -> None:
    global _ATTACHMENT_STORAGE
    _ATTACHMENT_STORAGE = storage


def set_attachment_storage_for_tests(storage: "AttachmentStorage") -> None:
    set_attachment_storage(storage)


# --- Mk1 registrations ---------------------------------------------------
def _ilike_prefix(q: str) -> str:
    r"""An escaped `q%` ILIKE pattern for search-as-you-type. LIKE metacharacters
    are matched literally (escape char `\`), so typing `%`/`_` finds the literal
    rather than a wildcard. Prefix (not substring) — a typeahead over ids/titles
    anchors on the start. Mirrors service._like_pattern's escaping; kept local so
    seams does not depend on the higher service layer."""
    esc = str(q).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"{esc}%"


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

    def _sample_state(db, eid):
        row = _load_sample(db, eid)
        return getattr(row, "status", None)

    def _sub_sample_label(db, eid):
        from models import LimsSubSample
        row = db.get(LimsSubSample, int(eid)) if str(eid).isdigit() else None
        return getattr(row, "sample_id", None) or f"Sub Sample {eid}"

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

    # --- typeahead search closures (link pickers) ------------------------
    # entity_id is per-type to match how each type's context/deep-link
    # resolves and how existing links dedup: sample → human sample_id,
    # sub_sample/worksheet → the pk their resolvers accept.
    def _sample_search(db, q):
        from models import LimsSample
        pattern = _ilike_prefix(q)
        rows = (db.query(LimsSample)
                .filter(LimsSample.sample_id.ilike(pattern, escape="\\"))
                .order_by(LimsSample.sample_id)
                .limit(10).all())
        return [{"entity_id": r.sample_id, "label": r.sample_id} for r in rows]

    def _sub_sample_search(db, q):
        from models import LimsSubSample
        pattern = _ilike_prefix(q)
        rows = (db.query(LimsSubSample)
                .filter(LimsSubSample.sample_id.ilike(pattern, escape="\\"))
                .order_by(LimsSubSample.sample_id)
                .limit(10).all())
        return [{"entity_id": str(r.id), "label": r.sample_id} for r in rows]

    def _worksheet_search(db, q):
        from sqlalchemy import or_
        from models import Worksheet
        cond = Worksheet.title.ilike(_ilike_prefix(q), escape="\\")
        if str(q).isdigit():
            cond = or_(cond, Worksheet.id == int(q))
        rows = (db.query(Worksheet).filter(cond)
                .order_by(Worksheet.id.desc())
                .limit(10).all())
        return [{"entity_id": str(r.id), "label": r.title or f"Worksheet {r.id}"}
                for r in rows]

    # Deep links reconciled against the real frontend useHashNavigation routes
    # (Plan 3 Task 7). Hash format is `#<section>/<subsection>?id=<id>`.
    register_entity("sample",
                    label=_sample_label,
                    deep_link=lambda eid: f"/#senaite/sample-details?id={eid}",
                    can_flag=lambda user, eid: True,
                    context=_sample_context,
                    descendants=_sample_descendants,
                    state=_sample_state,
                    search=_sample_search)
    register_entity("sub_sample",
                    label=_sub_sample_label,
                    deep_link=lambda eid: f"/#senaite/sample-details?id={eid}",
                    can_flag=lambda user, eid: True,
                    context=_sub_sample_context,
                    search=_sub_sample_search)
    register_entity("worksheet",
                    label=lambda db, eid: f"Worksheet {eid}",
                    deep_link=lambda eid: f"/#hplc-analysis/worksheet-detail?id={eid}",
                    can_flag=lambda user, eid: True,
                    context=_worksheet_context,
                    search=_worksheet_search)
