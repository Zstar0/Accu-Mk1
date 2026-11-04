"""ai_chat.routes: /ai-chat chats, prompts, approvals and the per-user event stream (spec 8)."""
import ast
import asyncio
import logging
import time
from pathlib import Path

import anyio
import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select, text, update

import main
import models
from ai_chat import approvals, hub, routes, sessions
from ai_chat.models import AcpProvider, AiChat, AiChatMessage

pytestmark = pytest.mark.anyio

URL = "/ai-chat"
AS_STANDARD = {"X-Test-User": "2"}
AS_OTHER_ADMIN = {"X-Test-User": "3"}
CHAT_KEYS = {"id", "provider_id", "title", "archived", "created_at", "updated_at", "running_turn_id",
             "pending_approvals"}
PENDING_KEYS = {"permission_id", "source", "title", "detail", "can_allow", "hidden"}
MESSAGE_KEYS = {"id", "seq", "role", "text", "meta", "created_at"}
CTX = {"section": "lims", "subsection": "sample-detail", "target_kind": "sample", "target_id": "P-1234",
       "extra": "dropped"}
CLEAN_CTX = {"section": "lims", "subsection": "sample-detail", "target_kind": "sample", "target_id": "P-1234"}
TOOLS_STANDARD_OK = "Available tools (1):\n  todo_list: Track a task list for multi-step work"
JSON = {"content-type": "application/json"}
# Text no database stores: a NUL (Postgres refuses it) and a lone surrogate (it has no UTF-8). Raw bytes, because
# httpx would fail to encode the surrogate itself.
UNSTORABLE = [b"a\\u0000b", b"a\\ud800b"]


@pytest.fixture
def anyio_backend():
    return "asyncio"  # acp runs on asyncio only


# ---- helpers ------------------------------------------------------------------------------------

async def call(api, method: str, url: str, **kwargs):
    """Every request is bounded: some of them start a real agent process."""
    with anyio.fail_after(60):
        return await api.request(method, url, **kwargs)


def detail(resp) -> dict:
    return resp.json()["detail"]


async def new_chat(api, headers=None, provider_id: int = 1) -> dict:
    resp = await call(api, "POST", f"{URL}/chats", json={"provider_id": provider_id}, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def send(api, text: str, chat_id: int = 1, headers=None, **body):
    return await call(api, "POST", f"{URL}/chats/{chat_id}/prompt", json={"text": text, **body}, headers=headers)


async def start(api, text: str, chat_id: int = 1, **body) -> str:
    resp = await send(api, text, chat_id, **body)
    assert resp.status_code == 202, resp.text
    return resp.json()["turn_id"]


async def decide(api, chat_id: int, permission_id: str, decision: str, headers=None):
    return await call(api, "POST", f"{URL}/chats/{chat_id}/permissions/{permission_id}",
                      json={"decision": decision}, headers=headers)


async def seen(env, type: str, **fields) -> dict:
    """The first event of `type` with these field values published to user 1, waiting for it."""
    with anyio.fail_after(30):
        while True:
            for event in env.events():
                if event["type"] == type and all(event.get(k) == v for k, v in fields.items()):
                    return event
            await asyncio.sleep(0.02)


async def ask(api, env, text: str, chat_id: int = 1, **body) -> tuple[str, dict]:
    """A whole turn: the prompt, then its `turn_ended`."""
    turn_id = await start(api, text, chat_id, **body)
    return turn_id, await seen(env, "turn_ended", turn_id=turn_id)


async def permit(api, env, text: str = "PERMIT", chat_id: int = 1) -> tuple[str, dict]:
    """A turn that is waiting on an approval: its turn id and the `permission_requested` event."""
    turn_id = await start(api, text, chat_id)
    return turn_id, await seen(env, "permission_requested", turn_id=turn_id)


def rows(env, chat_id: int = 1, role: str | None = None) -> list[AiChatMessage]:
    with env.Session() as db:
        query = select(AiChatMessage).where(AiChatMessage.chat_id == chat_id).order_by(AiChatMessage.seq)
        if role is not None:
            query = query.where(AiChatMessage.role == role)
        return list(db.scalars(query))


def set_chat(env, **values) -> None:
    with env.Session() as db:
        db.execute(update(AiChat).where(AiChat.id == 1).values(**values))
        db.commit()


def set_provider(env, **values) -> None:
    with env.Session() as db:
        db.execute(update(AcpProvider).where(AcpProvider.id == 1).values(**values))
        db.commit()


def standard_tools(env, tmp_path) -> None:
    """The fake agent lists only `todo_list`, which a provider standard users may use must."""
    path = tmp_path / "tools.txt"
    path.write_text(TOOLS_STANDARD_OK, encoding="utf-8")
    env.flags = ["--tools-reply", str(path)]


async def chat_ids(api, headers=None) -> list[int]:
    resp = await call(api, "GET", f"{URL}/chats", headers=headers)
    assert resp.status_code == 200, resp.text
    return [c["id"] for c in resp.json()]


# ---- providers ----------------------------------------------------------------------------------

async def test_providers_lists_only_enabled_ones_allowing_the_role(ai_chat_api, ai_chat_env):
    resp = await call(ai_chat_api, "GET", f"{URL}/providers")
    assert resp.status_code == 200
    assert resp.json() == [{"id": 1, "slug": "jarvis", "display_name": "Jarvis"}]  # no transport field survives
    assert (await call(ai_chat_api, "GET", f"{URL}/providers", headers=AS_STANDARD)).json() == []
    set_provider(ai_chat_env, allowed_roles=["admin", "standard"])
    assert len((await call(ai_chat_api, "GET", f"{URL}/providers", headers=AS_STANDARD)).json()) == 1
    set_provider(ai_chat_env, enabled=False)
    assert (await call(ai_chat_api, "GET", f"{URL}/providers")).json() == []


# ---- creating and listing chats -----------------------------------------------------------------

async def test_create_chat(ai_chat_api, ai_chat_env):
    resp = await call(ai_chat_api, "POST", f"{URL}/chats", json={"provider_id": 1})
    assert resp.status_code == 201
    chat = resp.json()
    assert set(chat) == CHAT_KEYS
    assert (chat["id"], chat["provider_id"], chat["title"], chat["archived"]) == (2, 1, "", False)
    assert (chat["running_turn_id"], chat["pending_approvals"]) == (None, [])
    assert chat["created_at"].endswith("Z") and chat["updated_at"].endswith("Z")
    with ai_chat_env.Session() as db:
        assert db.get(AiChat, 2).user_id == 1
    assert sessions.MANAGER.get(2) is None  # the agent session starts lazily, at the first prompt


async def test_create_chat_refusals(ai_chat_api, ai_chat_env):
    unknown = await call(ai_chat_api, "POST", f"{URL}/chats", json={"provider_id": 999})
    assert (unknown.status_code, detail(unknown)) == (404, {"code": "provider_not_found"})
    other_role = await call(ai_chat_api, "POST", f"{URL}/chats", json={"provider_id": 1}, headers=AS_STANDARD)
    assert (other_role.status_code, detail(other_role)) == (403, {"code": "role_not_allowed"})
    set_provider(ai_chat_env, enabled=False)
    disabled = await call(ai_chat_api, "POST", f"{URL}/chats", json={"provider_id": 1})
    assert (disabled.status_code, detail(disabled)) == (404, {"code": "provider_not_found"})
    missing = await call(ai_chat_api, "POST", f"{URL}/chats", json={})
    assert (missing.status_code, detail(missing)) == (422, {"code": "invalid_input", "field": "provider_id"})
    with ai_chat_env.Session() as db:
        assert [c.id for c in db.scalars(select(AiChat))] == [1]


async def test_chats_newest_first_and_leave_out_archived_and_other_users(ai_chat_api, ai_chat_env):
    await new_chat(ai_chat_api)
    await new_chat(ai_chat_api)
    assert await chat_ids(ai_chat_api) == [3, 2, 1]
    assert (await call(ai_chat_api, "PATCH", f"{URL}/chats/2", json={"archived": True})).status_code == 200
    assert await chat_ids(ai_chat_api) == [3, 1]
    assert await chat_ids(ai_chat_api, AS_OTHER_ADMIN) == []  # admins get no read of other users' chats


async def test_a_chat_whose_provider_stops_allowing_the_role_is_left_out(ai_chat_api, ai_chat_env):
    set_provider(ai_chat_env, allowed_roles=["admin", "standard"])
    mine = await new_chat(ai_chat_api, AS_STANDARD)
    assert await chat_ids(ai_chat_api, AS_STANDARD) == [mine["id"]]
    set_provider(ai_chat_env, allowed_roles=["admin"])
    assert await chat_ids(ai_chat_api, AS_STANDARD) == []
    assert await chat_ids(ai_chat_api) == [1]


async def test_chats_out_keys_survive(ai_chat_api, ai_chat_env):
    # response_model drops undeclared keys without a word: compare against the wire contract, not the model.
    turn_id, card = await permit(ai_chat_api, ai_chat_env)
    resp = await call(ai_chat_api, "GET", f"{URL}/chats")
    [chat] = resp.json()
    assert set(chat) == CHAT_KEYS
    assert chat["running_turn_id"] == turn_id
    [pending] = chat["pending_approvals"]
    assert set(pending) == PENDING_KEYS
    assert pending == {"permission_id": card["permission_id"], "source": "agent", "title": "Run a command",
                       "detail": '{"command":"ls"}', "can_allow": True, "hidden": False}
    assert (await decide(ai_chat_api, 1, card["permission_id"], "allow")).status_code == 200
    await seen(ai_chat_env, "turn_ended", turn_id=turn_id)
    [chat] = (await call(ai_chat_api, "GET", f"{URL}/chats")).json()
    assert (chat["running_turn_id"], chat["pending_approvals"]) == (None, [])


async def test_a_card_the_browser_was_not_told_about_is_not_listed(ai_chat_api):
    # `permission_requested` goes out in the step that sets `row_seq`: until then the entry is not on the list either.
    entry = approvals.APPROVALS.register(1, 1, "a-turn", "agent", "Run", "ls", True)
    try:
        assert (await call(ai_chat_api, "GET", f"{URL}/chats")).json()[0]["pending_approvals"] == []
        entry.row_seq = 5
        listed = (await call(ai_chat_api, "GET", f"{URL}/chats")).json()[0]["pending_approvals"]
        assert [p["permission_id"] for p in listed] == [entry.permission_id]
    finally:
        approvals.APPROVALS.expire(entry.permission_id)


# ---- ownership and roles ------------------------------------------------------------------------

async def test_other_users_chat_is_404(ai_chat_api, ai_chat_env):
    requests = [("GET", "/chats/1/messages", None), ("PATCH", "/chats/1", {"title": "Mine now"}),
                ("POST", "/chats/1/prompt", {"text": "hello"}), ("POST", "/chats/1/cancel", None),
                ("POST", "/chats/1/permissions/anything", {"decision": "allow"}),
                ("GET", "/chats/999/messages", None)]  # and one that does not exist
    for method, path, body in requests:
        resp = await call(ai_chat_api, method, URL + path, json=body, headers=AS_OTHER_ADMIN)
        assert (resp.status_code, detail(resp)) == (404, {"code": "chat_not_found"}), path
    assert rows(ai_chat_env) == []
    assert sessions.MANAGER.get(1) is None
    with ai_chat_env.Session() as db:
        assert db.get(AiChat, 1).title == ""


async def test_role_revoked_prompt_403(ai_chat_api, ai_chat_env):
    set_provider(ai_chat_env, allowed_roles=["admin", "standard"])
    mine = (await new_chat(ai_chat_api, AS_STANDARD))["id"]
    set_provider(ai_chat_env, allowed_roles=["admin"])
    for method, path, body in (("POST", f"/chats/{mine}/prompt", {"text": "hello"}),
                               ("GET", f"/chats/{mine}/messages", None),
                               ("PATCH", f"/chats/{mine}", {"title": "x"}), ("POST", f"/chats/{mine}/cancel", None),
                               ("POST", f"/chats/{mine}/permissions/anything", {"decision": "deny"})):
        resp = await call(ai_chat_api, method, URL + path, json=body, headers=AS_STANDARD)
        assert (resp.status_code, detail(resp)) == (403, {"code": "role_not_allowed"}), path
    assert rows(ai_chat_env, mine) == []
    assert sessions.MANAGER.get(mine) is None


async def test_disabled_provider_keeps_the_transcript_readable(ai_chat_api, ai_chat_env):
    await ask(ai_chat_api, ai_chat_env, "before")
    set_provider(ai_chat_env, enabled=False)
    messages = await call(ai_chat_api, "GET", f"{URL}/chats/1/messages")
    assert (messages.status_code, [m["role"] for m in messages.json()]) == (200, ["user", "assistant"])
    assert await chat_ids(ai_chat_api) == [1]
    refused = await send(ai_chat_api, "after")
    assert (refused.status_code, detail(refused)) == (404, {"code": "provider_not_found"})
    assert len(rows(ai_chat_env, 1, "user")) == 1


async def test_standard_user_full_turn(ai_chat_api, ai_chat_env, tmp_path):
    standard_tools(ai_chat_env, tmp_path)
    set_provider(ai_chat_env, allowed_roles=["admin", "standard"])
    assert len((await call(ai_chat_api, "GET", f"{URL}/providers", headers=AS_STANDARD)).json()) == 1
    chat = await new_chat(ai_chat_api, AS_STANDARD)
    sub = hub.HUB.subscribe(2, None)
    try:
        resp = await send(ai_chat_api, "hello", chat["id"], headers=AS_STANDARD)
        assert resp.status_code == 202
        got = []
        with anyio.fail_after(30):
            while not got or got[-1]["type"] != "turn_ended":
                got.append(await sub.get())
    finally:
        sub.close()
    assert [e["type"] for e in got][0] == "turn_started" and "message_chunk" in [e["type"] for e in got]
    assert {e["chat_id"] for e in got} == {chat["id"]} and {e["turn_id"] for e in got} == {resp.json()["turn_id"]}
    assert ai_chat_env.events() == []  # user 1's stream saw none of user 2's chat
    assert [m.text for m in rows(ai_chat_env, chat["id"], "assistant")] == ["echo: hello"]


# ---- prompts ------------------------------------------------------------------------------------

async def test_prompt_returns_202_and_persists_context(ai_chat_api, ai_chat_env):
    text = "Q" * 70
    resp = await send(ai_chat_api, f"  {text}  ", page_context=CTX)
    assert resp.status_code == 202
    assert set(resp.json()) == {"turn_id"}
    turn_id = resp.json()["turn_id"]
    assert len(turn_id) == 16
    started = await seen(ai_chat_env, "turn_started", turn_id=turn_id)
    ended = await seen(ai_chat_env, "turn_ended", turn_id=turn_id)
    assert started["chat_id"] == 1 and ended["stop_reason"] == "end_turn"
    [user_row] = rows(ai_chat_env, 1, "user")
    assert (user_row.text, user_row.meta) == (text, {"page_context": CLEAN_CTX})  # stripped; extra keys dropped
    assert [m.text for m in rows(ai_chat_env, 1, "assistant")] == [f"echo: {text}"]
    [chat] = (await call(ai_chat_api, "GET", f"{URL}/chats")).json()
    assert chat["title"] == "Q" * 60  # the first 60 characters of the first prompt
    first_updated = chat["updated_at"]

    await ask(ai_chat_api, ai_chat_env, "second", page_context={"section": "nowhere", "subsection": "x"})
    assert [m.meta for m in rows(ai_chat_env, 1, "user")] == [{"page_context": CLEAN_CTX}, {"page_context": None}]
    [chat] = (await call(ai_chat_api, "GET", f"{URL}/chats")).json()
    assert chat["title"] == "Q" * 60  # only the first prompt names the chat
    assert chat["updated_at"] > first_updated  # every prompt bumps it, title or not


async def test_prompt_while_running_409(ai_chat_api, ai_chat_env):
    turn_id = await start(ai_chat_api, "SLOW")
    await seen(ai_chat_env, "message_chunk", turn_id=turn_id)  # the agent is inside the prompt
    resp = await send(ai_chat_api, "again")
    assert (resp.status_code, detail(resp)) == (409, {"code": "turn_running"})
    assert [m.text for m in rows(ai_chat_env, 1, "user")] == ["SLOW"]  # the refused prompt stored nothing
    assert (await call(ai_chat_api, "GET", f"{URL}/chats")).json()[0]["running_turn_id"] == turn_id
    cancel = await call(ai_chat_api, "POST", f"{URL}/chats/1/cancel")
    assert (cancel.status_code, cancel.json()) == (200, {"cancelled": True})
    assert (await seen(ai_chat_env, "turn_ended", turn_id=turn_id))["stop_reason"] == "cancelled"
    again = await call(ai_chat_api, "POST", f"{URL}/chats/1/cancel")
    assert again.json() == {"cancelled": False}  # no turn runs


async def test_two_concurrent_prompts_start_one_turn(ai_chat_api, ai_chat_env):
    first, second = await asyncio.gather(send(ai_chat_api, "SLOW"), send(ai_chat_api, "SLOW"))
    assert sorted((first.status_code, second.status_code)) == [202, 409]
    winner = first if first.status_code == 202 else second
    assert len(rows(ai_chat_env, 1, "user")) == 1  # the loser stored nothing: no await between check and start
    turn_id = winner.json()["turn_id"]
    await seen(ai_chat_env, "message_chunk", turn_id=turn_id)
    assert (await call(ai_chat_api, "POST", f"{URL}/chats/1/cancel")).json() == {"cancelled": True}
    await seen(ai_chat_env, "turn_ended", turn_id=turn_id)


async def test_no_await_between_the_running_turn_check_and_start_turn(ai_chat_api, ai_chat_env):
    # The route function itself, twice at once: over HTTP the dependencies hop threads, which staggers two requests
    # and would hide a gap in the body. With a gap both pass the check, and both store a user row.
    async def post():
        db = ai_chat_env.Session()
        try:
            return await routes.prompt(1, routes.PromptIn(text="SLOW"), db, db.get(models.User, 1))
        except HTTPException as exc:
            return exc
        finally:
            db.close()

    results = await asyncio.gather(post(), post())
    won = [r for r in results if isinstance(r, routes.PromptOut)]
    lost = [r for r in results if isinstance(r, HTTPException)]
    assert len(won) == 1 and [(e.status_code, e.detail) for e in lost] == [(409, {"code": "turn_running"})]
    assert len(rows(ai_chat_env, 1, "user")) == 1
    await seen(ai_chat_env, "message_chunk", turn_id=won[0].turn_id)
    assert (await call(ai_chat_api, "POST", f"{URL}/chats/1/cancel")).json() == {"cancelled": True}
    await seen(ai_chat_env, "turn_ended", turn_id=won[0].turn_id)


async def test_prompt_busy_429(ai_chat_api, ai_chat_env):
    set_provider(ai_chat_env, max_sessions=1)
    other = (await new_chat(ai_chat_api))["id"]
    turn_id = await start(ai_chat_api, "SLOW")
    await seen(ai_chat_env, "message_chunk", turn_id=turn_id)
    resp = await send(ai_chat_api, "hello", other)
    assert (resp.status_code, detail(resp)) == (429, {"code": "provider_busy"})
    assert rows(ai_chat_env, other) == []  # refused before anything was stored
    assert sessions.MANAGER.get(other) is None
    await call(ai_chat_api, "POST", f"{URL}/chats/1/cancel")
    await seen(ai_chat_env, "turn_ended", turn_id=turn_id)
    await ask(ai_chat_api, ai_chat_env, "hello", other)  # the idle session of chat 1 makes room


@pytest.mark.parametrize("body", [{}, {"text": ""}, {"text": "  \n\t "}, {"text": "x" * 8001},
                                  {"text": "  " + "x" * 8001}])
async def test_prompt_text_validation_422(ai_chat_api, ai_chat_env, body):
    resp = await call(ai_chat_api, "POST", f"{URL}/chats/1/prompt", json=body)
    assert resp.status_code == 422
    assert resp.json() == {"detail": {"code": "invalid_input", "field": "text"}}  # and never the input
    assert rows(ai_chat_env) == [] and sessions.MANAGER.get(1) is None


async def test_prompt_text_limit_is_8000(ai_chat_api, ai_chat_env):
    turn_id, ended = await ask(ai_chat_api, ai_chat_env, "x" * 8000)
    assert ended["stop_reason"] == "end_turn" and len(rows(ai_chat_env, 1, "user")[0].text) == 8000


async def test_prompt_takes_no_second_pooled_connection(ai_chat_api, ai_chat_env):
    # The route's own session already holds the connection the auth dependency opened. A second one, taken on the
    # loop thread, waits out pool_timeout when the pool is full, and every stream and route waits with it.
    pooled = ai_chat_env.Session.kw["bind"]
    one = create_engine(pooled.url, connect_args={"check_same_thread": False}, pool_size=1, max_overflow=0,
                        pool_timeout=2)
    ai_chat_env.Session.kw["bind"] = one
    try:
        started = time.monotonic()
        turn_id = await start(ai_chat_api, "hello")
        assert time.monotonic() - started < 1.5  # not the 2 s pool timeout, which is an error too
        assert (await seen(ai_chat_env, "turn_ended", turn_id=turn_id))["stop_reason"] == "end_turn"
        assert [m.text for m in rows(ai_chat_env, 1, "user")] == ["hello"]
    finally:
        ai_chat_env.Session.kw["bind"] = pooled
        one.dispose()


@pytest.mark.parametrize("raw", UNSTORABLE)
async def test_prompt_text_a_database_cannot_store_is_422(ai_chat_api, ai_chat_env, raw):
    resp = await call(ai_chat_api, "POST", f"{URL}/chats/1/prompt", content=b'{"text": "' + raw + b'"}', headers=JSON)
    assert (resp.status_code, resp.json()) == (422, {"detail": {"code": "invalid_input", "field": "text"}})
    assert rows(ai_chat_env) == [] and sessions.MANAGER.get(1) is None  # refused before anything was reserved


async def test_a_failed_write_leaks_no_prompt_and_leaves_no_turn(ai_chat_api, ai_chat_env, caplog):
    secret = "MY-PRIVATE-PROMPT"
    with ai_chat_env.Session() as s:  # the insert fails, and SQLAlchemy puts the statement's parameters in its text
        s.execute(text("CREATE TRIGGER no_user_rows BEFORE INSERT ON ai_chat_messages WHEN NEW.role = 'user' "
                       "BEGIN SELECT RAISE(ABORT, 'boom'); END"))
        s.commit()
    db = ai_chat_env.Session()
    try:
        caplog.set_level("DEBUG")
        with pytest.raises(HTTPException) as failed:
            await routes.prompt(1, routes.PromptIn(text=secret), db, db.get(models.User, 1))
        assert not db.in_transaction()  # rolled back: the failed commit left no transaction and no held connection
    finally:
        db.close()
    exc = failed.value
    assert (exc.status_code, exc.detail) == (500, "Internal Server Error")
    assert exc.__cause__ is None and exc.__suppress_context__  # raised `from None`
    assert secret not in repr(exc.detail) and secret not in caplog.text
    assert "ai_chat.prompt_write_failed" in caplog.text and "IntegrityError" in caplog.text  # the type, nothing else
    with ai_chat_env.Session() as s:
        assert s.get(AiChat, 1).title == ""  # rolled back with the row
    assert rows(ai_chat_env) == [] and sessions.MANAGER.running_turn(1) is None
    # What it leaves is an idle reserved session with no process: one reaper pass removes it.
    assert sessions.MANAGER.get(1) is not None and sessions.MANAGER.get(1)._owner is None
    await sessions.MANAGER.reap_once(now=time.monotonic() + 15 * 60 + 5)
    assert sessions.MANAGER.get(1) is None
    with ai_chat_env.Session() as s:
        s.execute(text("DROP TRIGGER no_user_rows"))
        s.commit()
    _, ended = await ask(ai_chat_api, ai_chat_env, "after")  # and the chat still works
    assert ended["stop_reason"] == "end_turn"


async def test_prompt_on_an_archived_chat_is_404(ai_chat_api, ai_chat_env):
    assert (await call(ai_chat_api, "PATCH", f"{URL}/chats/1", json={"archived": True})).status_code == 200
    resp = await send(ai_chat_api, "hello")
    assert (resp.status_code, detail(resp)) == (404, {"code": "chat_not_found"})
    assert rows(ai_chat_env) == [] and sessions.MANAGER.get(1) is None  # no row, no session, no card nobody sees
    assert (await call(ai_chat_api, "GET", f"{URL}/chats/1/messages")).status_code == 200  # the transcript stays
    assert (await call(ai_chat_api, "PATCH", f"{URL}/chats/1", json={"archived": False})).status_code == 200
    await ask(ai_chat_api, ai_chat_env, "hello")  # unarchived, it takes prompts again


async def test_the_archived_check_comes_before_the_running_turn_check(ai_chat_api, ai_chat_env):
    turn_id = await start(ai_chat_api, "SLOW")
    await seen(ai_chat_env, "message_chunk", turn_id=turn_id)
    set_chat(ai_chat_env, archived=True)  # the PATCH has committed and is closing the session
    resp = await send(ai_chat_api, "again")
    assert (resp.status_code, detail(resp)) == (404, {"code": "chat_not_found"})  # not 409
    assert [m.text for m in rows(ai_chat_env, 1, "user")] == ["SLOW"]
    set_chat(ai_chat_env, archived=False)
    assert (await call(ai_chat_api, "POST", f"{URL}/chats/1/cancel")).json() == {"cancelled": True}
    await seen(ai_chat_env, "turn_ended", turn_id=turn_id)


async def test_prompt_restores_the_stored_session_after_the_session_closed(ai_chat_api, ai_chat_env, tmp_path):
    state = tmp_path / "agent.json"
    ai_chat_env.flags = ["--state", str(state)]
    await ask(ai_chat_api, ai_chat_env, "first")
    with ai_chat_env.Session() as db:
        stored = db.get(AiChat, 1).acp_session_id
    assert stored
    put = await call(ai_chat_api, "PUT", "/admin/acp-providers/1", json={"display_name": "Jarvis 2"})
    assert put.status_code == 200
    assert sessions.MANAGER.get(1) is None  # a provider update closes its sessions
    _, ended = await ask(ai_chat_api, ai_chat_env, "second")
    assert ended["stop_reason"] == "end_turn"
    log = Path(f"{state}.log").read_text(encoding="utf-8").splitlines()
    assert f"load {stored}" in log  # the route passed the chat row's session id, so the history is kept
    assert sum(line.startswith("new ") for line in log) == 1  # and no second session was opened


# ---- messages -----------------------------------------------------------------------------------

async def test_messages_after_seq(ai_chat_api, ai_chat_env):
    await ask(ai_chat_api, ai_chat_env, "one")
    await ask(ai_chat_api, ai_chat_env, "two")
    everything = (await call(ai_chat_api, "GET", f"{URL}/chats/1/messages")).json()
    assert [(m["seq"], m["role"]) for m in everything] == [(1, "user"), (2, "assistant"), (3, "user"), (4, "assistant")]
    after = (await call(ai_chat_api, "GET", f"{URL}/chats/1/messages", params={"after_seq": 2})).json()
    assert [m["seq"] for m in after] == [3, 4]
    assert (await call(ai_chat_api, "GET", f"{URL}/chats/1/messages", params={"after_seq": 4})).json() == []


async def test_messages_meta_survives(ai_chat_api, ai_chat_env):
    turn_id, card = await permit(ai_chat_api, ai_chat_env)
    await decide(ai_chat_api, 1, card["permission_id"], "allow")
    await seen(ai_chat_env, "turn_ended", turn_id=turn_id)
    messages = (await call(ai_chat_api, "GET", f"{URL}/chats/1/messages")).json()
    assert [m["role"] for m in messages] == ["user", "permission", "assistant"]
    assert all(set(m) == MESSAGE_KEYS and m["created_at"].endswith("Z") for m in messages)
    user, permission, assistant = messages
    assert user["meta"] == {"page_context": None}
    assert permission["text"] == "Run a command"
    assert {k: permission["meta"][k] for k in ("source", "title", "detail", "permission_id", "decision",
                                              "decided_by")} == {
        "source": "agent", "title": "Run a command", "detail": '{"command":"ls"}',
        "permission_id": card["permission_id"], "decision": "allow", "decided_by": 1}
    assert assistant["meta"]["stop_reason"] == "end_turn"
    assert assistant["meta"]["tools"] == [{"id": "call-1", "title": "Run a command", "kind": "execute",
                                           "status": "completed"}]


# ---- title and archive --------------------------------------------------------------------------

async def test_patch_title_and_archive(ai_chat_api, ai_chat_env):
    resp = await call(ai_chat_api, "PATCH", f"{URL}/chats/1", json={"title": "  Renamed  "})
    assert (resp.status_code, set(resp.json()), resp.json()["title"]) == (200, CHAT_KEYS, "Renamed")
    assert (await call(ai_chat_api, "PATCH", f"{URL}/chats/1", json={})).json()["title"] == "Renamed"
    await ask(ai_chat_api, ai_chat_env, "hello")
    assert sessions.MANAGER.get(1) is not None
    archived = await call(ai_chat_api, "PATCH", f"{URL}/chats/1", json={"archived": True})
    assert (archived.status_code, archived.json()["archived"], archived.json()["title"]) == (200, True, "Renamed")
    assert sessions.MANAGER.get(1) is None  # archiving closes the session
    assert await chat_ids(ai_chat_api) == []
    assert len((await call(ai_chat_api, "GET", f"{URL}/chats/1/messages")).json()) == 2  # the transcript stays
    restored = await call(ai_chat_api, "PATCH", f"{URL}/chats/1", json={"archived": False})
    assert restored.json()["archived"] is False and await chat_ids(ai_chat_api) == [1]


@pytest.mark.parametrize("title", ["", "   ", "x" * 61])
async def test_patch_title_validation_422(ai_chat_api, title):
    resp = await call(ai_chat_api, "PATCH", f"{URL}/chats/1", json={"title": title})
    assert (resp.status_code, resp.json()) == (422, {"detail": {"code": "invalid_input", "field": "title"}})


@pytest.mark.parametrize("raw", UNSTORABLE)
async def test_patch_title_a_database_cannot_store_is_422(ai_chat_api, ai_chat_env, raw):
    resp = await call(ai_chat_api, "PATCH", f"{URL}/chats/1", content=b'{"title": "' + raw + b'"}', headers=JSON)
    assert (resp.status_code, resp.json()) == (422, {"detail": {"code": "invalid_input", "field": "title"}})
    with ai_chat_env.Session() as db:
        assert db.get(AiChat, 1).title == ""


async def test_archiving_during_a_card_resolves_it_cancelled_and_returns_promptly(ai_chat_api, ai_chat_env):
    turn_id, card = await permit(ai_chat_api, ai_chat_env)
    pid = card["permission_id"]
    with anyio.fail_after(15):  # the approval would wait 240 s
        archived = await call(ai_chat_api, "PATCH", f"{URL}/chats/1", json={"archived": True})
    assert (archived.status_code, archived.json()["archived"]) == (200, True)
    assert (await seen(ai_chat_env, "permission_resolved", permission_id=pid))["decision"] == "cancelled"
    await seen(ai_chat_env, "turn_ended", turn_id=turn_id)
    late = await decide(ai_chat_api, 1, pid, "allow")
    assert (late.status_code, detail(late)) == (404, {"code": "permission_not_found"})
    assert sessions.MANAGER.get(1) is None and approvals.APPROVALS.pending_for_chat(1) == []
    assert rows(ai_chat_env, 1, "permission")[0].meta["decision"] == "cancelled"
    assert await chat_ids(ai_chat_api) == []


# ---- approvals ----------------------------------------------------------------------------------

async def test_double_allow_one_wins(ai_chat_api, ai_chat_env):
    turn_id, card = await permit(ai_chat_api, ai_chat_env)
    pid = card["permission_id"]
    first, second = await asyncio.gather(decide(ai_chat_api, 1, pid, "allow"), decide(ai_chat_api, 1, pid, "allow"))
    won, lost = (first, second) if first.status_code == 200 else (second, first)
    assert (won.status_code, won.json()) == (200, {"decision": "allow"})
    assert (lost.status_code, detail(lost)) == (409, {"code": "permission_decided"})
    third = await decide(ai_chat_api, 1, pid, "deny")
    assert (third.status_code, detail(third)) == (409, {"code": "permission_decided"})
    await seen(ai_chat_env, "turn_ended", turn_id=turn_id)
    assert [m.text for m in rows(ai_chat_env, 1, "assistant")] == ["allowed"]
    assert rows(ai_chat_env, 1, "permission")[0].meta["decision"] == "allow"


async def test_deny_and_allow_not_offered(ai_chat_api, ai_chat_env):
    turn_id, card = await permit(ai_chat_api, ai_chat_env, "PERMIT_NOALLOW")
    pid = card["permission_id"]
    assert card["can_allow"] is False
    refused = await decide(ai_chat_api, 1, pid, "allow")
    assert (refused.status_code, detail(refused)) == (409, {"code": "allow_not_offered"})
    [pending] = (await call(ai_chat_api, "GET", f"{URL}/chats")).json()[0]["pending_approvals"]
    assert pending["can_allow"] is False  # the refusal left it pending: Deny still works
    denied = await decide(ai_chat_api, 1, pid, "deny")
    assert (denied.status_code, denied.json()) == (200, {"decision": "deny"})
    await seen(ai_chat_env, "turn_ended", turn_id=turn_id)


async def test_a_write_too_long_to_show_cannot_be_allowed(ai_chat_api, ai_chat_env):
    turn_id, card = await permit(ai_chat_api, ai_chat_env, "PERMIT_WRITE 25000")
    pid = card["permission_id"]
    shown = "/srv/big\n" + "x" * 25000
    assert card["detail"] == f"{shown[:20000]}\n\n{len(shown) - 20000} more characters not shown."
    assert (card["can_allow"], card["hidden"]) == (False, True)
    refused = await decide(ai_chat_api, 1, pid, "allow")
    assert (refused.status_code, detail(refused)) == (409, {"code": "allow_not_offered"})
    [pending] = (await call(ai_chat_api, "GET", f"{URL}/chats")).json()[0]["pending_approvals"]
    assert (pending["can_allow"], pending["hidden"], pending["detail"]) == (False, True, card["detail"])
    assert (await decide(ai_chat_api, 1, pid, "deny")).status_code == 200
    await seen(ai_chat_env, "turn_ended", turn_id=turn_id)
    assert [m.text for m in rows(ai_chat_env, 1, "assistant")] == ["denied"]


async def test_a_write_under_the_cap_shows_in_full_and_can_be_allowed(ai_chat_api, ai_chat_env):
    turn_id, card = await permit(ai_chat_api, ai_chat_env, "PERMIT_WRITE 3000")
    assert card["detail"] == "/srv/big\n" + "x" * 3000
    assert (card["can_allow"], card["hidden"]) == (True, False)
    [pending] = (await call(ai_chat_api, "GET", f"{URL}/chats")).json()[0]["pending_approvals"]
    assert (pending["can_allow"], pending["hidden"], pending["detail"]) == (True, False, card["detail"])
    assert (await decide(ai_chat_api, 1, card["permission_id"], "allow")).status_code == 200
    await seen(ai_chat_env, "turn_ended", turn_id=turn_id)
    assert [m.text for m in rows(ai_chat_env, 1, "assistant")] == ["allowed"]


async def allowed_detail(api, env, prompt: str) -> str:
    """Ask, check the card can be allowed, allow it through the route, and return what the card showed."""
    turn_id, card = await permit(api, env, prompt)
    assert (card["can_allow"], card["hidden"]) == (True, False)
    assert (await decide(api, 1, card["permission_id"], "allow")).status_code == 200
    await seen(env, "turn_ended", turn_id=turn_id)
    assert [m.text for m in rows(env, 1, "assistant")] == ["allowed"]
    return card["detail"]


async def test_a_whole_file_edit_shows_the_line_it_changes(ai_chat_api, ai_chat_env):
    assert await allowed_detail(ai_chat_api, ai_chat_env, "PERMIT_EDIT_LINE") == (
        "/srv/app.conf\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three")


async def test_emptying_a_file_shows_every_line_as_removed(ai_chat_api, ai_chat_env):
    assert await allowed_detail(ai_chat_api, ai_chat_env, "PERMIT_EDIT_EMPTY") == (
        "/srv/app.conf\n@@ -1,3 +0,0 @@\n-one\n-two\n-three")


async def test_a_one_line_edit_in_a_big_file_is_a_short_diff_that_can_be_allowed(ai_chat_api, ai_chat_env):
    detail = await allowed_detail(ai_chat_api, ai_chat_env, "PERMIT_EDIT_BIG")
    assert detail.splitlines() == [
        "/srv/big.conf", "@@ -998,7 +998,7 @@", " line 0997", " line 0998", " line 0999", "-line 1000",
        "+line 1000 edited", " line 1001", " line 1002", " line 1003"]


async def test_an_edit_over_the_diff_ceiling_cannot_be_allowed(ai_chat_api, ai_chat_env):
    turn_id, card = await permit(ai_chat_api, ai_chat_env, "PERMIT_EDIT_HUGE")
    pid = card["permission_id"]
    assert card["detail"] == "/srv/huge.conf\n200003 more characters not shown."
    assert (card["can_allow"], card["hidden"]) == (False, True)
    refused = await decide(ai_chat_api, 1, pid, "allow")
    assert (refused.status_code, detail(refused)) == (409, {"code": "allow_not_offered"})
    [pending] = (await call(ai_chat_api, "GET", f"{URL}/chats")).json()[0]["pending_approvals"]
    assert (pending["can_allow"], pending["hidden"], pending["detail"]) == (False, True, card["detail"])
    assert (await decide(ai_chat_api, 1, pid, "deny")).status_code == 200
    await seen(ai_chat_env, "turn_ended", turn_id=turn_id)
    assert [m.text for m in rows(ai_chat_env, 1, "assistant")] == ["denied"]


async def test_an_empty_text_block_falls_back_to_the_raw_input(ai_chat_api, ai_chat_env):
    assert await allowed_detail(ai_chat_api, ai_chat_env, "PERMIT_EMPTY_TEXT") == '{"command":"rm -rf /srv"}'


async def test_decision_validation_422(ai_chat_api, ai_chat_env):
    turn_id, card = await permit(ai_chat_api, ai_chat_env)
    pid = card["permission_id"]
    for body in ({}, {"decision": "maybe"}, {"decision": ""}):
        resp = await call(ai_chat_api, "POST", f"{URL}/chats/1/permissions/{pid}", json=body)
        assert (resp.status_code, resp.json()) == (422, {"detail": {"code": "invalid_input", "field": "decision"}})
    assert (await decide(ai_chat_api, 1, pid, "deny")).status_code == 200  # still pending after the bad bodies
    await seen(ai_chat_env, "turn_ended", turn_id=turn_id)


async def test_a_permission_of_another_chat_is_not_found_through_this_url(ai_chat_api, ai_chat_env):
    other = (await new_chat(ai_chat_api))["id"]
    turn_id, card = await permit(ai_chat_api, ai_chat_env)
    pid = card["permission_id"]
    wrong = await decide(ai_chat_api, other, pid, "allow")
    assert (wrong.status_code, detail(wrong)) == (404, {"code": "permission_not_found"})
    [chat] = [c for c in (await call(ai_chat_api, "GET", f"{URL}/chats")).json() if c["id"] == 1]
    assert [p["permission_id"] for p in chat["pending_approvals"]] == [pid]  # not resolved by the wrong URL
    assert (await decide(ai_chat_api, 1, pid, "allow")).status_code == 200
    await seen(ai_chat_env, "turn_ended", turn_id=turn_id)


async def test_a_permission_of_a_turn_that_is_not_running_is_not_found(ai_chat_api, ai_chat_env):
    stale = approvals.APPROVALS.register(1, 1, "an-older-turn", "agent", "Run", "ls", True)
    try:
        resp = await decide(ai_chat_api, 1, stale.permission_id, "allow")
        assert (resp.status_code, detail(resp)) == (404, {"code": "permission_not_found"})
        assert not stale.future.done() and approvals.APPROVALS.pending_for_chat(1) == [stale]
    finally:
        approvals.APPROVALS.expire(stale.permission_id)


async def test_unknown_permission_is_404(ai_chat_api):
    resp = await decide(ai_chat_api, 1, "nope", "allow")
    assert (resp.status_code, detail(resp)) == (404, {"code": "permission_not_found"})


async def test_provider_update_mid_approval_cancels(ai_chat_api, ai_chat_env):
    turn_id, card = await permit(ai_chat_api, ai_chat_env)
    pid = card["permission_id"]
    put = await call(ai_chat_api, "PUT", "/admin/acp-providers/1", json={"display_name": "Jarvis 2"})
    assert put.status_code == 200
    resolved = await seen(ai_chat_env, "permission_resolved", permission_id=pid)
    assert resolved["decision"] == "cancelled"
    late = await decide(ai_chat_api, 1, pid, "allow")
    assert (late.status_code, detail(late)) == (404, {"code": "permission_not_found"})
    await seen(ai_chat_env, "turn_ended", turn_id=turn_id)
    assert rows(ai_chat_env, 1, "permission")[0].meta["decision"] == "cancelled"


async def test_cancel_resolves_pending(ai_chat_api, ai_chat_env):
    turn_id, card = await permit(ai_chat_api, ai_chat_env)
    pid = card["permission_id"]
    cancel = await call(ai_chat_api, "POST", f"{URL}/chats/1/cancel")
    assert (cancel.status_code, cancel.json()) == (200, {"cancelled": True})
    assert (await seen(ai_chat_env, "permission_resolved", permission_id=pid))["decision"] == "cancelled"
    await seen(ai_chat_env, "turn_ended", turn_id=turn_id)
    [chat] = (await call(ai_chat_api, "GET", f"{URL}/chats")).json()
    assert (chat["running_turn_id"], chat["pending_approvals"]) == (None, [])
    late = await decide(ai_chat_api, 1, pid, "allow")
    assert (late.status_code, detail(late)) == (404, {"code": "permission_not_found"})


async def test_no_db_connection_is_held_across_cancel_and_close(ai_chat_api, ai_chat_env, monkeypatch):
    pool = ai_chat_env.Session.kw["bind"].pool
    held = []

    def watch(name: str) -> None:
        original = getattr(sessions.MANAGER, name)

        async def watching(chat_id: int):
            held.append((name, pool.checkedout()))  # the route's session has gone back to the pool by now
            return await original(chat_id)

        monkeypatch.setattr(sessions.MANAGER, name, watching)

    watch("cancel")
    watch("close_chat")
    turn_id = await start(ai_chat_api, "SLOW")
    await seen(ai_chat_env, "message_chunk", turn_id=turn_id)
    assert (await call(ai_chat_api, "POST", f"{URL}/chats/1/cancel")).json() == {"cancelled": True}
    await seen(ai_chat_env, "turn_ended", turn_id=turn_id)
    assert (await call(ai_chat_api, "PATCH", f"{URL}/chats/1", json={"archived": True})).status_code == 200
    assert held == [("cancel", 0), ("close_chat", 0)]


# ---- the stream ---------------------------------------------------------------------------------

class FakeRequest:
    """The two things the stream reads from a request."""

    def __init__(self, last_event_id: str | None = None) -> None:
        self.headers = {} if last_event_id is None else {"last-event-id": last_event_id}
        self.disconnected = False

    async def is_disconnected(self) -> bool:
        return self.disconnected


async def open_stream(env, user_id: int = 1, last_event_id: str | None = None):
    """Calls the route function itself: httpx's ASGI transport buffers a whole response, which never ends here."""
    request = FakeRequest(last_event_id)
    db = env.Session()
    return request, await routes.stream(request, db, db.get(models.User, user_id))


async def frame(response) -> str:
    with anyio.fail_after(10):
        return await anext(response.body_iterator)


def subscribers(user_id: int = 1) -> int:
    return len(hub.HUB._subs.get(user_id, ()))


async def test_stream_403_without_provider(ai_chat_api, ai_chat_env):
    resp = await call(ai_chat_api, "GET", f"{URL}/stream", headers=AS_STANDARD)  # no provider allows `standard`
    assert (resp.status_code, detail(resp)) == (403, {"code": "role_not_allowed"})
    set_provider(ai_chat_env, enabled=False)
    resp = await call(ai_chat_api, "GET", f"{URL}/stream")  # and a disabled one allows nobody
    assert (resp.status_code, detail(resp)) == (403, {"code": "role_not_allowed"})
    assert subscribers() == 1  # only the fixture's own


async def test_stream_first_frames(ai_chat_api, ai_chat_env):
    hub.HUB.publish(1, "message_chunk", 1, "t0", text="old")
    one = hub.HUB.publish(1, "message_chunk", 1, "t1", text="a")
    two = hub.HUB.publish(1, "turn_ended", 1, "t1", stop_reason="end_turn", message_seq=2)
    request, response = await open_stream(ai_chat_env, last_event_id=str(one["seq"] - 1))
    assert response.media_type == "text/event-stream"
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["x-accel-buffering"] == "no"
    assert response.headers["connection"] == "keep-alive"
    assert [await frame(response) for _ in range(3)] == [": connected\n\n", hub.format_frame(one),
                                                         hub.format_frame(two)]
    assert subscribers() == 2
    request.disconnected = True
    with pytest.raises(StopAsyncIteration):
        await frame(response)
    assert subscribers() == 1  # the generator closed its subscription


async def test_stream_live_events_then_keepalive(ai_chat_api, ai_chat_env, monkeypatch):
    monkeypatch.setattr(routes, "KEEPALIVE_S", 0.05)
    request, response = await open_stream(ai_chat_env)
    assert await frame(response) == ": connected\n\n"
    live = hub.HUB.publish(1, "message_chunk", 1, "t1", text="hi")
    assert await frame(response) == hub.format_frame(live)
    assert await frame(response) == ": keepalive\n\n"
    request.disconnected = True
    with pytest.raises(StopAsyncIteration):
        await frame(response)
    assert subscribers() == 1


async def test_stream_unknown_last_event_id_gets_resync(ai_chat_api, ai_chat_env):
    hub.HUB.publish(1, "message_chunk", 1, "t1", text="a")
    request, response = await open_stream(ai_chat_env, last_event_id="not-a-number")
    assert await frame(response) == ": connected\n\n"
    assert (await frame(response)).splitlines()[1] == "event: resync"
    request.disconnected = True
    await response.body_iterator.aclose()


async def test_stream_holds_no_connection_and_no_subscription_until_it_starts(ai_chat_api, ai_chat_env):
    pool = ai_chat_env.Session.kw["bind"].pool
    request, response = await open_stream(ai_chat_env)
    assert pool.checkedout() == 0  # the db session was closed before the response was returned
    assert subscribers() == 1  # a generator that never started has not subscribed
    await response.body_iterator.aclose()
    assert subscribers() == 1
    request2, response2 = await open_stream(ai_chat_env)
    await frame(response2)
    assert subscribers() == 2
    await response2.body_iterator.aclose()  # a client that goes away: the generator's finally closes it
    assert subscribers() == 1


async def test_stream_skips_an_event_that_cannot_be_framed(ai_chat_api, ai_chat_env, caplog):
    before = hub.HUB.publish(1, "message_chunk", 1, "t1", text="before")
    hub.HUB.publish(1, "message_chunk", 1, "t1", text=object())  # not JSON: one bad event
    after = hub.HUB.publish(1, "turn_ended", 1, "t1", stop_reason="end_turn", message_seq=None)
    with caplog.at_level(logging.INFO):
        request, response = await open_stream(ai_chat_env, last_event_id=str(before["seq"] - 1))
        got = [await frame(response) for _ in range(3)]
    assert got == [": connected\n\n", hub.format_frame(before), hub.format_frame(after)]
    assert "message_chunk" in caplog.text  # the type is what the log line carries
    assert "serializable" not in caplog.text and "object at" not in caplog.text
    request.disconnected = True
    await response.body_iterator.aclose()


# ---- wiring -------------------------------------------------------------------------------------

def test_lifespan_starts_the_reaper_and_closes_the_sessions_at_shutdown():
    """The lifespan seeds the dev database, so it cannot run here: check the order in its source instead."""
    tree = ast.parse(Path(main.__file__).read_text(encoding="utf-8"))
    lifespan = next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef) and n.name == "lifespan")
    at_yield = next(n.lineno for n in ast.walk(lifespan) if isinstance(n, ast.Yield))
    called = {}
    for node in ast.walk(lifespan):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            called.setdefault(node.func.attr, []).append(node.lineno)
    assert all(line < at_yield for line in called["start_reaper"])
    assert called["close_all"] and all(line > at_yield for line in called["close_all"])
    assert called["cleanup"] and all(line > at_yield for line in called["cleanup"])


@pytest.mark.parametrize(("method", "path", "payload", "expected"), [
    ("POST", "/chats", {"provider_id": 1}, {"title": ""}),
    ("PATCH", "/chats/1", {"title": "Renamed"}, {"title": "Renamed"}),
    ("PATCH", "/chats/1", {"archived": True}, {"archived": True}),
], ids=["create", "rename", "archive"])
async def test_no_pool_checkout_on_the_loop_after_a_commit(ai_chat_api, loop_checkouts, method, path, payload, expected):
    with anyio.fail_after(30):
        resp = await ai_chat_api.request(method, f"{URL}{path}", json=payload)
    assert resp.status_code in (200, 201), resp.text
    assert loop_checkouts == []
    # Nothing was reloaded, and the answer is still whole.
    out = resp.json()
    assert set(out) == CHAT_KEYS and expected.items() <= out.items() and out["created_at"] and out["updated_at"]


def test_the_router_is_mounted():
    paths = {route.path for route in main.app.routes}
    assert {"/ai-chat/stream", "/ai-chat/chats", "/ai-chat/chats/{chat_id}/prompt"} <= paths
