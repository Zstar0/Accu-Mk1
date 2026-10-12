"""Agent key format (spec 2026-10-12 section 3.3)."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


def test_wire_key_round_trips_and_only_the_hash_is_derivable():
    from agents import keys
    secret = keys.new_secret()
    assert len(secret) >= 40 and "." not in secret
    token = keys.wire_key("pia", secret)
    assert token.startswith("mk1a.pia.") and keys.is_agent_key(token)
    assert keys.parse(token) == ("pia", secret)
    assert keys.hash_secret(secret) != secret and len(keys.hash_secret(secret)) == 64
    assert keys.hint(secret) == secret[:6]


def test_parse_refuses_malformed_keys():
    from agents import keys
    good = keys.new_secret()
    for bad in ("mk1a.pia", "mk1a..x" + good, "mk1a.Pia." + good, "mk1a.pia.short",
                "eyJhbGciOiJIUzI1NiJ9.x.y", "", "mk1a.p!a." + good):
        assert keys.parse(bad) is None, bad
    assert not keys.is_agent_key("eyJhbGciOiJIUzI1NiJ9.x.y") and not keys.is_agent_key(None)


def test_whitespace_around_the_key_is_tolerated():
    from agents import keys
    secret = keys.new_secret()
    assert keys.parse(f"  {keys.wire_key('pia', secret)} \n") == ("pia", secret)


def test_email_and_username_mapping():
    from types import SimpleNamespace
    from agents import keys
    assert keys.email_for("pia") == "pia@agent.invalid"
    assert keys.username_of(SimpleNamespace(email="pia@agent.invalid")) == "pia"


def test_credential_table_is_created(app_client):
    from sqlalchemy import inspect
    _, db = app_client
    cols = {c["name"] for c in inspect(db.get_bind()).get_columns("agent_credentials")}
    assert {"user_id", "key_hash", "key_hint", "lab_tools", "coa_publishing", "created_at",
            "created_by_user_id", "rotated_at", "last_used_at"} <= cols


from tests.agents_support import app_client  # noqa: E402,F401
