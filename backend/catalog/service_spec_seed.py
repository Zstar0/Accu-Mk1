"""Seed analysis_service_specs to parity with COABuilder's BAKED_SPECS.

The five native rows, all matrix=NULL (NULL = every matrix — this is what
fixes the Bacteriostatic Water 422 for free). Values frozen at the
2026-08-03 BAKED_SPECS state; G-A gate: the lab confirms or replaces the
numbers before the combined deploy.

Idempotent: keyed on (service, matrix IS NULL); any existing row in the
slot — active or deactivated — is left alone. The service is resolved by
keyword AT SEED TIME ONLY; the stored row holds the FK. Missing services
skip silently (a fresh DB may not carry the native services).
"""
import logging
from decimal import Decimal

from sqlalchemy.orm import Session

log = logging.getLogger(__name__)

# keyword -> (rule_kind, min, max, equals, unit)
# STERILITY_USP71's unit is None ON PURPOSE: BAKED_SPECS carries no unit key
# for it; seeding one would newly arm the unit-divergence warning against
# the row unit "Pos/Neg".
_PARITY_SPECS = {
    "HM-PB": ("range", None, Decimal("0.5"), None, "ppm"),
    "HM-AS": ("range", None, Decimal("1.5"), None, "ppm"),
    "HM-CD": ("range", None, Decimal("0.5"), None, "ppm"),
    "HM-HG": ("range", None, Decimal("1.5"), None, "ppm"),
    "STERILITY_USP71": ("equals", None, None, "Not Detected", None),
}


def seed_service_specs(db: Session) -> int:
    from catalog.service_spec_audit import record_spec_change
    from models import AnalysisService, AnalysisServiceSpec

    created = 0
    for keyword, (kind, lo, hi, eq, unit) in _PARITY_SPECS.items():
        svc = (
            db.query(AnalysisService)
            .filter(AnalysisService.keyword == keyword,
                    AnalysisService.origin == "mk1")
            .one_or_none()
        )
        if svc is None:
            continue
        existing = (
            db.query(AnalysisServiceSpec)
            .filter(AnalysisServiceSpec.analysis_service_id == svc.id,
                    AnalysisServiceSpec.matrix.is_(None))
            .one_or_none()
        )
        if existing is not None:
            continue
        spec = AnalysisServiceSpec(
            analysis_service_id=svc.id, matrix=None, rule_kind=kind,
            min_value=lo, max_value=hi, equals_value=eq, unit=unit,
        )
        db.add(spec)
        db.flush()   # assign spec.id before the audit row references it
        record_spec_change(db, spec, before=None, actor_user_id=None)
        created += 1
    db.commit()
    if created:
        log.info("catalog.service_spec_seed created=%s", created)
    return created
