import re
from unittest.mock import patch, MagicMock
import pytest
from sub_samples.senaite import (
    create_secondary, SecondaryCreateResult, SecondaryFalloutError, fetch_secondaries,
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
