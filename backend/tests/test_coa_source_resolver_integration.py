"""Phase 5a: integration tests for the COA source resolver against the live DB.

Seeds real lims_analyses parent-tier rows (via promote_to_parent) so the
Mk1-first dispatch fires against the production code path. Mirrors
test_variance_set.py / test_lims_analyses_service.py conventions: each
test cleans up its TEST: titled rows after running.
"""

from __future__ import annotations

import asyncio
from typing import Dict, List

import pytest
from sqlalchemy import delete, select, func

from coa.source_resolver import resolve_sources
from database import SessionLocal
from lims_analyses.service import (
    apply_transition, create_analysis, promote_to_parent,
)
from models import (
    AnalysisService,
    CoaResultPin,
    LimsAnalysis,
    LimsAnalysisPromotion,
    LimsAnalysisTransition,
    LimsSample,
    LimsSubSample,
)


class _FakeSenaiteReader:
    """Test double — returns whatever the test set up in `payload`."""

    def __init__(self, payload: Dict[str, List[dict]] | None = None):
        self.payload = payload or {}

    async def list_for_sample(self, sample_id: str) -> List[dict]:
        return list(self.payload.get(sample_id, []))


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def analysis_service(db):
    svc = db.execute(
        select(AnalysisService).where(AnalysisService.keyword.isnot(None))
    ).scalars().first()
    if svc is None:
        pytest.skip("no analysis_services row available")
    return svc


@pytest.fixture
def clean_sub(db, analysis_service):
    """Find a sub-sample with no non-retest row for the analysis_service's
    keyword. Returns the sub OR skips."""
    stmt = (
        select(LimsSubSample)
        .where(~select(LimsAnalysis.id).where(
            LimsAnalysis.lims_sub_sample_pk == LimsSubSample.id,
            LimsAnalysis.keyword == analysis_service.keyword,
            LimsAnalysis.retest_of_id.is_(None),
        ).exists())
    )
    sub = db.execute(stmt).scalars().first()
    if sub is None:
        pytest.skip("no sub-sample free of keyword")
    return sub


@pytest.fixture(autouse=True)
def cleanup(db):
    """Wipe any TEST: titled rows + their cascades after each test.

    Also wipe pins targeting mk1: UIDs — these only exist from prior test
    runs of this file (real production pins use SENAITE 32-char hex UIDs
    in this stack; mk1: pins are exclusively test fixtures until Phase 5b+).
    Without this, a leftover pin causes subsequent runs to surface stale_pin
    instead of the test's intended mode='auto'.
    """
    yield
    # Promotions first (no cascade from analyses-via-source if source still exists)
    db.execute(delete(LimsAnalysisPromotion).where(
        LimsAnalysisPromotion.parent_analysis_id.in_(
            select(LimsAnalysis.id).where(LimsAnalysis.title.like("TEST:%"))
        )
    ))
    db.execute(delete(LimsAnalysisTransition).where(
        LimsAnalysisTransition.reason.like("TEST:%")
    ))
    db.execute(delete(LimsAnalysis).where(LimsAnalysis.title.like("TEST:%")))
    db.execute(delete(CoaResultPin).where(
        CoaResultPin.source_analysis_uid.like("mk1:%")
    ))
    db.commit()


def _make_vial_to_be_verified(db, sub, svc, result="98.55"):
    """Create a vial-tier analysis on `sub` for `svc` + walk to to_be_verified."""
    row = create_analysis(
        db, host_kind="sub_sample", host_pk=sub.id,
        analysis_service_id=svc.id, keyword=svc.keyword,
        title=f"TEST: integration {svc.keyword}",
    )
    apply_transition(db, analysis_id=row.id, kind="assign",
                     reason="TEST: integration assign")
    apply_transition(db, analysis_id=row.id, kind="submit",
                     result_value=result, reason="TEST: integration submit")
    return row


def _promote_to_parent_row(db, src, svc, value):
    """Promote `src` to a parent-tier row, verify it, return the parent_row.

    Task 3: promote mints 'parent_to_verify', not 'verified' — this helper's
    callers exercise the resolver's live-candidate path, which requires
    'verified'/'published'. The verify step here keeps this fixture matching
    what it always meant to seed: a reviewed, resolvable parent-tier row.
    Task 6 narrowed parent-tier resolution to (verified, published) only —
    this verified fixture stays green under that change.
    """
    parent_row, _ = promote_to_parent(
        db, keyword=svc.keyword, result_value=value, result_unit=None,
        method_id=None, instrument_id=None,
        sources=[{"analysis_id": src.id, "contribution_kind": "chosen"}],
        reason="TEST: integration promote",
    )
    apply_transition(db, analysis_id=parent_row.id, kind="verify",
                     reason="TEST: integration verify")
    parent_row.title = "TEST: parent " + parent_row.title
    db.commit()
    return parent_row


# ── Tests ────────────────────────────────────────────────────────────────────


def test_resolve_sources_returns_mode_auto_for_promoted_parent_tier_row(db, clean_sub, analysis_service):
    """Spec Phase 5 acceptance #1: a Model D family with a promoted parent-tier
    row resolves to mode='auto' with no SENAITE round-trip needed for that analyte."""
    src = _make_vial_to_be_verified(db, clean_sub, analysis_service)
    parent_row = _promote_to_parent_row(db, src, analysis_service, "98.55")
    parent = db.get(LimsSample, parent_row.lims_sample_pk)
    assert parent is not None

    reader = _FakeSenaiteReader()  # empty — SENAITE has nothing for this parent
    res = asyncio.run(resolve_sources(parent.sample_id, db, reader))

    matching = [d for d in res.decisions if d.analyte_keyword == analysis_service.keyword]
    assert matching, f"no decision for {analysis_service.keyword!r}; got {[d.analyte_keyword for d in res.decisions]}"
    d = matching[0]
    assert d.mode == "auto"
    assert d.blocked is None
    assert d.chosen is not None
    assert d.chosen.source_analysis_uid == f"mk1:{parent_row.id}"
    assert d.chosen.value == "98.55"


def test_resolve_sources_does_not_query_sub_sample_senaite_ars(db, clean_sub, analysis_service):
    """A sub-sample with a SENAITE candidate but NO Mk1 parent-tier row
    produces no decision for that analyte under Phase 5a (sub ARs aren't
    queried; the only SENAITE data the resolver consults is the parent AR)."""
    parent = db.get(LimsSample, clean_sub.parent_sample_pk)
    fake_payload = {
        # SENAITE returns a verified candidate on the SUB, NOT the parent
        clean_sub.sample_id: [
            {"uid": "should-not-be-read", "keyword": analysis_service.keyword,
             "result": "ignored", "unit": "%", "review_state": "verified"},
        ],
        parent.sample_id: [],  # parent AR has nothing
    }
    reader = _FakeSenaiteReader(payload=fake_payload)
    res = asyncio.run(resolve_sources(parent.sample_id, db, reader))

    matching = [d for d in res.decisions if d.analyte_keyword == analysis_service.keyword]
    assert matching == [], (
        f"expected no decision for {analysis_service.keyword!r} (sub-sample SENAITE "
        f"candidates ignored under Phase 5a); got {matching}"
    )


def test_resolve_sources_mk1_parent_tier_shadows_senaite_parent_candidate(db, clean_sub, analysis_service):
    """If both a Mk1 parent-tier row AND a SENAITE parent-AR candidate exist
    for the same keyword, the Mk1 row wins (mode='auto', uid=mk1:N)."""
    src = _make_vial_to_be_verified(db, clean_sub, analysis_service)
    parent_row = _promote_to_parent_row(db, src, analysis_service, "98.55")
    parent = db.get(LimsSample, parent_row.lims_sample_pk)

    fake_payload = {
        parent.sample_id: [
            {"uid": "senaite-uid-shadowed", "keyword": analysis_service.keyword,
             "result": "99.99", "unit": "%", "review_state": "verified"},
        ],
    }
    reader = _FakeSenaiteReader(payload=fake_payload)
    res = asyncio.run(resolve_sources(parent.sample_id, db, reader))

    decisions_for_kw = [d for d in res.decisions if d.analyte_keyword == analysis_service.keyword]
    assert len(decisions_for_kw) == 1
    d = decisions_for_kw[0]
    assert d.chosen is not None
    assert d.chosen.source_analysis_uid == f"mk1:{parent_row.id}"
    assert d.chosen.value == "98.55"  # Mk1's value, not SENAITE's "99.99"


def test_resolve_sources_senaite_only_parent_uses_legacy_path(db, analysis_service):
    """A parent with NO Mk1 parent-tier row but a SENAITE candidate falls
    through to _resolve_analyte → mode='auto' with the SENAITE uid."""
    parent = db.execute(select(LimsSample).limit(1)).scalars().first()
    if parent is None:
        pytest.skip("no parent samples in DB")
    # Skip if this parent happens to have a Mk1 row for this keyword
    existing = db.execute(
        select(func.count(LimsAnalysis.id)).where(
            LimsAnalysis.lims_sample_pk == parent.id,
            LimsAnalysis.keyword == analysis_service.keyword,
            LimsAnalysis.retest_of_id.is_(None),
        )
    ).scalar()
    if existing > 0:
        pytest.skip("parent already has a Mk1 row for the keyword")

    fake_payload = {
        parent.sample_id: [
            {"uid": "senaite-legacy-uid", "keyword": analysis_service.keyword,
             "result": "42.0", "unit": "%", "review_state": "verified"},
        ],
    }
    reader = _FakeSenaiteReader(payload=fake_payload)
    res = asyncio.run(resolve_sources(parent.sample_id, db, reader))

    matching = [d for d in res.decisions if d.analyte_keyword == analysis_service.keyword]
    assert matching, "expected a decision from the SENAITE legacy path"
    d = matching[0]
    assert d.chosen is not None
    assert d.chosen.source_analysis_uid == "senaite-legacy-uid"
    assert d.chosen.value == "42.0"


def test_resolve_sources_excludes_senaite_superseded_retest(db, analysis_service):
    """Regression for P-0895 (pre-subsample retested sample): a SENAITE-only
    parent with a retest pair — the superseded original AND the retest of it,
    both still 'verified' in SENAITE — must resolve to the RETEST (mode='auto'),
    not block on needs_decision. The superseded original (its UID is the target
    of the retest's retest_of_uid) is excluded from candidates."""
    parent = db.execute(select(LimsSample).limit(1)).scalars().first()
    if parent is None:
        pytest.skip("no parent samples in DB")
    existing = db.execute(
        select(func.count(LimsAnalysis.id)).where(
            LimsAnalysis.lims_sample_pk == parent.id,
            LimsAnalysis.keyword == analysis_service.keyword,
            LimsAnalysis.retest_of_id.is_(None),
        )
    ).scalar()
    if existing > 0:
        pytest.skip("parent already has a Mk1 row for the keyword")

    fake_payload = {
        parent.sample_id: [
            # Superseded original — still 'verified' in SENAITE; its UID is the
            # target of the retest below. Must be excluded.
            {"uid": "orig-uid", "keyword": analysis_service.keyword,
             "result": "Conforms", "unit": "%", "review_state": "verified",
             "retest_of_uid": None},
            # The retest (points at the original via retest_of_uid) — report this.
            {"uid": "retest-uid", "keyword": analysis_service.keyword,
             "result": "99.93", "unit": "%", "review_state": "verified",
             "retest_of_uid": "orig-uid"},
        ],
    }
    reader = _FakeSenaiteReader(payload=fake_payload)
    res = asyncio.run(resolve_sources(parent.sample_id, db, reader))

    matching = [d for d in res.decisions if d.analyte_keyword == analysis_service.keyword]
    assert matching, "expected a decision"
    d = matching[0]
    assert d.blocked is None, f"should not block; got blocked={d.blocked!r}: {d.blocked_detail}"
    assert d.mode == "auto"
    assert d.chosen is not None
    assert d.chosen.source_analysis_uid == "retest-uid"
    assert d.chosen.value == "99.93"


def test_resolve_sources_mk1_to_be_verified_row_does_not_resolve(db, clean_sub, analysis_service):
    """Task 6: a parent-tier row in to_be_verified state (not yet the
    reviewer's verify sign-off) must NOT resolve as a live candidate — this
    pins the fail-closed fix for the divergence where _resolve_mk1_parent_tier
    passed _LIVE_RESULT_STATES (submitted/to_be_verified/verified/published)
    while its own docstring claimed verified/published-only. Before the fix a
    to_be_verified row would have been silently certified onto a COA."""
    # Insert a parent-tier row directly at to_be_verified to exercise the state
    # gate in _resolve_mk1_parent_tier without going through the full promote path.
    parent = db.get(LimsSample, clean_sub.parent_sample_pk)
    parent_row = create_analysis(
        db, host_kind="sample", host_pk=parent.id,
        analysis_service_id=analysis_service.id, keyword=analysis_service.keyword,
        title=f"TEST: tbv {analysis_service.keyword}",
    )
    parent_row.review_state = "to_be_verified"
    parent_row.result_value = "95.1"
    parent_row.reportable = True
    db.commit()

    # Precondition: the fixture really did write a to_be_verified row with a
    # live result — otherwise the "does not resolve" assertion below would
    # pass vacuously for the wrong reason (e.g. a broken fixture).
    reloaded = db.get(LimsAnalysis, parent_row.id)
    assert reloaded.review_state == "to_be_verified"
    assert reloaded.result_value == "95.1"

    reader = _FakeSenaiteReader()
    res = asyncio.run(resolve_sources(parent.sample_id, db, reader))

    matching = [d for d in res.decisions if d.analyte_keyword == analysis_service.keyword]
    assert not any(
        d.chosen is not None and d.chosen.source_analysis_uid == f"mk1:{parent_row.id}"
        for d in matching
    ), f"to_be_verified parent-tier row {parent_row.id} must not resolve; got {matching}"


def test_resolve_sources_mk1_parent_to_verify_row_does_not_resolve(db, clean_sub, analysis_service):
    """A parent-tier row in parent_to_verify state (promoted, awaiting the
    reviewer's verify sign-off) must not resolve as a live candidate either.
    parent_to_verify was never in _LIVE_RESULT_STATES, so this was already
    excluded before Task 6 — pinned here as an explicit control alongside
    the to_be_verified fail-closed fix."""
    parent = db.get(LimsSample, clean_sub.parent_sample_pk)
    parent_row = create_analysis(
        db, host_kind="sample", host_pk=parent.id,
        analysis_service_id=analysis_service.id, keyword=analysis_service.keyword,
        title=f"TEST: ptv {analysis_service.keyword}",
    )
    parent_row.review_state = "parent_to_verify"
    parent_row.result_value = "95.1"
    parent_row.reportable = True
    db.commit()

    reloaded = db.get(LimsAnalysis, parent_row.id)
    assert reloaded.review_state == "parent_to_verify"
    assert reloaded.result_value == "95.1"

    reader = _FakeSenaiteReader()
    res = asyncio.run(resolve_sources(parent.sample_id, db, reader))

    matching = [d for d in res.decisions if d.analyte_keyword == analysis_service.keyword]
    assert not any(
        d.chosen is not None and d.chosen.source_analysis_uid == f"mk1:{parent_row.id}"
        for d in matching
    ), f"parent_to_verify parent-tier row {parent_row.id} must not resolve; got {matching}"


def test_resolve_sources_mk1_pin_to_be_verified_row_blocks_stale_pin(db, clean_sub, analysis_service):
    """Task 6 self-review: _apply_pin_override's mk1: branch reads the SAME
    parent-tier rows _resolve_mk1_parent_tier does (both keyed by the
    'mk1:{id}' uid _resolve_mk1_parent_tier mints), and its own docstring
    already claims 'verify it's still verified/published' — but the code
    passed the broader _LIVE_RESULT_STATES. An admin pin targeting a
    to_be_verified parent-tier row must block as stale_pin, not resolve.

    SENAITE must surface *something* for this keyword (even an empty/missing
    candidate) so the analyte enters resolve_sources' merged keyword set at
    all — otherwise the pin override layer is never reached and this test
    would vacuously pass for the wrong reason (no decision emitted)."""
    parent = db.get(LimsSample, clean_sub.parent_sample_pk)
    parent_row = create_analysis(
        db, host_kind="sample", host_pk=parent.id,
        analysis_service_id=analysis_service.id, keyword=analysis_service.keyword,
        title=f"TEST: tbv pin {analysis_service.keyword}",
    )
    parent_row.review_state = "to_be_verified"
    parent_row.result_value = "95.1"
    parent_row.reportable = True
    db.commit()

    db.add(CoaResultPin(
        parent_sample_id=parent.sample_id,
        analyte_keyword=analysis_service.keyword,
        mode="pin",
        source_sample_id=parent.sample_id,
        source_analysis_uid=f"mk1:{parent_row.id}",
    ))
    db.commit()

    fake_payload = {
        parent.sample_id: [
            {"uid": "senaite-placeholder", "keyword": analysis_service.keyword,
             "result": None, "unit": "%", "review_state": "verified"},
        ],
    }
    reader = _FakeSenaiteReader(payload=fake_payload)
    res = asyncio.run(resolve_sources(parent.sample_id, db, reader))

    matching = [d for d in res.decisions if d.analyte_keyword == analysis_service.keyword]
    assert matching, f"expected a decision for {analysis_service.keyword!r} once SENAITE surfaces the keyword"
    d = matching[0]
    assert d.blocked == "stale_pin", (
        f"pin on a to_be_verified mk1 row must block as stale_pin; "
        f"got mode={d.mode!r} blocked={d.blocked!r} chosen={d.chosen!r}"
    )
    assert d.chosen is None


def test_resolve_sources_mk1_pin_override_marks_decision_as_pin(db, clean_sub, analysis_service):
    """A pin pointing at the existing Mk1 parent-tier row flips mode='auto' to
    mode='pin' while keeping the same value. Simulates the post-publish admin
    correction path where a manager confirms the resolved value via pin."""
    src = _make_vial_to_be_verified(db, clean_sub, analysis_service, result="98.55")
    parent_row = _promote_to_parent_row(db, src, analysis_service, "98.55")
    parent = db.get(LimsSample, parent_row.lims_sample_pk)

    db.add(CoaResultPin(
        parent_sample_id=parent.sample_id,
        analyte_keyword=analysis_service.keyword,
        mode="pin",
        source_sample_id=parent.sample_id,
        source_analysis_uid=f"mk1:{parent_row.id}",
    ))
    db.commit()

    reader = _FakeSenaiteReader()
    res = asyncio.run(resolve_sources(parent.sample_id, db, reader))

    matching = [d for d in res.decisions if d.analyte_keyword == analysis_service.keyword]
    assert matching, "expected a decision"
    d = matching[0]
    assert d.mode == "pin"
    assert d.blocked is None
    assert d.chosen is not None
    assert d.chosen.source_analysis_uid == f"mk1:{parent_row.id}"
    assert d.chosen.value == "98.55"
    # The pin gets cleaned by the autouse fixture (source_analysis_uid LIKE 'mk1:%')
