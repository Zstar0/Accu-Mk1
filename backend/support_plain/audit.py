"""support_actions writes and the duplicate guard (spec 3.5)."""
from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import SupportAction
from support_plain import rules

SENT = ("ok", "confirmed_after_timeout")
BLOCKING = SENT + ("pending",)  # an identical send still in flight counts as sent


def _now() -> datetime:
    return datetime.now(timezone.utc)


def body_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def record(db: Session, *, user_id: int, plain_user_id: str | None, customer_key: str, thread_id: str, action: str,
           args: dict, body: str | None, outcome: str, error_code: str | None = None) -> SupportAction:
    row = SupportAction(at=_now(), mk1_user_id=user_id, plain_user_id=plain_user_id, customer_key=customer_key,
                        thread_id=thread_id, action=action, args=args,
                        body_sha256=body_hash(body) if body is not None else None,
                        body_len=len(body) if body is not None else None, outcome=outcome, error_code=error_code)
    db.add(row)
    db.commit()
    return row


def is_duplicate(db: Session, *, user_id: int, thread_id: str, action: str, body: str,
                 now: datetime | None = None) -> bool:
    since = (now or _now()) - timedelta(seconds=rules.DUPLICATE_WINDOW)
    hit = db.execute(select(SupportAction.id).where(
        SupportAction.mk1_user_id == user_id, SupportAction.thread_id == thread_id, SupportAction.action == action,
        SupportAction.body_sha256 == body_hash(body), SupportAction.outcome.in_(BLOCKING),
        SupportAction.at >= since).limit(1)).first()
    return hit is not None


def finish(db: Session, row: SupportAction, outcome: str, error_code: str | None = None) -> None:
    row.outcome, row.error_code = outcome, error_code
    db.commit()
