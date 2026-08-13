"""Catalog department assignment.

Single source of truth for which top-level Department a service group belongs
to. Analytics/Core HPLC are the Analytical bench; Microbiology and Endotoxin
are both the Microbiology bench.

The seed is DERIVED FROM LIVE GROUP ROWS, never from a hardcoded membership
list: whether production carries a distinct 'Endotoxin' group is unconfirmed
(the seeder and the frontend disagree in comments), and seeding an assumption
would bury a defect in data instead of code. ENDO-LAL lands under the
Microbiology department either way.

Group naming is NOT consistent across environments: dev/seed catalogs use
"Analytics"; production's real service_groups table has no such row — its
analytical bench group is named "Core HPLC" (confirmed against production
data during Task 2's fix round). Both names must be recognized, and
production's HPLC analyte services (ID_*, HPLC-PUR, PEPT-Total, per-substance
PUR_<X>/QTY_<X>) additionally carry NO group membership at all — see the
ungrouped-rescue step in backfill_departments. Missing either mapping means
the fail-closed HPLC allow-list (Task 2, lims_analyses/seeder.py) silently
seeds ZERO analyses onto every HPLC vial, because the Analytical department
row still exists (so the mirror's missing-department abort never fires) —
it's just empty.
"""
import logging
from typing import Optional

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

log = logging.getLogger(__name__)

# Canonical department names — the single spelling shared by the backfill and
# the HPLC mirror's fail-closed allow-list (lims_analyses/seeder.py).
ANALYTICAL_DEPARTMENT = "Analytical"
MICROBIOLOGY_DEPARTMENT = "Microbiology"
# hm (Heavy Metals) is the first CATALOG-ONLY role: its own department/lane
# rather than folding into Analytical or Microbiology, so role-flip cleanup
# (sub_samples/service.py _ROLE_DEPARTMENT_NAMES) can clear hm's analyses
# without ambiguity against either existing bench (spec-3 Task 3).
HEAVY_METALS_DEPARTMENT = "Heavy Metals"

DEPARTMENT_NAMES = [ANALYTICAL_DEPARTMENT, MICROBIOLOGY_DEPARTMENT, HEAVY_METALS_DEPARTMENT]

# Group name -> department name. Endotoxin nests under Microbiology (the
# assignment UI already shows Endo + Sterility inside the Microbiology block).
# "Analytics" (dev/seed) and "Core HPLC" (production's real group name) both
# map to Analytical — see the module docstring for why both are required.
_GROUP_NAME_TO_DEPARTMENT = {
    "Analytics": ANALYTICAL_DEPARTMENT,
    "Core HPLC": ANALYTICAL_DEPARTMENT,
    "Microbiology": MICROBIOLOGY_DEPARTMENT,
    "Endotoxin": MICROBIOLOGY_DEPARTMENT,
}

# Ungrouped analytical keyword families that must be rescued into Analytical
# even though they carry no service-group membership at all (confirmed true
# in production for the HPLC analyte services). Each is an explicit,
# enumerated LIKE pattern — never a catch-all "everything non-micro is
# Analytical" default, which would reintroduce the BW-0015-S01-class leak
# (a Microbiology service wrongly landing on an HPLC vial). Literal
# underscores are escaped (escape="\\" at the call site) so e.g. "PUR\\_%"
# matches only a literal underscore, not the SQL LIKE single-char wildcard —
# unescaped, "PUR_%" would also match "PURGE-FOO".
_UNGROUPED_ANALYTICAL_LIKE_PATTERNS = (
    "ANALYTE-%",
    "ID\\_%",
    "HPLC-%",
    "PEPT-%",
    "PUR\\_%",
    "QTY\\_%",
    "BLEND-%",
)


def department_for_group_name(group_name: str) -> Optional[str]:
    """Return the department name for a service group, or None if unknown."""
    return _GROUP_NAME_TO_DEPARTMENT.get(group_name)


def department_id_by_name(db: Session, name: str) -> Optional[int]:
    """Return the id of the department with this name, or None if absent."""
    from models import Department
    row = db.query(Department).filter_by(name=name).one_or_none()
    return row.id if row else None


def department_id_for_service(db: Session, analysis_service_id: int) -> Optional[int]:
    """The service's structural department (direct column — no M2M fan-out)."""
    from models import AnalysisService
    svc = db.get(AnalysisService, analysis_service_id)
    return svc.department_id if svc is not None else None


def department_id_for_role(db: Session, role_code: str) -> Optional[int]:
    """The department owning a vial assignment_role code (e.g. 'ster' -> Microbiology).

    None is returned for two distinct reasons a caller doing fallback logic
    must not conflate: an unknown role_code, and the known 'xtra' role, which
    is the one VialRole row deliberately seeded with a NULL department (the
    reserved unassigned bucket — see VialRole's docstring in models.py).
    """
    from models import VialRole
    row = db.query(VialRole).filter_by(code=role_code).one_or_none()
    return row.department_id if row is not None else None


def backfill_departments(db: Session) -> None:
    """Idempotently seed departments and assign department_id from live groups.

    Safe to re-run on every start. Never clobbers a value that is already set,
    so an admin reassignment survives a restart.
    """
    from models import AnalysisService, Department, ServiceGroup

    # 1. Ensure department rows exist. is_system=True: these three names are
    # load-bearing (the worksheet-inbox legacy lane keys, catalog.roles
    # ._LEGACY_LANE_KEYS, are pinned to them BY NAME) — the departments PATCH
    # route refuses a name change on an is_system row (fix round, spec 4 Task
    # 7) so a rename can't silently break a stored FE pref / bookmarked
    # ?role=. Guarded: only flips False->True, never touches any other
    # department, and never fires on a fresh-create (already True there).
    by_name: dict[str, Department] = {}
    for i, name in enumerate(DEPARTMENT_NAMES):
        dept = db.query(Department).filter_by(name=name).one_or_none()
        if dept is None:
            dept = Department(name=name, sort_order=i, is_system=True)
            db.add(dept)
            db.flush()
        elif not dept.is_system:
            dept.is_system = True
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

    # 4. Ungrouped analytical keyword families (ANALYTE-N-*, ID_*, HPLC-*,
    #    PEPT-*, PUR_*, QTY_*, BLEND-*) are unambiguously analytical — the
    #    HPLC mirror seeds them, and production carries them with NO group
    #    membership at all. Tag them so the fail-closed allow-list (Task 2)
    #    can treat NULL as "unknown -> exclude" without dropping legitimate
    #    analyte rows. Explicit, enumerated patterns only — never a catch-all
    #    "everything non-micro is Analytical" default (see module docstring).
    analytical_id = by_name[ANALYTICAL_DEPARTMENT].id
    rescue_match = or_(*(
        AnalysisService.keyword.like(pattern, escape="\\")
        for pattern in _UNGROUPED_ANALYTICAL_LIKE_PATTERNS
    ))
    for svc in db.query(AnalysisService).filter(
        AnalysisService.department_id.is_(None),
        rescue_match,
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

    # Defense in depth, distinct failure mode from the NULL-count warning
    # above: the Analytical department ROW can exist (so the mirror's
    # missing-department abort never fires) while carrying ZERO tagged
    # services (e.g. this environment's real service-group names or ungrouped
    # keyword families aren't in _GROUP_NAME_TO_DEPARTMENT /
    # _UNGROUPED_ANALYTICAL_LIKE_PATTERNS). That state is silent at the
    # mirror layer — every HPLC vial simply mirrors zero analyses, forever,
    # with no error anywhere near the request that exposes it. Catching it
    # here, at backfill/startup time, is the only place it can be loud.
    total_count = db.query(func.count(AnalysisService.id)).scalar()
    analytical_count = db.query(func.count(AnalysisService.id)).filter(
        AnalysisService.department_id == analytical_id
    ).scalar()
    # total_count guard: an empty catalog (fresh install, no SENAITE sync yet)
    # legitimately has zero of everything and is not a misconfiguration —
    # only flag "services exist but none are Analytical".
    if total_count and analytical_count == 0:
        log.error(
            "catalog.backfill.analytical_department_empty — the %s department "
            "exists but ZERO services are tagged with it. Every HPLC vial will "
            "silently mirror ZERO analyses until this is fixed. Check "
            "_GROUP_NAME_TO_DEPARTMENT / _UNGROUPED_ANALYTICAL_LIKE_PATTERNS "
            "against this environment's real service_groups names and "
            "ungrouped keyword prefixes.", ANALYTICAL_DEPARTMENT,
        )
