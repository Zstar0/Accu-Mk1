from unittest.mock import patch, MagicMock
from clickup_client import ClickUpClient
from models_peptide_request import PeptideRequest
from uuid import uuid4
from datetime import datetime


def make_request() -> PeptideRequest:
    return PeptideRequest(
        id=uuid4(), created_at=datetime.now(), updated_at=datetime.now(),
        submitted_by_wp_user_id=42, submitted_by_email="a@b.c",
        submitted_by_name="Jane", compound_kind="peptide",
        compound_name="Retatrutide", vendor_producer="PepMart",
        sequence_or_structure=None, molecular_weight=None,
        cas_or_reference=None, vendor_catalog_number=None,
        reason_notes=None, expected_monthly_volume=None,
        status="new", previous_status=None, rejection_reason=None,
        sample_id=None, clickup_task_id=None, clickup_list_id="list_123",
        clickup_assignee_ids=[], senaite_service_uid=None,
        wp_coupon_code=None, wp_coupon_issued_at=None,
        completed_at=None, rejected_at=None, cancelled_at=None,
    )


@patch("clickup_client.requests.post")
def test_create_task_posts_to_list(mock_post):
    mock_post.return_value = MagicMock(status_code=200, json=lambda: {"id": "tsk_1", "url": "x"})
    client = ClickUpClient(api_token="t", list_id="L1", accumk1_base_url="https://accumk1")
    req = make_request()
    task_id = client.create_task_for_request(req)
    assert task_id == "tsk_1"
    args, kwargs = mock_post.call_args
    assert "L1/task" in args[0]
    body = kwargs["json"]
    assert body["name"].startswith("[peptide]")
    assert "Retatrutide" in body["name"]
    assert "PepMart" in body["name"]
    assert body["status"] == "New"
    assert body["assignees"] == []
    assert "accumk1" in body["description"]  # deep link


@patch("clickup_client.requests.post")
def test_create_task_raises_on_error(mock_post):
    mock_post.return_value = MagicMock(status_code=500, text="err")
    client = ClickUpClient(api_token="t", list_id="L1", accumk1_base_url="https://accumk1")
    import pytest
    with pytest.raises(Exception):
        client.create_task_for_request(make_request())
