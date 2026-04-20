"""Tests for backend/jobs/relay_status_to_wp.py.

Covers the payload shape and the send_email toggle logic. HTTP is mocked at
`backend.integration_service_client.requests.post` so no real network call
happens. Integration-service URL/token come from env vars set in the fixture.
"""
import os
import uuid

import pytest
from unittest.mock import patch, MagicMock

# Set required env vars BEFORE importing the client / job modules so
# IntegrationServiceClient.__init__ can find them at run_once() time.
os.environ.setdefault("INTEGRATION_SERVICE_URL", "http://fake-integration")
os.environ.setdefault("INTEGRATION_SERVICE_TOKEN", "fake-token")

from mk1_db import ensure_peptide_requests_table
from models_peptide_request import PeptideRequestCreate
from peptide_request_repo import PeptideRequestRepository
from jobs.relay_status_to_wp import run_once

# Idempotent DDL — matches the repo-test pattern elsewhere in the suite.
ensure_peptide_requests_table()


@pytest.fixture
def created_request():
    repo = PeptideRequestRepository()
    req = repo.create(
        PeptideRequestCreate(
            compound_kind="peptide",
            compound_name="CJC-1295",
            vendor_producer="TestVendor",
            submitted_by_wp_user_id=301,
            submitted_by_email="relay@test.c",
            submitted_by_name="RelayTest",
        ),
        idempotency_key=str(uuid.uuid4()),
        clickup_list_id="list_relay_test",
    )
    return req


@patch("integration_service_client.requests.post")
def test_relay_posts_to_integration_service(mock_post, created_request):
    mock_post.return_value = MagicMock(
        status_code=200,
        json=lambda: {"wp_accepted": True, "email_queued": True},
    )
    run_once(created_request.id, new_status="approved", previous_status="new")

    assert mock_post.called
    args, kwargs = mock_post.call_args
    # Endpoint path
    assert "/v1/internal/wp/peptide-request-status" in args[0]
    # Auth header
    assert kwargs["headers"]["X-Service-Token"] == "fake-token"
    # Payload shape
    body = kwargs["json"]
    assert body["peptide_request_id"] == str(created_request.id)
    assert body["wp_user_id"] == 301
    assert body["new_status"] == "approved"
    assert body["previous_status"] == "new"
    assert body["compound_name"] == "CJC-1295"
    assert body["send_email"] is True


@patch("integration_service_client.requests.post")
def test_relay_no_email_for_non_trigger_status(mock_post, created_request):
    mock_post.return_value = MagicMock(
        status_code=200,
        json=lambda: {"wp_accepted": True, "email_queued": False},
    )
    run_once(created_request.id, new_status="in_process", previous_status="approved")

    args, kwargs = mock_post.call_args
    body = kwargs["json"]
    assert body["new_status"] == "in_process"
    # in_process is NOT in EMAIL_TRIGGER_STATUSES
    assert body["send_email"] is False
