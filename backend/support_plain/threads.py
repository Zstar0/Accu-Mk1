"""Pure normalization of Plain threads and timeline entries (spec 3.3, 3.4). No I/O."""
from __future__ import annotations

import logging
from typing import Any

from support_plain import rules

logger = logging.getLogger(__name__)
_logged_unknown: set[str] = set()

# Entry types whose `text` is aliased per type in queries.THREAD (same name, different nullability).
_TEXT = {"ChatEntry": ("chat", "chatText", False), "NoteEntry": ("note", "noteText", True),
         "SlackMessageEntry": ("slack", "slackText", False), "SlackReplyEntry": ("slack", "slackReplyText", False),
         "ThreadDiscussionMessageEntry": ("discussion", "discussionText", True)}
_EVENTS = {"ThreadStatusTransitionedEntry", "ThreadLabelsChangedEntry", "ThreadAssignmentTransitionedEntry",
           "ThreadPriorityChangedEntry"}


def _iso(dt: dict | None) -> str | None:
    return (dt or {}).get("iso8601")


def _name(obj: dict | None) -> str | None:
    return (obj or {}).get("fullName") or None


def _labels(labels) -> list[str]:
    return [l["labelType"]["name"] for l in labels or [] if (l.get("labelType") or {}).get("name")]


def _label_refs(labels) -> list[dict[str, str]]:
    out = []
    for l in labels or []:
        lt = l.get("labelType") or {}
        if l.get("id") and lt.get("id") and lt.get("name"):
            out.append({"id": l["id"], "type_id": lt["id"], "name": lt["name"]})
    return out


def plain_url(workspace_id: str, thread_id: str) -> str:
    return f"https://app.plain.com/workspace/{workspace_id}/thread/{thread_id}"


def _waiting_since(t: dict, status: str) -> str | None:
    if status == "done":
        return None
    inbound = _iso((t.get("lastInboundMessageInfo") or {}).get("timestamp"))
    outbound = _iso((t.get("lastOutboundMessageInfo") or {}).get("timestamp"))
    if not inbound or (outbound and outbound >= inbound):
        return None
    return inbound


def thread_item(t: dict, workspace_id: str) -> dict[str, Any]:
    status = rules.STATUS.get(t.get("status"), "open")
    preview = " ".join((t.get("previewText") or "").split())
    return {"id": t["id"], "ref": t.get("ref") or "", "title": t.get("title") or "(no subject)", "status": status,
            "priority": rules.PRIORITY.get(t.get("priority"), "normal"), "labels": _labels(t.get("labels")),
            "assignee": _name(t.get("assignedTo")), "created_at": _iso(t.get("createdAt")),
            "updated_at": _iso(t.get("updatedAt")), "preview": preview[:rules.PREVIEW_CHARS],
            "waiting_since": _waiting_since(t, status), "plain_url": plain_url(workspace_id, t["id"]),
            "assignee_id": (t.get("assignedTo") or {}).get("id"),
            "customer_plain_id": (t.get("customer") or {}).get("id"),
            "label_refs": _label_refs(t.get("labels"))}


def build_threads(raw: list[dict], workspace_id: str) -> list[dict[str, Any]]:
    items = [thread_item(t, workspace_id) for t in raw if not t.get("isTestThread")]
    return sorted(items, key=lambda i: i["updated_at"] or "", reverse=True)


def _actor(a: dict | None) -> tuple[str | None, str]:
    kind = (a or {}).get("__typename")
    if kind == "CustomerActor":
        return _name(a.get("customer")), "customer"
    if kind == "UserActor":
        return _name(a.get("user")), "agent"
    if kind == "MachineUserActor":
        return _name(a.get("machineUser")), "agent"
    return None, "system"


def _event_text(typ: str, e: dict, who: str | None) -> str:
    by = f" by {who}" if who else ""
    if typ == "ThreadStatusTransitionedEntry":
        return f"Marked {rules.STATUS.get(e.get('nextStatus'), 'open')}{by}"
    if typ == "ThreadLabelsChangedEntry":
        names = _labels(e.get("nextLabels"))
        return f"Labels: {', '.join(names) if names else 'none'}{by}"
    if typ == "ThreadAssignmentTransitionedEntry":
        to = _name(e.get("nextAssignee"))
        return (f"Assigned to {to}" if to else "Unassigned") + by
    return f"Priority set to {rules.PRIORITY.get(e.get('nextPriority'), 'normal')}{by}"


def _entry(node: dict, customer_name: str | None) -> dict[str, Any] | None:
    e = node.get("entry") or {}
    typ = e.get("__typename")
    who, kind = _actor(node.get("actor"))
    base = {"id": node["id"], "at": _iso(node.get("timestamp")), "author": who, "author_kind": kind,
            "internal": False, "subject": None}
    if typ == "EmailEntry":
        text = e.get("fullTextContent") if e.get("hasMoreTextContent") and e.get("fullTextContent") else e.get("textContent")
        frm = e.get("from") or {}
        return {**base, "kind": "email", "author": who or frm.get("name") or frm.get("email"),
                "subject": e.get("subject"), "text": text or ""}
    if typ == "CustomEntry":  # website contact form, posted by our machine user on the customer's behalf
        text = "\n".join(c["text"] for c in e.get("components") or [] if c.get("text"))
        return {**base, "kind": "form", "author": customer_name, "author_kind": "customer",
                "subject": e.get("title"), "text": text}
    if typ in _TEXT:
        kind_name, field, internal = _TEXT[typ]
        return {**base, "kind": kind_name, "internal": internal, "text": e.get(field) or ""}
    if typ in _EVENTS:
        return {**base, "kind": "event", "text": _event_text(typ, e, who)}
    if typ and typ not in _logged_unknown:
        _logged_unknown.add(typ)
        logger.info("support_plain.entry_dropped type=%s", typ)
    return None


def build_entries(nodes: list[dict], customer_name: str | None) -> list[dict[str, Any]]:
    out = [x for x in (_entry(n, customer_name) for n in nodes) if x]
    return sorted(out, key=lambda x: x["at"] or "")
