"""Native analysis rows ride the COA publish to 'published'.

The workflow catalog always described the edge ("analysis: verified ->
published, rides the sample COA publish") and the state machine always had it,
but nothing applied it to canonical rows: PB-1002 and P-5007 were published
with every parent row still 'verified'. That mattered because 'published' is
what makes a result citable: a retest of a published row keeps the figure live
and lets the re-promote supersede it, whereas a 'verified' row is un-promoted,
i.e. retracted with its value cleared.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from lims_analyses.hplc_native import KW_BLEND_TOTAL, KW_PURITY, KW_QUANTITY
from lims_analyses.service import (
    apply_transition, parent_retest, promote_to_parent, publish_parent_rows,
)
from models import LimsAnalysis, LimsAnalysisTransition
from tests.hplc_native_family import native_family


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _vial_rows(db, sample_id, slots):
    parent, _, _, vial_rows = native_family(db, sample_id=sample_id, slots=slots)
    return parent, next(iter(vial_rows.values()))


def _result_and_promote(db, row, value, *, verify=True):
    apply_transition(db, analysis_id=row.id, kind="submit", result_value=value, user_id=1)
    db.refresh(row)
    parent, _ = promote_to_parent(
        db, keyword=row.keyword, result_value=row.result_value, result_unit=None,
        method_id=None, instrument_id=None,
        sources=[{"analysis_id": row.id, "contribution_kind": "chosen"}], user_id=1)
    if verify:
        apply_transition(db, analysis_id=parent.id, kind="verify", user_id=1)
    return parent


def test_verified_rows_ride_the_publish_with_timestamp_and_audit(db):
    _, rows = _vial_rows(db, "P-7200", [("KPV", "KPV")])
    pur = _result_and_promote(db, next(r for r in rows if r.keyword == KW_PURITY), "99.1")
    qty = _result_and_promote(db, next(r for r in rows if r.keyword == KW_QUANTITY), "5")

    assert publish_parent_rows(db, sample_id="P-7200", user_id=7) == 2
    db.commit()

    for row in (pur, qty):
        db.refresh(row)
        assert row.review_state == "published" and row.published_at is not None
        assert row.result_value in ("99.1", "5")                       # figure untouched
    last = db.query(LimsAnalysisTransition).filter_by(analysis_id=pur.id) \
             .order_by(LimsAnalysisTransition.id.desc()).first()
    assert (last.transition_kind, last.from_state, last.to_state, last.user_id) == (
        "publish", "verified", "published", 7)


def test_partial_publish_leaves_unverified_lines_for_the_later_coa(db):
    _, rows = _vial_rows(db, "P-7201", [("KPV", "KPV")])
    done = _result_and_promote(db, next(r for r in rows if r.keyword == KW_PURITY), "99.1")
    waiting = _result_and_promote(db, next(r for r in rows if r.keyword == KW_QUANTITY), "5",
                                  verify=False)                        # parent_to_verify

    assert publish_parent_rows(db, sample_id="P-7201") == 1
    db.commit()
    db.refresh(done); db.refresh(waiting)
    assert (done.review_state, waiting.review_state) == ("published", "parent_to_verify")

    apply_transition(db, analysis_id=waiting.id, kind="verify", user_id=1)
    assert publish_parent_rows(db, sample_id="P-7201") == 1            # the later COA
    db.commit()
    db.refresh(waiting)
    assert waiting.review_state == "published"


def test_republishing_is_a_no_op_and_placeholders_and_vials_never_move(db):
    parent, rows = _vial_rows(db, "P-7202", [("KPV", "KPV")])
    _result_and_promote(db, next(r for r in rows if r.keyword == KW_PURITY), "99.1")
    assert publish_parent_rows(db, sample_id="P-7202") == 1
    db.commit()
    assert publish_parent_rows(db, sample_id="P-7202") == 0            # regen + republish
    states = {(r.provenance, r.lims_sub_sample_pk is None, r.review_state)
              for r in db.query(LimsAnalysis).all()}
    assert ("ordered", True, "unassigned") in states                   # placeholders untouched
    assert not any(tier_is_parent is False and st == "published"
                   for (_p, tier_is_parent, st) in states)             # no vial row published
    assert publish_parent_rows(db, sample_id="NOPE-1") == 0


def test_legacy_service_rows_are_out_of_scope_until_signed_off(db):
    """Same gap, deliberately untouched: moving SENAITE-origin canonical rows
    changes what the lab sees on every legacy publish, so it needs its own
    sign-off (Handler ruled on native rows, 2026-09-21)."""
    from models import AnalysisService, LimsSample
    parent = LimsSample(sample_id="P-7290", external_lims_uid="uid-7290")
    legacy = AnalysisService(title="Peptide Purity (HPLC)", keyword="HPLC-PUR", origin="senaite")
    native = AnalysisService(title="Endotoxin", keyword="ENDOTOXIN-USP85LAL", origin="mk1")
    db.add_all([parent, legacy, native])
    db.flush()
    rows = {}
    for svc in (legacy, native):
        rows[svc.origin] = LimsAnalysis(
            lims_sample_pk=parent.id, analysis_service_id=svc.id, keyword=svc.keyword,
            title=svc.title, provenance="canonical", review_state="verified", result_value="1")
        db.add(rows[svc.origin])
    db.commit()

    assert publish_parent_rows(db, sample_id="P-7290") == 1
    db.commit()
    db.refresh(rows["senaite"]); db.refresh(rows["mk1"])
    assert rows["mk1"].review_state == "published"          # native add-on on a legacy sample
    assert rows["senaite"].review_state == "verified"       # unchanged


def test_a_retest_after_publish_keeps_the_published_figure(db):
    """The point of the whole change. Before: the row was still 'verified', so
    this retest RETRACTED it and cleared a value printed on a certificate the
    customer already holds."""
    _, rows = _vial_rows(db, "P-7203", [("KPV", "KPV")])
    pur = _result_and_promote(db, next(r for r in rows if r.keyword == KW_PURITY), "99.1")
    publish_parent_rows(db, sample_id="P-7203")
    db.commit()

    new_ids, _state = parent_retest(db, sample_id="P-7203", keyword=KW_PURITY, user_id=1,
                                    reason="customer dispute",
                                    parent_analysis_id=pur.id)
    db.refresh(pur)
    assert pur.review_state == "published"                 # NOT retracted
    assert pur.result_value == "99.1"                      # NOT cleared
    assert len(new_ids) == 1                               # the vial retest still spawned


def test_published_blend_aggregates_are_left_alone_by_the_recalculation(db):
    """Slice 18 never touches a published aggregate; this is what makes that
    rule reachable for native samples."""
    from lims_analyses.blend_aggregates import recalc_parent_blend_aggregates
    from tests.test_blend_aggregates import SLOTS, _fill, _promote
    parent, _, _, vial_rows = native_family(db, sample_id="PB-7204", slots=SLOTS)
    rows = next(iter(vial_rows.values()))
    _fill(db, rows, pur=["98", "99"], qty=["1", "3"])
    parents = {(r.keyword, r.slot): _promote(db, r) for r in rows if r.result_value is not None}
    assert publish_parent_rows(db, sample_id="PB-7204") == len(parents)
    db.commit()
    total = parents[(KW_BLEND_TOTAL, None)]
    total.result_value = "999"                             # force a mismatch
    db.commit()
    assert recalc_parent_blend_aggregates(db, parent_pk=parent.id) == []
    db.refresh(total)
    assert (total.result_value, total.review_state) == ("999", "published")
