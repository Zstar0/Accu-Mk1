"""Boot seed for the native HPLC family (spec 2026-09-10-hplc-native-born-design, M2).

Shape B: a GENERIC trio (identity / purity / quantity) plus two blend
aggregates. The peptide is NOT in the catalog — it lives on the analysis row
(lims_analyses.peptide_id / slot), so a blend is N rows of the same service.

Idempotent and admin-safe, mirroring service_spec_seed.py:
  * a service is keyed on (keyword, origin='mk1') — present => untouched;
  * the profile is keyed on key — present => untouched (vials_required,
    archetype, members are the admin's after first boot);
  * members are only written when the profile is created by THIS run;
  * spec rows use the wildcard slot (matrix IS NULL AND peptide_id IS NULL)
    and skip when any row -- active or not -- already occupies it.
Never resurrects a deactivated row. Every insert is audited via
catalog/change_log so the Catalog Change Log shows the boot as the actor.
Deliberate deviation from change_log.py's module docstring, which lists
other boot seeds (vial_roles_seed, service_spec_seed) as exempt from
change-log routing: THIS seed creates brand-new admin-facing catalog rows
(a service + a profile) that an operator will later edit, so they belong in
the same audit trail as a hand-created row — task-4-brief.md calls for
log_create/log_members explicitly and pins the behavior with
test_change_log_rows_written.

Final review Finding 2 (controller ruling): the profile is seeded
INACTIVE (active=False). native_profiles_for_parent (the Manage Analyses
picker payload) lists every active all-mk1 profile, so an active seed would
put "HPLC Purity + Identity" in front of the lab as addable to EVERY
existing sample on deploy day, before anyone decided to sell it. Activating
it is a deliberate flip-runbook step performed in Mk1 admin, not something
this boot seed does for you. sub_samples.catalog_demand still fulfills an
inactive profile for a paid order (with a warning) — inactivity here only
hides it from the picker, it does not block fulfillment of an order that
already references it.

Final review Finding 3 (controller ruling): before creating any of the five
services, check for an existing AnalysisService with the same keyword
regardless of origin. If one already exists under a DIFFERENT origin (e.g.
a SENAITE-imported row), skip that service — creating a same-keyword mk1
row alongside it would be a cross-origin keyword duplicate, which nothing
in this catalog enforces at the DB level (uniqueness here is scoped to
(keyword, origin)). A collision on any of the five aborts profile creation
entirely (log why) rather than seed a profile with fewer than five members.

The `ck_analysis_service_specs_rule_shape` CHECK (models.py) only restricts
equals_value/min_value/max_value/loq on an 'informational' row — it does not
forbid `unit` or `display_override` — so both are kept on the two
informational rows (HPLC-QUANTITY, HPLC-BLEND-TOTAL) below.

NOT added to sub_samples.product_registry.PRODUCT_REGISTRY: that map is the
legacy profile set pinned by test_profile_parity.py.
"""
import logging
from decimal import Decimal

from sqlalchemy.orm import Session

log = logging.getLogger(__name__)

HPLC_NATIVE_PROFILE_KEY = "hplc-purity-identity"
HPLC_NATIVE_PROFILE_NAME = "HPLC Purity + Identity"

# keyword, title, unit, result_type, variance_capable — ORDER = member sort_order
HPLC_NATIVE_SERVICES: tuple[tuple[str, str, str | None, str, bool], ...] = (
    ("HPLC-IDENTITY", "HPLC Identity", None, "string", False),
    ("HPLC-PURITY", "HPLC Purity", "%", "numeric", True),
    ("HPLC-QUANTITY", "HPLC Quantity", "mg", "numeric", True),
    ("HPLC-BLEND-PURITY", "HPLC Blend Purity (mass-weighted)", "%", "numeric", False),
    ("HPLC-BLEND-TOTAL", "HPLC Blend Total Quantity", "mg", "numeric", False),
)

# keyword -> (rule_kind, min, max, equals, unit, display_override)
# Handler rulings 2026-09-10: purity >= 98 % wildcard; quantity report-only
# ("As measured"); identity = literal Conforms.
HPLC_NATIVE_SPECS = {
    "HPLC-PURITY": ("range", Decimal("98"), None, None, "%", None),
    "HPLC-BLEND-PURITY": ("range", Decimal("98"), None, None, "%", None),
    "HPLC-QUANTITY": ("informational", None, None, None, "mg", "As measured"),
    "HPLC-BLEND-TOTAL": ("informational", None, None, None, "mg", "As measured"),
    "HPLC-IDENTITY": ("equals", None, None, "Conforms", None, None),
}

# entity_type literals mirror main.py's live admin routes verbatim (grep
# log_create( / log_members( in main.py): POST /analysis-services ~3668 uses
# "service", POST /analysis-profiles ~18972 uses "profile" -- NOT
# "analysis_service" / "analysis_profile" -- and PUT
# /analysis-profiles/{id}/members ~19191 logs the membership write under
# entity_type "profile_members", field "member_ids".
_SERVICE_LOG_FIELDS = ("title", "keyword", "unit", "result_type", "origin",
                       "department_id", "variance_capable", "category")
_PROFILE_LOG_FIELDS = ("key", "name", "is_addon", "vials_required",
                       "fulfillment_role", "fulfillment_dim", "active")


def seed_hplc_native_catalog(db: Session) -> dict[str, int]:
    from catalog.change_log import log_create, log_members
    from catalog.departments import department_id_by_name
    from catalog.service_spec_audit import record_spec_change
    from models import (AnalysisProfile, AnalysisService, AnalysisServiceSpec,
                        analysis_profile_members)

    report = {"services": 0, "profile": 0, "members": 0, "specs": 0}

    dept_id = department_id_by_name(db, "Analytical")
    if dept_id is None:
        log.warning("hplc_native_seed.no_analytical_department — services seed "
                    "with department_id NULL; backfill_departments tags HPLC-%% "
                    "on the NEXT boot (backfill_departments runs before this seeder)")

    # --- services ---
    # Finding 3: uniqueness in this catalog is scoped to (keyword, origin),
    # so an mk1 row can coexist with a same-keyword row of a different
    # origin (e.g. a SENAITE-imported service) with nothing at the DB level
    # to stop it. Check for ANY origin before minting the mk1 row; a
    # collision skips just that service and logs loudly for the admin to
    # resolve, rather than silently minting a cross-origin duplicate.
    services: dict[str, AnalysisService] = {}
    collisions: list[str] = []
    for keyword, title, unit, result_type, variance_capable in HPLC_NATIVE_SERVICES:
        svc = (db.query(AnalysisService)
               .filter(AnalysisService.keyword == keyword,
                       AnalysisService.origin == "mk1")
               .one_or_none())
        if svc is None:
            other = (db.query(AnalysisService)
                     .filter(AnalysisService.keyword == keyword,
                             AnalysisService.origin != "mk1")
                     .one_or_none())
            if other is not None:
                log.error("hplc_native_seed.keyword_collision keyword=%s origin=%s "
                           "id=%s — skipping; resolve in the catalog admin",
                           keyword, other.origin, other.id)
                collisions.append(keyword)
                continue
            svc = AnalysisService(
                title=title, keyword=keyword, unit=unit, result_type=result_type,
                category="HPLC", origin="mk1", department_id=dept_id,
                variance_capable=variance_capable, active=True,
            )
            db.add(svc)
            db.flush()
            log_create(db, svc, _SERVICE_LOG_FIELDS, entity_type="service",
                       entity_pk=svc.id, user_id=None)
            report["services"] += 1
        services[keyword] = svc

    if collisions:
        log.error("hplc_native_seed.profile_creation_aborted collided_keywords=%s "
                   "— %s cannot seed with all five members until the keyword "
                   "collision(s) above are resolved in the catalog admin",
                   collisions, HPLC_NATIVE_PROFILE_KEY)
        db.commit()
        if any(report.values()):
            log.info("catalog.hplc_native_seed %s", report)
        return report

    # --- profile (+ members only on first creation) ---
    # Finding 2 (controller ruling): seeded INACTIVE — activating it is an
    # explicit flip-runbook step in Mk1 admin, not something this boot seed
    # decides. native_profiles_for_parent only lists ACTIVE all-mk1
    # profiles, so leaving this False keeps it out of the Manage Analyses
    # picker until someone flips it on purpose. catalog_demand still
    # fulfills an inactive profile for a paid order (with a warning) — this
    # only hides it from the picker, it does not block an order that
    # already references it.
    prof = db.query(AnalysisProfile).filter_by(key=HPLC_NATIVE_PROFILE_KEY).one_or_none()
    if prof is None:
        prof = AnalysisProfile(
            key=HPLC_NATIVE_PROFILE_KEY, name=HPLC_NATIVE_PROFILE_NAME,
            is_addon=False, vials_required=1, fulfillment_role="hplc",
            fulfillment_dim="role", sort_order=0, active=False,
            coa_archetype=None,
        )
        db.add(prof)
        db.flush()
        log_create(db, prof, _PROFILE_LOG_FIELDS, entity_type="profile",
                   entity_pk=prof.id, user_id=None)
        report["profile"] = 1
        member_ids = [services[kw].id for kw, *_ in HPLC_NATIVE_SERVICES]
        for i, sid in enumerate(member_ids):
            db.execute(analysis_profile_members.insert().values(
                analysis_profile_id=prof.id, analysis_service_id=sid, sort_order=i))
        log_members(db, entity_type="profile_members", entity_pk=prof.id, user_id=None,
                    field="member_ids", before_ids=[], after_ids=member_ids)
        report["members"] = len(member_ids)

    # --- wildcard spec rows ---
    for keyword, (kind, lo, hi, eq, unit, display) in HPLC_NATIVE_SPECS.items():
        svc = services[keyword]
        existing = (db.query(AnalysisServiceSpec)
                    .filter(AnalysisServiceSpec.analysis_service_id == svc.id,
                            AnalysisServiceSpec.matrix.is_(None),
                            AnalysisServiceSpec.peptide_id.is_(None))
                    .first())
        if existing is not None:
            continue
        spec = AnalysisServiceSpec(
            analysis_service_id=svc.id, matrix=None, rule_kind=kind,
            min_value=lo, max_value=hi, equals_value=eq, unit=unit,
            display_override=display,
        )
        db.add(spec)
        db.flush()
        record_spec_change(db, spec, before=None, actor_user_id=None)
        report["specs"] += 1

    db.commit()
    if any(report.values()):
        log.info("catalog.hplc_native_seed %s", report)
    return report
