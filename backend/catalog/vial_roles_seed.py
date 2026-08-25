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

# (code, label, department name or None, boxable, variance_eligible, sort_order,
#  color, short_label, badge_glyph)
# Flags are PARITY-EXACT with the live constants (BOXABLE_ROLES, _VARIANCE_INELIGIBLE_ROLES)
# — see plan deviation 3. hm boxable=True since 2026-08-24 (Handler ruling with
# the analytical-vials feature: HM's 2 physical vials must route to the HM box
# and bench even though only the anchor vial carries analyses). Live DBs flip
# via the roles admin/UPDATE — this seed only covers fresh environments.
# Display faces (S1) are PARITY-EXACT with the pre-catalog hardcoded FE maps.
_LEGACY_ROLES = [
    ("hplc", "HPLC", ANALYTICAL_DEPARTMENT, True, True, 0, "green", "HPLC", "H"),
    ("endo", "Endotoxin", MICROBIOLOGY_DEPARTMENT, True, True, 1, "orange", "ENDO", "E"),
    ("ster", "Sterility", MICROBIOLOGY_DEPARTMENT, True, True, 2, "purple", "PCR", "P"),
    ("hm", "Heavy Metals", HEAVY_METALS_DEPARTMENT, True, False, 3, "slate", "HM", "M"),
    ("xtra", "Extras", None, True, True, 9, "sky", "XTRA", "X"),
]


def seed_vial_roles(db) -> int:
    existing = {r.code: r for r in db.query(VialRole).all()}
    created = 0
    healed = 0
    for code, label, dept_name, boxable, var_ok, sort, color, short_label, badge_glyph in _LEGACY_ROLES:
        dept_id = department_id_by_name(db, dept_name) if dept_name else None
        if dept_name and dept_id is None:
            log.error("vial_roles_seed_department_unresolved code=%s dept=%s", code, dept_name)
        row = existing.get(code)
        if row is not None:
            # Self-heal (fix round): a legacy row can exist with
            # department_id NULL because it was seeded before
            # backfill_departments ever ran (departments seed AFTER vial
            # roles in database.py's boot order, on the FIRST boot only —
            # every boot after that, department rows already exist by the
            # time this runs). NULL -> set only, never clobbers an admin
            # edit (an admin who deliberately re-nulled a department, or
            # pointed it elsewhere, keeps that value).
            if row.department_id is None and dept_id is not None:
                row.department_id = dept_id
                healed += 1
            # S1: same NULL-only self-heal shape for display faces — a row
            # seeded before this slice shipped has all three faces NULL;
            # stamp the legacy values once, never clobber an admin's own
            # pick. Triple-NULL is the sentinel (fix round: color alone
            # isn't enough — an admin who chose Auto (color=NULL) but set
            # short_label/badge_glyph must NOT have those two re-stamped on
            # the next boot). Mirrors the SQL backfill's matching
            # `AND color IS NULL AND short_label IS NULL AND badge_glyph
            # IS NULL` guard. Residual (accepted, Handler-surfaced): a
            # legacy role an admin sets fully to Auto (all three NULL) still
            # reverts to the legacy display on the next restart — no
            # per-field admin-edit tracking exists to distinguish "never
            # touched" from "deliberately reset to Auto".
            if row.color is None and row.short_label is None and row.badge_glyph is None:
                row.color = color
                row.short_label = short_label
                row.badge_glyph = badge_glyph
                healed += 1
            continue
        db.add(
            VialRole(
                code=code, label=label, department_id=dept_id, boxable=boxable,
                variance_eligible=var_ok, sort_order=sort, frozen=True, is_system=True,
                color=color, short_label=short_label, badge_glyph=badge_glyph,
            )
        )
        created += 1
    # flush before any read-back: production SessionLocal is autoflush=False
    db.flush()
    db.commit()
    log.info("catalog.vial_roles_seed created=%s healed=%s", created, healed)
    return created
