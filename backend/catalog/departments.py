"""Catalog department assignment.

Single source of truth for which top-level Department a service group belongs
to. Analytics is the Analytical bench; Microbiology and Endotoxin are both the
Microbiology bench.

The seed is DERIVED FROM LIVE GROUP ROWS, never from a hardcoded membership
list: whether production carries a distinct 'Endotoxin' group is unconfirmed
(the seeder and the frontend disagree in comments), and seeding an assumption
would bury a defect in data instead of code. ENDO-LAL lands under the
Microbiology department either way.
"""
import logging
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

log = logging.getLogger(__name__)

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

    Safe to re-run on every start. Never clobbers a value that is already set,
    so an admin reassignment survives a restart.
    """
    from models import AnalysisService, Department, ServiceGroup

    # 1. Ensure department rows exist.
    by_name: dict[str, Department] = {}
    for i, name in enumerate(DEPARTMENT_NAMES):
        dept = db.query(Department).filter_by(name=name).one_or_none()
        if dept is None:
            dept = Department(name=name, sort_order=i)
            db.add(dept)
            db.flush()
        by_name[name] = dept

    # 2. Group -> department, ONLY when unset.
    for group in db.query(ServiceGroup).all():
        if group.department_id is not None:
            continue
        dept_name = department_for_group_name(group.name)
        if dept_name is not None:
            group.department_id = by_name[dept_name].id

    # 3. Service -> department, inherited from a group it belongs to.
    for group in db.query(ServiceGroup).all():
        if group.department_id is None:
            continue
        for svc in group.analysis_services:
            if svc.department_id is None:
                svc.department_id = group.department_id

    # 4. Ungrouped generic per-analyte services (ANALYTE-N-*) are unambiguously
    #    analytical — the HPLC mirror seeds them. Tag them so the fail-closed
    #    allow-list (Task 2) can treat NULL as "unknown -> exclude" without
    #    dropping legitimate analyte rows.
    analytical_id = by_name["Analytical"].id
    for svc in db.query(AnalysisService).filter(
        AnalysisService.department_id.is_(None),
        AnalysisService.keyword.like("ANALYTE-%"),
    ).all():
        svc.department_id = analytical_id

    db.commit()

    # Defense in depth: after this backfill nothing should be NULL. If a future
    # ungrouped analytical service slips through, make it LOUD — the allow-list
    # would otherwise silently drop it from HPLC-vial mirroring.
    null_count = db.query(func.count(AnalysisService.id)).filter(
        AnalysisService.department_id.is_(None)
    ).scalar()
    if null_count:
        samples = [
            kw for (kw,) in db.query(AnalysisService.keyword)
            .filter(AnalysisService.department_id.is_(None))
            .limit(10).all()
        ]
        log.warning(
            "catalog.backfill.null_department count=%s — these services have no "
            "department and will be EXCLUDED from HPLC-vial mirroring "
            "(fail-closed). Sample keywords: %s", null_count, samples,
        )
