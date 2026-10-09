"""customer_review.llm: headers, retry, typed failures, cost."""
import json
from decimal import Decimal

import httpx
import pytest

from customer_review import llm

OK = {"type": "message", "content": [{"type": "text", "text": "hi"}], "usage": {"input_tokens": 3, "output_tokens": 1}}


def _client(handler, sleeps=None, workspace_id=None):
    return llm.AnthropicClient(api_key="k", workspace_id=workspace_id, transport=httpx.MockTransport(handler),
                               sleep=(sleeps.append if sleeps is not None else (lambda s: None)))


def test_posts_with_headers_and_returns_message():
    seen = {}

    def handler(req):
        seen.update(url=str(req.url), key=req.headers["x-api-key"], ver=req.headers["anthropic-version"],
                    ws=req.headers.get("anthropic-workspace-id"), body=json.loads(req.content))
        return httpx.Response(200, json=OK)

    assert _client(handler).create({"model": llm.MODEL, "messages": []}) == OK
    assert seen["url"] == llm.API_URL and seen["key"] == "k" and seen["ver"] == "2023-06-01" and seen["ws"] is None
    _client(handler, workspace_id="wrkspc_1").create({})
    assert seen["ws"] == "wrkspc_1"


def test_retries_once_on_429_with_capped_retry_after():
    calls, sleeps = [], []

    def handler(req):
        calls.append(1)
        return httpx.Response(429, headers={"retry-after": "60"}) if len(calls) == 1 else httpx.Response(200, json=OK)

    _client(handler, sleeps).create({})
    assert len(calls) == 2 and sleeps == [10]


@pytest.mark.parametrize("status", [529, 500, 503])
def test_overloaded_and_5xx_retry_then_fail(status):
    calls = []

    def handler(req):
        calls.append(1)
        return httpx.Response(status, json={"type": "error", "error": {"type": "overloaded_error"}})

    with pytest.raises(llm.ReviewUnavailable):
        _client(handler).create({})
    assert len(calls) == 2


@pytest.mark.parametrize("resp", [httpx.Response(400, json={"type": "error", "error": {"type": "invalid_request_error"}}),
                                  httpx.Response(200, text="<html>"), httpx.Response(200, json={"content": "x"})])
def test_client_errors_and_malformed_bodies_are_unavailable(resp):
    with pytest.raises(llm.ReviewUnavailable):
        _client(lambda req: resp).create({})


def test_get_client_requires_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(llm.ReviewNotConfigured):
        llm.get_client()
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k1")
    assert llm.get_client() is llm.get_client()


def test_cost():
    assert llm.cost_usd(1_000_000, 100_000) == Decimal("3.0000")
