"""build_variance_replicates: per-vial replicate records for the COA series.
Variance vials only (assignment_kind='variance'), vial_sequence order, each
record carrying its own PURITY/QUANTITY/IDENTITY (whatever it measured).
Parent NOT included (COABuilder prepends its own figure)."""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from coa.variance_series import build_variance_replicates
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
    Peptide,
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


def _svc(db, keyword, peptide_id=None):
    svc = AnalysisService(title=keyword, keyword=keyword, peptide_id=peptide_id)
    db.add(svc)
    db.flush()
    return svc


def _row(db, sub, svc, value, state="variance_verified"):
    db.add(LimsAnalysis(
        lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
        keyword=svc.keyword, title=svc.keyword, result_value=value,
        result_unit="mg" if svc.keyword.startswith("QTY") else None,
        review_state=state, reportable=True,
    ))
    db.flush()


@pytest.fixture
def world(db):
    pep = Peptide(name="BPC-157", abbreviation="BPC157", active=True)
    db.add(pep)
    db.flush()
    pur = _svc(db, "PUR_BPC157", pep.id)
    qty = _svc(db, "QTY_BPC157", pep.id)
    idsvc = _svc(db, "ID_BPC157", pep.id)
    parent = LimsSample(sample_id="P-0500", external_lims_uid="uid-p0500", container_mode=True)
    db.add(parent)
    db.flush()
    # vial 1 = core (excluded); vials 2,3 = variance
    subs = {}
    for seq, kind in ((1, "core"), (2, "variance"), (3, "variance")):
        sub = LimsSubSample(
            parent_sample_pk=parent.id, external_lims_uid=f"mk1://v{seq}",
            sample_id=f"P-0500-S{seq:02d}", vial_sequence=seq,
            assignment_role="hplc", assignment_kind=kind,
        )
        db.add(sub); db.flush()
        subs[seq] = sub
    # vial 2: full set; vial 3: purity + identity only (no quantity)
    _row(db, subs[2], pur, "99.1"); _row(db, subs[2], qty, "10.1"); _row(db, subs[2], idsvc, "BPC-157")
    _row(db, subs[3], pur, "97.21"); _row(db, subs[3], idsvc, "Out of Spec")
    # core vial has a row — must be EXCLUDED
    _row(db, subs[1], pur, "50.0")
    db.commit()
    return parent


def test_variance_vials_only_in_sequence_order(world, db):
    out = build_variance_replicates(db, world)
    recs = out["BPC-157"]
    assert [r["vial_sequence"] for r in recs] == [2, 3]  # core vial 1 excluded


def test_per_vial_records_carry_their_analytes(world, db):
    recs = build_variance_replicates(db, world)["BPC-157"]
    v2, v3 = recs[0], recs[1]
    assert v2["PURITY"] == "99.1%" and v2["QUANTITY"] == "10.1 mg" and v2["IDENTITY"] == "BPC-157"
    assert v3["PURITY"] == "97.21%" and v3["IDENTITY"] == "Out of Spec"
    assert "QUANTITY" not in v3  # vial 3 had no quantity row


def test_empty_when_no_variance_vials(db):
    parent = LimsSample(sample_id="P-0600", external_lims_uid="uid-p0600")
    db.add(parent); db.commit()
    assert build_variance_replicates(db, parent) == {}
