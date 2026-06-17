"""build_variance_analyte_series: keyword-keyed replicate series for
non-peptide (BW) analytes. Only variance_capable services included.
Parent NOT included (COABuilder prepends its own figure)."""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from models import (
    AnalysisService,
    LimsAnalysis,
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


def _svc(db, keyword, variance_capable=True, unit=None):
    svc = AnalysisService(
        title=keyword,
        keyword=keyword,
        variance_capable=variance_capable,
        unit=unit,
    )
    db.add(svc)
    db.flush()
    return svc


def _row(db, sub, svc, value, state="variance_verified", unit=None, retested=False, reportable=True):
    db.add(LimsAnalysis(
        lims_sub_sample_pk=sub.id,
        analysis_service_id=svc.id,
        keyword=svc.keyword,
        title=svc.keyword,
        result_value=value,
        result_unit=unit,
        review_state=state,
        reportable=reportable,
        retested=retested,
    ))
    db.flush()


@pytest.fixture
def bw_world(db):
    """BW-like parent with two variance vials, each carrying one
    variance_capable (PH-DETERM) and one non-capable (COLOUR) analysis."""
    ph_svc = _svc(db, "PH-DETERM", variance_capable=True, unit="pH")
    colour_svc = _svc(db, "COLOUR", variance_capable=False)

    parent = LimsSample(
        sample_id="BW-0001",
        external_lims_uid="uid-bw0001",
    )
    db.add(parent)
    db.flush()

    subs = {}
    for seq, kind in ((1, "variance"), (2, "variance")):
        sub = LimsSubSample(
            parent_sample_pk=parent.id,
            external_lims_uid=f"mk1://bw{seq}",
            sample_id=f"BW-0001-S{seq:02d}",
            vial_sequence=seq,
            assignment_role="hplc",
            assignment_kind=kind,
        )
        db.add(sub)
        db.flush()
        subs[seq] = sub

    # Vial 1: PH-DETERM=5.4, COLOUR (non-capable, must be excluded)
    _row(db, subs[1], ph_svc, "5.4", unit="pH")
    _row(db, subs[1], colour_svc, "Clear")

    # Vial 2: PH-DETERM=5.6, COLOUR (non-capable, must be excluded)
    _row(db, subs[2], ph_svc, "5.6", unit="pH")
    _row(db, subs[2], colour_svc, "Clear")

    db.commit()
    return parent


def test_series_keyed_by_keyword_only_includes_variance_capable(bw_world, db):
    from coa.variance_series import build_variance_analyte_series

    series = build_variance_analyte_series(db, bw_world)
    assert set(series.keys()) == {"PH-DETERM"}          # non-capable excluded
    assert series["PH-DETERM"]["values"] == ["5.4", "5.6"]  # vial-sequence order
    assert "unit" in series["PH-DETERM"]


def test_unit_populated_from_analysis_row(bw_world, db):
    from coa.variance_series import build_variance_analyte_series

    series = build_variance_analyte_series(db, bw_world)
    assert series["PH-DETERM"]["unit"] == "pH"


def test_unit_falls_back_to_service_unit_when_row_unit_missing(db):
    """When the analysis row carries no result_unit, the series unit must fall
    back to the lab-configured AnalysisService.unit. (bw_world sets both, so it
    can't isolate the fallback path.)"""
    from coa.variance_series import build_variance_analyte_series

    ph_svc = _svc(db, "PH-DETERM", variance_capable=True, unit="pH")
    parent = LimsSample(sample_id="BW-0004", external_lims_uid="uid-bw0004")
    db.add(parent)
    db.flush()

    sub = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid="mk1://bwfallback",
        sample_id="BW-0004-S01",
        vial_sequence=1,
        assignment_role="hplc",
        assignment_kind="variance",
    )
    db.add(sub)
    db.flush()
    # Row has NO result_unit -> must inherit svc.unit ("pH").
    _row(db, sub, ph_svc, "5.5", unit=None)
    db.commit()

    series = build_variance_analyte_series(db, parent)
    assert series["PH-DETERM"]["unit"] == "pH"
    assert series["PH-DETERM"]["values"] == ["5.5"]


def test_empty_when_no_variance_vials(db):
    from coa.variance_series import build_variance_analyte_series

    parent = LimsSample(sample_id="BW-0099", external_lims_uid="uid-bw0099")
    db.add(parent)
    db.commit()
    assert build_variance_analyte_series(db, parent) == {}


def test_core_vials_excluded(db):
    """A core vial (assignment_kind='core') must not contribute to the series."""
    from coa.variance_series import build_variance_analyte_series

    ph_svc = _svc(db, "PH-DETERM", variance_capable=True, unit="pH")
    parent = LimsSample(sample_id="BW-0002", external_lims_uid="uid-bw0002")
    db.add(parent)
    db.flush()

    core = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid="mk1://bwcore",
        sample_id="BW-0002-S01",
        vial_sequence=1,
        assignment_role="hplc",
        assignment_kind="core",  # NOT variance
    )
    db.add(core)
    db.flush()
    _row(db, core, ph_svc, "5.5", unit="pH")
    db.commit()

    assert build_variance_analyte_series(db, parent) == {}


def test_retested_vial_uses_current_result(db):
    """Current-row idiom: retested=False (not retest_of_id IS NULL)."""
    from coa.variance_series import build_variance_analyte_series

    ph_svc = _svc(db, "PH-DETERM", variance_capable=True, unit="pH")
    parent = LimsSample(sample_id="BW-0003", external_lims_uid="uid-bw0003")
    db.add(parent)
    db.flush()

    sub = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid="mk1://bwretest",
        sample_id="BW-0003-S01",
        vial_sequence=1,
        assignment_role="hplc",
        assignment_kind="variance",
    )
    db.add(sub)
    db.flush()

    # Superseded original (retested=True) — must NOT be returned.
    orig = LimsAnalysis(
        lims_sub_sample_pk=sub.id,
        analysis_service_id=ph_svc.id,
        keyword=ph_svc.keyword,
        title=ph_svc.keyword,
        result_value="4.0",
        result_unit="pH",
        review_state="variance_verified",
        reportable=True,
        retested=True,
    )
    db.add(orig)
    db.flush()

    # Current retest (retested=False) — this is the value we want.
    db.add(LimsAnalysis(
        lims_sub_sample_pk=sub.id,
        analysis_service_id=ph_svc.id,
        keyword=ph_svc.keyword,
        title=ph_svc.keyword,
        result_value="5.9",
        result_unit="pH",
        review_state="variance_verified",
        reportable=True,
        retested=False,
        retest_of_id=orig.id,
    ))
    db.commit()

    series = build_variance_analyte_series(db, parent)
    assert series["PH-DETERM"]["values"] == ["5.9"]
