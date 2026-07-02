"""Block Kit DM payloads for flag events. Pure — no I/O."""
from __future__ import annotations

from typing import Optional
from urllib.parse import quote

_ENTITY_LABEL = {"sample": "Sample", "sub_sample": "Vial", "worksheet": "Worksheet"}
_STATUS_LABEL = {"open": "Open", "in_progress": "In progress", "blocked": "Blocked",
                 "resolved": "Resolved", "closed": "Closed"}

_ACTION = {
    "assigned": "{actor} assigned you a flag",
    "mentioned": "{actor} mentioned you in a flag comment",
    "raised_activity": "{actor} updated a flag you raised",
    "watching_activity": "{actor} commented on a flag you're watching",
    "status_changes": "{actor} changed the status of your flag",
}

_EXCERPT_MAX = 140


def _entity_label(flag: dict) -> str:
    kind = _ENTITY_LABEL.get(flag.get("entity_type"), flag.get("entity_type", ""))
    return f"{kind} {flag.get('entity_id', '')}".strip()


def link_hash_for(deep_link: Optional[dict], flag_id: int) -> str:
    """Hash fragment for the DM's tap-through URL: land on the flagged
    entity's page AND open the flag thread (`?flag=` composes with any
    route). Unresolvable entity → dashboard fallback, thread still opens."""
    kind = (deep_link or {}).get("kind")
    eid = quote(str((deep_link or {}).get("id", "")), safe="")
    if kind == "sample" and eid:
        return f"#senaite/sample-details?id={eid}&flag={flag_id}"
    if kind == "worksheet" and eid:
        return f"#hplc-analysis/worksheet-detail?id={eid}&flag={flag_id}"
    return f"#dashboard/orders?flag={flag_id}"


def build_message(event: dict, category: str, actor_label: str,
                  base_url: str,
                  link_hash: Optional[str] = None) -> tuple[str, list[dict]]:
    flag = event.get("flag") or {}
    action = _ACTION.get(category, "{actor} updated a flag").format(actor=actor_label)
    if event.get("event_type") == "status_changed" and event.get("to_value"):
        action += f" → {_STATUS_LABEL.get(event['to_value'], event['to_value'])}"
    title = flag.get("title", "")
    status = _STATUS_LABEL.get(flag.get("status"), flag.get("status", ""))
    context = f"{_entity_label(flag)} · {str(flag.get('type', '')).replace('_', ' ').title()} · {status}"
    link = f"{base_url.rstrip('/')}/{link_hash or link_hash_for(None, flag.get('id'))}"

    text = f"{action}: {title}"
    blocks: list[dict] = [
        {"type": "section",
         "text": {"type": "mrkdwn", "text": f"*{action}*\n<{link}|{title}>"}},
        {"type": "context",
         "elements": [{"type": "mrkdwn", "text": context}]},
    ]
    excerpt = (event.get("details") or {}).get("body_excerpt")
    if excerpt:
        blocks.insert(1, {"type": "section",
                          "text": {"type": "mrkdwn",
                                   "text": f"> {excerpt[:_EXCERPT_MAX]}"}})
    return text, blocks
