"""Tests for the parent-analysis SENAITE->Mk1 shadow mirror helper (Task 2):
`resolve_shadow_target` + `mirror_parent_analysis` (create path only).

House pattern (see test_lims_analyses_service.py): module-local `db`
fixture = SessionLocal(); pick an existing seeded AnalysisService (skip
if none); create our own TEST-prefixed LimsSample per test; autouse
cleanup deletes TEST rows (transitions, then analyses, then the
LimsSample) after each test.
"""

from __future__ import annotations

import pytest
from sqlalchemy import delete, select

from database import SessionLocal
from lims_analyses.parent_mirror import (
    SHADOW_STATE, mark_parent_shadows_published, mirror_parent_analysis,
    resolve_shadow_target,
)
from models import AnalysisService, LimsAnalysis, LimsAnalysisTransition, LimsSample

TEST_SAMPLE_ID = "TEST-PM2-PARENT"
TEST_NOEXIST_SAMPLE_ID = "TEST-PM2-NOEXIST"
TEST_DUP_KEYWORD = "TEST-PM2-DUPKW"


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def analysis_service(db):
    """Pick any seeded analysis_service with a non-null keyword."""
    svc = db.execute(
        select(AnalysisService).where(AnalysisService.keyword.isnot(None))
    ).scalars().first()
    if svc is None:
        pytest.skip("no analysis_services row available")
    return svc


@pytest.fixture
def seed_parent_and_service(db, analysis_service):
    """A fresh TEST-prefixed parent LimsSample + an existing seeded service."""
    parent = LimsSample(sample_id=TEST_SAMPLE_ID, sample_type="x", status="received")
    db.add(parent)
    db.commit()
    db.refresh(parent)
    return parent, analysis_service


@pytest.fixture(autouse=True)
def cleanup(db):
    yield
    db.execute(delete(LimsAnalysisTransition).where(
        LimsAnalysisTransition.analysis_id.in_(
            select(LimsAnalysis.id).where(
                LimsAnalysis.lims_sample_pk.in_(
                    select(LimsSample.id).where(
                        LimsSample.sample_id.in_([TEST_SAMPLE_ID, TEST_NOEXIST_SAMPLE_ID])
                    )
                )
            )
        )
    ))
    db.execute(delete(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk.in_(
            select(LimsSample.id).where(
                LimsSample.sample_id.in_([TEST_SAMPLE_ID, TEST_NOEXIST_SAMPLE_ID])
            )
        )
    ))
    db.execute(delete(LimsSample).where(
        LimsSample.sample_id.in_([TEST_SAMPLE_ID, TEST_NOEXIST_SAMPLE_ID])
    ))
    # FIX 1 test seeds two TEST-prefixed AnalysisService rows sharing a
    # keyword — no other fixture in this file ever touches AnalysisService,
    # so it needs its own explicit cleanup to avoid polluting the shared
    # dev DB (and the `analysis_service` fixture's "first non-null keyword"
    # pick in every other test module).
    db.execute(delete(AnalysisService).where(AnalysisService.keyword == TEST_DUP_KEYWORD))
    db.commit()


def test_no_op_when_parent_not_in_registry(db, analysis_service):
    assert mirror_parent_analysis(
        db, sample_id=TEST_NOEXIST_SAMPLE_ID, keyword=analysis_service.keyword,
        mirror_review_state="to_be_verified", result_value="OK",
    ) is False


def test_creates_shadow_row_with_sentinel_state(db, seed_parent_and_service):
    parent, svc = seed_parent_and_service
    ok = mirror_parent_analysis(
        db, sample_id=parent.sample_id, keyword=svc.keyword,
        mirror_review_state="to_be_verified", result_value="99.2%",
    )
    assert ok is True
    row = db.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id, provenance="shadow").one()
    assert row.review_state == SHADOW_STATE
    assert row.mirror_review_state == "to_be_verified"
    assert row.result_value == "99.2%"
    assert row.analysis_service_id == svc.id
    tr = db.query(LimsAnalysisTransition).filter_by(analysis_id=row.id).all()
    assert len(tr) == 1  # audit row for the mirrored create


# ═══════════════════════════════════════════════════════════════════════════
# FIX 1: resolve_shadow_target must resolve a duplicate keyword deterministically
# ═══════════════════════════════════════════════════════════════════════════


@pytest.fixture
def dup_keyword_services(db):
    """Two TEST-prefixed AnalysisService rows sharing one keyword — prod
    precedent: a re-run of the analysis-services sync cloned two
    PUR_TB500BETA4 rows (see `service.py:73-81`'s identical defensive
    pattern). `keyword` carries no unique constraint on the model."""
    lower = AnalysisService(title="TEST: dup keyword lower", keyword=TEST_DUP_KEYWORD)
    db.add(lower)
    db.commit()
    db.refresh(lower)
    higher = AnalysisService(title="TEST: dup keyword higher", keyword=TEST_DUP_KEYWORD)
    db.add(higher)
    db.commit()
    db.refresh(higher)
    assert lower.id < higher.id
    return lower, higher


def test_resolve_shadow_target_dup_keyword_picks_lower_id(db, dup_keyword_services):
    lower, _higher = dup_keyword_services
    parent = LimsSample(sample_id=TEST_SAMPLE_ID, sample_type="x", status="received")
    db.add(parent)
    db.commit()
    db.refresh(parent)

    target = resolve_shadow_target(db, sample_id=parent.sample_id, keyword=TEST_DUP_KEYWORD)
    assert target is not None
    resolved_parent, resolved_svc = target
    assert resolved_parent.id == parent.id
    assert resolved_svc.id == lower.id  # deterministic: lower id wins


def test_mirror_parent_analysis_dup_keyword_succeeds_not_multipleresultsfound(
        db, dup_keyword_services):
    """Pre-fix, `scalar_one_or_none()` raises MultipleResultsFound on a dup
    keyword; the caller's best-effort guard swallows it, so every mirror
    write for that line silently no-ops forever. Post-fix this must succeed
    and land on the lower-id service deterministically."""
    lower, _higher = dup_keyword_services
    parent = LimsSample(sample_id=TEST_SAMPLE_ID, sample_type="x", status="received")
    db.add(parent)
    db.commit()
    db.refresh(parent)

    ok = mirror_parent_analysis(
        db, sample_id=parent.sample_id, keyword=TEST_DUP_KEYWORD,
        mirror_review_state="to_be_verified", result_value="1",
    )
    assert ok is True
    row = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, provenance="shadow"
    ).one()
    assert row.analysis_service_id == lower.id


def test_second_call_updates_same_shadow_row(db, seed_parent_and_service):
    parent, svc = seed_parent_and_service
    mirror_parent_analysis(db, sample_id=parent.sample_id, keyword=svc.keyword,
                           mirror_review_state="to_be_verified", result_value="1")
    mirror_parent_analysis(db, sample_id=parent.sample_id, keyword=svc.keyword,
                           mirror_review_state="verified")
    rows = db.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id, provenance="shadow").all()
    assert len(rows) == 1
    assert rows[0].mirror_review_state == "verified"
    assert rows[0].result_value == "1"  # unchanged fields preserved


def test_retest_creates_new_row_and_marks_old(db, seed_parent_and_service):
    parent, svc = seed_parent_and_service
    mirror_parent_analysis(db, sample_id=parent.sample_id, keyword=svc.keyword,
                           mirror_review_state="verified", result_value="1")
    mirror_parent_analysis(db, sample_id=parent.sample_id, keyword=svc.keyword,
                           mirror_review_state="verified", result_value="2", is_retest=True)
    rows = db.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id, provenance="shadow").order_by(LimsAnalysis.id).all()
    assert len(rows) == 2
    assert rows[0].retested is True
    assert rows[1].retest_of_id == rows[0].id and rows[1].retested is False


def test_retest_default_old_mirror_review_state_leaves_old_row_untouched(
        db, seed_parent_and_service):
    """Regression pin: the default (`old_mirror_review_state=None`) retest call
    must stay byte-identical to pre-existing behavior — the old row's
    mirror_review_state is left alone (SENAITE's real retest leaves the old
    line at whatever state it was, e.g. still 'verified'), only `retested`
    flips, and the audit reason stays 'shadow mirror: superseded by retest'."""
    parent, svc = seed_parent_and_service
    mirror_parent_analysis(db, sample_id=parent.sample_id, keyword=svc.keyword,
                           mirror_review_state="verified", result_value="1")
    mirror_parent_analysis(db, sample_id=parent.sample_id, keyword=svc.keyword,
                           mirror_review_state="unassigned", result_value="2", is_retest=True)
    rows = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, provenance="shadow"
    ).order_by(LimsAnalysis.id).all()
    assert len(rows) == 2
    old, new = rows
    assert old.retested is True
    assert old.mirror_review_state == "verified"  # untouched
    assert new.mirror_review_state == "unassigned"
    assert new.retest_of_id == old.id

    tr = db.query(LimsAnalysisTransition).filter_by(
        analysis_id=old.id, transition_kind="retest"
    ).one()
    assert tr.reason == "shadow mirror: superseded by retest"


def test_retest_with_old_mirror_review_state_updates_old_row_to_retracted(
        db, seed_parent_and_service):
    """The retract chain: passing `old_mirror_review_state="retracted"` must
    stamp the OLD row's mirror_review_state to 'retracted' (SENAITE's retract
    retires the original line, it doesn't leave it at its prior state) AND
    use the retract-specific audit reason, while the NEW row is born with
    whatever state/result the caller passes through (the retest copy)."""
    parent, svc = seed_parent_and_service
    mirror_parent_analysis(db, sample_id=parent.sample_id, keyword=svc.keyword,
                           mirror_review_state="verified", result_value="30")
    ok = mirror_parent_analysis(
        db, sample_id=parent.sample_id, keyword=svc.keyword,
        mirror_review_state="unassigned", result_value="30",
        is_retest=True, old_mirror_review_state="retracted",
    )
    assert ok is True
    rows = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, provenance="shadow"
    ).order_by(LimsAnalysis.id).all()
    assert len(rows) == 2
    old, new = rows
    assert old.retested is True
    assert old.mirror_review_state == "retracted"
    assert new.mirror_review_state == "unassigned"
    assert new.result_value == "30"
    assert new.retest_of_id == old.id
    assert new.retested is False

    tr = db.query(LimsAnalysisTransition).filter_by(
        analysis_id=old.id, transition_kind="retest"
    ).one()
    assert tr.reason == "shadow mirror: superseded by retract"


def test_update_after_retest_targets_retest_row_not_a_third(db, seed_parent_and_service):
    """Amendment 1 regression test: the pre-fix `_existing_shadow` filter
    (retest_of_id IS NULL AND retested IS FALSE) misses the live row after a
    retest (retest_of_id is set on the new row), so a further update call
    would fall into the create branch and mint a spurious THIRD row. The
    fixed filter (provenance='shadow' AND retested IS FALSE, newest first)
    must find the retest row and update it in place."""
    parent, svc = seed_parent_and_service
    mirror_parent_analysis(db, sample_id=parent.sample_id, keyword=svc.keyword,
                           mirror_review_state="verified", result_value="1")
    mirror_parent_analysis(db, sample_id=parent.sample_id, keyword=svc.keyword,
                           mirror_review_state="verified", result_value="2", is_retest=True)
    mirror_parent_analysis(db, sample_id=parent.sample_id, keyword=svc.keyword,
                           mirror_review_state="to_be_verified", result_value="3")
    rows = db.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id, provenance="shadow").order_by(LimsAnalysis.id).all()
    assert len(rows) == 2  # no spurious third row
    assert rows[0].retested is True
    assert rows[1].retest_of_id == rows[0].id
    assert rows[1].retested is False
    assert rows[1].result_value == "3"
    assert rows[1].mirror_review_state == "to_be_verified"


# ═══════════════════════════════════════════════════════════════════════════
# Task 8: A6 publish — mark_parent_shadows_published
# ═══════════════════════════════════════════════════════════════════════════


@pytest.fixture
def two_analysis_services(db):
    """Two distinct seeded services with non-null keyword — the shadow
    partial unique index is (lims_sample_pk, analysis_service_id) WHERE
    provenance='shadow' AND retested=FALSE, so two LIVE shadow rows for the
    same parent must sit on different services."""
    svcs = db.execute(
        select(AnalysisService).where(AnalysisService.keyword.isnot(None))
    ).scalars().all()[:2]
    if len(svcs) < 2:
        pytest.skip("need >=2 seeded analysis_services rows with a keyword")
    return svcs


def test_mark_shadows_published_no_op_when_parent_not_registered(db):
    assert mark_parent_shadows_published(db, sample_id=TEST_NOEXIST_SAMPLE_ID) == 0


def test_mark_shadows_published_flips_only_live_shadow_rows(
        db, seed_parent_and_service, two_analysis_services):
    parent, _ = seed_parent_and_service
    svc_a, svc_b = two_analysis_services

    live1 = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc_a.id,
        keyword=svc_a.keyword, title=svc_a.title,
        review_state=SHADOW_STATE, provenance="shadow",
        mirror_review_state="verified",
    )
    live2 = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc_b.id,
        keyword=svc_b.keyword, title=svc_b.title,
        review_state=SHADOW_STATE, provenance="shadow",
        mirror_review_state="to_be_verified",
    )
    db.add_all([live1, live2])
    db.commit()
    db.refresh(live1)
    db.refresh(live2)

    # A retested (superseded) shadow row on svc_a — must NOT flip, since
    # it's no longer live (retested=True).
    superseded = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc_a.id,
        keyword=svc_a.keyword, title=svc_a.title,
        review_state=SHADOW_STATE, provenance="shadow",
        mirror_review_state="verified", retested=True,
    )
    db.add(superseded)
    # A canonical (native) row — must NOT flip; publish there is a
    # separate native state machine.
    canonical = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc_a.id,
        keyword=svc_a.keyword, title=svc_a.title,
        review_state="verified", provenance="canonical",
    )
    db.add(canonical)
    db.commit()

    count = mark_parent_shadows_published(db, sample_id=parent.sample_id)
    db.commit()
    assert count == 2

    db.refresh(live1)
    db.refresh(live2)
    db.refresh(superseded)
    db.refresh(canonical)
    assert live1.mirror_review_state == "published"
    assert live2.mirror_review_state == "published"
    assert superseded.mirror_review_state == "verified"  # unchanged
    assert canonical.mirror_review_state is None  # unchanged (never set)


@pytest.fixture
def three_analysis_services(db):
    """Three distinct seeded services with non-null keyword. Needed (rather
    than reusing two_analysis_services) because the FIX 3 test below needs a
    dedicated service per live shadow row: the shadow partial unique index
    is (lims_sample_pk, analysis_service_id) WHERE provenance='shadow' AND
    retested=FALSE, so a rejected LIVE row (still retested=False) cannot
    share a service with another live row for the same parent."""
    svcs = db.execute(
        select(AnalysisService).where(AnalysisService.keyword.isnot(None))
    ).scalars().all()[:3]
    if len(svcs) < 3:
        pytest.skip("need >=3 seeded analysis_services rows with a keyword")
    return svcs


def test_mark_shadows_published_skips_rejected_and_retracted_live_shadows(
        db, seed_parent_and_service, three_analysis_services):
    """FIX 3: a live shadow row already stamped rejected/retracted (from
    A7-remove / A5-replace) must NOT flip to 'published' on AR publish — a
    removed/replaced analysis line doesn't publish with the AR. A live row
    with mirror_review_state still NULL (never stamped) MUST still flip:
    `NOT IN` against NULL is neither true nor false in SQL, so the fix has
    to explicitly OR in an IS NULL branch rather than relying on NOT IN
    alone."""
    parent, _ = seed_parent_and_service
    svc_ok, svc_rejected, svc_retracted = three_analysis_services

    live_ok = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc_ok.id,
        keyword=svc_ok.keyword, title=svc_ok.title,
        review_state=SHADOW_STATE, provenance="shadow",
        mirror_review_state=None,  # never stamped — must still flip
    )
    live_rejected = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc_rejected.id,
        keyword=svc_rejected.keyword, title=svc_rejected.title,
        review_state=SHADOW_STATE, provenance="shadow",
        mirror_review_state="rejected",
    )
    live_retracted = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc_retracted.id,
        keyword=svc_retracted.keyword, title=svc_retracted.title,
        review_state=SHADOW_STATE, provenance="shadow",
        mirror_review_state="retracted",
    )
    db.add_all([live_ok, live_rejected, live_retracted])
    db.commit()
    db.refresh(live_ok)
    db.refresh(live_rejected)
    db.refresh(live_retracted)

    count = mark_parent_shadows_published(db, sample_id=parent.sample_id)
    db.commit()
    assert count == 1  # only the NULL/unstamped row flips

    db.refresh(live_ok)
    db.refresh(live_rejected)
    db.refresh(live_retracted)
    assert live_ok.mirror_review_state == "published"
    assert live_rejected.mirror_review_state == "rejected"  # unchanged
    assert live_retracted.mirror_review_state == "retracted"  # unchanged
