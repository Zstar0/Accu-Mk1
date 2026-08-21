"""Worksheet → analyst stamping for vial-tier lims_analyses rows.

Spec: docs/superpowers/specs/2026-06-07-analyst-from-worksheet-design.md
The analyst column FOLLOWS worksheet membership: stamp on add, re-stamp when the
worksheet's effective analyst changes, clear on removal. Resolution is by exact
string match WorksheetItem.sample_uid == lims_sub_samples.external_lims_uid —
covers mk1:// native vials and legacy SENAITE-uid vials; a parent AR uid matches
nothing and the call no-ops (parent-tier attribution stays in SENAITE).

Callers are responsible for wrapping these calls in try/except if stamping is
best-effort relative to the host operation; plain DB errors roll back with the
host transaction.
"""
from typing import List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import (
    AnalysisService,
    LimsAnalysis,
    LimsSubSample,
    LimsSubSampleEvent,
    User,
    Worksheet,
    WorksheetItem,
    service_group_members,
)

_DEAD_STATES = ("retracted", "rejected")


def _resolve(
    db: Session, *, sample_uid: str,
    department_id: Optional[int] = None,
    service_group_id: Optional[int] = None,
) -> Tuple[Optional[LimsSubSample], List[LimsAnalysis]]:
    """Vial + its live analyses in the given DEPARTMENT (preferred), else the
    given legacy GROUP, else all live analyses (both None = wildcard — the
    historical contract; None never means 'department IS NULL').

    Department-miss role fallback: a department filter that matches zero rows
    on a vial whose assignment_role belongs to that same department returns
    ALL live rows — catalog-only services (hm, STERILITY_USP71) carry no
    department/group membership, but the vial was seeded role-scoped so its
    rows already match its role (main.py Phase-2 seeder contract).
    """
    sub = db.execute(
        select(LimsSubSample).where(LimsSubSample.external_lims_uid == sample_uid)
    ).scalar_one_or_none()
    if sub is None:
        return None, []
    base = (
        select(LimsAnalysis)
        .where(LimsAnalysis.lims_sub_sample_pk == sub.id)
        .where(~LimsAnalysis.review_state.in_(_DEAD_STATES))
    )
    if department_id is not None:
        q = base.join(
            AnalysisService, AnalysisService.id == LimsAnalysis.analysis_service_id
        ).where(AnalysisService.department_id == department_id)
        rows = list(db.execute(q).scalars().all())
        if not rows:
            from catalog.departments import department_id_for_role
            role = getattr(sub, "assignment_role", None)
            if role and department_id_for_role(db, role) == department_id:
                rows = list(db.execute(base).scalars().all())
        return sub, rows
    if service_group_id is not None:
        q = (
            base.join(AnalysisService, AnalysisService.id == LimsAnalysis.analysis_service_id)
            .join(
                service_group_members,
                service_group_members.c.analysis_service_id == AnalysisService.id,
            )
            .where(service_group_members.c.service_group_id == service_group_id)
        )
        return sub, list(db.execute(q).scalars().all())
    return sub, list(db.execute(base).scalars().all())


def _email(db: Session, user_id: Optional[int]) -> Optional[str]:
    if not user_id:
        return None
    u = db.get(User, user_id)
    return u.email if u else None


def _emit(db: Session, sub_pk: int, event: str, details: dict, user_id: Optional[int]) -> None:
    db.add(LimsSubSampleEvent(
        sub_sample_pk=sub_pk, event=event, details=details, user_id=user_id,
    ))


def stamp_for_item(
    db: Session,
    *,
    sample_uid: str,
    service_group_id: Optional[int],
    analyst_user_id: Optional[int],
    acting_user_id: Optional[int],
    worksheet_id: int,
    worksheet_title: Optional[str] = None,
    department_id: Optional[int] = None,
) -> int:
    """Stamp on add-to-worksheet. Always emits worksheet_assigned when the uid
    resolves to a vial (the add itself is the event), even if no analysis row
    changed value (e.g. analyst unassigned, or no live analyses in the group).
    Returns the number of analysis rows whose analyst changed."""
    sub, rows = _resolve(
        db, sample_uid=sample_uid, department_id=department_id, service_group_id=service_group_id
    )
    if sub is None:
        return 0
    changed = [r for r in rows if r.analyst_user_id != analyst_user_id]
    for r in changed:
        r.analyst_user_id = analyst_user_id
    db.flush()
    _emit(db, sub.id, "worksheet_assigned", {
        "worksheet_id": worksheet_id,
        "worksheet_title": worksheet_title,
        "analyst_email": _email(db, analyst_user_id),
        "keywords": sorted(r.keyword for r in changed),
    }, acting_user_id)
    return len(changed)


def clear_for_item(
    db: Session,
    *,
    sample_uid: str,
    service_group_id: Optional[int],
    acting_user_id: Optional[int],
    worksheet_id: int,
    worksheet_title: Optional[str] = None,
    department_id: Optional[int] = None,
) -> int:
    """Clear on removal from a worksheet. Emits worksheet_removed when the uid
    resolves to a vial. Returns the number of rows cleared."""
    sub, rows = _resolve(
        db, sample_uid=sample_uid, department_id=department_id, service_group_id=service_group_id
    )
    if sub is None:
        return 0
    changed = [r for r in rows if r.analyst_user_id is not None]
    for r in changed:
        r.analyst_user_id = None
    db.flush()
    _emit(db, sub.id, "worksheet_removed", {
        "worksheet_id": worksheet_id,
        "worksheet_title": worksheet_title,
        "keywords": sorted(r.keyword for r in changed),
    }, acting_user_id)
    return len(changed)


def restamp_for_worksheet(
    db: Session, *, worksheet: Worksheet, acting_user_id: Optional[int]
) -> int:
    """Re-stamp every vial item on a worksheet with its current effective
    analyst (worksheet-level wins, else the item's). Emits ONE
    worksheet_analyst_changed event per vial whose rows actually changed —
    idempotent: re-running with the same analyst emits nothing.
    Returns total analysis rows changed."""
    items = db.execute(
        select(WorksheetItem).where(WorksheetItem.worksheet_id == worksheet.id)
    ).scalars().all()
    total = 0
    for item in items:
        effective = worksheet.assigned_analyst_id or item.assigned_analyst_id
        sub, rows = _resolve(
            db, sample_uid=item.sample_uid,
            department_id=item.department_id, service_group_id=item.service_group_id,
        )
        if sub is None:
            continue
        changed = [r for r in rows if r.analyst_user_id != effective]
        if not changed:
            continue
        # from_email is representative-only (first changed row's prior analyst);
        # from_emails is the complete set when rows had mixed prior analysts
        # (multi-group partial stamps). Compute both BEFORE overwriting.
        from_email = _email(db, changed[0].analyst_user_id)
        from_emails = sorted({e for e in (_email(db, r.analyst_user_id) for r in changed) if e})
        for r in changed:
            r.analyst_user_id = effective
        db.flush()
        _emit(db, sub.id, "worksheet_analyst_changed", {
            "worksheet_id": worksheet.id,
            "worksheet_title": worksheet.title,
            "from_email": from_email,
            "from_emails": from_emails,
            "to_email": _email(db, effective),
            "keywords": sorted(r.keyword for r in changed),
        }, acting_user_id)
        total += len(changed)
    return total
