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

GENERIC services (HPLC-PUR, HPLC-ID) are seeded for all HPLC vials via the
ROLE_TO_KEYWORDS whitelist. Per-peptide identity services (e.g.
"BPC-157 - Identity (HPLC)" / keyword ID_BPC157) are additionally seeded
for HPLC vials based on the parent's analyte name(s).

Analyte-name source: lims_samples.peptide_name. This column stores the
value of the SENAITE Analyte1Peptide field as it appeared at sample-create
time — which matches the analysis_services.title exactly (e.g.
"BPC-157 - Identity (HPLC)"). Direct exact-match; no transformation needed.
Limitation: only Analyte1 is captured in lims_samples; samples with 2-4
analytes (blends) will only get the first analyte's ID service seeded here.
Blend support can be added in a future phase by joining through
peptides → peptide_analytes → analysis_services.

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


def select_identity_service_by_title(
    db: Session, title: str
) -> Optional[AnalysisService]:
    """Return the analysis_services row whose title exactly matches `title`,
    or None when no such row exists.

    lims_samples.peptide_name stores the full SENAITE title string
    (e.g. "BPC-157 - Identity (HPLC)"), which is identical to
    analysis_services.title — so an exact-match lookup is sufficient.
    No normalisation or separator conversion is needed.
    """
    return db.execute(
        select(AnalysisService).where(AnalysisService.title == title)
    ).scalars().first()


def _seed_peptide_identity_services(
    db: Session,
    *,
    sub_sample: LimsSubSample,
    existing_kw: set,
    created_by_user_id: Optional[int],
) -> List[LimsAnalysis]:
    """Seed per-peptide identity service(s) onto an HPLC vial.

    Analyte-name source: sub_sample.parent_sample.peptide_name. This field
    holds the SENAITE Analyte1Peptide title verbatim (e.g. "BPC-157 - Identity
    (HPLC)"), which is an exact match for analysis_services.title. Only Analyte1
    is captured; blends with multiple analytes will get only the first analyte's
    ID service. Multi-analyte support can be added in a future phase via the
    peptides → peptide_analytes → analysis_services join.

    If the parent has no peptide_name, or the catalog has no matching row, the
    call is a no-op (logs at INFO/WARNING respectively, never raises).

    `existing_kw` is the caller-built set of already-seeded keywords for this
    vial; rows whose keyword appears there are skipped (idempotency).
    """
    parent = getattr(sub_sample, "parent_sample", None)
    peptide_title = getattr(parent, "peptide_name", None) if parent else None
    if not peptide_title:
        log.info(
            "seeder.peptide_identity.skip_no_analyte sub=%s — parent has no peptide_name",
            sub_sample.sample_id,
        )
        return []

    svc = select_identity_service_by_title(db, peptide_title)
    if svc is None:
        log.warning(
            "seeder.peptide_identity.no_service sub=%s title=%r — no matching analysis_service; skipping",
            sub_sample.sample_id, peptide_title,
        )
        return []

    if svc.keyword in existing_kw:
        log.info(
            "seeder.peptide_identity.already_seeded sub=%s keyword=%s",
            sub_sample.sample_id, svc.keyword,
        )
        return []

    row = la_service.create_analysis(
        db,
        host_kind="sub_sample",
        host_pk=sub_sample.id,
        analysis_service_id=svc.id,
        keyword=svc.keyword,
        title=svc.title or svc.keyword,
        created_by_user_id=created_by_user_id,
    )
    log.info(
        "seeder.peptide_identity.seeded sub=%s analysis_id=%s keyword=%s title=%r",
        sub_sample.sample_id, row.id, svc.keyword, svc.title,
    )
    return [row]


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

    For HPLC vials this seeds:
      1. Generic services (HPLC-PUR, HPLC-ID) from ROLE_TO_KEYWORDS.
      2. Per-peptide identity service (e.g. ID_BPC157) resolved from
         parent_sample.peptide_name → analysis_services.title exact match.

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
        existing_kw.add(svc.keyword)  # keep set current for peptide step
        log.info(
            "seeder.seeded sub=%s analysis_id=%s keyword=%s",
            sub_sample.sample_id, row.id, svc.keyword,
        )

    # For HPLC vials: additionally seed the per-peptide identity service.
    # Piggybacks the same role_implies_seeding gate already passed above —
    # no new WP-key check. existing_kw is passed in so the peptide step
    # inherits idempotency from the generic step in the same call.
    if role == "hplc":
        peptide_rows = _seed_peptide_identity_services(
            db,
            sub_sample=sub_sample,
            existing_kw=existing_kw,
            created_by_user_id=created_by_user_id,
        )
        inserted.extend(peptide_rows)

    return inserted
