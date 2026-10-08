"""Orchestration: customer match, thread list and conversations (all cached), refresh, stale fallback, scoping."""
from __future__ import annotations

import logging
import time
from typing import Any

import psycopg2

from crm_close import match as crm_match
from crm_close.cache import TTLCache
from crm_close.service import _iso
from support_plain import match, queries, rules, threads
from support_plain.client import SupportUnavailable, get_client

logger = logging.getLogger(__name__)
CACHE = TTLCache()
_client_factory = get_client
_emails_fn = crm_match.customer_emails


def _emails(customer_key: str) -> list[str] | None:
    try:
        return _emails_fn(customer_key)
    except psycopg2.Error as e:
        logger.warning("support_plain.is_db_error error=%s", type(e).__name__)
        raise SupportUnavailable("is_db") from e


def _workspace(client) -> str:
    ws, _ = CACHE.get_or_load("ws", float("inf"), lambda: client.query(queries.WORKSPACE)["myWorkspace"]["id"])
    return ws


def _load(customer_key: str, emails: list[str], *, fresh: bool = False) -> dict[str, Any]:
    client = _client_factory()
    mkey = f"m:{customer_key}"
    if fresh:  # refresh: re-match, and replace the cached match only once Plain answered
        customers = match.find_customers(emails, client)
        CACHE.put(mkey, customers)
    else:
        customers, _ = CACHE.get_or_load(mkey, rules.MATCH_TTL, lambda: match.find_customers(emails, client))
    raw: list[dict] = []
    if customers:
        ws = _workspace(client)
        after = None
        while len(raw) < rules.MAX_THREADS:
            page = client.query(queries.THREADS, {"customerIds": [c["id"] for c in customers], "after": after})["threads"]
            raw.extend(e["node"] for e in page["edges"])
            if not page["pageInfo"]["hasNextPage"]:
                break
            after = page["pageInfo"]["endCursor"]
        unique = list({t["id"]: t for t in raw[:rules.MAX_THREADS]}.values())
        return {"matched": len(customers), "threads": threads.build_threads(unique, ws)}
    return {"matched": 0, "threads": []}


def customer_support(customer_key: str, *, refresh: bool, statuses: list[str], page: int,
                     page_size: int) -> dict[str, Any] | None:
    emails = _emails(customer_key)
    if emails is None:
        return None
    key = f"l:{customer_key}"
    do_refresh = bool(refresh) and CACHE.allow_refresh(customer_key, rules.REFRESH_COOLDOWN)
    throttled = bool(refresh) and not do_refresh
    stale = False
    try:
        if not emails:
            data, at = {"matched": 0, "threads": []}, time.monotonic()
        elif do_refresh:
            # Load first; cached copies are replaced only on success (spec 3.5).
            data = _load(customer_key, emails, fresh=True)
            at = CACHE.put(key, data)
            CACHE.drop(f"d:{customer_key}:")
        else:
            data, at = CACHE.get_or_load(key, rules.LIST_TTL, lambda: _load(customer_key, emails))
    except SupportUnavailable:
        fallback = CACHE.peek(key)
        if fallback is None:
            raise
        data, at = fallback
        stale = True
    every = data["threads"]
    counts = {s: sum(1 for t in every if t["status"] == s) for s in ("open", "snoozed", "done")}
    counts["waiting"] = sum(1 for t in every if t["waiting_since"])
    waiting = sorted(t["waiting_since"] for t in every if t["waiting_since"])
    shown = [t for t in every if not statuses or t["status"] in statuses]
    logger.info("support_plain.customer key_kind=%s matched=%d threads=%d stale=%s",
                customer_key.split(":")[0], data["matched"], len(every), stale)
    start = (page - 1) * page_size
    return {"customer_key": customer_key, "matched": data["matched"], "threads": shown[start:start + page_size],
            "total": len(shown), "page": page, "page_size": page_size, "counts": counts,
            "last_contact_at": every[0]["updated_at"] if every else None,
            "oldest_waiting_since": waiting[0] if waiting else None,
            "fetched_at": _iso(at), "stale": stale, "refresh_throttled": throttled}


def thread_detail(customer_key: str, thread_id: str, *, refresh: bool = False) -> dict[str, Any] | None:
    listing = customer_support(customer_key, refresh=False, statuses=[], page=1, page_size=rules.MAX_THREADS)
    if listing is None or not any(t["id"] == thread_id for t in listing["threads"]):
        return None  # unknown or another customer's thread never reaches Plain
    key = f"d:{customer_key}:{thread_id}"

    def load() -> dict[str, Any]:
        client = _client_factory()
        nodes: list[dict] = []
        after = None
        while len(nodes) < rules.MAX_ENTRIES:
            t = client.query(queries.THREAD, {"threadId": thread_id, "after": after})["thread"]
            if t is None:
                raise SupportUnavailable("thread_missing")
            conn = t["timelineEntries"]
            nodes.extend(e["node"] for e in conn["edges"])
            if not conn["pageInfo"]["hasNextPage"]:
                break
            after = conn["pageInfo"]["endCursor"]
        return {"thread": threads.thread_item(t, _workspace(client)),
                "entries": threads.build_entries(nodes[:rules.MAX_ENTRIES], (t.get("customer") or {}).get("fullName"))}

    stale = False
    try:
        if refresh and CACHE.allow_refresh(key, rules.REFRESH_COOLDOWN):
            data = load()
            at = CACHE.put(key, data)
        else:
            data, at = CACHE.get_or_load(key, rules.THREAD_TTL, load)
    except SupportUnavailable:
        fallback = CACHE.peek(key)
        if fallback is None:
            raise
        data, at = fallback
        stale = True
    return {**data, "fetched_at": _iso(at), "stale": stale}
