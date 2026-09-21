"""A promoted result is still the bench's result (slice 24).

Until now promote minted the parent row with no captured_at (prod 2026-09-21:
0 of 10,662 parent rows had one) and with analyst_user_id = whoever clicked
Promote. The parent line now carries the result-bearing source row's capture
time, analyst and processed-by. Who promoted is still recorded, on
created_by_user_id, the promotions rows and the audit transition.
"""
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from lims_analyses.hplc_native import KW_BLEND_TOTAL, KW_PURITY, KW_QUANTITY
from lims_analyses.service import apply_transition, parent_retest, promote_to_parent
from models import LimsAnalysis, LimsAnalysisPromotion, LimsAnalysisTransition
from tests.hplc_native_family import native_family

BENCH, PROMOTER, STAMPED, PROCESSOR = 1, 9, 5, 6


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _purity_rows(db, sample_id, vials=1, *, peptide=("KPV", "KPV"), services=None):
    _, services, _, vial_rows = native_family(db, sample_id=sample_id, slots=[peptide], vials=vials,
                                              services=services)
    # `services` rides back so a second family in the same DB can reuse the catalog.
    return [next(r for r in rows if r.keyword == KW_PURITY) for rows in vial_rows.values()], services


def _submit(db, row, value, *, user_id=BENCH, captured_at=None):
    apply_transition(db, analysis_id=row.id, kind="submit", result_value=value, user_id=user_id)
    db.refresh(row)
    if captured_at is not None:
        row.captured_at = captured_at
        db.commit()
    return row


def _promote(db, sources, value="99.1", *, user_id=PROMOTER):
    first = db.get(LimsAnalysis, sources[0]["analysis_id"])
    parent, _ = promote_to_parent(
        db, keyword=first.keyword, result_value=value, result_unit=None, method_id=None,
        instrument_id=None, sources=sources, user_id=user_id)
    return parent


def _chosen(row):
    return {"analysis_id": row.id, "contribution_kind": "chosen"}


def test_a_hand_entered_result_carries_its_capture_time_and_who_entered_it(db):
    """The P-5010 case: results typed on the vial, no worksheet stamp."""
    (src,), _ = _purity_rows(db, "P-7400")
    _submit(db, src, "99.1", user_id=BENCH)
    assert src.analyst_user_id is None and src.captured_at is not None

    parent = _promote(db, [_chosen(src)], user_id=PROMOTER)

    assert parent.captured_at == src.captured_at
    assert parent.analyst_user_id == BENCH                     # not the promoter
    # ...and who promoted is still on record, three times over.
    assert parent.created_by_user_id == PROMOTER
    assert db.query(LimsAnalysisPromotion).filter_by(
        parent_analysis_id=parent.id).one().promoted_by_user_id == PROMOTER
    assert db.query(LimsAnalysisTransition).filter_by(
        analysis_id=parent.id, to_state="parent_to_verify").one().user_id == PROMOTER


def test_a_worksheet_stamped_analyst_and_the_hplc_processor_carry_over(db):
    (src,), _ = _purity_rows(db, "P-7401")
    _submit(db, src, "99.1", user_id=BENCH)
    src.analyst_user_id, src.processed_by_user_id = STAMPED, PROCESSOR
    db.commit()

    parent = _promote(db, [_chosen(src)])

    assert (parent.analyst_user_id, parent.processed_by_user_id) == (STAMPED, PROCESSOR)


def test_the_promoter_is_only_the_last_resort(db):
    """No analyst on the row and no submit on record (e.g. a bridged result
    written by the system): fall back to the pre-slice-24 value."""
    (src,), _ = _purity_rows(db, "P-7402")
    _submit(db, src, "99.1", user_id=None)

    assert _promote(db, [_chosen(src)]).analyst_user_id == PROMOTER


def test_an_aggregate_takes_the_latest_capture_and_a_reference_row_never_counts(db):
    t0 = datetime(2026, 9, 1, 9, 0, 0)
    (a, b), services = _purity_rows(db, "P-7403", vials=2)
    _submit(db, a, "99.0", captured_at=t0)
    _submit(db, b, "99.2", captured_at=t0 + timedelta(hours=3))
    mean = _promote(db, [{"analysis_id": a.id, "contribution_kind": "aggregated_in"},
                         {"analysis_id": b.id, "contribution_kind": "aggregated_in"}], "99.1")
    assert mean.captured_at == t0 + timedelta(hours=3)

    (c, d), _ = _purity_rows(db, "P-7404", vials=2, peptide=("GHK-Cu", "GHKCU"), services=services)
    _submit(db, c, "99.0", captured_at=t0)
    _submit(db, d, "97.0", captured_at=t0 + timedelta(days=2))     # later, but only a reference
    picked = _promote(db, [_chosen(c), {"analysis_id": d.id, "contribution_kind": "reference"}], "99.0")
    assert picked.captured_at == t0


def test_a_recalculated_parent_aggregate_is_captured_when_it_is_recalculated(db):
    from tests.test_blend_aggregates import SLOTS, _fill, _promote as _promote_one

    _, _, _, vial_rows = native_family(db, sample_id="PB-7405", slots=SLOTS)
    rows = next(iter(vial_rows.values()))
    _fill(db, rows, pur=["98", "99"], qty=["1", "3"])
    parents = {(r.keyword, r.slot): _promote_one(db, r) for r in rows if r.result_value is not None}
    total = parents[(KW_BLEND_TOTAL, None)]
    stale = datetime(2026, 9, 1, 9, 0, 0)
    total.captured_at = stale
    db.commit()

    svc_id = parents[(KW_QUANTITY, 2)].analysis_service_id
    new_ids, _ = parent_retest(db, sample_id="PB-7405", keyword=KW_QUANTITY, user_id=1, reason="t",
                               analysis_service_id=svc_id, slot=2)
    retest_row = db.get(LimsAnalysis, new_ids[0])
    apply_transition(db, analysis_id=retest_row.id, kind="submit", result_value="1", user_id=1)
    db.refresh(retest_row)
    _promote_one(db, retest_row)                                  # total 4 -> 2

    db.refresh(total)
    assert total.result_value == "2" and total.captured_at > stale
