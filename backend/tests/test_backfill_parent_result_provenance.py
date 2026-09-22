"""scripts/backfill_parent_result_provenance.py

Catches up parent rows minted before slice 24: no captured_at, and the
promoter filed as the analyst. Values are derived off the promotion's own
source rows by the same function promote uses.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from lims_analyses.hplc_native import KW_PURITY
from lims_analyses.service import apply_transition, promote_to_parent
from models import AnalysisService, LimsAnalysis, LimsAnalysisTransition
from scripts.backfill_parent_result_provenance import backfill
from tests.hplc_native_family import native_family

BENCH, PROMOTER, SET_ON_PURPOSE = 1, 9, 4
quiet = dict(out=lambda *_: None)


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _old_style_parent(db, sample_id, *, analyst=PROMOTER):
    """A parent row the way promote minted it BEFORE slice 24."""
    _, _, _, vial_rows = native_family(db, sample_id=sample_id, slots=[("KPV", "KPV")])
    src = next(r for r in next(iter(vial_rows.values())) if r.keyword == KW_PURITY)
    apply_transition(db, analysis_id=src.id, kind="submit", result_value="99.1", user_id=BENCH)
    db.refresh(src)
    parent, _ = promote_to_parent(
        db, keyword=src.keyword, result_value="99.1", result_unit=None, method_id=None,
        instrument_id=None, user_id=PROMOTER,
        sources=[{"analysis_id": src.id, "contribution_kind": "chosen"}])
    parent.captured_at, parent.analyst_user_id = None, analyst
    db.commit()
    return parent, src


def test_dry_run_reports_and_writes_nothing(db):
    parent, _ = _old_style_parent(db, "P-7500")
    report = backfill(db, apply=False, **quiet)
    assert (report["mode"], report["rows_written"], report["captured_set"]) == ("dry-run", 1, 1)
    db.refresh(parent)
    assert parent.captured_at is None
    assert db.query(LimsAnalysisTransition).filter(
        LimsAnalysisTransition.reason.like("backfill:%")).count() == 0


def test_apply_fills_the_capture_time_and_leaves_the_analyst_alone_by_default(db):
    parent, src = _old_style_parent(db, "P-7501")
    report = backfill(db, apply=True, **quiet)
    db.refresh(parent)
    assert parent.captured_at == src.captured_at
    assert parent.analyst_user_id == PROMOTER and report["analyst_changed"] == 0
    assert parent.result_value == "99.1" and parent.review_state == "parent_to_verify"
    audit = db.query(LimsAnalysisTransition).filter(
        LimsAnalysisTransition.analysis_id == parent.id,
        LimsAnalysisTransition.reason.like("backfill:%")).one()
    assert (audit.transition_kind, audit.from_state, audit.to_state) == (
        "auto", "parent_to_verify", "parent_to_verify")
    assert "backfill_parent_result_provenance.py" in audit.reason and f"[{src.id}]" in audit.reason


def test_with_analyst_moves_the_promoter_default_but_never_a_deliberate_value(db):
    default_row, _ = _old_style_parent(db, "P-7502")
    report = backfill(db, apply=True, with_analyst=True, **quiet)
    db.refresh(default_row)
    assert default_row.analyst_user_id == BENCH and report["analyst_changed"] == 1
    audit = db.query(LimsAnalysisTransition).filter(
        LimsAnalysisTransition.analysis_id == default_row.id,
        LimsAnalysisTransition.reason.like("backfill:%")).one()
    assert audit.details["changed"]["analyst_user_id"] == {"before": PROMOTER, "after": BENCH}


def test_a_deliberately_set_analyst_is_never_overwritten(db):
    parent, _ = _old_style_parent(db, "P-7503", analyst=SET_ON_PURPOSE)
    report = backfill(db, apply=True, with_analyst=True, **quiet)
    db.refresh(parent)
    assert parent.analyst_user_id == SET_ON_PURPOSE and report["analyst_changed"] == 0
    assert parent.captured_at is not None                    # the additive part still lands


def test_rerun_is_a_no_op_and_a_row_without_a_promotion_is_reported(db):
    parent, _ = _old_style_parent(db, "P-7504")
    backfill(db, apply=True, **quiet)
    assert backfill(db, apply=True, **quiet)["candidate_rows"] == 0

    orphan = LimsAnalysis(lims_sample_pk=parent.lims_sample_pk, keyword=KW_PURITY,
                          analysis_service_id=parent.analysis_service_id, title="x",
                          provenance="canonical", review_state="retracted", retested=True)
    db.add(orphan); db.commit()
    report = backfill(db, apply=True, **quiet)
    assert report["rows_written"] == 0
    assert report["skipped_no_promotion"] == [("P-7504", orphan.id)]


def test_native_only_by_default(db):
    parent, _ = _old_style_parent(db, "P-7505")
    db.get(AnalysisService, parent.analysis_service_id).origin = "senaite"
    db.commit()
    assert backfill(db, apply=True, **quiet)["candidate_rows"] == 0
    assert backfill(db, apply=True, include_legacy=True, **quiet)["captured_set"] == 1
