"""crm_close.client: GET-only, retry once, typed failures."""
import httpx
import pytest

from crm_close import client as c


def _client(handler, sleeps=None):
    return c.CloseClient(api_key="k", transport=httpx.MockTransport(handler),
                         sleep=(sleeps.append if sleeps is not None else (lambda s: None)))


def test_get_sends_basic_auth_and_returns_json():
    seen = {}

    def handler(req):
        seen["auth"] = req.headers["authorization"]
        seen["url"] = str(req.url)
        return httpx.Response(200, json={"ok": True})

    assert _client(handler).get("me/") == {"ok": True}
    assert seen["auth"].startswith("Basic ") and seen["url"] == "https://api.close.com/api/v1/me/"


def test_retries_once_on_429_honouring_retry_after_capped():
    calls, sleeps = [], []

    def handler(req):
        calls.append(1)
        return httpx.Response(429, headers={"Retry-After": "30"}) if len(calls) == 1 else httpx.Response(200, json={})

    _client(handler, sleeps).get("lead/")
    assert len(calls) == 2 and sleeps == [5]


def test_second_failure_raises_unavailable():
    with pytest.raises(c.CrmUnavailable):
        _client(lambda req: httpx.Response(503)).get("lead/")


def test_timeout_raises_unavailable():
    def handler(req):
        raise httpx.ReadTimeout("slow", request=req)

    with pytest.raises(c.CrmUnavailable):
        _client(handler).get("lead/")


def test_paginate_follows_has_more_and_caps():
    def handler(req):
        skip = int(req.url.params["_skip"])
        return httpx.Response(200, json={"data": [{"id": skip}], "has_more": skip < 2})

    assert [x["id"] for x in _client(handler).paginate("activity/", {"lead_id": "L"}, limit=1)] == [0, 1, 2]


def test_get_only_surface():
    public = {n for n in dir(c.CloseClient) if not n.startswith("_")}
    assert public == {"get", "paginate"}


def test_missing_key_raises_not_configured(monkeypatch):
    monkeypatch.delenv("CLOSE_API_KEY", raising=False)
    with pytest.raises(c.CrmNotConfigured):
        c.get_client()
    monkeypatch.setenv("CLOSE_API_KEY", "  ")
    with pytest.raises(c.CrmNotConfigured):
        c.get_client()
