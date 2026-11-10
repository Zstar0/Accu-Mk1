"""Add-on test Variance, Task 14b: publish refuses a draft whose Variance runs
changed after it was generated, or that the builder would now refuse.

Publish ships the newest existing draft and never builds the document, so
the guard (main._refuse_unfinished_variance_runs ->
coa.native_sections.variance_publish_refusal) re-runs the builder's checks
and compares the replicate rows' last change with the draft's
coa_generations.created_at. Out of scope (no variance vial of a four-test
role) it costs one SELECT and nothing else.

The HPLC-only and retest-sample cases are characterization tests: their
literals were captured on the base checkout (scratch/mk1-t14b-capture.py)
with the same fakes, and they pass with or without the guard by design.
In-memory SQLite (StaticPool); nothing touches the shared dev Postgres.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, time, timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import integration_db
import main
import scheduled_publish
from coa.native_sections import NativeSectionsError, build_native_sections, variance_publish_refusal
from database import Base
from models import (BusinessHoursConfig, LimsAnalysis, LimsAnalysisTransition,
                    LimsScheduledPublish, User)
from tests.test_addon_variance_coa_rows import (HPLC_KEY, _endo_world, _order,
                                                _parent, _vial)

HOUR_AGO = datetime.utcnow() - timedelta(hours=1)
DRAFT_AT = datetime.utcnow() - timedelta(minutes=30)
STALE = ("cannot publish {sid}: a Variance run changed after this certificate was "
         "generated; regenerate it first (vial {sid}-S02 member 'ENDOTOXIN-USP85LAL' changed ")


@pytest.fixture()
def factory():
    import flags.models  # noqa: F401
    from flags.types_service import seed_builtins
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    f = sessionmaker(bind=engine)
    s = f()
    seed_builtins(s)
    s.add(User(id=1, email="admin@x", hashed_password="x", role="admin", is_active=True))
    s.add(BusinessHoursConfig(id=1, open_time=time(9, 0), close_time=time(17, 0),
                              timezone="America/Los_Angeles", working_days=[0, 1, 2, 3, 4]))
    s.commit()
    s.close()
    yield f
    engine.dispose()


@pytest.fixture()
def db(factory):
    s = factory()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture()
def publish(monkeypatch):
    """publish_sample_coa with every network edge faked, as the base capture
    ran it. `draft` is what fetch_publish_draft_generated_at answers (a
    datetime, None, or an exception to raise)."""
    calls, after = [], []
    state = SimpleNamespace(calls=calls, after=after, draft=DRAFT_AT, draft_reads=0)

    class Resp:
        def __init__(self, data):
            self._d = data

        def raise_for_status(self):
            return None

        def json(self):
            return self._d

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, **kw):
            calls.append(["POST", url, kw.get("json")])
            return Resp({"success": True, "verification_code": "VAR-0001",
                         "message": "COA published"})

        async def get(self, url, **kw):
            calls.append(["GET", url, None])
            return Resp({"items": []})

    def draft_read(sid):
        state.draft_reads += 1
        if isinstance(state.draft, BaseException):
            raise state.draft
        return state.draft

    monkeypatch.setattr(main, "SENAITE_URL", None)
    monkeypatch.setattr(main, "INTEGRATION_SERVICE_URL", "http://is.test")
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda *a, **k: Client())
    monkeypatch.setattr(integration_db, "fetch_stale_draft_primary", lambda s: None)
    monkeypatch.setattr(integration_db, "fetch_publish_draft_badge", lambda s: None)
    monkeypatch.setattr(integration_db, "fetch_publish_draft_generated_at", draft_read)
    monkeypatch.setattr(main, "_after_publish_native", lambda db, **kw: after.append(sorted(kw)))

    def run(db, sid, *, scheduled=False):
        if not scheduled:
            monkeypatch.setattr(scheduled_publish, "has_pending", lambda db, s: False)
        return asyncio.run(main.publish_sample_coa(sample_id=sid,
                                                   current_user=SimpleNamespace(id=1), db=db))
    state.run = run
    return state


def _base_literal(sid):
    return {"response": {"success": True, "message": "COA published",
                         "verification_code": "VAR-0001", "warning": None},
            "calls": [["POST", f"http://is.test/explorer/samples/{sid}/publish-coa",
                       {"include_lab_remarks": True}]],
            "after_publish_native": [["actor_user_id", "pre_publish_status", "sample_id",
                                      "senaite_actual_state", "verification_code"]]}


def _signed_world(db, monkeypatch, sid):
    """Endotoxin, 2 runs bought, run 2 signed off; every row backdated an hour
    so the draft (30 minutes ago) postdates it."""
    w = _endo_world(db, monkeypatch, sid, n=2, replicates=(("0.5", "variance_verified"),))
    db.query(LimsAnalysis).update({"created_at": HOUR_AGO})
    db.commit()
    return w


def _refused(publish, db, sid):
    with pytest.raises(HTTPException) as e:
        publish.run(db, sid)
    assert e.value.status_code == 409
    assert publish.calls == [] and publish.after == []
    return e.value.detail


def _builder_message(db, parent):
    with pytest.raises(NativeSectionsError) as e:
        build_native_sections(db, parent)
    return f"cannot publish {parent.sample_id}: {e.value.detail}"


# ── in scope: completeness and staleness ───────────────────────────────────

def test_signed_world_publishes(db, monkeypatch, publish):
    _signed_world(db, monkeypatch, "P-7460")
    res = publish.run(db, "P-7460")
    assert res.success is True and publish.draft_reads == 1
    assert publish.calls == _base_literal("P-7460")["calls"]


def test_retested_and_resigned_replicate_refuses_until_regenerated(db, monkeypatch, publish):
    from lims_analyses.service import apply_transition
    w = _signed_world(db, monkeypatch, "P-7461")
    old = db.query(LimsAnalysis).filter_by(lims_sub_sample_pk=w.reps[0].id).one()
    new = apply_transition(db, analysis_id=old.id, kind="retest")
    apply_transition(db, analysis_id=new.id, kind="submit", result_value="0.7")
    apply_transition(db, analysis_id=new.id, kind="variance_verify")
    db.commit()
    detail = _refused(publish, db, "P-7461")
    assert detail.startswith(STALE.format(sid="P-7461")), detail
    assert detail.endswith(f"the draft was generated {DRAFT_AT:%Y-%m-%d %H:%M:%S} UTC)")
    # Regenerate: the new draft postdates every change.
    publish.draft = datetime.utcnow()
    assert publish.run(db, "P-7461").success is True
    assert publish.calls == _base_literal("P-7461")["calls"]


def test_resubmitted_value_without_retest_is_stale(db, monkeypatch, publish):
    # A transition alone (no new row) moves the row's last change.
    w = _signed_world(db, monkeypatch, "P-7462")
    row = db.query(LimsAnalysis).filter_by(lims_sub_sample_pk=w.reps[0].id).one()
    db.add(LimsAnalysisTransition(analysis_id=row.id, from_state="variance_verified",
                                  to_state="variance_verified", transition_kind="variance_verify",
                                  occurred_at=datetime.utcnow()))
    db.commit()
    assert _refused(publish, db, "P-7462").startswith(STALE.format(sid="P-7462"))


def test_rejected_replicate_row_refuses_with_the_builder_message(db, monkeypatch, publish):
    w = _signed_world(db, monkeypatch, "P-7463")
    db.query(LimsAnalysis).filter_by(lims_sub_sample_pk=w.reps[0].id).update(
        {"review_state": "rejected"})
    db.commit()
    assert _refused(publish, db, "P-7463") == _builder_message(db, w.parent)


def test_only_replicate_taken_out_of_set_refuses_on_count(db, monkeypatch, publish):
    # The vial leaving the set must not take the sample out of the guard's
    # scope, or the draft's stale "Vial 2" row would ship.
    w = _signed_world(db, monkeypatch, "P-7464")
    w.reps[0].in_variance_set = False
    db.commit()
    assert _refused(publish, db, "P-7464") == (
        "cannot publish P-7464: native sections: 'endotoxin-usp85-lal' bought 2 runs, "
        "0 replicate runs carry results on P-7464; finish them or set the Variance count")


def test_failed_order_lookup_refuses(db, monkeypatch, publish):
    _signed_world(db, monkeypatch, "P-7465")

    def down(sid):
        raise ConnectionError("is down")
    monkeypatch.setattr("coa.native_sections.fetch_sample_services", down)
    assert _refused(publish, db, "P-7465") == (
        "cannot publish P-7465: native sections: order lookup failed for P-7465: is down")


def test_failed_draft_read_refuses(db, monkeypatch, publish):
    _signed_world(db, monkeypatch, "P-7466")
    publish.draft = RuntimeError("db down")
    assert _refused(publish, db, "P-7466") == (
        "cannot publish P-7466: the draft certificate could not be read to check its "
        "Variance runs (RuntimeError); try again")


# ── out of scope or no four-test plan: publish exactly as at base ──────────

def test_hplc_variance_only_sample_publishes_as_at_base(db, monkeypatch, publish):
    parent = _parent(db, "P-7450")
    _vial(db, parent, 1, "hplc", "core")
    _vial(db, parent, 2, "hplc", "variance")
    _order(monkeypatch, {HPLC_KEY: True, "variance": {HPLC_KEY: 2}})
    db.commit()
    publish.draft = AssertionError("the draft must not be read")
    res = publish.run(db, "P-7450")
    assert {"response": res.model_dump(), "calls": publish.calls,
            "after_publish_native": publish.after} == _base_literal("P-7450")
    assert publish.draft_reads == 0


def test_retest_sample_publishes_as_at_base(db, monkeypatch, publish):
    w = _endo_world(db, monkeypatch, "P-7451", n=3, replicates=(("0.5", "to_be_verified"),))
    w.parent.is_retest = True
    w.parent.retest_of_sample_id = "P-7000"
    db.commit()
    publish.draft = AssertionError("the draft must not be read")
    res = publish.run(db, "P-7451")
    assert {"response": res.model_dump(), "calls": publish.calls,
            "after_publish_native": publish.after} == _base_literal("P-7451")
    assert publish.draft_reads == 0


def test_no_variance_vial_costs_one_select_and_nothing_else(db, monkeypatch):
    _endo_world(db, monkeypatch, "P-7467", n=None, replicates=())

    def no_order(sid):
        raise AssertionError("the order must not be read")
    monkeypatch.setattr("coa.native_sections.fetch_sample_services", no_order)
    statements, draft_reads = [], []
    engine = db.get_bind()
    listener = lambda conn, cur, stmt, *a: statements.append(stmt)  # noqa: E731
    event.listen(engine, "before_cursor_execute", listener)
    try:
        reason = variance_publish_refusal(db, "P-7467",
                                          draft_generated_at=lambda: draft_reads.append(1))
    finally:
        event.remove(engine, "before_cursor_execute", listener)
    assert reason is None
    assert len(statements) == 1, statements
    assert draft_reads == []


# ── scheduled publish: refused, logged, not retried ────────────────────────

def test_scheduled_publish_refusal_is_logged_and_not_retried(factory, db, monkeypatch,
                                                             publish, caplog):
    from lims_analyses.service import apply_transition
    w = _signed_world(db, monkeypatch, "P-7468")
    old = db.query(LimsAnalysis).filter_by(lims_sub_sample_pk=w.reps[0].id).one()
    new = apply_transition(db, analysis_id=old.id, kind="retest")
    apply_transition(db, analysis_id=new.id, kind="submit", result_value="0.7")
    apply_transition(db, analysis_id=new.id, kind="variance_verify")
    now = datetime(2026, 11, 10, 18, 0)          # 10:00 lab time, outside the quiet window
    db.add(LimsScheduledPublish(sample_id="P-7468", scheduled_at=now - timedelta(hours=1),
                                pdf_date="11/10/2026", status="pending", created_by_user_id=1,
                                created_at=now - timedelta(hours=2)))
    db.commit()
    fired = []

    async def real_publish(*, sample_id, current_user, db):
        fired.append(sample_id)
        return await main.publish_sample_coa(sample_id=sample_id, current_user=current_user,
                                             db=db)
    with caplog.at_level(logging.WARNING, logger=scheduled_publish.logger.name):
        stats = asyncio.run(scheduled_publish.run_due(factory, real_publish, now=now))
        again = asyncio.run(scheduled_publish.run_due(factory, real_publish,
                                                      now=now + timedelta(minutes=1)))
    assert stats["failed"] == 1 and again["failed"] == 0 and fired == ["P-7468"]
    s = factory()
    [row] = s.execute(select(LimsScheduledPublish)).scalars().all()
    assert row.status == "failed"
    assert row.last_error.startswith(STALE.format(sid="P-7468"))
    s.close()
    [msg] = [r.getMessage() for r in caplog.records
             if r.getMessage().startswith("scheduled_publish.failed")]
    assert msg.startswith("scheduled_publish.failed sample=P-7468 err=" + STALE.format(sid="P-7468"))
    assert publish.calls == []
