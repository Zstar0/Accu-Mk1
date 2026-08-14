"""Demand-catalog integrity validation (S9).

With the legacy-wins override retired (catalog authoritative for vial
demand), a misconfigured catalog row can under-provision vials with no
request-time error. Every check here covers one silent path:

  1. legacy-key completeness  — the four legacy wire keys must resolve to
     active, role-bearing, vials>=1 profiles (post-flip, their absence is
     real under-provisioning, not a clamped no-op);
  2. role-less active profile — sub_samples.catalog_demand.resolve_catalog_
     fulfillment's `if prof.fulfillment_dim != "role" or not
     prof.fulfillment_role: continue` skips these with NO log;
  3. zero-vials role profile  — admin-created rows default vials_required=0
     and plan zero;
  4. unfillable role          — roles absent from vial_roles or with a NULL
     department are never returned by catalog.roles.real_bucket_codes, so
     auto-assign never fills them ('xtra' exempt by design).

Called from database.init_db's seed tail (ERROR log, never blocks boot) and
from scripts/s9_demand_precheck.py (the pre-deploy gate).
"""
import logging

log = logging.getLogger(__name__)

LEGACY_DEMAND_KEYS = (
    "hplcpurity_identity", "bac_water_panel", "endotoxin", "sterility_pcr",
)


def verify_demand_catalog(db) -> list[str]:
    from models import AnalysisProfile, VialRole

    total = db.query(AnalysisProfile).count()
    if total == 0:
        # Fresh install / pre-first-boot: an empty catalog is not a
        # misconfiguration (same hatch as backfill_departments' total_count).
        return []

    violations: list[str] = []

    for key in LEGACY_DEMAND_KEYS:
        row = db.query(AnalysisProfile).filter_by(key=key).one_or_none()
        if row is None or not row.active:
            violations.append(
                f"legacy demand key '{key}' missing or inactive — orders "
                f"carrying it will plan ZERO vials for its bucket"
            )
            continue
        if not row.fulfillment_role or row.vials_required < 1:
            violations.append(
                f"legacy demand key '{key}' misconfigured "
                f"(vials_required={row.vials_required}, "
                f"fulfillment_role={row.fulfillment_role!r}) — plans zero"
            )

    role_dim = (
        db.query(AnalysisProfile)
        .filter(AnalysisProfile.active.is_(True),
                AnalysisProfile.fulfillment_dim == "role")
        .all()
    )
    for p in role_dim:
        if not p.fulfillment_role:
            violations.append(
                f"active role-dim profile '{p.key}' has NO fulfillment_role — "
                f"silently skipped by resolve_catalog_fulfillment"
            )
        elif p.vials_required == 0:
            violations.append(
                f"active role-dim profile '{p.key}' has vials_required=0 — "
                f"plans zero vials"
            )

    role_codes = {c for (c,) in db.query(VialRole.code).all()}
    dept_ok = {
        c for (c,) in db.query(VialRole.code)
        .filter(VialRole.department_id.isnot(None)).all()
    }
    for p in role_dim:
        r = p.fulfillment_role
        if not r or r == "xtra":
            continue
        if r not in role_codes:
            violations.append(
                f"fulfillment_role '{r}' (profile '{p.key}') has no vial_roles "
                f"row — auto-assign will never fill it"
            )
        elif r not in dept_ok:
            violations.append(
                f"fulfillment_role '{r}' (profile '{p.key}') has a NULL "
                f"department — excluded from real_bucket_codes, never filled"
            )

    for v in violations:
        log.error("demand_catalog_integrity %s", v)
    return violations
