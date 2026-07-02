import asyncio
import httpx

from slack_notify.client import SlackClient


def _client(handler):
    return SlackClient("xoxb-test", transport=httpx.MockTransport(handler))


def test_lookup_by_email_hit_and_miss():
    def handler(request):
        assert request.headers["Authorization"] == "Bearer xoxb-test"
        if b"hit@x.com" in request.content or "hit%40x.com" in str(request.url):
            return httpx.Response(200, json={"ok": True, "user": {"id": "U123"}})
        return httpx.Response(200, json={"ok": False, "error": "users_not_found"})
    c = _client(handler)
    assert asyncio.run(c.lookup_by_email("hit@x.com")) == "U123"
    assert asyncio.run(c.lookup_by_email("miss@x.com")) is None


def test_open_dm_and_post_dm():
    def handler(request):
        if request.url.path.endswith("conversations.open"):
            return httpx.Response(200, json={"ok": True, "channel": {"id": "D9"}})
        return httpx.Response(200, json={"ok": True})
    c = _client(handler)
    assert asyncio.run(c.open_dm("U123")) == "D9"
    assert asyncio.run(c.post_dm("D9", "hi", [])) is True


def test_http_error_returns_falsey_never_raises():
    def handler(request):
        return httpx.Response(500)
    c = _client(handler)
    assert asyncio.run(c.lookup_by_email("a@b.c")) is None
    assert asyncio.run(c.post_dm("D9", "hi", [])) is False
