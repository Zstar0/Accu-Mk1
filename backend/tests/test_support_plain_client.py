"""support_plain.client: fixed queries only, GraphQL errors are failures, retry once."""
import json
import pathlib

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


def test_no_mutation_text_anywhere_in_the_package():
    pkg = pathlib.Path(c.__file__).parent
    for f in pkg.glob("*.py"):
        assert "mutation" not in f.read_text(encoding="utf-8").lower(), f.name


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
