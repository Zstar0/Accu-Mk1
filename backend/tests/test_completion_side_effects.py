"""Tests for backend/jobs/completion_side_effects.py.

Covers idempotency, peptide vs non-peptide branching, and per-function failure
isolation. HTTP is mocked at `backend.integration_service_client.requests.post`
so no real network traffic occurs. The accumark_mk1 DB is required (same
pattern as test_relay_status_to_wp.py and test_peptide_request_repo.py).
"""
import os
import uuid

import pytest
from unittest.mock import patch, MagicMock
from psycopg2.extras import RealDictCursor

# Set required env vars BEFORE importing the client / job modules so that
# IntegrationServiceClient.__init__ and get_config() can find them.
os.environ.setdefault("INTEGRATION_SERVICE_URL", "http://fake-integration")
os.environ.setdefault("INTEGRATION_SERVICE_TOKEN", "fake-token")
os.environ.setdefault("CLICKUP_LIST_ID", "fake-list-id")
os.environ.setdefault("CLICKUP_API_TOKEN", "fake-clickup-token")
os.environ.setdefault("CLICKUP_WEBHOOK_SECRET", "fake-webhook-secret")
os.environ.setdefault("MK1_DB_HOST", "localhost")
# Existing SENAITE-path tests were written against the legacy default behavior
# where the clone side-effect always ran. The feature is now gated on
# PEPTIDE_SENAITE_CLONE_ENABLED (default false); enable it here so existing
# assertions still exercise that code path. A dedicated test below covers the
# disabled-flag branch explicitly.
os.environ.setdefault("PEPTIDE_SENAITE_CLONE_ENABLED", "true")
os.environ.setdefault("PEPTIDE_COUPON_ENABLED", "true")

from backend.mk1_db import ensure_peptide_requests_table, get_mk1_conn
from backend.models_peptide_request import PeptideRequestCreate
from backend.peptide_request_repo import PeptideRequestRepository
from backend.jobs.completion_side_effects import (
    run_all,
    run_coupon,
    run_senaite_clone,
    _new_senaite_keyword,
)

# Idempotent DDL — matches the repo-test pattern elsewhere in the suite.
ensure_peptide_requests_table()


def _mock_response(body: dict) -> MagicMock:
    """Build a MagicMock that mimics a successful requests.Response."""
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = body
    resp.raise_for_status.return_value = None
    return resp


def _fetch_row(request_id) -> dict:
    with get_mk1_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute(
            "SELECT * FROM peptide_requests WHERE id = %s",
            (str(request_id),),
        )
        return dict(cur.fetchone())


def _make_request(wp_user_id: int, compound_kind: str = "peptide", compound_name: str = "CJC-1295"):
    repo = PeptideRequestRepository()
    return repo.create(
        PeptideRequestCreate(
            compound_kind=compound_kind,
            compound_name=compound_name,
            vendor_producer="TestVendor",
            submitted_by_wp_user_id=wp_user_id,
            submitted_by_email=f"user{wp_user_id}@test.c",
            submitted_by_name=f"User{wp_user_id}",
        ),
        idempotency_key=str(uuid.uuid4()),
        clickup_list_id="list_side_effects_test",
    )


def test_new_senaite_keyword_basic():
    assert _new_senaite_keyword("CJC-1295") == "CJC1-ID"
    assert _new_senaite_keyword("BPC-157") == "BPC1-ID"
    assert _new_senaite_keyword("tesamorelin") == "TESA-ID"
    assert _new_senaite_keyword("---") == "NEW-ID"


@patch("backend.integration_service_client.requests.post")
def test_peptide_runs_both_coupon_and_senaite(mock_post):
    req = _make_request(401, compound_kind="peptide", compound_name="Sermorelin")
    mock_post.side_effect = [
        _mock_response({"coupon_code": "SAVE250-A1"}),
        _mock_response({"service_uid": "svc_peptide_a1"}),
    ]

    run_all(req.id)

    row = _fetch_row(req.id)
    assert row["wp_coupon_code"] == "SAVE250-A1"
    assert row["wp_coupon_issued_at"] is not None
    assert row["senaite_service_uid"] == "svc_peptide_a1"
    assert row["coupon_failed_at"] is None
    assert row["senaite_clone_failed_at"] is None
    # Verify the SENAITE payload carried the correct name + keyword
    senaite_call = mock_post.call_args_list[1]
    body = senaite_call.kwargs["json"]
    assert body["new_name"] == "Sermorelin - Identity (HPLC)"
    assert body["new_keyword"] == "SERM-ID"
    assert body["template_keyword"] == "BPC157-ID"


@patch("backend.integration_service_client.requests.post")
def test_non_peptide_only_runs_coupon(mock_post):
    req = _make_request(402, compound_kind="other", compound_name="Creatine")
    # Only coupon should be called — SENAITE is skipped for non-peptide.
    mock_post.return_value = _mock_response({"coupon_code": "SAVE250-B2"})

    run_all(req.id)

    row = _fetch_row(req.id)
    assert row["wp_coupon_code"] == "SAVE250-B2"
    assert row["senaite_service_uid"] is None
    assert row["senaite_clone_failed_at"] is None
    # Exactly one POST — only to the coupon endpoint.
    assert mock_post.call_count == 1
    assert "/coupons/single-use" in mock_post.call_args.args[0]


@patch("backend.integration_service_client.requests.post")
def test_coupon_idempotent_when_already_set(mock_post):
    req = _make_request(403)
    # Pre-populate wp_coupon_code to simulate an already-issued coupon.
    with get_mk1_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "UPDATE peptide_requests SET wp_coupon_code = %s WHERE id = %s",
            ("EXISTING", str(req.id)),
        )
        conn.commit()

    run_coupon(req.id)

    assert mock_post.called is False
    row = _fetch_row(req.id)
    assert row["wp_coupon_code"] == "EXISTING"


@patch("backend.integration_service_client.requests.post")
def test_senaite_idempotent_when_already_set(mock_post):
    req = _make_request(404)
    with get_mk1_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "UPDATE peptide_requests SET senaite_service_uid = %s WHERE id = %s",
            ("uid_old", str(req.id)),
        )
        conn.commit()

    run_senaite_clone(req.id)

    assert mock_post.called is False
    row = _fetch_row(req.id)
    assert row["senaite_service_uid"] == "uid_old"


@patch("backend.integration_service_client.requests.post")
def test_coupon_failure_sets_coupon_failed_at(mock_post):
    req = _make_request(405, compound_kind="other", compound_name="Ashwagandha")
    mock_post.side_effect = Exception("boom — integration-service unreachable")

    run_all(req.id)

    row = _fetch_row(req.id)
    assert row["wp_coupon_code"] is None
    assert row["coupon_failed_at"] is not None
    # Non-peptide skips SENAITE entirely — no failed_at on that side either.
    assert row["senaite_clone_failed_at"] is None


@patch("backend.integration_service_client.requests.post")
def test_senaite_failure_sets_senaite_clone_failed_at(mock_post):
    req = _make_request(406, compound_kind="peptide", compound_name="Ipamorelin")
    # First call (coupon) succeeds; second call (SENAITE) raises.
    mock_post.side_effect = [
        _mock_response({"coupon_code": "SAVE250-C3"}),
        Exception("SENAITE clone 500"),
    ]

    run_all(req.id)

    row = _fetch_row(req.id)
    assert row["wp_coupon_code"] == "SAVE250-C3"
    assert row["coupon_failed_at"] is None
    assert row["senaite_service_uid"] is None
    assert row["senaite_clone_failed_at"] is not None


@patch("backend.integration_service_client.requests.post")
def test_senaite_failure_does_not_prevent_coupon(mock_post):
    """Explicit isolation check: a SENAITE exception must NOT roll back the
    coupon side of the pipeline. Same setup as the previous test, but we assert
    the independence property directly.
    """
    req = _make_request(407, compound_kind="peptide", compound_name="GHK-Cu")
    mock_post.side_effect = [
        _mock_response({"coupon_code": "SAVE250-D4"}),
        Exception("SENAITE boom"),
    ]

    run_all(req.id)

    row = _fetch_row(req.id)
    # Coupon succeeded despite the SENAITE failure.
    assert row["wp_coupon_code"] == "SAVE250-D4"
    assert row["wp_coupon_issued_at"] is not None
    # SENAITE was attempted and failed.
    assert row["senaite_clone_failed_at"] is not None
    assert row["senaite_service_uid"] is None
    # Both endpoints were called — coupon first, then SENAITE.
    assert mock_post.call_count == 2
    assert "/coupons/single-use" in mock_post.call_args_list[0].args[0]
    assert "/senaite/services/clone" in mock_post.call_args_list[1].args[0]


@patch("backend.integration_service_client.requests.post")
def test_senaite_clone_skipped_when_flag_disabled(mock_post, monkeypatch):
    """With PEPTIDE_SENAITE_CLONE_ENABLED unset/false, a peptide completion
    runs the coupon side-effect but skips the SENAITE clone entirely —
    no HTTP call, no senaite_service_uid, no senaite_clone_failed_at.
    """
    # Flip the flag off for just this test. The module-level setdefault at
    # import time set it to "true"; monkeypatch overrides and restores.
    monkeypatch.setenv("PEPTIDE_SENAITE_CLONE_ENABLED", "false")
    req = _make_request(408, compound_kind="peptide", compound_name="BPC-157")
    mock_post.return_value = _mock_response({"coupon_code": "SAVE250-E5"})

    run_all(req.id)

    row = _fetch_row(req.id)
    assert row["wp_coupon_code"] == "SAVE250-E5"
    assert row["senaite_service_uid"] is None
    assert row["senaite_clone_failed_at"] is None
    # Only one POST — the coupon. SENAITE clone short-circuited before any
    # network call.
    assert mock_post.call_count == 1
    assert "/coupons/single-use" in mock_post.call_args.args[0]


@patch("backend.integration_service_client.requests.post")
def test_coupon_skipped_when_flag_disabled(mock_post, monkeypatch):
    """With PEPTIDE_COUPON_ENABLED unset/false, a peptide completion skips
    the coupon side-effect entirely — no HTTP call, no wp_coupon_code,
    no coupon_failed_at. The SENAITE clone still runs if its own flag is on.
    """
    monkeypatch.setenv("PEPTIDE_COUPON_ENABLED", "false")
    req = _make_request(409, compound_kind="peptide", compound_name="Tirzepatide")
    mock_post.return_value = _mock_response({
        "service_uid": "uid_tirz", "title": "Tirzepatide - Identity (HPLC)",
        "keyword": "TIRZ-ID",
    })

    run_all(req.id)

    row = _fetch_row(req.id)
    assert row["wp_coupon_code"] is None
    assert row["coupon_failed_at"] is None
    assert row["senaite_service_uid"] == "uid_tirz"
    # Only one POST — the SENAITE clone. Coupon short-circuited before any
    # network call.
    assert mock_post.call_count == 1
    assert "/senaite/services/clone" in mock_post.call_args.args[0]


@patch("backend.integration_service_client.requests.post")
def test_both_side_effects_skipped_when_both_flags_disabled(mock_post, monkeypatch):
    """With both flags unset/false, a peptide completion is a DB-only no-op —
    no HTTP calls, no markers on either column.
    """
    monkeypatch.setenv("PEPTIDE_COUPON_ENABLED", "false")
    monkeypatch.setenv("PEPTIDE_SENAITE_CLONE_ENABLED", "false")
    req = _make_request(410, compound_kind="peptide", compound_name="Retatrutide")

    run_all(req.id)

    row = _fetch_row(req.id)
    assert row["wp_coupon_code"] is None
    assert row["coupon_failed_at"] is None
    assert row["senaite_service_uid"] is None
    assert row["senaite_clone_failed_at"] is None
    assert mock_post.called is False
