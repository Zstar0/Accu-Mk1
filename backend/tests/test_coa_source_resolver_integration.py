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
    """Promote `src` to a parent-tier row, return the parent_row."""
    parent_row, _ = promote_to_parent(
        db, keyword=svc.keyword, result_value=value, result_unit=None,
        method_id=None, instrument_id=None,
        sources=[{"analysis_id": src.id, "contribution_kind": "chosen"}],
        reason="TEST: integration promote",
    )
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
