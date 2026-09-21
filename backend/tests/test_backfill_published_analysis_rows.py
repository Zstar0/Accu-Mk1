"""scripts/backfill_published_analysis_rows.py

Moves parent rows that are already ON a published certificate from 'verified'
to 'published'. The rule that matters most: a row verified AFTER the last
publish is on no certificate, so it is reported and left alone. Prod
2026-09-21 had 8 such native rows on 6 samples among 279 candidates.
"""
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from models import (
    AnalysisService, LimsAnalysis, LimsAnalysisTransition, LimsSample,
    LimsSampleTransition, LimsSubSampleEvent,
)
from scripts.backfill_published_analysis_rows import backfill, last_publish_times

PUBLISHED_AT = datetime(2026, 9, 1, 12, 0, 0)


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def services(db):
    native = AnalysisService(title="Endotoxin", keyword="ENDOTOXIN-USP85LAL", origin="mk1")
    legacy = AnalysisService(title="Peptide Purity (HPLC)", keyword="HPLC-PUR", origin="senaite")
    db.add_all([native, legacy])
    db.commit()
    return {"mk1": native, "senaite": legacy}


def _sample(db, sample_id, *, status="published", ledger_publish=PUBLISHED_AT):
    s = LimsSample(sample_id=sample_id, status=status)
    db.add(s)
    db.flush()
    if ledger_publish is not None:
        db.add(LimsSampleTransition(lims_sample_pk=s.id, verb="publish", from_status="verified",
                                    to_status="published", source="mk1", occurred_at=ledger_publish))
    db.commit()
    return s


def _row(db, sample, svc, *, verified_at, state="verified", value="0.12", **over):
    r = LimsAnalysis(lims_sample_pk=sample.id, analysis_service_id=svc.id, keyword=svc.keyword,
                     title=svc.title, provenance="canonical", review_state=state,
                     result_value=value, verified_at=verified_at, **over)
    db.add(r)
    db.commit()
    return r


def test_dry_run_reports_and_writes_nothing(db, services):
    s = _sample(db, "P-8100")
    row = _row(db, s, services["mk1"], verified_at=PUBLISHED_AT - timedelta(hours=2))
    report = backfill(db, apply=False, out=lambda *_: None)
    assert (report["mode"], report["moved_rows"], report["moved_samples"]) == ("dry-run", 1, 1)
    db.refresh(row)
    assert row.review_state == "verified" and row.published_at is None
    assert db.query(LimsAnalysisTransition).count() == 0


def test_apply_moves_a_row_that_is_on_the_certificate(db, services):
    s = _sample(db, "P-8101")
    row = _row(db, s, services["mk1"], verified_at=PUBLISHED_AT - timedelta(hours=2))
    report = backfill(db, apply=True, out=lambda *_: None)
    assert report["moved_rows"] == 1 and report["by_keyword"]["ENDOTOXIN-USP85LAL"] == 1
    db.refresh(row)
    assert row.review_state == "published"
    assert row.published_at == PUBLISHED_AT                  # when it really went out, not now
    assert row.result_value == "0.12"                        # figure untouched
    audit = db.query(LimsAnalysisTransition).filter_by(analysis_id=row.id).one()
    assert (audit.transition_kind, audit.from_state, audit.to_state) == ("publish", "verified", "published")
    assert "backfill_published_analysis_rows.py" in audit.reason and "2026-09-01 12:00:00" in audit.reason


def test_a_row_verified_after_the_last_publish_is_left_alone_and_reported(db, services):
    """An add-on verified after the primary went out, or a retest promoted and
    never re-published: on no certificate. Marking it published would be false."""
    s = _sample(db, "P-8102")
    before = _row(db, s, services["mk1"], verified_at=PUBLISHED_AT - timedelta(days=1))
    svc2 = AnalysisService(title="Sterility PCR", keyword="STERILITY-PCR", origin="mk1")
    db.add(svc2); db.commit()
    after = _row(db, s, svc2, verified_at=PUBLISHED_AT + timedelta(days=2))

    report = backfill(db, apply=True, out=lambda *_: None)

    db.refresh(before); db.refresh(after)
    assert (before.review_state, after.review_state) == ("published", "verified")
    assert report["moved_rows"] == 1
    assert [(sid, kw) for sid, kw, *_ in report["skipped_verified_after_publish"]] == [
        ("P-8102", "STERILITY-PCR")]


def test_the_later_of_ledger_and_coa_published_event_is_the_last_publish(db, services):
    """An in-place regenerate + republish may not add a ledger row; every Mk1
    publish path does write a parent coa_published event."""
    s = _sample(db, "P-8103")
    republished = PUBLISHED_AT + timedelta(days=5)
    db.add(LimsSubSampleEvent(lims_sample_pk=s.id, event="coa_published", details={},
                              created_at=republished))
    db.commit()
    assert last_publish_times(db, [s.id])[s.id] == republished
    row = _row(db, s, services["mk1"], verified_at=PUBLISHED_AT + timedelta(days=2))
    assert backfill(db, apply=True, out=lambda *_: None)["moved_rows"] == 1
    db.refresh(row)
    assert (row.review_state, row.published_at) == ("published", republished)


def test_native_only_by_default_legacy_needs_the_flag(db, services):
    s = _sample(db, "P-8104")
    native = _row(db, s, services["mk1"], verified_at=PUBLISHED_AT - timedelta(hours=1))
    legacy = _row(db, s, services["senaite"], verified_at=PUBLISHED_AT - timedelta(hours=1))
    assert backfill(db, apply=True, out=lambda *_: None)["by_origin"] == {"mk1": 1}
    db.refresh(native); db.refresh(legacy)
    assert (native.review_state, legacy.review_state) == ("published", "verified")

    report = backfill(db, apply=True, include_legacy=True, out=lambda *_: None)
    assert report["by_origin"] == {"senaite": 1}
    db.refresh(legacy)
    assert legacy.review_state == "published"


def test_rerun_is_a_no_op_and_out_of_scope_rows_never_move(db, services):
    s = _sample(db, "P-8105")
    _row(db, s, services["mk1"], verified_at=PUBLISHED_AT - timedelta(hours=1))
    backfill(db, apply=True, out=lambda *_: None)
    assert backfill(db, apply=True, out=lambda *_: None)["candidate_rows"] == 0

    unpublished = _sample(db, "P-8106", status="verified", ledger_publish=None)
    a = _row(db, unpublished, services["mk1"], verified_at=PUBLISHED_AT)
    no_signal = _sample(db, "P-8107", ledger_publish=None)
    b = _row(db, no_signal, services["mk1"], verified_at=PUBLISHED_AT)
    pub = _sample(db, "P-8108")
    c = _row(db, pub, services["mk1"], verified_at=None)                           # no verified_at
    d = _row(db, pub, services["mk1"], verified_at=PUBLISHED_AT, retested=True)    # superseded
    e = _row(db, pub, services["mk1"], verified_at=PUBLISHED_AT, state="parent_to_verify")

    report = backfill(db, apply=True, out=lambda *_: None)
    assert report["moved_rows"] == 0
    assert report["skipped_no_publish_signal"] == ["P-8107"]
    assert report["skipped_no_verified_at"] == [("P-8108", "ENDOTOXIN-USP85LAL")]
    for r in (a, b, c, d, e):
        db.refresh(r)
        assert r.review_state != "published"


def test_sample_id_filter(db, services):
    rows = {}
    for sid in ("P-8110", "P-8111"):
        s = _sample(db, sid)
        rows[sid] = _row(db, s, services["mk1"], verified_at=PUBLISHED_AT - timedelta(hours=1))
    report = backfill(db, apply=True, sample_ids=["p-8110"], out=lambda *_: None)
    assert report["moved_samples"] == 1
    db.refresh(rows["P-8110"]); db.refresh(rows["P-8111"])
    assert (rows["P-8110"].review_state, rows["P-8111"].review_state) == ("published", "verified")
