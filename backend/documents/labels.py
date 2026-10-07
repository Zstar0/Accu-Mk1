"""Quick-label catalog (spec 2026-10-03 §4.3). A constant for v1, adapted from
plannotator's DEFAULT_QUICK_LABELS to lab documents. `tip` is the instruction
the export hands to the agent that revises the document. Moving this to
Settings later does not change the route shape."""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Optional


@dataclass(frozen=True)
class CommentLabel:
    id: str
    emoji: str
    text: str
    color: str
    tip: Optional[str] = None


COMMENT_LABELS: tuple[CommentLabel, ...] = (
    CommentLabel("clarify-this", "❓", "Clarify this", "yellow",
                 "This passage is ambiguous. Rewrite it so a new technician reads it one way."),
    CommentLabel("verify-this", "🔍", "Verify this", "orange",
                 "This reads as an assumption. Verify it against the method, the instrument "
                 "output, or the data before the next revision, and say what you checked."),
    CommentLabel("out-of-date", "⏳", "Out of date", "amber",
                 "This no longer matches current practice or the current system. Update it to "
                 "what is true today and note the change."),
    CommentLabel("needs-reference", "📎", "Needs reference", "blue",
                 "Cite the SOP, method, specification, or source this statement rests on."),
    CommentLabel("needs-example", "🔬", "Needs example", "cyan",
                 "Too abstract. Add a worked example, sample values, or a specific scenario."),
    CommentLabel("out-of-scope", "🚫", "Out of scope", "red",
                 "This does not belong in this document. Remove it, or move it to the document "
                 "that owns it."),
    CommentLabel("needs-sign-off", "✍️", "Needs sign-off", "purple",
                 "This changes a controlled behaviour. Do not activate until the responsible "
                 "person has approved it."),
    CommentLabel("match-format", "🧬", "Match existing format", "teal",
                 "Follow the structure and vocabulary of the lab's existing SOPs and artifacts "
                 "instead of introducing a new layout."),
    CommentLabel("nice-work", "👍", "Nice work", "green", None),
)
_BY_ID = {label.id: label for label in COMMENT_LABELS}


def get_label(label_id: Optional[str]) -> Optional[CommentLabel]:
    return _BY_ID.get(label_id or "")


def label_ids() -> frozenset[str]:
    return frozenset(_BY_ID)


def labels_out() -> list[dict]:
    return [asdict(label) for label in COMMENT_LABELS]
