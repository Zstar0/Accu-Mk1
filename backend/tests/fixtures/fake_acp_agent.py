"""A fake ACP agent for the ai_chat tests. Run as `[sys.executable, this file, *flags]`; it is never imported.

Flags:
  --no-load           do not advertise session/load (advertised by default)
  --resume            advertise session/resume
  --state FILE        known session ids persist in FILE (a JSON list), so a second process can restore them.
                      Every request is appended to FILE.log, one line each: `new <id>`, `load <id>`,
                      `resume <id>`, `prompt <JSON list of the text blocks>`, `cancel`, and `eof` when stdin closes.
  --exit-on-prompt    exit with status 3 as soon as a prompt arrives
  --exit-on-new       exit with status 3 as soon as session/new arrives
  --no-init           never answer initialize
  --linger SECONDS    stay up this long after stdin closes
  --tools-reply FILE  answer `/tools` with FILE's text instead of T7A
  --unknown-update    ahead of each reply, a session/update of a kind no ACP version has (what a newer Hermes could send)
  --unknown-option    ahead of each reply, a permission request with an option kind no ACP version has; refused, the
                      agent goes on as if denied. Both are raw frames: the typed helpers would validate them here.
  --deep-frame        ahead of each reply, a raw session/update nested deeper than `copy.deepcopy` can reach

Prompts, by their last text block:
  /tools            the tool list
  PERMIT            a thought, a tool call, then a permission request offering allow_once, reject_once and
                    allow_always; replies `allowed`, `denied` or `cancelled` (the outcome it got)
  PERMIT_NOREJECT   the same without reject_once
  PERMIT_NOALLOW    the same without allow_once
  PERMIT_DIFF       PERMIT, the tool call holding a diff block (and a raw input, as Hermes's does)
  PERMIT_BLOCKS     PERMIT, the tool call holding a text block, then a diff block
  PERMIT_TERMINAL   PERMIT, the tool call holding a text block, then a terminal block
  PERMIT_WRITE <n>  PERMIT, the tool call holding a diff block with n characters of new text
  PERMIT_LONG_TITLE PERMIT, the tool call with a 25000 character title
  PERMIT_EDIT_LINE  PERMIT, a whole-file diff block as Hermes builds it: one line changed in a small file
  PERMIT_EDIT_EMPTY the same, emptying the file
  PERMIT_EDIT_BIG   the same, one line changed in a 21000 character file
  PERMIT_EDIT_HUGE  the same, with old and new text over Mk1's 200000 character diff ceiling
  PERMIT_EDIT_LINES the same, one line changed, with old and new text just over Mk1's 10000 line diff bound
  PERMIT_EDIT_PATCH PERMIT, a V4A patch as Hermes builds it: the file as old text and the patch as new text
  PERMIT_EDIT_PATCH_BIG   the same, on a 21000 character file
  PERMIT_EDIT_PATCH_OTHER the same shape, but the raw input's patch is not the new text
  PERMIT_EDIT_REPLACE     PERMIT, Hermes's replace mode: the whole file on both sides, the two strings as raw input
  PERMIT_EMPTY_TEXT PERMIT, the tool call holding an empty text block and a raw input
  PERMIT_BAD_TEXT   PERMIT as a raw frame, with a NUL and a lone surrogate in the title and the raw input
  BAD_TEXT          replies with a NUL and a lone surrogate, as a raw frame
  ABANDON           sends the same permission request, and ends the turn 0.3 s later without waiting for the answer
  SLOW              replies `working`, waits for session/cancel, then stops with `cancelled`
  STUCK             replies `working` and never stops, session/cancel or not
  PLAN              sends an empty plan update, then echoes
  STALE             sends a message chunk for another session id, then echoes
  anything else     `echo: <text>`, in two chunks

Like Hermes (spec 7, G10): a prompt for a session id this agent does not know stops with `refusal` and no text,
session/load of an unknown id answers an empty success, and session/resume answers an empty success for any id.
"""
import argparse
import asyncio
import json
import os
import time
import warnings
from pathlib import Path

import acp
from acp.schema import (
    AgentCapabilities,
    Implementation,
    InitializeResponse,
    LoadSessionResponse,
    NewSessionResponse,
    PermissionOption,
    PromptResponse,
    ResumeSessionResponse,
    SessionCapabilities,
    SessionResumeCapabilities,
    ToolCallUpdate,
)

# acp 0.12.1 under the pinned pydantic: serializing a session update (`conn.session_update`) warns, once per update,
# that it cannot read the union's discriminator and fell back to left-to-right matching. The bytes sent are right.
# That is this process's stderr, which a failed Test connection returns, so tests that compare it must not see it.
warnings.filterwarnings("ignore", message="Pydantic serializer warnings", category=UserWarning)

# Verbatim copy of T7A in test_ai_chat_context.py (the phase0 2026-11-03 `/tools` reply).
T7A = ("Available tools (3):\n  mcp__mk1__create_flag: Raise a flag on a sample. The user must approve it in Mk1 first, which can ta...\n"
       "  mcp__mk1__whoami: Return the Mk1 user this chat acts as.\n"
       "  todo_list: Track a task list for multi-step work (3+ steps). Use for complex tasks with ...")

REPLIES = {"allow-once": "allowed", "reject-once": "denied"}
DIFF_BLOCK = acp.tool_diff_content("/srv/app/run.sh", "new body", old_text="old body")
WHY_BLOCK = acp.tool_content(acp.text_block("why"))


def hermes_edit(path: str, old_text: str, new_text: str, tool: str, /, **arguments) -> dict:
    """What Hermes's `build_acp_edit_tool_call` sends: one diff block, and the tool and its arguments as raw input."""
    return {"title": f"Approve edit: {path}", "kind": "edit",
            "content": [acp.tool_diff_content(path=path, old_text=old_text, new_text=new_text)],
            "raw_input": {"tool": tool, "arguments": arguments}}


def whole_file_edit(path: str, old_text: str, new_text: str) -> dict:
    """`write_file`: the whole file on both sides."""
    return hermes_edit(path, old_text, new_text, "write_file", path=path, content=new_text)


def v4a_edit(path: str, old_text: str, new_text: str, patch: str) -> dict:
    """`patch` in mode "patch" on one file (`_proposal_for_patch_v4a`): the file, then the patch as the new text."""
    return hermes_edit(path, old_text, new_text, "patch", mode="patch", patch=patch)


SMALL_FILE = "one\ntwo\nthree\n"
BIG_FILE = "".join(f"line {i:04d}\n" for i in range(2100))  # 21000 characters
V4A_PATCH = "*** Begin Patch\n*** Update File: /srv/app.conf\n@@\n one\n-two\n+TWO\n three\n*** End Patch"
TOOL_CALL_FIELDS = {
    "PERMIT_DIFF": {"content": [DIFF_BLOCK], "raw_input": {"path": "/srv/app/run.sh", "content": "new body"}},
    "PERMIT_BLOCKS": {"content": [WHY_BLOCK, DIFF_BLOCK]},
    "PERMIT_TERMINAL": {"content": [WHY_BLOCK, acp.tool_terminal_ref("term-1")]},
    "PERMIT_LONG_TITLE": {"title": "t" * 25000},
    "PERMIT_EDIT_LINE": whole_file_edit("/srv/app.conf", SMALL_FILE, SMALL_FILE.replace("two", "TWO")),
    "PERMIT_EDIT_EMPTY": whole_file_edit("/srv/app.conf", SMALL_FILE, ""),
    "PERMIT_EDIT_BIG": whole_file_edit("/srv/big.conf", BIG_FILE, BIG_FILE.replace("line 1000", "line 1000 edited")),
    "PERMIT_EDIT_HUGE": whole_file_edit("/srv/huge.conf", "x" * 100001, "x" * 100002),
    "PERMIT_EDIT_LINES": whole_file_edit("/srv/lines.conf", "x\n" * 10001, "x\n" * 10000 + "y\n"),
    "PERMIT_EDIT_PATCH": v4a_edit("/srv/app.conf", SMALL_FILE, V4A_PATCH, V4A_PATCH),
    "PERMIT_EDIT_PATCH_BIG": v4a_edit("/srv/app.conf", BIG_FILE, V4A_PATCH, V4A_PATCH),
    "PERMIT_EDIT_PATCH_OTHER": v4a_edit("/srv/app.conf", SMALL_FILE, V4A_PATCH, "*** Begin Patch\n*** End Patch"),
    "PERMIT_EDIT_REPLACE": hermes_edit(
        "/srv/app.conf", SMALL_FILE, SMALL_FILE.replace("two", "TWO"), "patch",
        mode="replace", path="/srv/app.conf", old_string="two", new_string="TWO"),
    "PERMIT_EMPTY_TEXT": {"content": [acp.tool_content(acp.text_block(""))], "raw_input": {"command": "rm -rf /srv"}},
}
BAD_TEXT = "a\x00b\ud800c"  # no database stores it: a NUL (Postgres refuses it) and a lone surrogate (no UTF-8)
UNKNOWN_KIND_TEXT = "SECRET-AGENT-TEXT"  # must never reach Mk1's logs


class FakeAgent(acp.Agent):
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.state = Path(args.state) if args.state else None
        self.known = set(json.loads(self.state.read_text())) if self.state and self.state.exists() else set()
        self.tools_reply = Path(args.tools_reply).read_text(encoding="utf-8") if args.tools_reply else T7A
        self.waiting: dict[str, asyncio.Event] = {}
        self.conn = None

    def on_connect(self, conn) -> None:
        self.conn = conn

    def log(self, line: str) -> None:
        if self.state:
            with open(f"{self.state}.log", "a", encoding="utf-8") as f:
                f.write(line + "\n")

    async def say(self, session_id: str, text: str) -> None:
        await self.conn.session_update(session_id, acp.update_agent_message_text(text))

    async def initialize(self, protocol_version, client_capabilities=None, client_info=None, **kwargs):
        if self.args.no_init:
            await asyncio.Event().wait()
        resume = SessionResumeCapabilities() if self.args.resume else None
        caps = AgentCapabilities(load_session=not self.args.no_load,
                                 session_capabilities=SessionCapabilities(resume=resume))
        return InitializeResponse(protocol_version=protocol_version, agent_capabilities=caps,
                                  agent_info=Implementation(name="fake-acp-agent", version="1.0"))

    async def new_session(self, cwd, additional_directories=None, mcp_servers=None, **kwargs):
        if self.args.exit_on_new:
            os._exit(3)
        session_id = os.urandom(8).hex()
        self.known.add(session_id)
        if self.state:
            self.state.write_text(json.dumps(sorted(self.known)))
        self.log(f"new {session_id}")
        return NewSessionResponse(session_id=session_id)

    async def load_session(self, cwd, session_id, mcp_servers=None, additional_directories=None, **kwargs):
        self.log(f"load {session_id}")
        if session_id not in self.known:
            return None
        await self.conn.session_update(session_id, acp.update_user_message_text("replayed question zq"))
        await self.say(session_id, "replayed answer zq")
        return LoadSessionResponse()

    async def resume_session(self, session_id, cwd, additional_directories=None, mcp_servers=None, **kwargs):
        self.log(f"resume {session_id}")
        return ResumeSessionResponse()

    async def cancel(self, session_id, **kwargs) -> None:
        self.log("cancel")
        if event := self.waiting.pop(session_id, None):
            event.set()

    async def prompt(self, session_id, prompt, **kwargs):
        texts = [block.text for block in prompt if getattr(block, "text", None) is not None]
        self.log("prompt " + json.dumps(texts))
        if self.args.exit_on_prompt:
            os._exit(3)
        if session_id not in self.known:
            return PromptResponse(stop_reason="refusal")
        last = texts[-1] if texts else ""
        if self.args.deep_frame:
            await self.conn._conn.send_notification("session/update", json.loads("[" * 600 + "]" * 600))
        if self.args.unknown_update:
            await self.conn._conn.send_notification("session/update", {
                "sessionId": session_id, "update": {"sessionUpdate": "future_kind", "text": UNKNOWN_KIND_TEXT}})
        if self.args.unknown_option:
            try:
                await self.raw_permission(session_id, UNKNOWN_KIND_TEXT, {"command": UNKNOWN_KIND_TEXT},
                                          {"optionId": "allow-forever", "name": "Allow forever",
                                           "kind": "allow_forever"})
            except acp.RequestError:
                self.log("permission refused")
        if last == "/tools":
            await self.say(session_id, self.tools_reply)
        elif last in ("PERMIT", "PERMIT_NOREJECT", "PERMIT_NOALLOW"):
            await self.permit(session_id, with_allow=last != "PERMIT_NOALLOW", with_reject=last != "PERMIT_NOREJECT")
        elif last in TOOL_CALL_FIELDS:
            await self.permit(session_id, True, True, TOOL_CALL_FIELDS[last])
        elif last.startswith("PERMIT_WRITE "):
            new_text = "x" * int(last.split()[1])
            await self.permit(session_id, True, True, {"content": [acp.tool_diff_content("/srv/big", new_text)]})
        elif last == "PERMIT_BAD_TEXT":
            response = await self.raw_permission(session_id, BAD_TEXT, {"command": BAD_TEXT},
                                                 {"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
                                                 {"optionId": "reject-once", "name": "Reject", "kind": "reject_once"})
            await self.say(session_id, REPLIES.get(response["outcome"].get("optionId"), "cancelled"))
        elif last == "BAD_TEXT":
            await self.conn._conn.send_notification("session/update", {
                "sessionId": session_id,
                "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": BAD_TEXT}}})
        elif last == "ABANDON":
            self.abandoned = asyncio.create_task(self.ask(session_id, with_allow=True, with_reject=True))
            await asyncio.sleep(0.3)
            await self.say(session_id, "gave up")
        elif last == "SLOW":
            self.waiting[session_id] = event = asyncio.Event()
            await self.say(session_id, "working")
            await event.wait()
            return PromptResponse(stop_reason="cancelled")
        elif last == "STUCK":
            await self.say(session_id, "working")
            await asyncio.Event().wait()
        else:
            if last == "PLAN":
                await self.conn.session_update(session_id, acp.update_plan([]))
            elif last == "STALE":
                await self.say("another-session", "stale")
            await self.say(session_id, "echo: ")
            await self.say(session_id, last)
        return PromptResponse(stop_reason="end_turn")

    async def raw_permission(self, session_id: str, title: str, raw_input: dict, *options: dict) -> dict:
        return await self.conn._conn.send_request("session/request_permission", {
            "sessionId": session_id, "options": list(options),
            "toolCall": {"toolCallId": "call-1", "title": title, "rawInput": raw_input}})

    async def ask(self, session_id: str, with_allow: bool, with_reject: bool, fields: dict | None = None):
        options = []
        if with_allow:
            options.append(PermissionOption(option_id="allow-once", name="Allow once", kind="allow_once"))
        if with_reject:
            options.append(PermissionOption(option_id="reject-once", name="Reject", kind="reject_once"))
        options.append(PermissionOption(option_id="allow-always", name="Always allow", kind="allow_always"))
        return await self.conn.request_permission(
            session_id=session_id, options=options,
            tool_call=ToolCallUpdate(tool_call_id="call-1", **{
                "title": "Run a command", **(fields if fields is not None else {"raw_input": {"command": "ls"}})}))

    async def permit(self, session_id: str, with_allow: bool, with_reject: bool, fields: dict | None = None) -> None:
        await self.conn.session_update(session_id, acp.update_agent_thought_text("checking"))
        await self.conn.session_update(session_id, acp.start_tool_call(
            "call-1", "Run a command", kind="execute", status="pending"))
        response = await self.ask(session_id, with_allow, with_reject, fields)
        outcome = response.outcome
        reply = REPLIES.get(outcome.option_id, outcome.option_id) if outcome.outcome == "selected" else "cancelled"
        await self.conn.session_update(session_id, acp.update_tool_call(
            "call-1", status="completed" if reply == "allowed" else "failed"))
        await self.say(session_id, reply)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-load", action="store_true")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--state")
    parser.add_argument("--exit-on-prompt", action="store_true")
    parser.add_argument("--exit-on-new", action="store_true")
    parser.add_argument("--no-init", action="store_true")
    parser.add_argument("--linger", type=float, default=0.0)
    parser.add_argument("--tools-reply")
    parser.add_argument("--unknown-update", action="store_true")
    parser.add_argument("--unknown-option", action="store_true")
    parser.add_argument("--deep-frame", action="store_true")
    agent = FakeAgent(parser.parse_args())
    # session/resume is on acp's unstable list: without this flag the agent answers method_not_found.
    asyncio.run(acp.run_agent(agent, use_unstable_protocol=True))
    agent.log("eof")
    time.sleep(agent.args.linger)


if __name__ == "__main__":
    main()
