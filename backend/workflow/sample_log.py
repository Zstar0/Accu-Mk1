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
