"""Boot seed for the native Bac Water family (spec 2026-10-05, MB1).

Three origin=mk1 Analytical services (PH-BW / BENZYL-ALCOHOL-BW /
FILL-VOLUME-BW) and ONE profile `bacteriostatic-water-panel` mirroring the
legacy `bac_water_panel` demand (role hplc, 1 vial), plus wildcard specs.
Same idempotency, collision-abort and change-log rules as
catalog/hplc_native_seed.py (read its docstring; not repeated here):
  * a service is keyed on (keyword, origin='mk1'); present => untouched;
  * the profile is keyed on key; present => untouched, members only on
    first creation;
  * spec rows use the wildcard slot and skip when any row occupies it;
  * a same-keyword row of another origin skips that service and aborts the
    profile (three members or none).

Seeded INACTIVE and it STAYS inactive at flip (spec MB1, like prod
hplc-purity-identity). catalog_demand still fulfils an inactive profile for a
paid order, IS still learns the key (/s2s/catalog/service-keys ships every
profile key), and the Manage Analyses picker hides it.

sla_tier_id is deliberately NOT set (None). Evidence, origin/master e5852180:
the legacy bac_water_panel profile carries no tier, and both SLA resolvers
skip INACTIVE profiles anyway (src/lib/sla-resolution.ts
buildServiceToProfileTierMap `if (!p.active) continue`; main.py:11021
`AnalysisProfile.active.is_(True)` for sla_perf / ready-to-publish). Native
and legacy BW therefore resolve the same tier: group tier, else default.

Departments: unlike HPLC-%, nothing rescues these keywords into a department
on a later boot (catalog/departments.py _UNGROUPED_ANALYTICAL_LIKE_PATTERNS),
and a NULL department hid BW from the worksheet inbox on 09-01. With no
Analytical department the seed creates NOTHING and logs ERROR; init_db runs
backfill_departments (which seeds departments) first, so prod never hits it.

NOT added to sub_samples.product_registry.PRODUCT_REGISTRY: that map is the
legacy profile set pinned by test_profile_parity.py.
"""
import logging
from decimal import Decimal

from sqlalchemy.orm import Session

from catalog.bw_keys import NATIVE_BW_KEY

log = logging.getLogger(__name__)

BW_NATIVE_PROFILE_KEY = NATIVE_BW_KEY
BW_NATIVE_PROFILE_NAME = "Bac Water Panel"
_CATEGORY = "Bacteriostatic Water"   # never "HPLC": throughput classifies category first

# keyword, title, unit, result_type, variance_capable; ORDER = member sort_order.
# Titles + units mirror the prod SENAITE services exactly (prod read 2026-10-05:
# "pH Determination"/pH, "Benzyl Alcohol Assay (HPLC)"/% (v/v),
# "Fill volume / Net content"/mL). Spec bounds + display strings mirror LIVE
# coabuilder baked_specs.py:39-49 (BA widened to +/-20% in 2.28.3, Handler
# sign-off 2026-07-17); Mk1's vendored copy (0.81-0.99) is stale, not the source.
BW_NATIVE_SERVICES: tuple[tuple[str, str, str | None, str, bool], ...] = (
    ("PH-BW", "pH Determination", "pH", "numeric", True),
    ("BENZYL-ALCOHOL-BW", "Benzyl Alcohol Assay (HPLC)", "% (v/v)", "numeric", True),
    ("FILL-VOLUME-BW", "Fill volume / Net content", "mL", "numeric", False),
)

# keyword -> (rule_kind, min, max, equals, unit, display_override); spec R4.
BW_NATIVE_SPECS = {
    "PH-BW": ("range", Decimal("4.5"), Decimal("7.0"), None, "pH", "4.5 – 7.0"),
    "BENZYL-ALCOHOL-BW": ("range", Decimal("0.72"), Decimal("1.08"), None, "% (v/v)",
                          "0.9% (v/v) ±20%"),
    "FILL-VOLUME-BW": ("informational", None, None, None, "mL", None),  # prints "Measured"
}

_SERVICE_LOG_FIELDS = ("title", "keyword", "unit", "result_type", "result_options",
                       "origin", "department_id", "variance_capable", "category")
_PROFILE_LOG_FIELDS = ("key", "name", "is_addon", "vials_required",
                       "fulfillment_role", "fulfillment_dim", "active", "coa_archetype")


def seed_bw_native_catalog(db: Session) -> dict[str, int]:
    from catalog.change_log import log_create, log_members
    from catalog.departments import department_id_by_name
    from catalog.service_spec_audit import record_spec_change
    from coa.bw_shim import LEGACY_BW_ARCHETYPE
    from models import (AnalysisProfile, AnalysisService, AnalysisServiceSpec,
                        analysis_profile_members)

    report = {"services": 0, "profile": 0, "members": 0, "specs": 0}

    dept_id = department_id_by_name(db, "Analytical")
    if dept_id is None:
        log.error("bw_native_seed.no_analytical_department: nothing seeded; "
                  "retried on the next boot")
        return report

    services: dict[str, AnalysisService] = {}
    collisions: list[str] = []
    for keyword, title, unit, result_type, variance_capable in BW_NATIVE_SERVICES:
        svc = (db.query(AnalysisService)
               .filter(AnalysisService.keyword == keyword, AnalysisService.origin == "mk1")
               .one_or_none())
        if svc is None:
            other = (db.query(AnalysisService)
                     .filter(AnalysisService.keyword == keyword, AnalysisService.origin != "mk1")
                     .one_or_none())
            if other is not None:
                log.error("bw_native_seed.keyword_collision keyword=%s origin=%s id=%s: "
                          "skipping; resolve in the catalog admin",
                          keyword, other.origin, other.id)
                collisions.append(keyword)
                continue
            svc = AnalysisService(
                title=title, keyword=keyword, unit=unit, result_type=result_type,
                category=_CATEGORY, origin="mk1", department_id=dept_id,
                variance_capable=variance_capable, active=True,
            )
            db.add(svc)
            db.flush()
            log_create(db, svc, _SERVICE_LOG_FIELDS, entity_type="service",
                       entity_pk=svc.id, user_id=None)
            report["services"] += 1
        services[keyword] = svc

    if collisions:
        log.error("bw_native_seed.profile_creation_aborted collided_keywords=%s: %s "
                  "cannot seed with all three members", collisions, BW_NATIVE_PROFILE_KEY)
        db.commit()
        return report

    prof = db.query(AnalysisProfile).filter_by(key=BW_NATIVE_PROFILE_KEY).one_or_none()
    if prof is None:
        prof = AnalysisProfile(
            key=BW_NATIVE_PROFILE_KEY, name=BW_NATIVE_PROFILE_NAME,
            is_addon=False, vials_required=1, fulfillment_role="hplc",
            fulfillment_dim="role", sort_order=0, active=False,
            coa_archetype=LEGACY_BW_ARCHETYPE,
        )
        db.add(prof)
        db.flush()
        log_create(db, prof, _PROFILE_LOG_FIELDS, entity_type="profile",
                   entity_pk=prof.id, user_id=None)
        report["profile"] = 1
        member_ids = [services[kw].id for kw, *_ in BW_NATIVE_SERVICES]
        for i, sid in enumerate(member_ids):
            db.execute(analysis_profile_members.insert().values(
                analysis_profile_id=prof.id, analysis_service_id=sid, sort_order=i))
        log_members(db, entity_type="profile_members", entity_pk=prof.id, user_id=None,
                    field="member_ids", before_ids=[], after_ids=member_ids)
        report["members"] = len(member_ids)

    for keyword, (kind, lo, hi, eq, unit, display) in BW_NATIVE_SPECS.items():
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
        log.info("catalog.bw_native_seed %s", report)
    return report
