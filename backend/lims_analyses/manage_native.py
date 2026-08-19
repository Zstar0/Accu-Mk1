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
