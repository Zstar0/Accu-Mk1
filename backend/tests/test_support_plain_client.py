"""support_plain.client: fixed queries only, GraphQL errors are failures, retry once."""
import json

import httpx
import pytest

from support_plain import client as c
from support_plain import queries


def _client(handler, sleeps=None):
    return c.PlainClient(api_key="k", transport=httpx.MockTransport(handler),
                         sleep=(sleeps.append if sleeps is not None else (lambda s: None)))


def test_posts_query_with_bearer_and_returns_data():
    seen = {}

    def handler(req):
        seen["auth"] = req.headers["authorization"]
        seen["url"] = str(req.url)
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, json={"data": {"myWorkspace": {"id": "w_1"}}})

    assert _client(handler).query(queries.WORKSPACE) == {"myWorkspace": {"id": "w_1"}}
    assert seen["auth"] == "Bearer k" and seen["url"] == c.API_URL
    assert seen["body"] == {"query": queries.WORKSPACE, "variables": {}}


def test_refuses_any_query_not_in_queries_module():
    with pytest.raises(ValueError):
        _client(lambda req: httpx.Response(200, json={"data": {}})).query("query { me { id } }")


def test_graphql_errors_in_a_200_are_unavailable():
    with pytest.raises(c.SupportUnavailable):
        _client(lambda req: httpx.Response(200, json={"errors": [{"message": "x"}], "data": None})).query(queries.WORKSPACE)


def test_retries_once_on_429_honouring_retry_after_capped():
    calls, sleeps = [], []

    def handler(req):
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(429, headers={"Retry-After": "30"})
        return httpx.Response(200, json={"data": {"myWorkspace": {"id": "w"}}})

    _client(handler, sleeps).query(queries.WORKSPACE)
    assert len(calls) == 2 and sleeps == [5]


def test_second_5xx_and_401_raise_unavailable():
    with pytest.raises(c.SupportUnavailable):
        _client(lambda req: httpx.Response(503)).query(queries.WORKSPACE)
    with pytest.raises(c.SupportUnavailable):
        _client(lambda req: httpx.Response(401, json={"message": "no"})).query(queries.WORKSPACE)


def test_network_error_twice_raises_unavailable():
    def handler(req):
        raise httpx.ConnectError("down")

    with pytest.raises(c.SupportUnavailable):
        _client(handler).query(queries.WORKSPACE)


def test_get_client_requires_key_and_reuses_one_client_per_key(monkeypatch):
    monkeypatch.delenv("PLAIN_API_KEY", raising=False)
    with pytest.raises(c.SupportNotConfigured):
        c.get_client()
    monkeypatch.setenv("PLAIN_API_KEY", "k1")
    a = c.get_client()
    assert c.get_client() is a
    monkeypatch.setenv("PLAIN_API_KEY", "k2")
    assert c.get_client() is not a


@pytest.mark.parametrize("resp", [
    httpx.Response(200, text="<html>proxy error</html>"),
    httpx.Response(200, json=[1, 2]),
    httpx.Response(200, json={"data": None}),
    httpx.Response(302, headers={"Location": "https://example.invalid/"}),
])
def test_malformed_responses_are_unavailable(resp):
    with pytest.raises(c.SupportUnavailable):
        _client(lambda req: resp).query(queries.WORKSPACE)


def test_query_refuses_mutations():
    for m in queries.MUTATIONS:
        with pytest.raises(ValueError):
            _client(lambda req: httpx.Response(200, json={"data": {}})).query(m)


def test_mutations_and_queries_are_disjoint():
    assert not (queries.MUTATIONS & queries.ALL)
    assert all(m.lstrip().startswith("mutation ") for m in queries.MUTATIONS)
    assert all(q.lstrip().startswith("query ") for q in queries.ALL)


def test_mutate_refuses_unknown_documents():
    with pytest.raises(ValueError):
        _client(lambda req: httpx.Response(200, json={"data": {}})).mutate("mutation { x }", {})


def test_mutate_returns_root_payload_once():
    calls = []

    def handler(req):
        calls.append(json.loads(req.content))
        return httpx.Response(200, json={"data": {"markThreadAsDone": {"error": None}}})

    assert _client(handler).mutate(queries.MARK_DONE, {"input": {"threadId": "th_1"}}) == {"error": None}
    assert len(calls) == 1 and calls[0]["variables"] == {"input": {"threadId": "th_1"}}


def test_mutate_error_payload_raises_action_error():
    body = {"data": {"replyToThread": {"error": {"code": "cannot_reply_to_thread", "type": "FORBIDDEN",
                                                 "message": "no"}}}}
    with pytest.raises(c.PlainActionError) as e:
        _client(lambda req: httpx.Response(200, json=body)).mutate(queries.REPLY, {"input": {}})
    assert e.value.code == "cannot_reply_to_thread" and e.value.type_ == "FORBIDDEN"


def test_mutate_never_retries_network_errors():
    calls = []

    def handler(req):
        calls.append(1)
        raise httpx.ReadTimeout("slow")

    with pytest.raises(c.SupportWriteUnconfirmed):
        _client(handler).mutate(queries.REPLY, {"input": {}})
    assert len(calls) == 1


def test_mutate_5xx_is_unconfirmed():
    calls = []

    def handler(req):
        calls.append(1)
        return httpx.Response(502)

    with pytest.raises(c.SupportWriteUnconfirmed):
        _client(handler).mutate(queries.REPLY, {"input": {}})
    assert len(calls) == 1


def test_mutate_429_is_unavailable_and_401_is_not_configured():
    with pytest.raises(c.SupportUnavailable):
        _client(lambda req: httpx.Response(429)).mutate(queries.MARK_DONE, {"input": {}})
    with pytest.raises(c.SupportNotConfigured):
        _client(lambda req: httpx.Response(401)).mutate(queries.MARK_DONE, {"input": {}})


def test_mutate_graphql_errors_are_unavailable():
    with pytest.raises(c.SupportUnavailable):
        _client(lambda req: httpx.Response(200, json={"errors": [{"message": "x"}]})).mutate(queries.MARK_DONE, {})


def test_connect_failures_never_left_so_they_are_unavailable():
    def handler(req):
        raise httpx.ConnectError("refused")

    with pytest.raises(c.SupportUnavailable):
        _client(handler).mutate(queries.REPLY, {"input": {}})


@pytest.mark.parametrize("resp", [
    httpx.Response(200, text="<html>proxy error</html>"),
    httpx.Response(200, json={"data": None}),
    httpx.Response(302, headers={"Location": "https://example.invalid/"}),
])
def test_ambiguous_write_responses_are_unconfirmed(resp):
    with pytest.raises(c.SupportWriteUnconfirmed):
        _client(lambda req: resp).mutate(queries.REPLY, {"input": {}})
