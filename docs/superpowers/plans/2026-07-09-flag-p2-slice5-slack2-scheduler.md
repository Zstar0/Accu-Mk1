# Flag P2 Slice 5 — Slack Round 2 + Scheduler (+ Recurring Tasks) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Interactive Slack DM buttons (Assign to me / Mark read / Resolve) behind a signed interactions endpoint; an in-process asyncio job **scheduler**; a per-user **morning digest** DM; **recurring tasks** that mint flags on a cadence; and the deferred orphaned-attachment **GC** job.

**Architecture:** A Slack-free scheduler *primitive* (`backend/flags/scheduler.py`) modelled on the SSE bus (`backend/flags/bus.py`) — single-uvicorn, no broker. It runs a ticker started in `main.py`'s existing lifespan; jobs are registered there from their home modules (mirrors how the bus/notifier are wired). Per-job bookkeeping lives in a new `flag_scheduler_runs` table so a restart never double-fires. Job functions live with their domain: **recurring-mint** in `flags/` (mints flags — module-domain, no Slack), **digest** and **GC** host-side in `slack_notify/` (Slack + host infra; the same host→flags-core import that `slack_notify/planner.py` already uses). The interactions endpoint is a new host router that verifies the Slack signature, reverse-maps the Slack member id to an Mk1 user via `slack_dm_prefs`, and routes each button through `flags.service` as that user — identical permission paths to the UI.

**Tech Stack:** FastAPI + SQLAlchemy + idempotent-DDL migrations (`database.py._run_migrations` — no alembic in Mk1); asyncio; `hmac`/`hashlib` stdlib for Slack signing; React 18 + TypeScript + shadcn + TanStack Query. Spec: `docs/superpowers/specs/2026-07-09-flag-system-phase2-design.md` §8 (+ §2, §10, §11, §12); §6's deferred GC job lands here.

## Global Constraints

- **npm only** for the Accu-Mk1 frontend (never pnpm/yarn). No new frontend dependencies in this slice.
- **Additive only** — no behavior change to existing flag/Slack paths. Existing tests stay green; the gate is a **normalized failure-SET diff** vs the known baseline (~19 backend / 34 frontend known failures), never a raw count.
- **Module purity.** `backend/flags/` core (`scheduler.py`, `recurring.py`, `service.py`, `catalog.py`) **must not import Slack**. The scheduler primitive is Slack-free; its *jobs* are registered from host modules in the lifespan. `slack_notify/` is HOST-side and may import Mk1 + flags core (precedent: `slack_notify/planner.py` does `from flags.models import FlagParticipant`).
- **Single-uvicorn assumption.** The scheduler is an in-process ticker (same justification as `flags.bus.BUS`). `flag_scheduler_runs` guards **restart** double-fire (bookkeeping survives a process bounce) — it is **not** a distributed lock and does not make the ticker safe under multiple worker processes. If Mk1 ever runs >1 uvicorn worker, this needs a real lock; call it out, don't silently assume.
- **Env-gated dormancy** (like `MK1_SLACK_BOT_TOKEN` today):
  - `SLACK_SIGNING_SECRET` unset ⇒ `POST /api/slack/interactions` **404s** (feature disabled) **and** DM buttons are **not** emitted (no dead buttons).
  - `MK1_SLACK_BOT_TOKEN` unset ⇒ the notifier stays dormant and the **digest job is not registered**.
  - `MK1_LAB_TZ` unset ⇒ digest hour is evaluated in **UTC** (operator config; do not bake in a guessed lab tz).
  - The scheduler + recurring-mint + GC jobs run regardless of Slack env (they need no Slack).
- **Tests never hit real Slack** — mock the client with a `FakeClient` (idiom in `backend/tests/test_slack_notify_notifier.py`). **Scheduler tests never sleep** — drive `Scheduler.tick(now=…)` with an injectable `now`; the production sleep loop is not unit-tested.
- **Analytics readiness (§10):** recurring mints attribute the creator with `details.automated: true` + `details.recurring_id` on the `raised` event; Slack-button actions attribute the mapped user via normal `flag_events`.
- Gates per task: backend `python -m pytest backend/tests/<file> -q`; frontend `npx vitest run <file>` + `npx tsc --noEmit -p tsconfig.json`. Slice-end gate: `npm run check:all` + `npm run build` + `python -m pytest backend/tests -q` (NEW-failure diff only).
- **Branch:** `feat/flag-p2-slack2` off `feat/flag-p2-search` (Slice 4). Retarget the PR to master once Slice 4 merges. Commit after every task. **Final task is gates-only — NO push/PR** (the orchestrator reviews before shipping).

**Resolved ambiguities (surfaced for reviewer objection):**
1. **Resolve-button visibility.** Spec §8 says buttons appear "*only on flags where the actor could resolve in-app*" (conditional visibility); the task brief says "*Resolve only acts if permitted*" (enforce-on-click). This plan **shows all three buttons on every DM and enforces at the endpoint** (a click routes through `service.change_status`, whose permission check declines with a confirmation line). It follows the brief; if the reviewer meant conditional visibility, that is a build change to `messages.build_message` (it would need per-recipient permission context it does not have today).
2. **GC job placement.** The brief groups the GC job "host side" with digest. This plan honors that: GC lives in `backend/slack_notify/maintenance.py`. **Reviewer question:** GC has zero Slack coupling and operates on `flag_attachments` via the flags attachment seam, so `backend/flags/attachments_gc.py` (module-domain, same rationale as recurring-mint) would be more cohesive. Kept host-side per the brief; move it a file over if you prefer cohesion — the registration wiring is identical.

---

### Task 1: Migrations + models — `flag_scheduler_runs`, `flag_recurring`, digest prefs columns

**Files:**
- Modify: `backend/flags/models.py` (add `FlagSchedulerRun`, `FlagRecurring`; import `Boolean`)
- Modify: `backend/models.py` (`SlackDmPrefs` — add `digest_enabled`, `digest_hour`, `last_digest_date`; import `Date` if absent)
- Modify: `backend/database.py` (append idempotent DDL to the flags migration block, after the box migrations ~line 937)
- Test: `backend/tests/test_flags_scheduler_models.py` (create)

**Interfaces:**
- Produces: `FlagSchedulerRun(name PK: str, last_run_at: Optional[datetime], last_status: Optional[str])`; `FlagRecurring(id, title, body, type, assignee_id, watchers: list|None, entity_type, entity_id, cadence, next_run_at, active, skip_if_open, created_by, created_at, last_minted_flag_id)`; `SlackDmPrefs.digest_enabled: bool`, `SlackDmPrefs.digest_hour: int`, `SlackDmPrefs.last_digest_date: Optional[date]`. Tasks 2/5/8/9 depend on these exact names.

- [ ] **Step 1: Write the failing test**

```python
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from datetime import date, datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def test_scheduler_run_row(db):
    from flags.models import FlagSchedulerRun
    db.add(FlagSchedulerRun(name="digest", last_run_at=datetime(2026, 7, 9, 8),
                            last_status="ok"))
    db.commit()
    assert db.get(FlagSchedulerRun, "digest").last_status == "ok"


def test_recurring_row_defaults(db):
    from flags.models import FlagRecurring
    r = FlagRecurring(title="Calibrate HPLC", type="task", cadence="weekly:0",
                      next_run_at=datetime(2026, 7, 13), created_by=1)
    db.add(r)
    db.commit()
    assert r.id and r.active is True and r.skip_if_open is True
    assert r.body is None and r.entity_type is None and r.last_minted_flag_id is None


def test_slack_prefs_digest_columns(db):
    from models import SlackDmPrefs
    p = SlackDmPrefs(user_id=1)
    db.add(p)
    db.commit()
    assert p.digest_enabled is False and p.digest_hour == 8
    assert p.last_digest_date is None
    p.last_digest_date = date(2026, 7, 9)
    db.commit()
    assert db.query(SlackDmPrefs).one().last_digest_date == date(2026, 7, 9)
```

- [ ] **Step 2: Run — FAIL**

Run: `python -m pytest backend/tests/test_flags_scheduler_models.py -q`
Expected: FAIL — models/columns don't exist yet.

- [ ] **Step 3: Implement.**

`backend/flags/models.py` — extend the SQLAlchemy import to include `Boolean`, and append the two models:

```python
from sqlalchemy import (
    Integer, Text, DateTime, ForeignKey, JSON, UniqueConstraint, Boolean,
)


class FlagSchedulerRun(Base):
    """Per-job bookkeeping for the in-process scheduler. `name` is the PK so a
    restart reads the last run and never double-fires. `last_status` is a short
    'ok' / 'error: …' string for ops health (surfaced via a health route later)."""
    __tablename__ = "flag_scheduler_runs"

    name: Mapped[str] = mapped_column(Text, primary_key=True)
    last_run_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_status: Mapped[Optional[str]] = mapped_column(Text, nullable=True)


class FlagRecurring(Base):
    """A recurring-task template. The scheduler mints a flag from it each time
    `next_run_at` arrives, then advances `next_run_at` per `cadence`. Watchers are
    an opaque id list (no FK — same convention as the rest of the module)."""
    __tablename__ = "flag_recurring"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    body: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    assignee_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    watchers: Mapped[Optional[list]] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"), nullable=True)
    entity_type: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    entity_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    cadence: Mapped[str] = mapped_column(Text, nullable=False)  # daily | weekly:<0-6> | monthly:<1-28>
    next_run_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true", nullable=False)
    skip_if_open: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true", nullable=False)
    created_by: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    last_minted_flag_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
```

`backend/models.py` — on `SlackDmPrefs`, after `slack_display_name`, add (ensure `Date` is imported from sqlalchemy — add it to the existing import if missing):

```python
    # Morning digest (Slice 5). Opt-in; hour is lab-local (MK1_LAB_TZ, UTC default).
    digest_enabled: Mapped[bool] = mapped_column(Boolean, default=False,
                                                 server_default="false", nullable=False)
    digest_hour: Mapped[int] = mapped_column(Integer, default=8,
                                             server_default="8", nullable=False)
    # Last local date a digest DM went out — dedupes the ~15-min ticker to one
    # send per user per day.
    last_digest_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
```

(Add `from datetime import date` / extend the existing `datetime` import at the top of `models.py` if `date` is not already imported.)

`backend/database.py` — append to the `migrations` list (the codebase's idempotent-DDL mechanism), after the `lims_boxes` block (~line 937), before the closing `]`:

```python
        # --- flags Slice 5: scheduler + recurring + digest prefs ---
        """
        CREATE TABLE IF NOT EXISTS flag_scheduler_runs (
            name         TEXT PRIMARY KEY,
            last_run_at  TIMESTAMP,
            last_status  TEXT
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS flag_recurring (
            id                   SERIAL PRIMARY KEY,
            title                TEXT NOT NULL,
            body                 TEXT,
            type                 TEXT NOT NULL,
            assignee_id          INTEGER,
            watchers             JSONB NOT NULL DEFAULT '[]'::jsonb,
            entity_type          TEXT,
            entity_id            TEXT,
            cadence              TEXT NOT NULL,
            next_run_at          TIMESTAMP NOT NULL,
            active               BOOLEAN NOT NULL DEFAULT TRUE,
            skip_if_open         BOOLEAN NOT NULL DEFAULT TRUE,
            created_by           INTEGER NOT NULL,
            created_at           TIMESTAMP NOT NULL DEFAULT NOW(),
            last_minted_flag_id  INTEGER
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_flag_recurring_next_run ON flag_recurring (next_run_at)",
        "ALTER TABLE slack_dm_prefs ADD COLUMN IF NOT EXISTS digest_enabled BOOLEAN NOT NULL DEFAULT FALSE",
        "ALTER TABLE slack_dm_prefs ADD COLUMN IF NOT EXISTS digest_hour INTEGER NOT NULL DEFAULT 8",
        "ALTER TABLE slack_dm_prefs ADD COLUMN IF NOT EXISTS last_digest_date DATE",
```

- [ ] **Step 4: Run — PASS.** Then confirm no regression in the flags model suite: `python -m pytest backend/tests/test_flags_models.py backend/tests/test_flags_scheduler_models.py -q`.

- [ ] **Step 5: Commit** — `git commit -m "feat(flags): scheduler + recurring + digest-prefs tables"`

---

### Task 2: Scheduler primitive + lifespan start

**Files:**
- Create: `backend/flags/scheduler.py`
- Modify: `backend/main.py` (lifespan — construct + start the scheduler after the notifier wiring, ~line 336)
- Test: `backend/tests/test_flags_scheduler.py` (create)

**Interfaces:**
- Produces: `Scheduler(session_factory, *, tick_seconds=60.0, clock=datetime.utcnow)` with `.register(name, *, interval: timedelta, fn, jitter=0.1)`, `async .tick(now=None) -> list[str]` (names fired), `.start() -> asyncio.Task`. `fn` may be sync (`(now) -> None`, run via `asyncio.to_thread`) or a coroutine fn (`async (now) -> None`, awaited). Every job's exceptions are caught and recorded to `flag_scheduler_runs.last_status`. Tasks 5/8/10 register jobs onto the lifespan scheduler instance.

- [ ] **Step 1: Failing tests**

```python
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import asyncio
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


@pytest.fixture
def session_factory():
    from database import Base
    import flags.models  # noqa: F401
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


def test_due_first_time_then_respects_interval(session_factory):
    from flags.scheduler import Scheduler
    from flags.models import FlagSchedulerRun
    calls = []
    s = Scheduler(session_factory)
    s.register("job", interval=timedelta(hours=1),
               fn=lambda now: calls.append(now), jitter=0.0)
    t0 = datetime(2026, 7, 9, 8, 0, 0)
    assert asyncio.run(s.tick(now=t0)) == ["job"]         # never run -> due
    assert asyncio.run(s.tick(now=t0 + timedelta(minutes=30))) == []  # < interval
    assert asyncio.run(s.tick(now=t0 + timedelta(hours=1, minutes=1))) == ["job"]
    assert len(calls) == 2
    db = session_factory()
    assert db.get(FlagSchedulerRun, "job").last_status == "ok"
    db.close()


def test_failing_job_records_error_and_does_not_kill_tick(session_factory):
    from flags.scheduler import Scheduler
    from flags.models import FlagSchedulerRun
    ran = []
    s = Scheduler(session_factory)
    s.register("boom", interval=timedelta(hours=1),
               fn=lambda now: (_ for _ in ()).throw(RuntimeError("nope")), jitter=0.0)
    s.register("ok", interval=timedelta(hours=1),
               fn=lambda now: ran.append(now), jitter=0.0)
    fired = asyncio.run(s.tick(now=datetime(2026, 7, 9, 8)))
    assert set(fired) == {"boom", "ok"} and ran           # ok still ran
    db = session_factory()
    assert db.get(FlagSchedulerRun, "boom").last_status.startswith("error:")
    assert db.get(FlagSchedulerRun, "ok").last_status == "ok"
    db.close()


def test_async_job_is_awaited(session_factory):
    from flags.scheduler import Scheduler
    seen = []
    async def job(now):
        seen.append(now)
    s = Scheduler(session_factory)
    s.register("aj", interval=timedelta(hours=1), fn=job, jitter=0.0)
    asyncio.run(s.tick(now=datetime(2026, 7, 9, 8)))
    assert len(seen) == 1


def test_duplicate_registration_rejected(session_factory):
    from flags.scheduler import Scheduler
    s = Scheduler(session_factory)
    s.register("x", interval=timedelta(hours=1), fn=lambda now: None)
    with pytest.raises(ValueError):
        s.register("x", interval=timedelta(hours=1), fn=lambda now: None)
```

- [ ] **Step 2: Run — FAIL** (`flags.scheduler` missing).

- [ ] **Step 3: Implement** `backend/flags/scheduler.py`:

```python
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
```

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Wire the lifespan.** In `backend/main.py`'s `lifespan`, after the Slack-notifier line (`_slack_notifier_task = _slack_maybe_start(_flag_bus.BUS)`, ~line 336), construct the scheduler and hold the instance for later job registration:

```python
    # Flag scheduler (Slice 5) — in-process ticker; jobs registered below.
    from flags.scheduler import Scheduler as _Scheduler
    from database import SessionLocal as _SessionLocal
    _flag_scheduler = _Scheduler(_SessionLocal)
    # Job registration is appended by later Slice-5 tasks (recurring, digest, GC)
    # BEFORE start(); e.g. _flag_scheduler.register("recurring_mint", ...).
    _flag_scheduler.start()
```

(Registering zero jobs is harmless — the ticker runs and does nothing. Later tasks insert their `_flag_scheduler.register(...)` calls immediately above `_flag_scheduler.start()`.)

- [ ] **Step 6: Run — PASS** + `python -m pytest backend/tests/test_flags_scheduler.py -q`. Smoke that the app still imports: `python -c "import sys; sys.path.insert(0,'backend'); import main"`.

- [ ] **Step 7: Commit** — `git commit -m "feat(flags): in-process asyncio job scheduler + lifespan start"`

---

### Task 3: Slack plumbing — signature verify, `chat.update`, DM buttons

**Files:**
- Create: `backend/slack_notify/interactions.py` (only `verify_slack_signature` in this task; the router lands in Task 4)
- Modify: `backend/slack_notify/client.py` (add `update_message`)
- Modify: `backend/slack_notify/messages.py` (add `interactive` param → actions block)
- Modify: `backend/slack_notify/notifier.py` (thread `interactive` into `build_message`)
- Test: `backend/tests/test_slack_interactions_sig.py` (create), extend `backend/tests/test_slack_notify_messages.py`

**Interfaces:**
- Produces: `verify_slack_signature(signing_secret, timestamp, signature, body, *, now=None, window=300) -> bool` (v0 HMAC over `v0:{ts}:{body}`, replay-windowed, fail-closed on unset secret); `SlackClient.update_message(channel, ts, text, blocks) -> bool`; `build_message(..., interactive: bool = False)` appends an `actions` block whose buttons carry `action_id` ∈ {`flag_assign_me`, `flag_mark_read`, `flag_resolve`} and `value = str(flag_id)`. Task 4 consumes all three.

- [ ] **Step 1: Failing tests.** `backend/tests/test_slack_interactions_sig.py`:

```python
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import hashlib
import hmac

from slack_notify.interactions import verify_slack_signature

SECRET = "shhh"


def _sign(ts, body):
    base = f"v0:{ts}:{body}".encode()
    return "v0=" + hmac.new(SECRET.encode(), base, hashlib.sha256).hexdigest()


def test_valid_signature_accepted():
    body, ts = "payload=%7B%7D", "1000"
    assert verify_slack_signature(SECRET, ts, _sign(ts, body), body, now=1000) is True


def test_tampered_body_rejected():
    ts = "1000"
    sig = _sign(ts, "payload=%7B%7D")
    assert verify_slack_signature(SECRET, ts, sig, "payload=EVIL", now=1000) is False


def test_replay_outside_window_rejected():
    body, ts = "payload=%7B%7D", "1000"
    assert verify_slack_signature(SECRET, ts, _sign(ts, body), body,
                                  now=1000 + 301) is False


def test_unset_secret_fails_closed():
    assert verify_slack_signature("", "1000", "v0=x", "b", now=1000) is False
    assert verify_slack_signature(None, "1000", "v0=x", "b", now=1000) is False


def test_bad_timestamp_rejected():
    assert verify_slack_signature(SECRET, "notanint", "v0=x", "b", now=1000) is False
```

Append to `backend/tests/test_slack_notify_messages.py` (existing tests pass `interactive` default False → their assertions are unchanged; these ADD coverage for the button path — no baseline breakage):

```python
def test_interactive_adds_action_buttons():
    _text, blocks = build_message(_event(), "assigned", "Nick",
                                  "https://mk1.example", interactive=True)
    actions = [b for b in blocks if b.get("type") == "actions"]
    assert len(actions) == 1
    ids = {e["action_id"] for e in actions[0]["elements"]}
    assert ids == {"flag_assign_me", "flag_mark_read", "flag_resolve"}
    assert all(e["value"] == "7" for e in actions[0]["elements"])  # flag id


def test_non_interactive_has_no_action_block():
    _text, blocks = build_message(_event(), "assigned", "Nick",
                                  "https://mk1.example")
    assert not any(b.get("type") == "actions" for b in blocks)
```

- [ ] **Step 2: Run — FAIL**

Run: `python -m pytest backend/tests/test_slack_interactions_sig.py backend/tests/test_slack_notify_messages.py -q`

- [ ] **Step 3: Implement.**

`backend/slack_notify/interactions.py` (this task adds only the pure verifier; the router is Task 4):

```python
"""Slack interactivity endpoint (Phase 2). POST /api/slack/interactions.

This task supplies the signature verifier; the router lands in Task 4. The verify
is fail-closed: an unset signing secret returns False (the endpoint 404s), and the
5-minute replay window rejects stale/replayed requests. The HMAC is computed over
the RAW request body — the caller must pass the undecoded-form body string.
"""
from __future__ import annotations

import hashlib
import hmac
import time
from typing import Optional

_REPLAY_WINDOW = 300  # seconds


def verify_slack_signature(signing_secret: Optional[str], timestamp: Optional[str],
                           signature: Optional[str], body: str, *,
                           now: Optional[float] = None,
                           window: int = _REPLAY_WINDOW) -> bool:
    if not signing_secret:
        return False
    try:
        ts = int(timestamp)                       # type: ignore[arg-type]
    except (TypeError, ValueError):
        return False
    now = time.time() if now is None else now
    if abs(now - ts) > window:
        return False
    base = f"v0:{timestamp}:{body}".encode()
    expected = "v0=" + hmac.new(signing_secret.encode(), base,
                                hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature or "")
```

`backend/slack_notify/client.py` — add after `post_dm` (chat.update takes JSON like chat.postMessage — no form encoding; the `form=True` path is only for users.lookupByEmail / users.info):

```python
    async def update_message(self, channel: str, ts: str, text: str,
                             blocks: list) -> bool:
        return await self._call("chat.update",
                                {"channel": channel, "ts": ts, "text": text,
                                 "blocks": blocks}) is not None
```

`backend/slack_notify/messages.py` — extend `build_message`'s signature to `def build_message(event, category, actor_label, base_url, link_hash=None, *, interactive=False)` and, just before `return text, blocks`, append the actions block:

```python
    if interactive:
        fid = flag.get("id")
        blocks.append({
            "type": "actions",
            "block_id": f"flag_{fid}",
            "elements": [
                {"type": "button", "action_id": "flag_assign_me",
                 "text": {"type": "plain_text", "text": "Assign to me"},
                 "value": str(fid)},
                {"type": "button", "action_id": "flag_mark_read",
                 "text": {"type": "plain_text", "text": "Mark read"},
                 "value": str(fid)},
                {"type": "button", "action_id": "flag_resolve", "style": "primary",
                 "text": {"type": "plain_text", "text": "Resolve"},
                 "value": str(fid)},
            ],
        })
```

`backend/slack_notify/notifier.py` — thread an `interactive` flag so buttons are emitted ONLY when the interactions endpoint is live (`SLACK_SIGNING_SECRET` present):
- `SlackNotifier.__init__` gains `interactive: bool = False` → store `self._interactive = interactive`.
- In `handle_event`, the `build_message(...)` call gains `interactive=self._interactive`.
- In `maybe_start`, construct with `interactive=bool(os.getenv("SLACK_SIGNING_SECRET"))`.

- [ ] **Step 4: Run — PASS.** Then the whole Slack suite (buttons don't perturb the notifier tests — they assert channel/text): `python -m pytest backend/tests -k slack -q` — baseline diff only.

- [ ] **Step 5: Commit** — `git commit -m "feat(slack): signature verify, chat.update, interactive DM buttons"`

---

### Task 4: Interactions endpoint — `POST /api/slack/interactions`

**Files:**
- Modify: `backend/slack_notify/interactions.py` (add the router + dispatch)
- Modify: `backend/main.py` (register `interactions_router`)
- Test: `backend/tests/test_slack_interactions_endpoint.py` (create)

**Interfaces:**
- Produces: `router` (prefix `/api/slack`) with `POST /interactions`. Behavior: `SLACK_SIGNING_SECRET` unset → 404; bad signature → 401; `block_actions` payload → reverse-map `user.id` (Slack member) via `slack_dm_prefs.slack_member_id` → run the button through `flags.service` as that user → `chat.update` a confirmation context line onto the original DM. Always returns `{"ok": True}` (200) on a verified request so Slack shows no error. `_client()` and `_map_actor()`/`_dispatch()` are module functions (tests patch `_client`).

- [ ] **Step 1: Failing tests.** Sign real requests; inject a fake client:

```python
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import hashlib, hmac, json
from types import SimpleNamespace
from urllib.parse import urlencode

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

SECRET = "shhh"


class FakeClient:
    def __init__(self):
        self.updates = []
    async def update_message(self, channel, ts, text, blocks):
        self.updates.append((channel, ts, blocks))
        return True


@pytest.fixture
def client(monkeypatch):
    from fastapi.testclient import TestClient
    from main import app
    from database import get_db, Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    from models import User, SlackDmPrefs
    from flags.models import FlagFlag

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    shared = Session()
    shared.add(User(id=5, email="a@x.t", hashed_password="x", role="standard"))
    shared.add(SlackDmPrefs(user_id=5, slack_member_id="U5"))
    shared.add(FlagFlag(id=1, entity_type="sample", entity_id="P-1", kind="issue",
                        type="blocker", status="open", title="t", created_by=5))
    shared.commit()

    monkeypatch.setenv("SLACK_SIGNING_SECRET", SECRET)
    monkeypatch.setenv("MK1_SLACK_BOT_TOKEN", "xoxb-test")
    fake = FakeClient()
    import slack_notify.interactions as inter
    monkeypatch.setattr(inter, "_client", lambda: fake)
    # interactions uses SessionLocal directly for its worker session:
    import database
    monkeypatch.setattr(database, "SessionLocal", Session)

    app.dependency_overrides[get_db] = lambda: iter([shared])
    tc = TestClient(app)
    tc.fake = fake  # type: ignore[attr-defined]
    tc.session = shared  # type: ignore[attr-defined]
    yield tc
    app.dependency_overrides.pop(get_db, None)
    shared.close()


def _post(tc, payload):
    body = urlencode({"payload": json.dumps(payload)})
    ts = "1000"
    sig = "v0=" + hmac.new(SECRET.encode(), f"v0:{ts}:{body}".encode(),
                           hashlib.sha256).hexdigest()
    return tc.post("/api/slack/interactions", content=body,
                   headers={"X-Slack-Request-Timestamp": ts,
                            "X-Slack-Signature": sig,
                            "Content-Type": "application/x-www-form-urlencoded"})


def _payload(action_id, flag_id=1, member="U5"):
    return {"type": "block_actions", "user": {"id": member},
            "channel": {"id": "D5"}, "message": {"ts": "111.222", "text": "t",
            "blocks": [{"type": "section", "text": {"type": "mrkdwn", "text": "t"}}]},
            "actions": [{"action_id": action_id, "value": str(flag_id)}]}


def test_assign_to_me_assigns_and_updates(client):
    r = _post(client, _payload("flag_assign_me"))
    assert r.status_code == 200
    from flags.models import FlagFlag
    assert client.session.get(FlagFlag, 1).assignee_id == 5
    assert client.fake.updates and "Assigned to you" in str(client.fake.updates[-1][2])


def test_resolve_routes_through_service(client):
    r = _post(client, _payload("flag_resolve"))
    assert r.status_code == 200
    from flags.models import FlagFlag
    assert client.session.get(FlagFlag, 1).status == "resolved"


def test_unmapped_member_prompts_to_link(client):
    r = _post(client, _payload("flag_mark_read", member="U-UNKNOWN"))
    assert r.status_code == 200
    assert "Preferences" in str(client.fake.updates[-1][2])


def test_bad_signature_401(client):
    body = urlencode({"payload": json.dumps(_payload("flag_mark_read"))})
    r = client.post("/api/slack/interactions", content=body,
                    headers={"X-Slack-Request-Timestamp": "1000",
                             "X-Slack-Signature": "v0=deadbeef",
                             "Content-Type": "application/x-www-form-urlencoded"})
    assert r.status_code == 401


def test_disabled_when_secret_unset(client, monkeypatch):
    monkeypatch.delenv("SLACK_SIGNING_SECRET", raising=False)
    r = _post(client, _payload("flag_mark_read"))
    assert r.status_code == 404
```

(The signature verifier reads `now` from `time.time()`; the tests sign with `ts="1000"` which is far outside the replay window of real wall-clock time. Handle this by having the endpoint pass `now=None` in prod but let the test monkeypatch `interactions._REPLAY_WINDOW` to a huge value, OR — simpler and what this plan does — the endpoint calls `verify_slack_signature(...)` **without** pinning `now`, and the test fixture monkeypatches `slack_notify.interactions.time.time` to return `1000`. Add `monkeypatch.setattr(inter.time, "time", lambda: 1000)` to the fixture.)

- [ ] **Step 2: Run — FAIL** (no router).

- [ ] **Step 3: Implement.** Append to `backend/slack_notify/interactions.py`:

```python
import asyncio
import json
import logging
import os
from urllib.parse import parse_qs

from fastapi import APIRouter, HTTPException, Request

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/slack", tags=["slack-interactions"])


def _client():
    """SlackClient factory (patched to a fake in tests)."""
    from slack_notify.client import SlackClient
    return SlackClient(os.environ["MK1_SLACK_BOT_TOKEN"])


def _map_actor(db, member_id: Optional[str]):
    """Reverse-map a verified Slack member id to an Mk1 User (or None)."""
    if not member_id:
        return None
    from models import SlackDmPrefs, User
    row = db.query(SlackDmPrefs).filter_by(slack_member_id=member_id).first()
    return db.get(User, row.user_id) if row else None


def _dispatch(db, user, action_id: str, flag_id: int) -> str:
    """Run the button as `user`; return a confirmation line. Every action goes
    through the SAME service permission path as the UI — a declined action
    returns a message, never a 500 into Slack (Slack has a 3s budget)."""
    from flags import service
    from flags.errors import PermissionDeniedError
    try:
        if action_id == "flag_assign_me":
            flag = service.get_flag(db, flag_id)
            if flag.assignee_id == user.id:
                return "Already assigned to you."
            service.assign(db, user=user, flag_id=flag_id, assignee_id=user.id)
            return "Assigned to you."
        if action_id == "flag_mark_read":
            service.mark_read(db, user_id=user.id, flag_id=flag_id)
            return "Marked as read."
        if action_id == "flag_resolve":
            service.change_status(db, user=user, flag_id=flag_id, to_status="resolved")
            return "Resolved."
        return "Unknown action."
    except PermissionDeniedError:
        return "You don't have permission to do that."
    except Exception as exc:                        # noqa: BLE001 — never 500 into Slack
        logger.warning("interaction %s on flag %s failed: %s", action_id, flag_id, exc)
        return "Sorry — that didn't go through."


@router.post("/interactions")
async def interactions(request: Request):
    secret = os.getenv("SLACK_SIGNING_SECRET")
    if not secret:
        raise HTTPException(status_code=404)        # disabled / fail-closed
    raw = (await request.body()).decode()
    if not verify_slack_signature(
            secret, request.headers.get("X-Slack-Request-Timestamp"),
            request.headers.get("X-Slack-Signature"), raw):
        raise HTTPException(status_code=401, detail="bad signature")

    payloads = parse_qs(raw).get("payload")
    if not payloads:
        raise HTTPException(status_code=400, detail="missing payload")
    payload = json.loads(payloads[0])
    if payload.get("type") != "block_actions":
        return {"ok": True}
    actions = payload.get("actions") or []
    if not actions:
        return {"ok": True}
    member_id = (payload.get("user") or {}).get("id")
    action_id = actions[0].get("action_id")
    try:
        flag_id = int(actions[0].get("value"))
    except (TypeError, ValueError):
        return {"ok": True}

    def _work() -> Optional[str]:
        from database import SessionLocal
        db = SessionLocal()
        try:
            user = _map_actor(db, member_id)
            if user is None:
                return None
            return _dispatch(db, user, action_id, flag_id)
        finally:
            db.close()

    confirmation = await asyncio.to_thread(_work)
    if confirmation is None:
        confirmation = ("Link your Slack account in Accu-Mk1 Preferences "
                        "to use these buttons.")
    # chat.update: append a context line to the message's existing blocks.
    channel = (payload.get("channel") or {}).get("id")
    ts_msg = (payload.get("message") or {}).get("ts")
    if channel and ts_msg and os.getenv("MK1_SLACK_BOT_TOKEN"):
        blocks = list((payload.get("message") or {}).get("blocks") or [])
        blocks.append({"type": "context",
                       "elements": [{"type": "mrkdwn", "text": f"✓ {confirmation}"}]})
        await _client().update_message(
            channel, ts_msg, (payload.get("message") or {}).get("text", ""), blocks)
    return {"ok": True}
```

`backend/main.py` — register the router alongside the other flag routers (~line 412):

```python
from slack_notify.interactions import router as slack_interactions_router
...
app.include_router(slack_interactions_router)
```

- [ ] **Step 4: Run — PASS**, then `python -m pytest backend/tests -k slack -q` — baseline diff only.

- [ ] **Step 5: Commit** — `git commit -m "feat(slack): interactive DM actions endpoint (assign/read/resolve)"`

---

### Task 5: `create_flag` event-details hook + recurring-mint service + scheduler job

**Files:**
- Modify: `backend/flags/service.py` (`create_flag` — additive `event_details` param)
- Create: `backend/flags/recurring.py`
- Modify: `backend/main.py` (lifespan — register the `recurring_mint` job)
- Test: `backend/tests/test_flags_recurring.py` (create)

**Interfaces:**
- Produces: `service.create_flag(..., event_details: Optional[dict] = None)` — merged into the `raised` event `details` (default None ⇒ unchanged). `recurring.next_run_after(cadence, after) -> datetime` (v1 literals); `recurring.validate_cadence(cadence)`; `recurring.create_recurring / list_recurring / update_recurring / delete_recurring`; `recurring.run_due(db, *, now) -> int` (mints due templates, honors `skip_if_open`, advances `next_run_at`). Task 6 wraps CRUD in routes.

- [ ] **Step 1: Failing tests** (reuse the `db` fixture idiom from `test_flags_service.py` — sqlite + `types_service.seed_builtins` + a registered `sub_sample` entity; add a global `task` type via `types_service.create_type`):

```python
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from datetime import datetime
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    from flags import seams, types_service
    seams.set_event_sink(seams.InMemoryEventSink())
    seams.register_entity("sub_sample", label=lambda d, e: f"Vial {e}",
                          deep_link=lambda e: f"/v/{e}", can_flag=lambda u, e: True)
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    types_service.seed_builtins(s)
    types_service.create_type(db=s, label="Task", color="#888", kind="issue",
                              slug="task", entity_types=[])  # global
    try:
        yield s
    finally:
        s.close()


def _user(id=1, role="admin"):
    return SimpleNamespace(id=id, role=role, email=f"u{id}@x.t")


def test_next_run_after_literals():
    from flags.recurring import next_run_after
    mon = datetime(2026, 7, 13)  # a Monday (weekday()==0)
    assert next_run_after("daily", datetime(2026, 7, 9, 8)) == datetime(2026, 7, 10)
    # weekly:0 (Mon) from a Monday -> the NEXT Monday (strictly after)
    assert next_run_after("weekly:0", mon) == datetime(2026, 7, 20)
    assert next_run_after("monthly:15", datetime(2026, 7, 9)) == datetime(2026, 7, 15)
    assert next_run_after("monthly:5", datetime(2026, 7, 9)) == datetime(2026, 8, 5)


def test_create_flag_event_details_merges(db):
    from flags import service
    from flags.models import FlagEvent
    f = service.create_flag(db, user=_user(), entity_type="sub_sample", entity_id="1",
                            type="blocker", title="t",
                            event_details={"automated": True, "recurring_id": 9})
    raised = [e for e in db.query(FlagEvent).filter_by(flag_id=f.id)
              if e.event_type == "raised"][0]
    assert raised.details["automated"] is True and raised.details["recurring_id"] == 9
    assert raised.details["type"] == "blocker"     # existing key preserved


def test_run_due_mints_and_advances(db):
    from flags import recurring
    from flags.models import FlagRecurring, FlagFlag
    r = recurring.create_recurring(db, user=_user(1), title="Calibrate", body="do it",
                                   type="task", cadence="daily",
                                   assignee_id=2, watchers=[3])
    r.next_run_at = datetime(2026, 7, 9, 0, 0)     # force due
    db.commit()
    minted = recurring.run_due(db, now=datetime(2026, 7, 9, 8, 0))
    assert minted == 1
    flag = db.query(FlagFlag).filter_by(title="Calibrate").one()
    assert flag.assignee_id == 2
    row = db.get(FlagRecurring, r.id)
    assert row.last_minted_flag_id == flag.id
    assert row.next_run_at == datetime(2026, 7, 10)  # advanced


def test_run_due_skips_when_previous_open(db):
    from flags import recurring
    from flags.models import FlagRecurring
    r = recurring.create_recurring(db, user=_user(1), title="Weekly", type="task",
                                   cadence="daily", skip_if_open=True)
    r.next_run_at = datetime(2026, 7, 9)
    db.commit()
    assert recurring.run_due(db, now=datetime(2026, 7, 9, 8)) == 1
    # previous mint is still open -> the next due tick skips (but still advances)
    db.get(FlagRecurring, r.id).next_run_at = datetime(2026, 7, 10)
    db.commit()
    assert recurring.run_due(db, now=datetime(2026, 7, 10, 8)) == 0
    assert db.get(FlagRecurring, r.id).next_run_at == datetime(2026, 7, 11)
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.**

`backend/flags/service.py` — `create_flag`: add the param and merge it into the raised event. Signature becomes `def create_flag(db, *, user, entity_type, entity_id, type, title, assignee_id=None, first_comment=None, due_at=None, event_details=None):` (note: `due_at` is added by Slice 2 — keep it). Replace the raised-event line:

```python
    _audit(db, flag, actor_id, "raised", to_value="open",
           details={"type": type, **(event_details or {})})
```

(This is additive: existing callers pass no `event_details` ⇒ identical output. Run `gitnexus_impact({target: "create_flag", direction: "upstream"})` before editing per repo policy and note the blast radius — every caller uses keyword args, so the new trailing kwarg is safe.)

`backend/flags/recurring.py`:

```python
"""Recurring-task templates (Slice 5). A template mints a flag each time its
cadence elapses. Module-domain: mints via flags.service (no Slack, no host
models beyond the user seam). The scheduler job is `run_due`.

Cadence v1 literals only (NO cron): 'daily' | 'weekly:<0-6, Mon=0>' |
'monthly:<1-28>'. next_run_at is anchored to midnight; time-of-day is out of
scope for v1 (the ~1-min ticker mints shortly after midnight of the due day).
"""
from __future__ import annotations

from datetime import datetime, timedelta
from types import SimpleNamespace
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from flags import catalog, service
from flags.errors import BadRequestError, NotFoundError
from flags.models import FlagFlag, FlagRecurring


def validate_cadence(cadence: str) -> None:
    next_run_after(cadence, datetime.utcnow())  # raises BadRequestError if bad


def next_run_after(cadence: str, after: datetime) -> datetime:
    """The next occurrence strictly after `after` (midnight-anchored)."""
    base = after.replace(hour=0, minute=0, second=0, microsecond=0)
    if cadence == "daily":
        return base + timedelta(days=1)
    if cadence.startswith("weekly:"):
        try:
            dow = int(cadence.split(":", 1)[1])
        except ValueError:
            raise BadRequestError(f"bad cadence {cadence!r}")
        if not 0 <= dow <= 6:
            raise BadRequestError(f"weekly dow out of range: {dow}")
        days = (dow - after.weekday()) % 7 or 7     # strictly after
        return base + timedelta(days=days)
    if cadence.startswith("monthly:"):
        try:
            dom = int(cadence.split(":", 1)[1])
        except ValueError:
            raise BadRequestError(f"bad cadence {cadence!r}")
        if not 1 <= dom <= 28:                      # 28 => valid every month
            raise BadRequestError(f"monthly dom out of range: {dom}")
        if dom > after.day:
            return base.replace(day=dom)
        year = after.year + (1 if after.month == 12 else 0)
        month = 1 if after.month == 12 else after.month + 1
        return base.replace(year=year, month=month, day=dom)
    raise BadRequestError(f"bad cadence {cadence!r}")


def _actor(user_id: int):
    """A minimal user-like for service calls — attribution only (role unused by
    create/watch; recurring never touches lifecycle actions)."""
    return SimpleNamespace(id=user_id, role="standard")


def create_recurring(db: Session, *, user, title: str, type: str,
                     cadence: str, body: Optional[str] = None,
                     assignee_id: Optional[int] = None,
                     watchers: Optional[list] = None,
                     entity_type: Optional[str] = None,
                     entity_id: Optional[str] = None,
                     skip_if_open: bool = True,
                     next_run_at: Optional[datetime] = None) -> FlagRecurring:
    validate_cadence(cadence)
    now = datetime.utcnow()
    r = FlagRecurring(
        title=title, body=body, type=type, assignee_id=assignee_id,
        watchers=list(watchers or []), entity_type=entity_type, entity_id=entity_id,
        cadence=cadence, next_run_at=next_run_at or next_run_after(cadence, now),
        active=True, skip_if_open=skip_if_open, created_by=getattr(user, "id", None))
    db.add(r)
    db.commit()
    db.refresh(r)
    return r


def list_recurring(db: Session) -> list[FlagRecurring]:
    return list(db.execute(
        select(FlagRecurring).order_by(FlagRecurring.created_at.desc())).scalars().all())


def get_recurring(db: Session, rid: int) -> FlagRecurring:
    r = db.get(FlagRecurring, rid)
    if r is None:
        raise NotFoundError(f"recurring {rid} not found")
    return r


def update_recurring(db: Session, rid: int, **fields) -> FlagRecurring:
    r = get_recurring(db, rid)
    if "cadence" in fields and fields["cadence"] is not None:
        validate_cadence(fields["cadence"])
    for key in ("title", "body", "type", "assignee_id", "entity_type",
                "entity_id", "cadence", "active", "skip_if_open", "next_run_at"):
        if key in fields and fields[key] is not None:
            setattr(r, key, fields[key])
    if "watchers" in fields and fields["watchers"] is not None:
        r.watchers = list(fields["watchers"])
    db.commit()
    db.refresh(r)
    return r


def delete_recurring(db: Session, rid: int) -> None:
    db.delete(get_recurring(db, rid))
    db.commit()


def _previous_open(db: Session, r: FlagRecurring) -> bool:
    if r.last_minted_flag_id is None:
        return False
    flag = db.get(FlagFlag, r.last_minted_flag_id)
    return flag is not None and flag.status in catalog.OPEN_STATES


def run_due(db: Session, *, now: datetime) -> int:
    """Scheduler job: mint every active template whose next_run_at has arrived.
    skip_if_open skips (but still advances) when the last mint is still open."""
    rows = db.execute(select(FlagRecurring).where(
        FlagRecurring.active.is_(True),
        FlagRecurring.next_run_at <= now)).scalars().all()
    minted = 0
    for r in rows:
        if r.skip_if_open and _previous_open(db, r):
            r.next_run_at = next_run_after(r.cadence, now)
            db.commit()
            continue
        flag = service.create_flag(
            db, user=_actor(r.created_by), entity_type=r.entity_type,
            entity_id=r.entity_id, type=r.type, title=r.title,
            first_comment=r.body, assignee_id=r.assignee_id,
            event_details={"automated": True, "recurring_id": r.id})
        for uid in (r.watchers or []):
            try:
                service.add_watcher(db, user=_actor(r.created_by),
                                    flag_id=flag.id, user_id=uid)
            except Exception:                        # noqa: BLE001 — a bad watcher id never blocks the mint
                pass
        r.last_minted_flag_id = flag.id
        r.next_run_at = next_run_after(r.cadence, now)
        db.commit()
        minted += 1
    return minted
```

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Register the job.** In `backend/main.py`'s lifespan, immediately above `_flag_scheduler.start()` (Task 2), add:

```python
    from datetime import timedelta as _timedelta
    from flags import recurring as _recurring
    _flag_scheduler.register(
        "recurring_mint", interval=_timedelta(minutes=5),
        fn=lambda now: _recurring.run_due(_SessionLocal(), now=now))
```

(The lambda opens a fresh session per run — `run_due` owns its session lifecycle via the caller here; wrap in a tiny helper that closes it: define `def _recurring_job(now): db = _SessionLocal(); try: _recurring.run_due(db, now=now); finally: db.close()` and register `fn=_recurring_job`. Use the helper form — don't leak the session.)

- [ ] **Step 6: Run — PASS** + app import smoke.

- [ ] **Step 7: Commit** — `git commit -m "feat(flags): recurring-task templates + scheduled mint"`

---

### Task 6: Recurring admin CRUD routes + schemas

**Files:**
- Modify: `backend/flags/schemas.py` (`FlagRecurringResponse` / `Create` / `Update`)
- Modify: `backend/flags/routes.py` (literal `/recurring*` routes ABOVE `/{flag_id}`, admin-gated)
- Test: `backend/tests/test_flags_recurring_routes.py` (create; mirror the `require_admin` override idiom from `test_flags_routes.py`)

**Interfaces:**
- Produces: `GET /api/flags/recurring` (list), `POST /api/flags/recurring` (create), `PUT /api/flags/recurring/{id}`, `DELETE /api/flags/recurring/{id}` — **all** `require_admin` (recurring is admin-only config, like flag-type management; there is no non-admin recurring view). Response `FlagRecurringResponse` mirrors the model.

- [ ] **Step 1: Failing tests** — assert admin-gating (403 for non-admin) + CRUD round-trip. Follow `test_flags_routes.py`: override `get_current_user` with an admin `SimpleNamespace(id=1, role="admin", email=...)` for the happy path and `role="standard"` for the 403 case; override `require_admin` is unnecessary (it derives from `get_current_user`).

```python
def test_create_requires_admin(client_standard):
    r = client_standard.post("/api/flags/recurring",
                             json={"title": "x", "type": "task", "cadence": "daily"})
    assert r.status_code == 403


def test_admin_crud_roundtrip(client_admin):
    r = client_admin.post("/api/flags/recurring",
                          json={"title": "Calibrate", "type": "task",
                                "cadence": "weekly:0", "watchers": [3]})
    assert r.status_code == 201
    rid = r.json()["id"]
    assert r.json()["cadence"] == "weekly:0" and r.json()["active"] is True
    assert client_admin.get("/api/flags/recurring").json()[0]["id"] == rid
    assert client_admin.put(f"/api/flags/recurring/{rid}",
                            json={"active": False}).json()["active"] is False
    assert client_admin.delete(f"/api/flags/recurring/{rid}").status_code == 204


def test_bad_cadence_400(client_admin):
    r = client_admin.post("/api/flags/recurring",
                          json={"title": "x", "type": "task", "cadence": "hourly"})
    assert r.status_code == 400
```

(Build `client_admin` / `client_standard` like the `client` fixture in `test_slack_notify_routes.py`, seeding a global `task` flag type via `types_service.seed_builtins` + `create_type`, and overriding `get_current_user` to the right role.)

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.**

`backend/flags/schemas.py` — append:

```python
# --- recurring tasks (Slice 5) ------------------------------------------
class FlagRecurringResponse(BaseModel):
    id: int
    title: str
    body: Optional[str] = None
    type: str
    assignee_id: Optional[int] = None
    watchers: List[int] = Field(default_factory=list)
    entity_type: Optional[str] = None
    entity_id: Optional[str] = None
    cadence: str
    next_run_at: datetime
    active: bool
    skip_if_open: bool
    created_by: int
    created_at: datetime
    last_minted_flag_id: Optional[int] = None
    model_config = ConfigDict(from_attributes=True)

    @field_validator("watchers", mode="before")
    @classmethod
    def _none_to_list(cls, v):
        return v or []


class FlagRecurringCreate(BaseModel):
    title: str
    type: str
    cadence: str
    body: Optional[str] = None
    assignee_id: Optional[int] = None
    watchers: List[int] = Field(default_factory=list)
    entity_type: Optional[str] = None
    entity_id: Optional[str] = None
    skip_if_open: bool = True


class FlagRecurringUpdate(BaseModel):
    title: Optional[str] = None
    type: Optional[str] = None
    cadence: Optional[str] = None
    body: Optional[str] = None
    assignee_id: Optional[int] = None
    watchers: Optional[List[int]] = None
    entity_type: Optional[str] = None
    entity_id: Optional[str] = None
    active: Optional[bool] = None
    skip_if_open: Optional[bool] = None
```

`backend/flags/routes.py` — add to the schemas import and register the routes in the **literal-before-param** region (with `/types`, `/activity`, above `/{flag_id}`). Import `recurring`:

```python
from flags import recurring, seams, service, types_service
from flags.schemas import (
    ..., FlagRecurringResponse, FlagRecurringCreate, FlagRecurringUpdate,
)


@router.get("/recurring", response_model=List[FlagRecurringResponse])
def list_recurring(db: Session = Depends(get_db), admin=Depends(require_admin)):
    try:
        return recurring.list_recurring(db)
    except Exception as e:
        raise _http(e)


@router.post("/recurring", response_model=FlagRecurringResponse, status_code=201)
def create_recurring(req: FlagRecurringCreate, db: Session = Depends(get_db),
                     admin=Depends(require_admin)):
    try:
        return recurring.create_recurring(
            db, user=admin, title=req.title, type=req.type, cadence=req.cadence,
            body=req.body, assignee_id=req.assignee_id, watchers=req.watchers,
            entity_type=req.entity_type, entity_id=req.entity_id,
            skip_if_open=req.skip_if_open)
    except Exception as e:
        raise _http(e)


@router.put("/recurring/{rid}", response_model=FlagRecurringResponse)
def update_recurring(rid: int, req: FlagRecurringUpdate, db: Session = Depends(get_db),
                     admin=Depends(require_admin)):
    try:
        return recurring.update_recurring(db, rid, **req.model_dump(exclude_unset=True))
    except Exception as e:
        raise _http(e)


@router.delete("/recurring/{rid}", status_code=204)
def delete_recurring(rid: int, db: Session = Depends(get_db),
                     admin=Depends(require_admin)):
    try:
        recurring.delete_recurring(db, rid)
    except Exception as e:
        raise _http(e)
```

- [ ] **Step 4: Run — PASS** + `python -m pytest backend/tests -k "flag and recurring" -q`.

- [ ] **Step 5: Commit** — `git commit -m "feat(flags): recurring-task admin CRUD routes"`

---

### Task 7: Recurring FE — "Recurring" section in the Flags settings pane

**Files:**
- Modify: `src/lib/flags-api.ts` (`FlagRecurring` type + CRUD fns)
- Create: `src/services/flag-recurring.ts` (TanStack hooks)
- Modify: `src/components/preferences/panes/FlagsPane.tsx` (add an admin-only `RecurringSection`)
- Test: `src/components/preferences/panes/__tests__/FlagsPane.recurring.test.tsx` (create)
- i18n: add `preferences.flags.recurring.*` keys to `locales/*.json` (mirror the existing `preferences.flags.*` block)

**Interfaces:**
- Consumes: `useFlagTypes`, `useFlagUsers`/`displayName`, the flags settings pane. Admin-gated render (`useAuthStore(state => state.user?.role === 'admin')`, already in `FlagsPane`).
- Produces: `FlagRecurring` interface (mirror of `FlagRecurringResponse`); `listRecurring/createRecurring/updateRecurring/deleteRecurring`; hooks `useRecurring/useCreateRecurring/useUpdateRecurring/useDeleteRecurring`.

- [ ] **Step 1: Failing test** (render-level — the section lists templates for an admin and hides for a non-admin):

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FlagsPane } from '@/components/preferences/panes/FlagsPane'

vi.mock('@/store/auth-store', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ user: { role: 'admin' } }),
}))
vi.mock('@/services/flag-types', () => ({
  useFlagTypes: () => ({ data: [], isLoading: false, isError: false }),
  useFlagEntityTypes: () => ({ data: [] }),
  useCreateFlagType: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateFlagType: () => ({ mutate: vi.fn() }),
  useDeleteFlagType: () => ({ mutate: vi.fn() }),
}))
vi.mock('@/services/flag-recurring', () => ({
  useRecurring: () => ({ data: [{ id: 1, title: 'Calibrate HPLC', type: 'task',
    cadence: 'weekly:0', active: true, skip_if_open: true, watchers: [],
    assignee_id: null, next_run_at: '', created_by: 1, created_at: '',
    last_minted_flag_id: null, body: null, entity_type: null, entity_id: null }],
    isLoading: false }),
  useCreateRecurring: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateRecurring: () => ({ mutate: vi.fn() }),
  useDeleteRecurring: () => ({ mutate: vi.fn() }),
}))

const wrap = (ui: React.ReactElement) => (
  <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
)

describe('FlagsPane recurring section', () => {
  it('lists recurring templates for an admin', () => {
    render(wrap(<FlagsPane />))
    expect(screen.getByText('Calibrate HPLC')).toBeInTheDocument()
  })
})
```

(Match the mock idiom already used by `FlagsPane.addtype.test.tsx` — read it first and follow its `vi.mock` shape for `@/services/flag-types` / `useAuthStore` rather than the sketch above if it differs.)

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.**

`src/lib/flags-api.ts` — add near the flag-type block:

```ts
/** Mirrors backend FlagRecurringResponse. cadence: 'daily' | 'weekly:<0-6>' | 'monthly:<1-28>'. */
export interface FlagRecurring {
  id: number
  title: string
  body: string | null
  type: string
  assignee_id: number | null
  watchers: number[]
  entity_type: string | null
  entity_id: string | null
  cadence: string
  next_run_at: string
  active: boolean
  skip_if_open: boolean
  created_by: number
  created_at: string
  last_minted_flag_id: number | null
}
export type FlagRecurringCreate = Pick<FlagRecurring,
  'title' | 'type' | 'cadence'> & Partial<Pick<FlagRecurring,
  'body' | 'assignee_id' | 'watchers' | 'entity_type' | 'entity_id' | 'skip_if_open'>>
export type FlagRecurringUpdate = Partial<Omit<FlagRecurring,
  'id' | 'created_by' | 'created_at' | 'last_minted_flag_id' | 'next_run_at'>>

export const listRecurring = () =>
  apiFetch<FlagRecurring[]>('/api/flags/recurring')
export const createRecurring = (body: FlagRecurringCreate) =>
  apiFetch<FlagRecurring>('/api/flags/recurring',
    { method: 'POST', body: JSON.stringify(body) })
export const updateRecurring = (id: number, body: FlagRecurringUpdate) =>
  apiFetch<FlagRecurring>(`/api/flags/recurring/${id}`,
    { method: 'PUT', body: JSON.stringify(body) })
export const deleteRecurring = (id: number) =>
  apiFetch<void>(`/api/flags/recurring/${id}`, { method: 'DELETE' })
```

`src/services/flag-recurring.ts`:

```ts
/** TanStack Query hooks for recurring-task templates (admin-only). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  listRecurring, createRecurring, updateRecurring, deleteRecurring,
  type FlagRecurringCreate, type FlagRecurringUpdate,
} from '@/lib/flags-api'

const KEY = ['flag-recurring'] as const

export function useRecurring() {
  return useQuery({ queryKey: KEY, queryFn: listRecurring })
}
export function useCreateRecurring() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: FlagRecurringCreate) => createRecurring(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}
export function useUpdateRecurring() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: FlagRecurringUpdate }) =>
      updateRecurring(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}
export function useDeleteRecurring() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deleteRecurring(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}
```

`src/components/preferences/panes/FlagsPane.tsx` — add a `RecurringSection` mounted below the existing `SettingsSection` (only when `isAdmin`; non-admins never see recurring). Mirror `TypeCard`'s card-per-row + commit-on-blur/toggle idiom. Each row: title `Input` (commit on blur), `type` Select (from `useFlagTypes`), a cadence editor (a `Select` for `daily`/`weekly`/`monthly` + a second control for the dow/dom that composes the `weekly:<n>`/`monthly:<n>` string), assignee `Select` (from `useFlagUsers`), `active` Switch, `skip_if_open` Switch, delete button. An "Add recurring task" button POSTs a sensible default (`{ title: t('…newRecurringDefault'), type: firstGlobalType, cadence: 'weekly:0' }`) then lets the admin rename in place (same create-then-edit UX as flag types). Keep the diff surgical — reuse `ScopeChip`/`Select`/`Switch` already imported in the file.

```tsx
// sketch — inside FlagsPane, after the types SettingsSection, guarded by isAdmin:
{isAdmin && (
  <SettingsSection title={t('preferences.flags.recurring.title')}>
    <div className="flex items-center justify-between">
      <p className="text-sm text-muted-foreground">
        {t('preferences.flags.recurring.description')}
      </p>
      <Button size="sm" disabled={createRecurring.isPending}
        onClick={() => createRecurring.mutate({
          title: t('preferences.flags.recurring.newDefault'),
          type: firstGlobalType, cadence: 'weekly:0',
        })}>
        <Plus className="mr-1 h-4 w-4" /> {t('preferences.flags.recurring.add')}
      </Button>
    </div>
    <div className="space-y-3">
      {(recurringQuery.data ?? []).map(r => (
        <RecurringCard key={r.id} recurring={r} types={types} users={users}
          onSave={data => updateRecurring.mutate({ id: r.id, data })}
          onDelete={() => deleteRecurring.mutate(r.id)} />
      ))}
    </div>
  </SettingsSection>
)}
```

(Implement `RecurringCard` in the same file, mirroring `TypeCard`. Split-cadence helpers: `parseCadence('weekly:0') -> {unit:'weekly', n:0}` and `formatCadence(unit, n)`; keep them local to the file. `firstGlobalType` = the first `useFlagTypes` row with empty `entity_types`, falling back to `'task'`.)

- [ ] **Step 4: Run — PASS** + `npx tsc --noEmit -p tsconfig.json` (fix any construction sites the compiler flags).

- [ ] **Step 5: Commit** — `git commit -m "feat(flags): recurring-task admin UI in flags settings"`

---

### Task 8: Morning digest job

**Files:**
- Create: `backend/slack_notify/digest.py`
- Modify: `backend/main.py` (lifespan — register the token-gated `slack_digest` job)
- Test: `backend/tests/test_slack_digest.py` (create)

**Interfaces:**
- Produces: `digest.compute_stats(db, user_id, *, now) -> dict` (assigned-open count + overdue/blocked breakdowns + unread count + oldest-overdue title/link; queries flags tables directly like `planner.py`); `digest.due_targets(db, *, now_local) -> list[tuple[int, str, dict]]` (user_id, member_id, stats — gated on `digest_enabled`, `digest_hour == now_local.hour`, `last_digest_date != now_local.date()`, a linked `slack_member_id`, and a non-empty digest); `digest.build_message(stats, base_url) -> (text, blocks)`; `async digest.run(session_factory, client, base_url, *, now)` — converts the scheduler's UTC `now` to `MK1_LAB_TZ` (UTC default), sends via the client, stamps `last_digest_date`.

- [ ] **Step 1: Failing tests** (fake client + sqlite `StaticPool` like `test_slack_notify_notifier.py`):

```python
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import asyncio
from datetime import date, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


class FakeClient:
    def __init__(self):
        self.posted = []
    async def open_dm(self, member_id):
        return f"D-{member_id}"
    async def post_dm(self, channel, text, blocks):
        self.posted.append((channel, text))
        return True


@pytest.fixture
def session_factory():
    from database import Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


def _seed(Session, *, hour=8, enabled=True, member="U1", overdue=True):
    from models import User, SlackDmPrefs
    from flags.models import FlagFlag
    db = Session()
    db.add(User(id=1, email="a@x.t", hashed_password="x"))
    db.add(SlackDmPrefs(user_id=1, slack_member_id=member,
                        digest_enabled=enabled, digest_hour=hour))
    due = datetime(2026, 7, 1) if overdue else None
    db.add(FlagFlag(entity_type="sample", entity_id="P-1", kind="issue",
                    type="blocker", status="open", title="Old one", created_by=1,
                    assignee_id=1, due_at=due))
    db.commit(); db.close()


def test_due_targets_hour_and_dedup(session_factory):
    from slack_notify import digest
    _seed(session_factory)
    db = session_factory()
    now_local = datetime(2026, 7, 9, 8, 30)          # hour 8 matches
    targets = digest.due_targets(db, now_local=now_local)
    assert [t[0] for t in targets] == [1]
    # after a send today, the same day dedups
    from models import SlackDmPrefs
    db.query(SlackDmPrefs).filter_by(user_id=1).update(
        {"last_digest_date": date(2026, 7, 9)})
    db.commit()
    assert digest.due_targets(db, now_local=now_local) == []
    db.close()


def test_wrong_hour_skipped(session_factory):
    from slack_notify import digest
    _seed(session_factory, hour=9)
    db = session_factory()
    assert digest.due_targets(db, now_local=datetime(2026, 7, 9, 8, 30)) == []
    db.close()


def test_empty_digest_skipped(session_factory):
    from slack_notify import digest
    _seed(session_factory, overdue=False)            # no overdue; still has 1 assigned-open
    db = session_factory()
    # assigned-open>0 => NOT empty; make it empty by resolving the only flag
    from flags.models import FlagFlag
    db.query(FlagFlag).update({"status": "resolved"})
    db.commit()
    assert digest.due_targets(db, now_local=datetime(2026, 7, 9, 8, 30)) == []
    db.close()


def test_run_sends_and_stamps(session_factory):
    from slack_notify import digest
    from models import SlackDmPrefs
    _seed(session_factory)
    fake = FakeClient()
    asyncio.run(digest.run(session_factory, fake, "https://mk1.example",
                           now=datetime(2026, 7, 9, 8, 30)))   # UTC hour 8
    assert fake.posted and fake.posted[0][0] == "D-U1"
    db = session_factory()
    assert db.query(SlackDmPrefs).filter_by(user_id=1).one().last_digest_date \
        == date(2026, 7, 9)
    db.close()
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** `backend/slack_notify/digest.py`:

```python
"""Morning digest DM (Slice 5). Host-side (may import flags core — same as
planner.py). Runs from the scheduler every ~15 min; DMs each opted-in user once
per day when their lab-local hour arrives, summarizing their open work. Skips
empty digests. Reuses the notifier client + messages._esc / link_hash_for.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import date, datetime, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from sqlalchemy import select

from slack_notify.messages import _esc, link_hash_for

logger = logging.getLogger(__name__)


def compute_stats(db, user_id: int, *, now: datetime) -> dict:
    """Open-work summary for one user. Queries flags tables directly."""
    from flags import seams, service
    from flags.catalog import OPEN_STATES
    from flags.models import FlagFlag

    assigned = db.execute(select(FlagFlag).where(
        FlagFlag.assignee_id == user_id,
        FlagFlag.status.in_(OPEN_STATES))).scalars().all()
    overdue = [f for f in assigned if f.due_at is not None and f.due_at < now]
    blocked = [f for f in assigned if f.status == "blocked"]
    unread = service.list_unread(db, user_id=user_id)

    oldest = None
    if overdue:
        f = min(overdue, key=lambda x: x.due_at)
        ctx = seams.resolve_context(db, f.entity_type or "", str(f.entity_id or ""))
        oldest = {"title": f.title,
                  "link_hash": link_hash_for((ctx or {}).get("deep_link"), f.id)}
    return {"assigned_open": len(assigned), "overdue": len(overdue),
            "blocked": len(blocked), "unread": len(unread), "oldest_overdue": oldest}


def _is_empty(stats: dict) -> bool:
    return stats["assigned_open"] == 0 and stats["unread"] == 0


def due_targets(db, *, now_local: datetime) -> list[tuple[int, str, dict]]:
    """(user_id, member_id, stats) for users whose digest hour has arrived, who
    haven't been DM'd today, are linked, and have a non-empty digest."""
    from models import SlackDmPrefs
    rows = db.execute(select(SlackDmPrefs).where(
        SlackDmPrefs.digest_enabled.is_(True),
        SlackDmPrefs.digest_hour == now_local.hour)).scalars().all()
    out: list[tuple[int, str, dict]] = []
    today = now_local.date()
    for row in rows:
        if row.slack_member_id is None or row.last_digest_date == today:
            continue
        stats = compute_stats(db, row.user_id, now=now_local)
        if _is_empty(stats):
            continue
        out.append((row.user_id, row.slack_member_id, stats))
    return out


def build_message(stats: dict, base_url: str) -> tuple[str, list[dict]]:
    a, o, b, u = (stats["assigned_open"], stats["overdue"],
                  stats["blocked"], stats["unread"])
    head = f"Your morning digest: *{a}* open assigned"
    if o or b:
        head += f" ({o} overdue, {b} blocked)"
    head += f" · *{u}* unread"
    blocks: list[dict] = [
        {"type": "section", "text": {"type": "mrkdwn", "text": head}}]
    oldest = stats.get("oldest_overdue")
    if oldest:
        link = f"{base_url.rstrip('/')}/{oldest['link_hash']}"
        blocks.append({"type": "section", "text": {"type": "mrkdwn",
                       "text": f"Oldest overdue: <{link}|{_esc(oldest['title'])}>"}})
    text = head.replace("*", "")
    return text, blocks


def _lab_now(now_utc: datetime) -> datetime:
    tz = ZoneInfo(os.getenv("MK1_LAB_TZ", "UTC"))
    return now_utc.replace(tzinfo=timezone.utc).astimezone(tz).replace(tzinfo=None)


def _plan(session_factory, now_local: datetime):
    db = session_factory()
    try:
        return due_targets(db, now_local=now_local)
    finally:
        db.close()


def _stamp(session_factory, user_id: int, when: date) -> None:
    from models import SlackDmPrefs
    db = session_factory()
    try:
        row = db.query(SlackDmPrefs).filter_by(user_id=user_id).first()
        if row is not None:
            row.last_digest_date = when
            db.commit()
    finally:
        db.close()


async def run(session_factory, client, base_url: str, *, now: datetime) -> int:
    """Scheduler job body. `now` is the scheduler's UTC clock."""
    now_local = _lab_now(now)
    targets = await asyncio.to_thread(_plan, session_factory, now_local)
    sent = 0
    for user_id, member_id, stats in targets:
        channel = await client.open_dm(member_id)
        if channel is None:
            continue
        text, blocks = build_message(stats, base_url)
        if await client.post_dm(channel, text, blocks):
            await asyncio.to_thread(_stamp, session_factory, user_id, now_local.date())
            sent += 1
    return sent
```

- [ ] **Step 4: Register the job** (token-gated) in `backend/main.py`'s lifespan, above `_flag_scheduler.start()`:

```python
    if os.getenv("MK1_SLACK_BOT_TOKEN"):
        from slack_notify.client import SlackClient as _SlackClient
        from slack_notify import digest as _digest
        _digest_base = os.getenv("MK1_PUBLIC_URL", "https://accumk1.valenceanalytical.com")
        async def _digest_job(now):
            await _digest.run(_SessionLocal,
                              _SlackClient(os.environ["MK1_SLACK_BOT_TOKEN"]),
                              _digest_base, now=now)
        _flag_scheduler.register("slack_digest", interval=_timedelta(minutes=15),
                                 fn=_digest_job)
```

- [ ] **Step 5: Run — PASS** + `python -m pytest backend/tests/test_slack_digest.py -q` + app import smoke.

- [ ] **Step 6: Commit** — `git commit -m "feat(slack): morning digest DM job"`

---

### Task 9: Digest prefs — API + Profile UI

**Files:**
- Modify: `backend/slack_notify/routes.py` (`SlackPrefsUpdate` + `_serialize` + validation)
- Modify: `src/lib/slack-prefs-api.ts` (`digest_enabled` / `digest_hour` on the type)
- Modify: `src/components/auth/SlackPrefsSection.tsx` (digest toggle + hour select)
- Test: `backend/tests/test_slack_notify_routes.py` (extend), `src/components/auth/__tests__/SlackPrefsSection.test.tsx` (extend)

**Interfaces:**
- Produces: `GET/PUT /api/slack-prefs` now round-trip `digest_enabled: bool` + `digest_hour: int` (0–23, rejected otherwise). FE `SlackDmPrefs` gains both fields; the Profile card gains a digest row.

- [ ] **Step 1: Failing tests** — backend (append to `test_slack_notify_routes.py`):

```python
def test_digest_prefs_roundtrip(client):
    r = client.put("/api/slack-prefs", json={"digest_enabled": True, "digest_hour": 7})
    assert r.status_code == 200 and r.json()["digest_enabled"] is True
    assert r.json()["digest_hour"] == 7
    assert client.get("/api/slack-prefs").json()["digest_hour"] == 7


def test_digest_defaults(client):
    body = client.get("/api/slack-prefs").json()
    assert body["digest_enabled"] is False and body["digest_hour"] == 8


def test_digest_hour_out_of_range_rejected(client):
    assert client.put("/api/slack-prefs", json={"digest_hour": 25}).status_code == 422
```

Frontend (extend `SlackPrefsSection.test.tsx`): assert a digest toggle renders and flipping it calls `update.mutate({ digest_enabled: true })` (follow the file's existing mock of `@/services/slack-prefs`).

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.**

`backend/slack_notify/routes.py`:
- Add `digest_enabled` to `_FIELDS` (it's a bool, serialized like the others).
- Add to `SlackPrefsUpdate`: `digest_enabled: Optional[bool] = None` and `digest_hour: Optional[int] = Field(default=None, ge=0, le=23)` (import `Field` from pydantic — the `ge/le` gives the 422 on 25).
- In `_serialize`, add `out["digest_hour"] = 8 if row is None else row.digest_hour` and ensure `digest_enabled` defaults False in the `row is None` branch (the `_FIELDS` default loop currently sets everything True — special-case `digest_enabled` to False, or drop it from the True-default loop and set explicitly). Concretely, in the `row is None` branch:

```python
    if row is None:
        out = {f: True for f in _FIELDS if f != "digest_enabled"}
        out.update({"slack_member_id": None, "slack_display_name": None,
                    "linked": False, "digest_enabled": False, "digest_hour": 8})
        return out
    out = {f: bool(getattr(row, f)) for f in _FIELDS}
    out["digest_hour"] = row.digest_hour
    ...
```

- The PUT loop already `setattr`s any `exclude_unset` field, so `digest_enabled`/`digest_hour` persist with no extra code.

`src/lib/slack-prefs-api.ts` — add to `SlackDmPrefs`:

```ts
  /** Morning digest opt-in + lab-local hour (0–23). */
  digest_enabled: boolean
  digest_hour: number
```

`src/components/auth/SlackPrefsSection.tsx` — add a digest row after the categories block:

```tsx
<div className="flex items-center justify-between py-1.5">
  <span className="text-sm">{t('preferences.slack.digest')}</span>
  <div className="flex items-center gap-2">
    <Select value={String(prefs.digest_hour)}
      disabled={!prefs.digest_enabled}
      onValueChange={v => update.mutate({ digest_hour: Number(v) })}>
      <SelectTrigger className="h-8 w-24 text-xs"><SelectValue /></SelectTrigger>
      <SelectContent>
        {Array.from({ length: 24 }, (_, h) => (
          <SelectItem key={h} value={String(h)}>{`${h}:00`}</SelectItem>
        ))}
      </SelectContent>
    </Select>
    <Switch checked={prefs.digest_enabled}
      onCheckedChange={v => update.mutate({ digest_enabled: v })} />
  </div>
</div>
```

(Import the shadcn `Select` family into the file. Add `preferences.slack.digest` to `locales/*.json`.)

- [ ] **Step 4: Run — PASS** (backend + `npx vitest run src/components/auth/__tests__/SlackPrefsSection.test.tsx`) + `npx tsc --noEmit -p tsconfig.json`.

- [ ] **Step 5: Commit** — `git commit -m "feat(slack): digest opt-in + hour in Slack prefs"`

---

### Task 10: Orphaned-attachment GC job (deferred from Slice 3)

> **CONTENT-ANCHOR — verify at execution.** The `flag_attachments` table + `seams.attachment_storage` seam are built in **Slice 3** (no plan doc exists yet; names come from spec §6). Before writing, confirm against the merged Slice 3 code: table `flag_attachments(id, flag_id, comment_id nullable, uploaded_by, filename, content_type, size_bytes, storage_key, created_at)`; the model class name (spec implies `FlagAttachment`); and the seam's delete method on `flags.seams.attachment_storage` (spec says a `put/get/delete/url` interface). Adjust the column/method names below to match what Slice 3 actually shipped.

**Files:**
- Create: `backend/slack_notify/maintenance.py` (host-side per the brief — see the reviewer question in Global Constraints)
- Modify: `backend/main.py` (lifespan — register the `attachment_gc` job)
- Test: `backend/tests/test_flag_attachment_gc.py` (create)

**Interfaces:**
- Produces: `maintenance.gc_orphaned_attachments(db, *, now, storage=None) -> int` — deletes every `flag_attachments` row with `comment_id IS NULL AND created_at < now - 24h`, calling `storage.delete(storage_key)` (best-effort per row) before the DB delete. `storage` defaults to `flags.seams.attachment_storage`; tests inject a fake.

- [ ] **Step 1: Failing test** (fake storage seam; seed rows straddling the 24h cutoff). If Slice 3 isn't merged into this branch yet, mark this test `@pytest.mark.skip("depends on Slice 3 flag_attachments")` and leave the job registration in place — it becomes live when Slice 3 lands. Prefer to un-skip once Slice 3 is present.

```python
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


class FakeStorage:
    def __init__(self):
        self.deleted = []
    def delete(self, key):
        self.deleted.append(key)


def test_gc_deletes_only_old_orphans(db):
    from slack_notify.maintenance import gc_orphaned_attachments
    from flags.models import FlagAttachment  # CONTENT-ANCHOR: confirm name
    now = datetime(2026, 7, 9, 12)
    # orphan (comment_id NULL) older than 24h -> deleted
    db.add(FlagAttachment(flag_id=1, comment_id=None, uploaded_by=1,
                          filename="a.png", content_type="image/png", size_bytes=1,
                          storage_key="k-old", created_at=now - timedelta(hours=25)))
    # orphan but recent -> kept (still mid-compose)
    db.add(FlagAttachment(flag_id=1, comment_id=None, uploaded_by=1,
                          filename="b.png", content_type="image/png", size_bytes=1,
                          storage_key="k-new", created_at=now - timedelta(hours=1)))
    # attached (comment_id set) + old -> kept
    db.add(FlagAttachment(flag_id=1, comment_id=7, uploaded_by=1,
                          filename="c.png", content_type="image/png", size_bytes=1,
                          storage_key="k-keep", created_at=now - timedelta(hours=48)))
    db.commit()
    storage = FakeStorage()
    assert gc_orphaned_attachments(db, now=now, storage=storage) == 1
    assert storage.deleted == ["k-old"]
    from flags.models import FlagAttachment as FA
    assert {a.storage_key for a in db.query(FA).all()} == {"k-new", "k-keep"}
```

- [ ] **Step 2: Run — FAIL** (or skip-pending if Slice 3 absent).

- [ ] **Step 3: Implement** `backend/slack_notify/maintenance.py`:

```python
"""Scheduler maintenance jobs (host-side). Currently: orphaned-attachment GC —
deletes flag_attachments never linked to a saved comment after 24h, freeing the
S3 objects behind them. Uses the flags attachment-storage seam (never boto3
directly). See the placement reviewer-question in the Slice 5 plan.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy import select

logger = logging.getLogger(__name__)

_ORPHAN_TTL = timedelta(hours=24)


def gc_orphaned_attachments(db, *, now: datetime, storage=None) -> int:
    from flags import seams
    from flags.models import FlagAttachment          # CONTENT-ANCHOR (Slice 3)
    storage = storage if storage is not None else getattr(
        seams, "attachment_storage", None)
    cutoff = now - _ORPHAN_TTL
    rows = db.execute(select(FlagAttachment).where(
        FlagAttachment.comment_id.is_(None),
        FlagAttachment.created_at < cutoff)).scalars().all()
    removed = 0
    for row in rows:
        try:
            if storage is not None:
                storage.delete(row.storage_key)      # CONTENT-ANCHOR: seam method
        except Exception:                            # noqa: BLE001 — a storage miss never blocks the DB GC
            logger.warning("gc: storage delete failed for %s", row.storage_key)
        db.delete(row)
        removed += 1
    db.commit()
    return removed
```

- [ ] **Step 4: Register the job** in `backend/main.py`'s lifespan, above `_flag_scheduler.start()` (always registered — no Slack env needed; hourly is plenty for a 24h TTL):

```python
    from slack_notify import maintenance as _maintenance
    def _gc_job(now):
        db = _SessionLocal()
        try:
            _maintenance.gc_orphaned_attachments(db, now=now)
        finally:
            db.close()
    _flag_scheduler.register("attachment_gc", interval=_timedelta(hours=1), fn=_gc_job)
```

- [ ] **Step 5: Run — PASS** (or skip-pending) + app import smoke.

- [ ] **Step 6: Commit** — `git commit -m "feat(flags): orphaned-attachment GC scheduler job"`

---

### Task 11: Slice gates

- [ ] **Step 1:** `npm run check:all` — typecheck, lint, ast:lint, format, rust, tests. Expected: green except the documented baseline (compare the failure SET to baseline, not the count).
- [ ] **Step 2:** `npm run build` — succeeds.
- [ ] **Step 3:** `python -m pytest backend/tests -q` — the failure set matches the ~19 known baseline (no NEW failures). Spot-check the new suites: `python -m pytest backend/tests -k "scheduler or recurring or slack or digest or attachment_gc" -q`.
- [ ] **Step 4:** App import smoke: `python -c "import sys; sys.path.insert(0,'backend'); import main"` — lifespan wiring compiles.
- [ ] **Step 5:** Final commit; stop. (Orchestrator reviews before push/PR — do NOT push or open a PR.)

```
git commit -am "chore(flags): slice 5 gates"
```
