"""The review agent loop (spec 3.1): tools, limits, forced submit, citation validation."""
from __future__ import annotations

import copy
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Callable

from customer_review import llm as llm_mod
from customer_review import prompts, tools

SECTIONS = ("open_issues", "shortfalls", "strengths", "next_steps")
TRENDS = ("improving", "steady", "declining")
SEVERITIES = ("high", "medium", "low")
THEMES = ("turnaround", "coa_quality", "communication", "billing", "other")
MAX_ITEM_CHARS = 400
MAX_TITLE_CHARS = 80
MAX_HEADLINE_CHARS = 300
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
    cost: Decimal = Decimal("0")


def _label(kind: str, cid: str, meta: dict) -> dict:
    out = {"kind": kind, "id": cid, "label": {"order": f"Order {cid}"}.get(kind, cid)}
    if kind == "crm":  # never the item title: a note's first line is staff-written text
        out["label"] = _crm_label(meta.get("item") or {}, cid)
    return {**out, **meta}


def _crm_label(item: dict, cid: str) -> str:
    kind = str(item.get("type") or "item").capitalize()
    try:
        dt = datetime.fromisoformat(str(item.get("at") or "")[:10])
        return f"{kind} {dt:%b} {dt.day}"
    except ValueError:
        return kind if item.get("type") else cid


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
    out: dict[str, Any] = {
        "headline": str(raw.get("headline") or "")[:MAX_HEADLINE_CHARS],
        "sentiment": {"score": score, "trend": s["trend"], "reason": str(s.get("reason") or "")[:MAX_ITEM_CHARS],
                      "citations": cites, "unsupported": not cites}}
    for name in SECTIONS:
        items = raw.get(name) or []
        if not isinstance(items, list):
            raise InvalidReview(f"{name} is not a list")
        kept = []
        for it in items:
            if not isinstance(it, dict) or not isinstance(it.get("title"), str) or not it["title"].strip():
                raise InvalidReview(f"every item in {name} needs a non-empty title")
            cites, n = _cites(it.get("citations"), ledger)
            dropped += n
            if not cites:
                continue
            row = {"title": it["title"].strip()[:MAX_TITLE_CHARS], "detail": str(it.get("detail") or "")[:MAX_ITEM_CHARS],
                   "citations": cites}
            if name in ("open_issues", "shortfalls"):
                row["severity"] = it.get("severity") if it.get("severity") in SEVERITIES else "medium"
            if name == "shortfalls":
                row["theme"] = it.get("theme") if it.get("theme") in THEMES else "other"
            kept.append(row)
        out[name] = kept[:MAX_ITEMS]
    return out, dropped


_EPHEMERAL = {"type": "ephemeral"}


def _specs() -> list[dict]:
    specs = [{"name": n, "description": t.description, "input_schema": t.schema} for n, t in tools.TOOLS.items()]
    return [*specs, {**prompts.SUBMIT_TOOL, "cache_control": _EPHEMERAL}]  # breakpoint: tools + system


def _cached(messages: list[dict]) -> list[dict]:
    """Copy with one cache breakpoint on the newest message, so each turn re-reads history at the cache rate."""
    out = list(messages)
    last = copy.copy(out[-1])
    content = last["content"]
    blocks = [{"type": "text", "text": content}] if isinstance(content, str) else list(content)
    blocks[-1] = {**blocks[-1], "cache_control": _EPHEMERAL}
    last["content"] = blocks
    out[-1] = last
    return out


def run(*, llm, ctx: tools.Ctx, on_step: Callable[[dict], None], clock: Callable[[], float] = time.monotonic,
        limits: Limits = Limits()) -> Outcome:
    started = clock()
    out = Outcome(status="failed")
    messages: list[dict] = [{"role": "user", "content": prompts.kickoff(ctx.customer_key)}]
    specs = _specs()
    forced = False
    retried_submit = False
    for _turn in range(limits.max_tool_calls + 4):
        forced = len(out.tool_calls) >= limits.max_tool_calls or clock() - started >= limits.max_seconds
        payload = {"model": llm_mod.MODEL, "max_tokens": limits.max_tokens,
                   "system": [{"type": "text", "text": prompts.SYSTEM, "cache_control": _EPHEMERAL}],
                   "tools": specs, "messages": _cached(messages)}
        if forced:
            payload["tool_choice"] = {"type": "tool", "name": "submit_review"}
        try:
            resp = llm.create(payload)
        except llm_mod.ReviewUnavailable:
            out.status, out.error = "failed", "AI service unavailable"  # keep spend + lookups so far
            return out
        usage = resp.get("usage") or {}
        fresh, written, read = (int(usage.get(k) or 0) for k in
                                ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
        produced = int(usage.get("output_tokens") or 0)
        out.input_tokens += fresh + written + read
        out.output_tokens += produced
        out.cost += llm_mod.cost_usd(fresh, produced, cache_write=written, cache_read=read)
        content = resp.get("content") or []
        messages.append({"role": "assistant", "content": content})
        uses = [b for b in content if isinstance(b, dict) and b.get("type") == "tool_use"]
        submit = next((b for b in uses if b.get("name") == "submit_review"), None)
        if submit is not None:
            try:
                out.review, out.citations_dropped = validate(submit.get("input"), ctx.ledger)
            except InvalidReview as e:
                if retried_submit:
                    out.status, out.error = "failed", "invalid review"
                    out.review = {"raw": submit.get("input")}
                    return out
                retried_submit = True  # one corrective resubmit instead of losing a paid run
                fix = [{"type": "tool_result", "tool_use_id": b.get("id"), "is_error": True,
                        "content": (f"Invalid review: {e}. Fix it and call submit_review again."
                                    if b is submit else "Ignored: submit_review must be called on its own.")}
                       for b in uses]
                messages.append({"role": "user", "content": fix})
                continue
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
            if len(out.tool_calls) >= limits.max_tool_calls:  # parallel calls past the budget
                results.append({"type": "tool_result", "tool_use_id": b.get("id"),
                                "content": tools.capped_json({"error": "tool call limit reached; call submit_review"})})
                continue
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
