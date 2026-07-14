"""Native sample-transition recorder (spec §6.1-6.3) — append-only mirror of
SENAITE sample state, deduped across the three write sources ('mk1',
'senaite', 'reconcile'; 'is_seed' never dedups here, it's keyed purely on the
is_event_id partial unique for idempotent backfill re-runs).

Flush-only: this module never commits. Callers own the transaction —
`main._record_sample_transition_bg` (mk1 hooks) commits its own short-lived
session after the call returns; the future IS-stream sync and reconcile
callers (Tasks 4/5) will batch several inserts per commit.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models import LimsSample, LimsSampleTransition

# Dedup windows (spec §6.2/§6.3), measured relative to the INCOMING row's
# occurred_at (not wall-clock now()) — deterministic and matches the fact
# that reconcile/senaite callers always pass a real or near-now occurred_at.
SENAITE_DEDUP_WINDOW = timedelta(minutes=5)
RECONCILE_DEDUP_WINDOW = timedelta(minutes=60)

# States that may be WRITTEN into lims_samples.status by a heal (2026-07-14
# inbox-desync fix, RC3). The column holds SENAITE review_state vocabulary
# everywhere else (_populate_basic_info writes meta review_state verbatim), so
# heals must never introduce the IS event stream's WP order-progress
# vocabulary ('analyzing', 'under_review', 'complete' — status_service.py's
# OrderStatus enum): 'analyzing' rides every worksheet_assigned event while
# SENAITE's review_state hasn't moved at all. Derived from the workflow
# catalog's sample-scope seeds (the canonical state list) plus two real
# SENAITE sample states the catalog doesn't carry yet.
from workflow.seeds import SEED_STATES

SAMPLE_REVIEW_STATE_WHITELIST: frozenset[str] = frozenset(
    slug for (scope, slug, *_rest) in SEED_STATES if scope == "sample"
) | {"rejected", "stored"}


def heal_sample_status(db: Session, sample_id: str, to_status: str) -> bool:
    """Guarded write of lims_samples.status (the registry mirror of SENAITE's
    review_state). Returns True iff the column was changed. Guards:

      - vocabulary: only SAMPLE_REVIEW_STATE_WHITELIST members are ever
        written (RC3 — IS order-progress vocab must not poison the column);
      - existence: unknown sample_id is a no-op (False);
      - idempotence: an already-matching status is a no-op (False).

    Flush-only, never commits — same transaction contract as
    record_sample_transition; callers own the commit."""
    if to_status not in SAMPLE_REVIEW_STATE_WHITELIST:
        return False
    row = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if row is None or row.status == to_status:
        return False
    row.status = to_status
    db.flush()
    return True


def _explained(db: Session, *, lims_sample_pk: int, source: str,
               verb: str | None, to_status: str, occurred_at: datetime) -> bool:
    """True when an existing row already accounts for this transition per the
    source-specific dedup rule. Only 'senaite' and 'reconcile' dedup; 'mk1'
    and 'is_seed' always insert (subject only to the is_event_id unique)."""
    if source == "senaite":
        lo, hi = occurred_at - SENAITE_DEDUP_WINDOW, occurred_at + SENAITE_DEDUP_WINDOW
        return db.execute(
            select(LimsSampleTransition.id).where(
                LimsSampleTransition.lims_sample_pk == lims_sample_pk,
                LimsSampleTransition.source == "mk1",
                LimsSampleTransition.verb == verb,
                LimsSampleTransition.occurred_at >= lo,
                LimsSampleTransition.occurred_at <= hi,
            ).limit(1)
        ).first() is not None
    if source == "reconcile":
        lo = occurred_at - RECONCILE_DEDUP_WINDOW
        return db.execute(
            select(LimsSampleTransition.id).where(
                LimsSampleTransition.lims_sample_pk == lims_sample_pk,
                LimsSampleTransition.to_status == to_status,
                LimsSampleTransition.occurred_at >= lo,
                LimsSampleTransition.occurred_at <= occurred_at,
            ).limit(1)
        ).first() is not None
    return False


def record_sample_transition(
    db: Session, *, sample_id: str, to_status: str, source: str,
    verb: str | None = None, from_status: str | None = None,
    actor_user_id: int | None = None, occurred_at: datetime | None = None,
    is_event_id: str | None = None,
) -> bool:
    """Append one row to lims_sample_transitions.

    Resolves `sample_id` (the lims_samples.sample_id string) to its PK;
    returns False if unknown. Flushes only — never commits; the caller owns
    the transaction. Returns False on any skip: unknown sample,
    source-specific dedup match (§6.2/§6.3), or an is_event_id collision.

    The insert runs inside a SAVEPOINT (`db.begin_nested()`) so a colliding
    is_event_id (IntegrityError on the partial unique index) rolls back only
    itself — never the caller's outer transaction/session.
    """
    lims_sample_pk = db.execute(
        select(LimsSample.id).where(LimsSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if lims_sample_pk is None:
        return False

    occurred_at = occurred_at or datetime.utcnow()

    if _explained(db, lims_sample_pk=lims_sample_pk, source=source, verb=verb,
                  to_status=to_status, occurred_at=occurred_at):
        return False

    try:
        with db.begin_nested():
            db.add(LimsSampleTransition(
                lims_sample_pk=lims_sample_pk, verb=verb, from_status=from_status,
                to_status=to_status, source=source, actor_user_id=actor_user_id,
                occurred_at=occurred_at, is_event_id=is_event_id,
            ))
            db.flush()
    except IntegrityError:
        return False
    return True
