"""
Mk1-native analyses seeder.

Given a sub-sample + a role, work out which analyses should exist on that
vial in Mk1 and insert lims_analyses rows for them. Reads the parent's WP
profile via the existing IS bridge (sub_samples.service.fetch_sample_services)
and filters Mk1's analysis_services catalog by an exact-keyword whitelist
per role.

Per the revised Phase 2 scope, the SENAITE secondary AR continues to be
created and its cloned analyses remain the source of truth UNTIL Phase 3's
AnalysisTable adapter cuts reads over to Mk1. The Mk1 rows seeded here are
the parallel-shadow that becomes authoritative at Phase 3 cutover.

The mapping below is intentionally conservative: it seeds the GENERIC
HPLC-PUR + HPLC-ID services for HPLC vials, not the per-peptide ID_* rows.
The per-peptide rows continue to live on the SENAITE secondary AR (cloned
by SENAITE's native secondary-create behavior from the parent's Profiles +
AnalytePeptide fields). Phase 3+ can refine this if needed once it's clear
what the AnalysisTable adapter wants to see.

Idempotent: calling twice with the same args is a no-op the second time
(deduped by the partial unique index on (lims_sub_sample_pk, keyword)).
"""

from __future__ import annotations

import logging
from typing import Dict, List, Optional, Set

from sqlalchemy import select
from sqlalchemy.orm import Session

from lims_analyses import service as la_service
from models import AnalysisService, LimsAnalysis, LimsSubSample

log = logging.getLogger(__name__)

# Role → set of WP service keys that imply analyses at this role.
#
# These mirror the keys consumed by derive_demand() in backend/sub_samples/
# service.py — kept in sync by hand. If a key is added there (a new WP
# customer-facing service category), mirror the addition here.
ROLE_TO_WP_KEYS: Dict[str, Set[str]] = {
    "hplc": {"hplcpurity_identity", "bac_water_panel"},
    "endo": {"endotoxin"},
    "ster": {"sterility_pcr"},
    "xtra": set(),  # XTRA vials seed nothing; see scope decision #1
}

# Role → exact analysis_services.keyword whitelist that selects the right
# analyses for the role. EXACT match — no substring magic — to avoid
# accidentally including per-peptide ID_* rows that the SENAITE-side
# cloning already covers.
ROLE_TO_KEYWORDS: Dict[str, List[str]] = {
    "hplc": ["HPLC-PUR", "HPLC-ID"],
    "endo": ["ENDO-LAL"],
    "ster": ["STER-PCR"],
    "xtra": [],
}


def role_implies_seeding(role: Optional[str], wp_services: Dict[str, bool]) -> bool:
    """True iff this role's analyses are requested by the WP profile."""
    if not role or role == "xtra":
        return False
    role_keys = ROLE_TO_WP_KEYS.get(role, set())
    return any(wp_services.get(k) for k in role_keys)


def select_services_for_role(db: Session, role: str) -> List[AnalysisService]:
    """Return the analysis_services rows whose keyword exactly matches the
    role's whitelist. Empty list if the role has no whitelist (xtra) or
    the catalog doesn't carry any matching keyword."""
    keywords = ROLE_TO_KEYWORDS.get(role, [])
    if not keywords:
        return []
    rows = db.execute(
        select(AnalysisService).where(AnalysisService.keyword.in_(keywords))
    ).scalars().all()
    return list(rows)


def seed_analyses_for_vial(
    db: Session,
    *,
    sub_sample: LimsSubSample,
    role: str,
    wp_services: Dict[str, bool],
    created_by_user_id: Optional[int] = None,
) -> List[LimsAnalysis]:
    """
    Insert lims_analyses rows for this vial based on its role + the parent's
    WP profile. Idempotent: any (sub_sample_pk, keyword) pair that already
    exists is skipped silently.

    Returns the list of newly-inserted rows (empty if nothing was needed).
    """
    if not role_implies_seeding(role, wp_services):
        log.info(
            "seeder.skip_no_seeding sub=%s role=%s wp_keys=%s",
            sub_sample.sample_id, role, sorted(wp_services.keys()),
        )
        return []

    services = select_services_for_role(db, role)
    if not services:
        log.warning(
            "seeder.no_matching_services sub=%s role=%s — nothing to seed",
            sub_sample.sample_id, role,
        )
        return []

    # Already-seeded keywords for this vial — skip them
    existing = db.execute(
        select(LimsAnalysis.keyword).where(
            LimsAnalysis.lims_sub_sample_pk == sub_sample.id
        )
    ).scalars().all()
    existing_kw = set(existing)

    inserted: List[LimsAnalysis] = []
    for svc in services:
        if svc.keyword in existing_kw:
            continue
        row = la_service.create_analysis(
            db,
            host_kind="sub_sample",
            host_pk=sub_sample.id,
            analysis_service_id=svc.id,
            keyword=svc.keyword,
            title=svc.title or svc.keyword,
            created_by_user_id=created_by_user_id,
        )
        inserted.append(row)
        log.info(
            "seeder.seeded sub=%s analysis_id=%s keyword=%s",
            sub_sample.sample_id, row.id, svc.keyword,
        )
    return inserted
