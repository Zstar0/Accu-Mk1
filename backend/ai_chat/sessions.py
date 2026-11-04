"""ai_chat.sessions: one agent process and ACP connection per active chat (spec 7).

A `LiveSession` spawns the provider's `ssh` command (the bot host's forced command runs the agent over stdio),
speaks ACP over that pipe as the client, restores or opens the chat's agent session, and streams each turn to
the user's event hub.

Owner task: `start()` creates one task, the only code that enters and leaves `acp.spawn_agent_process`. Every
other caller (routes, the reaper) sets flags, sends notifications or awaits futures. The owner drains stderr into
`stderr_tail`, races `initialize` against process exit, then waits for either `close()` (the stop event) or the
process exiting on its own, in which case it marks the session `dead` and cancels the running prompt so
`run_turn` reports `agent_exited`. Leaving the context manager closes stdin, waits 5 s, then terminates.

`SessionManager` owns the live sessions and one background task per turn. It keeps every provider under its
session cap, closes idle sessions, and ends each turn exactly one way: `turn_ended` is the last thing a turn
publishes, after every approval the turn left open has been resolved, so a browser that refetches at `turn_ended`
sees the final rows and may prompt again at once. Stop and close always tell the agent first (`session/cancel`),
then resolve approvals, then wait for the turn; hard-cancelling the turn task is only the bounded fallback.

Nothing here logs message text, stderr, key material, tool arguments or exception messages; log lines carry ids and
exception type names only. No DB session is held across an await on the agent: DB helpers are sync and run in
`asyncio.to_thread`.
"""
from __future__ import annotations

import asyncio
import contextlib
import difflib
import json
import logging
import os
import re
import secrets
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field, fields
from datetime import datetime, timezone
from typing import Any

import acp
from acp.connection import StreamDirection, StreamEvent
from acp.schema import (
    AgentCapabilities,
    AgentMessageChunk,
    AgentThoughtChunk,
    ClientCapabilities,
    ContentToolCallContent,
    FileEditToolCallContent,
    FileSystemCapabilities,
    Implementation,
    RequestPermissionResponse,
    TextContentBlock,
    ToolCallProgress,
    ToolCallStart,
    ToolCallUpdate,
)
from cryptography.fernet import InvalidToken
from pydantic import BaseModel
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError

from ai_chat import approvals, context, hub, transport
from ai_chat.models import AcpProvider, AiChat, AiChatMessage
from database import SessionLocal
from integration_keys import store

logger = logging.getLogger(__name__)


class _AcpLogFilter(logging.Filter):
    """acp logs a handler's exception through the root logger, whole. When a newer agent sends an update kind acp does
    not know, that exception is pydantic's, and its text quotes the agent's (spec 8: no content in logs). This cuts
    exactly those records to one line, which stays: it is the only sign that an agent update changed the wire. A request
    record keeps its traceback, a bug in Mk1's own handler, unless its `method` is no string: then the record's argument
    is whatever the agent sent, which acp's routes cannot hash."""

    def filter(self, record: logging.LogRecord) -> bool:
        if (os.path.basename(record.pathname) == "connection.py"
                and os.path.basename(os.path.dirname(record.pathname)) == "acp"):
            # LogRecord unwraps a lone non-empty dict argument, so `args` is then the method itself.
            method = record.args[0] if isinstance(record.args, tuple) and record.args else record.args
            where = {"_run_notification": "notification",
                     "_execute_request": None if isinstance(method, str) else "request"}.get(record.funcName)
            if where is not None:
                error = record.exc_info[0] if record.exc_info else None
                # Not the record's own `method`: it came off the wire.
                record.msg = "ai_chat.acp_unhandled where=%s error=%s"
                record.args = (where, error.__name__ if error else "unknown")
                record.exc_info = record.exc_text = record.stack_info = None
        return True


_ACP_LOG_FILTER = _AcpLogFilter()
logging.getLogger().addFilter(_ACP_LOG_FILTER)  # on the logger: acp calls `logging.exception`, handlers come after

_TRANSPORT = {"limit": 16 * 1024 * 1024, "stderr": asyncio.subprocess.PIPE, "shutdown_timeout": 5.0}
_CLIENT_CAPS = ClientCapabilities(fs=FileSystemCapabilities(read_text_file=False, write_text_file=False),
                                  terminal=False)
_INIT_TIMEOUT_S = 30.0
_GRACE_S = 5.0  # bounds every wait on a process or pipe that is going away
_DETAIL_MAX = 20000  # characters of a title or of tool detail on an approval card; a card cut to this has no Allow
# ponytail: difflib is not linear and runs on the loop thread, so one approval request diffs at most 200000 characters
# and 10000 lines, across all its blocks. Inside both, the worst input found holds the loop about 3.4 s per request. A
# worker thread, with a Stop re-check after it, if that bites.
_DIFF_MAX = 200000  # old and new together
_DIFF_MAX_LINES = 10000  # the longer side of each block
_UNSTORABLE = re.compile("[\x00\ud800-\udfff]")
REAPER_INTERVAL_S = 60
# ponytail: a writer loses at most once to each other writer, so 5 attempts guarantee 5 simultaneous writers on one
# chat. More usually land too, without the guarantee; raise this if a chat ever sees more.
_SEQ_ATTEMPTS = 5

_session_factory = SessionLocal  # module attribute so tests can point it at their own database


class AgentUnreachable(Exception):
    """The agent did not come up. `stderr_tail` is shown only in a failed Test connection, never logged."""

    def __init__(self, stderr_tail: list[str]) -> None:
        super().__init__("agent unreachable")
        self.stderr_tail = stderr_tail


class ProviderBusy(Exception):
    """At `max_sessions` with no idle session to evict (HTTP 429)."""


class TurnRunning(Exception):
    """A prompt while the chat's previous turn task has not finished (HTTP 409)."""


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
    """Append a transcript row; returns its seq (max + 1 in the chat).

    Writers race on the max: acp runs each incoming request in its own task, and routes write too. The loser hits
    the unique (chat_id, seq), and retries with a fresh max.

    `meta` goes through `storable_json`, here for every caller: what an agent sends reaches it in a tool chip's title.
    """
    if meta is not None:
        meta = storable_json(meta)
    attempt = 0
    while True:
        attempt += 1
        try:
            with _session_factory() as db:  # leaving it rolls a failed attempt back
                seq = (db.scalar(select(func.max(AiChatMessage.seq)).where(AiChatMessage.chat_id == chat_id)) or 0) + 1
                db.add(AiChatMessage(chat_id=chat_id, seq=seq, role=role, text=text, meta=meta))
                db.commit()
                return seq
        except IntegrityError:
            if attempt == _SEQ_ATTEMPTS:
                raise


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


def recap_messages(chat_id: int, limit: int = 20, before_seq: int | None = None) -> list[tuple[str, str]]:
    """The chat's last `limit` user and assistant messages as `(role, text)`, oldest first. `before_seq` leaves out
    that row and later ones: the turn's own question is already in its prompt."""
    query = select(AiChatMessage.role, AiChatMessage.text).where(AiChatMessage.chat_id == chat_id,
                                                                 AiChatMessage.role.in_(("user", "assistant")))
    if before_seq is not None:
        query = query.where(AiChatMessage.seq < before_seq)
    with _session_factory() as db:
        rows = db.execute(query.order_by(AiChatMessage.seq.desc()).limit(limit)).all()
    return [(role, text) for role, text in reversed(rows)]


def record_connect(provider_id: int, agent_info: dict, capabilities: dict) -> None:
    """What the agent reported at initialize. `updated_at` is kept: it means "last edited by an admin"."""
    with _session_factory() as db:
        db.execute(update(AcpProvider).where(AcpProvider.id == provider_id).values(
            last_agent_info=storable_json(agent_info), last_capabilities=storable_json(capabilities),
            updated_at=AcpProvider.updated_at))
        db.commit()


def _dump(model: BaseModel | None) -> dict:
    return model.model_dump(mode="json", by_alias=True, exclude_none=True) if model is not None else {}


def storable_text(text: str) -> str:
    """`text` with U+FFFD in place of what no database stores: a NUL (Postgres refuses it) and a lone surrogate (JSON
    can carry one; it has no UTF-8). Agent text goes through this, so one such character costs neither the reply nor
    the approval."""
    return _UNSTORABLE.sub("\ufffd", text)


def storable_json(value):
    """`value` with `storable_text` applied to every string in it, keys too. A lone surrogate stores fine in a json
    column and then fails every read: a response encodes to UTF-8. `ensure_ascii=False` keeps it a raw character in
    the dump, so `storable_text` can swap it. A NUL dumps as the escape `\\u0000` and comes back a NUL: the json column
    holds that and so does a response, so it stays."""
    return json.loads(storable_text(json.dumps(value, ensure_ascii=False)))


# ---- the ACP client side ----------------------------------------------------------------------

@dataclass
class TurnResult:
    stop_reason: str  # an ACP stop reason, or "agent_exited"
    text: str
    tools: list[dict]


def _not_shown(count: int, what: str) -> str:
    return f"{count} {what}{'' if count == 1 else 's'} not shown."


def _capped(text: str) -> tuple[str, bool]:
    """`text`, ending in a line that says how much was cut if it is over `_DETAIL_MAX`, and whether it was."""
    over = len(text) - _DETAIL_MAX
    return (text, False) if over <= 0 else (f"{text[:_DETAIL_MAX]}\n\n{_not_shown(over, 'more character')}", True)


def _is_v4a_patch(item: FileEditToolCallContent, raw_input: Any) -> bool:
    """Hermes's `patch` tool in mode "patch" puts the patch where the new file goes, beside the whole old file: diffed,
    one changed line reads as every line replaced. Equal to the patch in the raw input, it is the text that is applied.
    Any other shape gets the diff: noisy if it is a new one, but nothing is hidden."""
    arguments = raw_input.get("arguments") if isinstance(raw_input, dict) else None
    return (isinstance(arguments, dict) and raw_input.get("tool") == "patch" and arguments.get("mode") == "patch"
            and arguments.get("patch") == item.new_text)


@dataclass
class _DiffBudget:
    """What one approval request has left to diff. Below zero it stays spent: a frame can hold many blocks."""

    chars: int = _DIFF_MAX
    lines: int = _DIFF_MAX_LINES


def _diff_text(item: FileEditToolCallContent, raw_input: Any, budget: _DiffBudget) -> tuple[str, bool]:
    """A diff block as the card shows it, and whether part of it is left out. Hermes sends the whole file on both
    sides, so the new text alone would hide what a write removes. No old text means a new file, all of it new."""
    if item.old_text is None or _is_v4a_patch(item, raw_input):
        return f"{item.path}\n{item.new_text}", False  # no diff to run, so it costs no budget
    total = len(item.old_text) + len(item.new_text)
    too_big = f"{item.path}\n{_not_shown(total, 'more character')}", True
    budget.chars -= total
    if budget.chars < 0 or budget.lines < 0:  # first: this keeps text past the budget from being split at all
        return too_big
    # `keepends`: a change to a line ending alone is a change, and must not diff to nothing.
    old = storable_text(item.old_text).splitlines(keepends=True)
    new = storable_text(item.new_text).splitlines(keepends=True)
    budget.lines -= max(len(old), len(new))
    if budget.lines < 0:
        return too_big
    if item.old_text == item.new_text:
        return f"{item.path}\nNo change.", False
    diff = difflib.unified_diff(old, new, lineterm="")
    lines = [line.rstrip("\r\n") for line in diff][2:]  # the first two name the files, and these have no names
    # None only when they differ in nothing but what `storable_text` replaced, which the card cannot show.
    return f"{item.path}\n" + ("\n".join(lines) or _not_shown(1, "item")), not lines


def _permission_detail(tool_call: ToolCallUpdate) -> tuple[str, bool]:
    """What the card shows under the title, and whether part of what Allow would approve is not in it. Every content
    block: text as its text, a diff as `_diff_text`. Raw input as compact JSON only when the blocks show nothing."""
    shown, unknown, left_out, budget = [], 0, False, _DiffBudget()
    for item in tool_call.content or ():
        if isinstance(item, ContentToolCallContent) and isinstance(item.content, TextContentBlock):
            shown.append(item.content.text)
        elif isinstance(item, FileEditToolCallContent):
            text, cut = _diff_text(item, tool_call.raw_input, budget)
            shown.append(text)
            left_out = left_out or cut
        else:
            unknown += 1
    text = "\n\n".join(shown)
    if not text.strip() and tool_call.raw_input is not None:
        text = json.dumps(tool_call.raw_input, separators=(",", ":"), ensure_ascii=False, default=str)
    detail, cut = _capped(storable_text(text))
    if unknown:
        detail = "\n\n".join(filter(None, (detail, _not_shown(unknown, "item"))))
    return detail, left_out or cut or unknown > 0


def _decision_patch(decision: str, user_id: int) -> dict:
    return {"decision": decision, "decided_by": user_id if decision in ("allow", "deny") else None,
            "decided_at": datetime.now(timezone.utc).isoformat()}


def _log_permission(chat_id: int, source: str, decision: str) -> None:
    logger.info("ai_chat.permission chat=%s source=%s decision=%s", chat_id, source, decision)


@dataclass
class _Card:
    """One approval, from `register` until `_settle`. The writes are futures of their own, so they finish even when
    the coroutine awaiting them is cancelled."""

    approval: approvals.PendingApproval
    row: asyncio.Future  # the insert of the permission row; its result is the seq
    shown: bool = False  # `permission_requested` has gone out
    writing: asyncio.Future | None = None  # the latest write of a decision


class Mk1Client(acp.Client):
    """Routes one session's updates to the hub, collects the reply text and tool chips of each prompt, and carries
    the agent's permission requests to the chat's owner.

    `cards` holds every approval of this session that is not settled yet. `_settle` is the one place an approval
    ends, whoever gets there first: the waiting `request_permission`, or `close_cards` for Stop, close and turn end,
    including after acp cancelled the waiter.
    """

    def __init__(self, session: LiveSession) -> None:
        self._s = session
        self.text: list[str] = []
        self.tools: dict[str, dict] = {}
        self.cards: dict[str, _Card] = {}
        self._settling = asyncio.Lock()

    def reset(self) -> None:
        self.text, self.tools = [], {}

    def _publish(self, type: str, **fields) -> None:
        if self._s.turn_id is not None:  # a straggler after the turn ended has no turn to belong to
            hub.HUB.publish(self._s.user_id, type, self._s.chat_id, self._s.turn_id, **fields)

    async def session_update(self, session_id, update, **kwargs) -> None:
        s = self._s
        # Restored history: Mk1's own transcript is what the panel shows. No await ahead of this check: unlike
        # prompt, load_session has no wait for in-flight updates.
        if s.replaying:
            return
        if s.acp_session_id is not None and session_id != s.acp_session_id:  # a session this chat has left
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
            chip = self.tools.get(update.tool_call_id)
            if chip is None:
                if update.title is None:  # Hermes's status for an approval, on the request's own tool id: no chip
                    return
                chip = self.tools[update.tool_call_id] = {"id": update.tool_call_id, "title": None, "kind": None,
                                                          "status": None}
            chip.update({k: v for k, v in (("title", update.title), ("kind", update.kind),
                                           ("status", update.status)) if v is not None})
            self._publish("tool_call_update", id=update.tool_call_id, status=update.status, title=update.title)
        # Every other update kind (plans, commands, modes, usage) is ignored.

    async def request_permission(self, session_id, tool_call, options, **kwargs) -> RequestPermissionResponse:
        """Ask the chat's owner (spec 8). `cancelled`, which the agent takes as a deny, when nobody can answer: a
        throwaway session, the `/tools` probe, a restore, a session the chat has left, no turn, or after Stop."""
        s = self._s
        if (s.chat_id is None or s.turn_id is None or s.consuming or s.replaying or s.stop_requested
                or session_id != s.acp_session_id):
            if s.chat_id is not None:
                _log_permission(s.chat_id, "agent", "cancelled")
            return approvals.to_response("cancelled", None, None)
        try:
            return await self._ask_owner(tool_call, options)
        except Exception as exc:  # fail closed. acp would log the exception's text, and a DB error's text has the row.
            logger.warning("ai_chat.permission_failed chat=%s error=%s", s.chat_id, type(exc).__name__)
            return approvals.to_response("cancelled", None, None)

    async def _ask_owner(self, tool_call, options) -> RequestPermissionResponse:
        s = self._s
        allow_id, reject_id = approvals.pick_options(options)
        title, title_cut = _capped(storable_text(tool_call.title or ""))
        detail, detail_hidden = _permission_detail(tool_call)
        hidden = title_cut or detail_hidden  # nobody can approve what the card cannot show them
        p = approvals.APPROVALS.register(s.chat_id, s.user_id, s.turn_id, "agent", title, detail,
                                         allow_id is not None and not hidden, hidden=hidden)
        card = self.cards[p.permission_id] = _Card(p, asyncio.ensure_future(asyncio.to_thread(
            persist_message, p.chat_id, "permission", title, {"source": p.source, "title": title, "detail": detail,
                                                              "permission_id": p.permission_id, "decision": None})))
        try:
            await asyncio.wait({card.row})
            # With a failed insert there is no row to show. With a done future the sweep ran during the insert: no
            # card is ever shown, and the row alone records it.
            if card.row.exception() is None and not p.future.done():
                p.row_seq = card.row.result()
                card.shown = True
                hub.HUB.publish(p.user_id, "permission_requested", p.chat_id, p.turn_id, permission_id=p.permission_id,
                                source=p.source, title=title, detail=detail, can_allow=p.can_allow, hidden=p.hidden,
                                agent=s.provider.display_name)
                _log_permission(p.chat_id, p.source, "requested")
                try:
                    await asyncio.wait_for(asyncio.shield(p.future), s.provider.permission_timeout_s)
                except TimeoutError:
                    # No await before this, so a decision after the timeout gets ApprovalNotFound. A decision that
                    # landed just before it wins: `expire` leaves it alone, and the future below holds it.
                    approvals.APPROVALS.expire(p.permission_id)
            decision = await self._settle(card, p.future.result() if p.future.done() else "cancelled")
            return approvals.to_response(decision, allow_id, reject_id)
        finally:
            approvals.APPROVALS.expire(p.permission_id)  # no pending entry outlives this call, cancelled or not

    def _stopped(self) -> bool:
        return self._s.stop_requested or self._s.dead

    async def _settle(self, card: _Card, decision: str) -> str:
        """The one place an approval ends. Row, event and what the agent gets are the same decision, and it is
        `cancelled` once Stop or close has been asked for, or when in doubt. Returns that decision.

        From the last check to the caller's answer reaching acp's send queue there is no await, so no Stop can get
        between them. The lock makes the turn's own sweep wait, so `turn_ended` follows every row and event. A caller
        cancelled during a write leaves the card here for the next sweep, which lets that write land first.
        """
        p = card.approval
        async with self._settling:
            if p.permission_id not in self.cards:  # the sweep got here first, and it records only `cancelled`
                return "cancelled"
            try:
                if card.writing is not None:
                    await asyncio.wait({card.writing})
                decision = "cancelled" if self._stopped() else decision
                await self._write_decision(card, decision)
                if decision != "cancelled" and self._stopped():
                    decision = "cancelled"
                    await self._write_decision(card, decision)
            except Exception as exc:  # the card must not claim what did not happen
                logger.warning("ai_chat.permission_failed chat=%s error=%s", p.chat_id, type(exc).__name__)
                decision = "cancelled"
            del self.cards[p.permission_id]
            if card.shown:
                hub.HUB.publish(p.user_id, "permission_resolved", p.chat_id, p.turn_id,
                                permission_id=p.permission_id, decision=decision)
            _log_permission(p.chat_id, p.source, decision)
            return decision

    async def _write_decision(self, card: _Card, decision: str) -> None:
        p = card.approval
        seq = await asyncio.shield(card.row)
        card.writing = asyncio.ensure_future(asyncio.to_thread(update_message_meta, p.chat_id, seq,
                                                               _decision_patch(decision, p.user_id)))
        await asyncio.shield(card.writing)

    async def close_cards(self) -> None:
        """Stop, close and turn end: every open approval of this session ends as `cancelled`. Everything up to the
        first await runs at once, so a caller that has just cleared `turn_id` leaves no gap. With no cards it does
        nothing at all: `cancel_chat` goes by chat id, and a newer session of the same chat may have its own."""
        cards = list(self.cards.values())
        if cards:
            approvals.APPROVALS.cancel_chat(self._s.chat_id)
            for card in cards:
                await self._settle(card, "cancelled")


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
        self.before_seq: int | None = None  # the running turn's user row: recaps stop short of it
        self.stop_requested = False  # Stop or close asked for this turn to end; no further prompt goes out
        self.closing = False  # the manager has let go of this session
        self.stderr_tail: deque[str] = deque(maxlen=50)
        self.dead = False
        self.proc: asyncio.subprocess.Process | None = None
        self._client = Mk1Client(self)
        self._conn = None
        self._owner: asyncio.Task | None = None
        self._ready: asyncio.Future | None = None
        self._stop = asyncio.Event()
        self._prompt_task: asyncio.Future | None = None
        self._cancel_send: asyncio.Future | None = None  # held so nothing collects or interrupts the send
        self._permission_ids: set = set()  # the agent's approval requests acp has not answered yet

    # -- lifecycle ------------------------------------------------------------------------------

    async def start(self) -> None:
        """Spawn and initialize. Raises `AgentUnreachable` (carrying the stderr tail) or the spawn error."""
        self._ready = asyncio.get_running_loop().create_future()
        self._owner = asyncio.create_task(self._own(), name=f"ai_chat.session.{self.chat_id}")
        await self._ready

    async def cancel(self) -> None:
        """session/cancel for a running prompt; the agent then ends it with `cancelled`. A turn that has not sent
        its prompt yet (still starting, or between refusal and retry) never sends it."""
        self.stop_requested = True  # ahead of the yield: whatever runs during it already sees Stop
        if self._prompt_task is not None:
            # A prompt scheduled in this loop step has not reached acp's send queue yet. Its first step goes ahead of
            # this one, or the agent gets session/cancel first, cancels nothing, and then runs the whole prompt.
            await asyncio.sleep(0)
            await self._send_cancel()

    async def _send_cancel(self) -> None:
        if self.dead:
            return
        # Bounded: acp's sender never answers once its writer task died on a broken pipe.
        try:
            await asyncio.wait_for(self._conn.cancel(session_id=self.acp_session_id), _GRACE_S)
        except Exception as exc:  # what a closed handle raises differs between event loops
            logger.debug("ai_chat.cancel_not_sent chat=%s error=%s", self.chat_id, type(exc).__name__)

    async def close(self) -> None:
        """Idempotent; safe on a session that failed to start. Cancel before EOF (spec 7), then let the owner
        leave the context manager. A caller cancelled during this still stops the process."""
        if self._owner is None:
            return
        try:
            await self.cancel()
            if self._cancel_send is not None:  # a cancelled turn's session/cancel goes out before EOF too
                await asyncio.wait({self._cancel_send})
        finally:
            self._stop.set()
        await asyncio.wait({self._owner})

    async def _own(self) -> None:
        failure: Exception | None = None
        drain: asyncio.Task | None = None
        try:
            async with acp.spawn_agent_process(self._client, *spawn_command(self.provider), cwd=None,
                                               transport_kwargs=_TRANSPORT) as (conn, proc):
                self._conn, self.proc = conn, proc
                # ponytail: acp deep-copies every frame for an observer, so one nested about 500 levels closes the
                # connection (fail-closed, test_a_frame_too_deep_to_copy_ends_the_turn_and_does_not_hang).
                conn._conn.add_observer(self._watch_frame)  # private, but agent-client-protocol is pinned at 0.12.1
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

    def _watch_frame(self, event: StreamEvent) -> None:
        """Sees what `Mk1Client` cannot: acp refuses a `session/request_permission` it cannot parse and logs nothing, so
        a Hermes update adding an option kind would make every approval deny itself with no trace. Reads, and answers
        nothing. It catches its own failures: acp would log them whole, and these frames hold the agent's text."""
        try:
            frame = event.message
            if event.direction is StreamDirection.INCOMING:
                if frame.get("method") == "session/request_permission" and "id" in frame:
                    self._permission_ids.add(frame["id"])
            elif "method" not in frame and frame.get("id") in self._permission_ids:  # Mk1's own requests have a method
                self._permission_ids.remove(frame["id"])
                if "error" in frame:  # only acp's parser can get here: `request_permission` answers every failure
                    logger.warning("ai_chat.approval_refused chat=%s code=%s", self.chat_id, frame["error"].get("code"))
                    # After Stop that is no error, and the probe and a restore publish nothing, with `turn_id` set.
                    if not (self.stop_requested or self.consuming or self.replaying):
                        self._client._publish("error", code="approval_unreadable", message=(
                            f"{self.provider.display_name} asked for an approval this version of Mk1 cannot read, "
                            "so it was refused."))
        except Exception as exc:
            logger.warning("ai_chat.observer_failed chat=%s error=%s", self.chat_id, type(exc).__name__)

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
                try:
                    recap = await self._new_session(recap=True)
                except AgentUnreachable:  # it died after refusing
                    return TurnResult("agent_exited", result.text, result.tools)
                if self.stop_requested:  # the chat now holds the new session: the next prompt carries the recap
                    self.pending_recap = recap
                    return TurnResult("cancelled", result.text, result.tools)
                result = await self._prompt([recap, *blocks] if recap else blocks)
            return result
        finally:
            self.last_active = time.monotonic()

    async def _new_session(self, recap: bool) -> str | None:
        """session/new, stored on the chat. Returns the chat's recap block when `recap` (None if empty). Raises
        `AgentUnreachable` when the process died under the request."""
        try:
            response = await self._conn.new_session(cwd=self.provider.session_cwd, mcp_servers=[])
        except Exception as exc:
            if not await self._agent_gone(exc):
                raise
            self.dead = True
            raise AgentUnreachable(list(self.stderr_tail)) from exc
        self.acp_session_id = response.session_id
        if self.chat_id is None:
            return None
        await asyncio.to_thread(set_chat_session, self.chat_id, response.session_id)
        if not recap:
            return None
        return context.render_recap(await asyncio.to_thread(recap_messages, self.chat_id, before_seq=self.before_seq))

    async def _prompt(self, blocks: list[str]) -> TurnResult:
        """One session/prompt. `agent_exited` when the process died under it; a caller's cancel propagates."""
        self._client.reset()
        self._prompt_task = asyncio.ensure_future(self._conn.prompt(
            session_id=self.acp_session_id, prompt=[acp.text_block(b) for b in blocks]))
        if self.pending_recap in blocks:  # it has gone out
            self.pending_recap = None
        try:
            stop_reason = (await self._prompt_task).stop_reason
        except asyncio.CancelledError:
            if asyncio.current_task().cancelling():
                # The caller cancelled the turn, which also dropped the request inside acp, so only session/cancel
                # stops the agent's turn and its tool (G8). A repeat cancel ends this wait, never the held send.
                self._cancel_send = asyncio.ensure_future(self._send_cancel())
                await asyncio.wait({self._cancel_send})
                raise
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
        can arrive before the exit status, so wait (bounded) for the process in that case. While closing it counts
        as gone at once: acp rejects requests before the transport's own wait starts, so this wait would end first."""
        if self._stop.is_set():
            return True
        if isinstance(exc, ConnectionError) and not self.dead and self.proc.returncode is None:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self.proc.wait(), _GRACE_S)
        return self.dead or self.proc.returncode is not None


# ---- the manager ------------------------------------------------------------------------------

def _failure_event(session: LiveSession, exc: Exception) -> tuple[str, str]:
    """The `error` event's (code, message) for a failed turn. Fixed texts: stderr is shown only in a failed Test
    connection (spec 7), and an exception's own text never reaches a browser or a log."""
    agent = session.provider.display_name
    if isinstance(exc, AgentUnreachable):
        return "agent_unreachable", f"{agent} is unreachable."
    if isinstance(exc, ToolsCheckFailed):
        return "tools_check_failed", exc.reason
    logger.warning("ai_chat.turn_failed chat=%s error=%s", session.chat_id, type(exc).__name__)
    if session.proc is None and isinstance(exc, (store.KeysNotConfigured, ValueError)):  # raised by `spawn_command`
        return "agent_unreachable", f"{agent} is not configured correctly. Ask an admin to run Test connection."
    return "agent_error", f"Something went wrong talking to {agent}."


@dataclass
class _Turn:
    id: str
    session: LiveSession
    task: asyncio.Task


class SessionManager:
    """The live sessions, one per chat, and their turn tasks. `reserve` and `start_turn` are synchronous and must run
    back to back on the loop (a route's body): an await between them lets another chat's `reserve` evict the session.

    A close returns when the sessions it took out of the registry are closed. A session another close took first is
    that close's to finish, so a second concurrent close can return while the first still runs: a return does not
    prove the process is gone.
    """

    def __init__(self) -> None:
        self._sessions: dict[int, LiveSession] = {}  # a closing session is out of here, so `get` and the cap skip it
        self._turns: dict[int, _Turn] = {}  # by chat id: a turn stays here until its cleanup has run
        self._tasks: set[asyncio.Task] = set()  # turns, background closes and the reaper, held against the GC
        self._reaper: asyncio.Task | None = None

    def get(self, chat_id: int) -> LiveSession | None:
        return self._sessions.get(chat_id)

    def running_turn(self, chat_id: int) -> str | None:
        turn = self._turns.get(chat_id)
        return turn.id if turn is not None else None

    def live_count(self, provider_id: int) -> int:
        return sum(s.provider.id == provider_id for s in self._sessions.values())

    def reserve(self, chat_id: int, user_id: int, provider: ProviderSnapshot) -> LiveSession:
        """The chat's session, or a new unstarted one. At the cap the least recently active idle session of the
        provider is closed to make room; with none idle, `ProviderBusy`."""
        session = self._sessions.get(chat_id)
        if session is not None and not session.dead:
            session.last_active = time.monotonic()  # the reaper and the cap leave it alone until the turn starts
            return session
        if session is not None:
            self._retire(session)
        others = [s for s in self._sessions.values() if s.provider.id == provider.id]
        if len(others) >= provider.max_sessions:
            idle = [s for s in others if s.chat_id not in self._turns]
            if not idle:
                raise ProviderBusy(provider.slug)
            self._retire(min(idle, key=lambda s: s.last_active))
        session = self._sessions[chat_id] = LiveSession(chat_id, user_id, provider)
        return session

    def start_turn(self, session: LiveSession, text: str, page_context: dict | None, stored_session_id: str | None,
                   user_seq: int) -> str:
        """Creates the turn task and returns the turn id. `user_seq` is the turn's user row, which the route has
        stored already. Raises `TurnRunning` while the chat's previous turn task has not finished, since its cleanup
        would clear this turn's state, and `ProviderBusy` for a session closed since `reserve`, since nothing would
        ever close the process this turn would start."""
        chat_id = session.chat_id
        if chat_id in self._turns:
            raise TurnRunning(chat_id)
        if session.closing:
            raise ProviderBusy(session.provider.slug)
        turn_id = secrets.token_hex(8)
        session.turn_id, session.before_seq, session.stop_requested = turn_id, user_seq, False
        task = self._spawn(self._run_turn(session, turn_id, text, page_context, stored_session_id))
        self._turns[chat_id] = _Turn(turn_id, session, task)
        return turn_id

    async def cancel(self, chat_id: int) -> bool:
        """Stop. False when no turn runs. Otherwise returns once the turn is over."""
        turn = self._turns.get(chat_id)
        if turn is None:
            return False
        # A wait, not an await: the caller going away must not leave the agent blocked on an open card.
        await asyncio.wait({self._spawn(self._stop_turn(turn))})
        return True

    async def close_chat(self, chat_id: int) -> None:
        await self._close_where(lambda s: s.chat_id == chat_id)

    async def close_provider(self, provider_id: int) -> None:
        await self._close_where(lambda s: s.provider.id == provider_id)

    async def close_all(self) -> None:
        if self._reaper is not None:
            self._reaper.cancel()
        await self._close_where(lambda s: True)
        while self._tasks:  # evictions and turn cleanups still running; a cleanup can start one more close
            await asyncio.wait(self._tasks)

    def start_reaper(self) -> None:
        if self._reaper is None or self._reaper.done():
            self._reaper = self._spawn(self._reap_forever())

    async def reap_once(self, now: float | None = None) -> None:
        """Close the sessions idle past their provider's `idle_minutes` with no turn running."""
        now = time.monotonic() if now is None else now
        await self._close_where(lambda s: (s.chat_id not in self._turns
                                           and now - s.last_active > s.provider.idle_minutes * 60))

    async def _reap_forever(self) -> None:
        while True:
            await asyncio.sleep(REAPER_INTERVAL_S)
            try:
                await self.reap_once()
            except Exception as exc:  # one bad pass must not end the reaper
                logger.warning("ai_chat.reaper_failed error=%s", type(exc).__name__)

    def _spawn(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._task_done)
        return task

    def _task_done(self, task: asyncio.Task) -> None:
        self._tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:  # the type only: the text can hold a row
            logger.warning("ai_chat.background_task_failed error=%s", type(task.exception()).__name__)

    async def _close_where(self, doomed: Callable[[LiveSession], bool]) -> None:
        closes = [self._retire(s) for s in list(self._sessions.values()) if doomed(s)]
        if closes:  # a wait, not an await: the caller going away must not cancel the closes
            await asyncio.wait(closes)

    def _retire(self, session: LiveSession) -> asyncio.Task:
        """Out of the registry now, with no await, so no prompt can slip in; closed by a held background task."""
        del self._sessions[session.chat_id]
        session.closing = session.stop_requested = True
        return self._spawn(self._close_session(session))

    async def _close_session(self, session: LiveSession) -> None:
        turn = self._turns.get(session.chat_id)
        try:
            if turn is not None and turn.session is session:
                await self._stop_turn(turn)
        finally:
            try:
                await session._client.close_cards()
            finally:
                await session.close()

    async def _stop_turn(self, turn: _Turn) -> None:
        """session/cancel, then resolve approvals (the agent may be waiting on one, so this comes before any wait),
        then wait for the agent to end the turn. Hard-cancelling is the bounded fallback: it discards the agent's
        reply, so the turn's cleanup also closes the session, or late chunks could land in the next turn."""
        await turn.session.cancel()
        await turn.session._client.close_cards()
        await asyncio.wait({turn.task}, timeout=_GRACE_S)
        if not turn.task.done():
            logger.warning("ai_chat.turn_hard_cancelled chat=%s", turn.session.chat_id)
            turn.task.cancel()
            await asyncio.wait({turn.task}, timeout=_GRACE_S)

    async def _run_turn(self, session: LiveSession, turn_id: str, text: str, page_context: dict | None,
                        stored_session_id: str | None) -> None:
        """One turn start to end. `turn_ended` goes out exactly once and last, on every path."""
        chat_id, user_id = session.chat_id, session.user_id
        stop_reason, message_seq, finished = "cancelled", None, False  # what a hard cancel leaves
        try:
            hub.HUB.publish(user_id, "turn_started", chat_id, turn_id, starting=session._owner is None,
                            resuming=session.acp_session_id is None and stored_session_id is not None)
            stop_reason, message_seq = await self._converse(session, turn_id, text, page_context, stored_session_id)
            finished = True
        except Exception as exc:
            if session.stop_requested:  # Stop or close ended it, and that is no error
                logger.info("ai_chat.turn_stopped chat=%s error=%s", chat_id, type(exc).__name__)
            else:
                stop_reason = "error"
                code, message = _failure_event(session, exc)
                hub.HUB.publish(user_id, "error", chat_id, turn_id, code=code, message=message)
        finally:
            session.turn_id = None  # no await before the sweep's first step, so nothing can register after it
            try:
                await session._client.close_cards()
            finally:
                del self._turns[chat_id]
                session.last_active = time.monotonic()
                if (session.dead or not finished) and not session.closing:  # no process outlives a failed turn
                    self._retire(session)
                hub.HUB.publish(user_id, "turn_ended", chat_id, turn_id, stop_reason=stop_reason,
                                message_seq=message_seq)

    async def _converse(self, session: LiveSession, turn_id: str, text: str, page_context: dict | None,
                        stored_session_id: str | None) -> tuple[str, int | None]:
        """Start and attach as needed, prompt, store the reply. Returns `turn_ended`'s (stop_reason, message_seq)."""
        if session._owner is None and not session.stop_requested:
            await session.start()
        if session.acp_session_id is None and not session.stop_requested:
            await session.attach(stored_session_id)
        if session.stop_requested:  # no await from here to `_prompt` taking the blocks, so no Stop can slip past this
            return "cancelled", None
        cleaned = context.clean_context(page_context)
        blocks = [context.render_context_block(cleaned)] if cleaned is not None else []
        if session.pending_recap is not None:
            blocks.append(session.pending_recap)  # `_prompt` clears it once it has gone out
        result = await session.run_turn(turn_id, [*blocks, text])
        stop_reason = result.stop_reason
        if stop_reason == "agent_exited" and session.stop_requested:
            stop_reason = "cancelled"  # a close closed the connection under the prompt, ahead of the agent's answer
        message_seq = None
        if result.text or result.tools:
            message_seq = await asyncio.to_thread(persist_message, session.chat_id, "assistant",
                                                  storable_text(result.text),
                                                  {"tools": result.tools, "stop_reason": stop_reason})
        if stop_reason != "agent_exited":
            return stop_reason, message_seq
        hub.HUB.publish(session.user_id, "error", session.chat_id, turn_id, code="agent_exited",
                        message=f"{session.provider.display_name} stopped unexpectedly.")
        return "error", message_seq


# ponytail: single uvicorn worker; sticky routing or a broker if workers > 1
MANAGER = SessionManager()
