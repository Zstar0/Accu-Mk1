"""senaite-shape response carries result_type + result_options from the service."""
from __future__ import annotations

from models import AnalysisService, LimsSample, LimsSubSample, LimsAnalysis
from lims_analyses.service import list_analyses_in_senaite_shape


def _setup(db_session):
    svc = AnalysisService(
        title="Rapid Sterility Screening (PCR)", keyword="STER-PCR",
        result_type="select",
        result_options=[{"value": "1", "label": "Conforms"},
                        {"value": "0", "label": "Does Not Conform"}],
    )
    db_session.add(svc)
    db_session.flush()
    parent = LimsSample(sample_id="RT-0001", external_lims_uid="uid-RT-0001")
    db_session.add(parent)
    db_session.flush()
    sub = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid="mk1://x",
                        sample_id="RT-0001-S01", vial_sequence=1)
    db_session.add(sub)
    db_session.flush()
    a = LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
                     keyword="STER-PCR", title="Rapid Sterility Screening (PCR)",
                     review_state="to_be_verified", result_value=None)
    db_session.add(a)
    db_session.commit()
    return sub


def test_shape_carries_result_type_and_options(db_session):
    sub = _setup(db_session)
    rows = list_analyses_in_senaite_shape(
        db_session, host_kind="sub_sample", host_pk=sub.id, include_retests=False,
    )
    assert len(rows) == 1
    r = rows[0]
    assert r.result_type == "select"
    assert [o.model_dump() for o in r.result_options] == [
        {"value": "1", "label": "Conforms"},
        {"value": "0", "label": "Does Not Conform"},
    ]
