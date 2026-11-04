"""ai_chat.providers: the /admin/acp-providers routes and Test connection (spec 5, 6, 11)."""
import asyncio
import os
import sys
from datetime import datetime

import anyio
import pytest
from cryptography.fernet import Fernet
from sqlalchemy import delete, event, select, text, update
from sqlalchemy.orm import Session, sessionmaker

from ai_chat import providers, sessions, transport
from ai_chat.models import AcpProvider, AiChat

pytestmark = pytest.mark.anyio

URL = "/admin/acp-providers"
HOST_KEY = transport.generate_keypair()[1]
TOOLS_OK = "Available tools (1):\n  todo_list: Track a task list for multi-step work"
TOOLS_BAD = "Available tools (2):\n  todo_list: Track a task list for multi-step work\n  terminal: Run a command"
AS_STANDARD = {"X-Test-User": "2"}
AS_OTHER_ADMIN = {"X-Test-User": "3"}


@pytest.fixture
def anyio_backend():
    return "asyncio"  # acp runs on asyncio only


async def call(api, method: str, url: str, **kwargs):
    """Every request is bounded: some of them start a real agent process."""
    with anyio.fail_after(60):
        return await api.request(method, url, **kwargs)


def body(**over) -> dict:
    """A valid new-provider body ("nova", disabled, admin only)."""
    return {"slug": "nova", "display_name": "Nova", "ssh_host": "192.0.2.30", "ssh_user": "hermes",
            "host_key": HOST_KEY, "launcher_path": "/opt/mk1-acp/launch", "authorized_from": "192.0.2.20",
            "session_cwd": "/home/hermes", **over}


async def create(api, **over) -> dict:
    resp = await call(api, "POST", URL, json=body(**over))
    assert resp.status_code == 201, resp.text
    return resp.json()


async def keyed(api, **over) -> dict:
    """A new provider with a generated key."""
    made = await create(api, **over)
    resp = await call(api, "POST", f"{URL}/{made['id']}/key")
    assert resp.status_code == 200, resp.text
    return resp.json()


def stored(env, provider_id: int) -> AcpProvider:
    with env.Session() as s:
        row = s.get(AcpProvider, provider_id)
        if row is not None:
            s.expunge(row)
        return row


def tools_reply(env, tmp_path, text: str) -> None:
    path = tmp_path / "tools.txt"
    path.write_text(text, encoding="utf-8")
    env.flags = ["--tools-reply", str(path)]


async def probe(api, provider_id: int) -> dict:
    resp = await call(api, "POST", f"{URL}/{provider_id}/test")
    assert resp.status_code == 200, resp.text
    return resp.json()


async def put(api, provider_id: int, **fields):
    return await call(api, "PUT", f"{URL}/{provider_id}", json=fields)


# ---- shape and secrets --------------------------------------------------------------------------

async def test_create_and_list_never_returns_private_key(ai_chat_api, ai_chat_env):
    created = await call(ai_chat_api, "POST", URL, json=body())
    made = created.json()
    generated = await call(ai_chat_api, "POST", f"{URL}/{made['id']}/key")
    listed = await call(ai_chat_api, "GET", URL)
    row = stored(ai_chat_env, made["id"])
    pem = transport.decrypt_private(row.private_key_ciphertext).decode()
    assert pem.startswith("-----BEGIN OPENSSH PRIVATE KEY-----")
    for resp in (created, generated, listed):
        assert resp.status_code in (200, 201)
        text = resp.text
        assert "private" not in text.lower()
        assert row.private_key_ciphertext not in text
        assert pem.splitlines()[1] not in text  # the key's own base64
    assert generated.json()["public_key"].startswith("ssh-ed25519 ")


async def test_every_out_key_survives_response_model(ai_chat_api):
    # FastAPI drops response keys the model does not declare, silently: compare against the model itself.
    listed = await call(ai_chat_api, "GET", URL)
    assert set(listed.json()["providers"][0]) == set(providers.ProviderOut.model_fields)
    assert set(await create(ai_chat_api)) == set(providers.ProviderOut.model_fields)


async def test_list_reports_configuration_and_live_sessions(ai_chat_api, ai_chat_env):
    listed = (await call(ai_chat_api, "GET", URL)).json()
    first = listed["providers"][0]
    assert listed["configured"] is True
    assert (first["slug"], first["live_sessions"], first["allowed_roles"]) == ("jarvis", 0, ["admin"])
    assert first["host_key_fingerprint"].startswith("SHA256:")
    assert first["key_created_at"] is None and first["updated_at"].endswith("Z")
    session = sessions.MANAGER.reserve(1, 1, ai_chat_env.provider())
    with anyio.fail_after(30):
        await session.start()
    assert (await call(ai_chat_api, "GET", URL)).json()["providers"][0]["live_sessions"] == 1


async def test_create_defaults_and_duplicate_slug(ai_chat_api):
    made = await create(ai_chat_api)
    defaults = {"enabled": False, "ssh_port": 22, "allowed_roles": ["admin"], "inject_mk1_tools": False,
                "max_sessions": 4, "idle_minutes": 15, "permission_timeout_s": 240, "agent_approval_timeout_s": 300,
                "public_key": None, "authorized_keys_line": None, "last_test_ok": None}
    assert {k: made[k] for k in defaults} == defaults
    dup = await call(ai_chat_api, "POST", URL, json=body())
    assert (dup.status_code, dup.json()["detail"]) == (422, {"code": "invalid_input", "field": "slug"})
    assert len((await call(ai_chat_api, "GET", URL)).json()["providers"]) == 2


async def test_create_requires_every_core_field(ai_chat_api):
    for field in providers._REQUIRED:
        resp = await call(ai_chat_api, "POST", URL, json={k: v for k, v in body().items() if k != field})
        assert (resp.status_code, resp.json()["detail"]) == (422, {"code": "invalid_input", "field": field})


# ---- validation ---------------------------------------------------------------------------------

@pytest.mark.parametrize("field,value", [
    ("ssh_host", "-oProxyCommand=touch /tmp/pwned"), ("ssh_host", "host name"), ("ssh_host", "a;b"),
    ("ssh_host", "127.1"), ("ssh_host", "host\n"), ("ssh_host", ""),
    ("ssh_port", 0), ("ssh_port", 65536),
    ("ssh_user", "Root"), ("ssh_user", "a b"),
    ("host_key", "ssh-ed25519 !!!"), ("host_key", "ssh-rsa AAAA"),
    ("authorized_from", "example.com"), ("authorized_from", "10.0.0.1/8"),
    ("launcher_path", "relative/path"), ("launcher_path", '/opt/x"; rm -rf /'),
    ("session_cwd", "C:\\Users\\x"), ("session_cwd", "home/hermes"),
    ("slug", "A"), ("slug", "x"),
    ("display_name", "   "), ("display_name", "two\nlines"), ("display_name", "x" * 101),
    ("max_sessions", 0), ("max_sessions", 17), ("idle_minutes", 0), ("idle_minutes", 241),
    ("permission_timeout_s", 0), ("agent_approval_timeout_s", 3601),
])
async def test_hostile_ssh_host_422(ai_chat_api, field, value):
    # Every field fails the same way: 422 naming the column, and the input is never echoed.
    resp = await call(ai_chat_api, "POST", URL, json=body(**{field: value}))
    assert resp.status_code == 422
    assert resp.json()["detail"] == {"code": "invalid_input", "field": field}
    if isinstance(value, str) and value.strip():
        assert value not in resp.text
    assert len((await call(ai_chat_api, "GET", URL)).json()["providers"]) == 1


@pytest.mark.parametrize("roles", [["agent"], ["admin", "agent"], [], ["root"], ["admin", 1]])
async def test_agent_role_refused(ai_chat_api, roles):
    created = await call(ai_chat_api, "POST", URL, json=body(allowed_roles=roles))
    assert created.status_code == 422
    if all(isinstance(r, str) for r in roles):
        assert created.json()["detail"] == {"code": "invalid_input", "field": "allowed_roles"}
    made = await create(ai_chat_api)
    assert (await put(ai_chat_api, made["id"], allowed_roles=roles)).status_code == 422
    assert (await call(ai_chat_api, "GET", URL)).json()["providers"][1]["allowed_roles"] == ["admin"]


async def test_roles_are_normalized(ai_chat_api):
    made = await create(ai_chat_api, allowed_roles=["standard", "admin", "admin"])
    assert made["allowed_roles"] == ["admin", "standard"]


async def test_timeout_order_enforced(ai_chat_api):
    detail = {"code": "invalid_input", "field": "permission_timeout_s"}
    for pair in ((600, 600), (700, 600)):
        resp = await call(ai_chat_api, "POST", URL, json=body(permission_timeout_s=pair[0],
                                                              agent_approval_timeout_s=pair[1]))
        assert (resp.status_code, resp.json()["detail"]) == (422, detail)
    made = await create(ai_chat_api, permission_timeout_s=100, agent_approval_timeout_s=600)
    assert (made["permission_timeout_s"], made["agent_approval_timeout_s"]) == (100, 600)
    # An update is checked against the stored value of the field it leaves alone.
    resp = await put(ai_chat_api, made["id"], agent_approval_timeout_s=100)
    assert (resp.status_code, resp.json()["detail"]) == (422, detail)
    assert (await put(ai_chat_api, made["id"], permission_timeout_s=599)).status_code == 200


async def test_inject_mk1_tools_not_supported(ai_chat_api):
    resp = await call(ai_chat_api, "POST", URL, json=body(inject_mk1_tools=True))
    assert (resp.status_code, resp.json()["detail"]) == (422, {"code": "not_supported"})
    made = await create(ai_chat_api, inject_mk1_tools=False)
    resp = await put(ai_chat_api, made["id"], inject_mk1_tools=True)
    assert (resp.status_code, resp.json()["detail"]) == (422, {"code": "not_supported"})
    assert (await put(ai_chat_api, made["id"], inject_mk1_tools=False)).json()["inject_mk1_tools"] is False


async def test_keys_not_configured_503(ai_chat_api, monkeypatch):
    monkeypatch.delenv("INTEGRATION_KEYS_SECRET")
    detail = {"code": "keys_not_configured"}
    listed = await call(ai_chat_api, "GET", URL)
    assert listed.status_code == 200 and listed.json()["configured"] is False
    for method, url, json in (("POST", URL, body()), ("PUT", f"{URL}/1", {"display_name": "X"}),
                              ("POST", f"{URL}/1/key", None)):
        resp = await call(ai_chat_api, method, url, json=json)
        assert (resp.status_code, resp.json()["detail"]) == (503, detail), (method, url)
    assert len(listed.json()["providers"]) == 1


# ---- enabling -----------------------------------------------------------------------------------

async def test_enable_without_key_not_ready(ai_chat_api, ai_chat_env):
    not_ready = {"code": "not_ready"}
    resp = await call(ai_chat_api, "POST", URL, json=body(enabled=True))
    assert (resp.status_code, resp.json()["detail"]) == (409, not_ready)
    made = await create(ai_chat_api)
    resp = await put(ai_chat_api, made["id"], enabled=True)
    assert (resp.status_code, resp.json()["detail"]) == (409, not_ready)
    await call(ai_chat_api, "POST", f"{URL}/{made['id']}/key")
    # A host key is needed too. The routes never clear one, so this takes a hand edit.
    with ai_chat_env.Session() as s:
        s.execute(update(AcpProvider).where(AcpProvider.id == made["id"]).values(host_key=None))
        s.commit()
    resp = await put(ai_chat_api, made["id"], enabled=True)
    assert (resp.status_code, resp.json()["detail"]) == (409, not_ready)
    resp = await put(ai_chat_api, made["id"], enabled=True, host_key=HOST_KEY)
    assert (resp.status_code, resp.json()["enabled"]) == (200, True)  # admin only: no test needed


async def test_enable_standard_requires_passing_test(ai_chat_api, ai_chat_env, tmp_path):
    made = await keyed(ai_chat_api, allowed_roles=["admin", "standard"])
    pid = made["id"]
    tools_reply(ai_chat_env, tmp_path, TOOLS_BAD)  # lists a terminal
    result = await probe(ai_chat_api, pid)
    assert result["ok"] is False and result["error"] == "tool not allowed for standard users: terminal"
    assert stored(ai_chat_env, pid).last_test_ok is False
    resp = await put(ai_chat_api, pid, enabled=True)
    assert (resp.status_code, resp.json()["detail"]) == (409, {"code": "not_ready"})
    tools_reply(ai_chat_env, tmp_path, TOOLS_OK)
    assert (await probe(ai_chat_api, pid))["ok"] is True
    resp = await put(ai_chat_api, pid, enabled=True)
    assert (resp.status_code, resp.json()["enabled"], resp.json()["last_test_ok"]) == (200, True, True)


async def test_the_test_must_come_from_the_current_settings(ai_chat_api, ai_chat_env, tmp_path):
    tools_reply(ai_chat_env, tmp_path, TOOLS_OK)
    pid = (await keyed(ai_chat_api, allowed_roles=["admin", "standard"]))["id"]
    assert (await probe(ai_chat_api, pid))["ok"] is True
    # Sending the stored values back is not a change.
    resend = {k: v for k, v in body().items() if k != "slug"} | {"allowed_roles": ["standard", "admin"]}
    assert (await put(ai_chat_api, pid, **resend)).json()["last_test_ok"] is True
    assert (await put(ai_chat_api, pid, enabled=True)).status_code == 200
    # A changed setting while enabled and standard is refused outright, and nothing is written.
    resp = await put(ai_chat_api, pid, ssh_port=2222)
    assert (resp.status_code, resp.json()["detail"]) == (409, {"code": "not_ready"})
    row = stored(ai_chat_env, pid)
    assert (row.ssh_port, row.enabled, row.last_test_ok) == (22, True, True)
    # Disable first: the change goes through and the old test is void.
    resp = await put(ai_chat_api, pid, enabled=False, ssh_port=2222)
    assert (resp.status_code, resp.json()["last_test_ok"]) == (200, None)
    assert (await put(ai_chat_api, pid, enabled=True)).status_code == 409
    assert (await probe(ai_chat_api, pid))["ok"] is True
    assert (await put(ai_chat_api, pid, enabled=True)).status_code == 200
    # Revoking standard needs no test. Each of the other fields that matter voids it too.
    resp = await put(ai_chat_api, pid, allowed_roles=["admin"])
    assert (resp.status_code, resp.json()["enabled"], resp.json()["last_test_ok"]) == (200, True, None)
    new_host_key = transport.generate_keypair()[1]
    for field, value in (("ssh_host", "192.0.2.31"), ("ssh_user", "other"), ("host_key", new_host_key),
                         ("session_cwd", "/srv/elsewhere"), ("allowed_roles", ["admin", "standard"])):
        assert (await probe(ai_chat_api, pid))["ok"] is True
        assert stored(ai_chat_env, pid).last_test_ok is True
        resp = await put(ai_chat_api, pid, enabled=False, **{field: value})
        assert (resp.status_code, resp.json()["last_test_ok"]) == (200, None), field


async def test_generating_a_key_voids_the_test(ai_chat_api, ai_chat_env, tmp_path):
    tools_reply(ai_chat_env, tmp_path, TOOLS_OK)
    pid = (await keyed(ai_chat_api, allowed_roles=["admin", "standard"]))["id"]
    await probe(ai_chat_api, pid)
    assert (await put(ai_chat_api, pid, enabled=True)).json()["enabled"] is True
    before = stored(ai_chat_env, pid)
    resp = await call(ai_chat_api, "POST", f"{URL}/{pid}/key")
    assert (resp.status_code, resp.json()["enabled"], resp.json()["last_test_ok"]) == (200, False, None)
    after = stored(ai_chat_env, pid)
    assert after.public_key != before.public_key and after.private_key_ciphertext != before.private_key_ciphertext
    # Admin only: the provider stays enabled, but its test is void.
    assert (await probe(ai_chat_api, 1))["ok"] is True
    resp = await call(ai_chat_api, "POST", f"{URL}/1/key")
    assert (resp.json()["enabled"], resp.json()["last_test_ok"]) == (True, None)


# ---- update, delete -----------------------------------------------------------------------------

async def test_put_is_partial_and_ignores_slug(ai_chat_api, ai_chat_env):
    made = await create(ai_chat_api)
    resp = await call(ai_chat_api, "PUT", f"{URL}/{made['id']}", headers=AS_OTHER_ADMIN,
                      json={"display_name": "  Nova 2 ", "slug": "other", "host_key": None})
    assert resp.status_code == 200
    changed = resp.json()
    assert (changed["slug"], changed["display_name"], changed["host_key"]) == ("nova", "Nova 2", HOST_KEY)
    assert {k: v for k, v in changed.items() if k not in ("display_name", "updated_at")} == \
        {k: v for k, v in made.items() if k not in ("display_name", "updated_at")}
    row = stored(ai_chat_env, made["id"])
    assert (row.created_by_user_id, row.updated_by_user_id) == (1, 3)
    resp = await put(ai_chat_api, made["id"], ssh_host="-oProxyCommand=x", display_name="Nope")
    assert (resp.status_code, resp.json()["detail"]) == (422, {"code": "invalid_input", "field": "ssh_host"})
    assert stored(ai_chat_env, made["id"]).display_name == "Nova 2"
    assert (await put(ai_chat_api, made["id"])).status_code == 200
    # The slug is ignored whatever it holds, so an invalid one is no reason to refuse the rest.
    resp = await put(ai_chat_api, made["id"], slug="NOT VALID", display_name="Nova 3")
    assert (resp.status_code, resp.json()["slug"], resp.json()["display_name"]) == (200, "nova", "Nova 3")


async def test_delete_in_use_conflicts(ai_chat_api, ai_chat_env):
    resp = await call(ai_chat_api, "DELETE", f"{URL}/1")
    assert (resp.status_code, resp.json()["detail"]) == (409, {"code": "provider_in_use"})
    with ai_chat_env.Session() as s:  # an archived chat still counts: it keeps the approval record
        s.execute(update(AiChat).where(AiChat.id == 1).values(archived=True))
        s.commit()
    assert (await call(ai_chat_api, "DELETE", f"{URL}/1")).status_code == 409
    assert stored(ai_chat_env, 1) is not None
    made = await create(ai_chat_api)
    resp = await call(ai_chat_api, "DELETE", f"{URL}/{made['id']}")
    assert (resp.status_code, resp.content) == (204, b"")
    assert stored(ai_chat_env, made["id"]) is None
    assert (await call(ai_chat_api, "DELETE", f"{URL}/{made['id']}")).status_code == 404


async def test_unknown_provider_404(ai_chat_api):
    for method, suffix, json in (("PUT", "", {}), ("DELETE", "", None), ("POST", "/key", None),
                                 ("POST", "/test", None)):
        resp = await call(ai_chat_api, method, f"{URL}/99{suffix}", json=json)
        assert (resp.status_code, resp.json()["detail"]) == (404, {"code": "provider_not_found"}), (method, suffix)


async def test_non_admin_403(ai_chat_api, ai_chat_env):
    for method, suffix, json in (("GET", "", None), ("POST", "", body()), ("PUT", "/1", {"display_name": "X"}),
                                 ("DELETE", "/1", None), ("POST", "/1/key", None), ("POST", "/1/test", None)):
        resp = await call(ai_chat_api, method, URL + suffix, json=json, headers=AS_STANDARD)
        assert resp.status_code == 403, (method, suffix)
    row = stored(ai_chat_env, 1)
    assert (row.display_name, row.public_key is not None, row.last_test_at) == ("Jarvis", True, None)
    assert (await call(ai_chat_api, "GET", URL, headers=AS_OTHER_ADMIN)).status_code == 200


async def test_every_write_commits_before_it_closes_sessions(ai_chat_api, ai_chat_env, monkeypatch):
    pool = ai_chat_env.Session.kw["bind"].pool
    seen, held = [], []

    async def close(provider_id: int) -> None:
        held.append(pool.checkedout())  # no connection is held across the close (the Mk1 pool-exhaustion outage)
        row = stored(ai_chat_env, provider_id)  # another connection: sees what the route has committed
        seen.append((provider_id, None if row is None else (row.display_name, row.public_key)))

    monkeypatch.setattr(sessions.MANAGER, "close_provider", close)
    made = await create(ai_chat_api)
    assert seen == []  # a new provider has no sessions
    await put(ai_chat_api, made["id"], display_name="Renamed")
    await call(ai_chat_api, "POST", f"{URL}/{made['id']}/key")
    public = stored(ai_chat_env, made["id"]).public_key
    await call(ai_chat_api, "DELETE", f"{URL}/{made['id']}")
    assert seen == [(made["id"], ("Renamed", None)), (made["id"], ("Renamed", public)), (made["id"], None)]
    assert held == [0, 0, 0]


@pytest.mark.parametrize(("method", "path", "payload", "status"), [
    ("POST", "", body(), 201),
    ("PUT", "/1", {"display_name": "Renamed"}, 200),
    ("POST", "/1/key", None, 200),
    ("POST", "/1/test", None, 200),
], ids=["create", "update", "key", "test"])
async def test_no_pool_checkout_on_the_loop_after_a_commit(ai_chat_api, ai_chat_env, loop_checkouts, method, path,
                                                           payload, status):
    resp = await call(ai_chat_api, method, f"{URL}{path}", json=payload)
    assert resp.status_code == status, resp.text
    assert loop_checkouts == []
    if path != "/1/test":  # nothing was reloaded: the answer is what a fresh read gives, unset columns included
        out = resp.json()
        with ai_chat_env.Session() as s:
            rows = {r.id: providers._out(r) for r in s.scalars(select(AcpProvider))}
        assert out == rows[out["id"]].model_dump()


async def test_update_closes_live_sessions(ai_chat_api, ai_chat_env):
    session = sessions.MANAGER.reserve(1, 1, ai_chat_env.provider())
    with anyio.fail_after(30):
        await session.start()
    resp = await put(ai_chat_api, 1, display_name="Jarvis 2")
    assert (resp.status_code, resp.json()["live_sessions"]) == (200, 0)
    # A return from close_provider does not prove the process is gone, so wait for its owner, bounded.
    with anyio.fail_after(30):
        await asyncio.wait({session._owner})
    assert session.proc.returncode is not None


# ---- authorized_keys ----------------------------------------------------------------------------

async def test_authorized_keys_line_rendered(ai_chat_api):
    made = await create(ai_chat_api)
    assert made["authorized_keys_line"] is None  # no key yet
    key = await call(ai_chat_api, "POST", f"{URL}/{made['id']}/key")
    out = key.json()
    assert out["authorized_keys_line"] == (
        f'from="192.0.2.20",restrict,command="/opt/mk1-acp/launch" {out["public_key"]} mk1-acp-nova')
    assert out["key_created_at"].endswith("Z") and out["key_created_at"] <= out["updated_at"]
    again = (await call(ai_chat_api, "POST", f"{URL}/{made['id']}/key")).json()
    assert again["public_key"] != out["public_key"] and again["authorized_keys_line"] != out["authorized_keys_line"]
    moved = (await put(ai_chat_api, made["id"], launcher_path="/srv/launch", authorized_from="198.51.100.7")).json()
    assert moved["authorized_keys_line"].startswith('from="198.51.100.7",restrict,command="/srv/launch" ssh-ed25519 ')


# ---- Test connection ----------------------------------------------------------------------------

async def test_test_connection_reports_tools_and_caps(ai_chat_api, ai_chat_env):
    result = await probe(ai_chat_api, 1)  # provider 1 is enabled, admin only, and speaks the fake agent
    assert result["ok"] is True and result["error"] is None and result["stderr_tail"] is None
    assert result["tools"] == ["mcp__mk1__create_flag", "mcp__mk1__whoami", "todo_list"]
    assert result["agent_info"] == {"name": "fake-acp-agent", "version": "1.0"}
    assert result["capabilities"]["loadSession"] is True
    timings = result["timings_ms"]
    assert set(timings) == {"connect", "initialize", "new_session", "tools"}
    assert timings["initialize"] is None  # LiveSession.start is one step
    assert all(isinstance(timings[k], int) and timings[k] >= 0 for k in ("connect", "new_session", "tools"))
    row = stored(ai_chat_env, 1)
    assert (row.last_test_ok, row.last_test_error, row.last_test_at is not None) == (True, None, True)
    assert row.last_agent_info["name"] == "fake-acp-agent"  # record_connect ran on the test path
    assert ai_chat_env.events() == []  # nothing reaches the hub
    assert sessions.MANAGER.live_count(1) == 0  # and the session was never registered


async def test_no_db_connection_is_held_while_the_agent_runs(ai_chat_api, ai_chat_env, monkeypatch):
    pool = ai_chat_env.Session.kw["bind"].pool
    held, spawn = [], sessions.spawn_command

    def watching(provider):  # called when the agent is being started
        held.append(pool.checkedout())
        return spawn(provider)

    monkeypatch.setattr(sessions, "spawn_command", watching)
    assert (await probe(ai_chat_api, 1))["ok"] is True
    assert held == [0]


async def test_test_connection_does_not_touch_updated_at(ai_chat_api, ai_chat_env):
    before = stored(ai_chat_env, 1).updated_at
    await probe(ai_chat_api, 1)
    assert stored(ai_chat_env, 1).updated_at == before


async def test_test_connection_works_on_a_disabled_provider(ai_chat_api):
    made = await keyed(ai_chat_api)
    assert made["enabled"] is False
    result = await probe(ai_chat_api, made["id"])
    assert result["ok"] is True
    assert (await call(ai_chat_api, "GET", URL)).json()["providers"][1]["last_test_ok"] is True


async def test_test_connection_failure_shows_stderr(ai_chat_api, ai_chat_env, monkeypatch):
    code = "import sys; sys.stderr.write('Permission denied (publickey).\\n'); sys.exit(255)"
    monkeypatch.setattr(sessions, "spawn_command", lambda provider: [sys.executable, "-c", code])
    result = await probe(ai_chat_api, 1)
    assert result["ok"] is False and result["error"] == "Could not connect."
    assert result["stderr_tail"] == ["Permission denied (publickey)."]
    assert result["timings_ms"] == dict.fromkeys(("connect", "initialize", "new_session", "tools"))
    assert result["tools"] == [] and result["agent_info"] is None
    row = stored(ai_chat_env, 1)
    assert (row.last_test_ok, row.last_test_error) == (False, "Could not connect.")
    assert "Permission denied" not in (row.last_test_error or "")  # stderr is returned, never stored


async def test_failed_tool_check_returns_the_error_and_the_stderr_list(ai_chat_api, ai_chat_env, tmp_path):
    tools_reply(ai_chat_env, tmp_path, "Available tools (0):")
    result = await probe(ai_chat_api, 1)
    assert (result["ok"], result["error"], result["tools"]) == (False, "no tools listed", [])
    assert result["stderr_tail"] == []  # present on every failure; this agent wrote nothing to stderr
    tools_reply(ai_chat_env, tmp_path, "not the format we know")
    result = await probe(ai_chat_api, 1)
    assert (result["ok"], result["error"]) == (False, "tool list not readable")
    assert result["timings_ms"]["tools"] is not None  # the steps that ran are timed


async def test_test_connection_timeout(ai_chat_api, ai_chat_env, monkeypatch):
    monkeypatch.setattr(providers, "TEST_TIMEOUT_S", 0.5)
    ai_chat_env.flags = ["--no-init"]  # never answers initialize
    result = await probe(ai_chat_api, 1)
    assert (result["ok"], result["error"]) == (False, "Test connection timed out.")
    assert result["timings_ms"]["connect"] is None
    assert stored(ai_chat_env, 1).last_test_error == "Test connection timed out."


async def test_a_cancelled_request_still_closes_the_agent(ai_chat_api, ai_chat_env, monkeypatch):
    made = []
    init = sessions.LiveSession.__init__

    def capture(self, *args, **kwargs):
        init(self, *args, **kwargs)
        made.append(self)

    monkeypatch.setattr(sessions.LiveSession, "__init__", capture)
    ai_chat_env.flags = ["--no-init"]  # the test sits in `initialize`, so there is something to interrupt
    request = asyncio.ensure_future(call(ai_chat_api, "POST", f"{URL}/1/test"))
    with anyio.fail_after(30):
        while not (made and made[0].proc is not None):
            await asyncio.sleep(0.02)
    request.cancel()
    with pytest.raises(asyncio.CancelledError):
        await request
    session = made[0]  # the close finished before the cancellation left the route
    assert session._owner.done() and session.proc.returncode is not None
    assert stored(ai_chat_env, 1).last_test_at is None


async def test_test_connection_without_keys_is_503(ai_chat_api, ai_chat_env, monkeypatch):
    monkeypatch.setattr(sessions, "spawn_command", sessions.ssh_command)  # the real command needs the secret
    monkeypatch.delenv("INTEGRATION_KEYS_SECRET")
    resp = await call(ai_chat_api, "POST", f"{URL}/1/test")
    assert (resp.status_code, resp.json()["detail"]) == (503, {"code": "keys_not_configured"})
    assert stored(ai_chat_env, 1).last_test_at is None


async def test_test_connection_bad_stored_host_key(ai_chat_api, ai_chat_env, monkeypatch):
    monkeypatch.setattr(sessions, "spawn_command", sessions.ssh_command)
    with ai_chat_env.Session() as s:
        s.execute(update(AcpProvider).where(AcpProvider.id == 1).values(host_key="not a host key"))
        s.commit()
    result = await probe(ai_chat_api, 1)
    assert (result["ok"], result["error"]) == (False, "The stored host key is not valid.")
    assert (await call(ai_chat_api, "GET", URL)).json()["providers"][0]["host_key_fingerprint"] is None  # still lists


async def test_other_failures_are_reported_without_their_text(ai_chat_api, ai_chat_env, monkeypatch, caplog):
    def boom(provider):
        raise RuntimeError("secret-looking text")

    monkeypatch.setattr(sessions, "spawn_command", boom)
    caplog.set_level("DEBUG")
    result = await probe(ai_chat_api, 1)
    assert (result["ok"], result["error"]) == (False, "Test connection failed.")
    assert "secret-looking" not in caplog.text and "RuntimeError" in caplog.text
    assert "secret-looking" not in str(result)


@pytest.mark.parametrize("edit", [{"ssh_port": 2222}, {"enabled": False}])  # enabled is not in the snapshot
async def test_a_result_for_edited_settings_is_not_recorded(ai_chat_api, ai_chat_env, monkeypatch, edit):
    start = sessions.spawn_command

    def edited_meanwhile(provider):  # an admin saves while the agent is being tested
        with ai_chat_env.Session() as s:
            s.execute(update(AcpProvider).where(AcpProvider.id == 1).values(**edit))
            s.commit()
        return start(provider)

    monkeypatch.setattr(sessions, "spawn_command", edited_meanwhile)
    result = await probe(ai_chat_api, 1)
    assert result["ok"] is True  # the caller still gets the answer
    row = stored(ai_chat_env, 1)
    assert (row.last_test_at, row.last_test_ok) == (None, None)
    assert all(getattr(row, k) == v for k, v in edit.items())


async def test_a_save_between_the_read_and_the_write_keeps_the_result_out(ai_chat_env, monkeypatch):
    with ai_chat_env.Session() as s:
        row = s.get(AcpProvider, 1)
        snapshot, edited_at = sessions.ProviderSnapshot.from_row(row), row.updated_at

    class AdminSavesFirst(Session):
        def execute(self, statement, *args, **kwargs):
            if getattr(statement, "is_update", False):
                self.rollback()  # lets the other writer in on SQLite; Postgres read committed needs no such help
                with ai_chat_env.Session() as admin:  # what `update_provider` writes when a `_RETEST` field changes
                    admin.execute(update(AcpProvider).where(AcpProvider.id == 1).values(
                        ssh_host="new.host", last_test_ok=None, updated_at=datetime(2030, 1, 1)))
                    admin.commit()
            return super().execute(statement, *args, **kwargs)

    monkeypatch.setattr(sessions, "_session_factory", sessionmaker(bind=ai_chat_env.Session.kw["bind"],
                                                                   class_=AdminSavesFirst))
    await asyncio.to_thread(providers._record_test, snapshot, edited_at, True, None)
    row = stored(ai_chat_env, 1)
    assert (row.ssh_host, row.last_test_ok, row.last_test_at) == ("new.host", None, None)


@pytest.mark.parametrize("case", ["no key", "rotated secret"])
async def test_a_key_that_cannot_be_used_is_explained(ai_chat_api, monkeypatch, case):
    monkeypatch.setattr(sessions, "spawn_command", sessions.ssh_command)  # the real command, which decrypts the key
    made = await create(ai_chat_api) if case == "no key" else await keyed(ai_chat_api)
    if case == "rotated secret":
        monkeypatch.setenv("INTEGRATION_KEYS_SECRET", Fernet.generate_key().decode())
    result = await probe(ai_chat_api, made["id"])
    # The agent never started, so the reason travels with the exception: the session's own stderr is empty.
    assert (result["ok"], result["error"]) == (False, "Could not connect.")
    assert result["stderr_tail"] == ["provider key cannot be decrypted; generate a new key"]


async def test_a_provider_deleted_during_the_test_still_gets_its_answer(ai_chat_api, ai_chat_env, monkeypatch):
    pid = (await keyed(ai_chat_api))["id"]
    start = sessions.spawn_command

    def deleted_meanwhile(provider):
        with ai_chat_env.Session() as s:
            s.execute(delete(AcpProvider).where(AcpProvider.id == pid))
            s.commit()
        return start(provider)

    monkeypatch.setattr(sessions, "spawn_command", deleted_meanwhile)
    result = await probe(ai_chat_api, pid)
    assert result["ok"] is True  # the caller still gets the answer
    assert stored(ai_chat_env, pid) is None  # and nothing was written back


# ---- failures on write ----------------------------------------------------------------------------

async def test_a_failed_key_save_leaks_no_ciphertext(ai_chat_api, ai_chat_env, monkeypatch, caplog):
    tokens, encrypt = [], transport.encrypt_private
    monkeypatch.setattr(transport, "encrypt_private", lambda pem: tokens.append(encrypt(pem)) or tokens[-1])
    with ai_chat_env.Session() as s:  # the commit fails, and SQLAlchemy puts the statement's parameters in its text
        s.execute(text("CREATE TRIGGER boom BEFORE UPDATE ON acp_providers BEGIN SELECT RAISE(ABORT, 'boom'); END"))
        s.commit()
    before = stored(ai_chat_env, 1)
    caplog.set_level("DEBUG")
    resp = await call(ai_chat_api, "POST", f"{URL}/1/key")
    assert resp.status_code == 500
    assert len(tokens) == 1
    seen = resp.text + caplog.text
    assert tokens[0][10:50] not in seen and tokens[0][-50:-10] not in seen and "PRIVATE KEY" not in seen
    assert "IntegrityError" in caplog.text  # the type is logged, nothing else
    after = stored(ai_chat_env, 1)
    assert (after.public_key, after.private_key_ciphertext) == (before.public_key, before.private_key_ciphertext)


async def test_a_chat_created_during_delete_is_provider_in_use(ai_chat_api, ai_chat_env):
    pid = (await create(ai_chat_api))["id"]
    engine = ai_chat_env.Session.kw["bind"]
    # SQLite enforces foreign keys only when asked, as Postgres does always.
    event.listen(engine, "checkout", lambda dbapi, record, proxy: dbapi.execute("PRAGMA foreign_keys=ON"))
    arrived = []

    def chat_arrives(session):  # after the in-use check, before the DELETE reaches the database
        if not arrived:
            arrived.append(True)
            with ai_chat_env.Session() as other:
                other.add(AiChat(user_id=1, provider_id=pid))
                other.commit()

    event.listen(ai_chat_env.Session, "before_commit", chat_arrives)
    resp = await call(ai_chat_api, "DELETE", f"{URL}/{pid}")
    assert (resp.status_code, resp.json()["detail"]) == (409, {"code": "provider_in_use"})
    assert stored(ai_chat_env, pid) is not None


# ---- plaintext key files ------------------------------------------------------------------------

@pytest.fixture
def key_dir(tmp_path, monkeypatch):
    """The app's KEYFILES replaced by one rooted in tmp_path, removed afterwards."""
    (tmp_path / "keys").mkdir()
    files = transport.KeyFiles(str(tmp_path / "keys"))
    monkeypatch.setattr(transport, "KEYFILES", files)
    yield files
    files.cleanup()


def leave_files(env, files, provider_id: int) -> tuple[str, str]:
    """This provider's key and known_hosts files, as a spawn would have left them."""
    row = stored(env, provider_id)
    paths = files.paths(row.slug, transport.decrypt_private(row.private_key_ciphertext), row.host_key)
    assert all(os.path.exists(p) for p in paths)
    return paths


async def test_delete_removes_the_plaintext_key_files(ai_chat_api, ai_chat_env, key_dir):
    pid = (await keyed(ai_chat_api))["id"]
    other = (await keyed(ai_chat_api, slug="other"))["id"]
    keyfile, known_hosts = leave_files(ai_chat_env, key_dir, pid)
    other_key, other_hosts = leave_files(ai_chat_env, key_dir, other)
    assert (await call(ai_chat_api, "DELETE", f"{URL}/{pid}")).status_code == 204
    assert not os.path.exists(keyfile) and not os.path.exists(known_hosts)
    assert os.path.exists(other_key) and os.path.exists(other_hosts)  # only this provider's


async def test_key_generation_removes_the_old_plaintext_key_files(ai_chat_api, ai_chat_env, key_dir):
    pid = (await keyed(ai_chat_api))["id"]
    keyfile, known_hosts = leave_files(ai_chat_env, key_dir, pid)
    assert (await call(ai_chat_api, "POST", f"{URL}/{pid}/key")).status_code == 200
    assert not os.path.exists(keyfile) and not os.path.exists(known_hosts)
