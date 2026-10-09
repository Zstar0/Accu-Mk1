"""/ai-review/* API (spec section 4) and the background runner. Admin-only."""
from __future__ import annotations

import logging
import os
import threading
from typing import Any, Literal, Optional

import psycopg2
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import require_admin
from crm_close import match as crm_match
from customer_review import agent, document, llm, names, store, tools
from database import SessionLocal, get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/ai-review", tags=["ai-review"])
DAILY_CAP = int(os.environ.get("AI_REVIEW_DAILY_CAP") or 50)
_emails_fn = crm_match.customer_emails
_session_factory = SessionLocal


class StartResponse(BaseModel):
    run_id: int
    status: str


class Run(BaseModel):
    run_id: int
    customer_key: str
    status: Literal["running", "done", "failed", "interrupted"]
    created_at: Optional[str] = None
    finished_at: Optional[str] = None
    model: str
    steps: list[dict[str, Any]]
    review: Optional[dict[str, Any]] = None
    tool_calls: list[dict[str, Any]]
    tool_call_count: int
    input_tokens: int
    output_tokens: int
    cost_usd: float
    citations_dropped: int
    error: Optional[str] = None
    document_id: Optional[int] = None
    document_code: Optional[str] = None
    names_scrubbed: int = 0
    document_error: Optional[str] = None


class HistoryRow(BaseModel):
    run_id: int
    status: str
    created_at: Optional[str] = None
    sentiment_score: Optional[int] = None


class CustomerReviews(BaseModel):
    latest: Optional[Run] = None
    history: list[HistoryRow]


def _dossier_for(db, key: str) -> dict | None:
    try:
        return tools._dossier(tools.Ctx(customer_key=key, db=db))
    except Exception as e:
        logger.warning("customer_review.dossier_failed error=%s", type(e).__name__)
        return None


def _author(db, user_id: int | None) -> str | None:
    from models import User
    u = db.get(User, user_id) if user_id else None
    if u is None:
        return None
    return " ".join(p for p in (u.first_name, u.last_name) if p) or u.email


def _finish(run_id: int, **fields) -> None:
    """Finish on a fresh session: the run's own session may hold an aborted transaction."""
    db = _session_factory()
    try:
        store.finish(db, run_id, **fields)
    finally:
        db.close()


def _execute(run_id: int, key: str) -> None:
    """Runs one review in its own DB session; every exit path finishes the row."""
    db = _session_factory()
    try:
        ctx = tools.Ctx(customer_key=key, db=db)
        outcome = agent.run(llm=llm.get_client(), ctx=ctx, on_step=lambda step: store.add_step(db, run_id, step))
        doc_fields: dict = {}
        review = outcome.review
        if outcome.status == "done" and review:
            review, scrubbed = names.scrub(review, names.staff_names(db, ctx))
            doc_fields["names_scrubbed"] = scrubbed
            try:
                dossier = _dossier_for(db, key)
                row = store.get_run(db, run_id)
                doc_id, code = document.publish(
                    db, review=review, customer_key=key,
                    customer_name=((dossier or {}).get("identity") or {}).get("name") or key,
                    author=_author(db, row.created_by if row else None), run_id=run_id, model=llm.MODEL,
                    lookups=len(outcome.tool_calls), cost_usd=float(outcome.cost),
                    metric_cards=document.metrics(dossier), code=store.document_code_for(db, key))
                doc_fields.update(document_id=doc_id, document_code=code)
            except Exception as e:
                db.rollback()
                logger.warning("customer_review.publish_failed run=%s error=%s", run_id, type(e).__name__)
                doc_fields["document_error"] = "document publish failed"
        db.close()
        _finish(run_id, status=outcome.status, review=review, tool_calls=outcome.tool_calls,
                input_tokens=outcome.input_tokens, output_tokens=outcome.output_tokens, cost_usd=outcome.cost,
                citations_dropped=outcome.citations_dropped, error=outcome.error, **doc_fields)
    except (llm.ReviewUnavailable, llm.ReviewNotConfigured) as e:
        logger.warning("customer_review.run_failed run=%s error=%s", run_id, type(e).__name__)
        _finish(run_id, status="failed", tool_calls=[], input_tokens=0, output_tokens=0, cost_usd=0,
                error="AI service unavailable")
    except Exception as e:
        logger.exception("customer_review.run_crashed run=%s error=%s", run_id, type(e).__name__)
        _finish(run_id, status="failed", tool_calls=[], input_tokens=0, output_tokens=0, cost_usd=0,
                error="internal error")
    finally:
        db.close()


def _start(run_id: int, key: str) -> None:
    threading.Thread(target=_execute, args=(run_id, key), daemon=True, name=f"ai-review-{run_id}").start()


@router.post("/customers/{customer_key}", response_model=StartResponse, status_code=202)
def start_review(customer_key: str, db: Session = Depends(get_db), user=Depends(require_admin)):
    try:
        llm.get_client()
    except llm.ReviewNotConfigured:
        raise HTTPException(status_code=503, detail={"code": "review_not_configured"})
    try:
        emails = _emails_fn(customer_key)
    except psycopg2.Error:
        raise HTTPException(status_code=502, detail={"code": "review_unavailable"})
    if emails is None:
        raise HTTPException(status_code=404, detail="customer not found")
    live = store.active_run(db, customer_key)
    if live is not None:
        return {"run_id": live.id, "status": "running"}
    if store.over_daily_cap(db, DAILY_CAP):
        raise HTTPException(status_code=429, detail={"code": "review_daily_cap"})
    row = store.create_run(db, customer_key, getattr(user, "id", None), llm.MODEL)
    _start(row.id, customer_key)
    return {"run_id": row.id, "status": "running"}


@router.get("/customers/{customer_key}", response_model=CustomerReviews)
def customer_reviews(customer_key: str, db: Session = Depends(get_db), _u=Depends(require_admin)):
    rows = store.recent(db, customer_key)
    history = [{"run_id": r.id, "status": store.status_of(r), "created_at": store.to_dict(r)["created_at"],
                "sentiment_score": ((r.review or {}).get("sentiment") or {}).get("score")} for r in rows]
    return {"latest": store.to_dict(rows[0]) if rows else None, "history": history}


@router.get("/runs/{run_id}", response_model=Run)
def get_run(run_id: int, db: Session = Depends(get_db), _u=Depends(require_admin)):
    row = store.get_run(db, run_id)
    if row is None:
        raise HTTPException(status_code=404, detail="run not found")
    return store.to_dict(row)
