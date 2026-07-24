"""Input adapter: fetch a SENAITE AR + its analyses and shape them for the
vendored conformance engine. This is the ONLY bespoke code between SENAITE and
the engine; keep it in lockstep with what the engine reads (Result/Keyword/
Unit/Title/review_state/ResultCaptureDate) — see test_conformance_input_adapter.py.
"""
from __future__ import annotations

import os
from typing import Any

import requests

_SENAITE_HOST = os.environ.get("SENAITE_URL", "http://localhost:8080").rstrip("/")
SENAITE_BASE_URL = os.environ.get("SENAITE_BASE_URL", f"{_SENAITE_HOST}/senaite")
SENAITE_USER = os.environ.get("SENAITE_USER", "admin")
SENAITE_PASSWORD = os.environ.get("SENAITE_PASSWORD", "admin")

_AUTH = (SENAITE_USER, SENAITE_PASSWORD)


def _first(d: dict, *keys: str) -> Any:
    for k in keys:
        v = d.get(k)
        if v not in (None, ""):
            return v
    return None


def build_analyses_detailed(analysis_items: list[dict]) -> list[dict]:
    """Normalize raw SENAITE /Analysis list items into the per-analysis shape
    the engine reads. Preserves the original dict and ADDS the canonical keys
    (does not drop anything) so the engine's own fallbacks still work."""
    out: list[dict] = []
    for a in analysis_items:
        row = dict(a)  # keep everything; the engine also reads title/service_title/uid
        row["Keyword"] = _first(a, "Keyword", "getKeyword")
        row["Result"] = _first(a, "Result", "getResult", "result")
        row["Unit"] = _first(a, "Unit", "getUnit") or ""
        row["Title"] = _first(a, "Title", "title", "getServiceTitle", "ServiceTitle")
        row["review_state"] = _first(a, "review_state", "getReviewState")
        row["ResultCaptureDate"] = _first(a, "ResultCaptureDate", "getResultCaptureDate")
        out.append(row)
    return out


def fetch_ar_blob(sample_id: str) -> dict:
    """Fetch the full SENAITE AR record (all Accumark custom fields intact).
    Two-step id->uid->complete, mirroring sub_samples.senaite.fetch_parent_metadata."""
    list_resp = requests.get(
        f"{SENAITE_BASE_URL}/@@API/senaite/v1/AnalysisRequest",
        params={"id": sample_id}, auth=_AUTH, timeout=30,
    )
    list_resp.raise_for_status()
    items = list_resp.json().get("items", [])
    if not items:
        raise LookupError(f"SENAITE has no AR with id={sample_id}")
    uid = items[0]["uid"]
    detail = requests.get(
        f"{SENAITE_BASE_URL}/@@API/senaite/v1/AnalysisRequest/{uid}",
        params={"complete": "true"}, auth=_AUTH, timeout=30,
    )
    detail.raise_for_status()
    detail_items = detail.json().get("items", [])
    if not detail_items:
        raise LookupError(f"SENAITE detail empty for uid={uid}")
    return detail_items[0]


def fetch_analysis_items(sample_id: str) -> list[dict]:
    """Single bulk read of the sample's analyses (2nd of the 2 round-trips).
    Deliberately one call, not per-UID — clear of the bulk-scan hazard."""
    resp = requests.get(
        f"{SENAITE_BASE_URL}/@@API/senaite/v1/Analysis",
        params={"getRequestID": sample_id, "complete": "yes", "limit": "100"},
        auth=_AUTH, timeout=30,
    )
    resp.raise_for_status()
    return resp.json().get("items", [])
