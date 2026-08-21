"""Read helpers for the vial_roles catalog (spec 4). Fail-closed: callers treat a
registry miss as an error, never a silent drop."""
import logging
import re
from dataclasses import dataclass, field

from models import VialRole

log = logging.getLogger(__name__)

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
    # FE parity reference: src/lib/role-code.ts ports this algorithm; the live suggestion path is the FE.
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
    reserved unassigned bucket, gated by the show_xtra toggle instead.

    Key collisions are UNIQUIFIED, never dropped or overwritten (fix round,
    spec 4 Task 7): a two-pass assignment claims the three legacy alias keys
    for their canonical department names FIRST and unconditionally — an
    admin-created department that happens to slug to the same string (e.g.
    one literally named "HPLC") can never steal Analytical's 'hplc' key.
    Every other department is then processed in deterministic (sort_order,
    name) order; a slug that collides with an already-taken key gets a
    numeric suffix (suggest_role_code precedent), logging
    `inbox_lane_key_collision` each time."""
    rows = (
        db.query(VialRole)
        .filter(VialRole.department_id.isnot(None))
        .order_by(VialRole.sort_order, VialRole.code)
        .all()
    )
    by_dept_id: dict[int, dict] = {}
    for r in rows:
        dept = r.department
        if dept is None:
            continue
        entry = by_dept_id.get(dept.id)
        if entry is None:
            entry = {"dept": dept, "role_codes": set(), "sort_order": r.sort_order}
            by_dept_id[dept.id] = entry
        entry["role_codes"].add(r.code)
        entry["sort_order"] = min(entry["sort_order"], r.sort_order)

    lanes: dict[str, InboxLane] = {}
    taken_keys: set[str] = set()

    # Pass 1: legacy alias keys, claimed by their CANONICAL department name,
    # unconditionally — before any slugified key is even considered.
    dept_ids_by_name = {entry["dept"].name: dept_id for dept_id, entry in by_dept_id.items()}
    for dept_name, legacy_key in _LEGACY_LANE_KEYS.items():
        dept_id = dept_ids_by_name.get(dept_name)
        if dept_id is None:
            continue
        entry = by_dept_id[dept_id]
        lanes[legacy_key] = InboxLane(
            key=legacy_key, department_id=dept_id, department_name=entry["dept"].name,
            role_codes=set(entry["role_codes"]), sort_order=entry["sort_order"],
        )
        taken_keys.add(legacy_key)

    # Pass 2: everything else, deterministic order, slugified + uniquified
    # against everything already taken.
    remaining = [
        (dept_id, entry) for dept_id, entry in by_dept_id.items()
        if entry["dept"].name not in _LEGACY_LANE_KEYS
    ]
    remaining.sort(key=lambda pair: (pair[1]["sort_order"], pair[1]["dept"].name))
    for dept_id, entry in remaining:
        dept = entry["dept"]
        base_key = re.sub(r"[^a-z0-9]+", "_", dept.name.lower()).strip("_") or "dept"
        key = base_key
        n = 2
        while key in taken_keys:
            next_key = f"{base_key}_{n}"
            log.warning("inbox_lane_key_collision dept=%s key=%s -> %s",
                       dept.name, key, next_key)
            key = next_key
            n += 1
        lanes[key] = InboxLane(
            key=key, department_id=dept_id, department_name=dept.name,
            role_codes=set(entry["role_codes"]), sort_order=entry["sort_order"],
        )
        taken_keys.add(key)

    return lanes
