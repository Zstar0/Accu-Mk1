"""Append-only writer for catalog_change_log (S4). Every catalog admin write
path (Tasks 2-4: ~30 routes across vial roles, departments, service specs,
bench stations, etc.) must route its mutation through one of the functions
below instead of a raw setattr-loop / db.add() — that is what makes the log
complete. `details` uses the amendment-audit vocabulary carried over from
LimsAnalysisTransition (models.py, S4 spec 2026-08-07):
    {"changed": {"<field>": {"before": <raw>, "after": <raw>}}}

Exempt write paths — do NOT route these through this module:
  - SENAITE sync writers (workflow/observer.py, workflow/parent_mirror_reconcile.py,
    sub_samples/senaite.py): mirror external SENAITE state into local rows;
    not a deliberate catalog edit by a human actor.
  - Boot seeds (catalog/vial_roles_seed.py, catalog/service_spec_seed.py,
    catalog/departments.py seed helpers): first-boot/self-heal provisioning,
    not a runtime admin action.
  - record_spec_change (catalog/service_spec_audit.py): analysis_service_specs
    already has its own dedicated before/after AuditLog trail; don't double-log.
  - The vial_roles.frozen flip (sub_samples/service.py, ~line 1717): a
    system-derived side effect of vial assignment, not a deliberate catalog edit.

Actor idiom: every call site passes user_id=getattr(current_user, "id", None),
never current_user.id directly. Several route test fixtures override
get_current_user with a dict-shaped user ({"id": 0, ...}), which has no .id
attribute — bare access raises AttributeError on those live-DB tests.
getattr(...) degrades to a NULL actor instead, which is FK-safe (user_id is
a nullable FK to users.id) and matches this module's existing tolerance for
an unattributed write.
"""
from datetime import datetime
from decimal import Decimal
from typing import Iterable, Optional

from sqlalchemy.orm import Session

from models import CatalogChangeLog


def _json_safe(v):
    """Decimal -> str, datetime -> isoformat, else passthrough."""
    if isinstance(v, Decimal):
        return str(v)
    if isinstance(v, datetime):
        return v.isoformat()
    return v


def apply_and_log(
    db: Session, row, fields: dict, *,
    entity_type: str, entity_pk: int, user_id: Optional[int],
) -> dict:
    """setattr-loop replacement: applies every field in `fields` to `row`,
    computing a per-field before/after snapshot. Writes ONE catalog_change_log
    row (action="update") iff at least one field's value actually changed.
    Returns the changed dict (the same mapping written under details["changed"]),
    empty if nothing changed."""
    changed = {}
    for name, new_value in fields.items():
        before = _json_safe(getattr(row, name))
        setattr(row, name, new_value)
        after = _json_safe(getattr(row, name))
        if before != after:
            changed[name] = {"before": before, "after": after}

    if changed:
        db.add(CatalogChangeLog(
            entity_type=entity_type, entity_pk=entity_pk, action="update",
            details={"changed": changed}, user_id=user_id,
        ))
    return changed


def log_create(
    db: Session, row, fields: Iterable[str], *,
    entity_type: str, entity_pk: int, user_id: Optional[int],
) -> None:
    """Log a new row's creation: before=None for every field. Call AFTER
    flush so `row` (and entity_pk) has its assigned primary key — the
    record_spec_change flush-then-audit precedent."""
    changed = {
        name: {"before": None, "after": _json_safe(getattr(row, name))}
        for name in fields
    }
    db.add(CatalogChangeLog(
        entity_type=entity_type, entity_pk=entity_pk, action="create",
        details={"changed": changed}, user_id=user_id,
    ))


def log_delete(
    db: Session, row, fields: Iterable[str], *,
    entity_type: str, entity_pk: int, user_id: Optional[int],
) -> None:
    """Log a row's deletion: after=None for every field, snapshotted from
    `row` before it's removed from the session."""
    changed = {
        name: {"before": _json_safe(getattr(row, name)), "after": None}
        for name in fields
    }
    db.add(CatalogChangeLog(
        entity_type=entity_type, entity_pk=entity_pk, action="delete",
        details={"changed": changed}, user_id=user_id,
    ))


def log_members(
    db: Session, *, entity_type: str, entity_pk: int, user_id: Optional[int],
    field: str, before_ids: list[int], after_ids: list[int],
) -> None:
    """Log a membership-list change (e.g. an ordered set of role/spec ids on
    a parent entity) as one row iff the lists differ. Order-sensitive: a
    reorder with the same members still counts as a change (sort_order is
    meaningful)."""
    if before_ids == after_ids:
        return
    db.add(CatalogChangeLog(
        entity_type=entity_type, entity_pk=entity_pk, action="update",
        details={"changed": {field: {"before": before_ids, "after": after_ids}}},
        user_id=user_id,
    ))
