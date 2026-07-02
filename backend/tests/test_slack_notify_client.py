import asyncio
import httpx

from slack_notify.client import SlackClient


def _client(handler):
    return SlackClient("xoxb-test", transport=httpx.MockTransport(handler))


def test_lookup_by_email_is_form_encoded_hit_and_miss():
    def handler(request):
        assert request.headers["Authorization"] == "Bearer xoxb-test"
        # Slack rejects JSON for users.lookupByEmail (invalid_arguments) —
        # the call MUST be application/x-www-form-urlencoded.
        assert request.headers["content-type"].startswith(
            "application/x-www-form-urlencoded")
        if b"hit%40x.com" in request.content or b"hit@x.com" in request.content:
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


def test_user_info_returns_display_name_with_realname_fallback():
    def handler(request):
        assert request.url.path.endswith("users.info")
        if b"U-DISPLAY" in request.content:
            return httpx.Response(200, json={
                "ok": True,
                "user": {"real_name": "Forrest Parker",
                         "profile": {"display_name": "forrest"}}})
        return httpx.Response(200, json={
            "ok": True,
            "user": {"real_name": "No Display",
                     "profile": {"display_name": ""}}})
    c = _client(handler)
    assert asyncio.run(c.user_info("U-DISPLAY")) == "forrest"
    assert asyncio.run(c.user_info("U-BARE")) == "No Display"


def test_http_error_returns_falsey_never_raises():
    def handler(request):
        return httpx.Response(500)
    c = _client(handler)
    assert asyncio.run(c.lookup_by_email("a@b.c")) is None
    assert asyncio.run(c.post_dm("D9", "hi", [])) is False
