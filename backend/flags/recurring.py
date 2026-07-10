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
