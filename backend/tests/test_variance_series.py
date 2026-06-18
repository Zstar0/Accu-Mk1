"""build_variance_replicates: per-vial replicate records for the COA series.
Variance vials only (assignment_kind='variance'), vial_sequence order, each
record carrying its own PURITY/QUANTITY/IDENTITY (whatever it measured).
Parent NOT included (COABuilder prepends its own figure)."""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine, select
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


def test_deselected_vial_excluded(db):
    """A variance vial with in_variance_set=False (unchecked in the overlay)
    must NOT contribute a record — the COA series must match the overlay's
    selected set. Regression: builder filtered only on assignment_kind, so a
    deselected vial still reached the COA."""
    pep = Peptide(name="BPC-157", abbreviation="BPC157", active=True)
    db.add(pep); db.flush()
    pur = _svc(db, "PUR_BPC157", pep.id)
    parent = LimsSample(sample_id="P-0700", external_lims_uid="uid-p0700", container_mode=True)
    db.add(parent); db.flush()
    included = LimsSubSample(
        parent_sample_pk=parent.id, external_lims_uid="mk1://in",
        sample_id="P-0700-S01", vial_sequence=1,
        assignment_role="hplc", assignment_kind="variance", in_variance_set=True,
    )
    excluded = LimsSubSample(
        parent_sample_pk=parent.id, external_lims_uid="mk1://out",
        sample_id="P-0700-S02", vial_sequence=2,
        assignment_role="hplc", assignment_kind="variance", in_variance_set=False,
    )
    db.add_all([included, excluded]); db.flush()
    _row(db, included, pur, "99.1")
    _row(db, excluded, pur, "12.3")  # must NOT appear
    db.commit()

    recs = build_variance_replicates(db, parent)["BPC-157"]
    assert [r["vial_sequence"] for r in recs] == [1]
    assert recs[0]["PURITY"] == "99.1%"


def test_empty_when_no_variance_vials(db):
    parent = LimsSample(sample_id="P-0600", external_lims_uid="uid-p0600")
    db.add(parent); db.commit()
    assert build_variance_replicates(db, parent) == {}


@pytest.fixture
def prod_world(db):
    """Production single-peptide shape: generic purity/quantity services that
    carry NO peptide_id (HPLC-PUR, PEPT-Total) and a peptide-specific identity
    service (ID_BPC157). The vial's peptide is known only via its identity row;
    purity/quantity must still attach to that peptide."""
    pep = Peptide(name="BPC-157", abbreviation="BPC157", active=True)
    db.add(pep)
    db.flush()
    pur = _svc(db, "HPLC-PUR")                 # generic, peptide_id=None
    qty = _svc(db, "PEPT-Total")               # generic, peptide_id=None
    idsvc = _svc(db, "ID_BPC157", pep.id)      # peptide-specific
    parent = LimsSample(sample_id="P-0700", external_lims_uid="uid-p0700", container_mode=True)
    db.add(parent)
    db.flush()
    subs = {}
    for seq, kind in ((1, "core"), (2, "variance"), (3, "variance")):
        sub = LimsSubSample(
            parent_sample_pk=parent.id, external_lims_uid=f"mk1://w{seq}",
            sample_id=f"P-0700-S{seq:02d}", vial_sequence=seq,
            assignment_role="hplc", assignment_kind=kind,
        )
        db.add(sub); db.flush()
        subs[seq] = sub
    _row(db, subs[2], pur, "93.1"); _row(db, subs[2], qty, "15"); _row(db, subs[2], idsvc, "BPC-157")
    _row(db, subs[3], pur, "99.98"); _row(db, subs[3], qty, "15"); _row(db, subs[3], idsvc, "BPC-157")
    db.commit()
    return parent


def test_generic_services_attach_purity_quantity_to_vial_peptide(prod_world, db):
    recs = build_variance_replicates(db, prod_world)["BPC-157"]
    assert [r["vial_sequence"] for r in recs] == [2, 3]
    v2, v3 = recs[0], recs[1]
    assert v2["PURITY"] == "93.1%" and v2["IDENTITY"] == "BPC-157"
    assert v2.get("QUANTITY", "").startswith("15")
    assert v3["PURITY"] == "99.98%"
    assert v3.get("QUANTITY", "").startswith("15")


def test_retested_vial_uses_current_result_not_superseded_original(db):
    """Regression (P-0149 S03): a variance vial whose identity was retested must
    report the CURRENT (retested=False) value, not the superseded original.
    `retest_of_id IS NULL` grabs the stale original (which becomes retested=True
    once a retest exists); `retested IS False` is the correct current-row idiom
    for vial-tier rows."""
    pep = Peptide(name="BPC-157", abbreviation="BPC157", active=True)
    db.add(pep)
    db.flush()
    idsvc = _svc(db, "ID_BPC157", pep.id)
    parent = LimsSample(sample_id="P-0149", external_lims_uid="uid-p0149", container_mode=True)
    db.add(parent)
    db.flush()
    sub = LimsSubSample(
        parent_sample_pk=parent.id, external_lims_uid="mk1://s3",
        sample_id="P-0149-S03", vial_sequence=3,
        assignment_role="hplc", assignment_kind="variance",
    )
    db.add(sub)
    db.flush()
    # Superseded original identity: matched BPC-157, now retested away.
    orig = LimsAnalysis(
        lims_sub_sample_pk=sub.id, analysis_service_id=idsvc.id,
        keyword="ID_BPC157", title="ID_BPC157", result_value="BPC-157",
        review_state="variance_verified", reportable=True, retested=True,
    )
    db.add(orig)
    db.flush()
    # Current retest: does not conform.
    db.add(LimsAnalysis(
        lims_sub_sample_pk=sub.id, analysis_service_id=idsvc.id,
        keyword="ID_BPC157", title="ID_BPC157", result_value="Does_Not_Conform",
        review_state="variance_verified", reportable=True, retested=False,
        retest_of_id=orig.id,
    ))
    db.commit()
    recs = build_variance_replicates(db, parent)["BPC-157"]
    assert len(recs) == 1
    assert recs[0]["IDENTITY"] == "Does_Not_Conform"


def test_vial_quantity_inherits_parent_unit_when_missing(prod_world, db):
    """Vial PEPT-Total rows often carry no unit; the series must not fabricate
    'mg' next to a parent measured in mg/mL. Inherit the parent's quantity unit
    so the comma series stays consistent ('12 mg/mL, 15 mg/mL, ...')."""
    qty = db.execute(
        select(AnalysisService).where(AnalysisService.keyword == "PEPT-Total")
    ).scalar_one()
    # Parent-tier quantity row carries the canonical unit.
    db.add(LimsAnalysis(
        lims_sample_pk=prod_world.id, analysis_service_id=qty.id,
        keyword="PEPT-Total", title="PEPT-Total", result_value="12",
        result_unit="mg/mL", review_state="verified", reportable=True,
    ))
    db.commit()
    recs = build_variance_replicates(db, prod_world)["BPC-157"]
    assert recs[0]["QUANTITY"] == "15 mg/mL"
