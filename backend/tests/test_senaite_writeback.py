"""Tests for lims_analyses.senaite_writeback — all HTTP mocked at the wrapper level.

Mocking strategy mirrors test_sub_samples_senaite.py: patch the module-level
_get / _post_json wrappers so no real network calls occur regardless of env vars.
"""
import pytest
import requests as _requests
from unittest.mock import MagicMock, patch, call

from lims_analyses.senaite_writeback import (
    SenaiteWritebackError,
    find_parent_analysis_line,
    writeback_promotion,
    _update,
    _transition,
    EXPECTED_POST_STATES,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ok_resp(items):
    """Build a mock Response with status_code=200 and items list."""
    r = MagicMock(status_code=200)
    r.json.return_value = {"items": items}
    return r


def _analysis_item(uid, keyword, review_state):
    return {"uid": uid, "Keyword": keyword, "review_state": review_state}


# ---------------------------------------------------------------------------
# Test 1: find_parent_analysis_line — keyword match among multiple items
# ---------------------------------------------------------------------------

def test_find_parent_analysis_line_returns_uid_and_state_for_matching_keyword():
    items = [
        _analysis_item("uid-aaa", "HPLC_ASSAY", "to_be_verified"),
        _analysis_item("uid-bbb", "Identity", "verified"),
        _analysis_item("uid-ccc", "Water_Content", "unassigned"),
    ]
    with patch("lims_analyses.senaite_writeback._get", return_value=_ok_resp(items)):
        result = find_parent_analysis_line("P-0042", "Identity")

    assert result == {"uid": "uid-bbb", "review_state": "verified"}


# ---------------------------------------------------------------------------
# Test 2: find_parent_analysis_line — raises when keyword is absent
# ---------------------------------------------------------------------------

def test_find_parent_analysis_line_raises_when_keyword_absent():
    items = [
        _analysis_item("uid-aaa", "HPLC_ASSAY", "to_be_verified"),
    ]
    with patch("lims_analyses.senaite_writeback._get", return_value=_ok_resp(items)):
        with pytest.raises(SenaiteWritebackError) as exc_info:
            find_parent_analysis_line("P-0042", "Missing_Keyword")

    msg = str(exc_info.value)
    assert "Missing_Keyword" in msg
    assert "P-0042" in msg


# ---------------------------------------------------------------------------
# Test 3: writeback_promotion happy path from state 'unassigned'
#   Sequence must be: result+remarks _update → submit _transition → verify _transition
# ---------------------------------------------------------------------------

def test_writeback_promotion_full_sequence_from_unassigned():
    call_log = []

    find_resp = _ok_resp([_analysis_item("uid-xyz", "HPLC_ASSAY", "unassigned")])

    def fake_post_json(url, **kwargs):
        payload = kwargs.get("json", {})
        call_log.append(payload)
        transition = payload.get("transition")
        if transition == "submit":
            items = [{"review_state": "to_be_verified"}]
        elif transition == "verify":
            items = [{"review_state": "verified"}]
        else:
            # result+remarks update — review_state in response is irrelevant per spec
            items = [{"review_state": "unassigned"}]
        r = MagicMock(status_code=200)
        r.json.return_value = {"items": items}
        return r

    with patch("lims_analyses.senaite_writeback._get", return_value=find_resp), \
         patch("lims_analyses.senaite_writeback._post_json", side_effect=fake_post_json):
        uid = writeback_promotion("P-0042", "HPLC_ASSAY", "98.5", "Promoted from vial")

    assert uid == "uid-xyz"
    assert len(call_log) == 3
    # First call: result + remarks update (no 'transition' key)
    assert "transition" not in call_log[0]
    assert call_log[0].get("Result") == "98.5"
    assert call_log[0].get("Remarks") == "Promoted from vial"
    # Second call: submit transition
    assert call_log[1].get("transition") == "submit"
    # Third call: verify transition
    assert call_log[2].get("transition") == "verify"


# ---------------------------------------------------------------------------
# Test 4: writeback_promotion skips submit when line is already 'to_be_verified'
# ---------------------------------------------------------------------------

def test_writeback_promotion_skips_submit_when_already_to_be_verified():
    call_log = []

    find_resp = _ok_resp([_analysis_item("uid-xyz", "HPLC_ASSAY", "to_be_verified")])

    def fake_post_json(url, **kwargs):
        payload = kwargs.get("json", {})
        call_log.append(payload)
        transition = payload.get("transition")
        if transition == "verify":
            items = [{"review_state": "verified"}]
        else:
            items = [{"review_state": "to_be_verified"}]
        r = MagicMock(status_code=200)
        r.json.return_value = {"items": items}
        return r

    with patch("lims_analyses.senaite_writeback._get", return_value=find_resp), \
         patch("lims_analyses.senaite_writeback._post_json", side_effect=fake_post_json):
        uid = writeback_promotion("P-0042", "HPLC_ASSAY", "98.5", "remark")

    assert uid == "uid-xyz"
    assert len(call_log) == 2
    # No submit call — only result update then verify
    transitions = [c.get("transition") for c in call_log if "transition" in c]
    assert transitions == ["verify"]


# ---------------------------------------------------------------------------
# Test 5: writeback_promotion raises immediately on already-verified line,
#          makes NO _update or _transition calls
# ---------------------------------------------------------------------------

def test_writeback_promotion_raises_on_verified_line_with_no_calls():
    find_resp = _ok_resp([_analysis_item("uid-xyz", "HPLC_ASSAY", "verified")])

    with patch("lims_analyses.senaite_writeback._get", return_value=find_resp), \
         patch("lims_analyses.senaite_writeback._post_json") as mock_post:
        with pytest.raises(SenaiteWritebackError) as exc_info:
            writeback_promotion("P-0042", "HPLC_ASSAY", "98.5", "remark")

    mock_post.assert_not_called()
    assert "already verified" in str(exc_info.value).lower()


# ---------------------------------------------------------------------------
# Test 6: _transition raises SenaiteWritebackError on silent rejection
# ---------------------------------------------------------------------------

def test_transition_raises_on_silent_rejection():
    # _update returns an unchanged state instead of the expected post-state
    bad_item = [{"review_state": "unassigned"}]  # submit should yield to_be_verified
    with patch("lims_analyses.senaite_writeback._update", return_value=bad_item[0]):
        with pytest.raises(SenaiteWritebackError) as exc_info:
            _transition("uid-xyz", "submit")

    msg = str(exc_info.value)
    assert "silently rejected" in msg
    assert "to_be_verified" in msg   # expected state
    assert "unassigned" in msg        # actual state
