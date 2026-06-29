"""Catalog department assignment.

Single source of truth for which top-level Department a service group belongs to.
Derived to match the existing hardcoded routing literals (sub_samples.service
._ROLE_GROUP_NAMES, lims_analyses.seeder._NON_HPLC_GROUPS): Analytics is the
Analytical bench; Microbiology and Endotoxin are both the Microbiology bench.
"""
from typing import Optional

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


from sqlalchemy.orm import Session


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

    # 2. Assign each group's department_id from its name.
    for group in db.query(ServiceGroup).all():
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

    db.commit()
