"""ai_chat.sessions: one agent process and ACP connection per chat, restore order, turns, refusal guard (spec 7)."""
import asyncio
import json
import logging
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import anyio
import pytest
from acp.client.router import build_client_router
from acp.connection import Connection
from cryptography.fernet import Fernet
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from ai_chat import sessions, transport
from ai_chat.models import AcpProvider, AiChat, AiChatMessage

pytestmark = pytest.mark.anyio

RECAP_HEAD = "<mk1_earlier_conversation>"


@pytest.fixture
def anyio_backend():
    return "asyncio"  # acp runs on asyncio only


async def closed(s: sessions.LiveSession) -> None:
    await s.close()
    assert s.proc.returncode is not None


def agent_log(state: Path) -> list[str]:
    return Path(f"{state}.log").read_text(encoding="utf-8").splitlines()


def prompts(state: Path) -> list[list[str]]:
    return [json.loads(line[len("prompt "):]) for line in agent_log(state) if line.startswith("prompt ")]


def stored_session_id(env) -> str | None:
    with env.Session() as db:
        return db.get(AiChat, 1).acp_session_id


async def seed_history() -> None:
    await asyncio.to_thread(sessions.persist_message, 1, "user", "earlier question", None)
    await asyncio.to_thread(sessions.persist_message, 1, "assistant", "earlier answer", None)


def write_tools(tmp_path: Path, *lines: str) -> str:
    path = tmp_path / "tools.txt"
    path.write_text("\n".join([f"Available tools ({len(lines)}):", *lines]), encoding="utf-8")
    return str(path)


# ---- turns -----------------------------------------------------------------------------------

async def test_new_chat_streams_and_persists(ai_chat_env):
    s = ai_chat_env.session()
    with anyio.fail_after(30):
        await s.start()
        session_id = await s.attach(None)
        result = await s.run_turn("t1", ["hi"])
        await closed(s)
    assert result == sessions.TurnResult(stop_reason="end_turn", text="echo: hi", tools=[])
    assert [(e["type"], e["chat_id"], e["turn_id"], e["text"]) for e in ai_chat_env.events()] == [
        ("message_chunk", 1, "t1", "echo: "), ("message_chunk", 1, "t1", "hi")]
    assert stored_session_id(ai_chat_env) == session_id == s.acp_session_id
    assert s.pending_recap is None
    with ai_chat_env.Session() as db:
        provider = db.get(AcpProvider, 1)
        assert provider.last_agent_info == {"name": "fake-acp-agent", "version": "1.0"}
        assert provider.last_capabilities["loadSession"] is True


async def test_restore_prefers_load_and_drops_replay(ai_chat_env, tmp_path):
    state = tmp_path / "state.json"
    ai_chat_env.flags = ["--state", str(state)]
    first = ai_chat_env.session()
    with anyio.fail_after(30):
        await first.start()
        old = await first.attach(None)
        await closed(first)
        second = ai_chat_env.session()
        await second.start()
        assert await second.attach(old) == old
        result = await second.run_turn("t2", ["again"])
        await closed(second)
    assert result.text == "echo: again"
    log = agent_log(state)
    assert f"load {old}" in log and not any(line.startswith("resume") for line in log)
    assert [line for line in log if line.startswith("new ")] == [f"new {old}"]  # the second process made none
    texts = [e.get("text", "") for e in ai_chat_env.events()]
    assert texts == ["echo: ", "again"]  # the replayed history ("... zq") never reached the hub
    assert second.pending_recap is None


async def test_restore_uses_resume_without_load(ai_chat_env, tmp_path):
    state = tmp_path / "state.json"
    ai_chat_env.flags = ["--state", str(state), "--no-load", "--resume"]
    first = ai_chat_env.session()
    with anyio.fail_after(30):
        await first.start()
        old = await first.attach(None)
        await closed(first)
        second = ai_chat_env.session()
        await second.start()
        assert await second.attach(old) == old
        result = await second.run_turn("t2", ["again"])
        await closed(second)
    assert result.text == "echo: again"
    log = agent_log(state)
    assert f"resume {old}" in log and not any(line.startswith("load") for line in log)
    assert [line for line in log if line.startswith("new ")] == [f"new {old}"]


async def test_restore_falls_back_to_new_session_with_recap(ai_chat_env, tmp_path):
    state = tmp_path / "state.json"
    ai_chat_env.flags = ["--state", str(state), "--no-load"]  # neither load nor resume advertised
    await seed_history()
    s = ai_chat_env.session()
    with anyio.fail_after(30):
        await s.start()
        new = await s.attach("gone-session")
        await closed(s)
    assert new != "gone-session" and stored_session_id(ai_chat_env) == new
    assert agent_log(state)[0] == f"new {new}"
    assert s.pending_recap.startswith(RECAP_HEAD)
    assert "user: earlier question" in s.pending_recap and "assistant: earlier answer" in s.pending_recap


async def test_refusal_guard_new_session_and_one_retry(ai_chat_env, tmp_path):
    state = tmp_path / "state.json"
    ai_chat_env.flags = ["--state", str(state)]
    await seed_history()
    s = ai_chat_env.session()
    with anyio.fail_after(30):
        await s.start()
        assert await s.attach("unknown-session") == "unknown-session"  # an unknown load looks like success (G10)
        result = await s.run_turn("t1", ["hi"])
        await closed(s)
    assert (result.stop_reason, result.text) == ("end_turn", "echo: hi")
    assert s.acp_session_id != "unknown-session" and stored_session_id(ai_chat_env) == s.acp_session_id
    refused, retried = prompts(state)  # exactly one retry
    assert refused == ["hi"]
    assert retried[0].startswith(RECAP_HEAD) and "user: earlier question" in retried[0] and retried[1:] == ["hi"]
    assert [e["text"] for e in ai_chat_env.events()] == ["echo: ", "hi"]


async def test_unknown_update_kind_ignored(ai_chat_env, caplog):
    # A kind no ACP version has, as a newer Hermes could send: acp refuses it before Mk1 sees it, and logs that.
    ai_chat_env.flags = ["--unknown-update"]
    s = ai_chat_env.session()
    with anyio.fail_after(30):
        await s.start()
        await s.attach(None)
        result = await s.run_turn("t1", ["hi"])
        await closed(s)
    assert (result.stop_reason, result.text) == ("end_turn", "echo: hi")
    assert {e["type"] for e in ai_chat_env.events()} == {"message_chunk"}
    assert "SECRET-AGENT-TEXT" not in caplog.text
    [line] = [record for record in caplog.records if record.name == "root"]
    assert line.getMessage() == "ai_chat.acp_unhandled where=notification error=ValidationError"
    assert (line.exc_info, line.exc_text, line.stack_info) == (None, None, None)
    assert "\n" not in caplog.handler.format(line)  # the one operator signal that a Hermes bump changed the wire


async def test_known_update_kind_nothing_shows_is_ignored(ai_chat_env, caplog):
    s = ai_chat_env.session()
    with anyio.fail_after(30):
        await s.start()
        await s.attach(None)
        result = await s.run_turn("t1", ["PLAN"])
        await closed(s)
    assert (result.stop_reason, result.text) == ("end_turn", "echo: PLAN")
    assert {e["type"] for e in ai_chat_env.events()} == {"message_chunk"}
    assert [record for record in caplog.records if record.name == "root"] == []


def acp_record(pathname: str, func: str, name: str = "root") -> logging.LogRecord:
    try:
        raise ValueError("the agent's text")
    except ValueError:
        exc_info = sys.exc_info()
    return logging.LogRecord(name, logging.ERROR, pathname, 1, "Unhandled error while handling request method=%s",
                             ("session/update",), exc_info, func)


def test_acp_log_filter_reduces_only_the_acp_records():
    log_filter = sessions._ACP_LOG_FILTER
    assert logging.getLogger().filters.count(log_filter) == 1
    reduced = acp_record("/venv/site-packages/acp/connection.py", "_run_notification")
    assert log_filter.filter(reduced) is True
    assert reduced.getMessage() == "ai_chat.acp_unhandled where=notification error=ValueError"
    assert (reduced.exc_info, reduced.exc_text, reduced.stack_info) == (None, None, None)
    # `_execute_request` with a string method too stays whole: an unknown kind never reaches its log call (acp answers
    # `ValidationError` first), so what lands there is a bug in Mk1's own request handler, which needs its traceback.
    for other in (acp_record("/app/other/connection.py", "_run_notification"),
                  acp_record("/venv/site-packages/acp/connection.py", "_execute_request"),
                  acp_record("/venv/site-packages/acp/connection.py", "_on_task_error")):
        args = other.args
        assert log_filter.filter(other) is True
        assert (other.args, other.exc_info is not None) == (args, True)  # untouched


class FramesFromTheAgent:
    """acp's transport, holding the frames an agent sent."""

    def __init__(self, *frames: dict) -> None:
        self.frames, self.sent = list(frames), []

    async def send(self, message: dict) -> None:
        self.sent.append(message)

    async def receive(self) -> dict:
        if self.frames:
            return self.frames.pop(0)
        await asyncio.Event().wait()  # until the connection closes

    async def close(self) -> None:
        pass


async def answered(ai_chat_env, method) -> list[dict]:
    """A request with this `method` through acp's real connection and Mk1's real client router."""
    transport = FramesFromTheAgent({"jsonrpc": "2.0", "id": 9, "method": method, "params": {}})
    connection = Connection(build_client_router(ai_chat_env.session()._client), transport)
    with anyio.fail_after(10):
        while not transport.sent:
            await asyncio.sleep(0.01)
    await connection.close()
    return transport.sent


@pytest.mark.parametrize("method", [{"SECRET-AGENT-TEXT": 1}, ["SECRET-AGENT-TEXT"], {}, []])
async def test_a_request_whose_method_is_no_string_leaves_no_wire_text_in_the_log(ai_chat_env, caplog, method):
    [answer] = await answered(ai_chat_env, method)
    assert answer["error"]["code"] == -32603
    [line] = caplog.records
    assert line.getMessage() == "ai_chat.acp_unhandled where=request error=TypeError"
    assert (line.exc_info, line.exc_text, line.stack_info) == (None, None, None)
    assert "SECRET-AGENT-TEXT" not in caplog.text


@pytest.mark.parametrize("method", ["SECRET-AGENT-TEXT", "_SECRET-AGENT-TEXT"])
async def test_a_string_method_nothing_handles_logs_nothing(ai_chat_env, caplog, method):
    await answered(ai_chat_env, method)
    assert caplog.records == []


async def test_thoughts_and_tool_calls_published(ai_chat_env):
    s = ai_chat_env.session(permission_timeout_s=1)
    with anyio.fail_after(30):
        await s.start()
        await s.attach(None)
        result = await s.run_turn("t1", ["PERMIT"])
        await closed(s)
    # Nobody decides, so the request times out and the agent gets `cancelled` (test_ai_chat_manager.py covers cards).
    assert (result.stop_reason, result.text) == ("end_turn", "cancelled")
    assert result.tools == [{"id": "call-1", "title": "Run a command", "kind": "execute", "status": "failed"}]
    cards = ("permission_requested", "permission_resolved")
    assert [{k: v for k, v in e.items() if k not in ("seq", "chat_id")}
            for e in ai_chat_env.events() if e["type"] not in cards] == [
        {"type": "thought_chunk", "turn_id": "t1", "text": "checking"},
        {"type": "tool_call", "turn_id": "t1", "id": "call-1", "title": "Run a command", "kind": "execute",
         "status": "pending"},
        {"type": "tool_call_update", "turn_id": "t1", "id": "call-1", "status": "failed", "title": None},
        {"type": "message_chunk", "turn_id": "t1", "text": "cancelled"},
    ]


# ---- process lifecycle -----------------------------------------------------------------------

async def test_updates_of_another_session_are_dropped(ai_chat_env):
    s = ai_chat_env.session()
    with anyio.fail_after(30):
        await s.start()
        await s.attach(None)
        result = await s.run_turn("t1", ["STALE"])
        await closed(s)
    assert result.text == "echo: STALE"
    assert [e["text"] for e in ai_chat_env.events()] == ["echo: ", "STALE"]


async def test_agent_exit_mid_turn(ai_chat_env):
    ai_chat_env.flags = ["--exit-on-prompt"]
    s = ai_chat_env.session()
    with anyio.fail_after(30):
        await s.start()
        await s.attach(None)
        result = await s.run_turn("t1", ["hi"])
        assert (result.stop_reason, s.dead) == ("agent_exited", True)
        await closed(s)
    assert s.proc.returncode == 3


async def test_unreachable_carries_stderr_tail(ai_chat_env, monkeypatch):
    script = "import sys; sys.stderr.write('Permission denied (publickey).\\n'); sys.exit(255)"
    monkeypatch.setattr(sessions, "spawn_command", lambda provider: [sys.executable, "-c", script])
    s = ai_chat_env.session()
    began = time.monotonic()
    with anyio.fail_after(4):
        with pytest.raises(sessions.AgentUnreachable) as caught:
            await s.start()
        assert "Permission denied (publickey)." in caught.value.stderr_tail
        await closed(s)
        await s.close()  # idempotent
    assert time.monotonic() - began < 4
    assert s.proc.returncode == 255 and s.dead


async def test_start_with_a_raising_spawn_command(ai_chat_env, monkeypatch):
    def refuse(provider):
        raise sessions.AgentUnreachable(["provider key cannot be decrypted; generate a new key"])

    monkeypatch.setattr(sessions, "spawn_command", refuse)
    s = ai_chat_env.session()
    with anyio.fail_after(4):
        with pytest.raises(sessions.AgentUnreachable):
            await s.start()
        await s.close()
    assert s.proc is None and s.dead


async def test_start_with_a_missing_executable(ai_chat_env, monkeypatch, tmp_path):
    monkeypatch.setattr(sessions, "spawn_command", lambda provider: [str(tmp_path / "no-such-agent")])
    s = ai_chat_env.session()
    with anyio.fail_after(4):
        with pytest.raises(FileNotFoundError):
            await s.start()
        await s.close()
    assert s.proc is None and s.dead


async def test_close_racing_a_pending_initialize(ai_chat_env):
    ai_chat_env.flags = ["--no-init"]
    s = ai_chat_env.session()
    with anyio.fail_after(10):
        start = asyncio.create_task(s.start())
        while s.proc is None:
            await asyncio.sleep(0.02)
        await closed(s)
        with pytest.raises(ConnectionError):
            await start
    assert s.dead


async def test_close_never_started_is_a_no_op(ai_chat_env):
    with anyio.fail_after(5):
        await ai_chat_env.session().close()


async def test_caller_cancel_propagates_and_session_lives(ai_chat_env, tmp_path):
    state = tmp_path / "state.json"
    ai_chat_env.flags = ["--state", str(state)]
    s = ai_chat_env.session()
    with anyio.fail_after(30):
        await s.start()
        await s.attach(None)
        turn = asyncio.create_task(s.run_turn("t1", ["SLOW"]))
        while not ai_chat_env.events():  # "working": the agent is inside the prompt
            await asyncio.sleep(0.02)
        turn.cancel()
        with pytest.raises(asyncio.CancelledError):
            await turn
        assert not s.dead
        # Before any second prompt: the agent is told, or its turn and tool keep running (G8).
        with anyio.fail_after(5):
            while "cancel" not in agent_log(state):
                await asyncio.sleep(0.02)
        result = await s.run_turn("t2", ["still here"])
        await closed(s)
    assert result.text == "echo: still here"
    log = agent_log(state)
    assert log.index('prompt ["SLOW"]') < log.index("cancel") < log.index('prompt ["still here"]')


async def test_repeat_cancel_and_close_cannot_lose_the_session_cancel(ai_chat_env, tmp_path, monkeypatch):
    state = tmp_path / "state.json"
    ai_chat_env.flags = ["--state", str(state)]
    s = ai_chat_env.session()
    with anyio.fail_after(30):
        await s.start()
        await s.attach(None)
        send = s._conn.cancel

        async def slow_send(**kwargs):  # holds the send open long enough for the repeat cancel and the close
            await asyncio.sleep(0.3)
            await send(**kwargs)

        monkeypatch.setattr(s._conn, "cancel", slow_send)
        turn = asyncio.create_task(s.run_turn("t1", ["SLOW"]))
        while not ai_chat_env.events():
            await asyncio.sleep(0.02)
        turn.cancel()
        await asyncio.sleep(0.05)  # now inside the wait on the send
        turn.cancel()
        with pytest.raises(asyncio.CancelledError):
            await turn
        await closed(s)
    log = agent_log(state)
    assert log.index("cancel") < log.index("eof")


async def test_owner_cancelling_the_prompt_is_agent_exited(ai_chat_env):
    # On Windows the closed pipe always beats the exit status, so drive the owner's backstop directly: when it
    # sees the process exit it cancels the in-flight prompt, and that is not a caller's cancel.
    s = ai_chat_env.session()
    with anyio.fail_after(30):
        await s.start()
        await s.attach(None)
        turn = asyncio.create_task(s.run_turn("t1", ["SLOW"]))
        while not ai_chat_env.events():
            await asyncio.sleep(0.02)
        s._prompt_task.cancel()
        result = await turn
        assert (result.stop_reason, result.text, s.dead) == ("agent_exited", "working", True)
        await closed(s)


async def test_close_sends_cancel_before_eof(ai_chat_env, tmp_path):
    state = tmp_path / "state.json"
    ai_chat_env.flags = ["--state", str(state)]
    s = ai_chat_env.session()
    with anyio.fail_after(30):
        await s.start()
        await s.attach(None)
        turn = asyncio.create_task(s.run_turn("t1", ["SLOW"]))
        while not ai_chat_env.events():
            await asyncio.sleep(0.02)
        await closed(s)
        result = await turn  # ends once the connection closes, never hangs
    # Closing races the agent's `cancelled` answer against the connection closing under the prompt.
    assert result.stop_reason in ("cancelled", "agent_exited")
    log = agent_log(state)
    assert log.index("cancel") < log.index("eof")


async def test_close_during_turn_is_not_a_raw_connection_error(ai_chat_env, monkeypatch):
    # The agent outlives EOF. acp rejects the prompt before the transport starts its own wait on the process, so
    # a wait in the turn would run out first and hand the caller the closed pipe.
    monkeypatch.setattr(sessions, "_GRACE_S", 0.1)
    monkeypatch.setitem(sessions._TRANSPORT, "shutdown_timeout", 0.3)
    ai_chat_env.flags = ["--linger", "1"]
    s = ai_chat_env.session()
    with anyio.fail_after(30):
        await s.start()
        await s.attach(None)
        turn = asyncio.create_task(s.run_turn("t1", ["SLOW"]))
        while not ai_chat_env.events():
            await asyncio.sleep(0.02)
        await closed(s)
        result = await turn
    assert result.stop_reason in ("cancelled", "agent_exited")


async def test_agent_dying_after_a_refusal_is_agent_exited(ai_chat_env):
    ai_chat_env.flags = ["--exit-on-new"]
    s = ai_chat_env.session()
    with anyio.fail_after(30):
        await s.start()
        await s.attach("unknown-session")  # an unknown load looks like success (G10)
        result = await s.run_turn("t1", ["hi"])
        assert (result.stop_reason, s.dead) == ("agent_exited", True)
        await closed(s)
    assert s.proc.returncode == 3


async def test_agent_dying_after_a_tools_refusal_is_unreachable(ai_chat_env):
    ai_chat_env.flags = ["--exit-on-new"]
    s = ai_chat_env.session(allowed_roles=("admin", "standard"))
    with anyio.fail_after(30):
        await s.start()
        with pytest.raises(sessions.AgentUnreachable):
            await s.attach("unknown-session")
        await closed(s)
    assert s.dead and s.proc.returncode == 3


# ---- tool-list check (standard roles) --------------------------------------------------------

async def test_standard_provider_tools_check_refuses(ai_chat_env, tmp_path):
    ai_chat_env.flags = ["--tools-reply", write_tools(tmp_path, "  terminal: Run shell commands",
                                                       "  todo_list: Track tasks")]
    s = ai_chat_env.session(allowed_roles=("standard",))
    with anyio.fail_after(30):
        await s.start()
        with pytest.raises(sessions.ToolsCheckFailed) as caught:
            await s.attach(None)
        await closed(s)
    assert "terminal" in caught.value.reason
    assert ai_chat_env.events() == []  # the probe publishes nothing


async def test_tools_probe_refusal_renews_session_then_judges(ai_chat_env, tmp_path):
    state = tmp_path / "state.json"
    ai_chat_env.flags = ["--state", str(state), "--tools-reply", write_tools(tmp_path, "  todo_list: Track tasks")]
    await seed_history()
    s = ai_chat_env.session(allowed_roles=("admin", "standard"))
    with anyio.fail_after(30):
        await s.start()
        new = await s.attach("unknown-session")
        await closed(s)
    assert new != "unknown-session" and stored_session_id(ai_chat_env) == new
    assert prompts(state) == [["/tools"], ["/tools"]]  # the recap waits for the user's turn
    assert s.pending_recap.startswith(RECAP_HEAD)
    assert ai_chat_env.events() == []


# ---- default spawn command -------------------------------------------------------------------

def provider_snapshot(Session) -> sessions.ProviderSnapshot:
    with Session() as db:
        return sessions.ProviderSnapshot.from_row(db.get(AcpProvider, 1))


def test_spawn_command_builds_ssh_argv_without_the_key(ai_chat_db, tmp_path, monkeypatch):
    monkeypatch.setattr(transport, "KEYFILES", transport.KeyFiles(root=str(tmp_path)))
    snapshot = provider_snapshot(ai_chat_db)
    argv = sessions.spawn_command(snapshot)
    keyfile = argv[argv.index("-i") + 1]
    assert argv[0] == "ssh" and argv[-1] == "hermes-tars@192.0.2.10"
    assert Path(keyfile).read_bytes() == transport.decrypt_private(snapshot.private_key_ciphertext)
    assert not any("PRIVATE KEY" in a or a == snapshot.private_key_ciphertext for a in argv)
    assert snapshot.private_key_ciphertext not in repr(snapshot)


def test_spawn_command_undecryptable_key_is_unreachable(ai_chat_db, tmp_path, monkeypatch):
    monkeypatch.setattr(transport, "KEYFILES", transport.KeyFiles(root=str(tmp_path)))
    snapshot = provider_snapshot(ai_chat_db)
    monkeypatch.setenv("INTEGRATION_KEYS_SECRET", Fernet.generate_key().decode())  # rotated secret
    with pytest.raises(sessions.AgentUnreachable) as caught:
        sessions.spawn_command(snapshot)
    assert caught.value.stderr_tail == ["provider key cannot be decrypted; generate a new key"]


# ---- DB helpers ------------------------------------------------------------------------------

async def test_persist_message_numbers_seq_per_chat(ai_chat_env):
    first = await asyncio.to_thread(sessions.persist_message, 1, "user", "a", {"k": 1})
    second = await asyncio.to_thread(sessions.persist_message, 1, "assistant", "b", None)
    assert (first, second) == (1, 2)
    with ai_chat_env.Session() as db:
        row = db.query(AiChatMessage).filter_by(chat_id=1, seq=1).one()
        assert (row.role, row.text, row.meta) == ("user", "a", {"k": 1})


def test_persist_message_concurrent_writers_get_contiguous_seqs(ai_chat_db, monkeypatch):
    monkeypatch.setattr(sessions, "_session_factory", ai_chat_db)
    writers = 5  # at most `_SEQ_ATTEMPTS`: a writer loses at most once to each other writer, so all of them land
    rounds = 5
    barrier = threading.Barrier(writers, timeout=30)

    def write(_):
        barrier.wait()
        return sessions.persist_message(1, "permission", "x", None)

    with ThreadPoolExecutor(writers) as pool:
        seqs = [seq for _ in range(rounds) for seq in list(pool.map(write, range(writers)))]
    assert sorted(seqs) == list(range(1, rounds * writers + 1))
    with ai_chat_db() as db:
        assert sorted(db.scalars(select(AiChatMessage.seq).where(AiChatMessage.chat_id == 1))) == sorted(seqs)


def test_persist_message_retries_are_bounded(ai_chat_db, monkeypatch):
    monkeypatch.setattr(sessions, "_session_factory", ai_chat_db)
    with pytest.raises(IntegrityError):
        sessions.persist_message(1, None, "x", None)  # NOT NULL fails every attempt


async def test_update_message_meta_merges(ai_chat_env):
    seq = await asyncio.to_thread(sessions.persist_message, 1, "permission", "Run", {"decision": None, "a": 1})
    await asyncio.to_thread(sessions.update_message_meta, 1, seq, {"decision": "allow"})
    with ai_chat_env.Session() as db:
        assert db.query(AiChatMessage).filter_by(chat_id=1, seq=seq).one().meta == {"decision": "allow", "a": 1}


async def test_set_chat_session(ai_chat_env):
    await asyncio.to_thread(sessions.set_chat_session, 1, "s-1")
    assert stored_session_id(ai_chat_env) == "s-1"


async def test_recap_messages_oldest_first_user_and_assistant_only(ai_chat_env):
    for role, text in [("user", "q1"), ("assistant", "a1"), ("permission", "Run"), ("user", "q2")]:
        await asyncio.to_thread(sessions.persist_message, 1, role, text, None)
    assert await asyncio.to_thread(sessions.recap_messages, 1) == [("user", "q1"), ("assistant", "a1"), ("user", "q2")]
    assert await asyncio.to_thread(sessions.recap_messages, 1, 2) == [("assistant", "a1"), ("user", "q2")]


async def test_record_connect_keeps_updated_at(ai_chat_env):
    with ai_chat_env.Session() as db:
        before = db.get(AcpProvider, 1).updated_at
    await asyncio.to_thread(sessions.record_connect, 1, {"name": "x", "version": "2"}, {"loadSession": False})
    with ai_chat_env.Session() as db:
        p = db.get(AcpProvider, 1)
        assert (p.last_agent_info, p.last_capabilities, p.updated_at) == (
            {"name": "x", "version": "2"}, {"loadSession": False}, before)
