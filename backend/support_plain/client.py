"""Thin Plain GraphQL client. Reads retry once; writes (mutate) never retry (spec 3.2)."""
from __future__ import annotations

import logging
import os
import time
from typing import Any, Callable

import httpx

from support_plain import queries, rules

API_URL = "https://core-api.uk.plain.com/graphql/v1"
logger = logging.getLogger(__name__)


class SupportNotConfigured(Exception):
    """PLAIN_API_KEY is not set."""


class SupportUnavailable(Exception):
    """Plain failed after one retry (429/5xx/timeout/network), refused the key, or returned GraphQL errors."""


class SupportWriteUnconfirmed(Exception):
    """A write may or may not have reached Plain (network error, timeout, 5xx). Never retried."""


class PlainActionError(Exception):
    """Plain answered the mutation with an error payload."""

    def __init__(self, code: str, type_: str, message: str) -> None:
        super().__init__(code)
        self.code, self.type_, self.message = code, type_, message


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

    def mutate(self, mutation: str, variables: dict) -> dict:
        if mutation not in queries.MUTATIONS:
            raise ValueError("unknown mutation")
        op = mutation.split()[1].split("(")[0]
        try:
            r = self._http.post(API_URL, json={"query": mutation, "variables": variables},
                                timeout=rules.WRITE_TIMEOUT)
        except (httpx.ConnectError, httpx.ConnectTimeout) as e:  # never reached Plain: safe to retry
            logger.warning("support_plain.write_not_sent op=%s error=%s", op, type(e).__name__)
            raise SupportUnavailable(type(e).__name__) from e
        except httpx.HTTPError as e:
            logger.warning("support_plain.write_unconfirmed op=%s error=%s", op, type(e).__name__)
            raise SupportWriteUnconfirmed(type(e).__name__) from e
        if r.status_code in (401, 403):
            raise SupportNotConfigured()
        if r.status_code >= 500 or 300 <= r.status_code < 400:  # proxy/redirect: Plain may have acted
            logger.warning("support_plain.write_unconfirmed op=%s status=%s", op, r.status_code)
            raise SupportWriteUnconfirmed(f"http_{r.status_code}")
        if r.status_code >= 400:  # 429 and other 4xx: Plain refused before acting
            logger.warning("support_plain.write_refused op=%s status=%s", op, r.status_code)
            raise SupportUnavailable(f"http_{r.status_code}")
        try:
            body = r.json()
        except ValueError:
            body = None
        if isinstance(body, dict) and body.get("errors"):  # GraphQL rejected the document: nothing ran
            logger.warning("support_plain.write_refused op=%s graphql_errors", op)
            raise SupportUnavailable("graphql_errors")
        payload = next(iter(body["data"].values()), None) if isinstance(body, dict) and isinstance(
            body.get("data"), dict) else None
        if not isinstance(payload, dict):  # a 200 we cannot read (proxy page, empty data): Plain may have acted
            logger.warning("support_plain.write_unconfirmed op=%s bad_response", op)
            raise SupportWriteUnconfirmed("bad_response")
        err = payload.get("error")
        if err:
            logger.warning("support_plain.write_error op=%s code=%s", op, err.get("code"))
            raise PlainActionError(str(err.get("code") or ""), str(err.get("type") or ""),
                                   str(err.get("message") or ""))
        return payload


_shared: dict[str, PlainClient] = {}


def get_client() -> PlainClient:
    """One pooled client per key for the life of the process."""
    key = (os.environ.get("PLAIN_API_KEY") or "").strip()
    if not key:
        raise SupportNotConfigured()
    if key not in _shared:
        _shared.clear()
        _shared[key] = PlainClient(api_key=key)
    return _shared[key]
