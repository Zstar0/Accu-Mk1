# backend/tests/test_workflow_stranded.py
"""Detection, not sweeping (spec §6.2): one flag per stranded sample with
the diagnosis; resolves itself when the condition clears; writes nothing else."""
import json
from datetime import datetime, timezone

from sqlalchemy import select

from flags.models import FlagEntityLink, FlagFlag
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
    found = find_stranded(db_session)
    assert [(s.sample.sample_id, s.condition) for s in found] == [("P-ST-1", "lines_verified_status_behind")]
    stats = run_check(db_session, now=NOW)
    assert stats["flagged"] == 1
    flags = _flags(db_session)
    assert len(flags) == 1 and flags[0].status == "open"
    link = db_session.execute(select(FlagEntityLink).where(FlagEntityLink.flag_id == flags[0].id)).scalar_one()
    assert (link.entity_type, link.entity_id) == ("sample", "P-ST-1")
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
    assert [s.condition for s in find_stranded(db_session)] == ["published_in_ledger_not_status"]


def test_native_mirror_disagree_only_in_mk1_mode(db_session):
    from workflow.stranded import find_stranded
    _base(db_session, authority="mk1")
    db_session.add(LimsSample(sample_id="P-ST-4", status="sample_received", native_status="verified",
                              date_received=datetime(2026, 9, 1, tzinfo=timezone.utc)))
    db_session.flush()
    assert [s.condition for s in find_stranded(db_session)] == ["native_mirror_disagree"]


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
    assert [s.condition for s in find_stranded(db_session)] == ["senaite_tee_gave_up"]


def test_no_admin_user_skips_flagging(db_session):
    from workflow.stranded import run_check
    from flags.types_service import seed_builtins
    from workflow.seeds import seed_workflow_catalog
    seed_workflow_catalog(db_session)
    seed_builtins(db_session)
    _parent_with_verified_line(db_session, "P-ST-6", "sample_received")
    stats = run_check(db_session, now=NOW)
    assert stats["skipped_no_actor"] == 1 and _flags(db_session) == []
