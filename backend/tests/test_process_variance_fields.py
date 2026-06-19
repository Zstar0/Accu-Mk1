"""process_variance_fields: the variance portion of the COABuilder /process body.

generate_sample_coa attached the variance series, but regen_primary_coa did not —
so "Regen & Republish Primary" stripped the variance series off the COA. This
shared helper produces the variance fields both paths must send, keyed so a lone
caller can't drift out of parity again.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from models import AnalysisService, LimsAnalysis, LimsSample, LimsSubSample


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
    svc = AnalysisService(title=keyword, keyword=keyword, variance_capable=variance_capable, unit=unit)
    db.add(svc); db.flush()
    return svc


def _row(db, sub, svc, value, unit="pH"):
    db.add(LimsAnalysis(
        lims_sub_sample_pk=sub.id, analysis_service_id=svc.id, keyword=svc.keyword,
        title=svc.keyword, result_value=value, result_unit=unit,
        review_state="variance_verified", reportable=True, retested=False,
    ))
    db.flush()


def test_returns_variance_analytes_for_bw_parent_with_in_set_vials(db):
    from coa.variance_series import process_variance_fields

    ph = _svc(db, "PH-DETERM", variance_capable=True, unit="pH")
    parent = LimsSample(sample_id="BW-0010", external_lims_uid="uid-bw0010")
    db.add(parent); db.flush()
    for seq in (1, 2):
        sub = LimsSubSample(
            parent_sample_pk=parent.id, external_lims_uid=f"mk1://v{seq}",
            sample_id=f"BW-0010-S0{seq}", vial_sequence=seq,
            assignment_role="hplc", assignment_kind="variance", in_variance_set=True,
        )
        db.add(sub); db.flush()
        _row(db, sub, ph, "5.4" if seq == 1 else "5.6")
    db.commit()

    fields = process_variance_fields(db, parent)
    assert "variance_analytes" in fields
    assert fields["variance_analytes"]["PH-DETERM"]["values"] == ["5.4", "5.6"]


def test_empty_dict_when_no_variance(db):
    from coa.variance_series import process_variance_fields

    parent = LimsSample(sample_id="BW-0011", external_lims_uid="uid-bw0011")
    db.add(parent); db.commit()
    assert process_variance_fields(db, parent) == {}
