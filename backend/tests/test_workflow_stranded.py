# backend/tests/test_workflow_stranded.py
"""Detection, not sweeping (spec §6.2): one flag per stranded sample with
the diagnosis; resolves itself when the condition clears; writes nothing else."""
import json
from datetime import datetime, timezone

from sqlalchemy import select

from flags.models import FlagFlag
from models import (AnalysisService, LimsAnalysis, LimsSample, LimsSampleTransition,
                    LimsSenaiteTeeRetry, Settings, User)

NOW = datetime(2026, 9, 9, 12, 0, tzinfo=timezone.utc)


def _base(db, authority="senaite"):
    from flags.types_service import seed_builtins
    from workflow.catalog import clear_sample_state_cache
    from workflow.seeds import seed_workflow_catalog
    clear_sample_state_cache()
    seed_workflow_catalog(db)
    seed_builtins(db)
    db.add(User(email="admin@x.t", hashed_password="x", role="admin"))
    db.add(Settings(key="registry_read_source", value=json.dumps({"sample_status": authority})))
    db.flush()


def _parent_with_verified_line(db, sid, status):
    p = LimsSample(sample_id=sid, status=status, native_status=status,
                   date_received=datetime(2026, 9, 1, tzinfo=timezone.utc))
    db.add(p)
    db.flush()
    svc = AnalysisService(keyword=f"K-{sid}", title="t")
    db.add(svc)
    db.flush()
    db.add(LimsAnalysis(lims_sample_pk=p.id, lims_sub_sample_pk=None, analysis_service_id=svc.id,
                        keyword=svc.keyword, title="t", review_state="verified",
                        provenance="canonical", retested=False))
    db.flush()
    return p


def _flags(db):
    return db.execute(select(FlagFlag).where(FlagFlag.type == "workflow_stranded")).scalars().all()


def test_lines_verified_but_status_behind_raises_one_flag(db_session):
    from workflow.stranded import find_stranded, run_check
    _base(db_session)
    p = _parent_with_verified_line(db_session, "P-ST-1", "sample_received")
    found = find_stranded(db_session, now=NOW)
    assert [(s.sample.sample_id, s.condition) for s in found] == [("P-ST-1", "lines_verified_status_behind")]
    stats = run_check(db_session, now=NOW)
    assert stats["flagged"] == 1
    flags = _flags(db_session)
    assert len(flags) == 1 and flags[0].status == "open"
    assert (flags[0].entity_type, flags[0].entity_id) == ("sample", "P-ST-1")
    # second run: no duplicate
    run_check(db_session, now=NOW)
    assert len(_flags(db_session)) == 1
    # status never touched
    assert p.status == "sample_received"


def test_flag_resolves_when_condition_clears(db_session):
    from workflow.stranded import run_check
    _base(db_session)
    p = _parent_with_verified_line(db_session, "P-ST-2", "sample_received")
    run_check(db_session, now=NOW)
    p.status = "verified"
    db_session.flush()
    stats = run_check(db_session, now=NOW)
    assert stats["resolved"] == 1
    assert _flags(db_session)[0].status == "resolved"


def test_published_in_ledger_but_not_status(db_session):
    from workflow.stranded import find_stranded
    _base(db_session)
    p = LimsSample(sample_id="P-ST-3", status="verified", native_status="verified",
                   date_received=datetime(2026, 9, 1, tzinfo=timezone.utc))
    db_session.add(p)
    db_session.flush()
    db_session.add(LimsSampleTransition(lims_sample_pk=p.id, verb="publish", from_status="verified",
                                        to_status="published", source="mk1", occurred_at=NOW))
    db_session.flush()
    assert [s.condition for s in find_stranded(db_session, now=NOW)] == ["published_in_ledger_not_status"]


def test_native_mirror_disagree_only_in_mk1_mode(db_session):
    from workflow.stranded import find_stranded
    _base(db_session, authority="mk1")
    db_session.add(LimsSample(sample_id="P-ST-4", status="sample_received", native_status="verified",
                              date_received=datetime(2026, 9, 1, tzinfo=timezone.utc)))
    db_session.flush()
    assert [s.condition for s in find_stranded(db_session, now=NOW)] == ["native_mirror_disagree"]


def test_null_date_received_falls_back_to_created_at(db_session):
    """P-2605 (2026-09-11): received on the SENAITE side, so date_received
    stayed NULL; native_status advanced ahead of the mirrored status across
    the authority flip and the scan never saw the row."""
    from workflow.stranded import find_stranded
    _base(db_session, authority="mk1")
    db_session.add(LimsSample(sample_id="P-ST-NULL", status="verified", native_status="published",
                              date_received=None, created_at=datetime(2026, 8, 31, 16, 57)))
    # Same shape but registered before the window: still out of scope.
    db_session.add(LimsSample(sample_id="P-ST-OLD", status="verified", native_status="published",
                              date_received=None, created_at=datetime(2026, 1, 1)))
    db_session.flush()
    found = find_stranded(db_session, now=NOW)
    assert [(s.sample.sample_id, s.condition) for s in found] == [("P-ST-NULL", "native_mirror_disagree")]


def test_gave_up_tee_is_stranded(db_session):
    from workflow.stranded import find_stranded
    _base(db_session)
    p = LimsSample(sample_id="P-ST-5", status="published", native_status="published",
                   date_received=datetime(2026, 9, 1, tzinfo=timezone.utc))
    db_session.add(p)
    db_session.flush()
    db_session.add(LimsSenaiteTeeRetry(lims_sample_pk=p.id, verb="publish", expected_state="published",
                                       attempts=8, next_attempt_at=NOW, status="gave_up"))
    db_session.flush()
    assert [s.condition for s in find_stranded(db_session, now=NOW)] == ["senaite_tee_gave_up"]


def test_no_admin_user_skips_flagging(db_session):
    from workflow.stranded import run_check
    from flags.types_service import seed_builtins
    from workflow.seeds import seed_workflow_catalog
    seed_workflow_catalog(db_session)
    seed_builtins(db_session)
    _parent_with_verified_line(db_session, "P-ST-6", "sample_received")
    stats = run_check(db_session, now=NOW)
    assert stats["skipped_no_actor"] == 1 and _flags(db_session) == []


def test_addon_pending_sample_is_not_stranded(db_session):
    """waiting_for_addon_results is the partial-publish parking state: the
    HPLC lines are verified, the add-on line may not even exist yet."""
    from workflow.stranded import find_stranded
    _base(db_session)
    _parent_with_verified_line(db_session, "P-ST-7", "waiting_for_addon_results")
    assert find_stranded(db_session, now=NOW) == []


def test_flag_first_comment_carries_the_diagnosis(db_session):
    from flags.models import FlagComment, FlagFlag
    from models import LimsWorkflowShadowEvaluation
    from workflow.stranded import run_check
    _base(db_session)
    p = _parent_with_verified_line(db_session, "P-ST-8", "sample_received")
    db_session.add(LimsWorkflowShadowEvaluation(
        lims_sample_pk=p.id, trigger="analysis_cascade", verb="submit",
        from_status="sample_received", to_status="sample_received",
        outcome="requirements_unmet", requirements_met=False,
        outcomes=[{"kind": "all_analyses_in_state", "met": False, "detail": "1 of 2 lines"}]))
    db_session.flush()
    run_check(db_session, now=NOW)
    flag = db_session.execute(select(FlagFlag).where(FlagFlag.type == "workflow_stranded")).scalar_one()
    assert (flag.entity_type, flag.entity_id) == ("sample", "P-ST-8")
    body = db_session.execute(select(FlagComment.body).where(FlagComment.flag_id == flag.id)
                              .order_by(FlagComment.id)).scalars().first()
    assert "Condition: lines_verified_status_behind" in body
    assert "verb=submit" in body and "requirements_unmet" in body and "all_analyses_in_state" in body


def test_resolve_adds_the_cleared_note(db_session):
    from flags.models import FlagComment, FlagFlag
    from workflow.stranded import run_check
    _base(db_session)
    p = _parent_with_verified_line(db_session, "P-ST-9", "sample_received")
    run_check(db_session, now=NOW)
    p.status = "verified"
    db_session.flush()
    run_check(db_session, now=NOW)
    flag = db_session.execute(select(FlagFlag).where(FlagFlag.type == "workflow_stranded")).scalar_one()
    assert flag.status == "resolved"
    bodies = db_session.execute(select(FlagComment.body).where(FlagComment.flag_id == flag.id)).scalars().all()
    assert any("Condition cleared" in b for b in bodies)


def test_orphan_free_dedupe_uses_the_primary_anchor(db_session):
    """A second run never mints a second flag, and no FlagEntityLink row is
    needed for the dedupe (the primary anchor columns carry it)."""
    from flags.models import FlagEntityLink, FlagFlag
    from workflow.stranded import run_check
    _base(db_session)
    _parent_with_verified_line(db_session, "P-ST-10", "sample_received")
    run_check(db_session, now=NOW)
    run_check(db_session, now=NOW)
    assert len(db_session.execute(select(FlagFlag).where(FlagFlag.type == "workflow_stranded")).scalars().all()) == 1
    assert db_session.execute(select(FlagEntityLink)).scalars().all() == []


def test_cancelled_after_publish_is_not_stranded(db_session):
    """Spec §8 lets a published sample be cancelled natively (the COA stays
    live), so the mk1 publish ledger row must not flag it forever. The same
    sample still verified IS stranded."""
    from workflow.stranded import find_stranded
    _base(db_session)
    p = LimsSample(sample_id="P-ST-11", status="cancelled", native_status="cancelled",
                   date_received=datetime(2026, 9, 1, tzinfo=timezone.utc))
    db_session.add(p)
    db_session.flush()
    db_session.add(LimsSampleTransition(lims_sample_pk=p.id, verb="publish", from_status="verified",
                                        to_status="published", source="mk1", occurred_at=NOW))
    db_session.flush()
    assert find_stranded(db_session, now=NOW) == []
    p.status = "verified"
    p.native_status = "verified"
    db_session.flush()
    assert [s.condition for s in find_stranded(db_session, now=NOW)] == ["published_in_ledger_not_status"]


def test_natively_cancelled_sample_with_verified_lines_is_not_stranded(db_session):
    """Cancelled natively while SENAITE refused the cancel (senaite_only): the
    mirror still reads sample_received and the lines are verified. That is the
    documented divergence, not a status lagging its lines."""
    from workflow.stranded import find_stranded
    _base(db_session)
    p = _parent_with_verified_line(db_session, "P-ST-12", "sample_received")
    p.native_status = "cancelled"
    db_session.flush()
    assert find_stranded(db_session, now=NOW) == []


def _gave_up(db, sid, status):
    """A sample carrying a gave_up publish tee row."""
    row = LimsSample(sample_id=sid, status=status, native_status=status,
                     date_received=datetime(2026, 9, 1, tzinfo=timezone.utc))
    db.add(row)
    db.flush()
    db.add(LimsSenaiteTeeRetry(
        lims_sample_pk=row.id, verb="publish", expected_state="published",
        status="gave_up", attempts=8, next_attempt_at=NOW))
    db.flush()
    return row


def test_cancelled_sample_never_flags_a_gave_up_tee(db_session):
    """Mk1 owns cancel (Handler ruling 2026-09-09): SENAITE is not kept in
    sync for a cancelled sample, so a gave_up tee row on one is not a
    stranding for the lab to chase. The same row on a live sample still is."""
    from workflow.stranded import find_stranded
    _base(db_session)
    _gave_up(db_session, "P-ST-90", "cancelled")
    assert find_stranded(db_session, now=NOW) == []

    _gave_up(db_session, "P-ST-91", "verified")
    found = find_stranded(db_session, now=NOW)
    assert [(f.sample.sample_id, f.condition) for f in found] == [
        ("P-ST-91", "senaite_tee_gave_up")]
