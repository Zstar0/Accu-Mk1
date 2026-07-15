"""Nightly parent-analysis shadow reconcile rider (read-flip Layer 4, Task 4,
spec `2026-07-14-parent-ar-read-flip-design.md` §8).

WHY THIS EXISTS: flipping `sample_details` to native (Task 3) retires the
SENAITE display-fetch that the slice-3 passive drift observer piggybacked
on to notice when SENAITE-direct analysis edits had drifted from the
`lims_analyses` shadow rows. Once that fetch stops happening on every page
view, a SENAITE-direct edit would go stale in the shadow with nothing left
to catch it. This rider is the compensator: a scheduled full sweep that
reuses the slice-2 backfill core
(`scripts.backfill_parent_analysis_shadows.backfill`) on a nightly cadence
-- the same script that "doubles as manual reconcile" by design (its own
docstring), now run unattended instead of only ad hoc.

ENV GATE: `MK1_PARENT_MIRROR_RECONCILE_ENABLED`. The CODE default is
`"false"` -- prod decides at deploy time (Handler call per spec §8); stacks
turn it on via their own env. Read INSIDE `tick()` on every call, never
cached at import/module-load time or captured once at task-creation time --
env changes only take effect on container recreate anyway (house pattern),
so re-reading per tick costs nothing and keeps the on/off decision entirely
inside the one function the tests exercise directly (mirrors
`workflow.is_event_stream`'s test house-rule: never run the real asyncio
loop with real sleeps in tests -- drive the synchronous tick instead).

CADENCE: a boring nightly-window check, not a 24h-sleep task. `tick()`
no-ops unless `now.hour == RUN_HOUR_UTC` (8 UTC ~= 3am ET), and a
module-level `_last_run_date` guard (reset only on process restart) makes
sure at most one run fires per UTC calendar day even though the outer loop
polls every `_LOOP_POLL_SECONDS`. The guard is set BEFORE the backfill call
runs (not after it succeeds): a failed run does not retry same-day -- it
waits for tomorrow's fresh, full sweep rather than hammering SENAITE in a
retry storm. This is deliberately simpler than `flags.scheduler.Scheduler`
(DB-backed last-run bookkeeping across restarts) -- a missed night here is
self-healing (every run is a FULL sweep, not incremental), so an in-memory
guard is sufficient and avoids adding new persisted state for a rider whose
job is itself a drift-catcher.

CHECKPOINT: `backfill()` normally supports incremental resume, but this
rider always wants a full sweep -- every tick uses a FRESH, date-keyed
checkpoint path (`/tmp/reconcile_shadows_{date}.json`), so each night starts
scanning `lims_samples` from the top rather than resuming a stale cursor
from days ago.

THROTTLE: `sleep_s=THROTTLE_SLEEP_S` (>=0.5s between per-parent SENAITE
fetches) -- the SENAITE bulk-scan hazard class documented in
`feedback_senaite_bulk_scan_hazard`: an unthrottled sweep over every
registered parent took the single-Zope-core SENAITE instance down for
~15 minutes once already (2026-06-26). Never lower this without re-reading
that incident.

M/I-BLIND: inherited unmodified from the backfill core, which is itself
blind to `method_id`/`instrument_id` per Layer 1's ownership rule (those
columns are Mk1-owned -- native writers are the vial picker, the prep
bridge, and `promote_to_parent`). This rider adds no M/I writes of its own;
see `tests/test_parent_mirror_reconcile_rider.py`'s M/I-preservation test
for the rider-level regression proof.

NEVER-FAIL: any exception from the backfill call is caught inside `tick()`
and logged as `parent_mirror.reconcile_failed` -- a bad night never takes
the loop down, mirroring `workflow.is_event_stream`'s per-tick try/except.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime
from typing import Optional

from database import SessionLocal
from scripts.backfill_parent_analysis_shadows import backfill

logger = logging.getLogger(__name__)

ENV_VAR = "MK1_PARENT_MIRROR_RECONCILE_ENABLED"
RUN_HOUR_UTC = 8  # ~3am ET
THROTTLE_SLEEP_S = 0.5  # SENAITE bulk-scan hazard floor -- do not lower
CHECKPOINT_TEMPLATE = "/tmp/reconcile_shadows_{date}.json"
_REGISTRY_PAGE_SIZE = 200  # matches the script's own CLI default
_LOOP_POLL_SECONDS = 1800  # how often the outer loop checks the window

# Module-level once-per-day guard (YYYY-MM-DD of the last fired run). Reset
# on process restart -- deliberately not persisted; see module docstring.
_last_run_date: Optional[str] = None


def _enabled() -> bool:
    """House boolean-env idiom (`peptide_request_config._parse_bool`),
    inlined here since this is the only caller. Read at TICK time -- see
    module docstring."""
    return os.getenv(ENV_VAR, "false").strip().lower() in ("1", "true", "yes", "on")


def tick(now: Optional[datetime] = None, *, sleep_s: float = THROTTLE_SLEEP_S,
         checkpoint_path: Optional[str] = None) -> None:
    """One scheduler check. No-ops unless enabled AND inside the nightly
    window AND not already run today; otherwise runs exactly one full
    backfill-core sweep. `sleep_s`/`checkpoint_path` are overridable (default
    to the throttle floor / today's fresh path) purely so tests can drive
    the REAL core cheaply and deterministically without a real registry
    sweep -- production always uses the defaults.

    Never raises: a backfill-core exception is caught and logged
    (`parent_mirror.reconcile_failed`); the caller (the loop in
    `maybe_start`) is guaranteed to see this return normally either way."""
    global _last_run_date
    if not _enabled():
        return
    now = now or datetime.utcnow()
    if now.hour != RUN_HOUR_UTC:
        return
    today = now.strftime("%Y-%m-%d")
    if _last_run_date == today:
        return
    # Set BEFORE running -- see module docstring (a failed run waits for
    # tomorrow's fresh sweep rather than retrying same-day).
    _last_run_date = today

    path = checkpoint_path or CHECKPOINT_TEMPLATE.format(date=today)
    try:
        stats = backfill(
            SessionLocal, sleep_s=sleep_s, batch_size=_REGISTRY_PAGE_SIZE,
            checkpoint_path=path, dry_run=False, limit=None,
        )
        logger.info("parent_mirror.reconcile_done stats=%s checkpoint=%s", stats, path)
    except Exception:
        logger.warning("parent_mirror.reconcile_failed", exc_info=True)


def maybe_start(app=None) -> "asyncio.Task":
    """Entry point for main.py's lifespan -- mirrors
    `workflow.is_event_stream.maybe_start`'s shape (an always-created
    asyncio.Task looping with `asyncio.sleep`), with one deliberate
    difference: this rider's on/off decision is NOT made here at
    task-creation time. `tick()` re-reads the env gate on every call, so
    this always creates the loop task -- it is genuinely dormant (a cheap
    no-op tick every `_LOOP_POLL_SECONDS`) when the gate is off, not absent.
    That keeps env-gating entirely inside the directly-testable `tick()`
    function rather than splitting it across two call sites."""
    from fastapi.concurrency import run_in_threadpool

    async def _loop():
        while True:
            try:
                await run_in_threadpool(tick)
            except Exception:
                # Defense in depth -- tick() already catches its own
                # backfill-core failures; this guards anything else
                # (e.g. a threadpool dispatch issue) from killing the loop.
                logger.warning("parent_mirror.reconcile_failed", exc_info=True)
            await asyncio.sleep(_LOOP_POLL_SECONDS)

    return asyncio.create_task(_loop(), name="parent-mirror-reconcile")
