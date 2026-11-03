"""ai_chat.sessions: one agent process and ACP connection per active chat (spec 7).

A `LiveSession` spawns the provider's `ssh` command (the bot host's forced command runs the agent over stdio),
speaks ACP over that pipe as the client, restores or opens the chat's agent session, and streams each turn to
the user's event hub.

Owner task: `start()` creates one task, the only code that enters and leaves `acp.spawn_agent_process`. Every
other caller (routes, the reaper) sets flags, sends notifications or awaits futures. The owner drains stderr into
`stderr_tail`, races `initialize` against process exit, then waits for either `close()` (the stop event) or the
process exiting on its own, in which case it marks the session `dead` and cancels the running prompt so
`run_turn` reports `agent_exited`. Leaving the context manager closes stdin, waits 5 s, then terminates.

Nothing here logs message text, stderr, key material or exception messages; log lines carry ids and exception
type names only. No DB session is held across an await on the agent: DB helpers are sync and run in
`asyncio.to_thread`.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field, fields

import acp
from acp.schema import (
    AgentCapabilities,
    AgentMessageChunk,
    AgentThoughtChunk,
    ClientCapabilities,
    DeniedOutcome,
    FileSystemCapabilities,
    Implementation,
    RequestPermissionResponse,
    TextContentBlock,
    ToolCallProgress,
    ToolCallStart,
)
from cryptography.fernet import InvalidToken
from pydantic import BaseModel
from sqlalchemy import func, select, update

from ai_chat import context, hub, transport
from ai_chat.models import AcpProvider, AiChat, AiChatMessage
from database import SessionLocal

logger = logging.getLogger(__name__)

_TRANSPORT = {"limit": 16 * 1024 * 1024, "stderr": asyncio.subprocess.PIPE, "shutdown_timeout": 5.0}
_CLIENT_CAPS = ClientCapabilities(fs=FileSystemCapabilities(read_text_file=False, write_text_file=False),
                                  terminal=False)
_INIT_TIMEOUT_S = 30.0
_GRACE_S = 5.0  # bounds every wait on a process or pipe that is going away

_session_factory = SessionLocal  # module attribute so tests can point it at their own database


class AgentUnreachable(Exception):
    """The agent did not come up. `stderr_tail` is shown only in a failed Test connection, never logged."""

    def __init__(self, stderr_tail: list[str]) -> None:
        super().__init__("agent unreachable")
        self.stderr_tail = stderr_tail


class ProviderBusy(Exception):
    """At `max_sessions` with no idle session to evict (HTTP 429)."""


class ToolsCheckFailed(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class ProviderSnapshot:
    """The provider fields a live session needs, read once so no DB session outlives the request."""

    id: int
    slug: str
    display_name: str
    ssh_host: str
    ssh_port: int
    ssh_user: str
    host_key: str | None
    session_cwd: str
    allowed_roles: tuple[str, ...]
    max_sessions: int
    idle_minutes: int
    permission_timeout_s: int
    private_key_ciphertext: str | None = field(repr=False)  # decrypted only inside `spawn_command`

    @classmethod
    def from_row(cls, row: AcpProvider) -> ProviderSnapshot:
        values = {f.name: getattr(row, f.name) for f in fields(cls)}
        return cls(**{**values, "allowed_roles": tuple(row.allowed_roles or ())})


def ssh_command(provider: ProviderSnapshot) -> list[str]:
    """The ssh argv for `provider`. The key goes to a 0600 file in `KEYFILES`, never into argv or the env."""
    try:
        pem = transport.decrypt_private(provider.private_key_ciphertext or "")
    except InvalidToken:
        raise AgentUnreachable(["provider key cannot be decrypted; generate a new key"]) from None
    keyfile, known_hosts = transport.KEYFILES.paths(provider.slug, pem, provider.host_key)
    return transport.build_ssh_argv(host=provider.ssh_host, port=provider.ssh_port, user=provider.ssh_user,
                                    slug=provider.slug, keyfile=keyfile, known_hosts=known_hosts)


spawn_command: Callable[[ProviderSnapshot], list[str]] = ssh_command  # tests swap in the fake agent


# ---- DB helpers (sync; call them through asyncio.to_thread) -----------------------------------

def persist_message(chat_id: int, role: str, text: str, meta: dict | None) -> int:
    """Append a transcript row; returns its seq (max + 1 in the chat)."""
    with _session_factory() as db:
        seq = (db.scalar(select(func.max(AiChatMessage.seq)).where(AiChatMessage.chat_id == chat_id)) or 0) + 1
        db.add(AiChatMessage(chat_id=chat_id, seq=seq, role=role, text=text, meta=meta))
        db.commit()
        return seq


def update_message_meta(chat_id: int, seq: int, patch: dict) -> None:
    """Merge `patch` into the row's meta. The row must exist."""
    with _session_factory() as db:
        row = db.scalars(select(AiChatMessage).where(AiChatMessage.chat_id == chat_id,
                                                     AiChatMessage.seq == seq)).one()
        row.meta = {**(row.meta or {}), **patch}  # a new dict, so the JSON column sees the change
        db.commit()


def set_chat_session(chat_id: int, acp_session_id: str) -> None:
    with _session_factory() as db:
        db.execute(update(AiChat).where(AiChat.id == chat_id).values(acp_session_id=acp_session_id))
        db.commit()


def recap_messages(chat_id: int, limit: int = 20) -> list[tuple[str, str]]:
    """The chat's last `limit` user and assistant messages as `(role, text)`, oldest first."""
    with _session_factory() as db:
        rows = db.execute(select(AiChatMessage.role, AiChatMessage.text)
                          .where(AiChatMessage.chat_id == chat_id, AiChatMessage.role.in_(("user", "assistant")))
                          .order_by(AiChatMessage.seq.desc()).limit(limit)).all()
    return [(role, text) for role, text in reversed(rows)]


def record_connect(provider_id: int, agent_info: dict, capabilities: dict) -> None:
    """What the agent reported at initialize. `updated_at` is kept: it means "last edited by an admin"."""
    with _session_factory() as db:
        db.execute(update(AcpProvider).where(AcpProvider.id == provider_id).values(
            last_agent_info=agent_info, last_capabilities=capabilities, updated_at=AcpProvider.updated_at))
        db.commit()


def _dump(model: BaseModel | None) -> dict:
    return model.model_dump(mode="json", by_alias=True, exclude_none=True) if model is not None else {}


# ---- the ACP client side ----------------------------------------------------------------------

@dataclass
class TurnResult:
    stop_reason: str  # an ACP stop reason, or "agent_exited"
    text: str
    tools: list[dict]


class Mk1Client(acp.Client):
    """Routes one session's updates to the hub, and collects the reply text and tool chips of each prompt."""

    def __init__(self, session: LiveSession) -> None:
        self._s = session
        self.text: list[str] = []
        self.tools: dict[str, dict] = {}

    def reset(self) -> None:
        self.text, self.tools = [], {}

    def _publish(self, type: str, **fields) -> None:
        hub.HUB.publish(self._s.user_id, type, self._s.chat_id, self._s.turn_id, **fields)

    async def session_update(self, session_id, update, **kwargs) -> None:
        s = self._s
        if s.replaying:  # restored history: Mk1's own transcript is what the panel shows
            return
        if isinstance(update, AgentMessageChunk):
            if isinstance(update.content, TextContentBlock):
                self.text.append(update.content.text)
                if not s.consuming:
                    self._publish("message_chunk", text=update.content.text)
        elif s.consuming:  # the `/tools` probe publishes nothing at all
            return
        elif isinstance(update, AgentThoughtChunk):
            if isinstance(update.content, TextContentBlock):
                self._publish("thought_chunk", text=update.content.text)
        elif isinstance(update, ToolCallStart):
            chip = self.tools[update.tool_call_id] = {
                "id": update.tool_call_id, "title": update.title, "kind": update.kind, "status": update.status}
            self._publish("tool_call", **chip)
        elif isinstance(update, ToolCallProgress):
            chip = self.tools.setdefault(update.tool_call_id,
                                         {"id": update.tool_call_id, "title": None, "kind": None, "status": None})
            chip.update({k: v for k, v in (("title", update.title), ("kind", update.kind),
                                           ("status", update.status)) if v is not None})
            self._publish("tool_call_update", id=update.tool_call_id, status=update.status, title=update.title)
        # Every other update kind (plans, commands, modes, usage) is ignored.

    async def request_permission(self, session_id, tool_call, options, **kwargs) -> RequestPermissionResponse:
        """Task 7 wires approvals. Until then every request is answered `cancelled`, which the agent takes as a deny."""
        return RequestPermissionResponse(outcome=DeniedOutcome(outcome="cancelled"))


# ---- the live session -------------------------------------------------------------------------

class LiveSession:
    """One agent process and ACP connection for one chat. `chat_id` None is a throwaway session (Test
    connection): nothing is stored on a chat."""

    def __init__(self, chat_id: int | None, user_id: int, provider: ProviderSnapshot) -> None:
        self.chat_id = chat_id
        self.user_id = user_id
        self.provider = provider
        self.acp_session_id: str | None = None
        self.capabilities: AgentCapabilities | None = None
        self.agent_info: Implementation | None = None
        self.last_active = time.monotonic()
        self.turn_id: str | None = None
        self.replaying = False
        self.consuming = False
        self.pending_recap: str | None = None  # set when the agent lost the chat; the next turn sends it first
        self.stderr_tail: deque[str] = deque(maxlen=50)
        self.dead = False
        self.proc: asyncio.subprocess.Process | None = None
        self._client = Mk1Client(self)
        self._conn = None
        self._owner: asyncio.Task | None = None
        self._ready: asyncio.Future | None = None
        self._stop = asyncio.Event()
        self._prompt_task: asyncio.Future | None = None

    # -- lifecycle ------------------------------------------------------------------------------

    async def start(self) -> None:
        """Spawn and initialize. Raises `AgentUnreachable` (carrying the stderr tail) or the spawn error."""
        self._ready = asyncio.get_running_loop().create_future()
        self._owner = asyncio.create_task(self._own(), name=f"ai_chat.session.{self.chat_id}")
        await self._ready

    async def cancel(self) -> None:
        """session/cancel for a running prompt; the agent then ends it with `cancelled`."""
        if self._prompt_task is None or self.dead:
            return
        # Bounded: acp's sender never answers once its writer task died on a broken pipe.
        with contextlib.suppress(ConnectionError, TimeoutError):
            await asyncio.wait_for(self._conn.cancel(session_id=self.acp_session_id), _GRACE_S)

    async def close(self) -> None:
        """Idempotent; safe on a session that failed to start. Cancel before EOF (spec 7), then let the owner
        leave the context manager."""
        if self._owner is None:
            return
        await self.cancel()
        self._stop.set()
        await asyncio.wait({self._owner})

    async def _own(self) -> None:
        failure: Exception | None = None
        drain: asyncio.Task | None = None
        try:
            async with acp.spawn_agent_process(self._client, *spawn_command(self.provider), cwd=None,
                                               transport_kwargs=_TRANSPORT) as (conn, proc):
                self._conn, self.proc = conn, proc
                drain = asyncio.create_task(self._drain(proc.stderr))
                try:
                    await self._serve(conn, proc, drain)
                except Exception as exc:  # kept apart: leaving the context manager can raise its own error
                    failure = exc
        except Exception as exc:
            failure = failure or exc
        finally:
            self.dead = True
            if drain is not None:
                await asyncio.wait({drain}, timeout=_GRACE_S)
                drain.cancel()
            if not self._ready.done():
                self._ready.set_exception(failure or AgentUnreachable(list(self.stderr_tail)))
            elif failure is not None:
                logger.warning("ai_chat.session_failed chat=%s error=%s", self.chat_id, type(failure).__name__)

    async def _serve(self, conn, proc, drain: asyncio.Task) -> None:
        exited = asyncio.ensure_future(proc.wait())
        stopping = asyncio.ensure_future(self._stop.wait())
        try:
            await self._initialize(conn, exited, stopping, drain)
            if not self._ready.done():  # start() may have been cancelled meanwhile
                self._ready.set_result(None)
            await asyncio.wait({exited, stopping}, return_when=asyncio.FIRST_COMPLETED)
            if exited.done():
                logger.warning("ai_chat.agent_exited chat=%s returncode=%s", self.chat_id, proc.returncode)
                self.dead = True
                if self._prompt_task is not None:
                    self._prompt_task.cancel()
        finally:
            exited.cancel()
            stopping.cancel()

    async def _initialize(self, conn, exited: asyncio.Future, stopping: asyncio.Future, drain: asyncio.Task) -> None:
        info = Implementation(name="accu-mk1", version=os.environ.get("APP_VERSION", "0.0.0"))
        init = asyncio.ensure_future(asyncio.wait_for(
            conn.initialize(protocol_version=1, client_capabilities=_CLIENT_CAPS, client_info=info), _INIT_TIMEOUT_S))
        await asyncio.wait({init, exited, stopping}, return_when=asyncio.FIRST_COMPLETED)
        init.cancel()  # no-op when it finished
        response, cause = None, None
        try:
            response = await init
        except asyncio.CancelledError:
            if asyncio.current_task().cancelling():
                raise
        except Exception as exc:  # the pipe closed, the 30 s ran out, or the agent answered an error
            cause = exc
        if response is None:
            if stopping.done():
                raise ConnectionError("session closed while starting")
            await asyncio.wait({drain}, timeout=1.0)  # let the last stderr lines in
            raise AgentUnreachable(list(self.stderr_tail)) from cause
        self.agent_info = response.agent_info
        self.capabilities = response.agent_capabilities or AgentCapabilities()
        await asyncio.to_thread(record_connect, self.provider.id, _dump(self.agent_info), _dump(self.capabilities))

    async def _drain(self, stream: asyncio.StreamReader) -> None:
        """stderr into the ring buffer only (never logged), read to EOF so ssh never blocks on a full pipe."""
        while True:
            try:
                line = await stream.readline()
            except ValueError:  # an over-long line was discarded; keep reading
                continue
            if not line:
                return
            self.stderr_tail.append(line.decode(errors="replace").strip())

    # -- sessions and turns -----------------------------------------------------------------------

    async def attach(self, acp_session_id: str | None) -> str:
        """Restore the chat's agent session (session/load, else session/resume) or open a new one; returns the
        id in use. A restore that looks fine proves nothing (G10): the refusal guard in `run_turn` is the check.
        For a provider standard users may use, the agent's tool list is checked too (`ToolsCheckFailed`)."""
        caps = self.capabilities
        can_resume = caps.session_capabilities is not None and caps.session_capabilities.resume is not None
        restored = False
        if acp_session_id is not None and (caps.load_session or can_resume):
            # Clearing the flag right after the call is safe: acp handles messages in arrival order, and a
            # replayed update's handler runs to completion before the response wakes this coroutine.
            self.replaying = True
            try:
                if caps.load_session:
                    await self._conn.load_session(cwd=self.provider.session_cwd, session_id=acp_session_id,
                                                  mcp_servers=[])
                else:
                    await self._conn.resume_session(cwd=self.provider.session_cwd, session_id=acp_session_id,
                                                    mcp_servers=[])
                restored = True
            except Exception as exc:
                logger.info("ai_chat.restore_failed chat=%s error=%s", self.chat_id, type(exc).__name__)
            finally:
                self.replaying = False
        if restored:
            self.acp_session_id = acp_session_id
        else:
            self.pending_recap = await self._new_session(recap=acp_session_id is not None)
        if "standard" in self.provider.allowed_roles:
            reason = context.check_tools(await self.list_tools(), list(self.provider.allowed_roles))
            if reason is not None:
                raise ToolsCheckFailed(reason)
        return self.acp_session_id

    async def list_tools(self) -> list[str] | None:
        """The agent's `/tools` reply, parsed (None when unreadable). Nothing is published while it runs."""
        self.consuming = True
        try:
            result = await self._prompt(["/tools"])
            if result.stop_reason == "refusal" and not result.text:
                # The agent lost the session: renew it and probe again. The recap waits for the user's turn,
                # since a recap block in front of `/tools` would stop it being a command.
                self.pending_recap = await self._new_session(recap=True)
                result = await self._prompt(["/tools"])
        finally:
            self.consuming = False
        if result.stop_reason == "agent_exited":
            raise AgentUnreachable(list(self.stderr_tail))
        return context.parse_tools_reply(result.text)

    async def run_turn(self, turn_id: str, blocks: list[str]) -> TurnResult:
        """Prompt with `blocks` (one text block each, in order), streaming to the hub under `turn_id`."""
        self.turn_id = turn_id
        try:
            result = await self._prompt(blocks)
            if result.stop_reason == "refusal" and not result.text:
                # Refusal guard (G10): the agent does not know this session. Open a new one seeded with the
                # chat's recap, and retry once.
                recap = await self._new_session(recap=True)
                result = await self._prompt([recap, *blocks] if recap else blocks)
            return result
        finally:
            self.last_active = time.monotonic()

    async def _new_session(self, recap: bool) -> str | None:
        """session/new, stored on the chat. Returns the chat's recap block when `recap` (None if empty)."""
        response = await self._conn.new_session(cwd=self.provider.session_cwd, mcp_servers=[])
        self.acp_session_id = response.session_id
        if self.chat_id is None:
            return None
        await asyncio.to_thread(set_chat_session, self.chat_id, response.session_id)
        if not recap:
            return None
        return context.render_recap(await asyncio.to_thread(recap_messages, self.chat_id))

    async def _prompt(self, blocks: list[str]) -> TurnResult:
        """One session/prompt. `agent_exited` when the process died under it; a caller's cancel propagates."""
        self._client.reset()
        self._prompt_task = asyncio.ensure_future(self._conn.prompt(
            session_id=self.acp_session_id, prompt=[acp.text_block(b) for b in blocks]))
        try:
            stop_reason = (await self._prompt_task).stop_reason
        except asyncio.CancelledError:
            if asyncio.current_task().cancelling():
                raise  # the caller (Stop or close) cancelled the turn
            stop_reason = "agent_exited"  # the owner cancelled the prompt: the process died
        except Exception as exc:
            if not await self._agent_gone(exc):
                raise
            stop_reason = "agent_exited"
        finally:
            self._prompt_task = None
        if stop_reason == "agent_exited":
            self.dead = True
        return TurnResult(stop_reason, "".join(self._client.text), list(self._client.tools.values()))

    async def _agent_gone(self, exc: Exception) -> bool:
        """Did the process go away under this request? acp reports a closed pipe as ConnectionError, which
        can arrive before the exit status, so wait (bounded) for the process in that case."""
        if isinstance(exc, ConnectionError) and not self.dead and self.proc.returncode is None:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self.proc.wait(), _GRACE_S)
        return self.dead or self.proc.returncode is not None
