"""Thin Close REST client. GET only (the key itself can write; this client never does)."""
from __future__ import annotations

import logging
import time
from typing import Any, Callable

import httpx
from integration_keys import store as integration_keys

BASE_URL = "https://api.close.com/api/v1/"
logger = logging.getLogger(__name__)


class CrmNotConfigured(Exception):
    """CLOSE_API_KEY is not set."""


class CrmUnavailable(Exception):
    """Close failed after one retry (429/5xx/timeout/network)."""


class CloseClient:
    def __init__(self, api_key: str | None = None, transport: httpx.BaseTransport | None = None,
                 sleep: Callable[[float], Any] = time.sleep) -> None:
        self._http = httpx.Client(base_url=BASE_URL, auth=(api_key or "", ""), timeout=10.0, transport=transport)
        self._sleep = sleep

    def get(self, path: str, params: dict | None = None) -> dict:
        for attempt in (1, 2):
            try:
                r = self._http.get(path, params=params)
            except httpx.HTTPError as e:
                logger.warning("crm_close.request_failed path=%s attempt=%s error=%s", path, attempt, type(e).__name__)
                if attempt == 2:
                    raise CrmUnavailable(type(e).__name__) from e
                continue
            if r.status_code == 429 or r.status_code >= 500:
                logger.warning("crm_close.http_%s path=%s attempt=%s", r.status_code, path, attempt)
                if attempt == 2:
                    raise CrmUnavailable(f"http_{r.status_code}")
                if r.status_code == 429:
                    try:
                        wait = float(r.headers.get("Retry-After", "1"))
                    except ValueError:
                        wait = 1.0
                    self._sleep(min(wait, 5))
                continue
            if r.status_code >= 400:
                raise CrmUnavailable(f"http_{r.status_code}")
            return r.json()
        raise CrmUnavailable("unreachable")

    def paginate(self, path: str, params: dict, limit: int = 100, max_items: int = 2000) -> list[dict]:
        out: list[dict] = []
        skip = 0
        while len(out) < max_items:
            page = self.get(path, {**params, "_limit": limit, "_skip": skip})
            data = page.get("data") or []
            out.extend(data)
            if not page.get("has_more") or not data:
                break
            skip += len(data)
        return out[:max_items]


_shared: dict[str, CloseClient] = {}


def get_client() -> CloseClient:
    """One pooled client per key for the life of the process (no per-request socket churn)."""
    key = integration_keys.get("CLOSE_API_KEY") or ""
    if not key:
        raise CrmNotConfigured()
    if key not in _shared:
        _shared.clear()
        _shared[key] = CloseClient(api_key=key)
    return _shared[key]
