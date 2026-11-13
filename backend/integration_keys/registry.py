"""Allowlisted third-party keys and their read-only provider tests (spec 3.1)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import httpx

TIMEOUT = 10.0


@dataclass(frozen=True)
class Provider:
    name: str
    label: str
    test: Callable[[httpx.Client, str], httpx.Response]


def _close(c: httpx.Client, key: str) -> httpx.Response:
    return c.get("https://api.close.com/api/v1/me/", auth=(key, ""))


def _plain(c: httpx.Client, key: str) -> httpx.Response:
    return c.post("https://core-api.uk.plain.com/graphql/v1", json={"query": "query { myWorkspace { id } }"},
                  headers={"Authorization": f"Bearer {key}"})


def _anthropic(c: httpx.Client, key: str) -> httpx.Response:
    return c.get("https://api.anthropic.com/v1/models", params={"limit": 1},
                 headers={"x-api-key": key, "anthropic-version": "2023-06-01"})


PROVIDERS: dict[str, Provider] = {p.name: p for p in (
    Provider("CLOSE_API_KEY", "Close CRM", _close),
    Provider("PLAIN_API_KEY", "Plain support", _plain),
    Provider("ANTHROPIC_API_KEY", "Anthropic (AI review)", _anthropic),
)}


def run_test(name: str, key: str, transport: httpx.BaseTransport | None = None) -> str:
    """One read-only call, no retry: "ok", "rejected" (401/403) or "unavailable"."""
    try:
        with httpx.Client(timeout=TIMEOUT, transport=transport) as c:
            r = PROVIDERS[name].test(c, key)
    except httpx.HTTPError:
        return "unavailable"
    if r.status_code in (401, 403):
        return "rejected"
    if not 200 <= r.status_code < 300:
        return "unavailable"
    if name == "PLAIN_API_KEY":  # GraphQL reports failures inside a 200
        try:
            body = r.json()
        except ValueError:
            return "unavailable"
        if not isinstance(body, dict) or body.get("errors") or not ((body.get("data") or {}).get("myWorkspace") or {}).get("id"):
            return "unavailable"
    return "ok"
