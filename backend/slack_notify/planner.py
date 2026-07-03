"""Plan which users get a Slack DM for a flag event, and under which category.

Pure DB logic — no Slack calls. Category resolution order (first match wins):
assigned > mentioned > raised_activity (creator) > watching_activity
(participant) > status_changes (assignee). The actor never gets a DM.
`raised` never DMs (creator == actor, no watchers yet) — this IS the
raised+assigned collapse: the follow-up `assigned` event is the one DM.
"""
from __future__ import annotations

from dataclasses import dataclass

from models import SlackDmPrefs
from flags.models import FlagParticipant

CATEGORIES = ("assigned", "mentioned", "raised_activity",
              "watching_activity", "status_changes")
DEFAULTS = {c: True for c in CATEGORIES}

_PREF_COLUMN = {
    "assigned": "notify_assigned",
    "mentioned": "notify_mentioned",
    "raised_activity": "notify_raised_activity",
    "watching_activity": "notify_watching_activity",
    "status_changes": "notify_status_changes",
}


@dataclass(frozen=True)
class PlannedDM:
    user_id: int
    category: str


def _wants(db, user_id: int, category: str) -> bool:
    row = db.query(SlackDmPrefs).filter(SlackDmPrefs.user_id == user_id).first()
    if row is None:
        return True
    if not row.enabled:
        return False
    return bool(getattr(row, _PREF_COLUMN[category]))


def plan_dms(db, event: dict) -> list[PlannedDM]:
    etype = event.get("event_type")
    flag = event.get("flag") or {}
    actor_id = event.get("actor_id")
    planned: dict[int, str] = {}   # user_id -> category (first match wins)

    def consider(user_id, category):
        if user_id is None or user_id == actor_id or user_id in planned:
            return
        planned[user_id] = category

    if etype == "assigned":
        to_value = event.get("to_value")
        if to_value is not None:
            consider(int(to_value), "assigned")
    elif etype in ("commented", "status_changed"):
        if etype == "commented":
            for uid in (event.get("details") or {}).get("mentions") or []:
                consider(int(uid), "mentioned")
        consider(flag.get("created_by"), "raised_activity")
        watcher_ids = [
            uid for (uid,) in db.query(FlagParticipant.user_id)
            .filter(FlagParticipant.flag_id == event.get("flag_id")).all()
        ]
        for uid in watcher_ids:
            consider(uid, "watching_activity")
        if etype == "status_changed":
            consider(flag.get("assignee_id"), "status_changes")
    else:
        return []   # raised / unassigned / watcher_* never DM

    return [PlannedDM(user_id=u, category=c) for u, c in planned.items()
            if _wants(db, u, c)]
