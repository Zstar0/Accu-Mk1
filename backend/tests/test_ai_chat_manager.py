"""ai_chat.sessions.SessionManager: approvals inside turns, Stop, close, caps and the reaper (spec 7, 8)."""
import asyncio
import json
import logging
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

import anyio
import pytest
from acp.schema import (
    ContentToolCallContent,
    FileEditToolCallContent,
    PermissionOption,
    TerminalToolCallContent,
    TextContentBlock,
    ToolCallUpdate,
)
from sqlalchemy import select

from ai_chat import approvals, sessions
from ai_chat.models import AiChat, AiChatMessage
from integration_keys import store

pytestmark = pytest.mark.anyio

OPTION_IDS = ("allow-once", "reject-once", "allow-always")


@pytest.fixture
def anyio_backend():
    return "asyncio"  # acp runs on asyncio only


def add_chats(env, *ids: int) -> None:
    with env.Session() as db:
        db.add_all(AiChat(id=i, user_id=1, provider_id=1) for i in ids)
        db.commit()


async def send(env, text: str, chat_id: int = 1, stored: str | None = None, page_context: dict | None = None, **over):
    """What Task 9's route does: reserve, store the user row, start the turn. `over` overrides provider fields."""
    session = sessions.MANAGER.reserve(chat_id, 1, env.provider(**over))
    user_seq = await asyncio.to_thread(sessions.persist_message, chat_id, "user", text, None)
    return session, sessions.MANAGER.start_turn(session, text, page_context, stored, user_seq)


async def seen(env, type: str, **fields) -> dict:
    """The first published event of `type` with these field values, waiting for it."""
    with anyio.fail_after(15):
        while True:
            for event in env.events():
                if event["type"] == type and all(event.get(k) == v for k, v in fields.items()):
                    return event
            await asyncio.sleep(0.02)


def of_type(env, type: str) -> list[dict]:
    return [event for event in env.events() if event["type"] == type]


def rows(env, role: str, chat_id: int = 1) -> list[AiChatMessage]:
    with env.Session() as db:
        return list(db.scalars(select(AiChatMessage).where(AiChatMessage.chat_id == chat_id, AiChatMessage.role == role)
                               .order_by(AiChatMessage.seq)))


def agent_log(state: Path) -> list[str]:
    path = Path(f"{state}.log")  # the agent writes it at its first request
    return path.read_text(encoding="utf-8").splitlines() if path.exists() else []


def prompts(state: Path) -> list[list[str]]:
    return [json.loads(line[len("prompt "):]) for line in agent_log(state) if line.startswith("prompt ")]


async def seed_history() -> None:
    await asyncio.to_thread(sessions.persist_message, 1, "user", "earlier question", None)
    await asyncio.to_thread(sessions.persist_message, 1, "assistant", "earlier answer", None)


# ---- approvals in a turn ---------------------------------------------------------------------

async def test_permission_allow_runs(ai_chat_env):
    with anyio.fail_after(30):
        _, turn_id = await send(ai_chat_env, "PERMIT")
        card = await seen(ai_chat_env, "permission_requested")
        approvals.APPROVALS.decide(card["permission_id"], 1, "allow")
        ended = await seen(ai_chat_env, "turn_ended")
    assert card["turn_id"] == turn_id and card["chat_id"] == 1
    assert (card["source"], card["title"], card["detail"], card["can_allow"], card["agent"]) == (
        "agent", "Run a command", '{"command":"ls"}', True, "Jarvis")
    resolved = of_type(ai_chat_env, "permission_resolved")
    assert [(e["permission_id"], e["decision"], e["turn_id"]) for e in resolved] == [
        (card["permission_id"], "allow", turn_id)]
    row = rows(ai_chat_env, "permission")[0]
    assert row.text == "Run a command"
    assert row.meta["source"] == "agent" and row.meta["title"] == "Run a command"
    assert row.meta["detail"] == '{"command":"ls"}' and row.meta["permission_id"] == card["permission_id"]
    assert row.meta["decision"] == "allow" and row.meta["decided_by"] == 1
    datetime.fromisoformat(row.meta["decided_at"])
    assistant = rows(ai_chat_env, "assistant")[0]
    assert assistant.text == "allowed" and assistant.meta["stop_reason"] == "end_turn"
    assert assistant.meta["tools"] == [{"id": "call-1", "title": "Run a command", "kind": "execute",
                                        "status": "completed"}]
    assert (ended["stop_reason"], ended["message_seq"], ended["turn_id"]) == ("end_turn", assistant.seq, turn_id)


async def test_permission_deny_maps_reject_once(ai_chat_env):
    with anyio.fail_after(30):
        await send(ai_chat_env, "PERMIT")
        card = await seen(ai_chat_env, "permission_requested")
        approvals.APPROVALS.decide(card["permission_id"], 1, "deny")
        await seen(ai_chat_env, "turn_ended")
    assert rows(ai_chat_env, "assistant")[0].text == "denied"
    meta = rows(ai_chat_env, "permission")[0].meta
    assert meta["decision"] == "deny" and meta["decided_by"] == 1


async def test_noreject_deny_is_cancelled_outcome(ai_chat_env):
    with anyio.fail_after(30):
        await send(ai_chat_env, "PERMIT_NOREJECT")
        card = await seen(ai_chat_env, "permission_requested")
        approvals.APPROVALS.decide(card["permission_id"], 1, "deny")
        await seen(ai_chat_env, "turn_ended")
    assert rows(ai_chat_env, "assistant")[0].text == "cancelled"  # what the agent's outcome was
    assert rows(ai_chat_env, "permission")[0].meta["decision"] == "deny"


async def test_allow_always_option_never_offered(ai_chat_env):
    with anyio.fail_after(30):
        await send(ai_chat_env, "PERMIT")
        card = await seen(ai_chat_env, "permission_requested")
        approvals.APPROVALS.decide(card["permission_id"], 1, "allow")
        await seen(ai_chat_env, "turn_ended")
    assert card["can_allow"] is True
    assert set(card) == {"seq", "type", "chat_id", "turn_id", "permission_id", "source", "title", "detail",
                         "can_allow", "hidden", "agent"}
    blob = json.dumps(card) + json.dumps(rows(ai_chat_env, "permission")[0].meta)
    assert not [option for option in OPTION_IDS if option in blob]
    assert rows(ai_chat_env, "assistant")[0].text == "allowed"  # allow_once, not allow_always


async def test_unknown_option_kind_never_reaches_the_client(ai_chat_env, tmp_path, caplog, monkeypatch):
    # acp refuses the whole request before `Mk1Client` is called. Mk1 cannot see it, so it stays fail-closed: no card,
    # no row, the agent goes on as denied. acp answers it with invalid_params and logs nothing, so no log line either.
    state = tmp_path / "state.json"
    ai_chat_env.flags = ["--state", str(state), "--unknown-option"]
    asked = []
    real = sessions.Mk1Client.request_permission

    async def spy(self, *args, **kwargs):
        asked.append(args)
        return await real(self, *args, **kwargs)

    monkeypatch.setattr(sessions.Mk1Client, "request_permission", spy)
    with anyio.fail_after(30):
        await send(ai_chat_env, "hi")
        ended = await seen(ai_chat_env, "turn_ended")
    assert asked == []
    assert "permission refused" in agent_log(state)
    assert ended["stop_reason"] == "end_turn"
    assert rows(ai_chat_env, "assistant")[0].text == "echo: hi"
    assert rows(ai_chat_env, "permission") == []
    assert of_type(ai_chat_env, "permission_requested") == []
    assert approvals.APPROVALS.pending_for_chat(1) == []
    assert "SECRET-AGENT-TEXT" not in caplog.text
    assert [record for record in caplog.records if record.name == "root"] == []


async def test_no_allow_once_means_no_allow(ai_chat_env):
    with anyio.fail_after(30):
        await send(ai_chat_env, "PERMIT_NOALLOW")  # offers reject_once and allow_always
        card = await seen(ai_chat_env, "permission_requested")
        assert card["can_allow"] is False
        with pytest.raises(approvals.AllowNotOffered):
            approvals.APPROVALS.decide(card["permission_id"], 1, "allow")
        approvals.APPROVALS.decide(card["permission_id"], 1, "deny")  # still pending: Deny stays available
        await seen(ai_chat_env, "turn_ended")
    assert rows(ai_chat_env, "assistant")[0].text == "denied"


async def test_permission_timeout_expires(ai_chat_env):
    with anyio.fail_after(30):
        await send(ai_chat_env, "PERMIT", permission_timeout_s=1)
        card = await seen(ai_chat_env, "permission_requested")
        await seen(ai_chat_env, "permission_resolved", decision="expired")
        with pytest.raises(approvals.ApprovalNotFound):
            approvals.APPROVALS.decide(card["permission_id"], 1, "allow")
        await seen(ai_chat_env, "turn_ended")
    meta = rows(ai_chat_env, "permission")[0].meta
    assert meta["decision"] == "expired" and meta["decided_by"] is None and meta["decided_at"]
    assert rows(ai_chat_env, "assistant")[0].text == "cancelled"
    assert len(of_type(ai_chat_env, "permission_resolved")) == 1


async def test_decision_during_the_expiry_write_is_not_found(ai_chat_env, monkeypatch):
    reached, release = threading.Event(), threading.Event()
    real = sessions.update_message_meta

    def held(chat_id, seq, patch):
        reached.set()
        release.wait(10)
        real(chat_id, seq, patch)

    monkeypatch.setattr(sessions, "update_message_meta", held)
    with anyio.fail_after(30):
        await send(ai_chat_env, "PERMIT", permission_timeout_s=1)
        card = await seen(ai_chat_env, "permission_requested")
        while not reached.is_set():
            await asyncio.sleep(0.01)
        try:
            with pytest.raises(approvals.ApprovalNotFound):  # already expired, though nothing has said so yet
                approvals.APPROVALS.decide(card["permission_id"], 1, "allow")
        finally:
            release.set()
        await seen(ai_chat_env, "turn_ended")
    assert rows(ai_chat_env, "permission")[0].meta["decision"] == "expired"


async def test_cancelled_waiter_leaves_no_pending_and_the_sweep_closes_its_card(ai_chat_env):
    # What acp does to the handler when the connection closes. The turn's sweep runs after that, and finds the card.
    s = ai_chat_env.session()
    s.acp_session_id, s.turn_id = "sid", "t1"
    options = [PermissionOption(option_id="allow-once", name="Allow once", kind="allow_once")]
    tool_call = ToolCallUpdate(tool_call_id="c", title="x")
    waiter = asyncio.create_task(s._client.request_permission("sid", tool_call, options))
    with anyio.fail_after(15):
        card = await seen(ai_chat_env, "permission_requested")
        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
    assert approvals.APPROVALS.pending_for_chat(1) == []
    assert of_type(ai_chat_env, "permission_resolved") == []
    with anyio.fail_after(15):
        await s._client.close_cards()
    assert [(e["permission_id"], e["decision"]) for e in of_type(ai_chat_env, "permission_resolved")] == [
        (card["permission_id"], "cancelled")]
    assert rows(ai_chat_env, "permission")[0].meta["decision"] == "cancelled"


async def test_failed_row_write_leaves_no_pending(ai_chat_env, monkeypatch):
    def refuse(chat_id, role, text, meta):
        raise RuntimeError("no database")

    monkeypatch.setattr(sessions, "persist_message", refuse)
    s = ai_chat_env.session()
    s.acp_session_id, s.turn_id = "sid", "t1"  # no turn task here, so no sweep would clean up behind it
    with anyio.fail_after(5):
        response = await s._client.request_permission("sid", ToolCallUpdate(tool_call_id="c", title="x"), [])
    assert response.outcome.outcome == "cancelled"
    assert approvals.APPROVALS.pending_for_chat(1) == []


def test_permission_detail_shows_every_block_and_says_what_it_hides():
    def call(**fields):
        return ToolCallUpdate(tool_call_id="c", **fields)

    def text(value):
        return ContentToolCallContent(type="content", content=TextContentBlock(type="text", text=value))

    detail = sessions._permission_detail
    diff = FileEditToolCallContent(type="diff", path="/a", new_text="new", old_text="old")
    terminal = TerminalToolCallContent(type="terminal", terminal_id="t")
    assert detail(call(content=[text("run ls"), text("other")], raw_input={"a": 1})) == ("run ls\n\nother", False)
    assert detail(call(content=[diff, text("why")])) == ("/a\nnew\n\nwhy", False)
    assert detail(call(raw_input={"a": 1, "b": [2]})) == ('{"a":1,"b":[2]}', False)
    assert detail(call(content=[], raw_input={"a": 1})) == ('{"a":1}', False)
    assert detail(call()) == ("", False)
    assert detail(call(content=[terminal])) == ("1 item not shown.", True)
    assert detail(call(content=[text("why"), terminal, terminal])) == ("why\n\n2 items not shown.", True)
    assert detail(call(raw_input="x" * 18000)) == (json.dumps("x" * 18000), False)
    assert detail(call(content=[text("y" * 20000)])) == ("y" * 20000, False)
    assert detail(call(content=[text("y" * 20001)])) == ("y" * 20000 + "\n\n1 more character not shown.", True)
    assert detail(call(content=[text("y" * 25000), terminal])) == (
        "y" * 20000 + "\n\n5000 more characters not shown.\n\n1 item not shown.", True)
    assert detail(call(raw_input="x" * 25000))[1] is True


async def test_card_shows_a_diff_block_not_the_raw_input(ai_chat_env):
    with anyio.fail_after(30):
        await send(ai_chat_env, "PERMIT_DIFF")
        card = await seen(ai_chat_env, "permission_requested")
        approvals.APPROVALS.decide(card["permission_id"], 1, "allow")
        await seen(ai_chat_env, "turn_ended")
    assert card["detail"] == "/srv/app/run.sh\nnew body"
    assert (card["can_allow"], card["hidden"]) == (True, False)
    assert rows(ai_chat_env, "permission")[0].meta["detail"] == card["detail"]
    assert rows(ai_chat_env, "assistant")[0].text == "allowed"


async def test_card_shows_the_block_after_a_text_block(ai_chat_env):
    with anyio.fail_after(30):
        await send(ai_chat_env, "PERMIT_BLOCKS")
        card = await seen(ai_chat_env, "permission_requested")
        approvals.APPROVALS.decide(card["permission_id"], 1, "deny")
        await seen(ai_chat_env, "turn_ended")
    assert card["detail"] == "why\n\n/srv/app/run.sh\nnew body"
    assert card["can_allow"] is True


async def test_a_block_it_cannot_render_removes_allow(ai_chat_env):
    with anyio.fail_after(30):
        await send(ai_chat_env, "PERMIT_TERMINAL")
        card = await seen(ai_chat_env, "permission_requested")
        assert card["detail"] == "why\n\n1 item not shown."
        assert (card["can_allow"], card["hidden"]) == (False, True)
        with pytest.raises(approvals.AllowNotOffered):
            approvals.APPROVALS.decide(card["permission_id"], 1, "allow")
        approvals.APPROVALS.decide(card["permission_id"], 1, "deny")
        await seen(ai_chat_env, "turn_ended")
    assert rows(ai_chat_env, "assistant")[0].text == "denied"


async def test_a_long_title_is_cut_marked_and_removes_allow(ai_chat_env):
    with anyio.fail_after(30):
        await send(ai_chat_env, "PERMIT_LONG_TITLE")
        card = await seen(ai_chat_env, "permission_requested")
        with pytest.raises(approvals.AllowNotOffered):
            approvals.APPROVALS.decide(card["permission_id"], 1, "allow")
        approvals.APPROVALS.decide(card["permission_id"], 1, "deny")
        await seen(ai_chat_env, "turn_ended")
    assert card["title"] == "t" * 20000 + "\n\n5000 more characters not shown."
    assert (card["can_allow"], card["hidden"]) == (False, True)
    assert rows(ai_chat_env, "permission")[0].text == card["title"]


async def test_no_allow_once_is_not_hidden_content(ai_chat_env):
    with anyio.fail_after(30):
        await send(ai_chat_env, "PERMIT_NOALLOW")
        card = await seen(ai_chat_env, "permission_requested")
        approvals.APPROVALS.decide(card["permission_id"], 1, "deny")
        await seen(ai_chat_env, "turn_ended")
    assert (card["can_allow"], card["hidden"]) == (False, False)


async def test_a_nul_or_surrogate_in_a_title_still_asks_the_user(ai_chat_env):
    with anyio.fail_after(30):
        await send(ai_chat_env, "PERMIT_BAD_TEXT")
        card = await seen(ai_chat_env, "permission_requested")
        approvals.APPROVALS.decide(card["permission_id"], 1, "allow")
        await seen(ai_chat_env, "turn_ended")
    assert card["title"] == "a\ufffdb\ufffdc"
    assert card["detail"] == '{"command":"a\\u0000b\ufffdc"}'  # json.dumps has already escaped the NUL
    row = rows(ai_chat_env, "permission")[0]
    assert (row.text, row.meta["title"], row.meta["detail"]) == (card["title"], card["title"], card["detail"])
    assert rows(ai_chat_env, "assistant")[0].text == "allowed"  # the user's answer, not a silent cancelled


async def test_a_nul_or_surrogate_in_agent_text_does_not_lose_the_reply(ai_chat_env):
    with anyio.fail_after(30):
        await send(ai_chat_env, "BAD_TEXT")
        ended = await seen(ai_chat_env, "turn_ended")
    row = rows(ai_chat_env, "assistant")[0]
    assert row.text == "a\ufffdb\ufffdc"
    assert (ended["stop_reason"], ended["message_seq"]) == ("end_turn", row.seq)


@pytest.mark.parametrize("change", [{"chat_id": None}, {"turn_id": None}, {"consuming": True}, {"replaying": True},
                                    {"stop_requested": True}, {"acp_session_id": "another"}])
async def test_no_card_when_nobody_can_answer(ai_chat_env, change, caplog):
    caplog.set_level(logging.INFO, logger="ai_chat.sessions")
    s = ai_chat_env.session()
    s.acp_session_id, s.turn_id = "sid", "t1"
    for name, value in change.items():
        setattr(s, name, value)
    options = [PermissionOption(option_id="allow-once", name="Allow once", kind="allow_once")]
    with anyio.fail_after(5):
        response = await s._client.request_permission("sid", ToolCallUpdate(tool_call_id="c", title="x"), options)
    assert response.outcome.outcome == "cancelled"
    assert ai_chat_env.events() == []
    assert approvals.APPROVALS.pending_for_chat(1) == [] and rows(ai_chat_env, "permission") == []
    logged = [r.getMessage() for r in caplog.records if r.getMessage().startswith("ai_chat.permission ")]
    assert logged == ([] if s.chat_id is None else ["ai_chat.permission chat=1 source=agent decision=cancelled"])


async def test_failed_row_write_answers_cancelled_without_the_text(ai_chat_env, monkeypatch, caplog):
    real = sessions.persist_message

    def refuse_permission_rows(chat_id, role, text, meta):
        if role == "permission":
            raise RuntimeError("detail that must stay private")
        return real(chat_id, role, text, meta)

    monkeypatch.setattr(sessions, "persist_message", refuse_permission_rows)
    with anyio.fail_after(30):
        await send(ai_chat_env, "PERMIT")
        await seen(ai_chat_env, "turn_ended")
    assert rows(ai_chat_env, "assistant")[0].text == "cancelled"  # fail closed
    assert of_type(ai_chat_env, "permission_requested") == []
    assert approvals.APPROVALS.pending_for_chat(1) == []
    assert "RuntimeError" in caplog.text and "must stay private" not in caplog.text


async def test_permission_log_lines_carry_no_content(ai_chat_env, caplog):
    caplog.set_level(logging.INFO, logger="ai_chat.sessions")
    with anyio.fail_after(30):
        await send(ai_chat_env, "PERMIT")
        card = await seen(ai_chat_env, "permission_requested")
        approvals.APPROVALS.decide(card["permission_id"], 1, "deny")
        await seen(ai_chat_env, "turn_ended")
    assert [r.getMessage() for r in caplog.records if r.getMessage().startswith("ai_chat.permission ")] == [
        "ai_chat.permission chat=1 source=agent decision=requested",
        "ai_chat.permission chat=1 source=agent decision=deny"]
    assert "Run a command" not in caplog.text and '"command"' not in caplog.text


# ---- Stop and pending approvals ----------------------------------------------------------------

async def test_stop_cancels_turn_and_pending(ai_chat_env, tmp_path):
    state = tmp_path / "state.json"
    ai_chat_env.flags = ["--state", str(state)]
    with anyio.fail_after(30):
        await send(ai_chat_env, "PERMIT")
        card = await seen(ai_chat_env, "permission_requested")
        assert await sessions.MANAGER.cancel(1) is True
        # Stop waits for the turn, so it is over here. The fake's PERMIT ends normally once its request is answered.
        assert sessions.MANAGER.running_turn(1) is None
        assert of_type(ai_chat_env, "turn_ended")[0]["stop_reason"] == "end_turn"
        with pytest.raises(approvals.ApprovalNotFound):
            approvals.APPROVALS.decide(card["permission_id"], 1, "allow")
        assert await sessions.MANAGER.cancel(1) is False
    assert [e["decision"] for e in of_type(ai_chat_env, "permission_resolved")] == ["cancelled"]
    meta = rows(ai_chat_env, "permission")[0].meta
    assert meta["decision"] == "cancelled" and meta["decided_by"] is None
    assert rows(ai_chat_env, "assistant")[0].text == "cancelled"
    assert "cancel" in agent_log(state)
    assert approvals.APPROVALS.pending_for_chat(1) == []
    assert sessions.MANAGER.get(1) is not None  # the session stays for the next prompt


async def test_turn_ended_follows_a_slow_resolution(ai_chat_env, monkeypatch):
    # Stop's row write outlasts the agent ending the turn; a refetch at turn_ended must still see the decision.
    real = sessions.update_message_meta

    def slow_write(chat_id, seq, patch):
        time.sleep(0.5)
        real(chat_id, seq, patch)

    monkeypatch.setattr(sessions, "update_message_meta", slow_write)
    with anyio.fail_after(30):
        await send(ai_chat_env, "PERMIT")
        await seen(ai_chat_env, "permission_requested")
        assert await sessions.MANAGER.cancel(1) is True
        ended = await seen(ai_chat_env, "turn_ended")
    assert of_type(ai_chat_env, "permission_resolved")[0]["seq"] < ended["seq"]


async def test_stop_a_slow_turn_ends_cancelled(ai_chat_env):
    with anyio.fail_after(30):
        session, _ = await send(ai_chat_env, "SLOW")
        await seen(ai_chat_env, "message_chunk", text="working")
        assert await sessions.MANAGER.cancel(1) is True
    ended = of_type(ai_chat_env, "turn_ended")[0]
    assert ended["stop_reason"] == "cancelled" and ended["message_seq"] == rows(ai_chat_env, "assistant")[0].seq
    assert rows(ai_chat_env, "assistant")[0].meta == {"tools": [], "stop_reason": "cancelled"}
    assert of_type(ai_chat_env, "error") == []
    assert sessions.MANAGER.get(1) is session and session.proc.returncode is None


async def test_stop_without_a_turn_is_false(ai_chat_env):
    with anyio.fail_after(5):
        assert await sessions.MANAGER.cancel(1) is False


async def test_stop_survives_its_callers_cancellation(ai_chat_env, monkeypatch):
    with anyio.fail_after(30):
        session, _ = await send(ai_chat_env, "PERMIT")
        await seen(ai_chat_env, "permission_requested")
        send_cancel = session._conn.cancel

        async def slow_send(**kwargs):
            await asyncio.sleep(0.3)
            await send_cancel(**kwargs)

        monkeypatch.setattr(session._conn, "cancel", slow_send)
        stop = asyncio.create_task(sessions.MANAGER.cancel(1))
        await asyncio.sleep(0.05)  # inside the send, ahead of the sweep
        stop.cancel()
        with pytest.raises(asyncio.CancelledError):
            await stop
        # The agent is blocked on the card: left open, it would wait out permission_timeout_s.
        await seen(ai_chat_env, "permission_resolved", decision="cancelled")
        await seen(ai_chat_env, "turn_ended")


# The quick prompt ends `end_turn`: the fake's echo never looks at session/cancel. What Stop owes it is the order.
@pytest.mark.parametrize(("text", "stop_reason", "reply"), [("SLOW", "cancelled", "working"),
                                                            ("quick", "end_turn", "echo: quick")])
async def test_stop_ready_ahead_of_the_prompts_first_step_goes_out_after_it(ai_chat_env, tmp_path, monkeypatch, text,
                                                                            stop_reason, reply):
    # session/cancel ahead of session/prompt cancels nothing, and the agent then runs the whole prompt.
    state = tmp_path / "state.json"
    ai_chat_env.flags = ["--state", str(state)]
    stops = []
    real_prompt = sessions.LiveSession._prompt

    async def stop_then_prompt(self, blocks):
        # Ready now, so it runs right ahead of the task `_prompt` is about to schedule.
        stops.append(asyncio.create_task(sessions.MANAGER._stop_turn(sessions.MANAGER._turns[1])))
        return await real_prompt(self, blocks)

    monkeypatch.setattr(sessions.LiveSession, "_prompt", stop_then_prompt)
    with anyio.fail_after(30):
        session, _ = await send(ai_chat_env, text)
        ended = await seen(ai_chat_env, "turn_ended")
        await stops[0]
        kept = sessions.MANAGER.get(1) is session  # a hard cancel would have retired it
        await sessions.MANAGER.close_chat(1)
        await session.proc.wait()  # `eof` is in the log, so the log is complete
    assert [line for line in agent_log(state) if not line.startswith("new ")] == [f'prompt ["{text}"]', "cancel", "eof"]
    assert kept and ended["stop_reason"] == stop_reason and rows(ai_chat_env, "assistant")[0].text == reply


async def test_stop_during_start_sends_no_prompt(ai_chat_env, tmp_path, monkeypatch):
    monkeypatch.setattr(sessions, "_GRACE_S", 20)  # a slow host's spawn must not turn this into a hard cancel
    state = tmp_path / "state.json"
    ai_chat_env.flags = ["--state", str(state)]
    gate = asyncio.Event()
    real_start = sessions.LiveSession.start

    async def gated_start(self):
        await gate.wait()
        await real_start(self)

    monkeypatch.setattr(sessions.LiveSession, "start", gated_start)
    with anyio.fail_after(30):
        session, _ = await send(ai_chat_env, "hi")
        await seen(ai_chat_env, "turn_started", starting=True)
        stop = asyncio.create_task(sessions.MANAGER.cancel(1))
        while not session.stop_requested:
            await asyncio.sleep(0.01)
        gate.set()
        assert await stop is True
        ended = await seen(ai_chat_env, "turn_ended")
    assert (ended["stop_reason"], ended["message_seq"]) == ("cancelled", None)
    assert agent_log(state) == [] and session.acp_session_id is None  # no attach, no prompt
    assert rows(ai_chat_env, "assistant") == [] and of_type(ai_chat_env, "error") == []
    assert sessions.MANAGER.get(1) is session


async def test_stop_before_the_turn_runs_spawns_nothing(ai_chat_env):
    with anyio.fail_after(15):
        session, _ = await send(ai_chat_env, "hi")
        session.stop_requested = True  # no await since start_turn, so the turn task has not had a step yet
        ended = await seen(ai_chat_env, "turn_ended")
    assert ended["stop_reason"] == "cancelled" and session.proc is None and session._owner is None


async def test_failure_after_stop_is_cancelled_not_an_error(ai_chat_env, monkeypatch):
    # Stop lands during the tool check, which then fails: Stop's outcome, and the session still goes.
    async def stop_then_refuse(self):
        self.stop_requested = True
        return ["terminal"]

    monkeypatch.setattr(sessions.LiveSession, "list_tools", stop_then_refuse)
    with anyio.fail_after(30):
        session, _ = await send(ai_chat_env, "hi", allowed_roles=("standard",))
        ended = await seen(ai_chat_env, "turn_ended")
        await session.proc.wait()  # a failed turn's process still goes
    assert ended["stop_reason"] == "cancelled" and of_type(ai_chat_env, "error") == []
    assert sessions.MANAGER.get(1) is None


async def test_stop_after_the_sweep_refuses_a_new_request(ai_chat_env):
    # An agent that had not read the cancel yet can still ask: no second card (spec 8).
    with anyio.fail_after(30):
        session, _ = await send(ai_chat_env, "SLOW")
        await seen(ai_chat_env, "message_chunk", text="working")
        session.stop_requested = True
        response = await session._client.request_permission(
            session.acp_session_id, ToolCallUpdate(tool_call_id="c", title="x"), [])
    assert response.outcome.outcome == "cancelled"
    assert of_type(ai_chat_env, "permission_requested") == []


async def test_stop_falls_back_to_a_hard_cancel(ai_chat_env, monkeypatch):
    monkeypatch.setattr(sessions, "_GRACE_S", 0.2)
    with anyio.fail_after(30):
        session, _ = await send(ai_chat_env, "STUCK")  # ignores session/cancel
        await seen(ai_chat_env, "message_chunk", text="working")
        assert await sessions.MANAGER.cancel(1) is True
        ended = await seen(ai_chat_env, "turn_ended")
        assert sessions.MANAGER.running_turn(1) is None
        assert sessions.MANAGER.get(1) is None  # a discarded reply could land in the next turn, so the session goes
        await session.proc.wait()
    assert (ended["stop_reason"], ended["message_seq"]) == ("cancelled", None)
    assert of_type(ai_chat_env, "error") == []


async def test_turn_end_resolves_pending(ai_chat_env):
    with anyio.fail_after(30):
        session, _ = await send(ai_chat_env, "ABANDON")  # asks, and ends the turn without waiting for the answer
        card = await seen(ai_chat_env, "permission_requested")
        ended = await seen(ai_chat_env, "turn_ended")
        assert sessions.MANAGER.running_turn(1) is None  # a client that sees turn_ended can send the next prompt
        assert session.turn_id is None  # a request arriving now is refused, never registered
        with pytest.raises(approvals.ApprovalNotFound):
            approvals.APPROVALS.decide(card["permission_id"], 1, "allow")
    resolved = of_type(ai_chat_env, "permission_resolved")
    assert [e["decision"] for e in resolved] == ["cancelled"]
    assert resolved[0]["turn_id"] == card["turn_id"]
    assert resolved[0]["seq"] < ended["seq"]  # so the refetch at turn_ended sees the row's decision
    assert rows(ai_chat_env, "permission")[0].meta["decision"] == "cancelled"
    assert approvals.APPROVALS.pending_for_chat(1) == []


async def test_swept_during_the_row_write_shows_no_card(ai_chat_env, monkeypatch):
    reached, release = threading.Event(), threading.Event()
    real = sessions.persist_message

    def held(chat_id, role, text, meta):
        if role == "permission":
            reached.set()
            release.wait(10)
        return real(chat_id, role, text, meta)

    monkeypatch.setattr(sessions, "persist_message", held)
    with anyio.fail_after(30):
        session, _ = await send(ai_chat_env, "PERMIT")
        while not reached.is_set():
            await asyncio.sleep(0.01)
        assert len(approvals.APPROVALS.pending_for_chat(1)) == 1
        sweep = asyncio.create_task(session._client.close_cards())
        await asyncio.sleep(0.05)
        release.set()
        await sweep
        await seen(ai_chat_env, "turn_ended")
    assert of_type(ai_chat_env, "permission_requested") == []
    assert of_type(ai_chat_env, "permission_resolved") == []
    assert rows(ai_chat_env, "permission")[0].meta["decision"] == "cancelled"
    assert rows(ai_chat_env, "assistant")[0].text == "cancelled"


async def test_agent_death_resolves_pending(ai_chat_env):
    with anyio.fail_after(30):
        session, _ = await send(ai_chat_env, "PERMIT")
        card = await seen(ai_chat_env, "permission_requested")
        session.proc.kill()
        ended = await seen(ai_chat_env, "turn_ended")
        error = await seen(ai_chat_env, "error")
        assert sessions.MANAGER.get(1) is None
        await session.proc.wait()
    assert (error["code"], error["message"]) == ("agent_exited", "Jarvis stopped unexpectedly.")
    assert ended["stop_reason"] == "error"
    resolved = of_type(ai_chat_env, "permission_resolved")
    assert [(e["permission_id"], e["decision"]) for e in resolved] == [(card["permission_id"], "cancelled")]
    assert rows(ai_chat_env, "permission")[0].meta["decision"] == "cancelled"
    assert approvals.APPROVALS.pending_for_chat(1) == []
    assistant = rows(ai_chat_env, "assistant")[0]  # the partial row: a tool ran, no text
    assert ended["message_seq"] == assistant.seq and assistant.meta["stop_reason"] == "agent_exited"


# ---- one decision: row, event and agent agree, and Stop always wins ------------------------------

def decisions(env) -> tuple:
    """(what the agent replied, the permission_resolved decisions, the row's decision)."""
    return (rows(env, "assistant")[0].text, [e["decision"] for e in of_type(env, "permission_resolved")],
            rows(env, "permission")[0].meta["decision"])


async def test_allow_during_stops_send_is_cancelled(ai_chat_env, tmp_path, monkeypatch):
    state = tmp_path / "state.json"
    ai_chat_env.flags = ["--state", str(state)]
    written = []
    real = sessions.update_message_meta

    def spy(chat_id, seq, patch):
        written.append(patch["decision"])
        real(chat_id, seq, patch)

    monkeypatch.setattr(sessions, "update_message_meta", spy)
    with anyio.fail_after(30):
        session, _ = await send(ai_chat_env, "PERMIT")
        card = await seen(ai_chat_env, "permission_requested")
        send_cancel = session._conn.cancel

        async def send_then_stall(**kwargs):
            await send_cancel(**kwargs)
            await asyncio.sleep(0.2)

        monkeypatch.setattr(session._conn, "cancel", send_then_stall)
        stop = asyncio.create_task(sessions.MANAGER.cancel(1))
        await asyncio.sleep(0.05)
        approvals.APPROVALS.decide(card["permission_id"], 1, "allow")
        await stop
    assert decisions(ai_chat_env) == ("cancelled", ["cancelled"], "cancelled")
    assert written == ["cancelled"]  # settled before anything was written
    assert rows(ai_chat_env, "permission")[0].meta["decided_by"] is None
    assert "cancel" in agent_log(state)


async def test_allow_in_the_last_step_of_stops_send_is_cancelled(ai_chat_env, tmp_path, monkeypatch):
    # The sweep runs before the waiter wakes, and takes a card already decided.
    state = tmp_path / "state.json"
    ai_chat_env.flags = ["--state", str(state)]
    with anyio.fail_after(30):
        session, _ = await send(ai_chat_env, "PERMIT")
        card = await seen(ai_chat_env, "permission_requested")
        send_cancel = session._conn.cancel

        async def send_then_decide(**kwargs):
            await send_cancel(**kwargs)
            approvals.APPROVALS.decide(card["permission_id"], 1, "allow")

        monkeypatch.setattr(session._conn, "cancel", send_then_decide)
        assert await sessions.MANAGER.cancel(1) is True
    assert decisions(ai_chat_env) == ("cancelled", ["cancelled"], "cancelled")


async def test_sweep_ahead_of_the_waiter_is_what_the_agent_gets(ai_chat_env):
    # No Stop at all: the sweep takes a decided card before its waiter wakes, and the waiter answers what it recorded.
    s = ai_chat_env.session()
    s.acp_session_id, s.turn_id = "sid", "t1"
    options = [PermissionOption(option_id="allow-once", name="Allow once", kind="allow_once")]
    tool_call = ToolCallUpdate(tool_call_id="c", title="x")
    with anyio.fail_after(15):
        waiter = asyncio.create_task(s._client.request_permission("sid", tool_call, options))
        card = await seen(ai_chat_env, "permission_requested")
        approvals.APPROVALS.decide(card["permission_id"], 1, "allow")
        await s._client.close_cards()  # first step ahead of the waiter's: the future's wake-up takes several hops
        response = await waiter
    assert response.outcome.outcome == "cancelled"
    assert [e["decision"] for e in of_type(ai_chat_env, "permission_resolved")] == ["cancelled"]
    assert rows(ai_chat_env, "permission")[0].meta["decision"] == "cancelled"


async def test_turn_ended_follows_the_waiters_resolution(ai_chat_env, monkeypatch):
    # The agent ends the turn while the waiter writes the row, whatever the host's speed: the fake's 0.3 s runs out
    # under `_prompt`, the turn waits for the decision, and the write waits for the turn to be over.
    reached, release = threading.Event(), threading.Event()
    decided = asyncio.Event()
    real_write, real_prompt = sessions.update_message_meta, sessions.LiveSession._prompt

    def held(chat_id, seq, patch):
        reached.set()
        release.wait(10)
        real_write(chat_id, seq, patch)

    async def prompt_then_decision(self, blocks):
        result = await real_prompt(self, blocks)
        await decided.wait()
        return result

    monkeypatch.setattr(sessions, "update_message_meta", held)
    monkeypatch.setattr(sessions.LiveSession, "_prompt", prompt_then_decision)
    with anyio.fail_after(30):
        session, _ = await send(ai_chat_env, "ABANDON")
        card = await seen(ai_chat_env, "permission_requested")
        approvals.APPROVALS.decide(card["permission_id"], 1, "allow")
        while not reached.is_set():
            await asyncio.sleep(0.01)
        decided.set()
        while session.turn_id is not None:
            await asyncio.sleep(0.01)
        release.set()
        ended = await seen(ai_chat_env, "turn_ended")
        row = rows(ai_chat_env, "permission")[0].meta  # what a refetch at turn_ended reads
    resolved = of_type(ai_chat_env, "permission_resolved")
    assert [e["decision"] for e in resolved] == ["allow"] and row["decision"] == "allow"
    assert resolved[0]["seq"] < ended["seq"]


async def test_allow_written_while_stop_goes_out_flips_to_cancelled(ai_chat_env, tmp_path, monkeypatch):
    # The order, whatever the host's speed: the allow write starts, session/cancel reaches the agent, the write ends.
    state = tmp_path / "state.json"
    ai_chat_env.flags = ["--state", str(state)]
    written = []
    reached, release = threading.Event(), threading.Event()
    real = sessions.update_message_meta

    def held_once(chat_id, seq, patch):
        if not reached.is_set():
            reached.set()
            release.wait(10)
        real(chat_id, seq, patch)
        written.append(patch["decision"])

    monkeypatch.setattr(sessions, "update_message_meta", held_once)
    with anyio.fail_after(30):
        await send(ai_chat_env, "PERMIT")
        card = await seen(ai_chat_env, "permission_requested")
        approvals.APPROVALS.decide(card["permission_id"], 1, "allow")
        while not reached.is_set():
            await asyncio.sleep(0.01)
        stop = asyncio.create_task(sessions.MANAGER.cancel(1))
        while "cancel" not in agent_log(state):
            await asyncio.sleep(0.01)
        release.set()
        assert await stop is True
    assert decisions(ai_chat_env) == ("cancelled", ["cancelled"], "cancelled")
    assert written == ["allow", "cancelled"]
    assert rows(ai_chat_env, "permission")[0].meta["decided_by"] is None


async def test_allow_in_the_step_before_stops_send_is_cancelled(ai_chat_env, monkeypatch):
    # The yield in `LiveSession.cancel`: Stop is flagged and session/cancel has not gone out. Allow still loses.
    sends = []
    with anyio.fail_after(30):
        session, _ = await send(ai_chat_env, "PERMIT")
        card = await seen(ai_chat_env, "permission_requested")
        real_send = session._conn.cancel

        async def spy_send(**kwargs):
            sends.append(kwargs)
            await real_send(**kwargs)

        monkeypatch.setattr(session._conn, "cancel", spy_send)
        stop = asyncio.create_task(sessions.MANAGER.cancel(1))
        while not session.stop_requested:  # one step at a time: this runs ahead of whatever the flag's setter yields to
            await asyncio.sleep(0)
        assert sends == []
        approvals.APPROVALS.decide(card["permission_id"], 1, "allow")
        await stop
    assert len(sends) == 1
    assert decisions(ai_chat_env) == ("cancelled", ["cancelled"], "cancelled")


async def test_failed_decision_write_publishes_cancelled(ai_chat_env, monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="ai_chat.sessions")

    def refuse(chat_id, seq, patch):
        raise RuntimeError("detail that must stay private")

    monkeypatch.setattr(sessions, "update_message_meta", refuse)
    with anyio.fail_after(30):
        await send(ai_chat_env, "PERMIT")
        card = await seen(ai_chat_env, "permission_requested")
        approvals.APPROVALS.decide(card["permission_id"], 1, "allow")
        await seen(ai_chat_env, "turn_ended")
    assert decisions(ai_chat_env) == ("cancelled", ["cancelled"], None)
    logged = [r.getMessage() for r in caplog.records if r.getMessage().startswith("ai_chat.permission ")]
    assert logged[-1] == "ai_chat.permission chat=1 source=agent decision=cancelled"
    assert "RuntimeError" in caplog.text and "must stay private" not in caplog.text


async def test_waiter_cancelled_during_the_row_insert_still_gets_a_decision(ai_chat_env, monkeypatch):
    reached, release = threading.Event(), threading.Event()
    real = sessions.persist_message

    def held(chat_id, role, text, meta):
        reached.set()
        release.wait(10)
        return real(chat_id, role, text, meta)

    monkeypatch.setattr(sessions, "persist_message", held)
    s = ai_chat_env.session()
    s.acp_session_id, s.turn_id = "sid", "t1"
    options = [PermissionOption(option_id="allow-once", name="Allow once", kind="allow_once")]
    tool_call = ToolCallUpdate(tool_call_id="c", title="x")
    with anyio.fail_after(15):
        waiter = asyncio.create_task(s._client.request_permission("sid", tool_call, options))
        while not reached.is_set():
            await asyncio.sleep(0.01)
        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter  # at once: it does not hold acp's shutdown up behind the insert
        assert approvals.APPROVALS.pending_for_chat(1) == []
        sweep = asyncio.create_task(s._client.close_cards())
        await asyncio.sleep(0.05)
        release.set()
        await sweep
    assert rows(ai_chat_env, "permission")[0].meta["decision"] == "cancelled"
    assert ai_chat_env.events() == []  # no card was ever shown
    assert s._client.cards == {}


async def test_waiter_cancelled_during_the_decision_write_ends_cancelled(ai_chat_env, monkeypatch):
    # acp cancels the handler when the connection closes. The agent got no answer, so no record may say allow.
    reached, release, landed = threading.Event(), threading.Event(), threading.Event()
    real = sessions.update_message_meta

    def held_once(chat_id, seq, patch):
        first = not reached.is_set()
        if first:
            reached.set()
            release.wait(10)
        real(chat_id, seq, patch)
        if first:
            landed.set()

    monkeypatch.setattr(sessions, "update_message_meta", held_once)
    s = ai_chat_env.session()
    s.acp_session_id, s.turn_id = "sid", "t1"
    options = [PermissionOption(option_id="allow-once", name="Allow once", kind="allow_once")]
    tool_call = ToolCallUpdate(tool_call_id="c", title="x")
    with anyio.fail_after(15):
        waiter = asyncio.create_task(s._client.request_permission("sid", tool_call, options))
        card = await seen(ai_chat_env, "permission_requested")
        approvals.APPROVALS.decide(card["permission_id"], 1, "allow")
        while not reached.is_set():
            await asyncio.sleep(0.01)
        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
        assert of_type(ai_chat_env, "permission_resolved") == []
        sweep = asyncio.create_task(s._client.close_cards())
        await asyncio.sleep(0.05)
        release.set()  # the `allow` write lands first, and the sweep's `cancelled` goes on top of it
        await sweep
        while not landed.is_set():  # both have landed before the row is read
            await asyncio.sleep(0.01)
    assert [e["decision"] for e in of_type(ai_chat_env, "permission_resolved")] == ["cancelled"]
    assert rows(ai_chat_env, "permission")[0].meta["decision"] == "cancelled"


# ---- Stop never loses the recap ------------------------------------------------------------------

async def test_stop_during_start_keeps_the_history_for_the_next_prompt(ai_chat_env, tmp_path, monkeypatch):
    monkeypatch.setattr(sessions, "_GRACE_S", 20)
    state = tmp_path / "state.json"
    ai_chat_env.flags = ["--state", str(state), "--no-load"]
    gate = asyncio.Event()
    real_start = sessions.LiveSession.start

    async def gated_start(self):
        await gate.wait()
        await real_start(self)

    monkeypatch.setattr(sessions.LiveSession, "start", gated_start)
    with anyio.fail_after(30):
        await seed_history()
        session, t1 = await send(ai_chat_env, "first", stored="gone-session")
        await seen(ai_chat_env, "turn_started", turn_id=t1)
        stop = asyncio.create_task(sessions.MANAGER.cancel(1))
        while not session.stop_requested:
            await asyncio.sleep(0.01)
        gate.set()
        await stop
        await seen(ai_chat_env, "turn_ended", turn_id=t1)
        # The chat row still holds the stored id: this turn never attached, so the route reads the same one again.
        again, t2 = await send(ai_chat_env, "second", stored="gone-session")
        await seen(ai_chat_env, "turn_ended", turn_id=t2)
    assert again is session
    (only,) = prompts(state)  # `first` never went out
    assert only[0].startswith("<mk1_earlier_conversation>") and "user: earlier question" in only[0]
    assert only[1:] == ["second"]


async def test_stop_during_attach_keeps_the_recap_for_the_next_prompt(ai_chat_env, tmp_path, monkeypatch):
    state = tmp_path / "state.json"
    ai_chat_env.flags = ["--state", str(state), "--no-load"]
    real_attach = sessions.LiveSession.attach

    async def attach_then_stop(self, stored):
        result = await real_attach(self, stored)
        self.stop_requested = True  # what cancel() does first
        return result

    monkeypatch.setattr(sessions.LiveSession, "attach", attach_then_stop)
    with anyio.fail_after(30):
        await seed_history()
        session, t1 = await send(ai_chat_env, "first", stored="gone-session")
        ended = await seen(ai_chat_env, "turn_ended", turn_id=t1)
        assert ended["stop_reason"] == "cancelled"
        assert session.pending_recap is not None  # nothing has carried it yet
        again, t2 = await send(ai_chat_env, "second")  # attached already, so no second attach
        await seen(ai_chat_env, "turn_ended", turn_id=t2)
    assert again is session and session.pending_recap is None
    (only,) = prompts(state)
    assert "user: earlier question" in only[0] and only[1:] == ["second"]


async def test_stop_between_refusal_and_retry_keeps_the_recap(ai_chat_env, tmp_path, monkeypatch):
    state = tmp_path / "state.json"
    ai_chat_env.flags = ["--state", str(state)]
    real_new = sessions.LiveSession._new_session

    async def new_then_stop(self, recap):
        result = await real_new(self, recap)
        if recap:
            self.stop_requested = True  # what cancel() does first
        return result

    monkeypatch.setattr(sessions.LiveSession, "_new_session", new_then_stop)
    with anyio.fail_after(30):
        await seed_history()
        session, t1 = await send(ai_chat_env, "first", stored="unknown-session")
        ended = await seen(ai_chat_env, "turn_ended", turn_id=t1)
        again, t2 = await send(ai_chat_env, "second")
        await seen(ai_chat_env, "turn_ended", turn_id=t2)
    assert again is session and ended["stop_reason"] == "cancelled"
    refused, carried = prompts(state)
    assert refused == ["first"]
    assert carried[0].startswith("<mk1_earlier_conversation>") and "user: earlier question" in carried[0]
    assert carried[1:] == ["second"] and session.pending_recap is None


# ---- the turn task: events, rows, errors ---------------------------------------------------------

async def test_turn_flags_blocks_and_row(ai_chat_env, tmp_path):
    state = tmp_path / "state.json"
    ai_chat_env.flags = ["--state", str(state), "--no-load"]  # the stored id cannot be restored: new session + recap
    page = {"section": "lims", "subsection": "sample-details", "target_kind": "sample", "target_id": "P-1"}
    with anyio.fail_after(30):
        await seed_history()
        session, t1 = await send(ai_chat_env, "now", stored="gone-session", page_context=page)
        started = await seen(ai_chat_env, "turn_started")
        ended = await seen(ai_chat_env, "turn_ended", turn_id=t1)
        _, t2 = await send(ai_chat_env, "next", page_context={"section": "nope", "subsection": "x"})
        again = await seen(ai_chat_env, "turn_started", turn_id=t2)
        await seen(ai_chat_env, "turn_ended", turn_id=t2)
    assert (started["starting"], started["resuming"], started["turn_id"]) == (True, True, t1)
    assert (again["starting"], again["resuming"]) == (False, False)
    first, second = prompts(state)
    assert first[0].startswith("<mk1_page_context>") and "sample P-1" in first[0]
    assert first[1].startswith("<mk1_earlier_conversation>") and "user: earlier question" in first[1]
    assert "user: now" not in first[1] and first[2:] == ["now"]  # the recap holds only earlier messages
    assert second == ["next"]  # recap sent once; a bad context dropped
    assert session.pending_recap is None
    assistant = rows(ai_chat_env, "assistant")
    assert [r.text for r in assistant[-2:]] == ["echo: now", "echo: next"]
    assert assistant[-2].meta == {"tools": [], "stop_reason": "end_turn"}
    assert (ended["stop_reason"], ended["message_seq"]) == ("end_turn", assistant[-2].seq)


async def test_new_chat_turn_started_flags(ai_chat_env):
    with anyio.fail_after(30):
        await send(ai_chat_env, "hi")
        started = await seen(ai_chat_env, "turn_started")
        await seen(ai_chat_env, "turn_ended")
    assert (started["starting"], started["resuming"]) == (True, False)


async def test_refusal_recap_leaves_out_the_current_question(ai_chat_env, tmp_path):
    state = tmp_path / "state.json"
    ai_chat_env.flags = ["--state", str(state)]
    with anyio.fail_after(30):
        await seed_history()
        await send(ai_chat_env, "hi", stored="unknown-session")  # an unknown load looks like success (G10)
        ended = await seen(ai_chat_env, "turn_ended")
    assert ended["stop_reason"] == "end_turn"
    refused, retried = prompts(state)
    assert refused == ["hi"]
    assert "user: earlier question" in retried[0] and "user: hi" not in retried[0] and retried[1:] == ["hi"]


async def test_recap_messages_before_seq(ai_chat_env):
    with anyio.fail_after(15):
        await seed_history()
        seq = await asyncio.to_thread(sessions.persist_message, 1, "user", "current", None)
        earlier = await asyncio.to_thread(sessions.recap_messages, 1, before_seq=seq)
        everything = await asyncio.to_thread(sessions.recap_messages, 1)
    assert earlier == [("user", "earlier question"), ("assistant", "earlier answer")]
    assert everything[-1] == ("user", "current")


async def test_start_turn_refuses_while_a_turn_runs(ai_chat_env):
    with anyio.fail_after(30):
        session, turn_id = await send(ai_chat_env, "SLOW")
        assert sessions.MANAGER.running_turn(1) == turn_id
        with pytest.raises(sessions.TurnRunning):
            sessions.MANAGER.start_turn(session, "again", None, None, 99)
        await seen(ai_chat_env, "message_chunk", text="working")
        await sessions.MANAGER.cancel(1)
        assert sessions.MANAGER.running_turn(1) is None
        _, second = await send(ai_chat_env, "after")
        await seen(ai_chat_env, "turn_ended", turn_id=second)
    assert rows(ai_chat_env, "assistant")[-1].text == "echo: after"


async def test_agent_exit_is_mapped_and_the_next_prompt_respawns(ai_chat_env):
    ai_chat_env.flags = ["--exit-on-prompt"]
    with anyio.fail_after(30):
        session, t1 = await send(ai_chat_env, "hi")
        ended = await seen(ai_chat_env, "turn_ended", turn_id=t1)
        assert sessions.MANAGER.get(1) is None and sessions.MANAGER.live_count(1) == 0
        await session.proc.wait()
        ai_chat_env.flags = []
        replacement, t2 = await send(ai_chat_env, "hello", stored=session.acp_session_id)
        restarted = await seen(ai_chat_env, "turn_started", turn_id=t2)
        await seen(ai_chat_env, "turn_ended", turn_id=t2)
    assert (ended["stop_reason"], ended["message_seq"]) == ("error", None)
    assert [(e["code"], e["message"]) for e in of_type(ai_chat_env, "error")] == [
        ("agent_exited", "Jarvis stopped unexpectedly.")]
    assert replacement is not session and restarted["starting"] is True and restarted["resuming"] is True
    assert rows(ai_chat_env, "assistant")[-1].text == "echo: hello"


async def test_unreachable_is_mapped_without_stderr(ai_chat_env, monkeypatch):
    script = "import sys; sys.stderr.write('Permission denied (publickey).\\n'); sys.exit(255)"
    monkeypatch.setattr(sessions, "spawn_command", lambda provider: [sys.executable, "-c", script])
    with anyio.fail_after(30):
        session, _ = await send(ai_chat_env, "hi")
        ended = await seen(ai_chat_env, "turn_ended")
        assert sessions.MANAGER.get(1) is None
        await session.proc.wait()
    assert [(e["code"], e["message"]) for e in of_type(ai_chat_env, "error")] == [
        ("agent_unreachable", "Jarvis is unreachable.")]
    assert (ended["stop_reason"], ended["message_seq"]) == ("error", None)
    assert "publickey" not in json.dumps(ai_chat_env.events())


@pytest.mark.parametrize("failure", [store.KeysNotConfigured(), ValueError("private host_key text")])
async def test_spawn_config_errors_are_mapped(ai_chat_env, monkeypatch, caplog, failure):
    def refuse(provider):
        raise failure

    monkeypatch.setattr(sessions, "spawn_command", refuse)
    with anyio.fail_after(30):
        await send(ai_chat_env, "hi")
        ended = await seen(ai_chat_env, "turn_ended")
    assert [(e["code"], e["message"]) for e in of_type(ai_chat_env, "error")] == [
        ("agent_unreachable", "Jarvis is not configured correctly. Ask an admin to run Test connection.")]
    assert ended["stop_reason"] == "error" and sessions.MANAGER.get(1) is None
    assert type(failure).__name__ in caplog.text and "private" not in caplog.text


async def test_tools_check_failure_closes_and_the_next_prompt_checks_again(ai_chat_env, tmp_path):
    tools = tmp_path / "tools.txt"
    tools.write_text("Available tools (1):\n  terminal: Run a shell command", encoding="utf-8")
    ai_chat_env.flags = ["--tools-reply", str(tools)]
    standard = {"allowed_roles": ("standard",)}
    with anyio.fail_after(30):
        first, t1 = await send(ai_chat_env, "hi", **standard)
        ended = await seen(ai_chat_env, "turn_ended", turn_id=t1)
        assert sessions.MANAGER.get(1) is None
        await first.proc.wait()
        _, t2 = await send(ai_chat_env, "hi again", **standard)
        await seen(ai_chat_env, "turn_ended", turn_id=t2)
    errors = of_type(ai_chat_env, "error")
    assert [e["code"] for e in errors] == ["tools_check_failed"] * 2 and "terminal" in errors[0]["message"]
    assert (ended["stop_reason"], ended["message_seq"]) == ("error", None)
    assert rows(ai_chat_env, "assistant") == []


@pytest.mark.parametrize("failure", [RuntimeError("private prompt text"), ValueError("private prompt text")])
async def test_other_exception_is_agent_error_without_its_text(ai_chat_env, monkeypatch, caplog, failure):
    async def explode(self, turn_id, blocks):
        raise failure

    monkeypatch.setattr(sessions.LiveSession, "run_turn", explode)
    with anyio.fail_after(30):
        session, _ = await send(ai_chat_env, "hi")
        ended = await seen(ai_chat_env, "turn_ended")
        await session.proc.wait()  # no process outlives a failed turn
    assert [(e["code"], e["message"]) for e in of_type(ai_chat_env, "error")] == [
        ("agent_error", "Something went wrong talking to Jarvis.")]
    assert ended["stop_reason"] == "error" and sessions.MANAGER.get(1) is None
    assert type(failure).__name__ in caplog.text and "private prompt text" not in caplog.text


async def test_chunks_after_the_turn_are_dropped(ai_chat_env):
    s = ai_chat_env.session()
    s.turn_id = None
    s._client._publish("message_chunk", text="straggler")
    assert ai_chat_env.events() == []


# ---- close ---------------------------------------------------------------------------------------

async def test_close_sends_cancel_before_eof(ai_chat_env, tmp_path):
    state = tmp_path / "state.json"
    ai_chat_env.flags = ["--state", str(state)]
    with anyio.fail_after(30):
        session, _ = await send(ai_chat_env, "SLOW")
        await seen(ai_chat_env, "message_chunk", text="working")
        await sessions.MANAGER.close_chat(1)
        assert sessions.MANAGER.get(1) is None and sessions.MANAGER.running_turn(1) is None
        ended = await seen(ai_chat_env, "turn_ended")
    assert session.proc.returncode is not None
    log = agent_log(state)
    assert log.index("cancel") < log.index("eof")
    assert ended["stop_reason"] == "cancelled" and of_type(ai_chat_env, "error") == []


async def test_close_resolves_pending(ai_chat_env):
    with anyio.fail_after(30):
        session, _ = await send(ai_chat_env, "PERMIT")
        await seen(ai_chat_env, "permission_requested")
        await sessions.MANAGER.close_chat(1)
    assert [e["decision"] for e in of_type(ai_chat_env, "permission_resolved")] == ["cancelled"]
    assert rows(ai_chat_env, "permission")[0].meta["decision"] == "cancelled"
    assert len(of_type(ai_chat_env, "turn_ended")) == 1 and of_type(ai_chat_env, "error") == []
    assert approvals.APPROVALS.pending_for_chat(1) == [] and session.proc.returncode is not None


async def test_close_of_a_chat_without_a_session_is_a_no_op(ai_chat_env):
    with anyio.fail_after(5):
        await sessions.MANAGER.close_chat(1)


async def test_agent_exit_while_closing_is_cancelled(ai_chat_env):
    with anyio.fail_after(30):
        session, _ = await send(ai_chat_env, "SLOW")
        await seen(ai_chat_env, "message_chunk", text="working")
        session.closing = session.stop_requested = True  # what a close marks before it gets to the agent
        session.proc.kill()
        ended = await seen(ai_chat_env, "turn_ended")
    assert ended["stop_reason"] == "cancelled" and of_type(ai_chat_env, "error") == []
    assistant = rows(ai_chat_env, "assistant")[0]  # the partial reply is kept
    assert assistant.text == "working" and ended["message_seq"] == assistant.seq


async def test_close_while_starting_ends_cancelled(ai_chat_env, monkeypatch):
    monkeypatch.setattr(sessions, "_GRACE_S", 0.2)
    ai_chat_env.flags = ["--no-init"]
    with anyio.fail_after(30):
        session, _ = await send(ai_chat_env, "hi")
        while session.proc is None:
            await asyncio.sleep(0.02)
        await sessions.MANAGER.close_chat(1)
        ended = await seen(ai_chat_env, "turn_ended")
        await session.proc.wait()
    assert (ended["stop_reason"], ended["message_seq"]) == ("cancelled", None)
    assert of_type(ai_chat_env, "error") == [] and sessions.MANAGER.running_turn(1) is None


async def test_close_survives_its_own_cancellation(ai_chat_env, monkeypatch):
    s = ai_chat_env.session()
    with anyio.fail_after(30):
        await s.start()
        await s.attach(None)
        send_cancel = s._conn.cancel

        async def slow_send(**kwargs):
            await asyncio.sleep(0.5)
            await send_cancel(**kwargs)

        monkeypatch.setattr(s._conn, "cancel", slow_send)
        turn = asyncio.create_task(s.run_turn("t1", ["SLOW"]))
        await seen(ai_chat_env, "message_chunk", text="working")
        closing = asyncio.create_task(s.close())
        await asyncio.sleep(0.05)  # inside the send
        closing.cancel()
        with pytest.raises(asyncio.CancelledError):
            await closing
        await s.proc.wait()  # stop was set anyway
        await turn


async def test_close_provider_closes_only_that_provider(ai_chat_env):
    add_chats(ai_chat_env, 2)
    with anyio.fail_after(30):
        first, t1 = await send(ai_chat_env, "SLOW")
        await seen(ai_chat_env, "message_chunk", text="working")
        other = sessions.MANAGER.reserve(2, 1, ai_chat_env.provider(id=2))
        await sessions.MANAGER.close_provider(1)
        ended = await seen(ai_chat_env, "turn_ended", turn_id=t1)
    assert first.proc.returncode is not None and ended["stop_reason"] == "cancelled"
    assert sessions.MANAGER.get(1) is None and sessions.MANAGER.get(2) is other


async def test_close_all_closes_everything(ai_chat_env):
    add_chats(ai_chat_env, 2)
    with anyio.fail_after(30):
        first, _ = await send(ai_chat_env, "SLOW")
        await seen(ai_chat_env, "message_chunk", text="working")
        second, t2 = await send(ai_chat_env, "hi", chat_id=2)
        await seen(ai_chat_env, "turn_ended", turn_id=t2)
        await sessions.MANAGER.close_all()
    assert first.proc.returncode is not None and second.proc.returncode is not None
    assert sessions.MANAGER.live_count(1) == 0 and sessions.MANAGER.running_turn(1) is None


async def test_a_raise_in_stop_cannot_skip_the_sweep_or_the_close(ai_chat_env, monkeypatch, caplog):
    real_close = sessions.LiveSession.close
    resolved_at_close = []

    async def explode(self, turn):
        raise RuntimeError("private text")

    async def spy_close(self):
        resolved_at_close.append(len(of_type(ai_chat_env, "permission_resolved")))
        await real_close(self)

    monkeypatch.setattr(sessions.SessionManager, "_stop_turn", explode)
    monkeypatch.setattr(sessions.LiveSession, "close", spy_close)
    with anyio.fail_after(30):
        session, _ = await send(ai_chat_env, "PERMIT")
        await seen(ai_chat_env, "permission_requested")
        await sessions.MANAGER.close_chat(1)
        assert session.proc.returncode is not None
        await seen(ai_chat_env, "turn_ended")
    assert resolved_at_close[0] == 1  # the agent got its answer ahead of EOF
    assert [e["decision"] for e in of_type(ai_chat_env, "permission_resolved")] == ["cancelled"]
    assert rows(ai_chat_env, "permission")[0].meta["decision"] == "cancelled"
    assert "RuntimeError" in caplog.text and "private text" not in caplog.text


async def test_any_send_failure_during_stop_is_only_logged_by_type(ai_chat_env, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG, logger="ai_chat.sessions")

    async def closed_handle(**kwargs):
        raise OSError("private handle text")

    with anyio.fail_after(30):
        session, _ = await send(ai_chat_env, "SLOW")
        await seen(ai_chat_env, "message_chunk", text="working")
        with monkeypatch.context() as patch:
            patch.setattr(session._conn, "cancel", closed_handle)
            await session.cancel()  # does not raise
    assert "ai_chat.cancel_not_sent chat=1 error=OSError" in caplog.text and "private handle" not in caplog.text


async def test_background_task_failure_logs_the_type_only(ai_chat_env, caplog):
    async def explode():
        raise RuntimeError("private text")

    with anyio.fail_after(5):
        task = sessions.MANAGER._spawn(explode())
        await asyncio.wait({task})
    assert task not in sessions.MANAGER._tasks
    assert "RuntimeError" in caplog.text and "private text" not in caplog.text


# ---- caps ----------------------------------------------------------------------------------------

async def test_cap_evicts_idle_lru(ai_chat_env):
    add_chats(ai_chat_env, 2, 3)
    cap = {"max_sessions": 2}
    with anyio.fail_after(30):
        first, t1 = await send(ai_chat_env, "one", **cap)
        await seen(ai_chat_env, "turn_ended", turn_id=t1)
        second, t2 = await send(ai_chat_env, "two", chat_id=2, **cap)
        await seen(ai_chat_env, "turn_ended", turn_id=t2)
        assert sessions.MANAGER.reserve(1, 1, ai_chat_env.provider(**cap)) is first  # the existing one; now freshest
        assert sessions.MANAGER.live_count(1) == 2
        second.last_active = first.last_active - 1
        third = sessions.MANAGER.reserve(3, 1, ai_chat_env.provider(**cap))
        # Excluded at once, closing or not.
        assert sessions.MANAGER.get(2) is None and second.closing and sessions.MANAGER.live_count(1) == 2
        assert sessions.MANAGER.get(1) is first and sessions.MANAGER.get(3) is third
        await second.proc.wait()
    assert first.proc.returncode is None


async def test_cap_busy_when_none_idle(ai_chat_env):
    add_chats(ai_chat_env, 2)
    with anyio.fail_after(30):
        session, turn_id = await send(ai_chat_env, "SLOW", max_sessions=1)
        await seen(ai_chat_env, "message_chunk", text="working")
        with pytest.raises(sessions.ProviderBusy):
            sessions.MANAGER.reserve(2, 1, ai_chat_env.provider(max_sessions=1))
    assert sessions.MANAGER.get(2) is None and sessions.MANAGER.live_count(1) == 1
    assert sessions.MANAGER.get(1) is session and sessions.MANAGER.running_turn(1) == turn_id


async def test_start_turn_refuses_a_session_evicted_since_reserve(ai_chat_env):
    add_chats(ai_chat_env, 2)
    first = sessions.MANAGER.reserve(1, 1, ai_chat_env.provider(max_sessions=1))
    sessions.MANAGER.reserve(2, 1, ai_chat_env.provider(max_sessions=1))
    with pytest.raises(sessions.ProviderBusy):
        sessions.MANAGER.start_turn(first, "hi", None, None, 1)
    assert sessions.MANAGER.running_turn(1) is None


async def test_reserve_replaces_a_dead_session(ai_chat_env):
    with anyio.fail_after(30):
        session, _ = await send(ai_chat_env, "hi")
        await seen(ai_chat_env, "turn_ended")
        session.proc.kill()
        while not session.dead:
            await asyncio.sleep(0.02)
        user_seq = await asyncio.to_thread(sessions.persist_message, 1, "user", "again", None)
        replacement = sessions.MANAGER.reserve(1, 1, ai_chat_env.provider())
        assert replacement is not session and sessions.MANAGER.live_count(1) == 1
        # In the same tick: the old session's close must not take the new session's turn for its own.
        turn_id = sessions.MANAGER.start_turn(replacement, "again", None, None, user_seq)
        ended = await seen(ai_chat_env, "turn_ended", turn_id=turn_id)
    assert ended["stop_reason"] == "end_turn" and rows(ai_chat_env, "assistant")[-1].text == "echo: again"


# ---- reaper --------------------------------------------------------------------------------------

async def test_reaper_closes_idle(ai_chat_env):
    with anyio.fail_after(30):
        session, _ = await send(ai_chat_env, "hi", idle_minutes=1)
        await seen(ai_chat_env, "turn_ended")
        await sessions.MANAGER.reap_once(now=time.monotonic() + 30)
        assert sessions.MANAGER.get(1) is session  # not idle long enough
        session.last_active -= 1000
        assert sessions.MANAGER.reserve(1, 1, ai_chat_env.provider(idle_minutes=1)) is session
        await sessions.MANAGER.reap_once()
        assert sessions.MANAGER.get(1) is session  # a prompt is on its way
        await sessions.MANAGER.reap_once(now=time.monotonic() + 61)
        assert sessions.MANAGER.get(1) is None and sessions.MANAGER.live_count(1) == 0
    assert session.proc.returncode is not None


async def test_reaper_spares_a_running_turn(ai_chat_env):
    with anyio.fail_after(30):
        session, turn_id = await send(ai_chat_env, "SLOW", idle_minutes=1)
        await seen(ai_chat_env, "message_chunk", text="working")
        await sessions.MANAGER.reap_once(now=time.monotonic() + 10_000)
    assert sessions.MANAGER.get(1) is session and sessions.MANAGER.running_turn(1) == turn_id
    assert session.proc.returncode is None


async def test_reaper_task_runs_until_close_all(ai_chat_env, monkeypatch):
    monkeypatch.setattr(sessions, "REAPER_INTERVAL_S", 0.02)
    with anyio.fail_after(30):
        session, _ = await send(ai_chat_env, "hi", idle_minutes=0)
        await seen(ai_chat_env, "turn_ended")
        sessions.MANAGER.start_reaper()
        sessions.MANAGER.start_reaper()  # one reaper, however often it is asked
        while sessions.MANAGER.get(1) is not None:
            await asyncio.sleep(0.02)
        await session.proc.wait()
        reaper = sessions.MANAGER._reaper
        await sessions.MANAGER.close_all()
    assert reaper.done()


async def test_reaper_survives_a_bad_pass_and_a_bad_close(ai_chat_env, monkeypatch, caplog):
    monkeypatch.setattr(sessions, "REAPER_INTERVAL_S", 0.02)
    real_reap, real_close = sessions.SessionManager.reap_once, sessions.LiveSession.close
    passes, bad_closes = [], []

    async def reap_failing_once(self, now=None):
        passes.append(now)
        if len(passes) == 1:
            raise RuntimeError("private text")
        await real_reap(self, now)

    async def close_failing_once(self):
        await real_close(self)
        if not bad_closes:
            bad_closes.append(self)
            raise OSError("private text")

    monkeypatch.setattr(sessions.SessionManager, "reap_once", reap_failing_once)
    monkeypatch.setattr(sessions.LiveSession, "close", close_failing_once)
    with anyio.fail_after(30):
        session, _ = await send(ai_chat_env, "hi", idle_minutes=0)
        await seen(ai_chat_env, "turn_ended")
        sessions.MANAGER.start_reaper()
        while not bad_closes:
            await asyncio.sleep(0.02)
        after_the_close = len(passes)
        while len(passes) < after_the_close + 2:  # it is still going
            await asyncio.sleep(0.02)
    assert session.proc.returncode is not None and not sessions.MANAGER._reaper.done()
    assert "RuntimeError" in caplog.text and "OSError" in caplog.text and "private text" not in caplog.text


async def test_start_reaper_restarts_a_finished_reaper(ai_chat_env, monkeypatch):
    monkeypatch.setattr(sessions, "REAPER_INTERVAL_S", 0.02)
    with anyio.fail_after(15):
        sessions.MANAGER.start_reaper()
        first = sessions.MANAGER._reaper
        await sessions.MANAGER.close_all()
        assert first.done()
        sessions.MANAGER.start_reaper()
    assert sessions.MANAGER._reaper is not first and not sessions.MANAGER._reaper.done()
