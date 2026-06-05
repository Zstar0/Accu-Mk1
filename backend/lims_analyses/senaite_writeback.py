"""SENAITE write-back helper for promotion of vial-tier results to parent AR.

Public surface:
  - SenaiteWritebackError  — all failures raise this; callers catch one type.
  - find_parent_analysis_line(parent_sample_id, keyword) -> dict
  - writeback_promotion(parent_sample_id, keyword, result_value, remark) -> uid

Internal helpers (exposed for testing):
  - _update(uid, payload) -> dict
  - _transition(uid, action) -> str

Fail-closed: every network error and every unexpected SENAITE response is
converted to SenaiteWritebackError so the calling promote route can abort
cleanly.

Write-back flow: after result+remarks are posted and the line is submitted,
the parent AR analysis line is left at ``to_be_verified`` so the lab manager
can review and verify it manually in SENAITE (or on the parent AR page).
The verify transition is NOT performed automatically.
"""
import os
import logging
import requests

log = logging.getLogger(__name__)

_SENAITE_HOST = os.environ.get("SENAITE_URL", "http://localhost:8080").rstrip("/")
SENAITE_BASE_URL = os.environ.get("SENAITE_BASE_URL", f"{_SENAITE_HOST}/senaite")
SENAITE_USER = os.environ.get("SENAITE_USER", "admin")
SENAITE_PASSWORD = os.environ.get("SENAITE_PASSWORD", "admin")

# Maps workflow action name → the review_state SENAITE must report after it.
EXPECTED_POST_STATES: dict[str, str] = {
    "submit": "to_be_verified",
    "verify": "verified",
}


class SenaiteWritebackError(RuntimeError):
    """Write-back failed; promote must abort (fail-closed)."""


# ---------------------------------------------------------------------------
# HTTP thin wrappers — identical signature to sub_samples/senaite.py so the
# same patch("lims_analyses.senaite_writeback._get") pattern works in tests.
# ---------------------------------------------------------------------------

def _post_json(url: str, **kwargs) -> requests.Response:
    return requests.post(url, auth=(SENAITE_USER, SENAITE_PASSWORD), timeout=30, **kwargs)


def _get(url: str, **kwargs) -> requests.Response:
    return requests.get(url, auth=(SENAITE_USER, SENAITE_PASSWORD), timeout=30, **kwargs)


# ---------------------------------------------------------------------------
# Public / internal helpers
# ---------------------------------------------------------------------------

def find_parent_analysis_line(parent_sample_id: str, keyword: str) -> dict:
    """Locate the analysis line on a parent SENAITE AR that matches *keyword*.

    GETs Analysis?getRequestID=<parent_sample_id> and scans the items list for
    the first item whose ``Keyword`` field matches *keyword*.

    Returns ``{"uid": ..., "review_state": ...}``.

    Raises SenaiteWritebackError if:
      - HTTP error occurs (including transport failures)
      - The response contains no items
      - No item has the requested keyword
    """
    url = f"{SENAITE_BASE_URL}/@@API/senaite/v1/Analysis"
    try:
        resp = _get(url, params={"getRequestID": parent_sample_id})
    except requests.RequestException as exc:
        raise SenaiteWritebackError(
            f"SENAITE transport error fetching analysis lines for {parent_sample_id}: {exc}"
        ) from exc

    if resp.status_code >= 300:
        raise SenaiteWritebackError(
            f"SENAITE find_parent_analysis_line HTTP {resp.status_code} for "
            f"{parent_sample_id}: {resp.text[:300]}"
        )

    items = resp.json().get("items", [])
    if not items:
        raise SenaiteWritebackError(
            f"SENAITE returned no analysis lines for parent={parent_sample_id} "
            f"(keyword={keyword})"
        )

    # A retract in SENAITE leaves the retracted line in place and adds a
    # retest copy with the same keyword — prefer ACTIVE lines so write-back
    # never targets a retracted/rejected/verified one.  Preference order:
    #   1. Lines not in (retracted, rejected, verified) — write-back targets
    #      these directly.
    #   2. If only verified lines remain → error: caller must retest or retract
    #      in SENAITE first.
    #   3. All retracted/rejected → error unchanged.
    matched: list[dict] = []
    for item in items:
        # Live SENAITE returns getKeyword on Analysis items; the catalog/brain
        # form uses Keyword. Match both shapes (same dual-key pattern main.py
        # uses for ResultType/getResultType).
        item_kw = item.get("Keyword") or item.get("getKeyword")
        if item_kw == keyword:
            uid = item.get("uid")
            state = item.get("review_state")
            if not uid or state is None:
                raise SenaiteWritebackError(
                    f"SENAITE analysis item for keyword={keyword} missing "
                    f"uid or review_state: {item}"
                )
            matched.append({"uid": uid, "review_state": state})
    # First preference: active (non-retracted/rejected/verified) line.
    for line in matched:
        if line["review_state"] not in ("retracted", "rejected", "verified"):
            return line
    # No active line — check for verified line(s) before falling through.
    if any(line["review_state"] == "verified" for line in matched):
        raise SenaiteWritebackError(
            f"Analysis {keyword} on {parent_sample_id} is already verified in "
            f"SENAITE — retest or retract there first"
        )
    if matched:
        raise SenaiteWritebackError(
            f"all {len(matched)} SENAITE lines for keyword={keyword} on "
            f"parent={parent_sample_id} are retracted/rejected"
        )

    raise SenaiteWritebackError(
        f"SENAITE has no analysis line with keyword={keyword} on parent={parent_sample_id}"
    )


def _update(uid: str, payload: dict) -> dict:
    """POST to /update/{uid} with *payload*; returns the first item in the response.

    Raises SenaiteWritebackError on HTTP error or empty items list.
    """
    url = f"{SENAITE_BASE_URL}/@@API/senaite/v1/update/{uid}"
    try:
        resp = _post_json(url, json=payload)
    except requests.RequestException as exc:
        raise SenaiteWritebackError(
            f"SENAITE transport error on update uid={uid}: {exc}"
        ) from exc

    if resp.status_code >= 300:
        raise SenaiteWritebackError(
            f"SENAITE _update HTTP {resp.status_code} uid={uid}: {resp.text[:300]}"
        )

    items = resp.json().get("items", [])
    if not items:
        raise SenaiteWritebackError(
            f"SENAITE _update returned empty items for uid={uid}"
        )

    return items[0]


def _transition(uid: str, action: str) -> str:
    """Apply a workflow *action* to the analysis at *uid* via ``_update``.

    Compares the resulting ``review_state`` to ``EXPECTED_POST_STATES[action]``.
    If they don't match SENAITE silently rejected the transition — raises
    SenaiteWritebackError naming 'silently rejected' plus both states.

    Returns the new review_state string on success.
    """
    item = _update(uid, {"transition": action})
    new_state = item.get("review_state", "")
    expected = EXPECTED_POST_STATES[action]
    if new_state != expected:
        raise SenaiteWritebackError(
            f"SENAITE silently rejected transition '{action}' on uid={uid}: "
            f"expected review_state={expected!r} but got {new_state!r}"
        )
    return new_state


def writeback_promotion(
    parent_sample_id: str,
    keyword: str,
    result_value: str,
    remark: str,
) -> str:
    """Write a promoted result back to the parent SENAITE AR analysis line.

    Orchestration:
      1. Locate the analysis line (find_parent_analysis_line).
      2. If already ``verified``: raise SenaiteWritebackError — retract in
         SENAITE first.
      3. POST result + remark to the analysis line (_update).
      4. If not already ``to_be_verified``: submit the line (_transition).

    The line is intentionally left at ``to_be_verified`` after write-back so
    the lab manager can verify it manually in SENAITE (or on the parent AR
    page).  The verify transition is NOT performed automatically.

    Returns the analysis line UID on success.
    All failures raise SenaiteWritebackError (fail-closed).
    """
    line = find_parent_analysis_line(parent_sample_id, keyword)
    uid = line["uid"]
    initial_state = line["review_state"]

    if initial_state == "verified":
        raise SenaiteWritebackError(
            f"Analysis {keyword} on {parent_sample_id} is already verified in "
            f"SENAITE — retract there first before promoting"
        )

    _update(uid, {"Result": result_value, "Remarks": remark})

    if initial_state != "to_be_verified":
        _transition(uid, "submit")

    return uid
