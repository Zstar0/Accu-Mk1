"""Native status relay Mk1 -> Integration Service (spec M8).

A native-born sample's receive / verify / publish is the only signal that
reaches WordPress's order-status stepper once SENAITE is out of the loop.
This module is the ONE relay client; it is called from the single
mk1-authority status writer (`workflow.engine._write_status_if_authoritative`)
right after `sample.status` is set, and never on the request/transaction
path itself: the writer queues `(sample_id, transition)` here
(`queue_relay`) and a flush point elsewhere (end of the receive route,
`run_cascades_bg`, `_after_publish_native`) drains the queue
(`flush_pending_relays`) in its own short-lived session, after the caller's
own commit. Never raises, never blocks a DB transaction on the network.

Contract (twin-pinned with IS — tests/test_status_relay.py::test_contract_body_shape):
    POST {INTEGRATION_SERVICE_URL}/explorer/samples/{sample_id}/status
    X-API-Key: ACCU_MK1_API_KEY
    {"transition": "receive"|"verify"|"publish",
     "event_id": "mk1-{sample_id}-{transition}-{ordinal}",
     "order_ref": <lims_samples.client_order_number or null>,
     "occurred_at": "<UTC ISO8601 with Z>"}
    Response: {"status": "ok"|"duplicate"|"no_order_found", ...}

`ordinal` = count of `lims_sample_transitions` rows for the sample whose
verb equals `transition` (including the one the writer just flushed for
this call), so a retry re-sends the identical event_id and IS de-dupes.

No retry job in this slice (Global Constraints ruling): one attempt, a loud
`native_status_relay_failed` event, and a follow-up ticket.
"""
from __future__ import annotations

import logging
import os
from collections import deque
from datetime import datetime
from typing import Optional

import httpx
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from models import LimsSample, LimsSampleTransition, LimsSubSampleEvent

log = logging.getLogger(__name__)

# Same two env vars main._notify_worksheet_assigned reads — duplicated here
# (not imported from main) to avoid a status_relay -> main import cycle.
INTEGRATION_SERVICE_URL = os.environ.get(
    "INTEGRATION_SERVICE_URL", "http://host.docker.internal:8000")
INTEGRATION_SERVICE_API_KEY = os.environ.get("ACCU_MK1_API_KEY", "")

RELAYED_SLUGS = {
    "sample_received": "receive",
    "verified": "verify",
    "published": "publish",
}

# ponytail: module-level in-process queue — a single Mk1 worker process only.
# Fine for today's single-uvicorn-worker deploy; upgrade to a real queue
# (DB-backed outbox or broker) if Mk1 ever runs multiple worker processes,
# since a flush point in worker A would never drain a queue point in worker B.
# deque (not list): two receives can flush concurrently from different
# threadpool threads, and `popleft()` is what keeps the drain race-safe.
pending_relays: deque[tuple[str, str]] = deque()


def queue_relay(sample_id: str, transition: str) -> None:
    pending_relays.append((sample_id, transition))


def flush_pending_relays() -> list[str]:
    """Drain `pending_relays`, relaying each in its own session. Never
    raises — a relay failure becomes a "failed" outcome, not an exception.

    Two flush points can run concurrently (e.g. two receives in different
    threadpool threads), so the truthiness check and the pop are not atomic
    across threads — `popleft()` inside the try (not the `while` condition)
    is what makes an empty-queue race a clean early exit instead of an
    IndexError."""
    outcomes: list[str] = []
    while True:
        try:
            sample_id, transition = pending_relays.popleft()
        except IndexError:
            break
        try:
            from database import SessionLocal
            db = SessionLocal()
            try:
                outcomes.append(
                    relay_native_status(db, sample_id=sample_id, transition=transition))
            finally:
                db.close()
        except Exception:
            log.exception("status_relay.flush_failed sample=%s transition=%s",
                          sample_id, transition)
            outcomes.append("failed")
    return outcomes


def event_id_for(db: Session, sample: LimsSample, transition: str) -> str:
    count = db.execute(
        select(func.count(LimsSampleTransition.id)).where(
            LimsSampleTransition.lims_sample_pk == sample.id,
            LimsSampleTransition.verb == transition,
        )
    ).scalar_one()
    return f"mk1-{sample.sample_id}-{transition}-{count}"


def build_relay_body(db: Session, sample: LimsSample, transition: str) -> dict:
    # occurred_at is the flush-time UTC wall clock, not the ledger row's own
    # occurred_at — the relay may run well after the transition was written.
    return {
        "transition": transition,
        "event_id": event_id_for(db, sample, transition),
        "order_ref": sample.client_order_number,
        "occurred_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def post_relay(sample_id: str, body: dict) -> dict:
    """Sync POST (threadpool/bg-session safe), 10s timeout. Raises on
    transport error or non-2xx — callers translate that into "failed"."""
    url = f"{INTEGRATION_SERVICE_URL}/explorer/samples/{sample_id}/status"
    with httpx.Client(timeout=10.0) as client:
        resp = client.post(url, json=body,
                           headers={"X-API-Key": INTEGRATION_SERVICE_API_KEY})
        resp.raise_for_status()
        return resp.json()


def relay_native_status(db: Session, *, sample_id: str, transition: str) -> str:
    """Post one transition for `sample_id` to IS. Records the outcome as its
    own `LimsSubSampleEvent` and commits its own session (own `db`, own
    transaction — the caller may be a fresh SessionLocal() or a request-scoped
    session the flush point handed us). Never raises.

    Returns "sent" / "duplicate" / "no_order_found" / "failed" / "skipped"
    ("skipped" = not a native-born sample, or the sample vanished)."""
    try:
        sample = db.execute(
            select(LimsSample).where(LimsSample.sample_id == sample_id)
        ).scalar_one_or_none()
        if sample is None:
            return "skipped"
        from lims_analyses.hplc_native import is_native_born
        if not is_native_born(sample):
            return "skipped"

        body = build_relay_body(db, sample, transition)
        try:
            response = post_relay(sample_id, body)
        except Exception as e:
            log.warning("status_relay.post_failed sample=%s transition=%s err=%s",
                       sample_id, transition, e)
            db.add(LimsSubSampleEvent(
                lims_sample_pk=sample.id, event="native_status_relay_failed",
                details={"transition": transition, "event_id": body["event_id"],
                        "error": str(e)},
                user_id=None,
            ))
            db.commit()
            return "failed"

        status = response.get("status") if isinstance(response, dict) else None
        outcome = "sent" if status == "ok" else (status or "sent")
        db.add(LimsSubSampleEvent(
            lims_sample_pk=sample.id, event="native_status_relayed",
            details={"transition": transition, "event_id": body["event_id"],
                    "response": response},
            user_id=None,
        ))
        db.commit()
        return outcome
    except Exception:
        log.exception("status_relay.relay_native_status failed (never-raise) "
                      "sample=%s transition=%s", sample_id, transition)
        try:
            db.rollback()
        except Exception:
            pass
        return "failed"
