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
and creates one lims_analyses row per keyword that exists in the Mk1 catalog ONLY IF
that service's department_id equals the Analytical department id (fail-closed
allow-list). Per-analyte ANALYTE-N-* services are tagged Analytical by the
catalog backfill, so they are kept. Microbiology-department keywords (STER-PCR,
KF, ENDO-LAL, PCR-BACTERIA, PCR-FUNGI) and any NULL/unknown-department service
are excluded; those vials get their own role seeding.

The mirror is fail-hard: a SENAITE read error propagates so the caller can
abort rather than seed a partial/empty analyte set. endo/ster/xtra vials are
unaffected — they keep the fixed single-keyword ROLE_TO_KEYWORDS whitelist.

Idempotent: calling twice with the same args is a no-op the second time
(deduped against both vial-tier root indexes — (lims_sub_sample_pk, keyword)
and (lims_sub_sample_pk, analysis_service_id) — see seed_analyses_for_vial's
two-set skip).
"""

from __future__ import annotations

import logging
import re
from typing import Dict, List, Optional, Set

from sqlalchemy import select
from sqlalchemy.orm import Session

from catalog.departments import ANALYTICAL_DEPARTMENT, department_id_by_name
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
# THE CATALOG IS AUTHORITATIVE; this map is the legacy fallback for the five
# existing keys. It mirrors the keys consumed by derive_demand() in
# backend/sub_samples/service.py — kept in sync by hand. New WP customer-
# facing service categories no longer get an entry here: they resolve
# directly from Analysis Profile membership (fulfillment_dim='role') via
# _catalog_members_for_role. This map is never extended for new roles.
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
#
# THE CATALOG IS AUTHORITATIVE; this map is the legacy fallback for the five
# existing keys (endo/ster/xtra + hplc's mirror carve-out above). Catalog
# roles (any role not in this map) seed from ordered Analysis Profile
# membership instead — see _catalog_members_for_role. Never re-route endo/
# ster onto the catalog path: they stay pinned here.
ROLE_TO_KEYWORDS: Dict[str, List[str]] = {
    "endo": ["ENDO-LAL"],
    "ster": ["STER-PCR"],
    "xtra": [],
}


def _members_through_origin_gate(
    profiles_with_members: List[tuple],
) -> List[AnalysisService]:
    """Shared per-profile fail-closed origin gate + cross-profile dedup.
    `profiles_with_members` is an ordered list of (profile, log_label,
    members) triples — log_label is the profile's key in both callers (the
    wp_services dict key on the predicate path, `prof.key` on the edge
    path), used only for the warning line; `members` is the ordered service
    list to gate/seed for that profile — live `prof.analysis_services` from
    both callers, or (task 6) a snapshot-sourced list from the edge path
    when the profile is in the vial's frozen snapshot. A profile with zero
    members or any non-mk1-origin member is skipped in full (mirrors
    spec-2's all-native section rule); its native siblings do NOT partially
    seed. Origin is read live off whichever member rows were chosen (frozen
    or live) — origin means "can Mk1 own this today," not "what was true at
    registration" — so a service that moved off mk1-origin after
    registration still fails closed here even on the snapshot-sourced path."""
    out: List[AnalysisService] = []
    seen: Set[int] = set()
    for prof, label, members in profiles_with_members:
        if not members or any(s.origin != "mk1" for s in members):
            log.warning("catalog_seed_skipped_non_native profile=%s", label)
            continue
        for s in members:
            if s.id not in seen:
                seen.add(s.id)
                out.append(s)
    return out


def _members_from_edges(
    db: Session, edges: list, snapshot: Optional[dict] = None,
) -> List[AnalysisService]:
    """Union of member services of the profiles named by `edges` — host
    edges first, then rider edges, each profile's members in profile-member
    sort_order (AnalysisProfile.analysis_services is already ordered by the
    junction row's sort_order). Profile ids are deduped up front (defensive:
    current edges shouldn't ever name the same profile twice, but a profile
    appearing as both host and rider must not double-seed its members).

    snapshot (S4 rider, task 6): the vial's PARENT catalog_snapshot. When an
    edge's profile_id has an entry in `snapshot["profiles"]`, member service
    ids come from that entry's FROZEN service_ids (resolved to AnalysisService
    rows by id, in the frozen order) instead of the live
    prof.analysis_services read — so a live membership edit after
    registration can't change what an already-registered vial seeds. Falls
    back to the live read — logging catalog_snapshot.fallback_live — for any
    profile NOT present in the snapshot (e.g. a profile whose custody edge
    exists but was never part of the frozen registration resolution) and
    when `snapshot` itself is NULL (unchanged pre-task-6 behavior, no new
    logging). A frozen service_id that no longer resolves to a live
    AnalysisService row (deleted since registration) is dropped from that
    profile's member list and logged as catalog_snapshot.service_id_missing
    rather than silently shortening it unremarked."""
    from models import AnalysisProfile, AnalysisService

    host_ids: List[int] = []
    rider_ids: List[int] = []
    seen_pid: Set[int] = set()
    for e in edges:
        if e.analysis_profile_id in seen_pid:
            continue
        seen_pid.add(e.analysis_profile_id)
        bucket = host_ids if e.relation == "host" else rider_ids
        bucket.append(e.analysis_profile_id)

    snapshot_by_pid = {}
    if snapshot:
        snapshot_by_pid = {p["profile_id"]: p for p in (snapshot.get("profiles") or [])}

    labeled: List[tuple] = []
    for pid in host_ids + rider_ids:
        prof = db.get(AnalysisProfile, pid)
        if prof is None:
            continue
        entry = snapshot_by_pid.get(pid)
        if entry is not None:
            svc_ids = entry.get("service_ids") or []
            svc_by_id = {}
            if svc_ids:
                svc_by_id = {
                    s.id: s for s in
                    db.query(AnalysisService).filter(AnalysisService.id.in_(svc_ids)).all()
                }
            members = [svc_by_id[i] for i in svc_ids if i in svc_by_id]
            if len(members) != len(svc_ids):
                log.warning(
                    "catalog_snapshot.service_id_missing profile=%s expected=%s resolved=%s",
                    prof.key, svc_ids, [s.id for s in members],
                )
        else:
            if snapshot is not None:
                log.warning(
                    "catalog_snapshot.fallback_live reason=profile_not_in_snapshot profile_id=%s",
                    pid,
                )
            members = prof.analysis_services
        labeled.append((prof, prof.key, members))
    return _members_through_origin_gate(labeled)


def _catalog_members_for_role(
    db: Session,
    role: str,
    wp_services: Dict[str, bool],
    sub_sample: Optional[LimsSubSample] = None,
) -> List[AnalysisService]:
    """Ordered mk1-origin member services for `role`. Fail-closed on origin:
    a profile with any non-mk1 member seeds nothing (mirrors spec-2's
    all-native section rule).

    Edge-driven (spec 4): when `sub_sample` is given AND has current custody
    edges (sub_samples.custody.current_custody), membership is the union of
    member services of those edge profiles — HOST profiles first, then
    RIDER profiles, each profile's members in profile-member sort_order —
    through the SAME per-profile origin gate and dedup as the legacy path.
    wp_services is NOT consulted on this path: the edge is the source of
    truth (the display and the audit trail are the same record), so a later
    drift in wp_services must never change what a vial with recorded
    custody seeds.

    Falls back to the legacy fulfilling-profiles predicate (ordered
    wp_services keys -> profiles whose fulfillment_dim='role' and
    fulfillment_role==role) when `sub_sample` is None (no vial context —
    legitimate for callers like role_implies_seeding) or has zero current
    custody edges — the latter also logs catalog_seed_no_custody_fallback,
    since a real vial with no edges yet is a genuine gap worth knowing
    about. This fallback branch always reads live prof.analysis_services —
    it has no edges to look a frozen snapshot entry up against.

    snapshot (S4 rider, task 6): on the edge-driven branch, read from
    `sub_sample.parent_sample.catalog_snapshot` (not a parameter here — see
    _members_from_edges for the per-profile frozen-vs-live split) and
    threaded straight through."""
    from models import AnalysisProfile

    if sub_sample is not None:
        from sub_samples.custody import current_custody

        edges = current_custody(db, sub_sample.id)
        if edges:
            snapshot = sub_sample.parent_sample.catalog_snapshot
            return _members_from_edges(db, edges, snapshot=snapshot)
        log.warning(
            "catalog_seed_no_custody_fallback role=%s sub=%s",
            role, sub_sample.sample_id,
        )

    ordered = [k for k, v in (wp_services or {}).items() if v]
    labeled: List[tuple] = []
    for key in ordered:
        prof = db.query(AnalysisProfile).filter_by(key=key).one_or_none()
        if prof is None or prof.fulfillment_dim != "role" or prof.fulfillment_role != role:
            continue
        labeled.append((prof, key, prof.analysis_services))
    return _members_through_origin_gate(labeled)


def role_implies_seeding(
    role: Optional[str],
    wp_services: Dict[str, bool],
    db: Optional[Session] = None,
    sub_sample: Optional[LimsSubSample] = None,
) -> bool:
    """True iff this role's analyses are requested by the WP profile.

    Legacy roles resolve from ROLE_TO_WP_KEYS (hand-synced map, retained as
    the fallback for the five existing keys). Catalog roles resolve from
    Analysis Profiles — THE CATALOG IS AUTHORITATIVE for any role the map
    does not know. Without `db` (legacy callers/tests), catalog roles report
    False rather than raising — matches the prior default-off behavior for
    any role outside ROLE_TO_WP_KEYS.

    `sub_sample` (optional, default None) is threaded straight through to
    _catalog_members_for_role on the catalog-role branch, so this gate
    evaluates the SAME edge-driven membership seed_analyses_for_vial's
    catalog branch will actually seed — a vial with current custody edges
    naming an all-native rider must not gate False just because its HOST
    anchor happens to carry a non-mk1 member (the origin gate is
    per-profile, not per-vial). Every other caller (tests, any legacy-role
    path) omits it and keeps today's wp_services-predicate-only behavior."""
    if not role or role == "xtra":
        return False
    if role in ROLE_TO_WP_KEYS:
        role_keys = ROLE_TO_WP_KEYS.get(role, set())
        return any(wp_services.get(k) for k in role_keys)
    if db is None:
        return False
    return bool(_catalog_members_for_role(db, role, wp_services, sub_sample=sub_sample))


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


# Service groups whose analyses are NOT HPLC/Analyses-dept work. Endotoxin is
# its OWN group (ENDO-LAL), a sibling of Microbiology (STER-PCR/KF) — excluding
# only "Microbiology" let ENDO-LAL leak onto HPLC vials (e.g. BW-0015-S01
# showed an Endotoxin row on the parent's vial overlay though the vial was
# HPLC-assigned). No longer consulted by the HPLC mirror (see
# mirror_parent_hplc_analyses, which uses a fail-closed Department allow-list
# instead); still used by the COA-generation blocking gate in main.py.
_NON_HPLC_GROUPS = ("Microbiology", "Endotoxin")


def _micro_group_keywords(db: Session) -> Set[str]:
    """Resolve the analysis keywords of the non-HPLC service groups (Microbiology
    + Endotoxin) by group name.

    Returns an empty set if none exist — so missing groups exclude nothing
    (default-open). Analytics-grouped and ungrouped (ANALYTE-N-*) services are
    therefore kept.

    The HPLC mirror no longer calls this function — it uses a fail-closed
    Department allow-list (see mirror_parent_hplc_analyses). This remains in
    use by the COA-generation blocking gate in main.py and by
    test_assign_role_fail_hard.py."""
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


def coa_exempt_keywords(db: Session) -> Set[str]:
    """Keywords exempt from COA-generation blocking (S2 port, RULED 2026-08-12).

    Department half: Microbiology (micro finishes after the analytical COA and
    re-generates) plus Heavy Metals (RULED: HM does not block until its
    turnaround reality is known — this REVERSES the pre-S2 behavior where HM
    blocked by omission). Group half: the legacy _micro_group_keywords set —
    kept as a transition union so the gate's fail posture cannot invert if
    either source is empty (prod may lack the Endotoxin group; department
    backfill may lag). Delete the group half at SENAITE decommission.
    """
    from catalog.departments import HEAVY_METALS_DEPARTMENT, MICROBIOLOGY_DEPARTMENT
    from models import Department

    dept_rows = db.execute(
        select(AnalysisService.keyword)
        .join(Department, Department.id == AnalysisService.department_id)
        .where(Department.name.in_((MICROBIOLOGY_DEPARTMENT, HEAVY_METALS_DEPARTMENT)))
    ).scalars().all()
    return {k for k in dept_rows if k} | _micro_group_keywords(db)


def mirror_parent_hplc_analyses(
    db: Session,
    *,
    sub_sample: LimsSubSample,
    parent_sample_id: str,
    existing_kw: set,
    existing_service_ids: set,
    created_by_user_id: Optional[int],
    commit: bool = True,
) -> List[LimsAnalysis]:
    """Mirror the parent's HPLC analyses onto the HPLC vial.

    Reads the parent's SENAITE analysis keywords and seeds a lims_analyses row
    for every keyword that exists in the Mk1 catalog ONLY IF that service's
    department_id equals the Analytical department id (fail-closed allow-list;
    see department_id_by_name). Per-analyte ANALYTE-N-* services are tagged
    Analytical by the catalog backfill, so they are kept. Microbiology-
    department keywords (ENDO-LAL/STER-PCR/KF/PCR-BACTERIA/PCR-FUNGI) and any
    NULL/unknown-department service are excluded (those vials get their own
    role-based seeding). If the Analytical department itself is missing, the
    mirror aborts and seeds nothing rather than falling back to open.

    Generic per-analyte keywords (ANALYTE-{n}-PUR / ANALYTE-{n}-QTY) are
    TRANSLATED to the slot peptide's per-substance service (PUR_<X> / QTY_<X>)
    using the parent's Analyte{N}Peptide slot map: slot title → ID_<X> service
    (exact title match) → peptide_id → PUR_<X>/QTY_<X>. An ANALYTE-{n} whose
    slot is empty is SKIPPED. If the per-substance service is somehow missing,
    the generic ANALYTE-{n} service is seeded as a safety fallback (+ warning)
    so the analyte is never silently dropped. Identity (ID_<X>), BLEND-PUR,
    PEPT-Total and HPLC-ID are mirrored unchanged, provided their own
    department_id is Analytical.

    The predicate is a fail-closed Department allow-list, not a Microbiology
    deny-list (was: exclude-known-Micro, which defaulted to "mirror it" —
    incident BW-0015-S01 put an Endotoxin row on an HPLC vial that way). It is
    keyed on department_id rather than service-group name so mis-tagged and
    ungrouped services fail closed instead of leaking onto a chromatography
    vial.

    Fail-hard: a SENAITE read error propagates (the caller aborts rather than
    seed a partial analyte set).

    `existing_kw` / `existing_service_ids` are the caller-built sets of
    already-seeded identities for this vial (see seed_analyses_for_vial); a
    candidate matching EITHER is skipped, mirroring the two live root indexes
    on (lims_sub_sample_pk, keyword) and (lims_sub_sample_pk,
    analysis_service_id). The id leg is what skips a native service whose
    stored keyword has drifted from its catalog keyword — the translation
    below resolves candidates through the CATALOG (PUR_<X>/QTY_<X> by
    peptide_id), so it hands back exactly the catalog keyword a drifted row no
    longer carries.
    """
    # Late import + module-attribute reference so monkeypatching
    # sub_samples.senaite.fetch_parent_analysis_keywords takes effect in tests.
    from sub_samples import senaite as senaite_mod

    # Whole catalog indexed by keyword (NOT restricted to a group — see docstring).
    svc_rows = db.execute(select(AnalysisService)).scalars().all()
    svc_by_kw = {s.keyword: s for s in svc_rows if s.keyword}

    # Fail-closed allow-list: only Analytical-department services mirror onto
    # HPLC vials. Microbiology / NULL / mis-tagged services are excluded by
    # default, so nothing can leak onto a chromatography vial. (Was: an
    # exclude-known-Micro deny-list, which defaulted to "contaminate".)
    analytical_dept_id = department_id_by_name(db, ANALYTICAL_DEPARTMENT)
    if analytical_dept_id is None:
        log.error("seeder.mirror.no_analytical_dept — aborting mirror (fail-closed)")
        return []

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
        if svc.department_id != analytical_dept_id:   # fail-closed: Analytical only
            continue
        if svc.id in existing_service_ids or svc.keyword in existing_kw:
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
        existing_service_ids.add(svc.id)
        log.info(
            "seeder.mirror.seeded sub=%s analysis_id=%s keyword=%s",
            sub_sample.sample_id, row.id, svc.keyword,
        )
    return inserted


def _seed_rows_from_services(
    db: Session,
    *,
    sub_sample: LimsSubSample,
    services: List[AnalysisService],
    existing_kw: set,
    existing_service_ids: set,
    created_by_user_id: Optional[int],
    commit: bool,
    log_event: str,
) -> List[LimsAnalysis]:
    """Create a lims_analyses row for every service not already seeded on this
    vial (idempotency). Shared row-construction block for both the legacy
    keyword-whitelist branch and the catalog-membership branch — same fields,
    same skip semantics, same commit handling.

    Already-seeded is the UNION of the two live root indexes: a candidate is
    skipped if its service id OR its keyword is already taken by an active
    root row (see seed_analyses_for_vial, which builds both sets). Keying on
    the id is what catches a native service whose stored keyword drifted."""
    inserted: List[LimsAnalysis] = []
    for svc in services:
        if svc.id in existing_service_ids or svc.keyword in existing_kw:
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
        existing_service_ids.add(svc.id)
        log.info(
            "seeder.%s sub=%s analysis_id=%s keyword=%s",
            log_event, sub_sample.sample_id, row.id, svc.keyword,
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
    (unchanged). xtra vials seed nothing. Any other role (a catalog role —
    first tenant: "hm") seeds from the ordered Analysis Profile membership
    that fulfils it — see _catalog_members_for_role. Catalog roles never
    re-route endo/ster/xtra/hplc; those stay pinned to their existing paths.

    Returns the list of newly-inserted rows (empty if nothing was needed).
    """
    if not role_implies_seeding(role, wp_services, db=db, sub_sample=sub_sample):
        log.info(
            "seeder.skip_no_seeding sub=%s role=%s wp_keys=%s",
            sub_sample.sample_id, role, sorted(wp_services.keys()),
        )
        return []

    # Already-seeded identities for this vial — skip them. Dead rows
    # (rejected/retracted) do NOT block: a service rejected on the parent and
    # later re-added must resurrect as a fresh active row next to the dead
    # one. Mirrors the vial-tier root indexes, which enforce uniqueness only
    # across active root rows.
    #
    # TWO sets because BOTH root indexes are live with identical predicates:
    # uq_lims_analyses_sub_service_root on (vial, keyword) and
    # uq_lims_analyses_sub_service_id_root on (vial, analysis_service_id).
    # A candidate is already-seeded if it collides on EITHER key — this set
    # answers "would this insert collide", which is not the same question as
    # Task 3's identity resolution (origin-scoped, because there the keyword
    # is a senaite row's grandfathered identity contract). The service-id
    # index is deliberately origin-agnostic, so the id set is not scoped to
    # mk1 rows either. Keying on the id is what catches a native row whose
    # stored keyword has DRIFTED from its catalog keyword: keyword-only, it
    # looked unseeded and re-seeded into an IntegrityError.
    #
    # One query, two projections — no join to analysis_services, so a legacy
    # row with a NULL service FK still contributes its keyword (an inner join
    # would have dropped it out of existing_kw and re-seeded it).
    existing = db.execute(
        select(LimsAnalysis.keyword, LimsAnalysis.analysis_service_id).where(
            LimsAnalysis.lims_sub_sample_pk == sub_sample.id,
            LimsAnalysis.review_state.notin_(["rejected", "retracted"]),
        )
    ).all()
    existing_kw = {kw for kw, _sid in existing}
    existing_service_ids = {sid for _kw, sid in existing if sid is not None}

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
            existing_service_ids=existing_service_ids,
            created_by_user_id=created_by_user_id,
            commit=commit,
        )

    # ── catalog roles (spec 3): seed from Analysis Profile membership ────────
    # Any role not in ROLE_TO_KEYWORDS is a catalog role (first tenant: "hm").
    # endo/ster stay on the keyword whitelist below — never re-route legacy
    # roles onto the catalog path.
    if role not in ROLE_TO_KEYWORDS:
        services = _catalog_members_for_role(db, role, wp_services, sub_sample=sub_sample)
        if not services:
            log.warning(
                "seeder.no_matching_catalog_members sub=%s role=%s — nothing to seed",
                sub_sample.sample_id, role,
            )
            return []
        return _seed_rows_from_services(
            db,
            sub_sample=sub_sample,
            services=services,
            existing_kw=existing_kw,
            existing_service_ids=existing_service_ids,
            created_by_user_id=created_by_user_id,
            commit=commit,
            log_event="catalog_seeded",
        )

    # ── endo / ster: fixed single-keyword whitelist (unchanged) ──────────────
    services = select_services_for_role(db, role)
    if not services:
        log.warning(
            "seeder.no_matching_services sub=%s role=%s — nothing to seed",
            sub_sample.sample_id, role,
        )
        return []

    return _seed_rows_from_services(
        db,
        sub_sample=sub_sample,
        services=services,
        existing_kw=existing_kw,
        existing_service_ids=existing_service_ids,
        created_by_user_id=created_by_user_id,
        commit=commit,
        log_event="seeded",
    )
