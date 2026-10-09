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


def review(**over):
    base = {"sentiment": {"score": 1, "trend": "steady", "reason": "Happy overall",
                          "citations": [{"kind": "ticket", "id": "T-948"}]},
            "open_issues": [], "shortfalls": [{"text": "Reply on T-948 took 3 days",
                                               "citations": [{"kind": "ticket", "id": "T-948"}]}],
            "strengths": [], "next_steps": []}
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
    bad = review(open_issues=[{"text": "Invented", "citations": [{"kind": "ticket", "id": "T-1"}]}],
                 strengths=[{"text": "Mixed", "citations": [{"kind": "ticket", "id": "T-948"},
                                                            {"kind": "sample", "id": "P-0"}]}])
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
    llm = ScriptedLLM([use("submit_review", raw)])
    out, _ = run(llm, ctx)
    assert out.status == "failed" and out.error == "invalid review"


def test_items_are_trimmed_and_capped(ctx):
    many = [{"text": "y" * 900, "citations": [{"kind": "ticket", "id": "T-948"}]}] * 12
    llm = ScriptedLLM([use("list_tickets", {})], [use("submit_review", review(next_steps=many), "u2")])
    out, _ = run(llm, ctx)
    assert len(out.review["next_steps"]) == 8 and len(out.review["next_steps"][0]["text"]) == 400


def test_tool_errors_go_back_to_the_model(ctx):
    llm = ScriptedLLM([use("read_ticket", {"ref": "T-1"})], [use("list_tickets", {}, "u2")],
                      [use("submit_review", review(), "u3")])
    out, _ = run(llm, ctx)
    assert out.status == "done"
    result = llm.payloads[1]["messages"][-1]["content"][0]
    assert result["type"] == "tool_result" and "not this customer's ticket" in result["content"]


def test_anthropic_failure_propagates(ctx):
    from customer_review.llm import ReviewUnavailable

    with pytest.raises(ReviewUnavailable):
        run(ScriptedLLM(ReviewUnavailable("http_529")), ctx)


def test_system_prompt_rules():
    from customer_review import prompts

    s = prompts.SYSTEM.lower()
    assert "never attribute" in s and "data" in s and "cite" in s and "strengths" in s
