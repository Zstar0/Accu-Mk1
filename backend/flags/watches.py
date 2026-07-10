"""State-change watches engine (Plan 6).

Poll-don't-instrument (spec §2): a scheduler job evaluates armed watches against
the host `state` seam every ~2 min and fires each ONCE. Module-pure — this file
imports NO host models. It reads entity state ONLY via `seams.resolve_state` and
raises flags / posts comments ONLY through `flags.service`.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from flags import permissions, seams, service, types_service
from flags.errors import BadRequestError, NotFoundError, PermissionDeniedError
from flags.models import FlagEntityWatch

log = logging.getLogger(__name__)

# Abuse/noise ceiling (pre-deploy security review, finding #2): each fire
# creates a flag or comment, so an unbounded armed set is a spam vector even
# though fires carry only the creator's own privileges. Generous for a
# 10-40 person lab; cancelled/fired watches don't count.
MAX_ARMED_WATCHES_PER_USER = 25


@dataclass
class _ActorRef:
    """Minimal actor for automated fires — carries the watch creator's id so
    service permission checks (create/comment are OPEN actions) pass and emitted
    events attribute the creator (spec §10). Avoids a host User import."""
    id: int
    role: Optional[str] = None


# --- validation ----------------------------------------------------------
def _validate_condition(condition: dict) -> None:
    if not isinstance(condition, dict) or condition.get("field") != "state":
        raise BadRequestError("condition must be {'field':'state','equals':<str>}")
    if not isinstance(condition.get("equals"), str) or not condition["equals"].strip():
        raise BadRequestError("condition.equals must be a non-empty string")


def _validate_action(db: Session, action: dict) -> None:
    if not isinstance(action, dict):
        raise BadRequestError("action must be an object")
    kind = action.get("kind")
    if kind == "create_flag":
        if not action.get("title"):
            raise BadRequestError("create_flag action needs a title")
        atype = action.get("type") or "task"
        if not types_service.is_valid_type(db, atype):
            raise BadRequestError(f"unknown flag type {atype!r}")
    elif kind == "comment":
        if not action.get("flag_id"):
            raise BadRequestError("comment action needs a flag_id")
        if not (action.get("body") or "").strip():
            raise BadRequestError("comment action needs a body")
        service.get_flag(db, int(action["flag_id"]))  # 404 if the target is gone
    else:
        raise BadRequestError(f"unknown action kind {kind!r}")


# --- arm / cancel / list -------------------------------------------------
def arm_watch(db: Session, *, user, entity_type: str, entity_id: str,
              condition: dict, action: dict,
              watch_flag_id: Optional[int] = None) -> FlagEntityWatch:
    if not permissions.can(user, "watch", None):
        raise PermissionDeniedError("not allowed to arm watches")
    if not seams.is_registered(entity_type):
        raise BadRequestError(f"unknown entity_type {entity_type!r}")
    if not seams.has_state_seam(entity_type):
        raise BadRequestError(f"{entity_type} has no watchable state")
    _validate_condition(condition)
    _validate_action(db, action)
    flag = service.get_flag(db, watch_flag_id) if watch_flag_id is not None else None
    uid = getattr(user, "id", None)
    armed = db.execute(
        select(FlagEntityWatch.id)
        .where(FlagEntityWatch.created_by == uid,
               FlagEntityWatch.status == "armed")
    ).all()
    if len(armed) >= MAX_ARMED_WATCHES_PER_USER:
        raise BadRequestError(
            f"you already have {MAX_ARMED_WATCHES_PER_USER} armed watches — "
            "cancel one before arming another")
    watch = FlagEntityWatch(entity_type=entity_type, entity_id=str(entity_id),
                            condition=condition, action=action, created_by=uid,
                            watch_flag_id=watch_flag_id, status="armed")
    db.add(watch)
    db.flush()  # populate watch.id
    if flag is not None:
        service._audit(db, flag, uid, "watch_armed",
                       details={"watch_id": watch.id,
                                "entity": f"{entity_type}:{entity_id}"})
        service._commit_and_emit(db)
    else:
        db.commit()  # standalone watch: the row is its own record, no flag event
    db.refresh(watch)
    return watch


def cancel_watch(db: Session, *, user, watch_id: int) -> None:
    watch = db.get(FlagEntityWatch, watch_id)
    if watch is None:
        raise NotFoundError(f"watch {watch_id} not found")
    uid = getattr(user, "id", None)
    if uid != watch.created_by and getattr(user, "role", None) != "admin":
        raise PermissionDeniedError("only the creator or an admin can cancel a watch")
    if watch.status != "armed":
        return  # already fired/cancelled — idempotent
    watch.status = "cancelled"
    if watch.watch_flag_id is not None:
        flag = service.get_flag(db, watch.watch_flag_id)
        service._audit(db, flag, uid, "watch_cancelled", details={"watch_id": watch.id})
        service._commit_and_emit(db)
    else:
        db.commit()


def list_watches(db: Session, *, flag_id: Optional[int] = None,
                 status: str = "armed") -> list[FlagEntityWatch]:
    """Watches in `status` (default armed), optionally scoped to a thread."""
    stmt = select(FlagEntityWatch).where(FlagEntityWatch.status == status)
    if flag_id is not None:
        stmt = stmt.where(FlagEntityWatch.watch_flag_id == flag_id)
    return list(db.execute(
        stmt.order_by(FlagEntityWatch.created_at.asc())).scalars().all())


# --- poller --------------------------------------------------------------
def _condition_met(db: Session, watch: FlagEntityWatch) -> bool:
    cond = watch.condition or {}
    if cond.get("field") != "state":
        return False  # v1 evaluates state-equality only
    current = seams.resolve_state(db, watch.entity_type, watch.entity_id)
    return current is not None and current == cond.get("equals")


def _fire(db: Session, watch: FlagEntityWatch) -> None:
    """Execute the action + mark the watch fired ATOMICALLY (spec §9 one-shot).

    `status='fired'`/`fired_at` are set on the session BEFORE the service call;
    the action's own `_commit_and_emit` commit flushes the dirty watch in the
    SAME transaction — action + status-flip are all-or-nothing (a raise inside
    the action rolls both back, leaving the watch armed for the next tick). The
    `watch_fired` audit event is emitted in a follow-up commit (best-effort:
    losing only the meta event on a mid-fire crash beats double-firing).

    Attributes the watch CREATOR and stamps {automated, watch_id} on the action's
    own event via service's existing `event_details` merge (spec §10 lineage)."""
    action = watch.action or {}
    kind = action.get("kind")
    actor = _ActorRef(id=watch.created_by)
    marker = {"automated": True, "watch_id": watch.id}
    watch.status = "fired"
    watch.fired_at = datetime.utcnow()
    if kind == "create_flag":
        flag = service.create_flag(
            db, user=actor, entity_type=None, entity_id=None,
            type=action.get("type") or "task", title=action["title"],
            assignee_id=action.get("assignee_id"), event_details=marker)
        if watch.watch_flag_id is None:
            watch.watch_flag_id = flag.id      # link standalone watch to its flag
        target_flag_id = flag.id
    elif kind == "comment":
        service.add_comment(db, user=actor, flag_id=int(action["flag_id"]),
                            body=action["body"], event_details=marker)
        target_flag_id = watch.watch_flag_id or int(action["flag_id"])
    else:
        raise BadRequestError(f"unknown action kind {kind!r}")
    target = service.get_flag(db, target_flag_id)
    service._audit(db, target, watch.created_by, "watch_fired", details=marker)
    service._commit_and_emit(db)


def run_watch_poll(db: Session, *, now: Optional[datetime] = None) -> int:
    """Evaluate every armed watch once; fire the matches; return the fire count.

    Pure + injectable — no scheduler, no sleeps, opens no Session (the caller
    owns it) — so slice-§12 tests drive it directly with a fake `state` seam.
    Each watch is re-fetched by id and re-checked `armed` inside the loop so a
    `rollback()` in one iteration never acts on stale batch-loaded rows; a
    per-watch try/except isolates one poison watch from the rest."""
    _ = now  # v1 conditions are state-only; `now` reserved for future time conds
    armed_ids = list(db.execute(
        select(FlagEntityWatch.id)
        .where(FlagEntityWatch.status == "armed")
        .order_by(FlagEntityWatch.id.asc())).scalars().all())
    fired = 0
    for wid in armed_ids:
        try:
            watch = db.get(FlagEntityWatch, wid)
            if watch is None or watch.status != "armed":
                continue
            if not _condition_met(db, watch):
                continue
            _fire(db, watch)
            fired += 1
        except Exception:  # noqa: BLE001 — isolate one poison watch
            db.rollback()
            log.warning("flag_watch_fire_failed watch_id=%s", wid, exc_info=True)
    return fired


def _watch_poll_job(now: Optional[datetime] = None) -> None:
    """Scheduler entry point: open a Session, run one poll pass, close it. Thin
    wrapper so `run_watch_poll` stays Session-injectable + test-friendly (§12).
    Sync `def` run in the scheduler's threadpool; accepts the `now` the ticker
    passes (Slice-5 Scheduler calls `fn(now=now)`)."""
    from database import SessionLocal
    db = SessionLocal()
    try:
        run_watch_poll(db, now=now)
    finally:
        db.close()
