import re
from unittest.mock import patch, MagicMock
import pytest
from sub_samples.senaite import (
    create_secondary, SecondaryCreateResult, SecondaryFalloutError, fetch_secondaries,
    fetch_results_by_keyword,
)


def test_create_secondary_posts_correct_payload():
    mock_resp = MagicMock(status_code=200)
    mock_resp.json.return_value = {"items": [{"uid": "SECONDARY_UID_ABC", "id": "P-0134-S01"}]}
    with patch("sub_samples.senaite._post_json", return_value=mock_resp) as m:
        result = create_secondary(
            parent_sample_id="P-0134",
            parent_uid="PARENT_UID_XYZ",
            client_uid="CLIENT_UID",
            contact_uid="CONTACT_UID",
            sample_type_uid="ST_UID",
        )
    assert isinstance(result, SecondaryCreateResult)
    assert result.uid == "SECONDARY_UID_ABC"
    assert result.sample_id == "P-0134-S01"
    payload = m.call_args.kwargs["json"]
    assert payload["portal_type"] == "AnalysisRequest"
    assert payload["parent_uid"] == "CLIENT_UID"
    assert payload["PrimaryAnalysisRequest"] == "PARENT_UID_XYZ"
    assert payload["Contact"] == "CONTACT_UID"
    assert payload["SampleType"] == "ST_UID"
    # MUST NOT send these — SENAITE overrides Client and inherits dates
    assert "Client" not in payload
    assert "DateSampled" not in payload
    assert "DateReceived" not in payload


def test_create_secondary_detects_silent_fallthrough_when_id_lacks_SNN():
    mock_resp = MagicMock(status_code=200)
    mock_resp.json.return_value = {"items": [{"uid": "ORPHAN_UID", "id": "P-0135"}]}
    with patch("sub_samples.senaite._post_json", return_value=mock_resp), \
         patch("sub_samples.senaite.delete_secondary") as cleanup:
        with pytest.raises(SecondaryFalloutError):
            create_secondary(
                parent_sample_id="P-0134",
                parent_uid="WRONG_UID", client_uid="C", contact_uid="CT", sample_type_uid="ST",
            )
    cleanup.assert_called_once_with("ORPHAN_UID")


def test_create_secondary_raises_on_http_error():
    mock_resp = MagicMock(status_code=500, text="boom")
    with patch("sub_samples.senaite._post_json", return_value=mock_resp):
        with pytest.raises(RuntimeError, match="SENAITE create_secondary failed"):
            create_secondary(
                parent_sample_id="P-0134",
                parent_uid="X", client_uid="Y", contact_uid="Z", sample_type_uid="W",
            )


def test_fetch_secondaries_uses_search_and_filters_client_side():
    mock_resp = MagicMock(status_code=200)
    mock_resp.json.return_value = {"items": [
        {"uid": "PARENT_UID", "id": "P-0134"},
        {"uid": "S01_UID", "id": "P-0134-S01"},
        {"uid": "S02_UID", "id": "P-0134-S02"},
        {"uid": "OTHER_UID", "id": "P-0134-R01"},  # retest, NOT a secondary
    ]}
    with patch("sub_samples.senaite._get", return_value=mock_resp) as m:
        secondaries = fetch_secondaries("P-0134")
    assert m.call_args.kwargs["params"]["q"] == "P-0134"
    assert {s["id"] for s in secondaries} == {"P-0134-S01", "P-0134-S02"}


# ── fetch_results_by_keyword ────────────────────────────────────────────────

def test_fetch_results_by_keyword_parses_numeric_results():
    mock_resp = MagicMock(status_code=200)
    mock_resp.json.return_value = {"items": [
        {"getKeyword": "PH-DETERM", "Result": "6.54",
         "ResultOptions": None, "getResultOptions": [],
         "review_state": "to_be_verified"},
        {"getKeyword": "Benzyl_Alcohol_Assay", "Result": "98.55",
         "ResultOptions": None, "getResultOptions": [],
         "review_state": "to_be_verified"},
    ]}
    with patch("sub_samples.senaite._get", return_value=mock_resp) as m:
        out = fetch_results_by_keyword("BW-0012")
    assert m.call_args.kwargs["params"]["getRequestID"] == "BW-0012"
    assert out == {
        "PH-DETERM": {"value": "6.54", "kind": "numeric", "spec": None},
        "Benzyl_Alcohol_Assay": {"value": "98.55", "kind": "numeric", "spec": None},
    }


def test_fetch_results_by_keyword_does_not_filter_on_review_state():
    """to_be_verified results must come through — the verified state is downstream."""
    mock_resp = MagicMock(status_code=200)
    mock_resp.json.return_value = {"items": [
        {"getKeyword": "PH", "Result": "6.54", "review_state": "to_be_verified"},
    ]}
    with patch("sub_samples.senaite._get", return_value=mock_resp):
        out = fetch_results_by_keyword("X-0001")
    assert "PH" in out


def test_fetch_results_by_keyword_detects_categorical_via_result_options():
    mock_resp = MagicMock(status_code=200)
    mock_resp.json.return_value = {"items": [
        {"getKeyword": "Identity", "Result": "1",
         "ResultOptions": [{"ResultValue": "1", "ResultText": "Conforms"},
                           {"ResultValue": "2", "ResultText": "Does not conform"}]},
    ]}
    with patch("sub_samples.senaite._get", return_value=mock_resp):
        out = fetch_results_by_keyword("X-0001")
    assert out["Identity"]["kind"] == "categorical"
    assert out["Identity"]["value"] == "1"


def test_fetch_results_by_keyword_categorical_via_get_result_options():
    """SENAITE returns selection options under getResultOptions in some response shapes."""
    mock_resp = MagicMock(status_code=200)
    mock_resp.json.return_value = {"items": [
        {"getKeyword": "Identity", "Result": "2",
         "ResultOptions": None,
         "getResultOptions": [{"ResultValue": "1", "ResultText": "Conforms"}]},
    ]}
    with patch("sub_samples.senaite._get", return_value=mock_resp):
        out = fetch_results_by_keyword("X-0001")
    assert out["Identity"]["kind"] == "categorical"


def test_fetch_results_by_keyword_falls_back_through_field_name_variants():
    mock_resp = MagicMock(status_code=200)
    mock_resp.json.return_value = {"items": [
        {"getKeyword": "A", "Result": None, "getResult": "1.23"},
        {"getKeyword": "B", "Result": None, "getResult": None, "result": "4.56"},
    ]}
    with patch("sub_samples.senaite._get", return_value=mock_resp):
        out = fetch_results_by_keyword("X-0001")
    assert out["A"]["value"] == "1.23"
    assert out["B"]["value"] == "4.56"


def test_fetch_results_by_keyword_skips_empty_or_keywordless_items():
    mock_resp = MagicMock(status_code=200)
    mock_resp.json.return_value = {"items": [
        {"getKeyword": "PH", "Result": None},          # no result yet
        {"getKeyword": "PH-EMPTY", "Result": ""},      # empty-string result
        {"Result": "9.9"},                             # missing keyword
        {"getKeyword": "PH-OK", "Result": "7.4"},
    ]}
    with patch("sub_samples.senaite._get", return_value=mock_resp):
        out = fetch_results_by_keyword("X-0001")
    assert set(out.keys()) == {"PH-OK"}


def test_fetch_results_by_keyword_soft_fails_on_http_error():
    mock_resp = MagicMock(status_code=500, text="boom")
    with patch("sub_samples.senaite._get", return_value=mock_resp):
        out = fetch_results_by_keyword("X-0001")
    assert out == {}


def test_fetch_results_by_keyword_soft_fails_on_transport_error():
    import requests as _requests
    with patch("sub_samples.senaite._get", side_effect=_requests.ConnectionError("down")):
        out = fetch_results_by_keyword("X-0001")
    assert out == {}
