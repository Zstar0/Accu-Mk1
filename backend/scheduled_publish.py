"""Scheduled COA publish (2026-09-17).

Why: the lab finishes faster than the 48 to 72 hour turnaround customers see,
and the faster turnaround is to be sold as a premium tier later. So a finished
COA is parked and published on the normal cadence instead of the moment the
lab is done. This module owns the parked rows (``lims_scheduled_publishes``),
the suggested time, and the scheduler job that fires the publish.

Design (Handler rulings 2026-09-17):

* Scheduling REGENERATES the draft with the PDF "Published Date" = the
  scheduled lab-local date (coabuilder ``published_date_override``), so what
  the lab reviews is what ships; the job at fire time runs the ordinary
  publish route and nothing else.
* Suggested time = received + a random 50 to 70 clock hours, where closed
  days (weekends, lab holidays) do not count, clamped to one hour before the
  sample's SLA deadline. Never inside the quiet window.
* Quiet window: nothing fires between 22:00 and 05:00 lab time.
* A fire that fails is marked ``failed``, gets a flag, and is never retried
  by machine: a half-completed publish is not safe to re-run blind.

Row lifecycle: pending -> firing -> published | failed; pending/failed ->
cancelled. The job claims a row with a conditional UPDATE before publishing,
so a row can never fire twice. Single uvicorn process by design (same
contract as flags.scheduler).

Naive UTC everywhere in the DB, per codebase convention; lab time only at the
edges (pdf date, quiet window, suggestion walk).
"""
from __future__ import annotations

import logging
import random
from datetime import date, datetime, time, timedelta, timezone
from typing import Callable, Optional
from zoneinfo import ZoneInfo

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from models import (
    AnalysisProfile,
    BusinessHoursConfig,
    LabHoliday,
    LimsAnalysis,
    LimsSample,
    LimsSampleTransition,
    LimsScheduledPublish,
    LimsSubSampleEvent,
    ServiceGroup,
    SlaPriorityTier,
    SlaTier,
    User,
    analysis_profile_members,
    service_group_members,
)
from sla_engine import BusinessSchedule, resolve_sla_tier

logger = logging.getLogger(__name__)

SUGGEST_HOURS = (50.0, 70.0)
# The SLA window the 50 to 70 hour rule was written against (the 3-day tier).
# Other tiers get the same SHARE of their own window.
SUGGEST_WINDOW_HOURS = 72.0
QUIET_START = time(22, 0)   # lab time
QUIET_END = time(5, 0)
# Schedule must be this far out: covers the insert-then-regenerate window
# (variance lots take minutes per vial COA).
MIN_LEAD = timedelta(minutes=30)
# The publish runs on the scheduler's event loop; a 05:00 backlog drains a
# few per minute rather than starving the other jobs.
MAX_PER_TICK = 5
SLA_MARGIN = timedelta(minutes=60)
FLAG_TYPE = "scheduled_publish_failed"
DEFAULT_TZ = "America/Los_Angeles"

ACTIVE_STATUSES = ("pending", "firing", "failed")
PARKED_STATUSES = ("pending", "firing")


class PublishInProgress(Exception):
    """The row is `firing`: the job owns it until the publish settles."""


# ── time helpers ─────────────────────────────────────────────────────────────

def to_naive_utc(dt: datetime) -> datetime:
    """An offset-aware datetime -> the naive UTC the DB stores. Naive input is
    rejected: a browser value with no offset is ambiguous."""
    if dt.tzinfo is None:
        raise ValueError("scheduled_at must carry a timezone offset")
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


def _aware(naive_utc: datetime) -> datetime:
    return naive_utc.replace(tzinfo=timezone.utc)


def _to_naive(aware: datetime) -> datetime:
    return aware.astimezone(timezone.utc).replace(tzinfo=None)


def iso_z(dt: Optional[datetime]) -> Optional[str]:
    """Naive UTC -> ISO with a Z suffix (a bare naive string parses as local
    time in JavaScript)."""
    return None if dt is None else dt.replace(microsecond=0).isoformat() + "Z"


def lab_schedule(db: Session) -> BusinessSchedule:
    """The same fallback shape the Ready to Publish loader uses."""
    cfg = db.get(BusinessHoursConfig, 1)
    return BusinessSchedule(
        open_time=(cfg.open_time if cfg else time(9, 0)),
        close_time=(cfg.close_time if cfg else time(17, 0)),
        timezone=(cfg.timezone if cfg and cfg.timezone else DEFAULT_TZ),
        working_days=frozenset(cfg.working_days) if cfg and cfg.working_days else frozenset({0, 1, 2, 3, 4}),
    )


def lab_holidays(db: Session) -> frozenset:
    return frozenset(r[0] for r in db.execute(select(LabHoliday.holiday_date)).all())


def lab_tz(db: Session) -> str:
    return lab_schedule(db).timezone


def pdf_date(at_naive_utc: datetime, tz_name: str) -> str:
    """MM/DD/YYYY in lab time, the format coabuilder validates."""
    return _aware(at_naive_utc).astimezone(ZoneInfo(tz_name)).strftime("%m/%d/%Y")


def in_quiet_window(at_naive_utc: datetime, tz_name: str) -> bool:
    t = _aware(at_naive_utc).astimezone(ZoneInfo(tz_name)).time()
    return t >= QUIET_START or t < QUIET_END


def _is_open_day(d: date, schedule: BusinessSchedule, is_holiday: Callable[[date], bool]) -> bool:
    return d.weekday() in schedule.working_days and not is_holiday(d)


def _next_open_day(d: date, schedule: BusinessSchedule, is_holiday: Callable[[date], bool]) -> date:
    for _ in range(366):
        if _is_open_day(d, schedule, is_holiday):
            return d
        d += timedelta(days=1)
    return d  # no open day at all: misconfigured calendar, fall through


def add_open_day_hours(start_naive_utc: datetime, hours: float, schedule: BusinessSchedule,
                       is_holiday: Callable[[date], bool]) -> datetime:
    """Advance `hours` of clock time counting only open days: a closed day
    (weekend, holiday) is skipped whole. Received Thu 14:00 + 60h lands
    Tue 02:00, not Sun 02:00."""
    tz = ZoneInfo(schedule.timezone)
    cur = _aware(start_naive_utc).astimezone(tz)
    remaining = timedelta(hours=hours)
    for _ in range(400):
        if remaining <= timedelta(0):
            break
        if _is_open_day(cur.date(), schedule, is_holiday):
            day_end = datetime.combine(cur.date() + timedelta(days=1), time(0), tzinfo=tz)
            step = min(remaining, day_end - cur)
            cur += step
            remaining -= step
        else:
            cur = datetime.combine(cur.date() + timedelta(days=1), time(0), tzinfo=tz)
    return _to_naive(cur)


def add_business_minutes(start_naive_utc: datetime, minutes: float, schedule: BusinessSchedule,
                         is_holiday: Callable[[date], bool]) -> datetime:
    """The inverse of sla_engine.compute_business_minutes: the instant at which
    `minutes` of business time have elapsed since `start`. Same day-window
    rule (open..close on working days, holidays skipped), so
    compute_business_minutes(start, add_business_minutes(start, m)) == m."""
    tz = ZoneInfo(schedule.timezone)
    cur = _aware(start_naive_utc).astimezone(tz)
    remaining = float(minutes)
    for _ in range(3660):
        d = cur.date()
        if _is_open_day(d, schedule, is_holiday):
            open_dt = datetime.combine(d, schedule.open_time, tzinfo=tz)
            close_dt = datetime.combine(d, schedule.close_time, tzinfo=tz)
            lo = max(cur, open_dt)
            if lo < close_dt:
                avail = (close_dt - lo).total_seconds() / 60.0
                if remaining <= avail:
                    return _to_naive(lo + timedelta(minutes=remaining))
                remaining -= avail
        cur = datetime.combine(d + timedelta(days=1), time(0), tzinfo=tz)
    raise ValueError("no working time in the lab calendar")


def push_out_of_quiet(at_naive_utc: datetime, schedule: BusinessSchedule,
                      is_holiday: Callable[[date], bool], rng=random) -> datetime:
    """A time inside the quiet window moves to a random minute between 05:00
    and 08:00 of the next open day, so an overnight pile-up spreads out
    instead of stacking at 05:00 sharp."""
    if not in_quiet_window(at_naive_utc, schedule.timezone):
        return at_naive_utc
    tz = ZoneInfo(schedule.timezone)
    local = _aware(at_naive_utc).astimezone(tz)
    d = local.date() + timedelta(days=1) if local.time() >= QUIET_START else local.date()
    d = _next_open_day(d, schedule, is_holiday)
    morning = datetime.combine(d, QUIET_END, tzinfo=tz) + timedelta(minutes=rng.uniform(0, 180))
    return _to_naive(morning)


# ── SLA deadline for ONE sample ──────────────────────────────────────────────

def resolve_tier(db: Session, sample: LimsSample) -> Optional[SlaTier]:
    """The SLA tier that governs the NEXT publish of this sample.

    Each of the sample's services resolves to ONE tier, in the precedence the
    lab configures SLAs with (Handler 2026-09-17: tiers hang off ANALYSIS
    PROFILES, not service groups; mirrors src/lib/sla-resolution.ts):
      1. the tightest tiered ACTIVE analysis profile the service belongs to
         (prod: "Sterility USP 71" -> USP71 6720 min, "Endotoxin USP85 LAL"
         -> Microbiology 1440 min);
      2. else the tightest tier of a service group it sits in;
      3. else the default tier (prod: every HPLC service lands here).
    The profile step applies whether or not the service is in a group. Prod's
    USP 71 services (BACTERIA, FUNGI) are in no group; gating on group
    membership, as the frontend's per-group resolver does, would silently
    judge every USP 71 sample against the 3-day tier.

    Across the sample's services:
    * Nothing delivered yet: the TIGHTEST tier. The first (possibly partial)
      COA is the fast work and owes the fast deadline.
    * A COA already went out (a `coa_published` event exists): the LOOSEST.
      What remains is by construction the slow work (USP 71 sterility), and
      judging it against the 3-day tier would call every such sample late.

    A global priority override for the sample's effective priority beats all
    of it (sla_engine.resolve_sla_tier precedence).
    """
    tiers = {t.id: t for t in db.execute(select(SlaTier)).scalars().all()}
    default_tier = next((t for t in tiers.values() if t.is_default), None)

    svc_ids = set(db.execute(
        select(LimsAnalysis.analysis_service_id)
        .where(LimsAnalysis.lims_sample_pk == sample.id,
               LimsAnalysis.analysis_service_id.is_not(None))
    ).scalars().all())

    def tightest_by_service(rows) -> dict:
        out: dict = {}
        for svc_id, tier_id in rows:
            t = tiers.get(tier_id)
            if t is not None and (svc_id not in out or t.target_minutes < out[svc_id].target_minutes):
                out[svc_id] = t
        return out

    by_profile: dict = {}
    by_group: dict = {}
    if svc_ids:
        by_profile = tightest_by_service(db.execute(
            select(analysis_profile_members.c.analysis_service_id, AnalysisProfile.sla_tier_id)
            .join(AnalysisProfile, analysis_profile_members.c.analysis_profile_id == AnalysisProfile.id)
            .where(analysis_profile_members.c.analysis_service_id.in_(svc_ids),
                   AnalysisProfile.active.is_(True),
                   AnalysisProfile.sla_tier_id.is_not(None))
        ).all())
        by_group = tightest_by_service(db.execute(
            select(service_group_members.c.analysis_service_id, ServiceGroup.sla_tier_id)
            .join(ServiceGroup, service_group_members.c.service_group_id == ServiceGroup.id)
            .where(service_group_members.c.analysis_service_id.in_(svc_ids),
                   ServiceGroup.sla_tier_id.is_not(None))
        ).all())
    cands: list[SlaTier] = []
    for svc_id in svc_ids:
        t = by_profile.get(svc_id) or by_group.get(svc_id) or default_tier
        if t is not None:
            cands.append(t)
    if not svc_ids and default_tier is not None:
        cands.append(default_tier)
    group_tier = None
    if cands:
        delivered = _ever_delivered(db, sample.id)
        group_tier = (max if delivered else min)(cands, key=lambda t: t.target_minutes)

    # ponytail: global priority rows only; per-group priority rows are the
    # frontend resolver's refinement and can be added here if a group-scoped
    # override is ever configured.
    priority_map = {
        r.priority: tiers[r.sla_tier_id]
        for r in db.execute(
            select(SlaPriorityTier).where(SlaPriorityTier.service_group_id.is_(None))
        ).scalars().all()
        if r.sla_tier_id in tiers
    }
    priority = None
    if priority_map:
        from priority.service import load_effective_safe
        eff, _ = load_effective_safe(db, sample_pks=[sample.id])
        e = eff.get(sample.id)
        priority = e.key if e is not None else None

    return resolve_sla_tier(priority_map, group_tier, priority, default_tier)


def sla_deadline(db: Session, sample: LimsSample, schedule: Optional[BusinessSchedule] = None,
                 holidays: Optional[frozenset] = None, tier: Optional[SlaTier] = None
                 ) -> Optional[datetime]:
    """When this sample's SLA runs out (naive UTC), or None without a received
    date or a tier."""
    if sample.date_received is None:
        return None
    tier = tier or resolve_tier(db, sample)
    if tier is None:
        return None
    if tier.business_hours_only:
        schedule = schedule or lab_schedule(db)
        holidays = lab_holidays(db) if holidays is None else holidays
        return add_business_minutes(sample.date_received, tier.target_minutes, schedule, holidays.__contains__)
    return sample.date_received + timedelta(minutes=tier.target_minutes)


def sla_window_hours(tier: Optional[SlaTier], schedule: BusinessSchedule) -> float:
    """The tier's target as open-day CLOCK hours, the unit the suggestion is
    ruled in. A business-hours tier counts only open..close each day, so its
    minutes stretch by 24 / business-day length: 1440 min at 8 h/day = 72 h,
    USP71's 6720 min = 336 h (14 days). No tier: the 72 h the rule was written
    against."""
    if tier is None or tier.target_minutes <= 0:
        return SUGGEST_WINDOW_HOURS
    hours = tier.target_minutes / 60.0
    if tier.business_hours_only:
        day = (datetime.combine(date.min, schedule.close_time)
               - datetime.combine(date.min, schedule.open_time)).total_seconds() / 3600.0
        if day > 0:
            hours *= 24.0 / day
    return hours


def suggest(db: Session, sample: LimsSample, *, now: datetime, rng=random
            ) -> tuple[datetime, Optional[datetime], bool, Optional[SlaTier]]:
    """(suggested_at, sla_deadline, clamped, tier), datetimes naive UTC.

    received + rng.uniform(50, 70) open-day hours on the 72 h tier, the same
    share of the window on any other tier (USP71: about 9.7 to 13.6 days),
    clamped to SLA_MARGIN before the deadline (clamped=True when that bit),
    floored at now + 1h when the sample is already late, then pushed out of
    the quiet window.
    """
    schedule = lab_schedule(db)
    holidays = lab_holidays(db)
    is_holiday = holidays.__contains__
    tier = resolve_tier(db, sample)
    deadline = sla_deadline(db, sample, schedule, holidays, tier)
    clamped = False
    if sample.date_received is not None:
        share = rng.uniform(*SUGGEST_HOURS) / SUGGEST_WINDOW_HOURS
        cand = add_open_day_hours(sample.date_received, share * sla_window_hours(tier, schedule),
                                  schedule, is_holiday)
    else:
        cand = now + timedelta(hours=1)
    if deadline is not None and cand > deadline - SLA_MARGIN:
        cand = deadline - SLA_MARGIN
        clamped = True
    if cand < now + MIN_LEAD:
        cand = now + timedelta(hours=1)
    cand = push_out_of_quiet(cand, schedule, is_holiday, rng)
    # Floored past the deadline (the sample is already late): say so.
    if deadline is not None and cand > deadline:
        clamped = True
    return cand, deadline, clamped, tier


# ── rows ─────────────────────────────────────────────────────────────────────

def serialize(row: LimsScheduledPublish) -> dict:
    return {
        "id": row.id,
        "sample_id": row.sample_id,
        "scheduled_at": iso_z(row.scheduled_at),
        "pdf_date": row.pdf_date,
        "status": row.status,
        "created_by_user_id": row.created_by_user_id,
        "created_at": iso_z(row.created_at),
        "fired_at": iso_z(row.fired_at),
        "last_error": row.last_error,
    }


def active_for(db: Session, sample_id: str) -> Optional[LimsScheduledPublish]:
    """The sample's live row: pending, firing, or the most recent failed."""
    return db.execute(
        select(LimsScheduledPublish)
        .where(LimsScheduledPublish.sample_id == sample_id,
               LimsScheduledPublish.status.in_(ACTIVE_STATUSES))
        .order_by(LimsScheduledPublish.id.desc()).limit(1)
    ).scalars().first()


def active_by_sample(db: Session) -> dict[str, dict]:
    """{sample_id: serialized row} for every active row (Ready to Publish)."""
    out: dict[str, dict] = {}
    for row in db.execute(
        select(LimsScheduledPublish)
        .where(LimsScheduledPublish.status.in_(ACTIVE_STATUSES))
        .order_by(LimsScheduledPublish.id)
    ).scalars().all():
        out[row.sample_id] = serialize(row)
    return out


def list_rows(db: Session, *, include_history: bool = False, limit: int = 300) -> list[dict]:
    """Rows for the Scheduled Publishes page: what is going to fire (soonest
    first), then failed, then (with history) what already settled, newest
    first. Each row carries the sample's client / order / received date and
    who scheduled it."""
    q = select(LimsScheduledPublish, LimsSample, User).outerjoin(
        LimsSample, LimsSample.sample_id == LimsScheduledPublish.sample_id
    ).outerjoin(User, User.id == LimsScheduledPublish.created_by_user_id)
    if not include_history:
        q = q.where(LimsScheduledPublish.status.in_(ACTIVE_STATUSES))
    out = []
    # Newest first under the cap, so a long history never crowds out live rows.
    q = q.order_by(LimsScheduledPublish.id.desc()).limit(max(1, min(limit, 1000)))
    for row, sample, user in db.execute(q).all():
        name = " ".join(p for p in ((user.first_name or ""), (user.last_name or "")) if p) if user else ""
        out.append({
            **serialize(row),
            "cancelled_at": iso_z(row.cancelled_at),
            "client": sample.client_title if sample else None,
            "order": sample.client_order_number if sample else None,
            "received_at": iso_z(sample.date_received) if sample else None,
            "sample_status": sample.status if sample else None,
            "created_by": (name or user.email) if user else None,
        })
    rank = {"firing": 0, "pending": 1, "failed": 2}

    def key(r: dict):
        live = r["status"] in rank
        # Live rows soonest first; settled rows newest first.
        return (rank.get(r["status"], 3), r["scheduled_at"] if live else "", -r["id"])
    return sorted(out, key=key)


def process_override(db: Session, sample_id: str) -> dict:
    """Extra coabuilder /process body while a publish is pending: the draft
    must print the scheduled date, whichever route regenerates it (IS
    publishes the NEWEST draft). Deliberately not wrapped: failing closed on
    a certificate date beats shipping the wrong one."""
    row = db.execute(
        select(LimsScheduledPublish)
        .where(LimsScheduledPublish.sample_id == sample_id,
               LimsScheduledPublish.status == "pending")
        .limit(1)
    ).scalars().first()
    return {"published_date_override": row.pdf_date} if row is not None else {}


def cancel_active(db: Session, sample_id: str, user_id: Optional[int], *,
                  reason: str, now: Optional[datetime] = None) -> list[str]:
    """pending + failed rows -> cancelled (history kept). Returns the statuses
    that were cancelled. A firing row is left alone: the job owns it."""
    now = now or datetime.utcnow()
    rows = db.execute(
        select(LimsScheduledPublish)
        .where(LimsScheduledPublish.sample_id == sample_id,
               LimsScheduledPublish.status.in_(("pending", "failed")))
    ).scalars().all()
    was = []
    for r in rows:
        was.append(r.status)
        r.status = "cancelled"
        r.cancelled_at = now
        r.cancelled_by_user_id = user_id
        r.last_error = reason if r.last_error is None else f"{r.last_error} | {reason}"
    if rows:
        db.commit()
    return was


def create_pending(db: Session, sample_id: str, scheduled_at: datetime, pdf: str,
                   user_id: Optional[int], *, now: Optional[datetime] = None) -> LimsScheduledPublish:
    """Replace any pending/failed row with a fresh pending one. 409-class
    PublishInProgress while the job is firing the sample."""
    now = now or datetime.utcnow()
    cur = active_for(db, sample_id)
    if cur is not None and cur.status == "firing":
        raise PublishInProgress(sample_id)
    cancel_active(db, sample_id, user_id, reason="rescheduled", now=now)
    row = LimsScheduledPublish(sample_id=sample_id, scheduled_at=scheduled_at, pdf_date=pdf,
                               status="pending", created_by_user_id=user_id, created_at=now)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


# ── the job ──────────────────────────────────────────────────────────────────

def _published_since(db: Session, sample_pk: int, since: datetime) -> bool:
    """A `coa_published` event on the parent since `since`: the only signal
    every Mk1 publish path writes (main._after_publish_native). Sample status
    is no use here: partial and re-publish flows publish already-published
    samples on purpose."""
    return db.execute(
        select(LimsSubSampleEvent.id)
        .where(LimsSubSampleEvent.lims_sample_pk == sample_pk,
               LimsSubSampleEvent.event == "coa_published",
               LimsSubSampleEvent.created_at >= since)
        .limit(1)
    ).scalar_one_or_none() is not None


def _ever_delivered(db: Session, sample_pk: int) -> bool:
    """Has ANY COA gone out for this sample, at any time? Used to pick the
    tier (loosest once something is delivered), never to guard a fire.

    Either signal is enough. The `coa_published` event only exists from
    1.21.9 (first prod rows 2026-09-17), so alone it would call a sample
    partially published on 09-15 (P-2777) undelivered and judge its USP 71
    final against the 3-day tier. The `publish` row in the sample ledger has
    the history: July 2026 on, from Mk1's route and the SENAITE event sync.
    The fire-time guard stays on `_published_since` on purpose: it asks about
    a publish SINCE this schedule was created, which the event answers
    exactly."""
    if _published_since(db, sample_pk, datetime.min):
        return True
    return db.execute(
        select(LimsSampleTransition.id)
        .where(LimsSampleTransition.lims_sample_pk == sample_pk,
               LimsSampleTransition.verb == "publish")
        .limit(1)
    ).scalar_one_or_none() is not None


def _on_hold(db: Session, sample_id: str) -> bool:
    """An open On Hold flag (label-matched type, direct anchor or entity
    link), the same predicate the Ready to Publish loader parks rows on."""
    from flags.models import FlagEntityLink, FlagFlag
    from models import FlagType
    from ready_to_publish import OPEN_FLAG_STATUSES, FlagTypeIn, resolve_hold_flag_slugs
    slugs = resolve_hold_flag_slugs(
        FlagTypeIn(slug=ft.slug, label=ft.label)
        for ft in db.execute(select(FlagType).where(FlagType.is_active.is_(True))).scalars().all()
    )
    if not slugs:
        return False
    direct = db.execute(
        select(FlagFlag.id).where(
            FlagFlag.type.in_(list(slugs)), FlagFlag.status.in_(list(OPEN_FLAG_STATUSES)),
            FlagFlag.entity_type == "sample", FlagFlag.entity_id == sample_id,
        ).limit(1)
    ).scalar_one_or_none()
    if direct is not None:
        return True
    linked = db.execute(
        select(FlagEntityLink.id)
        .join(FlagFlag, FlagFlag.id == FlagEntityLink.flag_id)
        .where(FlagFlag.type.in_(list(slugs)), FlagFlag.status.in_(list(OPEN_FLAG_STATUSES)),
               FlagEntityLink.entity_type == "sample", FlagEntityLink.entity_id == sample_id)
        .limit(1)
    ).scalar_one_or_none()
    return linked is not None


def _raise_failure_flag(db: Session, row: LimsScheduledPublish, error: str) -> None:
    """One open flag per sample (deduped on the primary anchor, like
    workflow.stranded). Raised by the first admin, assigned to whoever
    scheduled it so they get the Slack DM + digest line. Never raises."""
    try:
        from flags import catalog as flag_catalog
        from flags import seams as flag_seams
        from flags import service as flag_service
        from flags.models import FlagFlag
        from workflow.stranded import _actor
        flag_seams.register_mk1_entities()
        actor = _actor(db)
        if actor is None:
            logger.warning("scheduled_publish.flag_skipped no admin user sample=%s", row.sample_id)
            return
        existing = db.execute(
            select(FlagFlag.id).where(
                FlagFlag.type == FLAG_TYPE, FlagFlag.status.in_(flag_catalog.OPEN_STATES),
                FlagFlag.entity_type == "sample", FlagFlag.entity_id == row.sample_id,
            ).limit(1)
        ).scalar_one_or_none()
        if existing is not None:
            return
        flag_service.create_flag(
            db, user=actor, entity_type="sample", entity_id=row.sample_id, type=FLAG_TYPE,
            title=f"{row.sample_id}: scheduled publish failed",
            assignee_id=row.created_by_user_id,
            first_comment=f"Scheduled for {iso_z(row.scheduled_at)}: {error}",
        )
    except Exception:
        logger.exception("scheduled_publish.flag_failed sample=%s", row.sample_id)
        try:
            db.rollback()
        except Exception:
            pass


def _invalidate_report_cache() -> None:
    try:
        import ready_to_publish_cache
        ready_to_publish_cache.invalidate()
    except Exception:  # noqa: BLE001
        logger.exception("scheduled_publish.cache_invalidate_failed")


def _mark_failed(db: Session, row: LimsScheduledPublish, error: str) -> None:
    row.status = "failed"
    row.last_error = error[:2000]
    db.commit()
    logger.warning("scheduled_publish.failed sample=%s err=%s", row.sample_id, error)
    _raise_failure_flag(db, row, error)
    _invalidate_report_cache()


def _fail_interrupted(db: Session, now: datetime) -> int:
    """Rows still `firing` at the start of a tick were interrupted by a
    restart mid-publish (jobs run sequentially in one process). Nobody can
    tell from here whether the COA went live: fail + flag, a human checks."""
    rows = db.execute(
        select(LimsScheduledPublish).where(LimsScheduledPublish.status == "firing")
    ).scalars().all()
    for r in rows:
        _mark_failed(db, r, "interrupted by a backend restart while publishing; "
                            "check whether the COA went live before doing anything")
    return len(rows)


async def _fire_one(session_factory, publish, row_id: int, now: datetime) -> str:
    db = session_factory()
    try:
        claimed = db.execute(
            update(LimsScheduledPublish)
            .where(LimsScheduledPublish.id == row_id, LimsScheduledPublish.status == "pending")
            .values(status="firing", fired_at=now)
        ).rowcount
        db.commit()
        if not claimed:
            return "lost_claim"
        row = db.get(LimsScheduledPublish, row_id)
        sample = db.execute(
            select(LimsSample).where(LimsSample.sample_id == row.sample_id)
        ).scalar_one_or_none()
        if sample is None:
            _mark_failed(db, row, "sample has no registry row")
            return "failed"
        if _published_since(db, sample.id, row.created_at):
            row.status = "cancelled"
            row.cancelled_at = now
            row.last_error = "already published"
            db.commit()
            return "cancelled"
        if _on_hold(db, row.sample_id):
            _mark_failed(db, row, "sample is On Hold")
            return "failed"

        user = db.get(User, row.created_by_user_id) if row.created_by_user_id else None
        if user is not None and not user.is_active:
            user = None
        # Plain values captured BEFORE publish: the route commits and may fail
        # on this session, and an expired ORM attribute must not be what the
        # failure path trips over.
        sample_pk, sample_id, scheduled_since = sample.id, row.sample_id, row.created_at
        ok = False
        note: Optional[str] = None
        try:
            result = await publish(sample_id=sample_id, current_user=user, db=db)
            ok = bool(getattr(result, "success", False))
            note = getattr(result, "warning", None) if ok else (getattr(result, "message", None) or "publish failed")
        except Exception as exc:  # noqa: BLE001
            try:
                db.rollback()
            except Exception:
                pass
            note = str(getattr(exc, "detail", None) or exc)
            # The 502 "published on IS, SENAITE silently rejected" class raises
            # AFTER the native publish landed; the event row is the truth. The
            # pre-fire guard proved no event existed since scheduling, so any
            # event now is this fire's.
            ok = _published_since(db, sample_pk, scheduled_since)
        row = db.get(LimsScheduledPublish, row_id)
        if ok:
            row.status = "published"
            row.last_error = note
            db.commit()
            logger.info("scheduled_publish.published sample=%s", sample_id)
            return "published"
        _mark_failed(db, row, note or "publish failed")
        return "failed"
    finally:
        db.close()


async def run_due(session_factory, publish, *, now: Optional[datetime] = None) -> dict:
    """Scheduler job body (`scheduled_publish`, every minute).

    `publish` is main.publish_sample_coa (injected: no main import here, and
    it is the test seam), called exactly the way regen_primary_coa calls it.
    Skips claiming inside the quiet window; the interrupted-row sweep runs
    regardless.
    """
    now = now or datetime.utcnow()
    stats = {"interrupted": 0, "quiet": False, "published": 0, "failed": 0, "cancelled": 0}
    db = session_factory()
    try:
        stats["interrupted"] = _fail_interrupted(db, now)
        if in_quiet_window(now, lab_tz(db)):
            stats["quiet"] = True
            return stats
        due_ids = db.execute(
            select(LimsScheduledPublish.id)
            .where(LimsScheduledPublish.status == "pending",
                   LimsScheduledPublish.scheduled_at <= now)
            .order_by(LimsScheduledPublish.scheduled_at, LimsScheduledPublish.id)
            .limit(MAX_PER_TICK)
        ).scalars().all()
    finally:
        db.close()
    for rid in due_ids:
        outcome = await _fire_one(session_factory, publish, rid, now)
        if outcome in stats:
            stats[outcome] += 1
    if due_ids:
        logger.info("scheduled_publish.tick %s", stats)
    return stats
