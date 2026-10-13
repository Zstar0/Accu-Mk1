"""Per-revision provenance (2026-10-11): who created a revision, who asked for it, and
where it came from, each labelled with how much of it Mk1 actually verified.

Server-owned, set from the credential or by in-process Mk1 code, never from a request
body: creator_kind/creator_ref, requested_by_user_id, source_verified and
content_edited_by_user_id/at. Caller-supplied and therefore ASSERTED: source_system,
source_record_*, source_run_id and the legacy free-text `author`.

An agent token proves the agent, not the channel: nothing here infers a source system
from who wrote the row. Rows written before these columns existed are derived only
from columns the server always set (created_by_user_id, co_author) and otherwise read
as unknown. Nothing is parsed out of source_session or any other free text."""
from __future__ import annotations

import re
from typing import Iterable, Optional

from documents.errors import BadRequestError

# Registered source systems. A caller may only NAME one of these; naming it does not
# verify it. Adding a system is one line here.
SOURCE_SYSTEMS = {
    "accumk1": "AccuMk1",
    "paperclip": "Paperclip",
    "valence-hq": "Valence HQ",
    "slack": "Slack",
    "claude-code": "Claude Code",
}
# Specific service identities. "internal-token" is the generic shared service token,
# which names no caller; it is never read as any particular agent.
SERVICE_LABELS = {"internal-token": "Internal service token", "ai-review": "AccuMk1 AI review"}

# Identifiers, not prose: no whitespace, no '/', so no URL, prompt or transcript fits.
_TYPE_RE = re.compile(r"^[a-z][a-z0-9_-]{0,39}$")
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$")
_LABEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._#:-]{0,99}$")
_SOURCE_FIELDS = ("source_system", "source_record_type", "source_record_id",
                  "source_record_label", "source_run_id")


def source_columns(fields: Optional[dict], *, verified: bool = False) -> dict:
    """Validated source columns for a new revision. `verified` is for in-process Mk1
    writers only; every HTTP caller's source is asserted. Errors name the field, never
    echo the value."""
    vals = {k: ((fields or {}).get(k) or "").strip() or None for k in _SOURCE_FIELDS}
    if not any(vals.values()):
        return {}
    system = vals["source_system"]
    if system not in SOURCE_SYSTEMS:
        raise BadRequestError(f"provenance.source_system must be one of {sorted(SOURCE_SYSTEMS)}")
    if (vals["source_record_id"] or vals["source_record_label"]) and not vals["source_record_type"]:
        raise BadRequestError("provenance.source_record_type is required with a record id or label")
    for key, rx in (("source_record_type", _TYPE_RE), ("source_record_id", _ID_RE),
                    ("source_record_label", _LABEL_RE), ("source_run_id", _ID_RE)):
        if vals[key] is not None and not rx.match(vals[key]):
            raise BadRequestError(f"provenance.{key} has characters or a length it may not have")
    return {**vals, "source_verified": verified}


def requester_is_self(user, author: Optional[str]) -> bool:
    """A login names itself as requester when it sends no author, or its own display
    name or email. Anyone else it names is only a supplied name."""
    from documents.comments import display_name
    given = (author or "").strip().casefold()
    if not given:
        return True
    own = {display_name(user).strip().casefold(), (getattr(user, "email", None) or "").strip().casefold()}
    return given in own - {""}


def user_names(db, docs: Iterable) -> dict[int, str]:
    from documents.comments import _user_names
    ids = []
    for d in docs:
        ids += [d.created_by_user_id, d.requested_by_user_id, d.content_edited_by_user_id]
    return _user_names(db, ids)


def _creator(doc) -> tuple[str, Optional[str]]:
    if doc.creator_kind:
        return doc.creator_kind, doc.creator_ref
    # Pre-provenance rows: both columns were only ever set server-side from the credential.
    if doc.created_by_user_id is not None:
        return "user", str(doc.created_by_user_id)
    if doc.co_author:
        return "agent", doc.co_author
    return "unknown", None


def provenance_out(doc, names: dict[int, str]) -> dict:
    kind, ref = _creator(doc)
    if kind == "user":
        uid = doc.created_by_user_id
        label = names.get(uid) if uid is not None else None
        label = label or (f"user {uid}" if uid is not None else "deleted user")
    elif kind == "agent":
        label = ref
    elif kind == "service":
        label = SERVICE_LABELS.get(ref, ref or "service")
    else:
        label = "unknown (recorded before provenance)"
    requested_by = None
    if doc.requested_by_user_id is not None:
        requested_by = {"label": names.get(doc.requested_by_user_id) or doc.author
                        or f"user {doc.requested_by_user_id}",
                        "user_id": doc.requested_by_user_id, "verified": True}
    elif doc.author:
        requested_by = {"label": doc.author, "user_id": None, "verified": False}
    source = None
    if doc.source_system:
        source = {"system": doc.source_system,
                  "system_label": SOURCE_SYSTEMS.get(doc.source_system, doc.source_system),
                  "verified": bool(doc.source_verified),
                  "record_type": doc.source_record_type, "record_id": doc.source_record_id,
                  "record_label": doc.source_record_label, "run_id": doc.source_run_id}
    content_edited = None
    if doc.content_edited_at is not None:
        uid = doc.content_edited_by_user_id
        content_edited = {"by": names.get(uid) or (f"user {uid}" if uid is not None else "deleted user"),
                          "at": doc.content_edited_at}
    return {"version": 1,
            "creator": {"kind": kind, "id": ref, "label": label, "verified": kind != "unknown"},
            "requested_by": requested_by, "source": source, "content_edited": content_edited}
