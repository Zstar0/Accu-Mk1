"""Tests for Task 7: passive analysis drift observer.

`workflow.observer.observe_parent_analyses` heals a parent's live shadow
rows (and logs an 'observed' transition) using SENAITE analysis data ALREADY
fetched for display by the two hook sites (lookup_senaite_sample's analyses
fetch, and the registry-debug panel's `_build_analysis_debug_rows`) — it
issues zero SENAITE calls of its own.

Seed idiom follows test_parent_mirror_hooks.py: a TEST-prefixed parent
LimsSample + a real seeded AnalysisService (non-null keyword), live
SessionLocal(), FK-safe cleanup (transitions -> analyses -> sample).
"""
from __future__ import annotations

import logging
from unittest.mock import patch

import pytest
from sqlalchemy import delete, select

from database import SessionLocal
from lims_analyses.parent_mirror import SHADOW_STATE
from models import AnalysisService, LimsAnalysis, LimsAnalysisTransition, LimsSample

TEST_SAMPLE_ID = "TEST-OBS7-PARENT"


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def analysis_service(db):
    """Pick any seeded analysis_service with a non-null keyword (house
    convention — never mutate shared seed data)."""
    svc = db.execute(
        select(AnalysisService).where(AnalysisService.keyword.isnot(None))
    ).scalars().first()
    if svc is None:
        pytest.skip("no seeded analysis_services row available")
    return svc


@pytest.fixture
def seed_parent(db):
    parent = LimsSample(sample_id=TEST_SAMPLE_ID, sample_type="x", status="received")
    db.add(parent)
    db.commit()
    db.refresh(parent)
    return parent


@pytest.fixture
def seed_shadow(db, seed_parent, analysis_service):
    """A live shadow row (provenance='shadow', retested=False) at
    mirror_review_state='verified', result_value='30' — the pre-drift
    baseline every test in this file heals away from."""
    row = LimsAnalysis(
        lims_sample_pk=seed_parent.id, analysis_service_id=analysis_service.id,
        keyword=analysis_service.keyword, title=analysis_service.title,
        review_state=SHADOW_STATE, provenance="shadow",
        mirror_review_state="verified", result_value="30",
        retested=False,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@pytest.fixture(autouse=True)
def cleanup(db):
    yield
    db.rollback()
    db.execute(delete(LimsAnalysisTransition).where(
        LimsAnalysisTransition.analysis_id.in_(
            select(LimsAnalysis.id).where(
                LimsAnalysis.lims_sample_pk.in_(
                    select(LimsSample.id).where(LimsSample.sample_id == TEST_SAMPLE_ID)
                )
            )
        )
    ))
    db.execute(delete(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk.in_(
            select(LimsSample.id).where(LimsSample.sample_id == TEST_SAMPLE_ID)
        )
    ))
    db.execute(delete(LimsSample).where(LimsSample.sample_id == TEST_SAMPLE_ID))
    db.commit()


# ═══════════════════════════════════════════════════════════════════════════
# observe_parent_analyses
# ═══════════════════════════════════════════════════════════════════════════


def test_state_drift_heals_shadow_and_logs_observed_transition(db, seed_shadow, analysis_service):
    from workflow.observer import observe_parent_analyses

    written = observe_parent_analyses(
        db, sample_id=TEST_SAMPLE_ID,
        observed=[{"keyword": analysis_service.keyword, "review_state": "published", "result": "30"}],
    )
    db.commit()

    assert written == 1
    db.refresh(seed_shadow)
    assert seed_shadow.mirror_review_state == "published"

    trans = db.execute(
        select(LimsAnalysisTransition).where(LimsAnalysisTransition.analysis_id == seed_shadow.id)
    ).scalars().all()
    assert len(trans) == 1
    assert trans[0].from_state == "verified"
    assert trans[0].to_state == "published"
    assert trans[0].transition_kind == "observed"
    assert trans[0].user_id is None
    assert trans[0].reason == "SENAITE-direct change observed via display fetch"


def test_no_drift_writes_nothing(db, seed_shadow, analysis_service):
    from workflow.observer import observe_parent_analyses

    written = observe_parent_analyses(
        db, sample_id=TEST_SAMPLE_ID,
        observed=[{"keyword": analysis_service.keyword, "review_state": "verified", "result": "30"}],
    )
    db.commit()

    assert written == 0
    db.refresh(seed_shadow)
    assert seed_shadow.mirror_review_state == "verified"
    assert seed_shadow.result_value == "30"
    assert db.execute(
        select(LimsAnalysisTransition).where(LimsAnalysisTransition.analysis_id == seed_shadow.id)
    ).scalars().all() == []


def test_no_shadow_row_writes_nothing(db, seed_parent, analysis_service):
    """No live shadow row exists yet for this keyword (pre-backfill) —
    observer must no-op; row creation belongs to the backfill, not here."""
    from workflow.observer import observe_parent_analyses

    written = observe_parent_analyses(
        db, sample_id=TEST_SAMPLE_ID,
        observed=[{"keyword": analysis_service.keyword, "review_state": "published", "result": "30"}],
    )
    db.commit()

    assert written == 0
    assert db.execute(
        select(LimsAnalysis).where(LimsAnalysis.lims_sample_pk == seed_parent.id)
    ).scalars().all() == []


def test_no_parent_row_writes_nothing(db, analysis_service):
    """sample_id not registered in lims_samples at all -> 0, no error."""
    from workflow.observer import observe_parent_analyses

    written = observe_parent_analyses(
        db, sample_id="TEST-OBS7-NO-SUCH-PARENT",
        observed=[{"keyword": analysis_service.keyword, "review_state": "published", "result": "30"}],
    )
    assert written == 0


def test_result_only_drift_heals_result_no_transition_row(db, seed_shadow, analysis_service):
    """State matches but result differs -> heal result_value only, write NO
    transition row (transitions log STATE changes, not result edits)."""
    from workflow.observer import observe_parent_analyses

    written = observe_parent_analyses(
        db, sample_id=TEST_SAMPLE_ID,
        observed=[{"keyword": analysis_service.keyword, "review_state": "verified", "result": "31"}],
    )
    db.commit()

    assert written == 0
    db.refresh(seed_shadow)
    assert seed_shadow.mirror_review_state == "verified"
    assert seed_shadow.result_value == "31"
    assert db.execute(
        select(LimsAnalysisTransition).where(LimsAnalysisTransition.analysis_id == seed_shadow.id)
    ).scalars().all() == []


def test_falsy_keyword_or_state_skipped(db, seed_shadow, analysis_service):
    from workflow.observer import observe_parent_analyses

    written = observe_parent_analyses(
        db, sample_id=TEST_SAMPLE_ID,
        observed=[
            {"keyword": None, "review_state": "published", "result": "99"},
            {"keyword": analysis_service.keyword, "review_state": None, "result": "99"},
            {"keyword": "", "review_state": "published", "result": "99"},
        ],
    )
    db.commit()

    assert written == 0
    db.refresh(seed_shadow)
    assert seed_shadow.mirror_review_state == "verified"
    assert seed_shadow.result_value == "30"


def test_retested_shadow_row_ignored_only_live_row_targeted(db, seed_parent, analysis_service):
    """A superseded (retested=True) shadow row must never be healed — only
    the live (retested=False) row represents current state, same idiom as
    parent_mirror._existing_shadow / the registry-debug panel's shadow_best
    selection."""
    from workflow.observer import observe_parent_analyses

    old = LimsAnalysis(
        lims_sample_pk=seed_parent.id, analysis_service_id=analysis_service.id,
        keyword=analysis_service.keyword, title=analysis_service.title,
        review_state=SHADOW_STATE, provenance="shadow",
        mirror_review_state="retracted", result_value="OLD",
        retested=True,
    )
    live = LimsAnalysis(
        lims_sample_pk=seed_parent.id, analysis_service_id=analysis_service.id,
        keyword=analysis_service.keyword, title=analysis_service.title,
        review_state=SHADOW_STATE, provenance="shadow",
        mirror_review_state="unassigned", result_value=None,
        retested=False,
    )
    db.add_all([old, live])
    db.commit()
    db.refresh(live)

    written = observe_parent_analyses(
        db, sample_id=TEST_SAMPLE_ID,
        observed=[{"keyword": analysis_service.keyword, "review_state": "to_be_verified", "result": "42"}],
    )
    db.commit()

    assert written == 1
    db.refresh(old)
    db.refresh(live)
    assert old.mirror_review_state == "retracted"  # untouched
    assert live.mirror_review_state == "to_be_verified"
    assert live.result_value == "42"


# ═══════════════════════════════════════════════════════════════════════════
# main._observe_parent_analyses_bg — own-session/never-raise wrapper
# ═══════════════════════════════════════════════════════════════════════════


def test_bg_wrapper_heals_on_its_own_session(db, seed_shadow, analysis_service):
    import main

    main._observe_parent_analyses_bg(
        sample_id=TEST_SAMPLE_ID,
        observed=[{"keyword": analysis_service.keyword, "review_state": "published", "result": "30"}],
    )

    db.expire_all()
    row = db.execute(
        select(LimsAnalysis).where(LimsAnalysis.id == seed_shadow.id)
    ).scalar_one()
    assert row.mirror_review_state == "published"


def test_bg_wrapper_never_raises_when_observer_explodes(caplog):
    import main

    with patch("workflow.observer.observe_parent_analyses", side_effect=RuntimeError("boom")), \
         caplog.at_level(logging.WARNING):
        main._observe_parent_analyses_bg(
            sample_id=TEST_SAMPLE_ID,
            observed=[{"keyword": "ANY-KW", "review_state": "published", "result": "1"}],
        )

    assert any("workflow.observer_failed" in rec.message for rec in caplog.records)


# ═══════════════════════════════════════════════════════════════════════════
# Hook site 2 (_build_analysis_debug_rows) — regression: the raw SENAITE
# Analysis fetch returns EVERY line for a keyword, including retest-
# superseded ones (no review_state filter). The observer's per-item loop has
# no dedup of its own, so it must be fed already-deduped current lines
# (select_current_lines — same reducer the backfill script uses), never the
# raw fetch. Feeding it raw duplicate-keyword lines would process both the
# current and the superseded line against the SAME shadow row, and whichever
# is processed last would win — silently corrupting a correctly-healed
# shadow back to a stale state and logging a bogus 'observed' transition.
# ═══════════════════════════════════════════════════════════════════════════


def _senaite_item(uid, keyword, **kw):
    base = {"uid": uid, "keyword": keyword, "result": None, "unit": None,
            "review_state": None, "retest_of_uid": None, "instrument_uid": None,
            "created": None}
    base.update(kw)
    return base


def test_hook2_dedupes_retest_chain_before_healing(db, seed_parent, seed_shadow, analysis_service):
    import main

    # The CURRENT line (a retest of U-OLD) carries the real new state; the
    # SUPERSEDED line still shows the old, already-healed-from state. Order
    # the superseded line LAST — the exact ordering that would corrupt an
    # undeduped per-line loop by "winning" the final write.
    current_line = _senaite_item(
        "U-NEW", analysis_service.keyword, result="35", review_state="to_be_verified",
        retest_of_uid="U-OLD",
    )
    superseded_line = _senaite_item(
        "U-OLD", analysis_service.keyword, result="30", review_state="verified",
    )
    with patch.object(main.senaite, "fetch_parent_analyses",
                       return_value=[current_line, superseded_line]):
        main._build_analysis_debug_rows(db, seed_parent, TEST_SAMPLE_ID)

    db.expire_all()
    row = db.execute(select(LimsAnalysis).where(LimsAnalysis.id == seed_shadow.id)).scalar_one()
    trans = db.execute(
        select(LimsAnalysisTransition).where(LimsAnalysisTransition.analysis_id == seed_shadow.id)
    ).scalars().all()

    # Correct (deduped) outcome: healed ONCE to the current line's state.
    assert row.mirror_review_state == "to_be_verified"
    assert row.result_value == "35"
    assert len(trans) == 1
    assert trans[0].from_state == "verified"
    assert trans[0].to_state == "to_be_verified"
    # The bug this guards against: an undeduped loop would additionally
    # process the superseded line second, flipping the shadow BACK to
    # "verified"/"30" and logging a second, fabricated transition.
