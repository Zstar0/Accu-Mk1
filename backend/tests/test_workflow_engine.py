"""Side-by-side engine tests (2026-07-26 spec). House conventions:
live subvial DB via SessionLocal, TEST-prefixed fixtures, self-cleanup."""
from __future__ import annotations

from unittest.mock import patch

import pytest
from sqlalchemy import delete, select

from database import SessionLocal
from models import (LimsSample, LimsWorkflowShadowEvaluation,
                    LimsWorkflowState, LimsWorkflowTransition)


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def test_sample(db):
    """A TEST lims_samples row with native_status set; removed after."""
    row = LimsSample(sample_id="TEST-SBS-0001", status="sample_received",
                     native_status="test_sbs_received")
    db.add(row)
    db.flush()
    yield row
    db.execute(delete(LimsWorkflowShadowEvaluation).where(
        LimsWorkflowShadowEvaluation.lims_sample_pk == row.id))
    db.execute(delete(LimsSample).where(LimsSample.id == row.id))
    db.commit()


def test_shadow_evaluation_roundtrip(db, test_sample):
    db.add(LimsWorkflowShadowEvaluation(
        lims_sample_pk=test_sample.id, trigger="seed", verb=None,
        from_status=None, to_status="test_sbs_received",
        outcome="seeded", requirements_met=None, outcomes=[],
    ))
    db.flush()
    got = db.execute(select(LimsWorkflowShadowEvaluation).where(
        LimsWorkflowShadowEvaluation.lims_sample_pk == test_sample.id
    )).scalars().one()
    assert got.outcome == "seeded"
    assert got.outcomes == []
    assert got.evaluated_at is not None
    db.rollback()


def test_auto_fire_defaults_false(db):
    # Any existing transition row must expose auto_fire (bool, default False
    # on newly created rows).
    t = LimsWorkflowTransition.__table__.c
    assert "auto_fire" in t


def test_seed_data_carries_auto_fire_and_coa_published(db):
    """Verify seed data carries auto_fire and coa_published on first boot.

    This ensures fresh databases get the correct flags on first boot, rather
    than relying on post-seed UPDATEs that would find zero rows on empty DBs.
    """
    from workflow.seeds import SEED_TRANSITIONS

    # Parse seed data to verify correct tuples structure
    sample_transitions = {
        (row[0], row[1], row[2], row[3]): row
        for row in SEED_TRANSITIONS if row[0] == "sample"
    }

    # Verify sample submit edge has auto_fire=True AND is gated (finding #1):
    # the unconditional submit fired regardless of live analysis state.
    submit_key = ("sample", "sample_received", "to_be_verified", "submit")
    assert submit_key in sample_transitions, "submit transition missing"
    submit_row = sample_transitions[submit_key]
    assert submit_row[4] is True, "submit should have auto_fire=True"
    submit_reqs = submit_row[5]
    assert any(
        req["kind"] == "all_analyses_in_state"
        and req["value"] == "to_be_verified,verified,published"
        for req in submit_reqs
    ), "submit should require all_analyses_in_state=to_be_verified,verified,published"

    # Verify sample verify edge has auto_fire=True
    verify_key = ("sample", "to_be_verified", "verified", "verify")
    assert verify_key in sample_transitions, "verify transition missing"
    verify_row = sample_transitions[verify_key]
    assert verify_row[4] is True, "verify should have auto_fire=True"

    # Verify sample publish edge has coa_published in requirements
    publish_key = ("sample", "verified", "published", "publish")
    assert publish_key in sample_transitions, "publish transition missing"
    publish_row = sample_transitions[publish_key]
    publish_reqs = publish_row[5]
    assert any(req["kind"] == "coa_published" for req in publish_reqs), \
        "publish should have coa_published requirement"

    # Verify all other sample transitions default to auto_fire=False
    for key, row in sample_transitions.items():
        verb = key[3]
        if verb not in ("submit", "verify"):
            assert row[4] is False, f"{verb} should default to auto_fire=False"


from models import AnalysisService, LimsAnalysis


@pytest.fixture
def any_service(db):
    svc = db.execute(select(AnalysisService).where(
        AnalysisService.keyword.isnot(None))).scalars().first()
    if svc is None:
        pytest.skip("no seeded analysis_services")
    return svc


def _add_parent_line(db, sample, svc, state, provenance="canonical",
                     mirror_state=None, keyword=None):
    row = LimsAnalysis(
        lims_sample_pk=sample.id, lims_sub_sample_pk=None,
        analysis_service_id=svc.id, keyword=keyword or svc.keyword,
        title="TEST: sbs line", provenance=provenance,
        review_state=state if provenance == "canonical" else "senaite_mirror",
        mirror_review_state=mirror_state,
    )
    db.add(row)
    db.flush()
    return row


@pytest.fixture
def sbs_cleanup(db, test_sample):
    yield
    db.execute(delete(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == test_sample.id))
    db.commit()


def test_all_analyses_in_state_empty_set_is_unmet(db, test_sample, sbs_cleanup):
    from workflow.engine import evaluate_requirements
    met, outcomes = evaluate_requirements(
        db, test_sample,
        [{"kind": "all_analyses_in_state", "value": "verified", "note": None}])
    assert met is False
    assert outcomes[0]["detail"] == "no live parent analyses"


def test_all_analyses_in_state_comma_list_and_canonical_wins(
        db, test_sample, sbs_cleanup):
    from workflow.engine import evaluate_requirements
    # canonical verified + shadow (same keyword) published → canonical wins;
    # second keyword only-shadow to_be_verified.
    svcs = db.execute(select(AnalysisService).where(
        AnalysisService.keyword.isnot(None)
    )).scalars().all()
    if len(svcs) < 2:
        pytest.skip("need at least 2 seeded analysis_services")
    svc1, svc2 = svcs[0], svcs[1]

    _add_parent_line(db, test_sample, svc1, "verified")
    _add_parent_line(db, test_sample, svc1, None, provenance="shadow",
                     mirror_state="published")
    _add_parent_line(db, test_sample, svc2, None, provenance="shadow",
                     mirror_state="to_be_verified", keyword="TEST-KW2")
    met, _ = evaluate_requirements(
        db, test_sample,
        [{"kind": "all_analyses_in_state",
          "value": "verified,to_be_verified", "note": None}])
    assert met is True
    met2, _ = evaluate_requirements(
        db, test_sample,
        [{"kind": "all_analyses_in_state", "value": "verified", "note": None}])
    assert met2 is False   # TEST-KW2 is to_be_verified


def test_parent_to_verify_collapses_to_to_be_verified(
        db, test_sample, any_service, sbs_cleanup):
    """Task 8 / R1 routing: a canonical parent-tier line minted by Task 3's
    native promote sits in 'parent_to_verify' (submitted, awaiting the
    separate Mk1-side verify sign-off) until someone explicitly verifies it.
    The sample-scope shadow gates (all_analyses_in_state) were seeded before
    that state existed and only know 'to_be_verified,verified,published' --
    without a collapse, a promoted-but-unverified line would permanently
    stall the seeded submit edge. _live_parent_line_states reports
    'parent_to_verify' as 'to_be_verified' for these gates: semantically
    equivalent (submitted, awaiting sign-off); real catalog modeling of the
    state ships with the catalog release."""
    from workflow.engine import _live_parent_line_states, evaluate_requirements
    _add_parent_line(db, test_sample, any_service, "parent_to_verify")
    states = _live_parent_line_states(db, test_sample)
    assert states[any_service.keyword] == "to_be_verified"
    met, outcomes = evaluate_requirements(
        db, test_sample,
        [{"kind": "all_analyses_in_state",
          "value": "to_be_verified,verified,published", "note": None}])
    assert met is True, outcomes


def test_coa_published_attested_and_unknown_kind_fail_closed(db, test_sample):
    from workflow.engine import evaluate_requirements
    met, _ = evaluate_requirements(
        db, test_sample, [{"kind": "coa_published", "value": None, "note": None}],
        attested={"coa_published": True})
    assert met is True
    met2, out2 = evaluate_requirements(
        db, test_sample, [{"kind": "coa_published", "value": None, "note": None}])
    assert met2 is False
    met3, out3 = evaluate_requirements(
        db, test_sample, [{"kind": "bogus_kind", "value": "x", "note": None}])
    assert met3 is False and out3[0]["detail"] == "unknown kind"


def test_distinct_actor_evaluated_but_never_gates(db, test_sample):
    from workflow.engine import evaluate_requirements
    met, outcomes = evaluate_requirements(
        db, test_sample,
        [{"kind": "distinct_actor", "value": "submit", "note": None}],
        actor_user_id=None)
    assert met is True                      # non-gating: gate ignores it
    assert outcomes[0]["met"] is False      # ...but the outcome is recorded
    assert outcomes[0]["gates"] is False


@pytest.fixture
def sbs_catalog(db):
    """Private TEST slice of the sample-scope catalog:
    test_sbs_received --submit(auto)--> test_sbs_tbv --verify(auto, needs
    all verified)--> test_sbs_verified --publish(explicit, needs attested
    coa_published)--> test_sbs_published."""
    states = {}
    for slug in ("test_sbs_received", "test_sbs_tbv",
                 "test_sbs_verified", "test_sbs_published"):
        s = LimsWorkflowState(entity_scope="sample", slug=slug,
                              label=f"TEST {slug}", category="active",
                              sort_order=9000, is_builtin=False)
        db.add(s)
        db.flush()
        states[slug] = s
    def edge(f, t, verb, reqs, auto):
        e = LimsWorkflowTransition(
            entity_scope="sample", from_state_id=states[f].id,
            to_state_id=states[t].id, verb=verb, requirements=reqs,
            auto_fire=auto, is_builtin=False, sort_order=9000)
        db.add(e)
        db.flush()
        return e
    edge("test_sbs_received", "test_sbs_tbv", "test_submit",
         [{"kind": "all_analyses_in_state",
           "value": "to_be_verified,verified", "note": None}], True)
    edge("test_sbs_tbv", "test_sbs_verified", "test_verify",
         [{"kind": "all_analyses_in_state", "value": "verified",
           "note": None}], True)
    edge("test_sbs_verified", "test_sbs_published", "test_publish",
         [{"kind": "coa_published", "value": None, "note": None}], False)
    yield states
    db.execute(delete(LimsWorkflowTransition).where(
        LimsWorkflowTransition.verb.in_(
            ["test_submit", "test_verify", "test_publish"])))
    db.execute(delete(LimsWorkflowState).where(
        LimsWorkflowState.slug.like("test_sbs_%")))
    db.commit()


def test_execute_verb_advances_and_records(db, test_sample, any_service,
                                           sbs_catalog, sbs_cleanup):
    from workflow.engine import execute_verb
    _add_parent_line(db, test_sample, any_service, "verified")
    test_sample.native_status = "test_sbs_verified"
    row = execute_verb(db, test_sample, "test_publish", trigger="publish",
                       attested={"coa_published": True})
    assert row.outcome == "advanced"
    assert test_sample.native_status == "test_sbs_published"
    assert row.from_status == "test_sbs_verified"
    db.rollback()


def test_execute_verb_refuses_and_dedups(db, test_sample, any_service,
                                         sbs_catalog, sbs_cleanup):
    from workflow.engine import execute_verb
    test_sample.native_status = "test_sbs_verified"
    r1 = execute_verb(db, test_sample, "test_publish", trigger="publish")
    assert r1.outcome == "requirements_unmet"
    assert test_sample.native_status == "test_sbs_verified"   # unchanged
    r2 = execute_verb(db, test_sample, "test_publish", trigger="publish")
    assert r2 is None                                          # delta-dedup
    r3 = execute_verb(db, test_sample, "bogus_verb", trigger="publish")
    assert r3.outcome == "no_edge"
    db.rollback()


def test_execute_verb_skips_unseeded(db, sbs_catalog):
    from workflow.engine import execute_verb
    s = LimsSample(sample_id="TEST-SBS-NULL", status="sample_received",
                   native_status=None)
    db.add(s)
    db.flush()
    assert execute_verb(db, s, "test_publish", trigger="publish") is None
    db.rollback()


def test_cascades_chain_and_terminate(db, test_sample, any_service,
                                      sbs_catalog, sbs_cleanup):
    from workflow.engine import evaluate_cascades
    _add_parent_line(db, test_sample, any_service, "verified")
    test_sample.native_status = "test_sbs_received"
    rows = evaluate_cascades(db, test_sample, trigger="analysis_cascade")
    # submit fires (verified ∈ list), then verify fires (all verified);
    # publish is NOT auto_fire so the chain stops at verified.
    assert [r.outcome for r in rows] == ["advanced", "advanced"]
    assert test_sample.native_status == "test_sbs_verified"


# ── run_cascades_bg direct coverage (finding #4) ────────────────────────
#
# run_cascades_bg opens its OWN session (SessionLocal()) — a separate
# connection that cannot see another session's uncommitted rows. These tests
# therefore create + commit their own fixtures rather than reusing the
# `test_sample` fixture (which only flushes), and clean up committed rows in
# a finally rather than relying on rollback.

def test_run_cascades_bg_happy_path_advances_and_commits(
        db, any_service, sbs_catalog):
    from workflow.engine import run_cascades_bg
    sample = LimsSample(sample_id="TEST-SBS-BG-0001", status="sample_received",
                        native_status="test_sbs_received")
    db.add(sample)
    db.flush()
    _add_parent_line(db, sample, any_service, "verified")
    db.commit()
    try:
        run_cascades_bg(sample.id, None)
        db.expire_all()
        fresh = db.get(LimsSample, sample.id)
        assert fresh.native_status == "test_sbs_verified"
        evals = db.execute(select(LimsWorkflowShadowEvaluation).where(
            LimsWorkflowShadowEvaluation.lims_sample_pk == sample.id
        )).scalars().all()
        assert any(e.outcome == "advanced" and e.trigger == "analysis_cascade"
                   for e in evals)
    finally:
        db.execute(delete(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == sample.id))
        db.execute(delete(LimsWorkflowShadowEvaluation).where(
            LimsWorkflowShadowEvaluation.lims_sample_pk == sample.id))
        db.execute(delete(LimsSample).where(LimsSample.id == sample.id))
        db.commit()


def test_run_cascades_bg_failure_path_never_raises(db):
    from workflow.engine import run_cascades_bg
    sample = LimsSample(sample_id="TEST-SBS-BG-0002", status="sample_received",
                        native_status=None)
    db.add(sample)
    db.commit()
    try:
        with patch("workflow.engine.evaluate_cascades",
                   side_effect=RuntimeError("boom")):
            run_cascades_bg(sample.id, None)   # must not raise
    finally:
        db.execute(delete(LimsWorkflowShadowEvaluation).where(
            LimsWorkflowShadowEvaluation.lims_sample_pk == sample.id))
        db.execute(delete(LimsSample).where(LimsSample.id == sample.id))
        db.commit()
    db.rollback()


# ── boot-migration bindparam guard (2026-07-27, CRITICAL finding) ───────
#
# database._run_migrations() executes every statement as conn.execute(
# text(sql)) inside a per-statement try/except that logs 'migration_skipped'
# on ANY exception. SQLAlchemy's text() parses an unescaped `:token` as a
# bind parameter — the coa_published boot UPDATE's original
# '"value":null' JSON literal was silently parsed as bind param `null`,
# and every real boot then hit InvalidRequestError ("A value is required
# for bind parameter 'null'"), swallowed as migration_skipped forever. This
# never surfaced on fresh DBs (the catalog seed carries the requirement
# directly from first boot — Task 1's ordering fix), but on every EXISTING
# DB this UPDATE was the ONLY path, so the publish edge never gained the
# coa_published requirement post-upgrade. Guards the WHOLE migrations
# list, not just the sbs statements — this failure class can silently
# no-op ANY future raw-SQL migration with the same shape.
#
# Captures the exact TextClause objects _run_migrations() would execute by
# mocking `database.engine.connect()` — this runs the REAL function (so it
# can never drift from the real statement list) without touching the DB.

@pytest.fixture
def captured_migration_statements():
    import database

    captured = []

    class _FakeConn:
        def execute(self, clause):
            captured.append(clause)

        def commit(self):
            pass

        def rollback(self):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    with patch.object(database.engine, "connect", return_value=_FakeConn()):
        database._run_migrations()
    return captured


def test_boot_migration_statements_have_no_bindparams(
        captured_migration_statements):
    offenders = [(str(c)[:120], list(c._bindparams.keys()))
                 for c in captured_migration_statements if c._bindparams]
    assert offenders == [], (
        f"{len(offenders)} boot migration statement(s) contain an "
        "unescaped ':token' SQLAlchemy parses as a bind parameter — this "
        "silently no-ops the statement via migration_skipped on every "
        f"boot forever: {offenders}"
    )


def test_sbs_boot_statements_execute_against_live_db(
        captured_migration_statements, db):
    """Beyond zero-bindparams: actually EXECUTES the three sbs boot
    statements (auto_fire, coa_published, submit-gate) against the live
    dev DB, inside a transaction rolled back at the end — proves they bind
    AND parse AND run. A naive bindparam count alone would not have caught
    a statement that parses fine but fails on some other runtime error."""
    markers = ("auto_fire = TRUE", "coa_published", "all_analyses_in_state")
    sbs_stmts = [c for c in captured_migration_statements
                if any(m in str(c) for m in markers)]
    assert len(sbs_stmts) == 3, (
        f"expected exactly 3 sbs boot statements, found {len(sbs_stmts)}: "
        f"{[str(s)[:80] for s in sbs_stmts]}"
    )
    conn = db.connection()
    nested = conn.begin_nested()
    try:
        for stmt in sbs_stmts:
            conn.execute(stmt)   # must not raise
    finally:
        nested.rollback()
