"""/health carries `stack` only when accumark-stack's compose sets the env.

The frontend draws the DEV STACK bar from this field, so it must be declared on
HealthResponse (response_model drops undeclared keys) and must be absent on prod.
"""
import asyncio

import main


def test_no_env_means_no_stack(monkeypatch):
    monkeypatch.delenv("ACCUMARK_STACK_NAME", raising=False)
    monkeypatch.delenv("ACCUMARK_STACK_LINKS", raising=False)
    assert main._stack_info() is None
    body = asyncio.run(main.health_check()).model_dump()
    assert body["stack"] is None
    assert body["status"] == "ok"


def test_blank_name_is_no_stack(monkeypatch):
    monkeypatch.setenv("ACCUMARK_STACK_NAME", "   ")
    assert main._stack_info() is None


def test_name_and_links_parse_in_compose_order(monkeypatch):
    monkeypatch.setenv("ACCUMARK_STACK_NAME", "alice")
    monkeypatch.setenv(
        "ACCUMARK_STACK_LINKS",
        "WP=http://h:5535/wp-admin/;Mk1=http://h:5532;Mailhog=http://h:5522;IS=http://h:5525/docs",
    )
    info = main._stack_info()
    assert info is not None
    assert info.name == "alice"
    assert list(info.links) == ["WP", "Mk1", "Mailhog", "IS"]
    assert info.links["WP"] == "http://h:5535/wp-admin/"
    assert info.links["IS"] == "http://h:5525/docs"
    assert asyncio.run(main.health_check()).model_dump()["stack"]["name"] == "alice"


def test_malformed_link_pairs_are_dropped(monkeypatch):
    monkeypatch.setenv("ACCUMARK_STACK_NAME", "alice")
    monkeypatch.setenv("ACCUMARK_STACK_LINKS", "WP=http://h:1;;junk;=nolabel;Empty=")
    assert main._stack_info().links == {"WP": "http://h:1"}
