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


def _pending_row(db: Session, sample: LimsSample, verb: str) -> Optional[LimsSenaiteTeeRetry]:
    return db.execute(
        select(LimsSenaiteTeeRetry).where(
            LimsSenaiteTeeRetry.lims_sample_pk == sample.id,
            LimsSenaiteTeeRetry.verb == verb,
            LimsSenaiteTeeRetry.status == "pending",
        )
    ).scalars().first()


def enqueue_retry(db: Session, sample: LimsSample, verb: str, *, error: str,
                  now: Optional[datetime] = None) -> LimsSenaiteTeeRetry:
    """One pending row per (sample, verb); a repeat refusal bumps attempts
    and reschedules per BACKOFF_MINUTES. Flush-only."""
    t = _now(now)
    row = _pending_row(db, sample, verb)
    if row is None:
        row = LimsSenaiteTeeRetry(lims_sample_pk=sample.id, verb=verb,
                                  expected_state=EXPECTED_AR_STATES[verb],
                                  attempts=0, next_attempt_at=t)
        db.add(row)
    row.attempts += 1
    row.last_error = (error or "")[:1000]
    if row.attempts >= MAX_ATTEMPTS:
        row.status = "gave_up"
    else:
        row.next_attempt_at = t + timedelta(minutes=BACKOFF_MINUTES[row.attempts - 1])
    db.flush()
    return row


def _mark_senaite_only(db: Session, sample: LimsSample, verb: str, *, note: str,
                       now: Optional[datetime] = None) -> LimsSenaiteTeeRetry:
    row = _pending_row(db, sample, verb) or LimsSenaiteTeeRetry(
        lims_sample_pk=sample.id, verb=verb, expected_state=EXPECTED_AR_STATES[verb],
        attempts=0, next_attempt_at=_now(now))
    row.status = "senaite_only"
    row.last_error = note[:1000]
    db.add(row)
    db.flush()
    return row


def tee_now(db: Session, sample: LimsSample, verb: str, *,
            now: Optional[datetime] = None) -> str:
    """Tee `verb` to SENAITE and prove it. Returns 'done' | 'pending' |
    'senaite_only' | 'skipped'. Never raises."""
    if verb not in EXPECTED_AR_STATES:
        return "skipped"
    uid = (sample.external_lims_uid or "").strip()
    if not uid:
        return "skipped"
    expected = EXPECTED_AR_STATES[verb]
    try:
        if verb == "cancel":
            current = read_back_state(sample)
            if current == "cancelled":
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
        row = _pending_row(db, sample, verb)
        if row is not None:
            row.status = "done"
            db.flush()
        return "done"
    enqueue_retry(db, sample, verb, now=now,
                  error=f"read-back {actual!r} != expected {expected!r}")
    return "pending"
