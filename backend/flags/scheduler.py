"""In-process asyncio job scheduler for the flags module.

Single-uvicorn-process primitive (same justification as flags.bus.BUS — one
process, no broker). A ticker wakes every `tick_seconds`; for each registered
job whose interval has elapsed since its last recorded run, it runs the job and
records (last_run_at, last_status) in flag_scheduler_runs so a restart never
double-fires and ops can read job health. Per-job try/except: one failing job
never kills the ticker or blocks the others.

Slack-free by construction — jobs that need Slack live in host modules and are
registered from main.py's lifespan (mirrors how the SSE bus/notifier are wired).
NOTE: flag_scheduler_runs guards RESTART double-fire, not concurrent workers;
this is safe only under a single uvicorn process.
"""
from __future__ import annotations

import asyncio
import inspect
import logging
import random
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Awaitable, Callable, Optional, Union

from sqlalchemy import select

logger = logging.getLogger(__name__)

JobFn = Callable[..., Union[None, Awaitable[None]]]


@dataclass
class Job:
    name: str
    interval: timedelta
    fn: JobFn
    jitter: float = 0.1  # ± fraction of interval; decorrelates fire times


class Scheduler:
    def __init__(self, session_factory, *, tick_seconds: float = 60.0,
                 clock: Callable[[], datetime] = datetime.utcnow) -> None:
        self._session_factory = session_factory
        self._tick_seconds = tick_seconds
        self._clock = clock
        self._jobs: list[Job] = []
        self._task: Optional[asyncio.Task] = None

    def register(self, name: str, *, interval: timedelta, fn: JobFn,
                 jitter: float = 0.1) -> None:
        if any(j.name == name for j in self._jobs):
            raise ValueError(f"duplicate scheduler job {name!r}")
        self._jobs.append(Job(name, interval, fn, jitter))

    # -- bookkeeping (sync DB; called via to_thread) ----------------------
    def _load_last_runs(self) -> dict[str, Optional[datetime]]:
        from flags.models import FlagSchedulerRun
        db = self._session_factory()
        try:
            return {r.name: r.last_run_at
                    for r in db.execute(select(FlagSchedulerRun)).scalars()}
        finally:
            db.close()

    def _record(self, name: str, when: datetime, status: str) -> None:
        from flags.models import FlagSchedulerRun
        db = self._session_factory()
        try:
            row = db.get(FlagSchedulerRun, name)
            if row is None:
                row = FlagSchedulerRun(name=name)
                db.add(row)
            row.last_run_at = when
            row.last_status = status[:500]
            db.commit()
        finally:
            db.close()

    def _due(self, last_run: Optional[datetime], job: Job, now: datetime) -> bool:
        if last_run is None:
            return True
        # Jitter shortens the threshold slightly so ticks needn't align exactly.
        # jitter=0.0 (the tests) => deterministic `elapsed >= interval`.
        slack = job.interval * job.jitter * random.random()
        return (now - last_run) >= (job.interval - slack)

    # -- tick (injectable now; unit tests drive THIS, never sleep) --------
    async def tick(self, *, now: Optional[datetime] = None) -> list[str]:
        now = now or self._clock()
        last = await asyncio.to_thread(self._load_last_runs)
        fired: list[str] = []
        for job in self._jobs:
            if not self._due(last.get(job.name), job, now):
                continue
            fired.append(job.name)
            await self._run_job(job, now)
        return fired

    async def _run_job(self, job: Job, now: datetime) -> None:
        status = "ok"
        try:
            if inspect.iscoroutinefunction(job.fn):
                await job.fn(now=now)
            else:
                await asyncio.to_thread(job.fn, now=now)
        except Exception as exc:                    # noqa: BLE001 — never kill the ticker
            status = f"error: {exc}"
            logger.exception("scheduler job %s failed", job.name)
        await asyncio.to_thread(self._record, job.name, now, status)

    # -- run loop (production; not unit-tested — tick() is) ----------------
    async def _run(self) -> None:
        logger.info("flag scheduler started with %d job(s)", len(self._jobs))
        while True:
            try:
                await self.tick()
            except Exception:                       # noqa: BLE001 — defensive
                logger.exception("scheduler tick failed")
            await asyncio.sleep(self._tick_seconds)

    def start(self) -> asyncio.Task:
        self._task = asyncio.create_task(self._run(), name="flag-scheduler")
        return self._task
