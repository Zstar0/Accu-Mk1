"""Read helpers for the vial_roles catalog (spec 4). Fail-closed: callers treat a
registry miss as an error, never a silent drop."""
import re
from dataclasses import dataclass, field

from models import VialRole

_CODE_RE = re.compile(r"[a-z][a-z0-9_]{0,7}")

# Department name -> the exact worksheet-inbox lane key stored FE preferences
# depend on (Task 7 conversion). Any OTHER department slugifies its own name
# instead — see inbox_lanes().
_LEGACY_LANE_KEYS = {
    "Analytical": "hplc",
    "Microbiology": "microbiology",
    "Heavy Metals": "hm",
}


def role_registry(db) -> dict:
    """All roles keyed by code. One query; call once per request path."""
    return {r.code: r for r in db.query(VialRole).all()}


def real_bucket_codes(db) -> list[str]:
    """Assignable demand buckets: every role with a department, ordered. xtra (NULL
    department) is the reserved unassigned bucket and is deliberately excluded."""
    rows = (
        db.query(VialRole)
        .filter(VialRole.department_id.isnot(None))
        .order_by(VialRole.sort_order, VialRole.code)
        .all()
    )
    return [r.code for r in rows]


def suggest_role_code(key: str, existing: set) -> str:
    """Derive a role code from a profile key: lowercase, strip invalid chars,
    truncate to 8, uniquify with a numeric suffix."""
    base = re.sub(r"[^a-z0-9_]", "_", key.lower()).strip("_") or "role"
    if not base[0].isalpha():
        base = "r" + base
    code = base[:8]
    n = 2
    while code in existing:
        suffix = str(n)
        code = base[: 8 - len(suffix)] + suffix
        n += 1
    return code


@dataclass
class InboxLane:
    """One worksheet-inbox filter chip: a department that has >=1 vial role.
    `key` is the URL/stored-pref value; `role_codes` is every assignment_role
    value that lane should show."""
    key: str
    department_id: int
    department_name: str
    role_codes: set = field(default_factory=set)
    sort_order: int = 0


def inbox_lanes(db) -> dict:
    """One InboxLane per department that owns >=1 vial role, keyed by lane key.

    key = the legacy alias for the three seeded departments (Analytical/
    Microbiology/Heavy Metals -> hplc/microbiology/hm — stored FE prefs depend
    on these exact strings) else a slugified department name
    (re.sub(r'[^a-z0-9]+', '_', name.lower())). role_codes is every role code
    in that department (e.g. microbiology collapses ster+endo into one chip).
    sort_order is the lowest sort_order among the lane's roles, for stable
    chip ordering. xtra (NULL department) never gets a lane — it's the
    reserved unassigned bucket, gated by the show_xtra toggle instead."""
    rows = (
        db.query(VialRole)
        .filter(VialRole.department_id.isnot(None))
        .order_by(VialRole.sort_order, VialRole.code)
        .all()
    )
    by_dept: dict[int, InboxLane] = {}
    for r in rows:
        dept = r.department
        if dept is None:
            continue
        lane = by_dept.get(dept.id)
        if lane is None:
            key = _LEGACY_LANE_KEYS.get(dept.name) or re.sub(r"[^a-z0-9]+", "_", dept.name.lower())
            lane = InboxLane(key=key, department_id=dept.id, department_name=dept.name,
                             sort_order=r.sort_order)
            by_dept[dept.id] = lane
        lane.role_codes.add(r.code)
        lane.sort_order = min(lane.sort_order, r.sort_order)
    return {lane.key: lane for lane in by_dept.values()}
