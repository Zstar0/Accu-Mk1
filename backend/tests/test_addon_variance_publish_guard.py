"""Add-on test Variance, Task 14b: publish refuses a draft whose Variance runs
no longer match what the builder would print now.

Publish ships the newest existing draft and never builds the document. So
every successful generation records a fingerprint of the four-test Variance
content the builder returned on its `coa_generated` sample event, and the
guard (main._refuse_unfinished_variance_runs ->
coa.native_sections.variance_publish_refusal) rebuilds and compares it with
the record for the draft being published (matched by generation number).
Out of scope (no recorded runs and no variance vial of a four-test role) it
costs two SELECTs and nothing else.

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

import httpx
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
from models import (BusinessHoursConfig, LimsAnalysis, LimsScheduledPublish, LimsSubSampleEvent,
                    User)
from tests.test_addon_variance_coa_rows import (ENDO_KEY, HPLC_KEY, _endo_world, _order,
                                                _parent, _parent_row, _vial)

STALE = ("cannot publish {sid}: a Variance run changed after this certificate was "
         "generated; regenerate it first ({detail})")


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
def lab(monkeypatch):
    """generate_sample_coa and publish_sample_coa with every network edge
    faked, publish as the base capture ran it. `badge` is the draft Publish
    would pick (fetch_publish_draft_badge): None, a dict, or an exception."""
    calls, after = [], []
    state = SimpleNamespace(calls=calls, after=after, badge=None, badge_reads=0,
                            generation=0, coab_down=False)

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
            if url.startswith("http://coabuilder.test/"):
                if state.coab_down:
                    raise httpx.ConnectError("coabuilder down")
                state.generation += 1
                n = state.generation
                state.badge = {"generation_number": n, "verification_code": f"V-{n}",
                               "page1": None, "overall_status": None}
                return Resp({"verification_code": f"V-{n}", "generation_number": n,
                             "generation_id": None, "warnings": []})
            calls.append(["POST", url, kw.get("json")])
            return Resp({"success": True, "verification_code": "VAR-0001",
                         "message": "COA published"})

        async def get(self, url, **kw):
            calls.append(["GET", url, None])
            return Resp({"items": []})

    def badge(sid):
        state.badge_reads += 1
        if isinstance(state.badge, BaseException):
            raise state.badge
        return state.badge

    monkeypatch.setattr(main, "SENAITE_URL", None)
    monkeypatch.setattr(main, "COA_BUILDER_URL", "http://coabuilder.test")
    monkeypatch.setattr(main, "INTEGRATION_SERVICE_URL", "http://is.test")
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda *a, **k: Client())
    monkeypatch.setattr(integration_db, "fetch_stale_draft_primary", lambda s: None)
    monkeypatch.setattr(integration_db, "fetch_publish_draft_badge", badge)
    monkeypatch.setattr(main, "_after_publish_native", lambda db, **kw: after.append(sorted(kw)))

    def generate(db, sid):
        return asyncio.run(main.generate_sample_coa(sample_id=sid, db=db,
                                                    current_user=SimpleNamespace(id=1)))

    def run(db, sid, *, scheduled=False):
        if not scheduled:
            monkeypatch.setattr(scheduled_publish, "has_pending", lambda db, s: False)
        return asyncio.run(main.publish_sample_coa(sample_id=sid,
                                                   current_user=SimpleNamespace(id=1), db=db))
    state.generate, state.run = generate, run
    return state


def _base_literal(sid):
    return {"response": {"success": True, "message": "COA published",
                         "verification_code": "VAR-0001", "warning": None},
            "calls": [["POST", f"http://is.test/explorer/samples/{sid}/publish-coa",
                       {"include_lab_remarks": True}]],
            "after_publish_native": [["actor_user_id", "pre_publish_status", "sample_id",
                                      "senaite_actual_state", "verification_code"]]}


def _signed_world(db, monkeypatch, sid, *, n=2, replicates=(("0.5", "variance_verified"),)):
    w = _endo_world(db, monkeypatch, sid, n=n, replicates=replicates)
    w.parent.variance_locked_at = datetime(2026, 11, 10, 12, 0, 0)
    db.commit()
    return w


def _generated(db, monkeypatch, lab, sid, **kw):
    """A signed world with one successful generation (draft #1)."""
    w = _signed_world(db, monkeypatch, sid, **kw)
    res = lab.generate(db, sid)
    assert res.success is True, res.message
    return w


def _refused(lab, db, sid):
    with pytest.raises(HTTPException) as e:
        lab.run(db, sid)
    assert e.value.status_code == 409
    assert lab.calls == [] and lab.after == []
    return e.value.detail


def _builder_message(db, parent):
    with pytest.raises(NativeSectionsError) as e:
        build_native_sections(db, parent)
    return f"cannot publish {parent.sample_id}: {e.value.detail}"


def _resign(db, w, value):
    from lims_analyses.service import apply_transition
    old = db.query(LimsAnalysis).filter_by(lims_sub_sample_pk=w.reps[0].id).one()
    new = apply_transition(db, analysis_id=old.id, kind="retest")
    apply_transition(db, analysis_id=new.id, kind="submit", result_value=value)
    apply_transition(db, analysis_id=new.id, kind="variance_verify")
    db.commit()


def _events(db):
    return [e.details for e in db.query(LimsSubSampleEvent).filter_by(event="coa_generated")
            .order_by(LimsSubSampleEvent.id)]


# ── the record ──────────────────────────────────────────────────────────────

def test_generation_records_the_fingerprint_of_what_it_printed(db, monkeypatch, lab):
    from coa.native_sections import variance_fingerprint
    w = _generated(db, monkeypatch, lab, "P-7460")
    [details] = _events(db)
    rec = details["variance"]
    assert details["generation_number"] == 1
    assert rec["runs"] == 2 and rec["generation_id"] is None
    rep = db.query(LimsAnalysis).filter_by(lims_sub_sample_pk=w.reps[0].id).one()
    assert rec["trace"] == [{"profile_key": ENDO_KEY, "deferred": False, "runs": [
        {"run": 1, "vial_pk": None, "row_pk": w.base.id, "keyword": "ENDOTOXIN-USP85LAL",
         "result": "1.2", "result_display": rec["trace"][0]["runs"][0]["result_display"],
         "conforms": True},
        {"run": 2, "vial_pk": w.reps[0].id, "row_pk": rep.id, "keyword": "ENDOTOXIN-USP85LAL",
         "result": "0.5", "result_display": rec["trace"][0]["runs"][1]["result_display"],
         "conforms": True}]}]
    assert rec["fingerprint"] == variance_fingerprint(rec["trace"])
    assert lab.run(db, "P-7460").success is True
    assert lab.calls == _base_literal("P-7460")["calls"]


def test_out_of_scope_generation_leaves_the_event_as_today(db, monkeypatch, lab):
    parent = _parent(db, "P-7470")
    _vial(db, parent, 1, "hplc", "core")
    _order(monkeypatch, {})
    db.commit()
    assert lab.generate(db, "P-7470").success is True
    assert _events(db) == [{"verification_code": "V-1", "generation_number": 1}]


def test_two_generations_with_no_change_publish(db, monkeypatch, lab):
    _generated(db, monkeypatch, lab, "P-7471")
    assert lab.generate(db, "P-7471").success is True
    assert [e["generation_number"] for e in _events(db)] == [1, 2]
    assert lab.run(db, "P-7471").success is True


def test_failed_generation_records_nothing_and_the_previous_record_governs(db, monkeypatch, lab):
    w = _generated(db, monkeypatch, lab, "P-7472")
    lab.coab_down = True
    assert lab.generate(db, "P-7472").success is False
    assert len(_events(db)) == 1
    assert lab.run(db, "P-7472").success is True          # draft #1, unchanged
    lab.calls.clear()
    lab.after.clear()
    _resign(db, w, "0.7")
    assert lab.generate(db, "P-7472").success is False
    assert _refused(lab, db, "P-7472") == STALE.format(sid="P-7472", detail=(
        "'endotoxin-usp85-lal' run 2 member 'ENDOTOXIN-USP85LAL' printed 0.5 on draft #1, "
        "now 0.7"))


# ── in scope: every change since the draft refuses ─────────────────────────

def test_retested_and_resigned_replicate_refuses_until_regenerated(db, monkeypatch, lab):
    w = _generated(db, monkeypatch, lab, "P-7461")
    _resign(db, w, "0.7")
    assert _refused(lab, db, "P-7461") == STALE.format(sid="P-7461", detail=(
        "'endotoxin-usp85-lal' run 2 member 'ENDOTOXIN-USP85LAL' printed 0.5 on draft #1, "
        "now 0.7"))
    assert lab.generate(db, "P-7461").success is True
    assert lab.run(db, "P-7461").success is True
    assert lab.calls == _base_literal("P-7461")["calls"]


def test_same_value_resigned_on_a_new_row_refuses(db, monkeypatch, lab):
    w = _generated(db, monkeypatch, lab, "P-7462")
    _resign(db, w, "0.5")
    assert _refused(lab, db, "P-7462") == STALE.format(sid="P-7462", detail=(
        "'endotoxin-usp85-lal' run 2 member 'ENDOTOXIN-USP85LAL' now comes from a "
        "different vial or result row than on draft #1"))


def test_rejected_replicate_row_refuses_with_the_builder_message(db, monkeypatch, lab):
    w = _generated(db, monkeypatch, lab, "P-7463")
    db.query(LimsAnalysis).filter_by(lims_sub_sample_pk=w.reps[0].id).update(
        {"review_state": "rejected"})
    db.commit()
    assert _refused(lab, db, "P-7463") == _builder_message(db, w.parent)


def test_only_replicate_taken_out_of_set_refuses_on_count(db, monkeypatch, lab):
    w = _generated(db, monkeypatch, lab, "P-7464")
    w.reps[0].in_variance_set = False
    db.commit()
    assert _refused(lab, db, "P-7464") == (
        "cannot publish P-7464: native sections: 'endotoxin-usp85-lal' bought 2 runs, "
        "0 replicate runs carry results on P-7464; finish them or set the Variance count")


def test_only_replicate_flipped_to_core_refuses(db, monkeypatch, lab):
    # The sample has no variance vial left: the recorded runs keep it in scope.
    w = _generated(db, monkeypatch, lab, "P-7473")
    w.reps[0].assignment_kind = "core"
    db.commit()
    assert _refused(lab, db, "P-7473") == _builder_message(db, w.parent)


def test_replicate_role_changed_refuses(db, monkeypatch, lab):
    w = _generated(db, monkeypatch, lab, "P-7474")
    w.reps[0].assignment_role = "hplc"
    db.commit()
    assert _refused(lab, db, "P-7474") == _builder_message(db, w.parent)


def test_variance_count_lowered_refuses(db, monkeypatch, lab):
    _generated(db, monkeypatch, lab, "P-7475", n=3,
               replicates=(("0.5", "variance_verified"), ("0.6", "variance_verified")))
    _order(monkeypatch, {ENDO_KEY: True, "variance": {ENDO_KEY: 2}})
    assert _refused(lab, db, "P-7475") == (
        "cannot publish P-7475: native sections: 'endotoxin-usp85-lal' bought 2 runs, "
        "2 replicate runs carry results on P-7475; take the extra vials out of the "
        "variance set")


def test_planned_profile_deferred_since_refuses(db, monkeypatch, lab):
    w = _generated(db, monkeypatch, lab, "P-7476")
    w.base.review_state = "to_be_verified"          # no eligible base result: deferred
    db.commit()
    assert _refused(lab, db, "P-7476") == STALE.format(sid="P-7476", detail=(
        "'endotoxin-usp85-lal' was printed on draft #1 and is deferred now"))


def test_core_run_parent_row_retested_with_a_new_value_refuses(db, monkeypatch, lab):
    w = _generated(db, monkeypatch, lab, "P-7477")
    w.base.retested = True
    w.base.review_state = "retracted"
    _parent_row(db, w.parent, w.svc, "1.5")
    db.commit()
    assert _refused(lab, db, "P-7477") == STALE.format(sid="P-7477", detail=(
        "'endotoxin-usp85-lal' run 1 member 'ENDOTOXIN-USP85LAL' printed 1.2 on draft #1, "
        "now 1.5"))


def test_draft_that_predates_the_record_refuses(db, monkeypatch, lab):
    _signed_world(db, monkeypatch, "P-7478")
    lab.badge = {"generation_number": 1, "verification_code": "V-1", "page1": None,
                 "overall_status": None}
    assert _refused(lab, db, "P-7478") == STALE.format(sid="P-7478", detail=(
        "draft #1 has no record of its Variance runs"))


def test_failed_order_lookup_refuses(db, monkeypatch, lab):
    _generated(db, monkeypatch, lab, "P-7465")

    def down(sid):
        raise ConnectionError("is down")
    monkeypatch.setattr("coa.native_sections.fetch_sample_services", down)
    assert _refused(lab, db, "P-7465") == (
        "cannot publish P-7465: native sections: order lookup failed for P-7465: is down")


def test_failed_draft_read_refuses(db, monkeypatch, lab):
    _generated(db, monkeypatch, lab, "P-7466")
    lab.badge = RuntimeError("db down")
    assert _refused(lab, db, "P-7466") == (
        "cannot publish P-7466: the draft certificate could not be read to check its "
        "Variance runs (RuntimeError); try again")


# ── out of scope or no four-test plan: publish exactly as at base ──────────

def test_hplc_variance_only_sample_publishes_as_at_base(db, monkeypatch, lab):
    parent = _parent(db, "P-7450")
    _vial(db, parent, 1, "hplc", "core")
    _vial(db, parent, 2, "hplc", "variance")
    _order(monkeypatch, {HPLC_KEY: True, "variance": {HPLC_KEY: 2}})
    db.commit()
    res = lab.run(db, "P-7450")
    assert {"response": res.model_dump(), "calls": lab.calls,
            "after_publish_native": lab.after} == _base_literal("P-7450")


def test_retest_sample_publishes_as_at_base(db, monkeypatch, lab):
    w = _endo_world(db, monkeypatch, "P-7451", n=3, replicates=(("0.5", "to_be_verified"),))
    w.parent.is_retest = True
    w.parent.retest_of_sample_id = "P-7000"
    db.commit()
    res = lab.run(db, "P-7451")
    assert {"response": res.model_dump(), "calls": lab.calls,
            "after_publish_native": lab.after} == _base_literal("P-7451")


def test_no_variance_vial_costs_two_selects_and_nothing_else(db, monkeypatch):
    _endo_world(db, monkeypatch, "P-7467", n=None, replicates=())

    def no_order(sid):
        raise AssertionError("the order must not be read")
    monkeypatch.setattr("coa.native_sections.fetch_sample_services", no_order)
    statements, badge_reads = [], []
    engine = db.get_bind()
    listener = lambda conn, cur, stmt, *a: statements.append(stmt)  # noqa: E731
    event.listen(engine, "before_cursor_execute", listener)
    try:
        reason = variance_publish_refusal(db, "P-7467",
                                          draft_badge=lambda: badge_reads.append(1))
    finally:
        event.remove(engine, "before_cursor_execute", listener)
    assert reason is None and badge_reads == []
    assert len(statements) == 2, statements
    assert "lims_sub_sample_events" in statements[0]
    assert "lims_sub_samples.assignment_kind" in statements[1]


# ── scheduled publish: refused, logged, not retried ────────────────────────

def test_scheduled_publish_refusal_is_logged_and_not_retried(factory, db, monkeypatch,
                                                             lab, caplog):
    w = _generated(db, monkeypatch, lab, "P-7468")
    _resign(db, w, "0.7")
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
    reason = STALE.format(sid="P-7468", detail=(
        "'endotoxin-usp85-lal' run 2 member 'ENDOTOXIN-USP85LAL' printed 0.5 on draft #1, "
        "now 0.7"))
    with caplog.at_level(logging.WARNING, logger=scheduled_publish.logger.name):
        stats = asyncio.run(scheduled_publish.run_due(factory, real_publish, now=now))
        again = asyncio.run(scheduled_publish.run_due(factory, real_publish,
                                                      now=now + timedelta(minutes=1)))
    assert stats["failed"] == 1 and again["failed"] == 0 and fired == ["P-7468"]
    s = factory()
    [row] = s.execute(select(LimsScheduledPublish)).scalars().all()
    assert (row.status, row.last_error) == ("failed", reason)
    s.close()
    assert f"scheduled_publish.failed sample=P-7468 err={reason}" in [
        r.getMessage() for r in caplog.records]
    assert lab.calls == []
