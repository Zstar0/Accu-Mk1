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
