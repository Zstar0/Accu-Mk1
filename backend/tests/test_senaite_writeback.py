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
    list_parent_line_states,
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
    # Live SENAITE Analysis items carry getKeyword (verified against dev
    # GET /Analysis?getRequestID=...). Use it as the primary shape in fixtures.
    return {"uid": uid, "getKeyword": keyword, "review_state": review_state}


# ---------------------------------------------------------------------------
# Test 1: find_parent_analysis_line — keyword match among multiple items;
#         prefers an active (non-retracted/rejected/verified) line when present.
# ---------------------------------------------------------------------------

def test_find_parent_analysis_line_returns_uid_and_state_for_matching_keyword():
    # uid-bbb is verified; uid-ccc is unassigned — the helper must prefer uid-bbb
    # was previously returning the verified line, which is now wrong.  The
    # correct behaviour is to skip verified and return the active line.
    items = [
        _analysis_item("uid-aaa", "HPLC_ASSAY", "to_be_verified"),
        _analysis_item("uid-bbb", "Identity", "to_be_verified"),
        _analysis_item("uid-ccc", "Water_Content", "unassigned"),
    ]
    with patch("lims_analyses.senaite_writeback._get", return_value=_ok_resp(items)):
        result = find_parent_analysis_line("P-0042", "Identity")

    assert result == {"uid": "uid-bbb", "review_state": "to_be_verified"}


# ---------------------------------------------------------------------------
# Test 1b: find_parent_analysis_line — also matches the legacy 'Keyword' shape
# ---------------------------------------------------------------------------

def test_find_parent_analysis_line_matches_legacy_Keyword_shape():
    # Catalog/brain form of an Analysis item uses 'Keyword' instead of
    # 'getKeyword'; the helper must match both.
    items = [
        {"uid": "uid-legacy", "Keyword": "Identity", "review_state": "unassigned"},
    ]
    with patch("lims_analyses.senaite_writeback._get", return_value=_ok_resp(items)):
        result = find_parent_analysis_line("P-0042", "Identity")

    assert result == {"uid": "uid-legacy", "review_state": "unassigned"}


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
# Test 2b: find_parent_analysis_line — matched item missing uid → fail-closed
# ---------------------------------------------------------------------------

def test_find_parent_analysis_line_raises_on_matched_item_missing_uid():
    items = [
        {"getKeyword": "Identity", "review_state": "unassigned"},  # no uid
    ]
    with patch("lims_analyses.senaite_writeback._get", return_value=_ok_resp(items)):
        with pytest.raises(SenaiteWritebackError) as exc_info:
            find_parent_analysis_line("P-0042", "Identity")

    assert "missing" in str(exc_info.value).lower()


# ---------------------------------------------------------------------------
# Test 2c: find_parent_analysis_line — transport error wrapped, not leaked
# ---------------------------------------------------------------------------

def test_find_parent_analysis_line_wraps_transport_error():
    with patch(
        "lims_analyses.senaite_writeback._get",
        side_effect=_requests.ConnectionError("connection refused"),
    ):
        with pytest.raises(SenaiteWritebackError):
            find_parent_analysis_line("P-0042", "Identity")


# ---------------------------------------------------------------------------
# Test 3: writeback_promotion happy path from state 'unassigned'
#   Sequence must be: result+remarks _update → submit _transition
#   (line is left at to_be_verified; lab manager verifies manually)
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
    assert len(call_log) == 2
    # First call: result + remarks update (no 'transition' key)
    assert "transition" not in call_log[0]
    assert call_log[0].get("Result") == "98.5"
    assert call_log[0].get("Remarks") == "Promoted from vial"
    # Second call: submit transition — line left at to_be_verified for manual verify
    assert call_log[1].get("transition") == "submit"


# ---------------------------------------------------------------------------
# Test 4: writeback_promotion skips submit when line is already 'to_be_verified'
#         — only result+remarks update is performed; line stays at to_be_verified
# ---------------------------------------------------------------------------

def test_writeback_promotion_skips_submit_when_already_to_be_verified():
    call_log = []

    find_resp = _ok_resp([_analysis_item("uid-xyz", "HPLC_ASSAY", "to_be_verified")])

    def fake_post_json(url, **kwargs):
        payload = kwargs.get("json", {})
        call_log.append(payload)
        r = MagicMock(status_code=200)
        r.json.return_value = {"items": [{"review_state": "to_be_verified"}]}
        return r

    with patch("lims_analyses.senaite_writeback._get", return_value=find_resp), \
         patch("lims_analyses.senaite_writeback._post_json", side_effect=fake_post_json):
        uid = writeback_promotion("P-0042", "HPLC_ASSAY", "98.5", "remark")

    assert uid == "uid-xyz"
    assert len(call_log) == 1
    # Only the result+remarks update — no submit, no verify transitions
    transitions = [c.get("transition") for c in call_log if "transition" in c]
    assert transitions == []


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


# ---------------------------------------------------------------------------
# Task 3: new preference tests — active line preferred over verified
# ---------------------------------------------------------------------------

# Test 7: [verified, unassigned] in verified-first order → returns the
#          unassigned uid, NOT the verified one.
def test_find_parent_analysis_line_prefers_unassigned_over_verified_verified_first():
    items = [
        _analysis_item("uid-verified", "Identity", "verified"),
        _analysis_item("uid-active", "Identity", "unassigned"),
    ]
    with patch("lims_analyses.senaite_writeback._get", return_value=_ok_resp(items)):
        result = find_parent_analysis_line("P-0042", "Identity")

    assert result == {"uid": "uid-active", "review_state": "unassigned"}


# Test 8: [unassigned, verified] in active-first order → same result.
def test_find_parent_analysis_line_prefers_unassigned_over_verified_active_first():
    items = [
        _analysis_item("uid-active", "Identity", "unassigned"),
        _analysis_item("uid-verified", "Identity", "verified"),
    ]
    with patch("lims_analyses.senaite_writeback._get", return_value=_ok_resp(items)):
        result = find_parent_analysis_line("P-0042", "Identity")

    assert result == {"uid": "uid-active", "review_state": "unassigned"}


# Test 9: only-verified line(s) → SenaiteWritebackError with SENAITE-retest
#          message; _update and _transition are NEVER called.
def test_find_parent_analysis_line_only_verified_raises_with_correct_message():
    items = [
        _analysis_item("uid-verified", "Identity", "verified"),
    ]
    with patch("lims_analyses.senaite_writeback._get", return_value=_ok_resp(items)), \
         patch("lims_analyses.senaite_writeback._update") as mock_update, \
         patch("lims_analyses.senaite_writeback._transition") as mock_transition:
        with pytest.raises(SenaiteWritebackError) as exc_info:
            find_parent_analysis_line("P-0042", "Identity")

    msg = str(exc_info.value)
    assert "already verified in SENAITE" in msg
    assert "retest or retract there first" in msg
    mock_update.assert_not_called()
    mock_transition.assert_not_called()


# ---------------------------------------------------------------------------
# list_parent_line_states tests
# ---------------------------------------------------------------------------

def test_list_parent_line_states_maps_verified_keyword():
    """A keyword with only a verified line → mapped to 'verified' in the dict."""
    items = [
        _analysis_item("uid-a", "STER-PCR", "verified"),
        _analysis_item("uid-b", "ENDO-LAL", "to_be_verified"),
    ]
    with patch("lims_analyses.senaite_writeback._get", return_value=_ok_resp(items)):
        states = list_parent_line_states("P-0144")

    assert states["STER-PCR"] == "verified"
    assert states["ENDO-LAL"] == "to_be_verified"


def test_list_parent_line_states_prefers_non_verified_when_both_present():
    """Verified + active for same keyword → active state wins (retest in flight)."""
    items = [
        _analysis_item("uid-old", "STER-PCR", "verified"),
        _analysis_item("uid-new", "STER-PCR", "to_be_verified"),
    ]
    with patch("lims_analyses.senaite_writeback._get", return_value=_ok_resp(items)):
        states = list_parent_line_states("P-0144")

    # Active (non-verified) line takes precedence; vial row should NOT be locked.
    assert states["STER-PCR"] == "to_be_verified"


def test_list_parent_line_states_skips_retracted_and_rejected():
    """Retracted and rejected lines do not contribute to the result."""
    items = [
        _analysis_item("uid-r1", "STER-PCR", "retracted"),
        _analysis_item("uid-r2", "ENDO-LAL", "rejected"),
        _analysis_item("uid-a", "HPLC_ASSAY", "to_be_verified"),
    ]
    with patch("lims_analyses.senaite_writeback._get", return_value=_ok_resp(items)):
        states = list_parent_line_states("P-0144")

    assert "STER-PCR" not in states
    assert "ENDO-LAL" not in states
    assert states["HPLC_ASSAY"] == "to_be_verified"


def test_list_parent_line_states_transport_error_raises():
    """Transport failure → SenaiteWritebackError (best-effort route must catch)."""
    with patch(
        "lims_analyses.senaite_writeback._get",
        side_effect=_requests.ConnectionError("timeout"),
    ):
        with pytest.raises(SenaiteWritebackError):
            list_parent_line_states("P-0144")


def test_list_parent_line_states_http_error_raises():
    """Non-2xx HTTP response → SenaiteWritebackError."""
    bad_resp = MagicMock(status_code=503)
    bad_resp.text = "service unavailable"
    with patch("lims_analyses.senaite_writeback._get", return_value=bad_resp):
        with pytest.raises(SenaiteWritebackError):
            list_parent_line_states("P-0144")


def test_list_parent_line_states_empty_items_returns_empty_dict():
    """No items (new AR) → empty dict, no error."""
    with patch("lims_analyses.senaite_writeback._get", return_value=_ok_resp([])):
        states = list_parent_line_states("P-0144")

    assert states == {}
