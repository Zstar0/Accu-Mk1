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


from main import _parse_service_result_options, _apply_service_result_type


def test_parse_service_result_options_maps_value_label():
    raw = [
        {"ResultValue": 1, "ResultText": "Conforms"},
        {"ResultValue": 0, "ResultText": "Does Not Conform"},
    ]
    assert _parse_service_result_options(raw) == [
        {"value": "1", "label": "Conforms"},
        {"value": "0", "label": "Does Not Conform"},
    ]


def test_parse_service_result_options_handles_empty():
    assert _parse_service_result_options(None) == []
    assert _parse_service_result_options([]) == []


def test_apply_seeds_when_result_type_null(db_session):
    svc = AnalysisService(title="Ster", keyword="STER-PCR")  # result_type is None
    db_session.add(svc)
    db_session.flush()
    item = {"ResultType": "select", "ResultOptions": [{"ResultValue": 1, "ResultText": "Conforms"}]}

    _apply_service_result_type(svc, item)

    assert svc.result_type == "select"
    assert svc.result_options == [{"value": "1", "label": "Conforms"}]


def test_apply_does_not_overwrite_existing(db_session):
    svc = AnalysisService(
        title="Ster", keyword="STER-PCR",
        result_type="numeric", result_options=[{"value": "x", "label": "y"}],
    )
    db_session.add(svc)
    db_session.flush()
    item = {"ResultType": "select", "ResultOptions": [{"ResultValue": 1, "ResultText": "Conforms"}]}

    _apply_service_result_type(svc, item)  # local-wins: unchanged

    assert svc.result_type == "numeric"
    assert svc.result_options == [{"value": "x", "label": "y"}]
