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

HPLC vials MIRROR the parent SENAITE sample's full HPLC analyte set.
Instead of seeding a generic HPLC-PUR/HPLC-ID whitelist, the seeder reads
the parent AR's analysis keywords (sub_samples.senaite.fetch_parent_analysis_keywords)
and creates one lims_analyses row per keyword that exists in the Mk1 catalog
EXCEPT those in the non-HPLC service groups ("Microbiology" + "Endotoxin").
This captures the real per-analyte purity/quantity/identity rows (ANALYTE-N-*,
ID_*), blend purity (BLEND-PUR), peptide totals (PEPT-Total) and HPLC-ID exactly
as the parent carries them. The predicate is exclude-non-HPLC-groups (not
include-Analytics) because the per-analyte ANALYTE-N-* services are intentionally
ungrouped — an Analytics-group include filter would silently drop them. Micro
keywords (STER-PCR, KF in Microbiology; ENDO-LAL in Endotoxin) are dropped;
those vials get their own role seeding.

The mirror is fail-hard: a SENAITE read error propagates so the caller can
abort rather than seed a partial/empty analyte set. endo/ster/xtra vials are
unaffected — they keep the fixed single-keyword ROLE_TO_KEYWORDS whitelist.

Idempotent: calling twice with the same args is a no-op the second time
(deduped by the partial unique index on (lims_sub_sample_pk, keyword)).
"""

from __future__ import annotations

import logging
import re
from typing import Dict, List, Optional, Set

from sqlalchemy import select
from sqlalchemy.orm import Session

from lims_analyses import service as la_service
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsSubSample,
    ServiceGroup,
    service_group_members,
)

log = logging.getLogger(__name__)

# Generic per-analyte purity/quantity keyword as carried on the parent blend AR.
# Translated by the mirror into the slot peptide's per-substance PUR_<X>/QTY_<X>.
_PARENT_ANALYTE = re.compile(r"^ANALYTE-([1-4])-(PUR|QTY)$")

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
# analyses for the role. EXACT match — no substring magic. HPLC is NOT here:
# HPLC vials mirror the parent's Analytics analyte set (see
# mirror_parent_hplc_analyses) rather than seeding a fixed whitelist.
ROLE_TO_KEYWORDS: Dict[str, List[str]] = {
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


# Service groups whose analyses are NOT HPLC/Analyses-dept work, so they must be
# dropped from the HPLC-vial mirror. Endotoxin is its OWN group (ENDO-LAL), a
# sibling of Microbiology (STER-PCR/KF) — excluding only "Microbiology" let
# ENDO-LAL leak onto HPLC vials (e.g. BW-0015-S01 showed an Endotoxin row on the
# parent's vial overlay though the vial was HPLC-assigned).
_NON_HPLC_GROUPS = ("Microbiology", "Endotoxin")


def _micro_group_keywords(db: Session) -> Set[str]:
    """Resolve the analysis keywords of the non-HPLC service groups (Microbiology
    + Endotoxin) by group name.

    Returns an empty set if none exist — so missing groups exclude nothing
    (default-open). The HPLC mirror uses this as an EXCLUDE list, not an include
    filter (see mirror_parent_hplc_analyses); Analytics-grouped and ungrouped
    (ANALYTE-N-*) services are therefore kept."""
    rows = db.execute(
        select(AnalysisService.keyword)
        .join(
            service_group_members,
            service_group_members.c.analysis_service_id == AnalysisService.id,
        )
        .join(
            ServiceGroup,
            ServiceGroup.id == service_group_members.c.service_group_id,
        )
        .where(ServiceGroup.name.in_(_NON_HPLC_GROUPS))
    ).scalars().all()
    return {k for k in rows if k}


def mirror_parent_hplc_analyses(
    db: Session,
    *,
    sub_sample: LimsSubSample,
    parent_sample_id: str,
    existing_kw: set,
    created_by_user_id: Optional[int],
    commit: bool = True,
) -> List[LimsAnalysis]:
    """Mirror the parent's HPLC analyses onto the HPLC vial.

    Reads the parent's SENAITE analysis keywords and seeds a lims_analyses row
    for every keyword that exists in the Mk1 catalog EXCEPT those belonging to
    the Microbiology service group (ENDO-LAL/STER-PCR/KF — those vials get
    their own role-based seeding).

    Generic per-analyte keywords (ANALYTE-{n}-PUR / ANALYTE-{n}-QTY) are
    TRANSLATED to the slot peptide's per-substance service (PUR_<X> / QTY_<X>)
    using the parent's Analyte{N}Peptide slot map: slot title → ID_<X> service
    (exact title match) → peptide_id → PUR_<X>/QTY_<X>. An ANALYTE-{n} whose
    slot is empty is SKIPPED. If the per-substance service is somehow missing,
    the generic ANALYTE-{n} service is seeded as a safety fallback (+ warning)
    so the analyte is never silently dropped. Identity (ID_<X>), BLEND-PUR,
    PEPT-Total and HPLC-ID are mirrored unchanged.

    The predicate is EXCLUDE-Microbiology, not include-Analytics, on purpose:
    the per-analyte services (ANALYTE-N-PUR / ANALYTE-N-QTY) are intentionally
    ungrouped in the catalog, so an Analytics-group include filter would drop
    exactly the per-analyte rows this feature exists to mirror. Default-open
    (seed unless it's a known Micro keyword) is the correct error direction —
    under-inclusion silently loses analyte data.

    Fail-hard: a SENAITE read error propagates (the caller aborts rather than
    seed a partial analyte set).

    `existing_kw` is the caller-built set of already-seeded keywords for this
    vial; matching rows are skipped (idempotency, also backed by the partial
    unique index on (lims_sub_sample_pk, keyword)).
    """
    # Late import + module-attribute reference so monkeypatching
    # sub_samples.senaite.fetch_parent_analysis_keywords takes effect in tests.
    from sub_samples import senaite as senaite_mod

    # Whole catalog indexed by keyword (NOT restricted to a group — see docstring).
    svc_rows = db.execute(select(AnalysisService)).scalars().all()
    svc_by_kw = {s.keyword: s for s in svc_rows if s.keyword}

    # Keywords to drop: the Microbiology group (ENDO-LAL/STER-PCR/KF).
    micro_kw = _micro_group_keywords(db)

    # raises -> fail-hard
    parent_keywords = senaite_mod.fetch_parent_analysis_keywords(parent_sample_id)

    # Per-substance translation indexes (built from the catalog already loaded).
    # pur_by_pep/qty_by_pep assume one PUR_/QTY_ service per peptide (the 1:1
    # invariant the migration establishes). Iterating by ascending keyword with
    # setdefault makes the pick deterministic (lowest keyword wins) and matches the
    # prep bridge's `order_by(keyword).limit(1)`, so the row seeded here is the row
    # the bridge later resolves — even in the (currently nonexistent) two-services-
    # per-peptide edge.
    id_svc_by_title = {
        s.title: s for s in svc_rows
        if s.keyword and s.keyword.startswith("ID_") and s.title
    }
    pur_by_pep: dict = {}
    qty_by_pep: dict = {}
    for s in sorted((x for x in svc_rows if x.keyword and x.peptide_id), key=lambda x: x.keyword):
        if s.keyword.startswith("PUR_"):
            pur_by_pep.setdefault(s.peptide_id, s)
        elif s.keyword.startswith("QTY_"):
            qty_by_pep.setdefault(s.peptide_id, s)

    # Slot->substance map: only read SENAITE when a generic ANALYTE-{n} keyword is
    # present (single-peptide HPLC vials carry HPLC-PUR/HPLC-ID, never ANALYTE-N).
    # fetch_parent_analyte_slots raises on error -> fail-hard (consistent).
    needs_slots = any(_PARENT_ANALYTE.match(kw) for kw in parent_keywords)
    slot_map = senaite_mod.fetch_parent_analyte_slots(parent_sample_id) if needs_slots else {}

    inserted: List[LimsAnalysis] = []
    for kw in parent_keywords:
        m = _PARENT_ANALYTE.match(kw)
        if m:
            slot_n, cat = int(m.group(1)), m.group(2)
            title = slot_map.get(slot_n)
            if not title:
                log.info(
                    "seeder.mirror.skip_empty_slot sub=%s slot=%s kw=%s",
                    sub_sample.sample_id, slot_n, kw,
                )
                continue
            id_svc = id_svc_by_title.get(title)
            per = None
            if id_svc is not None and id_svc.peptide_id is not None:
                per = (pur_by_pep if cat == "PUR" else qty_by_pep).get(id_svc.peptide_id)
            if per is not None:
                svc = per
            else:
                # Safety fallback: per-substance service missing — keep the generic
                # row so the analyte is never silently dropped. Two distinct causes,
                # logged separately so a prod occurrence is diagnosable:
                #   - no_id_service: slot title matched no ID_<X> service
                #   - no_per_sibling: ID_<X> resolved but has no PUR_/QTY_ sibling
                reason = "no_id_service" if id_svc is None else "no_per_sibling"
                svc = svc_by_kw.get(kw)
                log.warning(
                    "seeder.mirror.no_per_substance sub=%s slot=%s title=%r kw=%s reason=%s — fell back to generic",
                    sub_sample.sample_id, slot_n, title, kw, reason,
                )
                if svc is None:
                    continue
        else:
            svc = svc_by_kw.get(kw)
            if svc is None:          # keyword not in the Mk1 catalog at all
                continue
        if svc.keyword in micro_kw:   # Microbiology analysis (ENDO-LAL/STER-PCR/KF)
            continue
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
            commit=commit,
        )
        inserted.append(row)
        existing_kw.add(svc.keyword)
        log.info(
            "seeder.mirror.seeded sub=%s analysis_id=%s keyword=%s",
            sub_sample.sample_id, row.id, svc.keyword,
        )
    return inserted


def seed_analyses_for_vial(
    db: Session,
    *,
    sub_sample: LimsSubSample,
    role: str,
    wp_services: Dict[str, bool],
    parent_sample_id: Optional[str] = None,
    created_by_user_id: Optional[int] = None,
    commit: bool = True,
) -> List[LimsAnalysis]:
    """
    Insert lims_analyses rows for this vial based on its role + the parent's
    WP profile. Idempotent: any (sub_sample_pk, keyword) pair that already
    exists is skipped silently.

    commit=True (default) keeps per-row commits — the best-effort create path
    and compute_vial_plan rely on this. Pass commit=False (set_assignment_role)
    to leave every seeded row pending in the caller's transaction so the
    role-flip + audit event + all analyses commit atomically as one unit.

    HPLC vials MIRROR the parent's Analytics analyte set — see
    mirror_parent_hplc_analyses. This requires `parent_sample_id`; omitting it
    for an HPLC vial is a programming error (raises ValueError). The SENAITE
    read inside the mirror is fail-hard and propagates on error.

    endo/ster vials seed their fixed single-keyword ROLE_TO_KEYWORDS whitelist
    (unchanged). xtra vials seed nothing.

    Returns the list of newly-inserted rows (empty if nothing was needed).
    """
    if not role_implies_seeding(role, wp_services):
        log.info(
            "seeder.skip_no_seeding sub=%s role=%s wp_keys=%s",
            sub_sample.sample_id, role, sorted(wp_services.keys()),
        )
        return []

    # Already-seeded keywords for this vial — skip them. Dead rows
    # (rejected/retracted) do NOT block: a service rejected on the parent and
    # later re-added must resurrect as a fresh active row next to the dead
    # one. Mirrors the uq_lims_analyses_sub_service_root partial-index
    # predicate, which enforces uniqueness only across active root rows.
    existing = db.execute(
        select(LimsAnalysis.keyword).where(
            LimsAnalysis.lims_sub_sample_pk == sub_sample.id,
            LimsAnalysis.review_state.notin_(["rejected", "retracted"]),
        )
    ).scalars().all()
    existing_kw = set(existing)

    # ── HPLC: mirror the parent's Analytics analyte set ──────────────────────
    if role == "hplc":
        if not parent_sample_id:
            raise ValueError(
                "seed_analyses_for_vial(role='hplc') requires parent_sample_id"
            )
        return mirror_parent_hplc_analyses(
            db,
            sub_sample=sub_sample,
            parent_sample_id=parent_sample_id,
            existing_kw=existing_kw,
            created_by_user_id=created_by_user_id,
            commit=commit,
        )

    # ── endo / ster: fixed single-keyword whitelist (unchanged) ──────────────
    services = select_services_for_role(db, role)
    if not services:
        log.warning(
            "seeder.no_matching_services sub=%s role=%s — nothing to seed",
            sub_sample.sample_id, role,
        )
        return []

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
            commit=commit,
        )
        inserted.append(row)
        existing_kw.add(svc.keyword)
        log.info(
            "seeder.seeded sub=%s analysis_id=%s keyword=%s",
            sub_sample.sample_id, row.id, svc.keyword,
        )

    return inserted
