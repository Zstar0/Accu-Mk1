"""Audit trail for analysis_service_specs writes (ISO 17025 alignment).

Moving specs from a git-versioned literal into admin-editable rows is, on
its own, an auditability regression — this module is the mitigation. EVERY
write path (the seed today, the slice-2 admin editor tomorrow) must call
record_spec_change; rows are deactivated, never deleted.
"""
from typing import Optional

from sqlalchemy.orm import Session


def snapshot_spec(spec) -> dict:
    """JSON-safe snapshot of the rule-bearing fields (Decimal -> str)."""
    return {
        "analysis_service_id": spec.analysis_service_id,
        "matrix": spec.matrix,
        "peptide_id": spec.peptide_id,
        "rule_kind": spec.rule_kind,
        "min_value": str(spec.min_value) if spec.min_value is not None else None,
        "max_value": str(spec.max_value) if spec.max_value is not None else None,
        "equals_value": spec.equals_value,
        "unit": spec.unit,
        "display_override": spec.display_override,
        "active": spec.active,
    }


def record_spec_change(db: Session, spec, *, before: Optional[dict],
                       actor_user_id: Optional[int]) -> None:
    """Append the audit row for a spec write. `before` is a snapshot_spec()
    taken BEFORE mutation (None for creation); `actor_user_id` None means a
    system write (seed)."""
    from models import AuditLog

    db.add(AuditLog(
        operation="analysis_service_spec_changed",
        entity_type="analysis_service_spec",
        entity_id=str(spec.id),
        details={
            "before": before,
            "after": snapshot_spec(spec),
            "actor_user_id": actor_user_id,
        },
    ))
