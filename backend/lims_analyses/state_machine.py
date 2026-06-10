"""
Pure state-machine for lims_analyses. No DB, no I/O — just the
allowed-transitions table, a tier discriminator, and validators.

States and transitions mirror SENAITE's vocabulary so the existing UI
palette + transition handlers in AnalysisTable.tsx work unchanged when
the result-entry hooks swap to the Mk1 endpoint.

Tier discrimination: rows belong to one of two tiers per the spec
(spec §"Two tiers, two roles"). The state machine is shared but the
legal-from-state-x transitions DIFFER per tier:

  vial-tier (run): lims_sub_sample_pk set OR lims_sample_pk set with
                   the parent acting as a vial in a variance set.
                   These represent bench data — runs that happen and
                   produce results. Lifecycle:
                     unassigned → assigned → to_be_verified → promoted
                   plus reset, retract, reject.
                   CANNOT self-verify or publish — bench rows are promoted to
                   parent-tier by promote_to_parent, which creates a 'verified'
                   parent-tier row; the source sub-sample moves to 'promoted'.

  parent-tier (canonical): lims_sample_pk set with the row NOT being
                   a vial-tier run. These are created by the future
                   promote_to_parent service (Phase 4) in 'verified'
                   state directly. Lifecycle:
                     verified → published
                   plus admin retract.
                   CANNOT assign/submit — bench data is at the vial tier.

Phase 1 ships the discriminator + the tier_allows() matrix; promote_to_parent
that actually creates parent-tier rows lands in Phase 4.

Decision flow per kind (vial-tier):
  assign:   unassigned -> assigned
  submit:   assigned -> to_be_verified         (requires result_value)
            unassigned -> to_be_verified       (autoEdit shortcut from UI)
  retract:  to_be_verified -> retracted
  reject:   unassigned -> rejected
            assigned -> rejected
            to_be_verified -> rejected
  reset:    assigned -> unassigned             (clear without saving)
  variance_verify: to_be_verified -> variance_verified   (variance replicate
            sign-off; requires result_value + sub-sample host + host vial
            assignment_kind='variance' — service-layer guards)

Decision flow per kind (parent-tier):
  publish:  verified -> published
  retract:  verified -> retracted              (admin override)

Cross-tier:
  auto:     reserved for system-driven transitions (audit-only writes
            like reportable flip). Allowed from any non-terminal state
            to itself, both tiers.
  retest:   (creates a NEW analysis row pointing at the old one via
             retest_of_id; not a transition on the old row. Service-
             layer concern, not a state machine edge.)

Terminal states: rejected, published. ('promoted' is a non-terminal
sub-sample resting state — retest is still legal from it at the service layer.)
"""

from __future__ import annotations

from typing import Dict, FrozenSet, Optional, Tuple


# ─── State + kind constants ──────────────────────────────────────────────────

STATES: FrozenSet[str] = frozenset({
    "unassigned",
    "assigned",
    "to_be_verified",
    "verified",
    "published",
    "promoted",
    "variance_verified",
    "rejected",
    "retracted",
})

TERMINAL_STATES: FrozenSet[str] = frozenset({"published", "rejected"})

TRANSITION_KINDS: FrozenSet[str] = frozenset({
    "assign", "submit", "verify", "retract", "reject",
    "retest", "publish", "reset", "auto", "variance_verify",
})

# Tier discriminator constants. Service layer reads these.
TIER_VIAL = "vial"
TIER_PARENT = "parent"
TIERS: FrozenSet[str] = frozenset({TIER_VIAL, TIER_PARENT})


# ─── Allowed-transitions table ───────────────────────────────────────────────
# (from_state, kind) -> to_state

_ALLOWED: Dict[Tuple[str, str], str] = {
    ("unassigned",     "assign"):   "assigned",
    ("unassigned",     "submit"):   "to_be_verified",
    ("unassigned",     "reject"):   "rejected",

    ("assigned",       "submit"):   "to_be_verified",
    ("assigned",       "reject"):   "rejected",
    ("assigned",       "reset"):    "unassigned",

    ("to_be_verified", "verify"):           "verified",
    ("to_be_verified", "variance_verify"):  "variance_verified",
    ("to_be_verified", "retract"):          "retracted",
    ("to_be_verified", "reject"):           "rejected",

    ("verified",       "publish"):  "published",
    ("verified",       "retract"):  "retracted",
}

# Tier × kind matrix. Sub-sample (vial) rows do bench work (assign through
# to_be_verified, plus retract/reject/reset/retest); they NEVER self-verify —
# verification is promotion (promote_to_parent moves the source to 'promoted').
# 'verify'/'publish' are parent-tier concerns; parent rows are created in
# 'verified' by promote and only publish or admin-retract from there.
_TIER_ALLOWED_KINDS: Dict[str, FrozenSet[str]] = {
    TIER_VIAL: frozenset({
        "assign", "submit", "retract", "reject", "reset", "retest", "auto",
        "variance_verify",
    }),
    TIER_PARENT: frozenset({
        "publish", "retract", "auto",
    }),
}


# ─── Public API ──────────────────────────────────────────────────────────────


class InvalidTransitionError(ValueError):
    """Raised when a transition kind is not allowed from the current state."""

    def __init__(self, from_state: str, kind: str, message: Optional[str] = None):
        self.from_state = from_state
        self.kind = kind
        super().__init__(
            message or f"transition {kind!r} is not allowed from state {from_state!r}"
        )


class TierMismatchError(ValueError):
    """Raised when a transition kind is not allowed at the row's tier."""

    def __init__(self, tier: str, kind: str, message: Optional[str] = None):
        self.tier = tier
        self.kind = kind
        super().__init__(
            message or f"transition {kind!r} is not allowed at tier {tier!r}"
        )


class UnknownStateError(ValueError):
    """Raised when an unknown state is supplied."""


class UnknownKindError(ValueError):
    """Raised when an unknown transition kind is supplied."""


class UnknownTierError(ValueError):
    """Raised when an unknown tier is supplied."""


def tier_of(*, lims_sample_pk: Optional[int],
            lims_sub_sample_pk: Optional[int],
            review_state: str) -> str:
    """
    Discriminate a row's tier from its host FKs + state.

    Vial-tier: lims_sub_sample_pk set (always vial), OR lims_sample_pk
        set with the row currently in unassigned/assigned/to_be_verified
        (the parent acting as a vial in a variance set, mid-run).
    Parent-tier: lims_sample_pk set with the row in verified/published
        (canonical chosen result, created by promote_to_parent).

    Edge: a parent-attached row in retracted is parent-tier — it was
    promoted then retracted by admin. A vial-attached row in retracted/
    rejected is vial-tier (the run failed/was abandoned).
    """
    if (lims_sample_pk is None) == (lims_sub_sample_pk is None):
        raise ValueError(
            "tier_of() requires exactly one of lims_sample_pk / lims_sub_sample_pk"
        )
    if lims_sub_sample_pk is not None:
        return TIER_VIAL
    # Parent-attached. State decides whether it's a vial-style run or canonical.
    # 'promoted' is a sub-sample-tier state only (promote sets it on the source
    # sub-sample), so it correctly falls through to TIER_VIAL below.
    if review_state in ("verified", "published", "retracted"):
        return TIER_PARENT
    return TIER_VIAL


def tier_allows(tier: str, kind: str) -> bool:
    """True iff the kind is legal at the tier (independent of from_state)."""
    if tier not in TIERS:
        raise UnknownTierError(tier)
    if kind not in TRANSITION_KINDS:
        raise UnknownKindError(kind)
    return kind in _TIER_ALLOWED_KINDS[tier]


def allowed_kinds(from_state: str, tier: Optional[str] = None) -> FrozenSet[str]:
    """Return the set of transition kinds legal from this state.

    If `tier` is provided, intersect with the tier's allowed kinds so the
    caller sees only transitions that are simultaneously legal for the
    state machine AND the tier.
    """
    if from_state not in STATES:
        raise UnknownStateError(from_state)
    sm_legal = frozenset(k for (s, k) in _ALLOWED if s == from_state)
    if tier is None:
        return sm_legal
    if tier not in TIERS:
        raise UnknownTierError(tier)
    return frozenset(sm_legal & _TIER_ALLOWED_KINDS[tier])


def next_state(from_state: str, kind: str, tier: Optional[str] = None) -> str:
    """
    Apply a transition. Returns the new state. Raises:
      UnknownStateError / UnknownKindError / UnknownTierError on bad inputs.
      TierMismatchError when `tier` is provided and the kind isn't legal at it.
      InvalidTransitionError when the (from_state, kind) pair isn't in the table.
    """
    if from_state not in STATES:
        raise UnknownStateError(from_state)
    if kind not in TRANSITION_KINDS:
        raise UnknownKindError(kind)
    if tier is not None:
        if tier not in TIERS:
            raise UnknownTierError(tier)
        if kind not in _TIER_ALLOWED_KINDS[tier]:
            raise TierMismatchError(tier, kind)
    try:
        return _ALLOWED[(from_state, kind)]
    except KeyError:
        raise InvalidTransitionError(from_state, kind)


def is_terminal(state: str) -> bool:
    """True iff the state is terminal (no transitions out)."""
    if state not in STATES:
        raise UnknownStateError(state)
    return state in TERMINAL_STATES
