"""IS event-stream incremental sync (spec §7) — the ONLY IS→Mk1 puller.

Pulls `sample_status_events` rows out of the Integration Service database
(read-only, via `integration_db.get_integration_db()`) and appends them to
the native sample-transition log (`workflow.sample_log.record_sample_transition`,
source="senaite"). This is the single place data flows from IS into Mk1's
workflow history today. Freshly-inserted rows also heal the sample's `status`
column in the same batch transaction (log-and-heal, `_heal_status`) so the
mirror doesn't sit visibly behind SENAITE until the next display-fetch
reconcile.

COLD-START SEMANTICS: sync starts at now. The first tick after boot, when no
cursor row exists yet, initializes the cursor to `datetime.now(timezone.utc)`
and returns immediately without fetching — it deliberately does NOT walk IS
history from epoch. A full first sweep would replay all of IS history as if
it were live traffic and mislabel it source='senaite'; that history properly
belongs to the one-time seed backfill
(`scripts/backfill_sample_transitions_from_is.py`, source='is_seed' — spec
§6.5). Run the seed backfill separately for history; this stream only ever
carries events going forward from first boot.

RETIREMENT CONTRACT: when the direction inverts — Mk1 becomes the
authoritative LIMS and starts feeding IS instead of the reverse, near the
SENAITE disconnect — this module is deleted wholesale, in full. It is kept
fully self-contained on purpose (only `workflow.sample_log`, `integration_db`,
and the ORM models it needs for its own cursor/lookup) so that deletion is a
one-file operation with no tendrils elsewhere to chase down.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from integration_db import get_connection_config, get_integration_db
from models import LimsSample, LimsWorkflowSyncState
from workflow.sample_log import record_sample_transition

logger = logging.getLogger(__name__)

CURSOR_NAME = "is_sample_events"

_FETCH_EVENTS_SQL = """
    SELECT id, sample_id, transition, new_status, event_id,
           event_timestamp, created_at
    FROM sample_status_events
    WHERE created_at > %s
    ORDER BY created_at ASC
    LIMIT %s
"""


def _fetch_events(cursor_dt: datetime, batch_size: int) -> list[dict]:
    """Query IS `sample_status_events` created after `cursor_dt`, ascending,
    capped at `batch_size`. Extracted as its own function so `sync_once`'s
    orchestration (cursor math, recorder calls, commit/advance ordering) can
    be tested without a live IS connection — tests patch this function
    directly."""
    from psycopg2.extras import RealDictCursor

    with get_integration_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(_FETCH_EVENTS_SQL, [cursor_dt, batch_size])
            return [dict(row) for row in cur.fetchall()]


def _occurred_at(ev: dict) -> datetime:
    """Naive UTC — matches the recorder's own dedup-window comparisons and
    the LimsSampleTransition.occurred_at column (untimezoned)."""
    ts = ev.get("event_timestamp")
    if ts is not None:
        return datetime.utcfromtimestamp(ts)
    created = ev["created_at"]
    if created.tzinfo is not None:
        return created.astimezone(timezone.utc).replace(tzinfo=None)
    return created


def _heal_status(db: Session, sample_pk: int, new_status: str,
                 occurred_at: Optional[datetime], stats: dict) -> None:
    """Log-and-heal: a freshly-INSERTED senaite row means SENAITE just moved
    this sample, so mirror the status column immediately instead of waiting
    for the next display-fetch reconcile (kills the registry-inspect
    "log ahead of status" window). Two guards keep this strictly a mirror:

      - dup rows never heal (the transition was already accounted for);
        callers only invoke this when the recorder inserted.
      - an event older than the sample's last SENAITE snapshot
        (last_synced_at) never heals — a catch-up backlog after sync downtime
        must not regress a status a fresher reconcile already wrote.
      - non-SENAITE vocabulary never heals (2026-07-14 inbox-desync RC3): IS
        events carry WP order-progress statuses for some verbs
        (worksheet_assigned -> 'analyzing') that are NOT review_states;
        writing them poisons a column every read surface compares against
        SENAITE vocabulary. The transition LOG still records the raw event —
        only the status-column write is gated.

    Heal failure never breaks the sync loop (same contract as the recorder)."""
    from workflow.sample_log import SAMPLE_REVIEW_STATE_WHITELIST
    try:
        if new_status not in SAMPLE_REVIEW_STATE_WHITELIST:
            return
        sample = db.get(LimsSample, sample_pk)
        if sample is None or not new_status or sample.status == new_status:
            return
        last_synced = sample.last_synced_at
        if (last_synced is not None and occurred_at is not None
                and occurred_at < last_synced):
            return
        sample.status = new_status
        stats["healed"] += 1
    except Exception as e:
        logger.warning("workflow.is_sync_heal_failed sample_pk=%s err=%s",
                       sample_pk, e)
        stats["errors"] += 1


def sync_once(db_factory: Callable[[], Session], *, batch_size: int = 500,
              overlap_minutes: int = 10) -> dict:
    """One incremental pull: read the cursor, fetch IS events since
    cursor - overlap, append each to the sample-transition log, commit the
    batch, then advance the cursor to the max `created_at` seen — ONLY after
    that batch commit succeeds. A missing cursor row (cold start) is NOT
    treated as epoch: it's initialized to now() and persisted immediately,
    and this tick returns with fetched=0 — no IS history is walked or
    replayed here (see module docstring's COLD-START SEMANTICS; the seed
    backfill script owns history). Safe to call repeatedly: the recorder's
    own dedup rules plus the is_event_id partial unique make re-processing
    the overlap window idempotent.

    Returns stats: {"fetched", "inserted", "dup", "no_sample", "healed",
    "errors"}. "no_sample" and "dup" are both
    `record_sample_transition() -> False` outcomes, disambiguated here by a
    cheap existence check up front (the recorder itself doesn't distinguish
    "unknown sample" from "dedup skip"). "healed" counts status-column writes
    made by `_heal_status` for freshly-inserted rows (log-and-heal).
    """
    stats = {"fetched": 0, "inserted": 0, "dup": 0, "no_sample": 0,
             "healed": 0, "errors": 0}
    db = db_factory()
    try:
        cursor_row = db.execute(
            select(LimsWorkflowSyncState).where(LimsWorkflowSyncState.name == CURSOR_NAME)
        ).scalar_one_or_none()

        if cursor_row is None:
            # Cold start: anchor the cursor at now and stop. Do NOT fetch —
            # a first-boot epoch walk would mislabel all of IS history as
            # live 'senaite' traffic. The seed backfill script owns history.
            cursor_row = LimsWorkflowSyncState(
                name=CURSOR_NAME, cursor_created_at=datetime.now(timezone.utc)
            )
            db.add(cursor_row)
            db.commit()
            return stats

        cursor_dt = cursor_row.cursor_created_at
        query_from = cursor_dt - timedelta(minutes=overlap_minutes)

        try:
            events = _fetch_events(query_from, batch_size)
        except Exception as e:
            logger.warning("workflow.is_sync_fetch_failed err=%s", e)
            stats["errors"] += 1
            db.rollback()
            return stats

        stats["fetched"] = len(events)
        if not events:
            return stats

        max_created_at = cursor_dt
        for ev in events:
            created_at = ev["created_at"]
            if created_at > max_created_at:
                max_created_at = created_at
            try:
                sample_pk = db.execute(
                    select(LimsSample.id).where(LimsSample.sample_id == ev["sample_id"])
                ).scalar_one_or_none()
                if sample_pk is None:
                    stats["no_sample"] += 1
                    continue
                occurred = _occurred_at(ev)
                inserted = record_sample_transition(
                    db, sample_id=ev["sample_id"], to_status=ev["new_status"],
                    source="senaite", verb=ev["transition"],
                    occurred_at=occurred,
                    is_event_id=ev["event_id"] or f"synth:{ev['id']}",
                )
                stats["inserted" if inserted else "dup"] += 1
                if inserted:
                    # Events arrive created_at ASC, so a multi-event batch
                    # for one sample lands on the newest status.
                    _heal_status(db, sample_pk, ev["new_status"], occurred, stats)
            except Exception as e:
                logger.warning("workflow.is_sync_event_failed sample_id=%s err=%s",
                                ev.get("sample_id"), e)
                stats["errors"] += 1

        db.commit()

        # cursor_row always exists by this point — the cold-start branch
        # above returns early before ever reaching here.
        cursor_row.cursor_created_at = max_created_at
        db.commit()
    finally:
        db.close()
    return stats


def _integration_db_configured() -> bool:
    try:
        return bool(get_connection_config().get("host"))
    except Exception:
        return False


def maybe_start(app) -> Optional["asyncio.Task"]:
    """Env-gated entry point for main.py's lifespan (mirrors
    slack_notify.notifier.maybe_start's shape). Dormant when the Integration
    Service DB isn't configured, or when explicitly disabled via
    MK1_IS_EVENT_SYNC_ENABLED=0.

    Note: the config-presence gate (`_integration_db_configured()`) is
    effectively always True in practice — `get_connection_config()` defaults
    host to "localhost" when no INTEGRATION_DB_*_HOST env var is set, so an
    unconfigured environment still reads as "configured". In practice
    MK1_IS_EVENT_SYNC_ENABLED=0 is the real operational off-switch."""
    if os.getenv("MK1_IS_EVENT_SYNC_ENABLED", "1") == "0":
        return None
    if not _integration_db_configured():
        return None

    from database import SessionLocal
    from fastapi.concurrency import run_in_threadpool

    interval = int(os.getenv("MK1_IS_EVENT_SYNC_INTERVAL_SECONDS", "300"))

    async def _loop():
        while True:
            try:
                await run_in_threadpool(sync_once, SessionLocal)
            except Exception as e:
                logger.warning("workflow.is_sync_failed err=%s", e)
            await asyncio.sleep(interval)

    return asyncio.create_task(_loop(), name="is-event-stream-sync")
