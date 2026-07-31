"""Seed the five legacy vial-role rows (spec 4). Idempotent; never clobbers admin edits."""
import logging

from catalog.departments import (
    ANALYTICAL_DEPARTMENT,
    HEAVY_METALS_DEPARTMENT,
    MICROBIOLOGY_DEPARTMENT,
    department_id_by_name,
)
from models import VialRole

log = logging.getLogger("accumark.catalog")

# (code, label, department name or None, boxable, variance_eligible, sort_order)
# Flags are PARITY-EXACT with the live constants (BOXABLE_ROLES, _VARIANCE_INELIGIBLE_ROLES)
# — see plan deviation 3. hm stays boxable=False (deviation 4: Handler flips post-rehearsal).
_LEGACY_ROLES = [
    ("hplc", "HPLC", ANALYTICAL_DEPARTMENT, True, True, 0),
    ("endo", "Endotoxin", MICROBIOLOGY_DEPARTMENT, True, True, 1),
    ("ster", "Sterility", MICROBIOLOGY_DEPARTMENT, True, True, 2),
    ("hm", "Heavy Metals", HEAVY_METALS_DEPARTMENT, False, False, 3),
    ("xtra", "Extras", None, True, True, 9),
]


def seed_vial_roles(db) -> int:
    existing = {code for (code,) in db.query(VialRole.code).all()}
    created = 0
    for code, label, dept_name, boxable, var_ok, sort in _LEGACY_ROLES:
        if code in existing:
            continue
        dept_id = department_id_by_name(db, dept_name) if dept_name else None
        db.add(
            VialRole(
                code=code, label=label, department_id=dept_id, boxable=boxable,
                variance_eligible=var_ok, sort_order=sort, frozen=True, is_system=True,
            )
        )
        created += 1
    # flush before any read-back: production SessionLocal is autoflush=False
    db.flush()
    db.commit()
    log.info("catalog.vial_roles_seed created=%s", created)
    return created
