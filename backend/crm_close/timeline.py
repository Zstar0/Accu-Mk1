"""Close activities -> one normalized timeline. Pure: no I/O."""
from __future__ import annotations

import html
import re
from typing import Any

from crm_close import rules

_TAG = re.compile(r"<[^>]+>")
_BLOCK = re.compile(r"<\s*(br|/p|/div|/li|/tr|/h\d)\s*/?>", re.I)
_DROP = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.I | re.S)
_DIRECTIONS = {"incoming": "inbound", "inbound": "inbound", "outgoing": "outbound", "outbound": "outbound"}


def html_to_text(raw: str | None) -> str:
    if not raw:
        return ""
    s = _DROP.sub("", raw)
    s = _BLOCK.sub("\n", s)
    s = html.unescape(_TAG.sub("", s))
    return "\n".join(line.strip() for line in s.splitlines() if line.strip())


def _text_body(a: dict[str, Any]) -> str:
    return (a.get("body_text") or "").strip() or html_to_text(a.get("body_html"))


def _preview(text: str) -> str:
    return " ".join(text.split())[: rules.PREVIEW_CHARS]


def _at(a: dict[str, Any]) -> str | None:
    return a.get("starts_at") or a.get("activity_at") or a.get("date_sent") or a.get("date_created")


def _call_title(a: dict[str, Any]) -> str:
    parts = ["Call"]
    if a.get("disposition"):
        parts.append(str(a["disposition"]))
    secs = a.get("duration") or 0
    if secs:
        parts.append(f"{max(1, round(secs / 60))} min")
    return ", ".join(parts)


def normalize(a: dict[str, Any], lead_names: dict[str, str]) -> dict[str, Any] | None:
    kind = rules.KEPT_TYPES.get(a.get("_type", ""))
    if kind is None:
        return None
    direction = _DIRECTIONS.get((a.get("direction") or "").lower())
    support_url = None
    automated = False
    if kind == "email":
        body = _text_body(a)
        sender = (a.get("sender") or "").lower()
        automated = bool(rules.AUTOMATED_SUBJECT.search(a.get("subject") or "")) or any(
            s in sender for s in rules.AUTOMATED_SENDERS)
        who, title = a.get("sender") or a.get("user_name") or "", a.get("subject") or "(no subject)"
    elif kind == "call":
        body = a.get("note") or ""
        who, title = a.get("user_name") or a.get("phone") or "", _call_title(a)
    elif kind == "sms":
        body = a.get("text") or ""
        who, title = (a.get("remote_phone") if direction == "inbound" else a.get("user_name")) or "", "SMS"
    elif kind == "meeting":
        body = html_to_text(a.get("note")) if "<" in (a.get("note") or "") else (a.get("note") or "")
        who, title = a.get("user_name") or "", a.get("title") or "Meeting"
    else:  # note
        body = a.get("note") or html_to_text(a.get("note_html"))
        stripped = body.strip().strip("<>").strip()
        m = rules.PLAIN_URL.fullmatch(stripped) if stripped else None
        if m:
            support_url, title = m.group(0), "Support thread"
        else:
            title = (body.strip().splitlines() or [""])[0][:120]
        who = a.get("user_name") or ""
    return {
        "id": a["id"], "type": kind, "at": _at(a), "direction": direction, "who": who, "title": title,
        "preview": "" if support_url else _preview(body), "lead_id": a.get("lead_id"),
        "lead_name": lead_names.get(a.get("lead_id") or "", ""), "automated": automated,
        "support_thread_url": support_url,
    }


def build(activities: list[dict[str, Any]], lead_names: dict[str, str]) -> list[dict[str, Any]]:
    items = [i for i in (normalize(a, lead_names) for a in activities) if i is not None]
    dated = sorted((i for i in items if i["at"]), key=lambda i: i["at"], reverse=True)
    return dated + [i for i in items if not i["at"]]


def _email_message(a: dict[str, Any]) -> dict[str, Any]:
    return {"id": a["id"], "at": _at(a), "direction": _DIRECTIONS.get((a.get("direction") or "").lower()),
            "sender": a.get("sender") or "", "to": list(a.get("to") or []), "cc": list(a.get("cc") or []),
            "subject": a.get("subject") or "", "body": _text_body(a)}


def detail(a: dict[str, Any], thread: list[dict[str, Any]], lead_names: dict[str, str]) -> dict[str, Any]:
    """Full item. `thread` = the lead's emails sharing a.thread_id (ignored for other types)."""
    item = normalize(a, lead_names) or {}
    extra: dict[str, Any] = {}
    if item.get("type") == "email":
        by_id = {m["id"]: m for m in thread}
        by_id[a["id"]] = a  # the clicked email is always shown, even if the thread lookup missed it
        extra["messages"] = [_email_message(m) for m in sorted(by_id.values(), key=lambda m: _at(m) or "")]
    elif item.get("type") == "call":
        extra.update(duration=a.get("duration"), disposition=a.get("disposition"),
                     note=a.get("note") or "", recording_url=a.get("recording_url"), phone=a.get("phone"))
    elif item.get("type") == "sms":
        extra.update(text=a.get("text") or "", remote_phone=a.get("remote_phone"))
    elif item.get("type") == "meeting":
        extra.update(starts_at=a.get("starts_at"), ends_at=a.get("ends_at"),
                     attendees=[v for v in (x.get("email") or x.get("name") for x in a.get("attendees") or []) if v],
                     note=html_to_text(a.get("note")) if "<" in (a.get("note") or "") else (a.get("note") or ""))
    elif item.get("type") == "note":
        extra["note"] = a.get("note") or html_to_text(a.get("note_html"))
    return {**item, **extra}
