"""customer_review.agent: tool loop, limits, forced submit, citation validation."""
import copy

import pytest

from customer_review import agent, tools


class ScriptedLLM:
    """Returns queued responses; records payloads."""

    def __init__(self, *responses):
        self.responses, self.payloads = list(responses), []

    def create(self, payload):
        self.payloads.append(copy.deepcopy(payload))  # the agent keeps appending to one messages list
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return {"content": r, "usage": {"input_tokens": 100, "output_tokens": 10}}


def use(name, args, uid="u1"):
    return {"type": "tool_use", "id": uid, "name": name, "input": args}


def item(title="Reply on T-948 took 3 days", **kw):
    base = {"title": title, "detail": "Customer waited for an answer.", "severity": "high",
            "citations": [{"kind": "ticket", "id": "T-948"}]}
    base.update(kw)
    return base


def review(**over):
    base = {"headline": "Happy overall, one slow reply.",
            "sentiment": {"score": 1, "trend": "steady", "reason": "Happy overall",
                          "citations": [{"kind": "ticket", "id": "T-948"}]},
            "open_issues": [], "shortfalls": [item(theme="communication")], "strengths": [], "next_steps": []}
    base.update(over)
    return base


@pytest.fixture
def ctx(monkeypatch):
    c = tools.Ctx(customer_key="wc:1", db=None)

    def fake_call(cx, name, args):
        if name == "list_tickets":
            cx.ledger[("ticket", "T-948")] = {"thread": {"id": "th_1", "ref": "T-948"}}
            return {"tickets": [{"ref": "T-948"}]}
        if name == "read_ticket" and args.get("ref") != "T-948":
            return {"error": "not this customer's ticket"}
        return {"ok": True}

    monkeypatch.setattr(agent.tools, "call", fake_call)
    return c


def run(llm, ctx, **kw):
    steps = []
    out = agent.run(llm=llm, ctx=ctx, on_step=steps.append, **kw)
    return out, steps


def test_tools_then_submit(ctx):
    llm = ScriptedLLM([use("list_tickets", {})], [use("submit_review", review(), "u2")])
    out, steps = run(llm, ctx)
    assert out.status == "done" and out.review["shortfalls"][0]["citations"][0]["thread"]["id"] == "th_1"
    assert [s["tool"] for s in steps] == ["list_tickets"] and steps[0]["label"] == "Listed support tickets"
    assert out.input_tokens == 200 and out.output_tokens == 20 and len(out.tool_calls) == 1
    assert llm.payloads[0]["model"] == "claude-sonnet-5-5" and "submit_review" in [t["name"] for t in llm.payloads[0]["tools"]]


def test_tool_call_limit_forces_submit(ctx):
    llm = ScriptedLLM([use("list_tickets", {})], [use("list_tickets", {}, "u2")],
                      [use("submit_review", review(), "u3")])
    out, _ = run(llm, ctx, limits=agent.Limits(max_tool_calls=2))
    assert out.status == "done"
    assert llm.payloads[2]["tool_choice"] == {"type": "tool", "name": "submit_review"}
    assert "tool_choice" not in llm.payloads[1]


def test_time_limit_forces_submit(ctx):
    t = iter([0.0, 0.0, 200.0, 200.0, 200.0])
    llm = ScriptedLLM([use("list_tickets", {})], [use("submit_review", review(), "u2")])
    out, _ = run(llm, ctx, clock=lambda: next(t))
    assert out.status == "done" and llm.payloads[1]["tool_choice"]["name"] == "submit_review"


def test_no_submission_after_forcing_fails(ctx):
    llm = ScriptedLLM([use("list_tickets", {})], [{"type": "text", "text": "I refuse"}])
    out, _ = run(llm, ctx, limits=agent.Limits(max_tool_calls=1))
    assert out.status == "failed" and out.error == "no review produced"


def test_uncited_and_foreign_citations_are_dropped(ctx):
    bad = review(open_issues=[item("Invented", citations=[{"kind": "ticket", "id": "T-1"}])],
                 strengths=[item("Mixed", citations=[{"kind": "ticket", "id": "T-948"}, {"kind": "sample", "id": "P-0"}])])
    llm = ScriptedLLM([use("list_tickets", {})], [use("submit_review", bad, "u2")])
    out, _ = run(llm, ctx)
    assert out.review["open_issues"] == []
    assert [c["id"] for c in out.review["strengths"][0]["citations"]] == ["T-948"]
    assert out.citations_dropped == 2


def test_sentiment_without_valid_citation_is_marked_unsupported(ctx):
    r = review(sentiment={"score": -1, "trend": "declining", "reason": "x", "citations": [{"kind": "crm", "id": "nope"}]})
    llm = ScriptedLLM([use("list_tickets", {})], [use("submit_review", r, "u2")])
    out, _ = run(llm, ctx)
    assert out.review["sentiment"]["unsupported"] is True and out.review["sentiment"]["score"] == -1


@pytest.mark.parametrize("raw", [{"sentiment": {"score": 5, "trend": "steady", "reason": "x"}},
                                 {"sentiment": {"score": 1, "trend": "sideways", "reason": "x"}},
                                 {"sentiment": "good"}])
def test_malformed_submission_fails(ctx, raw):
    llm = ScriptedLLM([use("submit_review", raw)], [use("submit_review", raw, "u2")])  # after the one retry
    out, _ = run(llm, ctx)
    assert out.status == "failed" and out.error == "invalid review"


def test_items_are_trimmed_and_capped(ctx):
    many = [item("t" * 200, detail="y" * 900)] * 12
    llm = ScriptedLLM([use("list_tickets", {})], [use("submit_review", review(next_steps=many), "u2")])
    out, _ = run(llm, ctx)
    first = out.review["next_steps"][0]
    assert len(out.review["next_steps"]) == 8 and len(first["title"]) == 80 and len(first["detail"]) == 400


def test_tool_errors_go_back_to_the_model(ctx):
    llm = ScriptedLLM([use("read_ticket", {"ref": "T-1"})], [use("list_tickets", {}, "u2")],
                      [use("submit_review", review(), "u3")])
    out, _ = run(llm, ctx)
    assert out.status == "done"
    result = llm.payloads[1]["messages"][-1]["content"][0]
    assert result["type"] == "tool_result" and "not this customer's ticket" in result["content"]


def test_anthropic_failure_mid_run_keeps_spend_and_lookups(ctx):
    from customer_review.llm import ReviewUnavailable

    out, _ = run(ScriptedLLM([use("list_tickets", {})], ReviewUnavailable("http_529")), ctx)
    assert out.status == "failed" and out.error == "AI service unavailable"
    assert out.input_tokens == 100 and len(out.tool_calls) == 1 and out.cost > 0


def test_prompt_caching_breakpoints(ctx):
    llm = ScriptedLLM([use("list_tickets", {})], [use("submit_review", review(), "u2")])
    run(llm, ctx)
    p0, p1 = llm.payloads
    assert p0["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert p0["tools"][-1]["cache_control"] == {"type": "ephemeral"}
    assert p1["messages"][-1]["content"][-1]["cache_control"] == {"type": "ephemeral"}
    marks = sum(1 for m in p1["messages"] if isinstance(m["content"], list)
                for b in m["content"] if isinstance(b, dict) and "cache_control" in b)
    assert marks == 1  # only the newest message carries a breakpoint (API max is 4 in total)


def test_parallel_tool_calls_past_the_limit_are_refused(ctx):
    three = [use("list_tickets", {}, "a"), use("list_tickets", {}, "b"), use("list_tickets", {}, "c")]
    llm = ScriptedLLM(three, [use("submit_review", review(), "u2")])
    out, _ = run(llm, ctx, limits=agent.Limits(max_tool_calls=2))
    assert len(out.tool_calls) == 2
    results = llm.payloads[1]["messages"][-1]["content"]
    assert [r["tool_use_id"] for r in results] == ["a", "b", "c"] and "limit" in results[2]["content"]


def test_cost_counts_cache_reads_and_writes():
    from decimal import Decimal

    from customer_review import llm

    assert llm.cost_usd(0, 0, cache_write=1_000_000, cache_read=1_000_000) == Decimal("2.7000")


def test_system_prompt_rules():
    from customer_review import prompts

    s = prompts.SYSTEM.lower()
    assert "never attribute" in s and "data" in s and "cite" in s and "strengths" in s


def test_v2_shape_defaults_and_headline(ctx):
    r = review(open_issues=[{"title": "No severity given", "detail": "d", "citations": [{"kind": "ticket", "id": "T-948"}]}],
               shortfalls=[{"title": "No theme", "detail": "d", "severity": "low",
                            "citations": [{"kind": "ticket", "id": "T-948"}]}],
               strengths=[item("Good", severity="high")], headline="h" * 500)
    llm = ScriptedLLM([use("list_tickets", {})], [use("submit_review", r, "u2")])
    out, _ = run(llm, ctx)
    assert out.review["open_issues"][0]["severity"] == "medium"
    assert out.review["shortfalls"][0]["theme"] == "other" and out.review["shortfalls"][0]["severity"] == "low"
    assert len(out.review["headline"]) == 300
    assert "severity" not in out.review["strengths"][0]


def test_v1_text_items_are_invalid(ctx):
    r = review(open_issues=[{"text": "old shape", "citations": [{"kind": "ticket", "id": "T-948"}]}])
    llm = ScriptedLLM([use("list_tickets", {})], [use("submit_review", r, "u2")], [use("submit_review", r, "u3")])
    out, _ = run(llm, ctx)
    assert out.status == "failed" and out.error == "invalid review"


def test_submit_schema_requires_headline_and_titles():
    from customer_review import prompts

    schema = prompts.SUBMIT_TOOL["input_schema"]
    assert "headline" in schema["required"]
    item_schema = schema["properties"]["shortfalls"]["items"]
    assert set(item_schema["required"]) == {"title", "citations"}
    assert item_schema["properties"]["theme"]["enum"] == ["turnaround", "coa_quality", "communication", "billing", "other"]
    assert "possessive" in prompts.SYSTEM.lower()


def test_crm_citation_label_is_neutral(ctx):
    ctx.ledger[("crm", "acti_9")] = {"item": {"type": "note", "at": "2026-09-17T10:00:00Z", "title": "Scott said X"}}
    r = review(strengths=[item("Good", citations=[{"kind": "crm", "id": "acti_9"}])])
    llm = ScriptedLLM([use("list_tickets", {})], [use("submit_review", r, "u2")])
    out, _ = run(llm, ctx)
    assert out.review["strengths"][0]["citations"][0]["label"] == "Note Sep 17"


def test_invalid_submission_gets_one_corrective_retry(ctx):
    bad = review(open_issues=[{"detail": "no title", "citations": [{"kind": "ticket", "id": "T-948"}]}])
    llm = ScriptedLLM([use("list_tickets", {})], [use("submit_review", bad, "u2")], [use("submit_review", review(), "u3")])
    out, _ = run(llm, ctx)
    assert out.status == "done"
    fix_msg = llm.payloads[2]["messages"][-1]["content"][0]
    assert fix_msg["type"] == "tool_result" and fix_msg["is_error"] is True and "title" in fix_msg["content"]


def test_second_invalid_submission_fails(ctx):
    bad = review(open_issues=[{"detail": "no title", "citations": [{"kind": "ticket", "id": "T-948"}]}])
    llm = ScriptedLLM([use("list_tickets", {})], [use("submit_review", bad, "u2")], [use("submit_review", bad, "u3")])
    out, _ = run(llm, ctx)
    assert out.status == "failed" and out.error == "invalid review"
