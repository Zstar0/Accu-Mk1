"""Regression: reads of a VIAL row's current value/state must use
retested=False, not retest_of_id IS NULL (which returns the superseded
original once a retest exists). Same class as the P-0149 variance-series bug.

Covers the two remaining vial-row consumers found in the audit:
  - sub_samples._fetch_mk1_results_for_host  (feeds get_variance_set)
  - families._gather_analytes                (feeds _derive_state)
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from models import AnalysisService, LimsAnalysis, LimsSample, LimsSubSample
from sub_samples.service import _fetch_mk1_results_for_host
from families.service import _gather_analytes


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
def retested_vial(db):
    """A variance vial whose ID_BPC157 was retested: original conformed
    ('BPC-157', retested=True) and the current retest does not
    ('Does_Not_Conform', retested=False)."""
    svc = AnalysisService(title="ID_BPC157", keyword="ID_BPC157")
    db.add(svc)
    db.flush()
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
    orig = LimsAnalysis(
        lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
        keyword="ID_BPC157", title="ID_BPC157", result_value="BPC-157",
        review_state="verified", reportable=True, retested=True,
    )
    db.add(orig)
    db.flush()
    db.add(LimsAnalysis(
        lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
        keyword="ID_BPC157", title="ID_BPC157", result_value="Does_Not_Conform",
        review_state="variance_verified", reportable=True, retested=False,
        retest_of_id=orig.id,
    ))
    db.commit()
    return parent, sub


def test_fetch_mk1_results_uses_current_retest_value(retested_vial, db):
    _parent, sub = retested_vial
    out = _fetch_mk1_results_for_host(db, host_kind="sub_sample", host_pk=sub.id)
    assert out["ID_BPC157"]["value"] == "Does_Not_Conform"


def test_gather_analytes_uses_current_retest_state(retested_vial, db):
    parent, _sub = retested_vial
    breakdown = _gather_analytes(db, parent, [])
    assert breakdown["ID_BPC157"].vial_states == ["variance_verified"]
