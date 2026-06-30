"""Pure type/status catalog for flags. No DB, no host coupling.

Type definitions are data here (a config map). Promote to a DB table only if
the lab needs to self-manage types (deferred).
"""
from __future__ import annotations

# type -> definition. `kind` groups behavior; `color` is the UI accent;
# `blocking` marks types that should weight triage; `signal` types are positive.
FLAG_TYPES: dict[str, dict] = {
    "blocker":               {"kind": "issue",  "label": "Blocker",              "color": "#e5484d", "blocking": True},
    "critical":              {"kind": "issue",  "label": "Critical",             "color": "#e8730a", "blocking": True},
    "question":              {"kind": "issue",  "label": "Question",             "color": "#3b82f6", "blocking": False},
    "waiting_on_customer":   {"kind": "issue",  "label": "Waiting on Customer",  "color": "#8b5cf6", "blocking": False},
    "ready_for_verification":{"kind": "signal", "label": "Ready for Verification","color": "#22c55e", "blocking": False},
}

STATUSES = ["open", "in_progress", "resolved", "closed"]

# Lifecycle. Forward flow plus reopen from resolved/closed. open->closed and
# open->resolved are allowed (a flag can be resolved/closed directly).
LEGAL_TRANSITIONS: dict[str, set[str]] = {
    "open":        {"in_progress", "resolved", "closed"},
    "in_progress": {"resolved", "closed", "open"},
    "resolved":    {"closed", "open", "in_progress"},
    "closed":      {"open", "in_progress"},
}


def is_valid_type(type_: str) -> bool:
    return type_ in FLAG_TYPES


def kind_for_type(type_: str) -> str:
    try:
        return FLAG_TYPES[type_]["kind"]
    except KeyError:
        raise ValueError(f"unknown flag type {type_!r}")


def is_legal_transition(frm: str, to: str) -> bool:
    if to not in STATUSES:
        return False
    return to in LEGAL_TRANSITIONS.get(frm, set())
