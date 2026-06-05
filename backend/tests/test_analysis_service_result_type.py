"""Result type + options on AnalysisService (analysis_services)."""
from __future__ import annotations

from models import AnalysisService


def test_analysis_service_result_type_columns(db_session):
    svc = AnalysisService(
        title="Rapid Sterility Screening (PCR)",
        keyword="STER-PCR",
        result_type="select",
        result_options=[
            {"value": "1", "label": "Conforms"},
            {"value": "0", "label": "Does Not Conform"},
        ],
    )
    db_session.add(svc)
    db_session.commit()
    db_session.refresh(svc)

    assert svc.result_type == "select"
    assert svc.result_options == [
        {"value": "1", "label": "Conforms"},
        {"value": "0", "label": "Does Not Conform"},
    ]


def test_analysis_service_result_type_defaults_none(db_session):
    svc = AnalysisService(title="HPLC Purity", keyword="HPLC-PUR")
    db_session.add(svc)
    db_session.commit()
    db_session.refresh(svc)
    assert svc.result_type is None
    assert svc.result_options is None
