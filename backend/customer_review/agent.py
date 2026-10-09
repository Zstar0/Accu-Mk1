"""The review agent loop (spec 3.1): tools, limits, forced submit, citation validation."""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable

from customer_review import llm as llm_mod
from customer_review import prompts, tools

SECTIONS = ("open_issues", "shortfalls", "strengths", "next_steps")
TRENDS = ("improving", "steady", "declining")
MAX_ITEM_CHARS = 400
MAX_ITEMS = 8


class InvalidReview(Exception):
    pass


@dataclass(frozen=True)
class Limits:
    max_tool_calls: int = 20
    max_seconds: float = 120.0
    max_tokens: int = 4096


@dataclass
class Outcome:
    status: str
    review: dict | None = None
    error: str | None = None
    tool_calls: list[dict] = field(default_factory=list)
    input_tokens: int = 0
    output_tokens: int = 0
    citations_dropped: int = 0


def _label(kind: str, cid: str, meta: dict) -> dict:
    out = {"kind": kind, "id": cid, "label": {"order": f"Order {cid}"}.get(kind, cid)}
    if kind == "crm":
        out["label"] = (meta.get("item") or {}).get("title") or cid
    return {**out, **meta}


def _cites(raw: Any, ledger: dict) -> tuple[list[dict], int]:
    good, dropped = [], 0
    for c in raw or []:
        key = (str((c or {}).get("kind")), str((c or {}).get("id")))
        if key in ledger:
            good.append(_label(key[0], key[1], ledger[key]))
        else:
            dropped += 1
    return good, dropped


def validate(raw: dict, ledger: dict) -> tuple[dict, int]:
    if not isinstance(raw, dict) or not isinstance(raw.get("sentiment"), dict):
        raise InvalidReview("sentiment missing")
    s = raw["sentiment"]
    score = s.get("score")
    if not isinstance(score, int) or isinstance(score, bool) or not -2 <= score <= 2 or s.get("trend") not in TRENDS:
        raise InvalidReview("bad sentiment")
    cites, dropped = _cites(s.get("citations"), ledger)
    out: dict[str, Any] = {"sentiment": {"score": score, "trend": s["trend"], "reason": str(s.get("reason") or "")[:MAX_ITEM_CHARS],
                                         "citations": cites, "unsupported": not cites}}
    for name in SECTIONS:
        items = raw.get(name) or []
        if not isinstance(items, list):
            raise InvalidReview(f"{name} is not a list")
        kept = []
        for it in items:
            if not isinstance(it, dict) or not isinstance(it.get("text"), str):
                raise InvalidReview(f"bad item in {name}")
            cites, n = _cites(it.get("citations"), ledger)
            dropped += n
            if cites:
                kept.append({"text": it["text"][:MAX_ITEM_CHARS], "citations": cites})
        out[name] = kept[:MAX_ITEMS]
    return out, dropped


def _specs() -> list[dict]:
    specs = [{"name": n, "description": t.description, "input_schema": t.schema} for n, t in tools.TOOLS.items()]
    return [*specs, prompts.SUBMIT_TOOL]


def run(*, llm, ctx: tools.Ctx, on_step: Callable[[dict], None], clock: Callable[[], float] = time.monotonic,
        limits: Limits = Limits()) -> Outcome:
    started = clock()
    out = Outcome(status="failed")
    messages: list[dict] = [{"role": "user", "content": prompts.kickoff(ctx.customer_key)}]
    specs = _specs()
    forced = False
    for _turn in range(limits.max_tool_calls + 3):
        forced = len(out.tool_calls) >= limits.max_tool_calls or clock() - started >= limits.max_seconds
        payload = {"model": llm_mod.MODEL, "max_tokens": limits.max_tokens, "system": prompts.SYSTEM,
                   "tools": specs, "messages": messages}
        if forced:
            payload["tool_choice"] = {"type": "tool", "name": "submit_review"}
        resp = llm.create(payload)
        usage = resp.get("usage") or {}
        out.input_tokens += int(usage.get("input_tokens") or 0)
        out.output_tokens += int(usage.get("output_tokens") or 0)
        content = resp.get("content") or []
        messages.append({"role": "assistant", "content": content})
        uses = [b for b in content if isinstance(b, dict) and b.get("type") == "tool_use"]
        submit = next((b for b in uses if b.get("name") == "submit_review"), None)
        if submit is not None:
            try:
                out.review, out.citations_dropped = validate(submit.get("input"), ctx.ledger)
            except InvalidReview:
                out.status, out.error = "failed", "invalid review"
                out.review = {"raw": submit.get("input")}
                return out
            out.status = "done"
            return out
        if not uses:
            if forced:
                break
            messages.append({"role": "user", "content": "Continue with the tools, then call submit_review."})
            continue
        results = []
        for b in uses:
            name, args = b.get("name"), b.get("input") or {}
            result = tools.call(ctx, name, args)
            t = tools.TOOLS.get(name)
            label = t.label(args) if t else f"Unknown tool {name}"
            out.tool_calls.append({"tool": name, "args": args, "ok": "error" not in result,
                                   "size": len(tools.capped_json(result))})
            on_step({"at": datetime.now(timezone.utc).isoformat(), "tool": name, "label": label})
            results.append({"type": "tool_result", "tool_use_id": b.get("id"), "content": tools.capped_json(result)})
        messages.append({"role": "user", "content": results})
    out.status, out.error = "failed", "no review produced"
    return out
