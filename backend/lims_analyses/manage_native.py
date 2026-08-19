"""Native Manage Analyses (spec docs/superpowers/specs/2026-08-18-native-manage-analyses-design.md).

Lab-side add / remove / re-sync of NATIVE (origin='mk1') analyses on a parent
sample and its vials, after an order exists. Composes three primitives that
stay unchanged:

  * parent tier   — lims_analyses.parent_placeholders.seed_parent_placeholders
                    (provenance='ordered' rows; the parent's "what is on this
                    sample" truth)
  * vial custody  — models.VialProfileAssignment host edges (spec 4). Since
                    spec 4 the vial seeder reads edges first and IGNORES
                    wp_services when edges exist, so "put a profile on a vial"
                    IS "write a host edge". write_custody_edges is never called
                    from here — it supersedes every current edge.
  * vial rows     — lims_analyses.seeder._seed_rows_from_services (the shared
                    row builder: dedupe by live keyword, create_analysis with
                    its 'auto' transition, log event)

Rulings baked in: A (provision-on-sample), P (profile-level add), R1 (soft
remove of the placeholder). Nothing here writes to WP or the IS.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import (
    AnalysisProfile, AnalysisService, LimsAnalysis, LimsSample, LimsSubSample,
    LimsSubSampleEvent, VialProfileAssignment,
)
from lims_analyses.parent_placeholders import PROVENANCE_ORDERED, seed_parent_placeholders
from lims_analyses.service import BadRequestError, ConflictError
# Module-level on purpose (tests monkeypatch mn.fetch_sample_services); same
# import coa/native_sections.py already makes at module level — no cycle.
from sub_samples.service import fetch_sample_services

log = logging.getLogger(__name__)

DEAD_STATES = ("rejected", "retracted")


class ProfileNotNativeError(BadRequestError):
    code = "profile_not_native"


class ProfileInactiveError(BadRequestError):
    code = "profile_inactive"


class ProfileHasNoMembersError(BadRequestError):
    code = "profile_has_no_members"


class ProfileAlreadyOnSampleError(ConflictError):
    code = "profile_already_on_sample"


# ── read helpers ─────────────────────────────────────────────────────────────

def _native_members(profile: AnalysisProfile) -> list[AnalysisService]:
    """The profile's member services, or raise. Same predicate as
    coa.native_sections._ordered_native_profiles: every member must be mk1."""
    if not profile.active:
        raise ProfileInactiveError(f"profile {profile.key!r} is inactive")
    members = list(profile.analysis_services)
    if not members:
        raise ProfileHasNoMembersError(f"profile {profile.key!r} has no member services")
    if any((getattr(s, "origin", None) or "") != "mk1" for s in members):
        raise ProfileNotNativeError(f"profile {profile.key!r} has a non-native member")
    return members


def _is_all_native(profile: AnalysisProfile) -> bool:
    try:
        _native_members(profile)
        return True
    except BadRequestError:
        return False


def _live_parent_service_ids(db: Session, parent: LimsSample) -> set[int]:
    """Service ids with a LIVE parent-tier row: an 'ordered' placeholder or a
    non-dead 'canonical' row (a promoted result counts as 'on the sample')."""
    rows = db.execute(
        select(LimsAnalysis.analysis_service_id).where(
            LimsAnalysis.lims_sample_pk == parent.id,
            LimsAnalysis.lims_sub_sample_pk.is_(None),
            LimsAnalysis.provenance.in_((PROVENANCE_ORDERED, "canonical")),
            LimsAnalysis.review_state.notin_(DEAD_STATES),
        )
    ).scalars().all()
    return set(rows)


def _vials_of(db: Session, parent: LimsSample) -> list[LimsSubSample]:
    return db.execute(
        select(LimsSubSample)
        .where(LimsSubSample.parent_sample_pk == parent.id)
        .order_by(LimsSubSample.vial_sequence)
    ).scalars().all()


def _host_vials(db: Session, parent: LimsSample, profile: AnalysisProfile) -> list[LimsSubSample]:
    """Existing vials whose assignment_role is the profile's host role.
    Role-dimension profiles host on their own fulfillment_role; anything else
    (rider profiles) hosts nowhere here — they attach at check-in via
    resolve_catalog_fulfillment and are out of this slice's add path."""
    if profile.fulfillment_dim != "role" or not profile.fulfillment_role:
        return []
    return [v for v in _vials_of(db, parent) if v.assignment_role == profile.fulfillment_role]


def native_profiles_for_parent(db: Session, *, parent: LimsSample) -> list[dict]:
    """Picker payload: active all-mk1 profiles with membership, whether the
    sample already carries them, and which existing vials would host them."""
    live = _live_parent_service_ids(db, parent)
    out: list[dict] = []
    profiles = db.execute(
        select(AnalysisProfile).where(AnalysisProfile.active.is_(True))
        .order_by(AnalysisProfile.sort_order, AnalysisProfile.name)
    ).scalars().all()
    for prof in profiles:
        if not _is_all_native(prof):
            continue
        members = list(prof.analysis_services)
        have = sum(1 for m in members if m.id in live)
        on_sample = "none" if have == 0 else ("full" if have == len(members) else "partial")
        out.append({
            "id": prof.id,
            "key": prof.key,
            "name": prof.name,
            "fulfillment_role": prof.fulfillment_role,
            "members": [{"service_id": m.id, "keyword": m.keyword, "title": m.title} for m in members],
            "on_sample": on_sample,
            "host_vials": [v.sample_id for v in _host_vials(db, parent, prof)],
        })
    return out


def placeholder_profile_keys(db: Session, parent: LimsSample) -> dict[str, bool]:
    """{profile.key: True} for every active all-mk1 profile with ≥1 member that
    has a LIVE 'ordered' placeholder on the parent. Unioned into the role-flip
    services map (sub_samples.service.set_assignment_role) so a lab-added
    profile seeds when a matching-role vial appears — ruling A's promise."""
    live_ordered = set(db.execute(
        select(LimsAnalysis.analysis_service_id).where(
            LimsAnalysis.lims_sample_pk == parent.id,
            LimsAnalysis.lims_sub_sample_pk.is_(None),
            LimsAnalysis.provenance == PROVENANCE_ORDERED,
            LimsAnalysis.review_state.notin_(DEAD_STATES),
        )
    ).scalars().all())
    if not live_ordered:
        return {}
    keys: dict[str, bool] = {}
    for prof in db.execute(select(AnalysisProfile).where(AnalysisProfile.active.is_(True))).scalars():
        if not _is_all_native(prof):
            continue
        if any(m.id in live_ordered for m in prof.analysis_services):
            keys[prof.key] = True
    return keys


# ── write path: add ──────────────────────────────────────────────────────────

def _ensure_host_edge(db: Session, *, vial: LimsSubSample, profile: AnalysisProfile,
                      user_id: Optional[int]) -> bool:
    """Add a current host edge (vial ↔ profile) if none exists. Returns True
    when a row was written. Never supersedes anything."""
    existing = db.execute(
        select(VialProfileAssignment).where(
            VialProfileAssignment.lims_sub_sample_pk == vial.id,
            VialProfileAssignment.analysis_profile_id == profile.id,
            VialProfileAssignment.superseded_at.is_(None),
        )
    ).scalars().first()
    if existing is not None:
        return False
    db.add(VialProfileAssignment(
        lims_sub_sample_pk=vial.id, analysis_profile_id=profile.id,
        relation="host", assigned_at=datetime.utcnow(), assigned_by_id=user_id,
    ))
    db.flush()
    return True


def _seed_members_on_vial(db: Session, *, vial: LimsSubSample, members: list[AnalysisService],
                          user_id: Optional[int]) -> int:
    """Seed exactly `members` on `vial` through the seeder's shared row builder
    (dedupe by live keyword; each row gets create_analysis's 'auto' transition).
    Bypasses seed_analyses_for_vial's role branching on purpose: we know the
    exact service list, and legacy roles (hplc/endo/ster) never take the
    catalog path there."""
    from lims_analyses.seeder import _seed_rows_from_services
    existing_kw = set(db.execute(
        select(LimsAnalysis.keyword).where(
            LimsAnalysis.lims_sub_sample_pk == vial.id,
            LimsAnalysis.review_state.notin_(DEAD_STATES),
        )
    ).scalars().all())
    rows = _seed_rows_from_services(
        db, sub_sample=vial, services=members, existing_kw=existing_kw,
        created_by_user_id=user_id, commit=False, log_event="manage_native_seeded",
    )
    return len(rows)


def add_profile_to_parent(db: Session, *, parent: LimsSample, profile: AnalysisProfile,
                          user_id: Optional[int]) -> dict:
    """Ruling A + P: put a native PROFILE on the sample. Mints the parent
    placeholders (idempotent), and for every existing vial whose role hosts
    the profile writes a host custody edge and seeds the members. No host
    vial → placeholders only (the role-flip union hook seeds later).
    Raises ProfileInactiveError / ProfileHasNoMembersError /
    ProfileNotNativeError / ProfileAlreadyOnSampleError. Caller commits."""
    members = _native_members(profile)
    live = _live_parent_service_ids(db, parent)
    if all(m.id in live for m in members):
        raise ProfileAlreadyOnSampleError(f"profile {profile.key!r} is already on {parent.sample_id}")

    reason = f"manage_analyses:add profile={profile.key}"
    stats = seed_parent_placeholders(
        db, parent=parent, services={profile.key: True},
        reason=reason, created_by_user_id=user_id,
    )

    hosts: list[dict] = []
    for vial in _host_vials(db, parent, profile):
        edge_created = _ensure_host_edge(db, vial=vial, profile=profile, user_id=user_id)
        n = _seed_members_on_vial(db, vial=vial, members=members, user_id=user_id)
        hosts.append({"vial_id": vial.sample_id, "edge_created": edge_created, "vial_rows_created": n})

    db.add(LimsSubSampleEvent(
        lims_sample_pk=parent.id, event="native_profile_added",
        details={
            "profile_key": profile.key, "profile_name": profile.name,
            "placeholders_created": stats["created"], "hosts": hosts,
        },
        user_id=user_id,
    ))
    db.flush()
    log.info("manage_native.profile_added parent=%s profile=%s placeholders=%s hosts=%s",
             parent.sample_id, profile.key, stats["created"], [h["vial_id"] for h in hosts])
    return {
        "profile_key": profile.key,
        "profile_name": profile.name,
        "placeholders_created": stats["created"],
        "placeholders_existing": stats["existing"],
        "hosts": hosts,
        "no_host_vial": not hosts,
    }


# ── write path: remove ───────────────────────────────────────────────────────

class PromotedResultExistsError(ConflictError):
    code = "promoted_result_exists"


class RemovalNeedsConfirm(Exception):
    """Worked vial rows would be rejected — the caller must confirm (412)."""

    def __init__(self, impact: dict):
        super().__init__("removal touches worked vial rows; confirm required")
        self.impact = impact


def _placeholder_row(db: Session, parent: LimsSample, analysis_id: int) -> LimsAnalysis:
    from lims_analyses.service import NotFoundError
    row = db.get(LimsAnalysis, analysis_id)
    if (row is None or row.lims_sample_pk != parent.id or row.lims_sub_sample_pk is not None
            or row.provenance != PROVENANCE_ORDERED or row.review_state in DEAD_STATES):
        raise NotFoundError(f"no live parent placeholder id={analysis_id} on {parent.sample_id}")
    return row


def _classify_vial_rows(db: Session, parent: LimsSample, service_id: int) -> dict:
    """Vial-tier rows for `service_id` on the parent's vials, bucketed like
    service.classify_removal_impact but keyed by SERVICE ID (S3-aligned):
    pristine (unassigned, no result, not retested, no promotion link, not a
    retest child) / worked_unverified (anything else live, including retest
    children) / blocked (promoted, i.e. a promotion link exists — the
    parent-tier canonical check upstream already 409s, this is defence).

    A retest CHILD (retest_of_id IS NOT NULL) is never pristine even though
    it is freshly 'unassigned' with no result: delete_pristine_analysis
    resolves its target by KEYWORD and filters retest_of_id IS NULL
    (service.py), so it always targets the lineage's ROOT row, never the
    child. Bucketing the child as pristine here would tell the pristine loop
    it deleted the child while delete_pristine_analysis actually inspected —
    and, since the root is worked, rejected with a misleading message — the
    root. Routing the child (and its root, which independently lands here
    via the worked_unverified branch below) into worked_unverified instead
    means the whole lineage is rejected via apply_transition, never deleted,
    and the pristine loop never touches a keyword with a live retest child."""
    from models import LimsAnalysisPromotion
    vials = {v.id: v for v in _vials_of(db, parent)}
    out = {"pristine": [], "worked_unverified": [], "blocked": []}
    if not vials:
        return out
    rows = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sub_sample_pk.in_(list(vials)),
            LimsAnalysis.analysis_service_id == service_id,
            LimsAnalysis.review_state.notin_(DEAD_STATES),
        )
    ).scalars().all()
    promoted_ids = set(db.execute(
        select(LimsAnalysisPromotion.source_analysis_id).where(
            LimsAnalysisPromotion.source_analysis_id.in_([r.id for r in rows] or [-1]))
    ).scalars().all())
    for r in rows:
        entry = {"sample_id": vials[r.lims_sub_sample_pk].sample_id, "analysis_id": r.id,
                 "review_state": r.review_state, "keyword": r.keyword}
        if r.id in promoted_ids or r.review_state in ("verified", "published", "promoted"):
            out["blocked"].append(entry)
        elif r.retest_of_id is not None:
            out["worked_unverified"].append(entry)
        elif r.review_state == "unassigned" and r.result_value is None and not r.retested:
            out["pristine"].append(entry)
        else:
            out["worked_unverified"].append(entry)
    return out


def _supersede_orphan_edges(db: Session, *, parent: LimsSample, service_id: int) -> int:
    """For every all-native profile containing `service_id`, on every vial of
    the parent that has a current edge for that profile: if NO live vial row
    of ANY member remains on that vial, stamp superseded_at. Returns count."""
    now = datetime.utcnow()
    n = 0
    profiles = [p for p in db.execute(select(AnalysisProfile)).scalars()
                if _is_all_native(p) and any(m.id == service_id for m in p.analysis_services)]
    for prof in profiles:
        member_ids = [m.id for m in prof.analysis_services]
        for vial in _vials_of(db, parent):
            edge = db.execute(select(VialProfileAssignment).where(
                VialProfileAssignment.lims_sub_sample_pk == vial.id,
                VialProfileAssignment.analysis_profile_id == prof.id,
                VialProfileAssignment.superseded_at.is_(None))).scalars().first()
            if edge is None:
                continue
            remaining = db.execute(select(LimsAnalysis.id).where(
                LimsAnalysis.lims_sub_sample_pk == vial.id,
                LimsAnalysis.analysis_service_id.in_(member_ids),
                LimsAnalysis.review_state.notin_(DEAD_STATES))).first()
            if remaining is None:
                edge.superseded_at = now
                n += 1
    db.flush()
    return n


def remove_parent_native_analysis(db: Session, *, parent: LimsSample, analysis_id: int,
                                  confirm: bool, user_id: Optional[int]) -> dict:
    """Ruling P (service-level remove) + R1 (soft remove). Order of operations:
    validate → 409 on a live canonical row → classify vial rows → 412 unless
    confirm when worked rows exist → delete pristine vial rows
    (delete_pristine_analysis, commits per row, writes the vial event first)
    → reject worked rows (apply_transition, commits per row) → supersede
    orphaned custody edges → soft-reject the placeholder → parent event →
    commit. The vial-tier primitives commit as they go (same as the SENAITE
    overlay's path); the placeholder flip is last so a mid-way failure leaves
    the parent row live and the action visibly incomplete, never the reverse."""
    from lims_analyses.service import (
        apply_transition, delete_pristine_analysis, soft_reject_parent_placeholder,
    )
    row = _placeholder_row(db, parent, analysis_id)
    service_id = row.analysis_service_id
    canonical_live = db.execute(select(LimsAnalysis.id).where(
        LimsAnalysis.lims_sample_pk == parent.id, LimsAnalysis.lims_sub_sample_pk.is_(None),
        LimsAnalysis.analysis_service_id == service_id, LimsAnalysis.provenance == "canonical",
        LimsAnalysis.review_state.notin_(DEAD_STATES))).first()
    if canonical_live is not None:
        raise PromotedResultExistsError(
            f"{row.keyword} has a promoted result on {parent.sample_id}; use retest/retract")

    impact = _classify_vial_rows(db, parent, service_id)
    if impact["blocked"]:
        raise PromotedResultExistsError(
            f"{row.keyword} has verified/promoted vial rows on {parent.sample_id}")
    if impact["worked_unverified"] and not confirm:
        raise RemovalNeedsConfirm(impact)

    vials = {v.id: v for v in _vials_of(db, parent)}
    deleted = 0
    for e in impact["pristine"]:
        vial = next(v for v in vials.values() if v.sample_id == e["sample_id"])
        delete_pristine_analysis(db, sub_sample_pk=vial.id, keyword=e["keyword"], user_id=user_id)
        deleted += 1
    rejected = 0
    for e in impact["worked_unverified"]:
        apply_transition(db, analysis_id=e["analysis_id"], kind="reject",
                         reason="manage_analyses:remove", user_id=user_id)
        rejected += 1

    superseded = _supersede_orphan_edges(db, parent=parent, service_id=service_id)
    soft_reject_parent_placeholder(db, row, reason="manage_analyses:remove", user_id=user_id)
    db.add(LimsSubSampleEvent(
        lims_sample_pk=parent.id, event="native_analysis_removed",
        details={"keyword": row.keyword, "analysis_service_id": service_id, "analysis_id": row.id,
                 "vial_rows_deleted": deleted, "vial_rows_rejected": rejected,
                 "edges_superseded": superseded},
        user_id=user_id,
    ))
    db.commit()
    log.info("manage_native.analysis_removed parent=%s keyword=%s deleted=%s rejected=%s edges=%s",
             parent.sample_id, row.keyword, deleted, rejected, superseded)
    return {"analysis_id": row.id, "keyword": row.keyword, "analysis_service_id": service_id,
            "vial_rows_deleted": deleted, "vial_rows_rejected": rejected, "edges_superseded": superseded}
