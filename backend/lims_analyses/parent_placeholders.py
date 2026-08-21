"""Registration-time parent-tier placeholders for ORDERED native analyses.

The native sibling of `_shadow_analyses_at_registration_bg` (main.py): a
sample that has just been registered has no vials and no roles, so
`seed_analyses_for_vial` has not run and the parent tier is silent about
tests the customer has already paid for.

SENAITE services solve this with a `provenance='shadow'` row minted at
registration, which coexists with the later `provenance='canonical'`
promoted row under a *different* partial unique index. Native services
never got that first row. This module mints it under a THIRD provenance.

Why a third value and not 'shadow':
  - 'shadow' means "mirrored from SENAITE" and carries `mirror_review_state`;
    an origin='mk1' row in that namespace is a contradiction.
  - workflow/engine.py branches `if canonical / elif shadow` with NO else,
    so an unknown provenance is silently ignored — the sample-scope state
    gates are unperturbed BY CONSTRUCTION rather than by accident.

Why never 'canonical': that is the slot `promote_to_parent` inserts into
(uq_lims_analyses_parent_service_root). Keeping placeholders out of it is
what lets promote stay completely untouched.
"""
from __future__ import annotations

PROVENANCE_ORDERED = "ordered"


def seed_parent_placeholders(db, *, parent, services: dict, package=None) -> dict:
    """Mint a pending parent-tier row per ORDERED native analysis service.

    Idempotent: relies on uq_lims_analyses_parent_service_ordered, and also
    checks first so a re-run reports `existing` rather than raising.

    Only native (origin='mk1') services are placeheld — SENAITE-sourced ones
    already get their 'shadow' row from the registration mirror.

    Calls _ordered_native_profiles with require_archetype=False: a profile's
    coa_archetype governs whether a COA section can be RENDERED, not whether
    the customer paid for the test. A native profile that is ordered but has
    no archetype configured yet must still surface on the bench — deferring
    to the archetype gate here would reintroduce the exact invisibility this
    feature exists to remove.
    """
    from models import LimsAnalysis
    from coa.native_sections import _ordered_native_profiles

    stats = {"created": 0, "existing": 0, "skipped": 0}
    profiles = _ordered_native_profiles(db, services or {}, package,
                                        require_archetype=False)

    for prof in profiles:
        for svc in prof.analysis_services:
            if (getattr(svc, "origin", None) or "") != "mk1":
                stats["skipped"] += 1
                continue
            exists = db.query(LimsAnalysis).filter_by(
                lims_sample_pk=parent.id,
                analysis_service_id=svc.id,
                provenance=PROVENANCE_ORDERED,
            ).first()
            if exists is not None:
                stats["existing"] += 1
                continue
            db.add(LimsAnalysis(
                lims_sample_pk=parent.id,
                lims_sub_sample_pk=None,
                analysis_service_id=svc.id,
                keyword=svc.keyword,
                title=svc.title,
                result_value=None,
                review_state="unassigned",
                provenance=PROVENANCE_ORDERED,
            ))
            stats["created"] += 1
    return stats
