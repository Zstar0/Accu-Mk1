"""SENAITE tee with read-back and retry (spec §5).

Every native sample transition SENAITE can represent is teed here, then
PROVEN by re-reading the AR — SENAITE returns HTTP 200 for transitions it
silently refuses, and its JSON `transitions` list is empty even when a
transition is allowed, so neither is evidence. On mismatch or transport
error the transition becomes ONE pending `lims_senaite_tee_retries` row
(unique per sample+verb while pending) drained by `run_retries` (Task 8).
The user's request never waits on, or fails over, the tee.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import LimsSample, LimsSenaiteTeeRetry

log = logging.getLogger(__name__)

EXPECTED_AR_STATES = {
    "receive": "sample_received",
    "verify": "verified",
    "publish": "published",
    "cancel": "cancelled",
}
# SENAITE forbids `cancel` once verified/published; a cancel teed from there
# is a documented SENAITE-only divergence, not a retry.
SENAITE_CANCELLABLE_STATES = frozenset({
    "sample_registered", "sample_due", "sample_received", "to_be_verified",
    "waiting_for_addon_results", "ready_for_initial_review",
})
BACKOFF_MINUTES = (5, 15, 45, 180, 720, 720, 720, 720)
MAX_ATTEMPTS = len(BACKOFF_MINUTES)


def _now(now: Optional[datetime]) -> datetime:
    return now or datetime.now(timezone.utc)


def _ar_transition(uid: str, verb: str) -> None:
    """POST update/{uid} {"transition": verb}. Patched in tests."""
    from lims_analyses.senaite_writeback import _update
    _update(uid, {"transition": verb})


def read_back_state(sample: LimsSample) -> str:
    """The AR's live review_state (the only proof). Patched in tests."""
    from sub_samples.senaite import fetch_parent_metadata
    meta = fetch_parent_metadata(sample.sample_id)
    return str(meta.get("review_state") or "")


def _row_for(db: Session, sample: LimsSample, verb: str) -> Optional[LimsSenaiteTeeRetry]:
    """The LATEST tee-retry row for this (sample, verb), in any status."""
    return db.execute(
        select(LimsSenaiteTeeRetry).where(
            LimsSenaiteTeeRetry.lims_sample_pk == sample.id,
            LimsSenaiteTeeRetry.verb == verb,
        ).order_by(LimsSenaiteTeeRetry.id.desc())
    ).scalars().first()


def _resolve_done(db: Session, sample: LimsSample, verb: str) -> None:
    """Resolve any non-done row for (sample, verb) to 'done'. Flush-only."""
    row = _row_for(db, sample, verb)
    if row is not None and row.status != "done":
        row.status = "done"
        db.flush()


def enqueue_retry(db: Session, sample: LimsSample, verb: str, *, error: str,
                  now: Optional[datetime] = None) -> LimsSenaiteTeeRetry:
    """One row per (sample, verb), regardless of status. A pending row's
    attempts bump and reschedule per BACKOFF_MINUTES; a row parked in
    done/gave_up/senaite_only is REVIVED (attempts reset to 0) before the
    same bump/backoff is applied. Flush-only."""
    t = _now(now)
    row = _row_for(db, sample, verb)
    created = row is None
    revived = False
    if row is None:
        row = LimsSenaiteTeeRetry(lims_sample_pk=sample.id, verb=verb,
                                  expected_state=EXPECTED_AR_STATES[verb],
                                  attempts=0, next_attempt_at=t)
        db.add(row)
    elif row.status != "pending":
        revived = True
        row.status = "pending"
        row.attempts = 0
    row.attempts += 1
    row.last_error = (error or "")[:1000]
    if row.attempts >= MAX_ATTEMPTS:
        row.status = "gave_up"
    else:
        row.status = "pending"
        row.next_attempt_at = t + timedelta(minutes=BACKOFF_MINUTES[row.attempts - 1])
    db.flush()
    if created or revived:
        log.warning("senaite_tee.enqueued sample=%s verb=%s attempts=%s error=%s",
                    sample.sample_id, verb, row.attempts, row.last_error)
    return row


def _mark_senaite_only(db: Session, sample: LimsSample, verb: str, *, note: str,
                       now: Optional[datetime] = None) -> LimsSenaiteTeeRetry:
    row = _row_for(db, sample, verb) or LimsSenaiteTeeRetry(
        lims_sample_pk=sample.id, verb=verb, expected_state=EXPECTED_AR_STATES[verb],
        attempts=0, next_attempt_at=_now(now))
    row.status = "senaite_only"
    row.last_error = (note or "")[:1000]
    db.add(row)
    db.flush()
    return row


def tee_now(db: Session, sample: LimsSample, verb: str, *,
            now: Optional[datetime] = None) -> str:
    """Tee `verb` to SENAITE and prove it. Returns 'done' | 'pending' |
    'senaite_only' | 'skipped' | 'error'. 'error' means the transition/
    read-back itself may have succeeded but this call's own bookkeeping
    (enqueue/resolve) raised — never propagated to the caller. Never
    raises; flush-only (does not roll back the caller's session/transaction
    on 'error' — that's the caller's to own)."""
    if verb not in EXPECTED_AR_STATES:
        return "skipped"
    uid = (sample.external_lims_uid or "").strip()
    if not uid:
        return "skipped"
    expected = EXPECTED_AR_STATES[verb]
    try:
        try:
            if verb == "cancel":
                current = read_back_state(sample)
                if current == "cancelled":
                    _resolve_done(db, sample, verb)
                    return "done"
                if current not in SENAITE_CANCELLABLE_STATES:
                    _mark_senaite_only(db, sample, verb, now=now,
                                       note=f"SENAITE forbids cancel from {current!r}")
                    return "senaite_only"
            _ar_transition(uid, verb)
            actual = read_back_state(sample)
        except Exception as e:  # transport, auth, parse — all retryable
            enqueue_retry(db, sample, verb, error=f"{type(e).__name__}: {e}", now=now)
            return "pending"
        if actual == expected:
            _resolve_done(db, sample, verb)
            return "done"
        enqueue_retry(db, sample, verb, now=now,
                      error=f"read-back {actual!r} != expected {expected!r}")
        return "pending"
    except Exception:
        log.exception("senaite_tee.tee_now failed sample=%s verb=%s", sample.sample_id, verb)
        return "error"


def _attempt(db: Session, sample: LimsSample, row: LimsSenaiteTeeRetry, *,
             now: Optional[datetime]) -> str:
    """One retry attempt for a pending row. Returns the row's new status."""
    uid = (sample.external_lims_uid or "").strip()
    expected = row.expected_state
    try:
        if row.verb == "publish":
            # PB-0462 rule: SENAITE refuses publish while the AR is unverified
            # (its own auto-verify miscounts once an analysis was rejected).
            current = read_back_state(sample)
            if current == "to_be_verified":
                _ar_transition(uid, "verify")
                current = read_back_state(sample)
                if current != "verified":
                    enqueue_retry(db, sample, row.verb, now=now,
                                  error=f"verify-before-publish read-back {current!r}")
                    return row.status
        _ar_transition(uid, row.verb)
        actual = read_back_state(sample)
    except Exception as e:
        enqueue_retry(db, sample, row.verb, error=f"{type(e).__name__}: {e}", now=now)
        return row.status
    if actual == expected:
        row.status = "done"
        db.flush()
        return "done"
    enqueue_retry(db, sample, row.verb, now=now,
                  error=f"read-back {actual!r} != expected {expected!r}")
    return row.status


def run_retries(db: Session, *, now: Optional[datetime] = None, batch: int = 50) -> dict:
    """Scheduler job body (registered as `senaite_tee_retry`, every 5 min):
    drain due pending rows. Never raises past a single row; caller commits.

    Each row's processing runs inside its own SAVEPOINT (`db.begin_nested()`,
    same idiom as `workflow.sample_log.record_sample_transition`). On
    Postgres a failed statement aborts the enclosing transaction until it's
    rolled back — without a savepoint, one bad row would turn every later
    statement in the batch into an `errors` count too. The savepoint scopes
    the damage to just that row; the outer transaction (and the rest of the
    batch) stays usable."""
    t = _now(now)
    stats = {"retried": 0, "done": 0, "gave_up": 0, "superseded": 0, "errors": 0}
    due = db.execute(
        select(LimsSenaiteTeeRetry).where(
            LimsSenaiteTeeRetry.status == "pending",
            LimsSenaiteTeeRetry.next_attempt_at <= t,
        ).order_by(LimsSenaiteTeeRetry.next_attempt_at).limit(batch)
    ).scalars().all()
    for row in due:
        try:
            with db.begin_nested():
                sample = db.get(LimsSample, row.lims_sample_pk)
                if sample is None:
                    row.status = "done"
                    stats["superseded"] += 1
                    continue
                # A later native state wins: never push SENAITE somewhere
                # Mk1 has left. `native_status` is the engine's OWN column;
                # `status` is SENAITE's mirror, which lags under senaite
                # authority (today's default) — exactly while a retry row
                # is pending. Fall back to `status` only when native_status
                # was never seeded (NULL, side-by-side engine not yet run).
                native = sample.native_status if sample.native_status is not None else sample.status
                if native != row.expected_state:
                    row.status = "done"
                    row.last_error = f"superseded: native status is {native!r}"
                    stats["superseded"] += 1
                    continue
                stats["retried"] += 1
                new_status = _attempt(db, sample, row, now=now)
                if new_status == "done":
                    stats["done"] += 1
                elif new_status == "gave_up":
                    stats["gave_up"] += 1
        except Exception:
            log.exception("senaite_tee.retry_failed row=%s", row.id)
            stats["errors"] += 1
        db.flush()
    log.info("senaite_tee.run_retries %s", stats)
    return stats


def gave_up_count(db: Session) -> int:
    from sqlalchemy import func
    return int(db.execute(
        select(func.count()).select_from(LimsSenaiteTeeRetry).where(
            LimsSenaiteTeeRetry.status == "gave_up")
    ).scalar() or 0)
