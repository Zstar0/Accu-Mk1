"""Thin Anthropic Messages client over httpx (spec 3). No SDK dependency."""
from __future__ import annotations

import logging
import os
import time
from decimal import Decimal
from typing import Any, Callable

import httpx

API_URL = "https://api.anthropic.com/v1/messages"
MODEL = "claude-sonnet-5-5"
PRICE_IN = Decimal("2")    # USD per million input tokens (October 2026)
PRICE_OUT = Decimal("10")  # USD per million output tokens
logger = logging.getLogger(__name__)


class ReviewNotConfigured(Exception):
    """ANTHROPIC_API_KEY is not set."""


class ReviewUnavailable(Exception):
    """Anthropic failed after one retry, rejected the request, or answered with something unreadable."""


class AnthropicClient:
    def __init__(self, api_key: str | None, workspace_id: str | None = None,
                 transport: httpx.BaseTransport | None = None, sleep: Callable[[float], Any] = time.sleep) -> None:
        headers = {"x-api-key": api_key or "", "anthropic-version": "2023-06-01"}
        if workspace_id:
            headers["anthropic-workspace-id"] = workspace_id
        self._http = httpx.Client(timeout=60.0, transport=transport, headers=headers)
        self._sleep = sleep

    def create(self, payload: dict) -> dict:
        for attempt in (1, 2):
            try:
                r = self._http.post(API_URL, json=payload)
            except httpx.HTTPError as e:
                logger.warning("customer_review.llm_request_failed attempt=%s error=%s", attempt, type(e).__name__)
                if attempt == 2:
                    raise ReviewUnavailable(type(e).__name__) from e
                continue
            if r.status_code in (429, 529) or r.status_code >= 500:
                logger.warning("customer_review.llm_http_%s attempt=%s", r.status_code, attempt)
                if attempt == 2:
                    raise ReviewUnavailable(f"http_{r.status_code}")
                if r.status_code == 429:
                    try:
                        wait = float(r.headers.get("retry-after", "2"))
                    except ValueError:
                        wait = 2.0
                    self._sleep(min(wait, 10))
                continue
            try:
                body = r.json()
            except ValueError:
                body = None
            if r.status_code >= 400:
                kind = ((body or {}).get("error") or {}).get("type") if isinstance(body, dict) else None
                logger.warning("customer_review.llm_http_%s error_type=%s", r.status_code, kind)
                raise ReviewUnavailable(f"http_{r.status_code}")
            if not isinstance(body, dict) or not isinstance(body.get("content"), list):
                logger.warning("customer_review.llm_bad_response status=%s", r.status_code)
                raise ReviewUnavailable("bad_response")
            return body
        raise ReviewUnavailable("unreachable")


def cost_usd(input_tokens: int, output_tokens: int) -> Decimal:
    raw = (Decimal(input_tokens) * PRICE_IN + Decimal(output_tokens) * PRICE_OUT) / Decimal(1_000_000)
    return raw.quantize(Decimal("0.0001"))


_shared: dict[tuple[str, str], AnthropicClient] = {}


def get_client() -> AnthropicClient:
    key = (os.environ.get("ANTHROPIC_API_KEY") or "").strip()
    if not key:
        raise ReviewNotConfigured()
    ws = (os.environ.get("ANTHROPIC_WORKSPACE_ID") or "").strip()
    if (key, ws) not in _shared:
        _shared.clear()
        _shared[(key, ws)] = AnthropicClient(api_key=key, workspace_id=ws or None)
    return _shared[(key, ws)]
