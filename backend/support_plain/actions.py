"""Support ticket actions (spec 3.3-3.6): validate, guard, one Plain write, confirm, audit, refresh."""
from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.orm import Session

from support_plain import audit, queries, rules, service
from support_plain.client import (PlainActionError, SupportNotConfigured, SupportUnavailable,
                                  SupportWriteUnconfirmed)
from support_plain.seat import Seat

logger = logging.getLogger(__name__)
_CODES = {"cannot_reply_to_thread": (403, "not_allowed_to_reply"),
          "missing_user_auth_slack_integration_for_team": (409, "slack_not_connected")}


class ActionFailed(Exception):
    def __init__(self, status: int, code: str) -> None:
        super().__init__(code)
        self.status, self.code = status, code


def _bad() -> ActionFailed:
    return ActionFailed(422, "invalid_input")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def plain_text(md: str) -> str:
    """Markdown to the text Plain shows in clients that cannot render markdown."""
    t = re.sub(r"!?\[([^\]]*)\]\(([^)]+)\)", r"\1 (\2)", md)
    t = re.sub(r"^\s{0,3}(#{1,6}|>)\s?", "", t, flags=re.M)
    t = re.sub(r"(\*\*|__|\*|_|`)", "", t)
    return t.strip()


def _norm(s: str) -> str:
    return " ".join(s.split())


def _markdown(body: dict) -> str:
    md = (body.get("markdown") or "").strip()
    if not md or len(md) > rules.MAX_BODY:
        raise _bad()
    return md


def _plan(action: str, body: dict, seat: Seat, thread: dict) -> tuple[list[tuple[str, dict]], str | None]:
    tid = thread["id"]
    if action == "reply":
        md = _markdown(body)
        return [(queries.REPLY, {"input": {"threadId": tid, "textContent": plain_text(md), "markdownContent": md,
                                           "impersonation": {"asUser": {"userIdentifier":
                                                                        {"userId": seat.plain_user_id}}}}})], md
    if action == "note":
        md = _markdown(body)
        if not thread.get("customer_plain_id"):
            raise ActionFailed(502, "support_unavailable")
        text = f"{seat.full_name}: {md}"
        return [(queries.NOTE, {"input": {"customerId": thread["customer_plain_id"], "threadId": tid,
                                          "text": plain_text(text), "markdown": text}})], md
    if action == "status":
        s = body.get("status")
        if s == "todo":
            return [(queries.MARK_TODO, {"input": {"threadId": tid}})], None
        if s == "done":
            return [(queries.MARK_DONE, {"input": {"threadId": tid}})], None
        if s != "snoozed" or not body.get("until"):
            raise _bad()
        try:
            until = datetime.fromisoformat(str(body["until"]).replace("Z", "+00:00"))
        except ValueError:
            raise _bad()
        if until.tzinfo is None:
            raise _bad()
        secs = int((until - _now()).total_seconds())
        if not rules.SNOOZE_MIN <= secs <= rules.SNOOZE_MAX:
            raise _bad()
        return [(queries.SNOOZE, {"input": {"threadId": tid, "durationSeconds": secs}})], None
    if action == "assign":
        uid = body.get("plain_user_id")
        if uid is None:
            return [(queries.UNASSIGN, {"input": {"threadId": tid}})], None
        if uid not in {t["plain_user_id"] for t in service.workspace_people()["teammates"]}:
            raise _bad()
        return [(queries.ASSIGN, {"input": {"threadId": tid, "userId": uid}})], None
    if action == "priority":
        p = rules.PRIORITY_IN.get(body.get("priority"))
        if p is None:
            raise _bad()
        return [(queries.PRIORITY, {"input": {"threadId": tid, "priority": p}})], None
    if action == "labels":
        add, remove = list(body.get("add") or []), list(body.get("remove") or [])
        if not add and not remove:
            raise _bad()
        if add and not set(add) <= {l["id"] for l in service.workspace_people()["label_types"]}:
            raise _bad()
        if not set(remove) <= {l["id"] for l in thread.get("label_refs") or []}:
            raise _bad()
        steps = []
        if add:
            steps.append((queries.ADD_LABELS, {"input": {"threadId": tid, "labelTypeIds": add}}))
        if remove:
            steps.append((queries.REMOVE_LABELS, {"input": {"labelIds": remove}}))
        return steps, None
    raise _bad()


def _confirmed(client, thread_id: str, seat: Seat, md: str) -> bool:
    try:
        _, nodes = service.raw_timeline(client, thread_id)
    except (SupportUnavailable, SupportNotConfigured, KeyError, TypeError):
        return False
    want = _norm(plain_text(md))[:rules.CONFIRM_PREFIX]
    cutoff = _now() - timedelta(seconds=rules.CONFIRM_WINDOW)
    for n in nodes:
        actor = n.get("actor") or {}
        if actor.get("__typename") != "UserActor" or actor.get("userId") != seat.plain_user_id:
            continue
        try:
            at = datetime.fromisoformat(n["timestamp"]["iso8601"].replace("Z", "+00:00"))
        except (KeyError, TypeError, ValueError):
            continue
        if at < cutoff:
            continue
        e = n.get("entry") or {}
        text = e.get("textContent") or e.get("chatText") or e.get("slackText") or e.get("slackReplyText") or ""
        if _norm(text).startswith(want):
            return True
    return False


def run(db: Session, user: Any, seat: Seat, customer_key: str, thread_id: str, action: str,
        body: dict) -> dict | None:
    detail = service.thread_detail(customer_key, thread_id)
    if detail is None:
        raise ActionFailed(404, "thread_not_found")
    steps, md = _plan(action, body, seat, detail["thread"])
    args = {k: v for k, v in body.items() if k != "markdown"}

    def rec(outcome: str, code: str | None = None) -> None:
        audit.record(db, user_id=user.id, plain_user_id=seat.plain_user_id, customer_key=customer_key,
                     thread_id=thread_id, action=action, args=args, body=md, outcome=outcome, error_code=code)

    if md is not None and audit.is_duplicate(db, user_id=user.id, thread_id=thread_id, action=action, body=md):
        rec("duplicate")
        raise ActionFailed(409, "duplicate_reply")
    client = service._client_factory()
    try:
        for mutation, variables in steps:
            client.mutate(mutation, variables)
    except PlainActionError as e:
        rec("error", e.code)
        status, code = _CODES.get(e.code) or ((422, "invalid_input") if e.type_.upper() == "VALIDATION"
                                              else (502, "support_unavailable"))
        raise ActionFailed(status, code)
    except SupportWriteUnconfirmed:
        if action == "reply" and _confirmed(client, thread_id, seat, md or ""):
            rec("confirmed_after_timeout")
        else:
            rec("unconfirmed")
            raise ActionFailed(504, "reply_unconfirmed") if action == "reply" else ActionFailed(502, "support_unavailable")
    except SupportNotConfigured:
        rec("error", "not_configured")
        raise ActionFailed(503, "support_not_configured")
    except SupportUnavailable as e:
        rec("error", str(e)[:64])
        raise ActionFailed(502, "support_unavailable")
    else:
        rec("ok")
    logger.info("support_plain.action action=%s thread=%s", action, thread_id)
    service.invalidate(customer_key, thread_id)
    try:
        return service.thread_detail(customer_key, thread_id)
    except (SupportUnavailable, SupportNotConfigured):
        return None
