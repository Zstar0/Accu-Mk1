"""customer_ai_reviews reads and writes (spec 3.5)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import CustomerAiReview

# Well above the worst-case run (2 LLM retries x 60 s + forced turn + cold data sources);
# a restart is caught at startup by sweep_running instead.
INTERRUPTED_AFTER = timedelta(minutes=10)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    # SQLite (unit tests) hands back naive datetimes; Postgres timestamptz is aware.
    return dt if dt is None or dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _iso(dt: datetime | None) -> str | None:
    dt = _aware(dt)
    return dt.isoformat().replace("+00:00", "Z") if dt else None


def status_of(row: CustomerAiReview, now: datetime | None = None) -> str:
    if row.status == "running" and _aware(row.created_at) < (now or _now()) - INTERRUPTED_AFTER:
        return "interrupted"
    return row.status


def create_run(db: Session, key: str, user_id: int | None, model: str) -> CustomerAiReview:
    row = CustomerAiReview(customer_key=key, status="running", created_by=user_id, created_at=_now(), model=model,
                           steps=[], tool_calls=[], input_tokens=0, output_tokens=0, cost_usd=0, citations_dropped=0)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def get_run(db: Session, run_id: int) -> CustomerAiReview | None:
    return db.get(CustomerAiReview, run_id)


def active_run(db: Session, key: str) -> CustomerAiReview | None:
    """The live run for this customer, closing any interrupted one on the way."""
    live = None
    rows = db.execute(select(CustomerAiReview).where(CustomerAiReview.customer_key == key,
                                                     CustomerAiReview.status == "running")).scalars().all()
    for row in rows:
        if status_of(row) == "interrupted":
            row.status, row.error, row.finished_at = "failed", "interrupted", _now()
        else:
            live = row
    db.commit()
    return live


def sweep_running(db: Session) -> int:
    """At backend startup every running row belongs to a dead process (single worker)."""
    rows = db.execute(select(CustomerAiReview).where(CustomerAiReview.status == "running")).scalars().all()
    for row in rows:
        row.status, row.error, row.finished_at = "failed", "interrupted", _now()
    db.commit()
    return len(rows)


def recent(db: Session, key: str, limit: int = 20) -> list[CustomerAiReview]:
    return list(db.execute(select(CustomerAiReview).where(CustomerAiReview.customer_key == key)
                           .order_by(CustomerAiReview.created_at.desc(), CustomerAiReview.id.desc())
                           .limit(limit)).scalars())


def over_daily_cap(db: Session, cap: int, now: datetime | None = None) -> bool:
    start = (now or _now()).replace(hour=0, minute=0, second=0, microsecond=0)
    # ponytail: reads only the newest `cap` rows; enough to answer "at least cap today".
    rows = db.execute(select(CustomerAiReview.created_at).order_by(CustomerAiReview.id.desc()).limit(cap)).scalars()
    return sum(1 for c in rows if _aware(c) >= start) >= cap


def add_step(db: Session, run_id: int, step: dict[str, Any]) -> None:
    row = db.get(CustomerAiReview, run_id)
    if row is None or row.finished_at is not None:
        return
    row.steps = [*(row.steps or []), step]  # reassign so SQLAlchemy sees the change
    db.commit()


def finish(db: Session, run_id: int, *, status: str, review: dict | None = None, tool_calls: list,
           input_tokens: int, output_tokens: int, cost_usd, citations_dropped: int = 0,
           error: str | None = None, document_id: int | None = None, document_code: str | None = None,
           names_scrubbed: int = 0, document_error: str | None = None) -> None:
    row = db.get(CustomerAiReview, run_id)
    if row is None or row.finished_at is not None:
        return
    row.status, row.review, row.tool_calls = status, review, tool_calls
    row.input_tokens, row.output_tokens, row.cost_usd = input_tokens, output_tokens, cost_usd
    row.citations_dropped, row.error, row.finished_at = citations_dropped, error, _now()
    row.document_id, row.document_code = document_id, document_code
    row.names_scrubbed, row.document_error = names_scrubbed, document_error
    db.commit()


def to_dict(row: CustomerAiReview) -> dict[str, Any]:
    calls = row.tool_calls or []
    return {"run_id": row.id, "customer_key": row.customer_key, "status": status_of(row),
            "created_at": _iso(row.created_at), "finished_at": _iso(row.finished_at), "model": row.model,
            "steps": row.steps or [], "review": row.review, "tool_calls": calls, "tool_call_count": len(calls),
            "input_tokens": row.input_tokens or 0, "output_tokens": row.output_tokens or 0,
            "cost_usd": float(row.cost_usd or 0), "citations_dropped": row.citations_dropped or 0,
            "error": row.error, "document_id": row.document_id, "document_code": row.document_code,
            "names_scrubbed": row.names_scrubbed or 0, "document_error": row.document_error}


def document_code_for(db: Session, key: str) -> str | None:
    return db.execute(select(CustomerAiReview.document_code)
                      .where(CustomerAiReview.customer_key == key, CustomerAiReview.document_code.is_not(None))
                      .order_by(CustomerAiReview.id.desc()).limit(1)).scalar_one_or_none()
