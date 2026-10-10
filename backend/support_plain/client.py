"""Thin Plain GraphQL client. Sends only the fixed queries in queries.py (the key itself can write)."""
from __future__ import annotations

import logging
import time
from typing import Any, Callable

import httpx

from support_plain import queries
from integration_keys import store as integration_keys

API_URL = "https://core-api.uk.plain.com/graphql/v1"
logger = logging.getLogger(__name__)


class SupportNotConfigured(Exception):
    """PLAIN_API_KEY is not set."""


class SupportUnavailable(Exception):
    """Plain failed after one retry (429/5xx/timeout/network), refused the key, or returned GraphQL errors."""


class PlainClient:
    def __init__(self, api_key: str | None = None, transport: httpx.BaseTransport | None = None,
                 sleep: Callable[[float], Any] = time.sleep) -> None:
        self._http = httpx.Client(timeout=10.0, transport=transport,
                                  headers={"Authorization": f"Bearer {api_key or ''}"})
        self._sleep = sleep

    def query(self, query: str, variables: dict | None = None) -> dict:
        if query not in queries.ALL:
            raise ValueError("unknown query")
        op = query.split()[1].split("(")[0]  # operation name, for logs only
        for attempt in (1, 2):
            try:
                r = self._http.post(API_URL, json={"query": query, "variables": variables or {}})
            except httpx.HTTPError as e:
                logger.warning("support_plain.request_failed op=%s attempt=%s error=%s", op, attempt, type(e).__name__)
                if attempt == 2:
                    raise SupportUnavailable(type(e).__name__) from e
                continue
            if r.status_code == 429 or r.status_code >= 500:
                logger.warning("support_plain.http_%s op=%s attempt=%s", r.status_code, op, attempt)
                if attempt == 2:
                    raise SupportUnavailable(f"http_{r.status_code}")
                if r.status_code == 429:
                    try:
                        wait = float(r.headers.get("Retry-After", "1"))
                    except ValueError:
                        wait = 1.0
                    self._sleep(min(wait, 5))
                continue
            if r.status_code >= 400:
                logger.warning("support_plain.http_%s op=%s", r.status_code, op)
                raise SupportUnavailable(f"http_{r.status_code}")
            try:
                body = r.json()
            except ValueError:  # HTML error page, empty 3xx, proxy junk
                body = None
            if not isinstance(body, dict):
                logger.warning("support_plain.bad_response op=%s status=%s", op, r.status_code)
                raise SupportUnavailable("bad_response")
            if body.get("errors"):
                logger.warning("support_plain.graphql_errors op=%s count=%d", op, len(body["errors"]))
                raise SupportUnavailable("graphql_errors")
            data = body.get("data")
            if not isinstance(data, dict):
                logger.warning("support_plain.bad_response op=%s status=%s", op, r.status_code)
                raise SupportUnavailable("bad_response")
            return data
        raise SupportUnavailable("unreachable")


_shared: dict[str, PlainClient] = {}


def get_client() -> PlainClient:
    """One pooled client per key for the life of the process."""
    key = integration_keys.get("PLAIN_API_KEY") or ""
    if not key:
        raise SupportNotConfigured()
    if key not in _shared:
        _shared.clear()
        _shared[key] = PlainClient(api_key=key)
    return _shared[key]
