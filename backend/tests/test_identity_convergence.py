"""S3 native-identity convergence — behavior tests.

Task 3 covers the two retest-lineage readers, whose identity resolution is
deliberately NOT promote's `_ident_clause` ternary (service.py:850-857).
Promote holds the source ROW and can read its service FK before querying;
these two callers hold only a keyword off a keyword-boundary wire. The shape
they use instead is three-legged:

  1. explicit `analysis_service_id` — caller already holds the native key
  2. exact stored keyword — byte-identical to the pre-S3 lookup
  3. mk1 catalog rescue — ONLY on a miss from (2), and only for origin='mk1'

Leg 2-before-3 is the whole point: a caller sending a keyword that names a
LIVE row must always get that row, even when some other service's catalog
keyword happens to be the same string (test_exact_keyword_wins_over_rescue).

Fixture idiom follows tests/test_parent_retest_cascade.py (in-memory SQLite,
the established harness for these two functions) rather than the live-PG
builder: the cascade commits its own transactions, so a rollback fixture
would not contain it, and index enforcement is Task 2's subject, not this
file's.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from lims_analyses.service import (
    NotFoundError,
    cascade_parent_retest_to_sources,
    parent_retest,
)
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsAnalysisPromotion,
    LimsSample,
    LimsSubSample,
    LimsSubSampleEvent,
)


# ─── Fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture
def db_mem():
    """In-memory SQLite session (same harness as test_parent_retest_cascade)."""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def host(db_mem):
    """A parent LimsSample with one sub-sample. Returns (db, parent, sub)."""
    parent = LimsSample(sample_id="P-S3-001", external_lims_uid="uid-s3-001")
    db_mem.add(parent)
    db_mem.flush()

    sub = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid="uid-s3-001-S01",
        sample_id="P-S3-001-S01",
        vial_sequence=1,
    )
    db_mem.add(sub)
    db_mem.commit()
    return db_mem, parent, sub


def _service(db, *, keyword, origin):
    """Catalog service. `keyword` here is the CATALOG keyword — the row's
    stored keyword is passed separately so drift can be constructed."""
    svc = AnalysisService(title=f"TEST {keyword}", keyword=keyword, origin=origin)
    db.add(svc)
    db.flush()
    return svc


def _parent_row(db, parent, svc, *, stored_keyword, state="verified"):
    row = LimsAnalysis(
        lims_sample_pk=parent.id,
        lims_sub_sample_pk=None,
        analysis_service_id=svc.id,
        keyword=stored_keyword,
        title=f"TEST: parent {stored_keyword}",
        review_state=state,
        result_value="99.00",
        retest_of_id=None,
    )
    db.add(row)
    db.flush()
    return row


def _promoted_vial(db, sub, svc, *, stored_keyword):
    """A retest-eligible ('promoted') vial-tier source row."""
    row = LimsAnalysis(
        lims_sub_sample_pk=sub.id,
        analysis_service_id=svc.id,
        keyword=stored_keyword,
        title=f"TEST: vial {stored_keyword}",
        review_state="promoted",
        result_value="99.00",
        retest_of_id=None,
    )
    db.add(row)
    db.flush()
    return row


def _link(db, parent_row, vial_row):
    db.add(LimsAnalysisPromotion(
        parent_analysis_id=parent_row.id,
        source_analysis_id=vial_row.id,
        contribution_kind="chosen",
        promoted_by_user_id=None,
    ))
    db.flush()


def _drifted_native(db, parent, sub, *, catalog_kw="PUR_NEW", stored_kw="PUR_OLD"):
    """mk1-origin service whose live rows carry a keyword that has drifted away
    from the catalog's. Returns (svc, parent_row, vial_row)."""
    svc = _service(db, keyword=catalog_kw, origin="mk1")
    prow = _parent_row(db, parent, svc, stored_keyword=stored_kw)
    vial = _promoted_vial(db, sub, svc, stored_keyword=stored_kw)
    _link(db, prow, vial)
    db.commit()
    return svc, prow, vial


# ─── (a) explicit analysis_service_id — both sites ───────────────────────────


def test_cascade_finds_drifted_native_row_by_service_id(host):
    """Caller holds the native identity key: the lookup keys on the service FK
    alone, and the keyword it also passes is irrelevant to the match."""
    db, parent, sub = host
    svc, prow, vial = _drifted_native(db, parent, sub)

    new_ids = cascade_parent_retest_to_sources(
        db,
        parent_sample_id=parent.sample_id,
        keyword="TOTALLY-UNRELATED-KEYWORD",
        user_id=None,
        analysis_service_id=svc.id,
    )

    assert len(new_ids) == 1, f"service-id lookup must find the drifted row; got {new_ids}"
    assert db.get(LimsAnalysis, new_ids[0]).retest_of_id == vial.id
    db.refresh(prow)
    assert prow.review_state == "retracted"


def test_parent_retest_finds_drifted_native_row_by_service_id(host):
    """Same, one level up: parent_retest's active-row lookup and the service id
    it threads down to the cascade."""
    db, parent, sub = host
    svc, prow, vial = _drifted_native(db, parent, sub)

    new_ids, state = parent_retest(
        db,
        sample_id=parent.sample_id,
        keyword="TOTALLY-UNRELATED-KEYWORD",
        user_id=None,
        analysis_service_id=svc.id,
    )

    assert len(new_ids) == 1, f"service-id lookup must find the drifted row; got {new_ids}"
    assert db.get(LimsAnalysis, new_ids[0]).retest_of_id == vial.id
    assert state == "retracted"


# ─── (b) catalog-keyword rescue after an exact miss — both sites ─────────────


def test_cascade_rescues_drifted_native_row_via_catalog_keyword(host):
    """Caller passes the CATALOG keyword for an mk1 service whose live rows
    still carry the pre-rename keyword. Exact match misses; the mk1-scoped
    catalog rescue resolves the service and finds the row by FK. Before S3
    this silently no-op'd."""
    db, parent, sub = host
    svc, prow, vial = _drifted_native(db, parent, sub, catalog_kw="PUR_NEW", stored_kw="PUR_OLD")

    new_ids = cascade_parent_retest_to_sources(
        db,
        parent_sample_id=parent.sample_id,
        keyword="PUR_NEW",          # catalog keyword; no live row carries it
        user_id=None,
    )

    assert len(new_ids) == 1, f"catalog rescue must find the drifted row; got {new_ids}"
    assert db.get(LimsAnalysis, new_ids[0]).retest_of_id == vial.id


def test_parent_retest_rescues_drifted_native_row_via_catalog_keyword(host):
    db, parent, sub = host
    svc, prow, vial = _drifted_native(db, parent, sub, catalog_kw="PUR_NEW", stored_kw="PUR_OLD")

    new_ids, state = parent_retest(
        db,
        sample_id=parent.sample_id,
        keyword="PUR_NEW",
        user_id=None,
    )

    assert len(new_ids) == 1, f"catalog rescue must find the drifted row; got {new_ids}"
    assert db.get(LimsAnalysis, new_ids[0]).retest_of_id == vial.id
    assert state == "retracted"


# ─── (c) the hazard: exact keyword must win over the rescue ──────────────────


def test_exact_keyword_wins_over_catalog_rescue(host):
    """The reason leg 2 runs before leg 3.

    Both root indexes permit these two rows to be live on one parent at once:
      X — service 'PUR_NEW' (mk1), stored keyword 'PUR_OLD'   (drifted)
      Y — service 'OTHER'   (mk1), stored keyword 'PUR_NEW'   (also drifted)
    A caller sending 'PUR_NEW' means Y — that is the string Y's live row
    answers to, and it is what the FE sends (it echoes row.keyword). Resolving
    'PUR_NEW' through the catalog FIRST would route the retest to X and retract
    the wrong promoted sources."""
    db, parent, sub = host

    # X: the drifted row whose SERVICE owns the 'PUR_NEW' catalog keyword
    svc_x = _service(db, keyword="PUR_NEW", origin="mk1")
    row_x = _parent_row(db, parent, svc_x, stored_keyword="PUR_OLD")
    vial_x = _promoted_vial(db, sub, svc_x, stored_keyword="PUR_OLD")
    _link(db, row_x, vial_x)

    # Y: the row that actually answers to the string 'PUR_NEW'
    svc_y = _service(db, keyword="OTHER", origin="mk1")
    row_y = _parent_row(db, parent, svc_y, stored_keyword="PUR_NEW")
    vial_y = _promoted_vial(db, sub, svc_y, stored_keyword="PUR_NEW")
    _link(db, row_y, vial_y)
    db.commit()

    new_ids = cascade_parent_retest_to_sources(
        db,
        parent_sample_id=parent.sample_id,
        keyword="PUR_NEW",
        user_id=None,
    )

    assert len(new_ids) == 1
    assert db.get(LimsAnalysis, new_ids[0]).retest_of_id == vial_y.id, (
        "exact stored-keyword match must win; the catalog rescue routed the "
        "retest to the wrong line"
    )
    db.refresh(row_x)
    assert row_x.review_state == "verified", "row X must be untouched"
    db.refresh(vial_x)
    assert vial_x.retested is False, "row X's source must not be retested"


# ─── (d) senaite-origin: keyword only, no rescue ─────────────────────────────


def test_senaite_origin_gets_no_catalog_rescue(host):
    """senaite services keep the keyword as their identity contract
    (grandfathered): a drifted senaite row is NOT reachable by its catalog
    keyword, because the rescue leg is scoped to origin='mk1'. The SENAITE
    webhook (main.py) sends SENAITE's own keyword, which is the stored one."""
    db, parent, sub = host
    svc = _service(db, keyword="SEN_NEW", origin="senaite")
    prow = _parent_row(db, parent, svc, stored_keyword="SEN_OLD")
    vial = _promoted_vial(db, sub, svc, stored_keyword="SEN_OLD")
    _link(db, prow, vial)
    db.commit()

    assert cascade_parent_retest_to_sources(
        db,
        parent_sample_id=parent.sample_id,
        keyword="SEN_NEW",          # catalog keyword — must NOT rescue
        user_id=None,
    ) == [], "senaite rows must not be reachable through the mk1 catalog rescue"

    with pytest.raises(NotFoundError):
        parent_retest(db, sample_id=parent.sample_id, keyword="SEN_NEW", user_id=None)

    # ...and the stored keyword still works, exactly as before S3.
    new_ids = cascade_parent_retest_to_sources(
        db,
        parent_sample_id=parent.sample_id,
        keyword="SEN_OLD",
        user_id=None,
    )
    assert len(new_ids) == 1
    assert db.get(LimsAnalysis, new_ids[0]).retest_of_id == vial.id


# ─── the audit event names the row that was retested ────────────────────────


def test_retest_event_records_resolved_identity_not_requested_keyword(host):
    """parent_retest's activity event used to echo the caller's keyword. Since
    the rescue leg can resolve a row whose stored keyword differs from the one
    asked for, the event must name the ROW's identity — otherwise the audit
    trail carries a keyword that doesn't identify what was retested. The
    requested string is kept alongside it, only when it differed."""
    db, parent, sub = host
    svc, prow, vial = _drifted_native(db, parent, sub, catalog_kw="PUR_NEW", stored_kw="PUR_OLD")

    parent_retest(db, sample_id=parent.sample_id, keyword="PUR_NEW", user_id=None)

    ev = db.execute(
        LimsSubSampleEvent.__table__.select().where(
            LimsSubSampleEvent.event == "parent_analysis_retested"
        )
    ).mappings().one()
    assert ev["details"]["keyword"] == "PUR_OLD", "must record the resolved row's keyword"
    assert ev["details"]["analysis_service_id"] == svc.id
    assert ev["details"]["requested_keyword"] == "PUR_NEW"
    assert ev["details"]["service_origin"] == "mk1"


def test_retest_event_omits_requested_keyword_when_it_matches(host):
    """The pre-S3 shape: caller named the row's own keyword, so there is no
    divergence to record."""
    db, parent, sub = host
    svc = _service(db, keyword="PUR_SAME", origin="mk1")
    prow = _parent_row(db, parent, svc, stored_keyword="PUR_SAME")
    vial = _promoted_vial(db, sub, svc, stored_keyword="PUR_SAME")
    _link(db, prow, vial)
    db.commit()

    parent_retest(db, sample_id=parent.sample_id, keyword="PUR_SAME", user_id=None)

    ev = db.execute(
        LimsSubSampleEvent.__table__.select().where(
            LimsSubSampleEvent.event == "parent_analysis_retested"
        )
    ).mappings().one()
    assert ev["details"]["keyword"] == "PUR_SAME"
    assert "requested_keyword" not in ev["details"]


# ─── regression: the provenance term survives the refactor ──────────────────


def test_all_legs_target_canonical_not_shadow(host):
    """`review_state NOT IN ('retracted','rejected')` does NOT exclude the
    shadow sentinel 'senaite_mirror', so a shadow row for the same (parent,
    service) matches every leg's filter. A shadow carries no promotion links,
    so resolving to one makes the cascade silently no-op instead of retesting
    the sources the canonical row promoted.

    Pins that for all three identity legs. The live-PG original
    (test_parent_mirror_fail_closed.py::test_retest_cascade_targets_canonical_
    not_shadow) covers the exact-keyword leg only; the service-id and rescue
    legs are new surface. Shadow is inserted FIRST (lower id) to bias an
    unordered scan toward it."""
    db, parent, sub = host
    svc = _service(db, keyword="PUR_NEW", origin="mk1")

    shadow = LimsAnalysis(
        lims_sample_pk=parent.id,
        analysis_service_id=svc.id,
        keyword="PUR_OLD",
        title="TEST: shadow",
        review_state="senaite_mirror",
        provenance="shadow",
        mirror_review_state="verified",
        result_value="88.8",
    )
    db.add(shadow)
    db.flush()          # shadow gets the lower id

    canonical = _parent_row(db, parent, svc, stored_keyword="PUR_OLD")
    vial = _promoted_vial(db, sub, svc, stored_keyword="PUR_OLD")
    _link(db, canonical, vial)
    db.commit()

    for leg, kwargs in (
        ("service id", {"keyword": "irrelevant", "analysis_service_id": svc.id}),
        ("exact keyword", {"keyword": "PUR_OLD"}),
        ("catalog rescue", {"keyword": "PUR_NEW"}),
    ):
        db.rollback()
        for row in (canonical, vial):
            db.refresh(row)
            row.review_state = "verified" if row is canonical else "promoted"
            row.result_value = "99.00"
            row.retested = False
        db.execute(
            LimsAnalysis.__table__.delete().where(
                LimsAnalysis.retest_of_id.is_not(None)
            )
        )
        db.commit()

        new_ids = cascade_parent_retest_to_sources(
            db, parent_sample_id=parent.sample_id, user_id=None, **kwargs
        )
        assert new_ids, f"{leg} leg resolved to the shadow row and no-opped"
        db.refresh(shadow)
        assert shadow.review_state == "senaite_mirror", f"{leg} leg touched the shadow"
        assert shadow.result_value == "88.8"
        assert shadow.retested is False
