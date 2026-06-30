"""Catalog department assignment.

Single source of truth for which top-level Department a service group belongs to.
Analytics is the Analytical bench; Microbiology and Endotoxin are both the
Microbiology bench. (Plan 1B repointed the former hardcoded routing literals at
this mapping.)
"""
from typing import Optional

from sqlalchemy.orm import Session

DEPARTMENT_NAMES = ["Analytical", "Microbiology"]

# Group name -> department name. Endotoxin nests under Microbiology (the
# assignment UI already shows Endo + Sterility inside the Microbiology block).
_GROUP_NAME_TO_DEPARTMENT = {
    "Analytics": "Analytical",
    "Microbiology": "Microbiology",
    "Endotoxin": "Microbiology",
}


def department_for_group_name(group_name: str) -> Optional[str]:
    """Return the department name for a service group, or None if unknown."""
    return _GROUP_NAME_TO_DEPARTMENT.get(group_name)


def department_id_by_name(db: Session, name: str) -> Optional[int]:
    """Return the id of the department with this name, or None if absent."""
    from models import Department
    row = db.query(Department).filter_by(name=name).one_or_none()
    return row.id if row else None


def backfill_departments(db: Session) -> None:
    """Idempotently seed departments and assign department_id from live groups.

    Derived from current data: a service's department = the department of (one of)
    its service groups. Never hardcodes membership; safe to re-run on every start.
    """
    from models import Department, ServiceGroup, AnalysisService

    # 1. Ensure department rows exist.
    by_name: dict[str, Department] = {}
    for i, name in enumerate(DEPARTMENT_NAMES):
        dept = db.query(Department).filter_by(name=name).one_or_none()
        if dept is None:
            dept = Department(name=name, sort_order=i)
            db.add(dept)
            db.flush()
        by_name[name] = dept

    # 2. Assign each group's department_id from its name — ONLY when unset, so a
    #    later manual reassignment (admin/UI) is never clobbered by a restart.
    for group in db.query(ServiceGroup).all():
        if group.department_id is not None:
            continue
        dept_name = department_for_group_name(group.name)
        if dept_name is not None:
            group.department_id = by_name[dept_name].id

    # 3. Assign each service's department_id from a group it belongs to.
    for group in db.query(ServiceGroup).all():
        if group.department_id is None:
            continue
        for svc in group.analysis_services:
            if svc.department_id is None:
                svc.department_id = group.department_id

    # 4. Tag the ungrouped generic per-analyte services (ANALYTE-N-*) onto the
    #    Analytical bench. They carry no group (steps 2-3 leave them NULL) but are
    #    unambiguously analytical — the HPLC mirror seeds them. Tagging them lets
    #    the fail-closed HPLC allow-list (Plan 1B Task 2) treat NULL as
    #    "unknown → exclude" without dropping these legitimate analyte rows.
    analytical_id = by_name["Analytical"].id
    for svc in db.query(AnalysisService).filter(
        AnalysisService.department_id.is_(None),
        AnalysisService.keyword.like("ANALYTE-%"),
    ).all():
        svc.department_id = analytical_id

    db.commit()
