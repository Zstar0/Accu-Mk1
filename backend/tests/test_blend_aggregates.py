"""Native blend aggregates are CALCULATED on both tiers (blend_aggregates.py).

    HPLC-BLEND-TOTAL  = sum of slot quantities
    HPLC-BLEND-PURITY = quantity-weighted mean of slot purities

Scenarios come from Handler UAT sample PB-1002 (2026-09-21), where the two
rows were typed by hand and drifted from what the COA recomputes.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from lims_analyses.blend_aggregates import (
    compute_blend_values, recalc_parent_blend_aggregates, recalc_vial_aggregates_for_row,
)
from lims_analyses.hplc_native import KW_BLEND_PURITY, KW_BLEND_TOTAL, KW_PURITY, KW_QUANTITY
from lims_analyses.service import apply_transition, parent_retest, promote_to_parent
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


SLOTS = [("KPV", "KPV"), ("GHK-Cu", "GHKCU")]


def _row(rows, kw, slot=None):
    return next(r for r in rows if r.keyword == kw and r.slot == slot)


def _enter(db, row, value):
    """What the inline result cell does: submit, then the route's recalc."""
    apply_transition(db, analysis_id=row.id, kind="submit", result_value=value,
                     reason="bench-tech result entry", user_id=1)
    db.refresh(row)
    recalc_vial_aggregates_for_row(db, row, 1)


def _fill(db, rows, *, pur, qty):
    for slot, (p, q) in enumerate(zip(pur, qty), start=1):
        _enter(db, _row(rows, KW_PURITY, slot), p)
        _enter(db, _row(rows, KW_QUANTITY, slot), q)
    for r in rows:
        db.refresh(r)


def _promote(db, row, *, verify=True):
    parent, _ = promote_to_parent(
        db, keyword=row.keyword, result_value=row.result_value, result_unit=None,
        method_id=None, instrument_id=None,
        sources=[{"analysis_id": row.id, "contribution_kind": "chosen"}], user_id=1)
    if verify:
        apply_transition(db, analysis_id=parent.id, kind="verify", user_id=1)
    return parent


# ── the formula ─────────────────────────────────────────────────────────────

def test_formula_matches_the_published_pb1002_certificate():
    comps = {1: {"pur": 98.0, "qty": 1.0}, 2: {"pur": 99.0, "qty": 2.0},
             3: {"pur": 99.56, "qty": 3.0}, 4: {"pur": 99.523, "qty": 4.0}}
    assert compute_blend_values(comps) == ("10", "99.277")


def test_a_partial_blend_never_yields_a_number():
    assert compute_blend_values({1: {"pur": 98.0, "qty": 1.0}, 2: {"pur": 99.0, "qty": None}}) is None
    assert compute_blend_values({1: {"pur": 98.0, "qty": 1.0}}, expected_slots={1, 2}) is None


# ── vial tier: typed results fill the aggregates (the PB-1002 drift) ────────

def test_typing_slot_results_fills_the_aggregates_nobody_types_them(db):
    _, _, _, vial_rows = native_family(db, sample_id="PB-7100", slots=SLOTS)
    rows = next(iter(vial_rows.values()))
    total, purity = _row(rows, KW_BLEND_TOTAL), _row(rows, KW_BLEND_PURITY)

    _enter(db, _row(rows, KW_PURITY, 1), "98")
    _enter(db, _row(rows, KW_QUANTITY, 1), "1")
    _enter(db, _row(rows, KW_PURITY, 2), "99")
    db.refresh(total)
    assert total.review_state == "unassigned" and total.result_value is None   # still partial

    _enter(db, _row(rows, KW_QUANTITY, 2), "3")                                # completes the set
    db.refresh(total); db.refresh(purity)
    assert (total.result_value, total.review_state) == ("4", "to_be_verified")
    assert (purity.result_value, purity.review_state) == ("98.75", "to_be_verified")


def test_correcting_a_slot_before_promotion_recalculates_in_place(db):
    _, _, _, vial_rows = native_family(db, sample_id="PB-7101", slots=SLOTS)
    rows = next(iter(vial_rows.values()))
    _fill(db, rows, pur=["98", "99"], qty=["1", "3"])
    _enter(db, _row(rows, KW_QUANTITY, 2), "1")            # correction
    total, purity = _row(rows, KW_BLEND_TOTAL), _row(rows, KW_BLEND_PURITY)
    db.refresh(total); db.refresh(purity)
    assert (total.result_value, purity.result_value) == ("2", "98.5")
    assert total.review_state == "to_be_verified"          # self-edge, not a new state
    reasons = [t.reason for t in db.query(LimsAnalysisTransition)
               .filter_by(analysis_id=total.id).order_by(LimsAnalysisTransition.id)]
    assert reasons[-1].startswith("auto: recalculated") and "was 4" in reasons[-1]


def test_a_promoted_aggregate_is_frozen_on_the_vial(db):
    _, _, _, vial_rows = native_family(db, sample_id="PB-7102", slots=SLOTS)
    rows = next(iter(vial_rows.values()))
    _fill(db, rows, pur=["98", "99"], qty=["1", "3"])
    total = _row(rows, KW_BLEND_TOTAL)
    _promote(db, total, verify=False)
    db.refresh(total)
    assert total.review_state == "promoted"
    assert recalc_vial_aggregates_for_row(db, _row(rows, KW_QUANTITY, 1), 1) == []


def test_singles_and_aggregate_rows_themselves_are_ignored(db):
    _, _, _, vial_rows = native_family(db, sample_id="P-7103", slots=[("KPV", "KPV")])
    rows = next(iter(vial_rows.values()))
    pur = _row(rows, KW_PURITY, 1)
    apply_transition(db, analysis_id=pur.id, kind="submit", result_value="99", user_id=1)
    db.refresh(pur)
    assert recalc_vial_aggregates_for_row(db, pur, 1) == []          # no aggregate rows on a single


# ── parent tier ─────────────────────────────────────────────────────────────

def _promoted_blend(db, sample_id, *, vials=1):
    parent, _, _, vial_rows = native_family(db, sample_id=sample_id, slots=SLOTS, vials=vials)
    rows = next(iter(vial_rows.values()))
    _fill(db, rows, pur=["98", "99"], qty=["1", "3"])
    parents = {}
    for r in rows:
        if r.result_value is not None:
            parents[(r.keyword, r.slot)] = _promote(db, r)
    return parent, vial_rows, parents


def test_promoting_everything_from_one_vial_changes_nothing(db):
    parent, _, parents = _promoted_blend(db, "PB-7110")
    total, purity = parents[(KW_BLEND_TOTAL, None)], parents[(KW_BLEND_PURITY, None)]
    db.refresh(total); db.refresh(purity)
    assert (total.result_value, total.review_state) == ("4", "verified")
    assert (purity.result_value, purity.review_state) == ("98.75", "verified")
    assert recalc_parent_blend_aggregates(db, parent_pk=parent.id, user_id=1) == []   # idempotent
    autos = db.query(LimsAnalysisTransition).filter(
        LimsAnalysisTransition.analysis_id.in_([total.id, purity.id]),
        LimsAnalysisTransition.reason.like("auto: recalc%")).count()
    assert autos == 0


def test_ruling_a_retesting_a_slot_unverifies_the_aggregates(db):
    parent, _, parents = _promoted_blend(db, "PB-7111")
    total, purity = parents[(KW_BLEND_TOTAL, None)], parents[(KW_BLEND_PURITY, None)]
    svc_id = parents[(KW_QUANTITY, 2)].analysis_service_id

    parent_retest(db, sample_id="PB-7111", keyword=KW_QUANTITY, user_id=1, reason="t",
                  analysis_service_id=svc_id, slot=2)

    db.refresh(total); db.refresh(purity)
    # Inputs are incomplete now: nothing can vouch for the old figures.
    assert (total.review_state, total.verified_at) == ("parent_to_verify", None)
    assert purity.review_state == "parent_to_verify"
    assert total.result_value == "4"                       # kept until the slot comes back
    last = db.query(LimsAnalysisTransition).filter_by(analysis_id=total.id) \
             .order_by(LimsAnalysisTransition.id.desc()).first()
    assert (last.transition_kind, last.from_state, last.to_state) == ("auto", "verified", "parent_to_verify")


def test_ruling_a_the_repromoted_slot_writes_the_new_value(db):
    parent, vial_rows, parents = _promoted_blend(db, "PB-7112")
    total, purity = parents[(KW_BLEND_TOTAL, None)], parents[(KW_BLEND_PURITY, None)]
    svc_id = parents[(KW_QUANTITY, 2)].analysis_service_id
    new_ids, _ = parent_retest(db, sample_id="PB-7112", keyword=KW_QUANTITY, user_id=1, reason="t",
                               analysis_service_id=svc_id, slot=2)
    retest_row = db.get(LimsAnalysis, new_ids[0])
    apply_transition(db, analysis_id=retest_row.id, kind="submit", result_value="1", user_id=1)
    db.refresh(retest_row)
    _promote(db, retest_row)                               # slot 2 quantity is now 1, was 3

    db.refresh(total); db.refresh(purity)
    assert (total.result_value, purity.result_value) == ("2", "98.5")
    assert total.review_state == "parent_to_verify"        # must be signed again
    # The vial's own aggregate is frozen at the OLD figure: the parent is the
    # only place the blend's truth lives now, which is why it recalculates.
    vial_total = _row(next(iter(vial_rows.values())), KW_BLEND_TOTAL)
    db.refresh(vial_total)
    assert vial_total.result_value == "4"


def test_published_aggregates_are_never_touched(db):
    parent, _, parents = _promoted_blend(db, "PB-7113")
    total = parents[(KW_BLEND_TOTAL, None)]
    total.review_state = "published"
    total.result_value = "999"                              # deliberately not the computed 4
    db.commit()
    assert recalc_parent_blend_aggregates(db, parent_pk=parent.id, user_id=1) == []
    db.refresh(total)
    assert (total.result_value, total.review_state) == ("999", "published")
