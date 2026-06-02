# SLA Business-Hours Engine + Calendar (Sub-project B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `business_hours_only` SLA tiers measure elapsed time in business minutes (Mon–Fri 09:00–17:00 Pacific, excluding holidays) via a pure server-side engine, a stored/editable holiday calendar, a batch `POST /sla/status` endpoint, and a "Business Hours" Preferences pane.

**Architecture:** A pure, DB-free engine (`backend/sla_engine.py`) does day-by-day business-minute math; a dependency-free `backend/holidays_us.py` computes federal holiday dates; two new tables (`business_hours_config` singleton + `lab_holidays`) are created and seeded in `database._run_migrations` + a startup seeder; FastAPI endpoints expose config/holiday CRUD and the batch status endpoint; the frontend adds an api.ts client, a TanStack-Query service, and a Preferences pane. **No TypeScript mirror of the business-hours math** — it is server-side only (DST correctness via stdlib `zoneinfo`). Only the existing `resolveSlaTier` stays client-side.

**Tech Stack:** Python 3.13 / FastAPI / SQLAlchemy 2.0 (raw-SQL idempotent migrations, no Alembic) / Postgres `accumark_mk1`; React 19 / TanStack Query v5 / shadcn-ui / react-i18next / Vitest.

---

## Operating context (read before starting)

- **Work in the worktree `C:\tmp\accu-mk1-wave1`** (branch `feat/order-status-processing-time`). The Docker containers bind-mount it; the OneDrive checkout is parked on `master` and is NOT what `:3101`/`:8012` serve. All paths below are relative to this worktree.
- **Backend tests live at `/app/tests` inside the container.** Run them as:
  `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/<file> -q'`
  If pytest is missing (session-local pip install, lost on rebuild): `docker exec accu-mk1-backend pip install --quiet pytest`.
- **Restart after schema/endpoint edits:** `docker restart accu-mk1-backend` after editing `models.py`/`database.py`/`main.py` (migrations + `init_db` run only at startup; Windows bind-mount HMR doesn't fire for the backend). `docker restart accu-mk1-frontend` after `src/` edits.
- **ESLint:** `Array<T>` is forbidden — use `T[]`. Zustand: selector syntax only, no destructuring. Lint only the files you change; 3 pre-existing baseline errors in `src/lib/api.ts` (~lines 1730/3224/3757) are NOT regressions — ignore them.
- **i18n convention here:** `fr.json` and `ar.json` currently hold *English* strings for the SLA keys (translation deferred). Mirror that — add the **same English** `preferences.businessHours.*` keys to all three locale files.
- **Commit per task; push the feature branch per task. NO PR/merge to master.** Leave `.planning/STATE.md` out of commits (GSD artifact).

## File structure

| File | Responsibility | Action |
|------|----------------|--------|
| `backend/holidays_us.py` | Pure federal-holiday date→name computation | Create |
| `backend/sla_engine.py` | Add `BusinessSchedule`, `_to_aware_utc`, `sla_status_dict`, `compute_business_minutes`; refactor `compute_sla_status` | Modify |
| `backend/models.py` | `BusinessHoursConfig`, `LabHoliday` ORM models | Modify |
| `backend/database.py` | Table DDL + config seed in `_run_migrations`; `seed_federal_holidays()` + startup window seeder | Modify |
| `backend/main.py` | Pydantic schemas + 7 endpoints (config GET/PUT, holidays GET/POST/DELETE/generate-federal, `POST /sla/status`) | Modify |
| `backend/tests/test_holidays_us.py` | Federal-holiday unit tests | Create |
| `backend/tests/test_sla_engine.py` | Business-minutes + refactor-regression tests | Modify |
| `backend/tests/test_business_hours_schema.py` | Table/seed schema tests | Create |
| `backend/tests/test_api_business_hours.py` | config + holidays + generate-federal API tests | Create |
| `backend/tests/test_api_sla_status.py` | batch endpoint + "loaded once" test | Create |
| `src/lib/api.ts` | Types + fetch functions for config/holidays/batch-status | Modify |
| `src/services/business-hours.ts` | TanStack Query hooks | Create |
| `src/components/preferences/panes/BusinessHoursPane.tsx` | Schedule + holidays UI | Create |
| `src/components/preferences/PreferencesDialog.tsx` | Register the new pane | Modify |
| `locales/{en,fr,ar}.json` | `preferences.businessHours.*` strings | Modify |
| `src/test/business-hours.test.ts` | Frontend helper test | Create |

---

## Task 1: Federal holiday helper (pure, dependency-free)

**Files:**
- Create: `backend/holidays_us.py`
- Test: `backend/tests/test_holidays_us.py`

> **Spec deviation (deliberate, justified):** The spec types this `us_federal_holidays(year) -> set[date]`, but `lab_holidays.name` requires a display name per row (spec data model, e.g. "Independence Day (observed)"). A bare `set[date]` cannot seed names. This plan returns `dict[date, str]` (observed date → name). Membership tests (`d in holidays`) behave identically on dict keys, so the engine's `is_holiday` is unaffected.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_holidays_us.py`:
```python
"""Unit tests for the dependency-free US federal holiday helper (sub-project B).

Run in the backend container:
    docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_holidays_us.py -q'
"""
from datetime import date

from holidays_us import us_federal_holidays


def test_2026_fixed_and_floating_dates():
    h = us_federal_holidays(2026)
    # Floating
    assert date(2026, 1, 19) in h   # MLK — 3rd Mon Jan
    assert date(2026, 2, 16) in h   # Presidents' — 3rd Mon Feb
    assert date(2026, 5, 25) in h   # Memorial — last Mon May
    assert date(2026, 9, 7) in h    # Labor — 1st Mon Sep
    assert date(2026, 10, 12) in h  # Columbus — 2nd Mon Oct
    assert date(2026, 11, 26) in h  # Thanksgiving — 4th Thu Nov
    # Fixed (no shift in 2026)
    assert date(2026, 1, 1) in h
    assert date(2026, 6, 19) in h
    assert date(2026, 11, 11) in h
    assert date(2026, 12, 25) in h  # Dec 25 2026 is a Friday — no shift


def test_2026_observed_shift_for_july_4_saturday():
    h = us_federal_holidays(2026)
    # Jul 4 2026 is a Saturday -> observed Friday Jul 3
    assert date(2026, 7, 3) in h
    assert date(2026, 7, 4) not in h
    assert h[date(2026, 7, 3)] == "Independence Day (observed)"


def test_sunday_fixed_holiday_shifts_to_monday():
    # New Year's Day 2023-01-01 was a Sunday -> observed Monday Jan 2
    h = us_federal_holidays(2023)
    assert date(2023, 1, 2) in h
    assert date(2023, 1, 1) not in h
    assert h[date(2023, 1, 2)] == "New Year's Day (observed)"


def test_returns_eleven_holidays():
    assert len(us_federal_holidays(2026)) == 11


def test_names_present_and_nonempty():
    for name in us_federal_holidays(2026).values():
        assert isinstance(name, str) and name
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_holidays_us.py -q'`
Expected: FAIL — `ModuleNotFoundError: No module named 'holidays_us'`

- [ ] **Step 3: Write the implementation**

`backend/holidays_us.py`:
```python
"""US federal holidays — pure, dependency-free (sub-project B).

`us_federal_holidays(year)` returns a dict of OBSERVED federal holiday date ->
display name for a year. Used to seed `lab_holidays` rows. No external deps
(no `holidays`/`pandas`) — the rules are stable and few.
"""
from __future__ import annotations

from datetime import date, timedelta


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """The nth (1-based) `weekday` (Mon=0..Sun=6) of month/year."""
    first = date(year, month, 1)
    offset = (weekday - first.weekday()) % 7
    return first + timedelta(days=offset + 7 * (n - 1))


def _last_weekday(year: int, month: int, weekday: int) -> date:
    """The last `weekday` (Mon=0..Sun=6) of month/year."""
    nxt = date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)
    last_day = nxt - timedelta(days=1)
    return last_day - timedelta(days=(last_day.weekday() - weekday) % 7)


def _observed(d: date) -> date:
    """Fixed-date observed shift: Saturday -> Friday, Sunday -> Monday."""
    if d.weekday() == 5:  # Saturday
        return d - timedelta(days=1)
    if d.weekday() == 6:  # Sunday
        return d + timedelta(days=1)
    return d


def us_federal_holidays(year: int) -> dict[date, str]:
    """Observed US federal holiday dates -> display names for `year`."""
    out: dict[date, str] = {}

    def add_fixed(month: int, day: int, name: str) -> None:
        actual = date(year, month, day)
        obs = _observed(actual)
        out[obs] = f"{name} (observed)" if obs != actual else name

    add_fixed(1, 1, "New Year's Day")
    add_fixed(6, 19, "Juneteenth")
    add_fixed(7, 4, "Independence Day")
    add_fixed(11, 11, "Veterans Day")
    add_fixed(12, 25, "Christmas Day")

    out[_nth_weekday(year, 1, 0, 3)] = "Martin Luther King Jr. Day"
    out[_nth_weekday(year, 2, 0, 3)] = "Presidents' Day"
    out[_last_weekday(year, 5, 0)] = "Memorial Day"
    out[_nth_weekday(year, 9, 0, 1)] = "Labor Day"
    out[_nth_weekday(year, 10, 0, 2)] = "Columbus Day"
    out[_nth_weekday(year, 11, 3, 4)] = "Thanksgiving Day"
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_holidays_us.py -q'`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git -C /c/tmp/accu-mk1-wave1 add backend/holidays_us.py backend/tests/test_holidays_us.py
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): dependency-free US federal holiday helper"
git -C /c/tmp/accu-mk1-wave1 push origin feat/order-status-processing-time
```

---

## Task 2: Business-minutes engine + shared status formula

**Files:**
- Modify: `backend/sla_engine.py` (add imports, `BusinessSchedule`, `_to_aware_utc`, `sla_status_dict`, `compute_business_minutes`; refactor `compute_sla_status`)
- Test: `backend/tests/test_sla_engine.py` (append new tests; keep existing tests unchanged)

> **Impact note (already analyzed):** `compute_sla_status` has **zero production callers** — only its own unit tests in `test_sla_engine.py` depend on its output shape. Risk: LOW. The refactor MUST be behavior-preserving: the raw path keeps doing naive `(now - received_at)` subtraction and returns the identical dict. Existing `compute_sla_status` tests are the regression guard — do not modify them; they must stay green.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_sla_engine.py`:
```python
# ── Business-hours engine (sub-project B) ──────────────────────────────
from datetime import time, timezone as _tz
from zoneinfo import ZoneInfo

from sla_engine import (
    BusinessSchedule,
    compute_business_minutes,
    sla_status_dict,
)

_PT = ZoneInfo("America/Los_Angeles")
_SCHED = BusinessSchedule(
    open_time=time(9, 0),
    close_time=time(17, 0),
    timezone="America/Los_Angeles",
    working_days=frozenset({0, 1, 2, 3, 4}),
)
_NO_HOLIDAY = lambda d: False  # noqa: E731


def _utc(y, mo, d, h, mi=0):
    """A Pacific wall-clock instant expressed as NAIVE UTC (codebase convention)."""
    return (
        datetime(y, mo, d, h, mi, tzinfo=_PT)
        .astimezone(_tz.utc)
        .replace(tzinfo=None)
    )


def test_received_after_close_friday_through_weekend_is_zero():
    # Fri 2026-07-10 18:00 PT -> Sat 2026-07-11 14:00 PT
    got = compute_business_minutes(_utc(2026, 7, 10, 18), _utc(2026, 7, 11, 14), _SCHED, _NO_HOLIDAY)
    assert got == 0.0


def test_friday_evening_to_monday_morning_counts_monday_only():
    # Fri 18:00 PT -> Mon 2026-07-13 10:00 PT == Mon 09:00-10:00 == 60 min
    got = compute_business_minutes(_utc(2026, 7, 10, 18), _utc(2026, 7, 13, 10), _SCHED, _NO_HOLIDAY)
    assert got == 60.0


def test_received_before_open_clamps_to_open():
    # Mon 08:00 PT -> Mon 10:00 PT == 09:00-10:00 == 60 min
    got = compute_business_minutes(_utc(2026, 7, 13, 8), _utc(2026, 7, 13, 10), _SCHED, _NO_HOLIDAY)
    assert got == 60.0


def test_received_exactly_at_close_is_zero():
    got = compute_business_minutes(_utc(2026, 7, 13, 17), _utc(2026, 7, 13, 17, 30), _SCHED, _NO_HOLIDAY)
    assert got == 0.0


def test_now_before_received_is_zero():
    got = compute_business_minutes(_utc(2026, 7, 13, 12), _utc(2026, 7, 13, 11), _SCHED, _NO_HOLIDAY)
    assert got == 0.0


def test_received_none_is_zero():
    assert compute_business_minutes(None, _utc(2026, 7, 13, 12), _SCHED, _NO_HOLIDAY) == 0.0


def test_full_working_day_is_480_minutes_in_pdt_and_pst():
    # Summer (PDT) full day Wed 2026-07-08
    pdt = compute_business_minutes(_utc(2026, 7, 8, 0), _utc(2026, 7, 8, 23, 59), _SCHED, _NO_HOLIDAY)
    # Winter (PST) full day Wed 2026-01-14
    pst = compute_business_minutes(_utc(2026, 1, 14, 0), _utc(2026, 1, 14, 23, 59), _SCHED, _NO_HOLIDAY)
    assert pdt == 480.0
    assert pst == 480.0  # DST does not shift the 9-5 window


def test_spans_dst_spring_forward_full_days_still_480_each():
    # Spring-forward is Sun 2026-03-08 (non-working). Mon 03-09 and Tue 03-10 are full working days.
    got = compute_business_minutes(_utc(2026, 3, 9, 0), _utc(2026, 3, 10, 23, 59), _SCHED, _NO_HOLIDAY)
    assert got == 960.0  # 480 + 480


def test_holiday_in_middle_is_skipped():
    # Mon 16:00 -> Wed 10:00, with Tue 2026-07-14 a holiday:
    # Mon 16:00-17:00 (60) + Tue skipped + Wed 09:00-10:00 (60) == 120
    is_holiday = lambda d: d == date(2026, 7, 14)  # noqa: E731
    got = compute_business_minutes(_utc(2026, 7, 13, 16), _utc(2026, 7, 15, 10), _SCHED, is_holiday)
    assert got == 120.0


def test_misconfig_close_before_open_returns_zero():
    bad = BusinessSchedule(time(17, 0), time(9, 0), "America/Los_Angeles", frozenset({0, 1, 2, 3, 4}))
    assert compute_business_minutes(_utc(2026, 7, 13, 0), _utc(2026, 7, 17, 23), bad, _NO_HOLIDAY) == 0.0


def test_misconfig_no_working_days_returns_zero():
    bad = BusinessSchedule(time(9, 0), time(17, 0), "America/Los_Angeles", frozenset())
    assert compute_business_minutes(_utc(2026, 7, 13, 0), _utc(2026, 7, 17, 23), bad, _NO_HOLIDAY) == 0.0


def test_every_day_holiday_returns_zero():
    assert compute_business_minutes(_utc(2026, 7, 13, 0), _utc(2026, 7, 17, 23), _SCHED, lambda d: True) == 0.0


def test_sla_status_dict_shared_formula():
    assert sla_status_dict(100, 40.0) == {
        "target_minutes": 100,
        "elapsed_minutes": 40.0,
        "remaining_minutes": 60.0,
        "breached": False,
    }
    assert sla_status_dict(100, 100.0)["breached"] is False   # strict >
    assert sla_status_dict(100, 100.5)["breached"] is True


def test_compute_sla_status_raw_path_unchanged():
    # Regression: refactor must preserve A's exact output.
    recv = datetime(2026, 7, 13, 9, 0, 0)
    now = datetime(2026, 7, 13, 11, 0, 0)
    assert compute_sla_status(recv, 60, now) == {
        "target_minutes": 60,
        "elapsed_minutes": 120.0,
        "remaining_minutes": -60.0,
        "breached": True,
    }
    assert compute_sla_status(None, 60, now) is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_sla_engine.py -q'`
Expected: FAIL — `ImportError: cannot import name 'BusinessSchedule'`

- [ ] **Step 3: Implement the engine additions and refactor**

In `backend/sla_engine.py`, replace the import block at the top (currently `from datetime import datetime` / `from typing import Mapping, Optional, TypeVar`) with:
```python
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Callable, Mapping, Optional, TypeVar
from zoneinfo import ZoneInfo
```

Add, after the `PRIORITIES`/`T` declarations and before `resolve_sla_tier` (or at the end of the module — order is not load-bearing for these pure helpers):
```python
@dataclass(frozen=True)
class BusinessSchedule:
    """A global business-hours schedule for the business-minutes engine.

    DB-free so the engine stays unit-testable; the API builds one from the
    BusinessHoursConfig row via :meth:`from_orm`.
    """

    open_time: time
    close_time: time
    timezone: str
    working_days: frozenset[int]  # Python weekday ints, Mon=0..Sun=6

    @classmethod
    def from_orm(cls, config) -> "BusinessSchedule":
        return cls(
            open_time=config.open_time,
            close_time=config.close_time,
            timezone=config.timezone,
            working_days=frozenset(config.working_days),
        )


def _to_aware_utc(dt: datetime) -> datetime:
    """Make a datetime tz-aware. Naive datetimes are UTC by codebase convention;
    already-aware datetimes pass through (compared in absolute time)."""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def sla_status_dict(target_minutes: int, elapsed_minutes: float) -> dict:
    """The single SLA status formula shared by the raw and business-hours paths.

    ``breached`` is strict ``>`` — sitting exactly at target is not yet a breach.
    """
    return {
        "target_minutes": target_minutes,
        "elapsed_minutes": elapsed_minutes,
        "remaining_minutes": target_minutes - elapsed_minutes,
        "breached": elapsed_minutes > target_minutes,
    }


def compute_business_minutes(
    received_at: Optional[datetime],
    now: datetime,
    schedule: BusinessSchedule,
    is_holiday: Callable[[date], bool],
) -> float:
    """Business minutes elapsed between ``received_at`` and ``now``.

    Counts only the [open_time, close_time] window on working days in the
    schedule's timezone, skipping holidays. Day-by-day window overlap (not
    minute-by-minute). The clock-start rule falls out of the ``max(...)`` clamp:
    a sample received after close contributes 0 until the next working open.

    Returns 0.0 for no/zero/negative span and for any misconfiguration
    (close <= open, no working days, every day a holiday) — never raises on
    those. Assumes ``schedule.timezone`` is a valid IANA zone (enforced at write
    time by the config PUT validation).
    """
    if received_at is None:
        return 0.0
    start = _to_aware_utc(received_at)
    end = _to_aware_utc(now)
    if end <= start:
        return 0.0
    tz = ZoneInfo(schedule.timezone)
    total = 0.0
    d = start.astimezone(tz).date()
    last = end.astimezone(tz).date()
    while d <= last:
        if d.weekday() in schedule.working_days and not is_holiday(d):
            open_dt = datetime.combine(d, schedule.open_time, tzinfo=tz)
            close_dt = datetime.combine(d, schedule.close_time, tzinfo=tz)
            lo = max(start, open_dt)
            hi = min(end, close_dt)
            if hi > lo:
                total += (hi - lo).total_seconds() / 60.0
        d += timedelta(days=1)
    return total
```

Refactor `compute_sla_status` so the raw path uses the shared formula (keep the docstring's intent; the math is identical):
```python
def compute_sla_status(
    received_at: Optional[datetime],
    target_minutes: int,
    now: datetime,
) -> Optional[dict]:
    """Raw wall-clock SLA status for a sample.

    Returns None when ``received_at`` is None ("Awaiting sample"). Elapsed is raw
    wall-clock here; the business-hours-aware variant is
    :func:`compute_business_minutes`. Both paths return the same shape via
    :func:`sla_status_dict`.
    """
    if received_at is None:
        return None
    elapsed_minutes = (now - received_at).total_seconds() / 60.0
    return sla_status_dict(target_minutes, elapsed_minutes)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_sla_engine.py -q'`
Expected: PASS (all existing resolve_sla_tier + compute_sla_status tests AND the new business-minutes tests)

- [ ] **Step 5: Commit**

```bash
git -C /c/tmp/accu-mk1-wave1 add backend/sla_engine.py backend/tests/test_sla_engine.py
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): business-minutes engine + shared status formula"
git -C /c/tmp/accu-mk1-wave1 push origin feat/order-status-processing-time
```

---

## Task 3: Data model, migration, and federal-holiday seeding

**Files:**
- Modify: `backend/models.py` (imports + 2 models)
- Modify: `backend/database.py` (DDL/seed in `_run_migrations`; `seed_federal_holidays()` + startup window seeder; call from `init_db`)
- Test: `backend/tests/test_business_hours_schema.py`

- [ ] **Step 1: Write the failing test**

`backend/tests/test_business_hours_schema.py`:
```python
"""Schema + seed tests for the business-hours calendar (sub-project B).

These run against the live accumark_mk1 DB AFTER the backend has started (so
init_db has created + seeded the tables). Restart the backend before running:
    docker restart accu-mk1-backend
    docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_business_hours_schema.py -q'
"""
from datetime import date

from sqlalchemy import text

from database import engine, seed_federal_holidays, _seed_federal_holidays_window
from holidays_us import us_federal_holidays


def test_business_hours_config_singleton_seeded():
    with engine.connect() as c:
        rows = c.execute(text("SELECT id, open_time, close_time, timezone, working_days FROM business_hours_config")).fetchall()
    assert len(rows) == 1
    row = rows[0]
    assert row[0] == 1
    assert str(row[1]) == "09:00:00"
    assert str(row[2]) == "17:00:00"
    assert row[3] == "America/Los_Angeles"
    assert list(row[4]) == [0, 1, 2, 3, 4]


def test_federal_holidays_seeded_for_current_year():
    y = date.today().year
    expected = set(us_federal_holidays(y).keys())
    with engine.connect() as c:
        present = {
            r[0]
            for r in c.execute(
                text("SELECT holiday_date FROM lab_holidays WHERE source='federal' AND EXTRACT(year FROM holiday_date)=:y"),
                {"y": y},
            ).fetchall()
        }
    assert expected.issubset(present)


def test_seed_federal_per_year_re_adds_missing_on_explicit_call():
    """The explicit per-year helper (used by POST /lab-holidays/generate-federal)
    re-adds any missing federal row for that year — including one just deleted.
    This is the contract for the user-triggered generate action."""
    year = 2099
    with engine.begin() as c:
        c.execute(text("DELETE FROM lab_holidays WHERE EXTRACT(year FROM holiday_date)=:y"), {"y": year})
        assert seed_federal_holidays(c, year) == 11
        # re-seeding while all rows are present adds nothing
        assert seed_federal_holidays(c, year) == 0
        # delete one, re-seed -> the missing one is re-added (explicit action)
        victim = sorted(us_federal_holidays(year).keys())[0]
        c.execute(text("DELETE FROM lab_holidays WHERE holiday_date=:d"), {"d": victim})
        assert seed_federal_holidays(c, year) == 1
        # cleanup
        c.execute(text("DELETE FROM lab_holidays WHERE EXTRACT(year FROM holiday_date)=:y"), {"y": year})


def test_startup_seeder_is_first_boot_only():
    """After the initial boot, _seed_federal_holidays_window() short-circuits on
    the settings flag — so a federal row the lab deleted stays gone across
    restarts (the durable delete-to-disable guarantee). Self-restoring."""
    y = date.today().year
    # The flag is set because init_db ran on the last restart.
    with engine.connect() as c:
        flag = c.execute(text("SELECT value FROM settings WHERE key='business_hours_federal_initial_seeded'")).scalar()
    assert flag == "true"
    # Delete a real current-year federal row; capture it for restore.
    with engine.begin() as c:
        victim = c.execute(text(
            "SELECT holiday_date, name FROM lab_holidays WHERE source='federal' "
            "AND EXTRACT(year FROM holiday_date)=:y ORDER BY holiday_date LIMIT 1"
        ), {"y": y}).fetchone()
        assert victim is not None
        vdate, vname = victim[0], victim[1]
        c.execute(text("DELETE FROM lab_holidays WHERE holiday_date=:d"), {"d": vdate})
    try:
        _seed_federal_holidays_window()  # simulate a reboot
        with engine.connect() as c:
            still_present = c.execute(text("SELECT 1 FROM lab_holidays WHERE holiday_date=:d"), {"d": vdate}).scalar()
        assert still_present is None  # deletion survived the "reboot"
    finally:
        with engine.begin() as c:
            c.execute(text(
                "INSERT INTO lab_holidays (holiday_date, name, source, created_at) "
                "VALUES (:d, :n, 'federal', NOW()) ON CONFLICT (holiday_date) DO NOTHING"
            ), {"d": vdate, "n": vname})
```

> **Contract (this is the load-bearing behavior, spec line 47):** `ON CONFLICT DO NOTHING` is *not* "won't re-add deleted rows" — it only no-ops on rows that still exist, so an absent (deleted) row gets re-inserted. The durable delete-to-disable guarantee therefore comes from the **startup seeder running only on first boot** (gated by a `settings` flag), NOT from `ON CONFLICT`. The two tests above pin both halves: the explicit per-year helper re-adds missing rows (the user-triggered generate contract), while the startup seeder leaves deletions alone across restarts.

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_business_hours_schema.py -q'`
Expected: FAIL — `ImportError: cannot import name 'seed_federal_holidays'` (and/or relation does not exist)

- [ ] **Step 3a: Add ORM models**

In `backend/models.py`, update the two top imports:
```python
from datetime import datetime, time, date
from sqlalchemy import String, Text, Float, Integer, Boolean, DateTime, Time, Date, ForeignKey, JSON, Column, Table, UniqueConstraint, CheckConstraint
```

Append at the end of `backend/models.py`:
```python
class BusinessHoursConfig(Base):
    """Singleton (id=1) global lab business-hours schedule (sub-project B).

    The business-minutes engine reads open/close/timezone/working_days; the
    per-tier business_hours_only flag (sub-project A) selects whether a tier uses
    it. Exactly one row, enforced by id=1 + the seed guard in _run_migrations.
    """

    __tablename__ = "business_hours_config"

    id: Mapped[int] = mapped_column(primary_key=True)  # always 1
    open_time: Mapped[time] = mapped_column(Time, nullable=False)
    close_time: Mapped[time] = mapped_column(Time, nullable=False)
    timezone: Mapped[str] = mapped_column(String(64), nullable=False, default="America/Los_Angeles")
    working_days: Mapped[list] = mapped_column(JSON, nullable=False, default=lambda: [0, 1, 2, 3, 4])
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def __repr__(self) -> str:
        return f"<BusinessHoursConfig(open={self.open_time}, close={self.close_time}, tz='{self.timezone}')>"


class LabHoliday(Base):
    """A lab closure date — federal (seeded) or custom (user-added). Every row is
    removable; deleting a federal row means the lab works that day (sub-project B)."""

    __tablename__ = "lab_holidays"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    holiday_date: Mapped[date] = mapped_column(Date, nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    source: Mapped[str] = mapped_column(String(10), nullable=False, default="custom")  # 'federal' | 'custom'
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    def __repr__(self) -> str:
        return f"<LabHoliday(date={self.holiday_date}, name='{self.name}', source='{self.source}')>"
```

- [ ] **Step 3b: Add table DDL + config seed to `_run_migrations`**

In `backend/database.py`, append these entries to the `migrations` list in `_run_migrations` (after the SLA-tier block, before the closing `]`):
```python
        # ── Business-hours SLA calendar (sub-project B) ──
        """
        CREATE TABLE IF NOT EXISTS business_hours_config (
            id           INTEGER PRIMARY KEY,
            open_time    TIME NOT NULL,
            close_time   TIME NOT NULL,
            timezone     VARCHAR(64) NOT NULL DEFAULT 'America/Los_Angeles',
            working_days JSON NOT NULL,
            created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """,
        # Seed the singleton: 09:00-17:00, Mon-Fri, Pacific. Idempotent.
        """
        INSERT INTO business_hours_config (id, open_time, close_time, timezone, working_days, created_at, updated_at)
        SELECT 1, '09:00', '17:00', 'America/Los_Angeles', '[0,1,2,3,4]', NOW(), NOW()
        WHERE NOT EXISTS (SELECT 1 FROM business_hours_config)
        """,
        """
        CREATE TABLE IF NOT EXISTS lab_holidays (
            id           SERIAL PRIMARY KEY,
            holiday_date DATE NOT NULL UNIQUE,
            name         VARCHAR(100) NOT NULL,
            source       VARCHAR(10) NOT NULL DEFAULT 'custom',
            created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """,
```

- [ ] **Step 3c: Add the seeding helpers and wire into `init_db`**

In `backend/database.py`, add these module-level functions (after `_run_migrations`):
```python
def seed_federal_holidays(conn, year: int) -> int:
    """Insert any missing federal holiday rows for `year`.

    Idempotent via ON CONFLICT (holiday_date) DO NOTHING. `conn` is a SQLAlchemy
    Connection; the caller owns the transaction (engine.begin() at startup, or the
    request session's connection in the generate-federal endpoint). Returns the
    number of rows actually inserted. Shared by startup seeding and the endpoint.
    """
    from sqlalchemy import text
    from holidays_us import us_federal_holidays

    added = 0
    for d, name in sorted(us_federal_holidays(year).items()):
        result = conn.execute(
            text(
                "INSERT INTO lab_holidays (holiday_date, name, source, created_at) "
                "VALUES (:d, :n, 'federal', NOW()) "
                "ON CONFLICT (holiday_date) DO NOTHING"
            ),
            {"d": d, "n": name},
        )
        added += result.rowcount or 0
    return added


def _seed_federal_holidays_window() -> None:
    """First-boot-ONLY seed of federal holidays for the rolling window
    (current + next 2 years), gated by a settings flag.

    Why first-boot-only: deleting a federal row is how the lab opts out of a
    holiday it works. If this re-ran every boot, ON CONFLICT DO NOTHING would
    re-insert any deleted (absent) row — resurrecting opt-outs. The settings
    flag makes the seeder a no-op after the first successful run, so deletions
    survive restarts. New years enter coverage only via the explicit
    POST /lab-holidays/generate-federal action. Wrapped so a failure never
    blocks boot.
    """
    from sqlalchemy import text
    from datetime import date as _date

    try:
        with engine.begin() as conn:
            already = conn.execute(
                text("SELECT value FROM settings WHERE key='business_hours_federal_initial_seeded'")
            ).scalar()
            if already == "true":
                return
            base = _date.today().year
            for year in (base, base + 1, base + 2):
                seed_federal_holidays(conn, year)
            conn.execute(
                text(
                    "INSERT INTO settings (key, value, updated_at) "
                    "VALUES ('business_hours_federal_initial_seeded', 'true', NOW()) "
                    "ON CONFLICT (key) DO UPDATE SET value='true', updated_at=NOW()"
                )
            )
    except Exception as e:
        log.warning("federal_holiday_seed_skipped err=%s", e)
```

Update `init_db` to call the seeder after `create_all`:
```python
def init_db():
    """Initialize database tables."""
    import models  # noqa: F401
    _run_migrations()
    Base.metadata.create_all(bind=engine)
    _seed_federal_holidays_window()
```

- [ ] **Step 4: Restart the backend, then run the schema test**

```bash
docker restart accu-mk1-backend
curl -fsS http://localhost:8012/health
docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_business_hours_schema.py -q'
```
Expected: `/health` returns ok; schema tests PASS (4 tests). If the backend crash-loops on a transient inter-task import, the test recovers once this task's code is consistent.

Sanity-check the seeded data directly:
```bash
docker exec accu-mk1-backend python -c "from sqlalchemy import text; from database import engine; c=engine.connect(); print('config:', c.execute(text('SELECT * FROM business_hours_config')).fetchall()); print('holiday_count:', c.execute(text('SELECT count(*) FROM lab_holidays')).scalar())"
```
Expected: one config row; holiday_count ≈ 33 (11 × 3 years), minus any year overlap.

- [ ] **Step 5: Commit**

```bash
git -C /c/tmp/accu-mk1-wave1 add backend/models.py backend/database.py backend/tests/test_business_hours_schema.py
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): business_hours_config + lab_holidays tables, federal seeding"
git -C /c/tmp/accu-mk1-wave1 push origin feat/order-status-processing-time
```

---

## Task 4: business-hours-config API (GET/PUT + validation)

**Files:**
- Modify: `backend/main.py` (imports, 2 Pydantic schemas, 2 endpoints)
- Test: `backend/tests/test_api_business_hours.py` (config portion)

- [ ] **Step 1: Write the failing test**

`backend/tests/test_api_business_hours.py`:
```python
"""API tests for business-hours config + holidays (sub-project B).

Self-restoring against the live accumark_mk1 DB.
    docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_business_hours.py -q'
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import auth
from database import engine
from main import app

app.dependency_overrides[auth.get_current_user] = lambda: {"id": 0, "username": "test"}
client = TestClient(app)


@pytest.fixture(autouse=True)
def restore_config():
    with engine.connect() as c:
        before = c.execute(text("SELECT open_time, close_time, timezone, working_days FROM business_hours_config WHERE id=1")).fetchone()
    yield
    if before is not None:
        with engine.begin() as c:
            c.execute(
                text("UPDATE business_hours_config SET open_time=:o, close_time=:cl, timezone=:tz, working_days=:wd WHERE id=1"),
                {"o": before[0], "cl": before[1], "tz": before[2], "wd": __import__("json").dumps(list(before[3]))},
            )


def test_get_returns_seeded_config():
    resp = client.get("/business-hours-config")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["timezone"] == "America/Los_Angeles"
    assert body["working_days"] == [0, 1, 2, 3, 4]
    assert body["open_time"].startswith("09:00")
    assert body["close_time"].startswith("17:00")


def test_put_updates_config():
    resp = client.put("/business-hours-config", json={
        "open_time": "08:30", "close_time": "16:30",
        "timezone": "America/New_York", "working_days": [0, 1, 2, 3, 4, 5],
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["open_time"].startswith("08:30")
    assert body["timezone"] == "America/New_York"
    assert body["working_days"] == [0, 1, 2, 3, 4, 5]


def test_put_rejects_unknown_timezone():
    resp = client.put("/business-hours-config", json={
        "open_time": "09:00", "close_time": "17:00", "timezone": "Mars/Olympus", "working_days": [0, 1, 2, 3, 4],
    })
    assert resp.status_code == 422


def test_put_rejects_close_before_open():
    resp = client.put("/business-hours-config", json={
        "open_time": "17:00", "close_time": "09:00", "timezone": "America/Los_Angeles", "working_days": [0, 1, 2, 3, 4],
    })
    assert resp.status_code == 422


def test_put_rejects_out_of_range_working_days():
    resp = client.put("/business-hours-config", json={
        "open_time": "09:00", "close_time": "17:00", "timezone": "America/Los_Angeles", "working_days": [0, 7],
    })
    assert resp.status_code == 422
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_business_hours.py -q'`
Expected: FAIL — 404 on `/business-hours-config` (endpoint not defined yet)

- [ ] **Step 3a: Update main.py imports**

In `backend/main.py`:
- Line 14: change `from datetime import datetime` to `from datetime import datetime, date, time, timezone`
- Line 36: change `from sqlalchemy import select, desc, delete, update, func` to `from sqlalchemy import select, desc, delete, update, func, extract`
- Add near the other stdlib imports (top of file): `from zoneinfo import ZoneInfo`
- Line 40 (the models import) — append `, BusinessHoursConfig, LabHoliday` to the `from models import ...` list.

- [ ] **Step 3b: Add Pydantic schemas**

In `backend/main.py`, after the `SlaPriorityTierSet` class (~line 1871):
```python
class BusinessHoursConfigResponse(BaseModel):
    open_time: time
    close_time: time
    timezone: str
    working_days: list[int]

    class Config:
        from_attributes = True


class BusinessHoursConfigUpdate(BaseModel):
    open_time: time
    close_time: time
    timezone: str
    working_days: list[int]


class LabHolidayResponse(BaseModel):
    id: int
    holiday_date: date
    name: str
    source: str

    class Config:
        from_attributes = True


class LabHolidayCreate(BaseModel):
    holiday_date: date
    name: str
```

- [ ] **Step 3c: Add the config endpoints**

In `backend/main.py`, after the `delete_sla_priority_tier` endpoint (~line 11988):
```python
# ── Business-hours config (sub-project B) ──────────────────────────────────

@app.get("/business-hours-config", response_model=BusinessHoursConfigResponse)
async def get_business_hours_config(
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """The singleton business-hours schedule. Read-only for non-admins (UI-gated)."""
    cfg = db.get(BusinessHoursConfig, 1)
    if not cfg:
        raise HTTPException(500, "Business-hours config not initialized")
    return cfg


@app.put("/business-hours-config", response_model=BusinessHoursConfigResponse)
async def update_business_hours_config(
    data: BusinessHoursConfigUpdate,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Update the schedule. Validates IANA timezone, close>open, working_days ⊆ 0..6."""
    try:
        ZoneInfo(data.timezone)
    except Exception:
        raise HTTPException(422, f"Unknown timezone: {data.timezone}")
    if data.close_time <= data.open_time:
        raise HTTPException(422, "close_time must be after open_time")
    if not data.working_days or any(d < 0 or d > 6 for d in data.working_days):
        raise HTTPException(422, "working_days must be a non-empty subset of 0..6")
    cfg = db.get(BusinessHoursConfig, 1)
    if not cfg:
        raise HTTPException(500, "Business-hours config not initialized")
    cfg.open_time = data.open_time
    cfg.close_time = data.close_time
    cfg.timezone = data.timezone
    cfg.working_days = sorted(set(data.working_days))
    db.commit()
    db.refresh(cfg)
    return cfg
```

- [ ] **Step 4: Restart backend, run the config tests**

```bash
docker restart accu-mk1-backend
curl -fsS http://localhost:8012/health
docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_business_hours.py -q'
```
Expected: the 5 config tests PASS (holiday tests in this file are added in Task 5 — until then they don't exist).

- [ ] **Step 5: Commit**

```bash
git -C /c/tmp/accu-mk1-wave1 add backend/main.py backend/tests/test_api_business_hours.py
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): business-hours-config GET/PUT with validation"
git -C /c/tmp/accu-mk1-wave1 push origin feat/order-status-processing-time
```

---

## Task 5: lab-holidays API (GET / POST / DELETE / generate-federal)

**Files:**
- Modify: `backend/main.py` (4 endpoints)
- Test: `backend/tests/test_api_business_hours.py` (append holiday tests)

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_api_business_hours.py`:
```python
import datetime as _dt


@pytest.fixture
def cleanup_holidays():
    created = []
    yield created
    if created:
        with engine.begin() as c:
            c.execute(text("DELETE FROM lab_holidays WHERE holiday_date = ANY(:ds)"), {"ds": created})


def test_list_holidays_for_current_year_includes_federal():
    y = _dt.date.today().year
    resp = client.get(f"/lab-holidays?year={y}")
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert any(r["source"] == "federal" for r in rows)
    # ordered by date
    dates = [r["holiday_date"] for r in rows]
    assert dates == sorted(dates)


def test_create_custom_holiday(cleanup_holidays):
    d = "2031-11-28"
    cleanup_holidays.append(d)
    resp = client.post("/lab-holidays", json={"holiday_date": d, "name": "Day after Thanksgiving"})
    assert resp.status_code == 201, resp.text
    assert resp.json()["source"] == "custom"
    assert resp.json()["name"] == "Day after Thanksgiving"


def test_create_duplicate_returns_409(cleanup_holidays):
    d = "2031-12-31"
    cleanup_holidays.append(d)
    assert client.post("/lab-holidays", json={"holiday_date": d, "name": "NYE"}).status_code == 201
    assert client.post("/lab-holidays", json={"holiday_date": d, "name": "NYE again"}).status_code == 409


def test_delete_holiday(cleanup_holidays):
    d = "2031-07-05"
    client.post("/lab-holidays", json={"holiday_date": d, "name": "Extra"})
    resp = client.delete(f"/lab-holidays/{d}")
    assert resp.status_code == 200, resp.text
    # gone now
    assert client.delete(f"/lab-holidays/{d}").status_code == 404


def test_delete_missing_returns_404():
    assert client.delete("/lab-holidays/2031-01-15").status_code == 404


def test_generate_federal_for_year():
    year = 2098
    with engine.begin() as c:
        c.execute(text("DELETE FROM lab_holidays WHERE EXTRACT(year FROM holiday_date)=:y"), {"y": year})
    try:
        resp = client.post(f"/lab-holidays/generate-federal?year={year}")
        assert resp.status_code == 200, resp.text
        assert resp.json()["added"] == 11
        # second call adds nothing (idempotent)
        assert client.post(f"/lab-holidays/generate-federal?year={year}").json()["added"] == 0
    finally:
        with engine.begin() as c:
            c.execute(text("DELETE FROM lab_holidays WHERE EXTRACT(year FROM holiday_date)=:y"), {"y": year})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_business_hours.py -q'`
Expected: the new holiday tests FAIL (404 — endpoints not defined)

- [ ] **Step 3: Add the holiday endpoints**

In `backend/main.py`, after `update_business_hours_config`:
```python
# ── Lab holidays (sub-project B) ───────────────────────────────────────────

@app.get("/lab-holidays", response_model=list[LabHolidayResponse])
async def list_lab_holidays(
    year: Optional[int] = None,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """All stored closures for `year` (defaults to current), federal + custom, ordered by date."""
    y = year if year is not None else date.today().year
    return db.execute(
        select(LabHoliday)
        .where(extract("year", LabHoliday.holiday_date) == y)
        .order_by(LabHoliday.holiday_date)
    ).scalars().all()


@app.post("/lab-holidays", response_model=LabHolidayResponse, status_code=201)
async def create_lab_holiday(
    data: LabHolidayCreate,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Add a custom closure (source='custom'). 409 if a closure already exists on that date."""
    existing = db.execute(
        select(LabHoliday).where(LabHoliday.holiday_date == data.holiday_date)
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(409, f"A closure already exists on {data.holiday_date}")
    row = LabHoliday(holiday_date=data.holiday_date, name=data.name, source="custom")
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@app.delete("/lab-holidays/{holiday_date}")
async def delete_lab_holiday(
    holiday_date: date,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Remove any closure (federal or custom). Deleting a federal row = the lab works that day."""
    row = db.execute(
        select(LabHoliday).where(LabHoliday.holiday_date == holiday_date)
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(404, f"No closure on {holiday_date}")
    db.delete(row)
    db.commit()
    return {"message": f"Closure on {holiday_date} removed"}


@app.post("/lab-holidays/generate-federal")
async def generate_federal_holidays_endpoint(
    year: int,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Insert any missing federal closures for `year`. Primary use: extend
    coverage into a new year. Caveat: this re-adds ANY missing federal date for
    that year — including ones the lab previously deleted — because it's a
    deliberate, user-triggered action. (Startup seeding does NOT do this; it is
    first-boot-only, so deletions survive restarts.)"""
    from database import seed_federal_holidays

    added = seed_federal_holidays(db.connection(), year)
    db.commit()
    return {"year": year, "added": added}
```

- [ ] **Step 4: Restart backend, run the full file**

```bash
docker restart accu-mk1-backend
curl -fsS http://localhost:8012/health
docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_business_hours.py -q'
```
Expected: all config + holiday tests PASS.

- [ ] **Step 5: Commit**

```bash
git -C /c/tmp/accu-mk1-wave1 add backend/main.py backend/tests/test_api_business_hours.py
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): lab-holidays CRUD + generate-federal endpoint"
git -C /c/tmp/accu-mk1-wave1 push origin feat/order-status-processing-time
```

---

## Task 6: POST /sla/status batch endpoint

**Files:**
- Modify: `backend/main.py` (engine import, 4 Pydantic schemas, 1 endpoint)
- Test: `backend/tests/test_api_sla_status.py`

- [ ] **Step 1: Write the failing test**

`backend/tests/test_api_sla_status.py`:
```python
"""API tests for the batch POST /sla/status endpoint (sub-project B).

    docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_sla_status.py -q'
"""
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlalchemy import event

import auth
from database import engine
from main import app

app.dependency_overrides[auth.get_current_user] = lambda: {"id": 0, "username": "test"}
client = TestClient(app)


def _iso_minutes_ago(minutes):
    return (datetime.utcnow() - timedelta(minutes=minutes)).isoformat()


def test_null_received_at_yields_null_status():
    resp = client.post("/sla/status", json={"items": [
        {"key": "a", "received_at": None, "target_minutes": 60, "business_hours_only": False},
    ]})
    assert resp.status_code == 200, resp.text
    item = resp.json()["items"][0]
    assert item["key"] == "a"
    assert item["status"] is None


def test_raw_path_elapsed_and_breach():
    resp = client.post("/sla/status", json={"items": [
        {"key": "k1", "received_at": _iso_minutes_ago(120), "target_minutes": 60, "business_hours_only": False},
    ]})
    item = resp.json()["items"][0]
    assert item["key"] == "k1"
    assert item["status"]["breached"] is True
    assert item["status"]["elapsed_minutes"] >= 119


def test_keys_echoed_and_correlated_not_by_order():
    resp = client.post("/sla/status", json={"items": [
        {"key": "uid-x", "received_at": None, "target_minutes": 60, "business_hours_only": False},
        {"key": "uid-y", "received_at": _iso_minutes_ago(10), "target_minutes": 60, "business_hours_only": False},
    ]})
    by_key = {i["key"]: i for i in resp.json()["items"]}
    assert set(by_key) == {"uid-x", "uid-y"}
    assert by_key["uid-x"]["status"] is None
    assert by_key["uid-y"]["status"] is not None


def test_business_hours_path_differs_from_raw():
    # A 3-day-old sample: raw elapsed is ~4320 min; business elapsed is far less
    # (weekends/after-hours excluded). Just assert business < raw for a bh item.
    received = _iso_minutes_ago(3 * 24 * 60)
    resp = client.post("/sla/status", json={"items": [
        {"key": "raw", "received_at": received, "target_minutes": 60, "business_hours_only": False},
        {"key": "bh", "received_at": received, "target_minutes": 60, "business_hours_only": True},
    ]})
    by_key = {i["key"]: i["status"]["elapsed_minutes"] for i in resp.json()["items"]}
    assert by_key["bh"] <= by_key["raw"]


def test_loaded_once_query_count_is_constant_regardless_of_batch_size():
    # Count statements against config + holidays tables; must not scale with N.
    def _count_for(n):
        seen = {"hits": 0}

        def _listen(conn, cursor, statement, params, context, executemany):
            s = statement.lower()
            if "business_hours_config" in s or "lab_holidays" in s:
                seen["hits"] += 1

        event.listen(engine, "before_cursor_execute", _listen)
        try:
            items = [
                {"key": str(i), "received_at": _iso_minutes_ago(30), "target_minutes": 60, "business_hours_only": True}
                for i in range(n)
            ]
            client.post("/sla/status", json={"items": items})
        finally:
            event.remove(engine, "before_cursor_execute", _listen)
        return seen["hits"]

    assert _count_for(1) == _count_for(50)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_sla_status.py -q'`
Expected: FAIL — 404 on `/sla/status`

- [ ] **Step 3a: Import the engine in main.py**

In `backend/main.py`, add near the other backend-module imports (after the `from database import ...` line):
```python
from sla_engine import BusinessSchedule, compute_business_minutes, sla_status_dict
```

- [ ] **Step 3b: Add the batch schemas**

In `backend/main.py`, after `LabHolidayCreate`:
```python
class SlaStatusRequestItem(BaseModel):
    key: str
    received_at: Optional[datetime] = None
    target_minutes: int
    business_hours_only: bool = False


class SlaStatusRequest(BaseModel):
    items: list[SlaStatusRequestItem]


class SlaStatusResultItem(BaseModel):
    key: str
    status: Optional[dict] = None


class SlaStatusResponse(BaseModel):
    items: list[SlaStatusResultItem]
```

- [ ] **Step 3c: Add the endpoint**

In `backend/main.py`, after `generate_federal_holidays_endpoint`:
```python
@app.post("/sla/status", response_model=SlaStatusResponse)
async def compute_sla_statuses(
    req: SlaStatusRequest,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Batch SLA status for a page of rows (D2's render endpoint).

    Loads the schedule + holiday set ONCE, then maps over items — O(items) with
    O(1) DB reads. `now` is server time; the response is a snapshot. `key` is
    opaque and echoed (the client correlates by key, not array order). `status`
    is null iff `received_at` is null.
    """
    now = datetime.utcnow()  # naive UTC, codebase convention
    cfg = db.get(BusinessHoursConfig, 1)
    schedule = BusinessSchedule.from_orm(cfg) if cfg else None
    holiday_dates = {r[0] for r in db.execute(select(LabHoliday.holiday_date)).all()}
    is_holiday = lambda d: d in holiday_dates  # noqa: E731

    results: list[SlaStatusResultItem] = []
    for item in req.items:
        recv = item.received_at
        if recv is None:
            results.append(SlaStatusResultItem(key=item.key, status=None))
            continue
        # Normalize to naive UTC (an offset-aware ISO string is converted).
        if recv.tzinfo is not None:
            recv = recv.astimezone(timezone.utc).replace(tzinfo=None)
        if item.business_hours_only and schedule is not None:
            elapsed = compute_business_minutes(recv, now, schedule, is_holiday)
        else:
            elapsed = (now - recv).total_seconds() / 60.0
        results.append(
            SlaStatusResultItem(key=item.key, status=sla_status_dict(item.target_minutes, elapsed))
        )
    return SlaStatusResponse(items=results)
```

- [ ] **Step 4: Restart backend, run the test**

```bash
docker restart accu-mk1-backend
curl -fsS http://localhost:8012/health
docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_sla_status.py -q'
```
Expected: all 5 tests PASS (including the loaded-once query-count assertion).

- [ ] **Step 5: Commit**

```bash
git -C /c/tmp/accu-mk1-wave1 add backend/main.py backend/tests/test_api_sla_status.py
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): POST /sla/status batch endpoint (config+holidays loaded once)"
git -C /c/tmp/accu-mk1-wave1 push origin feat/order-status-processing-time
```

---

## Task 7: api.ts client — types + fetch functions

**Files:**
- Modify: `src/lib/api.ts` (add types + functions in the SLA section, after `resolveSlaTier` ~line 3997)

> Mirror the existing SLA client style: raw `fetch` + `getBearerHeaders()` (NOT `apiFetch`). Do NOT add any tier-resolution logic here — `resolveSlaTier` already exists and stays the only client-side resolver. This task only adds config/holiday/batch-status I/O.

- [ ] **Step 1: Write the failing test**

`src/test/business-hours.test.ts`:
```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchSlaStatuses, type SlaStatusRequestItem } from '@/lib/api'

afterEach(() => vi.restoreAllMocks())

describe('fetchSlaStatuses', () => {
  it('POSTs items and returns the items array', async () => {
    const items: SlaStatusRequestItem[] = [
      { key: 'a', received_at: null, target_minutes: 60, business_hours_only: false },
    ]
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [{ key: 'a', status: null }] }), { status: 200 }),
    )
    const result = await fetchSlaStatuses(items)
    expect(result).toEqual([{ key: 'a', status: null }])
    const [, init] = mock.mock.calls[0]
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ items })
  })

  it('throws on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }))
    await expect(fetchSlaStatuses([])).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/business-hours.test.ts'`
Expected: FAIL — `fetchSlaStatuses` is not exported

- [ ] **Step 3: Add the types and functions**

In `src/lib/api.ts`, immediately after `resolveSlaTier` (~line 3997):
```typescript
// ─── Business-hours config + holidays + batch status (sub-project B) ──────────

export interface BusinessHoursConfig {
  open_time: string // "HH:MM:SS"
  close_time: string
  timezone: string
  working_days: number[] // Python weekday ints, Mon=0..Sun=6
}

export interface LabHoliday {
  id: number
  holiday_date: string // "YYYY-MM-DD"
  name: string
  source: 'federal' | 'custom'
}

export interface SlaStatusRequestItem {
  key: string
  received_at: string | null
  target_minutes: number
  business_hours_only: boolean
}

export interface SlaStatus {
  target_minutes: number
  elapsed_minutes: number
  remaining_minutes: number
  breached: boolean
}

export interface SlaStatusResultItem {
  key: string
  status: SlaStatus | null
}

export async function getBusinessHoursConfig(): Promise<BusinessHoursConfig> {
  const response = await fetch(`${API_BASE_URL()}/business-hours-config`, { headers: getBearerHeaders() })
  if (!response.ok) throw new Error(`Failed to load business hours: ${response.status}`)
  return response.json()
}

export async function updateBusinessHoursConfig(data: BusinessHoursConfig): Promise<BusinessHoursConfig> {
  const response = await fetch(`${API_BASE_URL()}/business-hours-config`, {
    method: 'PUT', headers: getBearerHeaders('application/json'), body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(`Failed to save business hours: ${response.status}`)
  return response.json()
}

export async function getLabHolidays(year: number): Promise<LabHoliday[]> {
  const response = await fetch(`${API_BASE_URL()}/lab-holidays?year=${year}`, { headers: getBearerHeaders() })
  if (!response.ok) throw new Error(`Failed to load holidays: ${response.status}`)
  return response.json()
}

export async function createLabHoliday(data: { holiday_date: string; name: string }): Promise<LabHoliday> {
  const response = await fetch(`${API_BASE_URL()}/lab-holidays`, {
    method: 'POST', headers: getBearerHeaders('application/json'), body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(`Failed to add holiday: ${response.status}`)
  return response.json()
}

export async function deleteLabHoliday(holidayDate: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL()}/lab-holidays/${holidayDate}`, {
    method: 'DELETE', headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Failed to remove holiday: ${response.status}`)
}

export async function generateFederalHolidays(year: number): Promise<{ year: number; added: number }> {
  const response = await fetch(`${API_BASE_URL()}/lab-holidays/generate-federal?year=${year}`, {
    method: 'POST', headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Failed to generate federal holidays: ${response.status}`)
  return response.json()
}

export async function fetchSlaStatuses(items: SlaStatusRequestItem[]): Promise<SlaStatusResultItem[]> {
  const response = await fetch(`${API_BASE_URL()}/sla/status`, {
    method: 'POST', headers: getBearerHeaders('application/json'), body: JSON.stringify({ items }),
  })
  if (!response.ok) throw new Error(`Failed to fetch SLA statuses: ${response.status}`)
  const data = await response.json()
  return data.items
}
```

- [ ] **Step 4: Run test + typecheck**

```bash
docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/business-hours.test.ts'
npm --prefix /c/tmp/accu-mk1-wave1 run typecheck
```
Expected: vitest PASS (2 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git -C /c/tmp/accu-mk1-wave1 add src/lib/api.ts src/test/business-hours.test.ts
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): api.ts client for business-hours config/holidays/batch-status"
git -C /c/tmp/accu-mk1-wave1 push origin feat/order-status-processing-time
```

---

## Task 8: TanStack Query service hooks

**Files:**
- Create: `src/services/business-hours.ts`

> Mirror `src/services/sla.ts` exactly (queryKeys object, `useQuery`/`useMutation`, `toast` on success/error, `invalidateQueries`).

- [ ] **Step 1: Write the implementation** (no separate unit test — these are thin wrappers covered by the pane render + the api.ts test; consistent with `sla.ts` having no dedicated hook test)

`src/services/business-hours.ts`:
```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  getBusinessHoursConfig, updateBusinessHoursConfig,
  getLabHolidays, createLabHoliday, deleteLabHoliday, generateFederalHolidays,
  type BusinessHoursConfig, type LabHoliday,
} from '@/lib/api'

export const businessHoursQueryKeys = {
  config: ['business-hours', 'config'] as const,
  holidays: (year: number) => ['business-hours', 'holidays', year] as const,
}

export function useBusinessHoursConfig() {
  return useQuery({
    queryKey: businessHoursQueryKeys.config,
    queryFn: getBusinessHoursConfig,
    staleTime: 1000 * 60 * 5,
  })
}

export function useUpdateBusinessHoursConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: BusinessHoursConfig) => updateBusinessHoursConfig(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: businessHoursQueryKeys.config })
      toast.success('Business hours saved')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useLabHolidays(year: number) {
  return useQuery({
    queryKey: businessHoursQueryKeys.holidays(year),
    queryFn: () => getLabHolidays(year),
    staleTime: 1000 * 60 * 5,
  })
}

export function useCreateLabHoliday(year: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: { holiday_date: string; name: string }) => createLabHoliday(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: businessHoursQueryKeys.holidays(year) })
      toast.success('Closure added')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDeleteLabHoliday(year: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (holidayDate: string) => deleteLabHoliday(holidayDate),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: businessHoursQueryKeys.holidays(year) })
      toast.success('Closure removed')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useGenerateFederalHolidays(year: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (targetYear: number) => generateFederalHolidays(targetYear),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: businessHoursQueryKeys.holidays(year) })
      toast.success(`Added ${result.added} federal holiday${result.added === 1 ? '' : 's'}`)
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export type { BusinessHoursConfig, LabHoliday }
```

- [ ] **Step 2: Typecheck**

Run: `npm --prefix /c/tmp/accu-mk1-wave1 run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git -C /c/tmp/accu-mk1-wave1 add src/services/business-hours.ts
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): TanStack Query hooks for business-hours config + holidays"
git -C /c/tmp/accu-mk1-wave1 push origin feat/order-status-processing-time
```

---

## Task 9a: BusinessHoursPane component + i18n keys

**Files:**
- Create: `src/components/preferences/panes/BusinessHoursPane.tsx`
- Modify: `locales/en.json`, `locales/fr.json`, `locales/ar.json` (add the SAME English `preferences.businessHours.*` keys to all three — matches the existing SLA-key convention)

- [ ] **Step 1: Add the i18n keys**

Add these entries to `locales/en.json`, `locales/fr.json`, AND `locales/ar.json` (identical English text in each; insert next to the existing `preferences.sla.*` block — JSON key order is not significant):
```json
  "preferences.businessHours": "Business Hours",
  "preferences.businessHours.readOnly": "You have read-only access to business-hours settings.",
  "preferences.businessHours.loadError": "Failed to load business-hours settings.",
  "preferences.businessHours.schedule": "Schedule",
  "preferences.businessHours.scheduleDescription": "The lab's working hours. Business-hours SLA tiers measure elapsed time only within this window.",
  "preferences.businessHours.openTime": "Open",
  "preferences.businessHours.closeTime": "Close",
  "preferences.businessHours.timezone": "Timezone",
  "preferences.businessHours.timezoneHint": "IANA name, e.g. America/Los_Angeles.",
  "preferences.businessHours.workingDays": "Working days",
  "preferences.businessHours.save": "Save schedule",
  "preferences.businessHours.holidays": "Holidays & closures",
  "preferences.businessHours.holidaysDescription": "Days the lab is closed. Federal holidays are pre-loaded; remove any row (including federal) for a day the lab works.",
  "preferences.businessHours.federalTag": "U.S. federal",
  "preferences.businessHours.customTag": "Custom",
  "preferences.businessHours.addClosure": "Add closure",
  "preferences.businessHours.closureName": "Name",
  "preferences.businessHours.closureNamePlaceholder": "e.g. Day after Thanksgiving",
  "preferences.businessHours.generateFederal": "Generate federal holidays for {{year}}",
  "preferences.businessHours.noHolidays": "No closures recorded for this year.",
  "preferences.businessHours.year": "Year",
  "preferences.businessHours.mon": "Mon",
  "preferences.businessHours.tue": "Tue",
  "preferences.businessHours.wed": "Wed",
  "preferences.businessHours.thu": "Thu",
  "preferences.businessHours.fri": "Fri",
  "preferences.businessHours.sat": "Sat",
  "preferences.businessHours.sun": "Sun",
```

- [ ] **Step 2: Write the component**

`src/components/preferences/panes/BusinessHoursPane.tsx`:
```typescript
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { SettingsSection } from '../shared/SettingsComponents'
import { useAuthStore } from '@/store/auth-store'
import {
  useBusinessHoursConfig, useUpdateBusinessHoursConfig,
  useLabHolidays, useCreateLabHoliday, useDeleteLabHoliday, useGenerateFederalHolidays,
} from '@/services/business-hours'
import type { BusinessHoursConfig } from '@/lib/api'

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

function hhmm(value: string): string {
  return value.slice(0, 5) // "09:00:00" -> "09:00"
}

export function BusinessHoursPane() {
  const { t } = useTranslation()
  const isAdmin = useAuthStore(state => state.user?.role === 'admin')
  const configQuery = useBusinessHoursConfig()
  const [year, setYear] = useState(new Date().getFullYear())
  const holidaysQuery = useLabHolidays(year)

  if (configQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (configQuery.isError || !configQuery.data) {
    return <p className="text-sm text-destructive">{t('preferences.businessHours.loadError')}</p>
  }

  return (
    <div className="space-y-8">
      {!isAdmin && (
        <p className="text-sm text-muted-foreground">{t('preferences.businessHours.readOnly')}</p>
      )}

      <ScheduleSection config={configQuery.data} readOnly={!isAdmin} />

      <HolidaysSection
        year={year}
        onYearChange={setYear}
        readOnly={!isAdmin}
        isLoading={holidaysQuery.isLoading}
        isError={holidaysQuery.isError}
        holidays={holidaysQuery.data ?? []}
      />
    </div>
  )
}

function ScheduleSection({ config, readOnly }: { config: BusinessHoursConfig; readOnly: boolean }) {
  const { t } = useTranslation()
  const update = useUpdateBusinessHoursConfig()
  const [open, setOpen] = useState(hhmm(config.open_time))
  const [close, setClose] = useState(hhmm(config.close_time))
  const [tz, setTz] = useState(config.timezone)
  const [days, setDays] = useState<number[]>(config.working_days)

  const toggleDay = (idx: number) => {
    setDays(prev => (prev.includes(idx) ? prev.filter(d => d !== idx) : [...prev, idx].sort((a, b) => a - b)))
  }

  const save = () => {
    update.mutate({ open_time: open, close_time: close, timezone: tz, working_days: days })
  }

  return (
    <SettingsSection title={t('preferences.businessHours.schedule')}>
      <p className="text-sm text-muted-foreground">{t('preferences.businessHours.scheduleDescription')}</p>
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('preferences.businessHours.openTime')}</span>
          <Input className="h-8 w-32" type="time" value={open} disabled={readOnly}
            onChange={e => setOpen(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('preferences.businessHours.closeTime')}</span>
          <Input className="h-8 w-32" type="time" value={close} disabled={readOnly}
            onChange={e => setClose(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('preferences.businessHours.timezone')}</span>
          <Input className="h-8 w-56" value={tz} disabled={readOnly}
            onChange={e => setTz(e.target.value)} />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{t('preferences.businessHours.timezoneHint')}</p>
      <div className="space-y-2">
        <span className="text-sm text-muted-foreground">{t('preferences.businessHours.workingDays')}</span>
        <div className="flex flex-wrap gap-3">
          {DAY_KEYS.map((dayKey, idx) => (
            <label key={dayKey} className="flex items-center gap-1.5 text-sm">
              <Checkbox checked={days.includes(idx)} disabled={readOnly}
                onCheckedChange={() => toggleDay(idx)} />
              {t(`preferences.businessHours.${dayKey}`)}
            </label>
          ))}
        </div>
      </div>
      {!readOnly && (
        <Button size="sm" onClick={save} disabled={update.isPending}>
          {t('preferences.businessHours.save')}
        </Button>
      )}
    </SettingsSection>
  )
}

function HolidaysSection({
  year, onYearChange, readOnly, isLoading, isError, holidays,
}: {
  year: number
  onYearChange: (y: number) => void
  readOnly: boolean
  isLoading: boolean
  isError: boolean
  holidays: { id: number; holiday_date: string; name: string; source: 'federal' | 'custom' }[]
}) {
  const { t } = useTranslation()
  const createHoliday = useCreateLabHoliday(year)
  const deleteHoliday = useDeleteLabHoliday(year)
  const generateFederal = useGenerateFederalHolidays(year)
  const [newDate, setNewDate] = useState('')
  const [newName, setNewName] = useState('')

  const addClosure = () => {
    if (!newDate || !newName.trim()) return
    createHoliday.mutate({ holiday_date: newDate, name: newName.trim() }, {
      onSuccess: () => { setNewDate(''); setNewName('') },
    })
  }

  return (
    <SettingsSection title={t('preferences.businessHours.holidays')}>
      <p className="text-sm text-muted-foreground">{t('preferences.businessHours.holidaysDescription')}</p>

      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">{t('preferences.businessHours.year')}</span>
        <Input className="h-8 w-24" type="number" value={String(year)}
          onChange={e => onYearChange(parseInt(e.target.value, 10) || year)} />
        {!readOnly && (
          <Button size="sm" variant="outline" disabled={generateFederal.isPending}
            onClick={() => generateFederal.mutate(year)}>
            {t('preferences.businessHours.generateFederal', { year })}
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
      ) : isError ? (
        <p className="text-sm text-destructive">{t('preferences.businessHours.loadError')}</p>
      ) : holidays.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('preferences.businessHours.noHolidays')}</p>
      ) : (
        <div className="space-y-1">
          {holidays.map(h => (
            <div key={h.id} className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm">
              <span className="w-28 font-mono text-xs">{h.holiday_date}</span>
              <span className="flex-1">{h.name}</span>
              <Badge variant="outline" className="text-[10px]">
                {h.source === 'federal'
                  ? t('preferences.businessHours.federalTag')
                  : t('preferences.businessHours.customTag')}
              </Badge>
              {!readOnly && (
                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive"
                  onClick={() => deleteHoliday.mutate(h.holiday_date)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {!readOnly && (
        <div className="flex flex-wrap items-end gap-2 pt-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('preferences.businessHours.year')}</span>
            <Input className="h-8 w-40" type="date" value={newDate}
              onChange={e => setNewDate(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('preferences.businessHours.closureName')}</span>
            <Input className="h-8 w-64" value={newName}
              placeholder={t('preferences.businessHours.closureNamePlaceholder')}
              onChange={e => setNewName(e.target.value)} />
          </label>
          <Button size="sm" disabled={createHoliday.isPending || !newDate || !newName.trim()} onClick={addClosure}>
            <Plus className="mr-1 h-4 w-4" /> {t('preferences.businessHours.addClosure')}
          </Button>
        </div>
      )}
    </SettingsSection>
  )
}
```

- [ ] **Step 3: Typecheck**

Run: `npm --prefix /c/tmp/accu-mk1-wave1 run typecheck`
Expected: clean. (Confirm `@/components/ui/checkbox` exists — it does: `src/components/ui/checkbox.tsx`.)

- [ ] **Step 4: Commit**

```bash
git -C /c/tmp/accu-mk1-wave1 add src/components/preferences/panes/BusinessHoursPane.tsx locales/en.json locales/fr.json locales/ar.json
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): Business Hours preferences pane + i18n keys"
git -C /c/tmp/accu-mk1-wave1 push origin feat/order-status-processing-time
```

---

## Task 9b: Register the pane in PreferencesDialog

**Files:**
- Modify: `src/components/preferences/PreferencesDialog.tsx`

- [ ] **Step 1: Wire the new pane**

In `src/components/preferences/PreferencesDialog.tsx`:

1. Add the icon import (line 3) — add `CalendarClock` to the lucide import:
```typescript
import { Settings, Palette, Zap, Database, Timer, CalendarClock } from 'lucide-react'
```
2. Import the pane (after the `SlaPane` import, line 33):
```typescript
import { BusinessHoursPane } from './panes/BusinessHoursPane'
```
3. Extend the `PreferencePane` union (line 35):
```typescript
type PreferencePane = 'general' | 'appearance' | 'dataPipeline' | 'sla' | 'businessHours' | 'advanced'
```
4. Add a `navigationItems` entry — insert this object immediately after the `sla` item (after line 57, before the `advanced` item):
```typescript
  {
    id: 'businessHours' as const,
    labelKey: 'preferences.businessHours',
    icon: CalendarClock,
  },
```
5. Add the render case — after the `sla` line in the pane switch (line 136):
```typescript
              {activePane === 'businessHours' && <BusinessHoursPane />}
```

- [ ] **Step 2: Typecheck**

Run: `npm --prefix /c/tmp/accu-mk1-wave1 run typecheck`
Expected: clean.

- [ ] **Step 3: Restart frontend and smoke-check via the API (Playwright on :3101 is degraded — verify via DOM/API, per the handoff)**

```bash
docker restart accu-mk1-frontend
```
Then in the `:3101` browser devtools console (or via `browser_evaluate`):
```javascript
fetch('http://localhost:8012/business-hours-config', { headers: { Authorization: 'Bearer ' + localStorage.accu_mk1_auth_token } }).then(r => r.json()).then(console.log)
```
Expected: the seeded config object. (The pane itself opens via the Tauri native menu; the API smoke is the reliable signal that the chain is wired.)

- [ ] **Step 4: Commit**

```bash
git -C /c/tmp/accu-mk1-wave1 add src/components/preferences/PreferencesDialog.tsx
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): register Business Hours pane in PreferencesDialog"
git -C /c/tmp/accu-mk1-wave1 push origin feat/order-status-processing-time
```

---

## Task 10: Full verification sweep

**Files:** none (verification only)

- [ ] **Step 1: Backend — full SLA + regression suite**

Run:
```bash
docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest \
  tests/test_holidays_us.py \
  tests/test_sla_engine.py \
  tests/test_business_hours_schema.py \
  tests/test_api_business_hours.py \
  tests/test_api_sla_status.py \
  tests/test_sla_schema.py \
  tests/test_api_sla_tiers.py \
  tests/test_api_sla_priority_tiers.py \
  tests/test_api_service_group_sla_tier.py \
  tests/test_api_peptide_requests_read.py -q'
```
Expected: all PASS (new B suites + the A/C suites + the peptide-requests regression all green).

- [ ] **Step 2: Frontend — typecheck + vitest (B + A/D1 regression)**

Run:
```bash
npm --prefix /c/tmp/accu-mk1-wave1 run typecheck
docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run \
  src/test/business-hours.test.ts \
  src/test/sla-resolver.test.ts \
  src/test/explorer-helpers.test.ts \
  src/test/order-row.test.tsx'
```
Expected: typecheck clean; all vitest PASS.

- [ ] **Step 3: Lint the changed frontend files only**

Run: `npm --prefix /c/tmp/accu-mk1-wave1 run lint -- src/lib/api.ts src/services/business-hours.ts src/components/preferences/panes/BusinessHoursPane.tsx src/components/preferences/PreferencesDialog.tsx`
Expected: no NEW errors. (Ignore the 3 pre-existing baseline errors in `api.ts` ~lines 1730/3224/3757.)

- [ ] **Step 4: Live end-to-end smoke (browser-authed)**

In the `:3101` devtools console / via `browser_evaluate`, with `T = localStorage.accu_mk1_auth_token`:
```javascript
// 1. config round-trip
await fetch('http://localhost:8012/business-hours-config', { headers: { Authorization: 'Bearer ' + T } }).then(r => r.json())
// 2. batch status: a business-hours item vs a raw item, 3 days old
await fetch('http://localhost:8012/sla/status', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + T, 'Content-Type': 'application/json' },
  body: JSON.stringify({ items: [
    { key: 'raw', received_at: new Date(Date.now() - 3*864e5).toISOString(), target_minutes: 60, business_hours_only: false },
    { key: 'bh',  received_at: new Date(Date.now() - 3*864e5).toISOString(), target_minutes: 60, business_hours_only: true },
  ] }),
}).then(r => r.json())
```
Expected: (1) seeded config; (2) two items echoed by key, `bh.status.elapsed_minutes` < `raw.status.elapsed_minutes`.

- [ ] **Step 5: `detect_changes` then final commit**

```bash
git -C /c/tmp/accu-mk1-wave1 status --short
```
Run `gitnexus_detect_changes()` (advisory — index targets the OneDrive checkout; expect low/empty for this additive worktree work). Confirm only the expected B files changed across the task commits. No extra commit needed if Tasks 1–9b each committed; otherwise commit any straggler verification fixes.

---

## Self-Review (completed by plan author)

**Spec coverage** — every spec section maps to a task:
- Data model (`business_hours_config`, `lab_holidays`) → Task 3
- Federal helper `us_federal_holidays` → Task 1 (deviation noted: returns `dict[date,str]` for naming)
- Engine (`compute_business_minutes`, shared `sla_status_dict`, refactor) → Task 2
- API (config GET/PUT, holidays GET/POST/DELETE, generate-federal, `POST /sla/status`) → Tasks 4, 5, 6
- "Business Hours" pane → Tasks 9a, 9b
- "Loaded once" O(items) → Task 6 query-count test
- Migration idempotent + durable delete-to-disable → Task 3 (startup seeder is first-boot-only, gated by a `settings` flag; ON CONFLICT alone does NOT give non-resurrection — corrected from the spec's stated mechanism)
- DST correctness → Task 2 DST tests
- Misconfig returns 0.0 → Task 2 misconfig tests

**Placeholder scan** — no TBD/TODO/"add appropriate"; every code step has complete code.

**Type consistency** — `BusinessSchedule` fields (open_time/close_time/timezone/working_days) match `from_orm` and the ORM `BusinessHoursConfig`; the `/sla/status` request/response shape matches the api.ts `SlaStatusRequestItem`/`SlaStatusResultItem`/`SlaStatus` interfaces; `seed_federal_holidays(conn, year)` signature matches both callers (startup `engine.begin()` and the endpoint `db.connection()`).
