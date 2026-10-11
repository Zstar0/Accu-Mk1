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


_DETAIL = {
    "ThreadStatusDetailCreated": ("needs_first_response", "Needs first response"),
    "ThreadStatusDetailNewReply": ("needs_next_response", "Needs next response"),
    "ThreadStatusDetailUnsnoozed": ("needs_next_response", "Needs next response"),
    "ThreadStatusDetailThreadLinkUpdated": ("needs_next_response", "Needs next response"),
    "ThreadStatusDetailLinearUpdated": ("needs_next_response", "Needs next response"),
    "ThreadStatusDetailThreadDiscussionResolved": ("needs_next_response", "Needs next response"),
    "ThreadStatusDetailReplied": ("in_progress", "In progress"),
    "ThreadStatusDetailInProgress": ("in_progress", "In progress"),
    "ThreadStatusDetailWaitingForCustomer": ("waiting_for_customer", "Waiting for customer"),
    "ThreadStatusDetailWaitingIndefinitely": ("waiting", "Waiting"),
    "ThreadStatusDetailDoneManuallySet": ("done", "Done"),
    "ThreadStatusDetailIgnored": ("done", "Done"),
    "ThreadStatusDetailDoneAutomaticallySet": ("done_auto", "Done automatically"),
}
_BY_STATUS = {"TODO": ("needs_next_response", "Needs next response"), "SNOOZED": ("waiting", "Waiting"),
              "DONE": ("done", "Done")}
WP_PROFILE = "https://accumarklabs.com/wp-admin/user-edit.php?user_id={}"


def status_detail(t: dict) -> dict[str, Any]:
    d = t.get("statusDetail") or {}
    typ = d.get("__typename")
    until = _iso(d.get("waitingUntil") or d.get("snoozedUntil"))
    if typ in ("ThreadStatusDetailWaitingForDuration", "ThreadStatusDetailSnoozed") and until:
        return {"kind": "waiting_until", "label": f"Waiting until {until[:10]}", "until": until}
    kind, label = _DETAIL.get(typ) or _BY_STATUS.get(t.get("status"), _BY_STATUS["TODO"])
    return {"kind": kind, "label": label, "until": None}


def _person(a: dict | None, primary: bool) -> dict[str, Any] | None:
    if not a or not a.get("fullName"):
        return None
    is_user = a.get("__typename") == "User"
    return {"plain_user_id": a.get("id") if is_user else None, "name": a["fullName"],
            "avatar_url": a.get("avatarUrl") if is_user else None, "primary": primary}


def assignees(t: dict) -> list[dict[str, Any]]:
    people = [_person(t.get("assignedTo"), True)] + [_person(a, False) for a in t.get("additionalAssignees") or []]
    return [p for p in people if p]


def _field_value(f: dict) -> str | None:
    if f.get("stringValue") not in (None, ""):
        return str(f["stringValue"])
    if f.get("booleanValue") is not None:
        return "Yes" if f["booleanValue"] else "No"
    if f.get("numberValue") is not None:
        n = f["numberValue"]
        return str(int(n)) if float(n).is_integer() else str(n)
    date = _iso(f.get("dateValue"))
    return date[:10] if date else None


def fields(t: dict, schemas: list[dict]) -> list[dict[str, Any]]:
    values = {f["key"]: _field_value(f) for f in t.get("threadFields") or [] if f.get("key")}
    known = sorted((s for s in schemas if s.get("key")), key=lambda s: s.get("order") or 0)
    out = [{"key": s["key"], "label": s.get("label") or s["key"], "value": values.pop(s["key"], None)} for s in known]
    return out + [{"key": k, "label": k, "value": v} for k, v in values.items()]


def customer_block(t: dict) -> dict[str, Any] | None:
    c = t.get("customer") or {}
    if not c.get("fullName"):
        return None
    ext = c.get("externalId")
    return {"name": c["fullName"], "email": (c.get("email") or {}).get("email"), "external_id": ext,
            "avatar_url": c.get("avatarUrl"), "company": (c.get("company") or {}).get("name"),
            "created_at": _iso(c.get("createdAt")), "updated_at": _iso(c.get("updatedAt")),
            "wp_profile_url": WP_PROFILE.format(ext) if ext and str(ext).isdigit() else None}


def detail_extras(t: dict, schemas: list[dict]) -> dict[str, Any]:
    tier = t.get("tier") or {}
    return {"status_detail": status_detail(t), "assignees": assignees(t),
            "tier": {"name": tier["name"], "color": tier.get("color")} if tier.get("name") else None,
            "fields": fields(t, schemas), "customer": customer_block(t)}


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


def _actor(a: dict | None) -> tuple[str | None, str, str | None, str | None]:
    """(name, author_kind, avatar_url, actor typename)."""
    kind = (a or {}).get("__typename")
    if kind == "CustomerActor":
        c = a.get("customer") or {}
        return _name(c), "customer", c.get("avatarUrl"), kind
    if kind == "UserActor":
        u = a.get("user") or {}
        return _name(u), "agent", u.get("avatarUrl"), kind
    if kind == "MachineUserActor":
        return _name(a.get("machineUser")), "agent", None, kind
    return None, "system", None, kind


_STATUS_WORD = {"open": "Todo", "snoozed": "Snoozed", "done": "Done"}


def _event(typ: str, e: dict, who: str | None) -> dict[str, str]:
    actor = who or "Plain"
    if typ == "ThreadStatusTransitionedEntry":
        word = _STATUS_WORD[rules.STATUS.get(e.get("nextStatus"), "open")]
        return {"icon": "status", "actor": actor, "text": f"changed status to {word}"}
    if typ == "ThreadLabelsChangedEntry":
        names = _labels(e.get("nextLabels"))
        return {"icon": "label", "actor": actor, "text": f"set labels to {', '.join(names)}" if names else "removed all labels"}
    if typ == "ThreadAssignmentTransitionedEntry":
        to = _name(e.get("nextAssignee"))
        return {"icon": "assign", "actor": actor, "text": f"assigned {to}" if to else "unassigned the thread"}
    level = rules.PRIORITY.get(e.get("nextPriority"), "normal")
    return {"icon": "priority", "actor": actor, "text": f"set priority to {level.capitalize()}"}


def _fmt(p: dict | None) -> str | None:
    p = p or {}
    if not p.get("email"):
        return None
    return f"{p['name']} <{p['email']}>" if p.get("name") else p["email"]


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
    who, kind, avatar, actor_type = _actor(node.get("actor"))
    bot = actor_type in ("SystemActor", "MachineUserActor")
    base = {"id": node["id"], "at": _iso(node.get("timestamp")), "author": who, "author_kind": kind,
            "internal": False, "subject": None, "author_avatar_url": avatar, "automated": False,
            "email_to": None, "email_from": None, "markdown": None, "event": None}
    if typ == "EmailEntry":
        text = e.get("fullTextContent") if e.get("hasMoreTextContent") and e.get("fullTextContent") else e.get("textContent")
        md = e.get("fullMarkdownContent") if e.get("hasMoreMarkdownContent") and e.get("fullMarkdownContent") else e.get("markdownContent")
        frm = e.get("from") or {}
        return {**base, "kind": "email", "author": who or frm.get("name") or frm.get("email"),
                "subject": e.get("subject"), "text": text or "", "markdown": md or None, "automated": bot,
                "email_to": _fmt(e.get("to")), "email_from": _fmt(frm)}
    if typ == "CustomEntry":  # website contact form, posted by our machine user on the customer's behalf
        text = "\n".join(c["text"] for c in e.get("components") or [] if c.get("text"))
        return {**base, "kind": "form", "author": customer_name, "author_kind": "customer",
                "author_avatar_url": None, "subject": e.get("title"), "text": text}
    if typ in _TEXT:
        kind_name, field, internal = _TEXT[typ]
        return {**base, "kind": kind_name, "internal": internal, "text": e.get(field) or "",
                "automated": bot and typ == "ChatEntry"}
    if typ in _EVENTS:
        return {**base, "kind": "event", "text": _event_text(typ, e, who), "event": _event(typ, e, who)}
    if typ and typ not in _logged_unknown:
        _logged_unknown.add(typ)
        logger.info("support_plain.entry_dropped type=%s", typ)
    return None


def build_entries(nodes: list[dict], customer_name: str | None) -> list[dict[str, Any]]:
    out = [x for x in (_entry(n, customer_name) for n in nodes) if x]
    return sorted(out, key=lambda x: x["at"] or "")
