"""Workflow catalog service. Descriptive-only while SENAITE is authority —
validation here guards catalog INTEGRITY, never live workflow behavior."""
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from models import (LimsAnalysis, LimsSample, LimsWorkflowState,
                    LimsWorkflowTransition)

REQUIREMENT_KINDS = frozenset({"all_analyses_in_state", "field_present",
                               "role_at_least", "manual"})


def validate_requirements(entries) -> list:
    """Shape-validate requirement entries (spec §5.3). Returns the cleaned
    list ({kind, value, note} only); raises ValueError on any bad entry.
    Entries are stored + rendered, never evaluated, until the authority swap."""
    if not isinstance(entries, list):
        raise ValueError("requirements must be a list")
    cleaned = []
    for e in entries:
        if not isinstance(e, dict) or e.get("kind") not in REQUIREMENT_KINDS:
            raise ValueError(f"unknown requirement kind: {e!r}")
        if e["kind"] != "manual" and not e.get("value"):
            raise ValueError(f"requirement kind {e['kind']} needs a value")
        cleaned.append({"kind": e["kind"], "value": e.get("value"),
                        "note": e.get("note")})
    return cleaned


def usage_counts(db: Session, scope: str) -> dict[str, int]:
    """Live rows per state slug. sample scope: lims_samples.status group-by.
    analysis scope: canonical rows by review_state PLUS shadow rows by
    mirror_review_state (their own review_state is the sentinel), summed."""
    if scope == "sample":
        rows = db.execute(select(LimsSample.status, func.count())
                          .group_by(LimsSample.status)).all()
        return {s: c for s, c in rows if s}
    counts: dict[str, int] = {}
    for col, flt in ((LimsAnalysis.review_state, LimsAnalysis.provenance == "canonical"),
                     (LimsAnalysis.mirror_review_state, LimsAnalysis.provenance == "shadow")):
        for s, c in db.execute(select(col, func.count()).where(flt).group_by(col)).all():
            if s:
                counts[s] = counts.get(s, 0) + c
    return counts


def graph_payload(db: Session, scope: str) -> dict:
    """States + transitions + usage counts for one scope — the settings-page
    load payload."""
    usage = usage_counts(db, scope)
    states = (db.query(LimsWorkflowState).filter_by(entity_scope=scope)
              .order_by(LimsWorkflowState.sort_order).all())
    transitions = (db.query(LimsWorkflowTransition).filter_by(entity_scope=scope)
                   .order_by(LimsWorkflowTransition.sort_order,
                             LimsWorkflowTransition.id).all())
    return {
        "scope": scope,
        "states": [{
            "id": s.id, "slug": s.slug, "label": s.label,
            "description": s.description, "category": s.category,
            "color": s.color, "sort_order": s.sort_order,
            "is_builtin": s.is_builtin, "is_active": s.is_active,
            "usage_count": usage.get(s.slug, 0),
        } for s in states],
        "transitions": [{
            "id": t.id, "from_state_id": t.from_state_id,
            "to_state_id": t.to_state_id, "verb": t.verb, "label": t.label,
            "description": t.description, "requirements": t.requirements,
            "is_builtin": t.is_builtin, "is_active": t.is_active,
        } for t in transitions],
    }
