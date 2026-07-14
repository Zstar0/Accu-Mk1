"""One-time historical seed backfill: copy the Integration Service DB's
`sample_status_events` history into the native Mk1 sample-transition log
(`lims_sample_transitions`, source='is_seed' — spec §6.5).

Run INSIDE the backend container so the app's modules and env are available:

    docker exec -w /app -i <backend-container> \\
        python -m scripts.backfill_sample_transitions_from_is --batch-size 1000

DB-to-DB (IS -> Mk1): unlike the two SENAITE-fetching backfills this mirrors
the operational SHAPE of (backfill_lims_sample_basic_info.py,
backfill_parent_analysis_shadows.py), there is zero SENAITE load here.
--sleep (default 0) is kept purely for operator control — there is no
load-bearing throttle need, unlike those two.

Idempotent: keyed on `is_event_id` (the `lims_sample_transitions` partial
unique index, source-agnostic — see database.py's
`uq_lims_sample_transitions_event`). Re-running is a clean no-op: every event
dups. NOTE the dedup nuance (spec §6.5 / workflow/sample_log.py
`_explained`): source='is_seed' NEVER participates in the senaite/reconcile
time-window dedup rules — only 'senaite' and 'reconcile' sources do. A
seeded historical row and a live 'mk1' or 'senaite' row can legitimately
coexist for what is "the same" real-world transition; that's fine and
by design — is_event_id uniqueness is the seed's only collision guard, and
it's the SAME guard Task 5's incremental sync uses, so the overlap region
between "history this script seeds" and "already synced by Task 5" is a
clean no-op too (both key off the same IS `event_id` namespace).

--dry-run: iterates every page and, per event, does READ-ONLY existence
checks (sample exists? is_event_id already present?) to report
`would_insert` / `dup` counts. ZERO writes, NO checkpoint touched or written.

--limit N: caps the number of events PROCESSED (not fetched) — a page may be
fetched in full and only partially processed; the checkpoint (real runs
only) advances only up to the last event actually PROCESSED, so a truncated
page's un-processed tail is re-fetched (and re-processed) on the next
invocation rather than silently skipped.

Checkpoint: `{"last_created_at": <iso8601>}`, atomic tmp+os.replace (same
idiom as backfill_parent_analysis_shadows.py). Pages IS events by
`created_at ASC` via `_fetch_events` — imported directly from
`workflow.is_event_stream`, the exact same query/seam Task 5's incremental
sync uses, so there is exactly one place that SQL lives. On checkpoint
RESUME the initial query starts from `last_created_at - overlap`
(--overlap-minutes, default 5 — see the page-boundary note below); within a
run, pages advance strictly greater than each page's max `created_at`.
Checkpoint advances once per PAGE, after that page's commit succeeds (never
mid-page, never before commit). NOTE: a per-event errored row still
advances the checkpoint (its page commits and checkpoints past it) — DELETE
the checkpoint file to retry errored events from the start.

Retirability note: `workflow/is_event_stream.py` is deliberately
self-contained (its own retirement contract, spec §7 — deleted wholesale at
the Mk1->IS inversion) and this script imports only its `_fetch_events` seam
— nothing else. The naive-UTC `occurred_at` conversion (`event_timestamp`
unix int wins, else tz-aware `created_at` normalized) is DUPLICATED here
rather than imported from `is_event_stream._occurred_at`: a 5-line function
copied on purpose so this script doesn't become a second tendril into that
module's internals, and `is_event_stream` doesn't have to grow a new public
export just to serve a caller outside its own sync loop. Keep the two copies
in sync if the IS event shape ever changes.

Page-boundary overlap: `created_at` is a non-unique sort key, so
strictly-greater cursor pagination can in theory miss rows sharing the
EXACT `created_at` of the last row of a full (`== batch_size`) page. The
mitigation is caller-side, the same way Task 5's `sync_once` does it: on
checkpoint RESUME the query starts from `last_created_at - overlap`
(--overlap-minutes, default 5), so any rows tied at/near a previous run's
boundary are swept up by the next invocation — the `is_event_id` partial
unique makes re-processing the overlap region a clean no-op (rows count as
"dup"). Per-page overlap WITHIN a run is deliberately NOT used: a tie-group
larger than batch_size would re-fetch the same page forever. Operational
habit: for a maximally complete seed, run the script twice — the second
pass is a cheap all-dup sweep that captures any intra-run page-boundary
ties via the resume overlap.

Caveat (spec §6.5): best-effort seed, not a certified audit trail — this
stream is only as complete as SENAITE's push hook into IS. The certified
record starts at this slice's deploy (Task 3's mk1-hook writes onward).

Exit code contract: 0 = clean run, no per-event errors. 1 = run completed
but one or more events errored (see the "errors" count in the stats line).
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

# Make the /app package root importable when run as a file (python -m from
# /app makes this a no-op).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import select

from database import SessionLocal
from models import LimsSample, LimsSampleTransition
from workflow.is_event_stream import _fetch_events
from workflow.sample_log import record_sample_transition

log = logging.getLogger("backfill_sample_transitions")

DEFAULT_CHECKPOINT = "/tmp/backfill_sample_transitions.checkpoint.json"
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _occurred_at(ev: dict) -> datetime:
    """Naive UTC — matches the recorder's dedup-window comparisons and the
    LimsSampleTransition.occurred_at column (untimezoned). DUPLICATED from
    workflow.is_event_stream._occurred_at on purpose — see the module
    docstring's Retirability note. Keep the two copies in sync if the IS
    event shape ever changes."""
    ts = ev.get("event_timestamp")
    if ts is not None:
        return datetime.utcfromtimestamp(ts)
    created = ev["created_at"]
    if created.tzinfo is not None:
        return created.astimezone(timezone.utc).replace(tzinfo=None)
    return created


def load_checkpoint(path: str) -> datetime:
    """Return the last-seeded `created_at` cursor (epoch = fresh run); on
    resume the CALLER rewinds it by --overlap-minutes before querying (see
    the module docstring's page-boundary note). Any read/parse failure
    (missing file, corrupt JSON, bad timestamp) is treated as a fresh run —
    same forgiving posture as backfill_parent_analysis_shadows.py's
    load_checkpoint."""
    try:
        with open(path) as f:
            raw = json.load(f).get("last_created_at")
        if not raw:
            return EPOCH
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (OSError, ValueError, TypeError):
        return EPOCH


def save_checkpoint(path: str, last_created_at: datetime) -> None:
    """Persist the page cursor atomically (tmp + os.replace)."""
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"last_created_at": last_created_at.isoformat()}, f)
    os.replace(tmp, path)


def _process_event(db, ev: dict, stats: dict, *, dry_run: bool) -> None:
    """Handle one IS event: known-sample check first (mirrors Task 5's
    sync_once — record_sample_transition collapses "unknown sample" and
    "dedup skip" into the same False, so we disambiguate up front with a
    cheap existence SELECT). In dry-run mode nothing past that point ever
    writes: a second READ-ONLY existence check against the is_event_id
    partial unique predicts dup vs would_insert exactly the way the real
    insert attempt would resolve it. In a real run the actual recorder call
    is made with source='is_seed'."""
    sample_pk = db.execute(
        select(LimsSample.id).where(LimsSample.sample_id == ev["sample_id"])
    ).scalar_one_or_none()
    if sample_pk is None:
        stats["no_sample"] += 1
        return

    event_id = ev["event_id"] or f"synth:{ev['id']}"

    if dry_run:
        exists = db.execute(
            select(LimsSampleTransition.id).where(
                LimsSampleTransition.is_event_id == event_id
            )
        ).scalar_one_or_none() is not None
        stats["dup" if exists else "would_insert"] += 1
        return

    inserted = record_sample_transition(
        db, sample_id=ev["sample_id"], to_status=ev["new_status"],
        source="is_seed", verb=ev["transition"],
        occurred_at=_occurred_at(ev), is_event_id=event_id,
    )
    stats["inserted" if inserted else "dup"] += 1


def backfill(db_factory, *, batch_size: int, checkpoint_path: str,
             dry_run: bool, limit: Optional[int], sleep_s: float = 0.0,
             overlap_minutes: int = 5) -> dict:
    """Page through IS `sample_status_events` (`created_at ASC`) and seed
    each into the native sample-transition log with source='is_seed'. On
    checkpoint resume the INITIAL query is rewound by `overlap_minutes`
    (invocation start ONLY — internal pages stay strictly greater than each
    page's max `created_at`; see the module docstring's page-boundary note).
    One page = one DB session, one commit (real runs), one checkpoint save —
    never per-event, matching the "batched, never per-row" house convention.

    `--limit` truncation is event-granular, not page-granular: the
    checkpoint only ever advances to the last event actually PROCESSED, so a
    page cut short by the limit is safely re-fetched (and its remainder
    re-processed) on the next invocation — nothing is silently skipped.

    Returns coverage stats: {"fetched", "inserted", "dup", "no_sample",
    "would_insert", "errors"}.

    Stats integrity (same concern backfill_parent_analysis_shadows.py's
    docstring calls out): `inserted`/`dup`/`no_sample`/`would_insert` are
    accumulated in a per-page LOCAL dict and folded into `stats` only AFTER
    that page's `db.commit()` returns (real runs) — this stats line is the
    documented coverage evidence for a one-time migration, so a page whose
    commit fails must not overcount rows that never actually landed. If the
    commit itself raises, the whole page's local counts are discarded, ONE
    error is tallied for the page, and the run stops (a commit failure most
    likely means the connection is unhealthy — not something worth paging
    past). Per-event failures inside the page are isolated already (each
    insert runs in its own SAVEPOINT via record_sample_transition), so this
    only bites on something outside that — e.g. a dropped connection between
    processing the page and the commit call.
    """
    stats = {"fetched": 0, "inserted": 0, "dup": 0, "no_sample": 0,
              "would_insert": 0, "errors": 0}
    cursor_dt = load_checkpoint(checkpoint_path)
    if cursor_dt != EPOCH:
        # Resume: rewind the initial query window so rows tied at/near the
        # previous run's boundary are re-fetched (is_event_id dedup makes
        # re-processing them a no-op — they count as "dup", never double-insert).
        query_from = cursor_dt - timedelta(minutes=overlap_minutes)
        log.info("resuming from checkpoint last_created_at=%s "
                 "(overlap %d min -> querying from %s)",
                 cursor_dt.isoformat(), overlap_minutes, query_from.isoformat())
        cursor_dt = query_from

    processed = 0
    while limit is None or processed < limit:
        try:
            events = _fetch_events(cursor_dt, batch_size)
        except Exception as e:
            stats["errors"] += 1
            log.warning("backfill_seed_fetch_failed cursor=%s err=%s",
                        cursor_dt.isoformat(), e, exc_info=True)
            break
        if not events:
            break
        stats["fetched"] += len(events)

        db = db_factory()
        page_max = cursor_dt
        page_processed = 0
        page_stats = {"inserted": 0, "dup": 0, "no_sample": 0, "would_insert": 0}
        page_errors = 0
        commit_failed = False
        try:
            for ev in events:
                if limit is not None and processed >= limit:
                    break
                processed += 1
                page_processed += 1
                created_at = ev["created_at"]
                if created_at > page_max:
                    page_max = created_at
                try:
                    _process_event(db, ev, page_stats, dry_run=dry_run)
                except Exception as e:
                    page_errors += 1
                    log.warning("backfill_seed_event_failed sample_id=%s err=%s",
                                ev.get("sample_id"), e, exc_info=True)
            if not dry_run:
                db.commit()
        except Exception as e:
            commit_failed = True
            log.warning("backfill_seed_page_commit_failed cursor=%s err=%s",
                        cursor_dt.isoformat(), e, exc_info=True)
        finally:
            db.close()

        if commit_failed:
            # Nothing in this page is durable (close() rolls back whatever
            # was flushed-but-uncommitted) — discard the per-event counts,
            # count exactly ONE error for the page, and stop.
            stats["errors"] += 1
            break

        for key, val in page_stats.items():
            stats[key] += val
        stats["errors"] += page_errors

        if page_processed and not dry_run:
            save_checkpoint(checkpoint_path, page_max)
        if page_processed:
            cursor_dt = page_max

        time.sleep(sleep_s)

        if len(events) < batch_size:
            break  # short page: no more rows satisfy the WHERE clause

    log.info("backfill_seed done: %s", stats)
    if not dry_run:
        log.info("checkpoint retained at %s — delete it to re-seed from the start",
                 checkpoint_path)
    return stats


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="One-time historical seed: copy IS sample_status_events "
                    "history into the native Mk1 sample-transition log "
                    "(source='is_seed'; spec §6.5 — see module docstring for "
                    "the full operational contract).",
        epilog="Exit codes: 0 = clean, 1 = completed with per-event errors "
               "(see the errors count in the stats line). Idempotent — keyed "
               "on is_event_id, safe to re-run any number of times.")
    ap.add_argument("--batch-size", type=int, default=1000,
                    help="IS sample_status_events page size (default 1000)")
    ap.add_argument("--checkpoint", default=DEFAULT_CHECKPOINT,
                    help=f"resume-cursor JSON path (default {DEFAULT_CHECKPOINT})")
    ap.add_argument("--dry-run", action="store_true",
                    help="iterate + count would_insert but write nothing "
                         "(no DB rows, no checkpoint)")
    ap.add_argument("--limit", type=int, default=None,
                    help="stop after N events processed (smoke runs)")
    ap.add_argument("--overlap-minutes", type=int, default=5,
                    help="on checkpoint resume, rewind the initial query to "
                         "last_created_at minus this window (default 5) — "
                         "re-processed rows dedup via is_event_id; 0 restores "
                         "strictly-greater resume")
    ap.add_argument("--sleep", type=float, default=0.0,
                    help="seconds between pages — operator control only, "
                         "DB-to-DB needs no throttling by default (default 0)")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    stats = backfill(SessionLocal, batch_size=args.batch_size,
                     checkpoint_path=args.checkpoint, dry_run=args.dry_run,
                     limit=args.limit, sleep_s=args.sleep,
                     overlap_minutes=args.overlap_minutes)
    print(json.dumps(stats))  # coverage evidence line — retain
    return 1 if stats["errors"] else 0  # nonzero so unattended runs surface partial failure


if __name__ == "__main__":
    raise SystemExit(main())
