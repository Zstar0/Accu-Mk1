"""stamp_prep_assignment: creating a vial-scoped sample prep stamps the
prep's instrument and the peptide's method onto the vial's unassigned
HPLC-category lims_analyses rows.

Fill-only-NULL semantics: a value already on a row (bench overlay, earlier
prep) is never overwritten. Micro rows (no HPLC category) and rows past
'unassigned' are untouched. Audit goes through set_method_instrument's
existing 'auto' transition.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from database import Base
from lims_analyses.prep_bridge import stamp_prep_assignment
from models import (
    AnalysisService,
    HplcMethod,
    Instrument,
    LimsAnalysis,
    LimsAnalysisTransition,
    LimsSample,
    LimsSubSample,
)


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
def world(db):
    """Vial with 3 rows: HPLC purity (PUR_BPC157), HPLC identity (HPLC-ID),
    micro (ENDO-LAL). Plus a method + instrument. Returns a dict."""
    method = HplcMethod(name="Method A")
    instrument = Instrument(name="HPLC-01")
    db.add_all([method, instrument])
    parent = LimsSample(sample_id="P-0400", external_lims_uid="uid-p0400")
    db.add(parent)
    db.flush()
    sub = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid="mk1://stamp-001",
        sample_id="P-0400-S01",
        vial_sequence=1,
        assignment_role="hplc",
    )
    db.add(sub)
    db.flush()
    rows = {}
    for key, kw in (("pur", "PUR_BPC157"), ("ident", "HPLC-ID"), ("endo", "ENDO-LAL")):
        svc = AnalysisService(title=f"svc {kw}", keyword=kw)
        db.add(svc)
        db.flush()
        row = LimsAnalysis(
            lims_sub_sample_pk=sub.id,
            analysis_service_id=svc.id,
            keyword=kw,
            title=f"svc {kw}",
            review_state="unassigned",
        )
        db.add(row)
        db.flush()
        rows[key] = row
    db.commit()
    return {"sub": sub, "method": method, "instrument": instrument, **rows}


def test_stamps_method_and_instrument_on_hplc_rows_only(db, world):
    changed = stamp_prep_assignment(
        db,
        lims_sub_sample_pk=world["sub"].id,
        instrument_id=world["instrument"].id,
        method_id=world["method"].id,
    )
    assert sorted(changed) == sorted([world["pur"].id, world["ident"].id])
    for key in ("pur", "ident"):
        db.refresh(world[key])
        assert world[key].method_id == world["method"].id
        assert world[key].instrument_id == world["instrument"].id
    db.refresh(world["endo"])
    assert world["endo"].method_id is None
    assert world["endo"].instrument_id is None


def test_fill_only_null_never_overwrites(db, world):
    other_method = HplcMethod(name="Method B")
    db.add(other_method)
    db.commit()
    world["pur"].method_id = other_method.id
    db.commit()
    stamp_prep_assignment(
        db,
        lims_sub_sample_pk=world["sub"].id,
        instrument_id=world["instrument"].id,
        method_id=world["method"].id,
    )
    db.refresh(world["pur"])
    # Existing method kept; missing instrument filled in
    assert world["pur"].method_id == other_method.id
    assert world["pur"].instrument_id == world["instrument"].id


def test_rows_past_unassigned_untouched(db, world):
    world["pur"].review_state = "to_be_verified"
    db.commit()
    changed = stamp_prep_assignment(
        db,
        lims_sub_sample_pk=world["sub"].id,
        instrument_id=world["instrument"].id,
        method_id=world["method"].id,
    )
    assert changed == [world["ident"].id]
    db.refresh(world["pur"])
    assert world["pur"].instrument_id is None


def test_noop_when_nothing_to_stamp(db, world):
    assert stamp_prep_assignment(
        db, lims_sub_sample_pk=world["sub"].id, instrument_id=None, method_id=None,
    ) == []


def test_writes_audit_transition(db, world):
    stamp_prep_assignment(
        db,
        lims_sub_sample_pk=world["sub"].id,
        instrument_id=world["instrument"].id,
        method_id=world["method"].id,
    )
    txns = db.execute(
        select(LimsAnalysisTransition).where(
            LimsAnalysisTransition.analysis_id == world["pur"].id
        )
    ).scalars().all()
    assert any(
        t.transition_kind == "auto" and f"method_id={world['method'].id}" in (t.reason or "")
        for t in txns
    )
