"""A result transition and a promote judge the row as COMMITTED, not as read.

apply_transition used to load its row with a plain get and promote_to_parent
its sources with a plain select, so two requests on one row both judged the
state they had read: the second then wrote from a state the row had already
left. Both now take the row under SELECT ... FOR UPDATE and re-read it.

Two connections and real row locks, so this file runs only when
MK1_TEST_POSTGRES_URL names a Postgres it may write to, and skips everywhere
else (the test_spec_unit_indexes_pg.py idiom). Everything runs in a throwaway
schema that is dropped afterwards.

Each test has request ONE hold the row (its transition flushed, not yet
committed) while request TWO starts on another connection, then lets ONE
commit and reads what TWO did.
"""
from __future__ import annotations

import os
import threading
import time
import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import sessionmaker

import models  # noqa: F401  (register the tables on Base, as init_db does)
import flags.models  # noqa: F401
import documents.models  # noqa: F401
import groups.models  # noqa: F401
import boards.models  # noqa: F401
from database import Base
from lims_analyses.promote_flow import PromoteError, run_promote
from lims_analyses.schemas import PromoteRequest
from lims_analyses.service import apply_transition
from lims_analyses.state_machine import InvalidTransitionError
from models import AnalysisService, LimsAnalysis, LimsAnalysisTransition, LimsSample, LimsSubSample

URL = os.environ.get("MK1_TEST_POSTGRES_URL")

pytestmark = pytest.mark.skipif(not URL, reason="set MK1_TEST_POSTGRES_URL to run the row lock tests")

USER = SimpleNamespace(id=None, email="qa@accumark.test")


@pytest.fixture
def pg(monkeypatch):
    """A session factory on a throwaway schema, and the id of one vial row."""
    # the real cascade opens its own session on the application's database
    monkeypatch.setattr("workflow.engine.run_cascades_bg", lambda parent_pk, user_id: None)
    schema = f"row_locks_{uuid.uuid4().hex[:8]}"
    admin = create_engine(URL)
    with admin.begin() as c:
        c.execute(text(f"CREATE SCHEMA {schema}"))
    engine = create_engine(URL, connect_args={"options": f"-csearch_path={schema}"})
    # as production: no autoflush (database.SessionLocal)
    make = sessionmaker(bind=engine, autoflush=False)
    sessions = []

    def new():
        s = make()
        sessions.append(s)
        return s

    try:
        Base.metadata.create_all(engine)
        yield new
    finally:
        for s in sessions:
            s.rollback()
            s.close()
        engine.dispose()
        with admin.begin() as c:
            c.execute(text(f"DROP SCHEMA {schema} CASCADE"))
        admin.dispose()


def _vial_row(db, *, state: str, value: str | None) -> int:
    svc = AnalysisService(title="Endotoxin USP85 LAL", keyword="ENDOTOXIN-USP85LAL",
                          origin="mk1", unit="EU/mL")
    parent = LimsSample(sample_id="P-7301", external_lims_uid="uid-P-7301")
    db.add_all([svc, parent])
    db.flush()
    vial = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid="uid-P-7301-S01",
                         sample_id="P-7301-S01", vial_sequence=1)
    db.add(vial)
    db.flush()
    row = LimsAnalysis(lims_sub_sample_pk=vial.id, analysis_service_id=svc.id, keyword=svc.keyword,
                       title=svc.title, result_value=value, review_state=state)
    db.add(row)
    db.commit()
    return row.id


def _second(fn):
    """Run request TWO on its own thread; its answer or its refusal."""
    out = {}

    def run():
        try:
            out["answer"] = fn()
        except Exception as e:  # noqa: BLE001  (the refusal is what the test reads)
            out["refusal"] = e

    t = threading.Thread(target=run)
    t.start()
    time.sleep(0.8)  # long enough to reach the row ONE holds
    assert t.is_alive(), f"request TWO did not wait for the row: {out}"
    return t, out


def _history(db, analysis_id: int):
    db.rollback()
    row = db.get(LimsAnalysis, analysis_id)
    db.refresh(row)
    moves = db.execute(
        select(LimsAnalysisTransition.transition_kind, LimsAnalysisTransition.from_state,
               LimsAnalysisTransition.to_state)
        .where(LimsAnalysisTransition.analysis_id == analysis_id)
        .order_by(LimsAnalysisTransition.id)).all()
    return (row.review_state, row.result_value, row.retested), [tuple(m) for m in moves]


def test_a_submit_that_waited_for_another_is_recorded_as_the_correction_it_is(pg):
    one, two, look = pg(), pg(), pg()
    aid = _vial_row(one, state="unassigned", value=None)
    apply_transition(one, analysis_id=aid, kind="submit", result_value="350", commit=False)

    t, out = _second(lambda: apply_transition(two, analysis_id=aid, kind="submit", result_value="349"))
    one.commit()
    t.join(15)

    assert "refusal" not in out, out
    row, moves = _history(look, aid)
    assert row[:2] == ("to_be_verified", "349")
    # the second submit found the row entered already: a correction, not a first entry
    assert moves == [("submit", "unassigned", "to_be_verified"),
                     ("submit", "to_be_verified", "to_be_verified")]


def test_a_correction_that_waited_for_a_reject_is_refused(pg):
    one, two, look = pg(), pg(), pg()
    aid = _vial_row(one, state="to_be_verified", value="350")
    apply_transition(one, analysis_id=aid, kind="reject", commit=False)

    t, out = _second(lambda: apply_transition(two, analysis_id=aid, kind="submit", result_value="349"))
    one.commit()
    t.join(15)

    assert isinstance(out.get("refusal"), InvalidTransitionError), out
    two.rollback()
    # nothing was written onto the rejected row
    assert _history(look, aid) == (("rejected", "350", False),
                                   [("reject", "to_be_verified", "rejected")])


def test_a_retest_that_waited_for_a_reject_is_refused(pg):
    one, two, look = pg(), pg(), pg()
    aid = _vial_row(one, state="to_be_verified", value="350")
    apply_transition(one, analysis_id=aid, kind="reject", commit=False)

    t, out = _second(lambda: apply_transition(two, analysis_id=aid, kind="retest"))
    one.commit()
    t.join(15)

    assert isinstance(out.get("refusal"), InvalidTransitionError), out
    two.rollback()
    assert _history(look, aid) == (("rejected", "350", False),
                                   [("reject", "to_be_verified", "rejected")])
    # and no retest row was minted for a rejected run
    assert look.execute(select(LimsAnalysis.id).where(LimsAnalysis.retest_of_id == aid)).all() == []


def test_a_method_restamp_that_waited_for_a_reject_is_refused(pg):
    """The restamp's own state guard (R7: a reported or dead row is locked)
    is judged on the row as committed too."""
    from lims_analyses.service import StateLockedError, set_method_instrument

    one, two, look = pg(), pg(), pg()
    aid = _vial_row(one, state="to_be_verified", value="350")
    apply_transition(one, analysis_id=aid, kind="reject", commit=False)

    t, out = _second(lambda: set_method_instrument(two, analysis_id=aid, method_id=None,
                                                    instrument_id=None))
    one.commit()
    t.join(15)

    assert isinstance(out.get("refusal"), StateLockedError), out


def test_a_promote_that_waited_for_a_correction_is_refused(pg):
    one, two, look = pg(), pg(), pg()
    aid = _vial_row(one, state="to_be_verified", value="25")
    apply_transition(one, analysis_id=aid, kind="submit", result_value="27", commit=False)

    req = PromoteRequest(keyword="ENDOTOXIN-USP85LAL", result_value="25", sources=[{
        "analysis_id": aid, "contribution_kind": "chosen",
        "seen_result_value": "25", "seen_result_unit": "EU/mL"}])
    t, out = _second(lambda: run_promote(two, USER, req))
    one.commit()
    t.join(15)

    refusal = out.get("refusal")
    assert isinstance(refusal, PromoteError), out
    assert (refusal.status, refusal.code) == (409, "source_changed")
    assert "it now reads 27 EU/mL" in refusal.detail
    # the vial keeps its corrected result and no parent row carries the old one
    assert _history(look, aid)[0] == ("to_be_verified", "27", False)
    assert look.execute(select(LimsAnalysis.id).where(
        LimsAnalysis.lims_sub_sample_pk.is_(None))).all() == []
