"""/ai-review/* routes: admin gate, start/dedupe/cap, shapes, runner outcomes."""
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from auth import get_current_user
from customer_review import agent, llm, routes, store
from customer_review.llm import cost_usd
from database import Base, get_db


@pytest.fixture
def api(monkeypatch):
    import main

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    started = []

    def _db():
        s = Session()
        try:
            yield s
        finally:
            s.close()

    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    monkeypatch.setattr(routes, "_emails_fn", lambda key: {"wc:1": ["k@x.example"]}.get(key))
    monkeypatch.setattr(routes, "_start", lambda run_id, key: started.append((run_id, key)))
    monkeypatch.setattr(routes, "_session_factory", Session)
    main.app.dependency_overrides[get_db] = _db
    main.app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1, role="admin")
    yield TestClient(main.app), Session, started
    main.app.dependency_overrides.clear()


def test_standard_user_is_forbidden_on_all_routes(api):
    import main

    client, _, _ = api
    main.app.dependency_overrides[get_current_user] = lambda: MagicMock(id=2, role="standard")
    assert client.post("/ai-review/customers/wc:1").status_code == 403
    assert client.get("/ai-review/customers/wc:1").status_code == 403
    assert client.get("/ai-review/runs/1").status_code == 403


def test_start_creates_one_run_and_a_second_post_returns_it(api):
    client, _, started = api
    r1 = client.post("/ai-review/customers/wc:1")
    assert r1.status_code == 202 and r1.json()["status"] == "running"
    r2 = client.post("/ai-review/customers/wc:1")
    assert r2.json()["run_id"] == r1.json()["run_id"] and len(started) == 1


def test_unknown_customer_404_not_configured_503_cap_429(api, monkeypatch):
    client, _, _ = api
    assert client.post("/ai-review/customers/wc:404").status_code == 404
    monkeypatch.setattr(routes, "DAILY_CAP", 0)
    r = client.post("/ai-review/customers/wc:1")
    assert r.status_code == 429 and r.json()["detail"]["code"] == "review_daily_cap"
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    r = client.post("/ai-review/customers/wc:1")
    assert r.status_code == 503 and r.json()["detail"]["code"] == "review_not_configured"


def test_latest_and_history_shapes(api):
    client, Session, _ = api
    run_id = client.post("/ai-review/customers/wc:1").json()["run_id"]
    with Session() as db:
        store.finish(db, run_id, status="done", review={"sentiment": {"score": 1, "trend": "steady", "reason": "r",
                                                                      "citations": [], "unsupported": True},
                                                        "open_issues": [], "shortfalls": [], "strengths": [],
                                                        "next_steps": []},
                     tool_calls=[{"tool": "customer_overview", "args": {}, "ok": True, "size": 10}],
                     input_tokens=10, output_tokens=5, cost_usd=0.0001)
    body = client.get("/ai-review/customers/wc:1").json()
    assert set(body) == {"latest", "history"}
    assert body["latest"]["status"] == "done" and body["history"][0]["sentiment_score"] == 1
    run = client.get(f"/ai-review/runs/{run_id}").json()
    assert set(run) == {"run_id", "customer_key", "status", "created_at", "finished_at", "model", "steps", "review",
                        "tool_calls", "tool_call_count", "input_tokens", "output_tokens", "cost_usd",
                        "citations_dropped", "error"}
    assert client.get("/ai-review/runs/999").status_code == 404
    assert client.get("/ai-review/customers/wc:2").json() == {"latest": None, "history": []}


def test_runner_records_done_failed_and_unavailable(api, monkeypatch):
    _, Session, _ = api
    with Session() as db:
        ok, bad, down = (store.create_run(db, "wc:1", 1, "m").id for _ in range(3))
    monkeypatch.setattr(llm, "get_client", lambda: object())

    def fake_run(*, llm, ctx, on_step, **kw):
        on_step({"at": "t", "tool": "list_tickets", "label": "Listed support tickets"})
        if fake_run.mode == "down":
            raise llm_mod_unavailable
        return agent.Outcome(status=fake_run.mode, review={"x": 1} if fake_run.mode == "done" else None,
                             error=None if fake_run.mode == "done" else "no review produced",
                             tool_calls=[{"tool": "list_tickets"}], input_tokens=1000, output_tokens=100,
                             cost=cost_usd(1000, 100))

    llm_mod_unavailable = llm.ReviewUnavailable("http_529")
    monkeypatch.setattr(routes.agent, "run", fake_run)
    for run_id, mode in ((ok, "done"), (bad, "failed"), (down, "down")):
        fake_run.mode = mode
        routes._execute(run_id, "wc:1")
    with Session() as db:
        a, b, c = store.get_run(db, ok), store.get_run(db, bad), store.get_run(db, down)
        assert a.status == "done" and float(a.cost_usd) == 0.003 and a.steps[0]["tool"] == "list_tickets"
        assert b.status == "failed" and b.error == "no review produced"
        assert c.status == "failed" and c.error == "AI service unavailable"


def test_runner_finishes_on_a_fresh_session(api, monkeypatch):
    _, Session, _ = api
    with Session() as db:
        run_id = store.create_run(db, "wc:1", 1, "m").id
    opened = []

    def factory():
        opened.append(1)
        return Session()

    monkeypatch.setattr(routes, "_session_factory", factory)
    monkeypatch.setattr(llm, "get_client", lambda: object())

    def crash(**kw):
        raise RuntimeError("db went away")

    monkeypatch.setattr(routes.agent, "run", crash)
    routes._execute(run_id, "wc:1")
    assert len(opened) == 2
    with Session() as db:
        assert store.get_run(db, run_id).error == "internal error"
