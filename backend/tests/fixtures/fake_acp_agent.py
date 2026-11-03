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

Prompts, by their last text block:
  /tools            the tool list
  PERMIT            a thought, a tool call, then a permission request offering allow_once, reject_once and
                    allow_always; replies `allowed`, `denied` or `cancelled` (the outcome it got)
  PERMIT_NOREJECT   the same without reject_once
  SLOW              replies `working`, waits for session/cancel, then stops with `cancelled`
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

# Verbatim copy of T7A in test_ai_chat_context.py (the phase0 2026-11-03 `/tools` reply).
T7A = ("Available tools (3):\n  mcp__mk1__create_flag: Raise a flag on a sample. The user must approve it in Mk1 first, which can ta...\n"
       "  mcp__mk1__whoami: Return the Mk1 user this chat acts as.\n"
       "  todo_list: Track a task list for multi-step work (3+ steps). Use for complex tasks with ...")

REPLIES = {"allow-once": "allowed", "reject-once": "denied"}


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
        if last == "/tools":
            await self.say(session_id, self.tools_reply)
        elif last in ("PERMIT", "PERMIT_NOREJECT"):
            await self.permit(session_id, with_reject=last == "PERMIT")
        elif last == "SLOW":
            self.waiting[session_id] = event = asyncio.Event()
            await self.say(session_id, "working")
            await event.wait()
            return PromptResponse(stop_reason="cancelled")
        else:
            if last == "PLAN":
                await self.conn.session_update(session_id, acp.update_plan([]))
            elif last == "STALE":
                await self.say("another-session", "stale")
            await self.say(session_id, "echo: ")
            await self.say(session_id, last)
        return PromptResponse(stop_reason="end_turn")

    async def permit(self, session_id: str, with_reject: bool) -> None:
        await self.conn.session_update(session_id, acp.update_agent_thought_text("checking"))
        await self.conn.session_update(session_id, acp.start_tool_call(
            "call-1", "Run a command", kind="execute", status="pending"))
        options = [PermissionOption(option_id="allow-once", name="Allow once", kind="allow_once")]
        if with_reject:
            options.append(PermissionOption(option_id="reject-once", name="Reject", kind="reject_once"))
        options.append(PermissionOption(option_id="allow-always", name="Always allow", kind="allow_always"))
        response = await self.conn.request_permission(
            session_id=session_id, options=options,
            tool_call=ToolCallUpdate(tool_call_id="call-1", title="Run a command", raw_input={"command": "ls"}))
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
    agent = FakeAgent(parser.parse_args())
    # session/resume is on acp's unstable list: without this flag the agent answers method_not_found.
    asyncio.run(acp.run_agent(agent, use_unstable_protocol=True))
    agent.log("eof")
    time.sleep(agent.args.linger)


if __name__ == "__main__":
    main()
