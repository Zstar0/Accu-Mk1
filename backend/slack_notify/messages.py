"""Block Kit DM payloads for flag events. Pure — no I/O."""
from __future__ import annotations

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


def build_message(event: dict, category: str, actor_label: str,
                  base_url: str) -> tuple[str, list[dict]]:
    flag = event.get("flag") or {}
    action = _ACTION.get(category, "{actor} updated a flag").format(actor=actor_label)
    if event.get("event_type") == "status_changed" and event.get("to_value"):
        action += f" → {_STATUS_LABEL.get(event['to_value'], event['to_value'])}"
    title = flag.get("title", "")
    status = _STATUS_LABEL.get(flag.get("status"), flag.get("status", ""))
    context = f"{_entity_label(flag)} · {str(flag.get('type', '')).replace('_', ' ').title()} · {status}"
    link = f"{base_url.rstrip('/')}/#dashboard/orders?flag={flag.get('id')}"

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
