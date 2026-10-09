"""customer_review.store: runs table, one active run per customer, interrupted detection, daily cap."""
from datetime import datetime, timedelta, timezone

from customer_review import store
from models import CustomerAiReview


def test_create_and_finish_round_trip(db_session):
    row = store.create_run(db_session, "wc:1", 7, "claude-sonnet-5-5")
    store.add_step(db_session, row.id, {"at": "t", "tool": "customer_overview", "label": "Read customer overview"})
    store.finish(db_session, row.id, status="done", review={"sentiment": {"score": 1}}, tool_calls=[{"tool": "x"}],
                 input_tokens=1000, output_tokens=200, cost_usd=0.004, citations_dropped=2)
    d = store.to_dict(store.get_run(db_session, row.id))
    assert d["status"] == "done" and d["review"] == {"sentiment": {"score": 1}}
    assert d["steps"][0]["tool"] == "customer_overview" and d["tool_call_count"] == 1
    assert d["cost_usd"] == 0.004 and d["citations_dropped"] == 2 and d["finished_at"]
    assert set(d) == {"run_id", "customer_key", "status", "created_at", "finished_at", "model", "steps", "review",
                      "tool_calls", "tool_call_count", "input_tokens", "output_tokens", "cost_usd",
                      "citations_dropped", "error"}


def test_active_run_returns_the_live_run(db_session):
    row = store.create_run(db_session, "wc:1", 7, "m")
    assert store.active_run(db_session, "wc:1").id == row.id
    assert store.active_run(db_session, "wc:2") is None


def test_stale_running_row_is_interrupted_and_closed(db_session):
    row = store.create_run(db_session, "wc:1", 7, "m")
    row.created_at = datetime.now(timezone.utc) - timedelta(minutes=11)
    db_session.commit()
    assert store.status_of(row) == "interrupted"
    assert store.active_run(db_session, "wc:1") is None
    closed = store.get_run(db_session, row.id)
    assert closed.status == "failed" and closed.error == "interrupted"


def test_recent_is_newest_first(db_session):
    a = store.create_run(db_session, "wc:1", 7, "m")
    b = store.create_run(db_session, "wc:1", 7, "m")
    store.create_run(db_session, "wc:2", 7, "m")
    assert [r.id for r in store.recent(db_session, "wc:1")] == [b.id, a.id]


def test_daily_cap_counts_today_only(db_session):
    old = store.create_run(db_session, "wc:1", 7, "m")
    old.created_at = datetime.now(timezone.utc) - timedelta(days=2)
    db_session.commit()
    store.create_run(db_session, "wc:1", 7, "m")
    assert store.over_daily_cap(db_session, 2) is False
    store.create_run(db_session, "wc:2", 7, "m")
    assert store.over_daily_cap(db_session, 2) is True


def test_finished_rows_are_never_reopened(db_session):
    row = store.create_run(db_session, "wc:1", 7, "m")
    store.finish(db_session, row.id, status="failed", tool_calls=[], input_tokens=0, output_tokens=0, cost_usd=0,
                 error="AI service unavailable")
    store.finish(db_session, row.id, status="done", tool_calls=[], input_tokens=0, output_tokens=0, cost_usd=0)
    assert store.get_run(db_session, row.id).status == "failed"
    assert isinstance(db_session.get(CustomerAiReview, row.id).steps, list)


def test_a_six_minute_run_is_still_running(db_session):
    row = store.create_run(db_session, "wc:1", 7, "m")
    row.created_at = datetime.now(timezone.utc) - timedelta(minutes=6)
    db_session.commit()
    assert store.status_of(row) == "running"
    assert store.active_run(db_session, "wc:1").id == row.id


def test_startup_sweep_closes_every_running_row(db_session):
    a = store.create_run(db_session, "wc:1", 7, "m")
    b = store.create_run(db_session, "wc:2", 7, "m")
    store.finish(db_session, b.id, status="done", tool_calls=[], input_tokens=0, output_tokens=0, cost_usd=0)
    assert store.sweep_running(db_session) == 1
    assert store.get_run(db_session, a.id).error == "interrupted"
    assert store.get_run(db_session, b.id).status == "done"
