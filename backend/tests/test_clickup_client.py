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
    # No `status` in the create payload — ClickUp uses the list's initial
    # column. Keeps client decoupled from lab column naming.
    assert "status" not in body
    assert body["assignees"] == []
    assert "accumk1" in body["description"]  # deep link


@patch("clickup_client.requests.post")
def test_create_task_raises_on_error(mock_post):
    mock_post.return_value = MagicMock(status_code=500, text="err")
    client = ClickUpClient(api_token="t", list_id="L1", accumk1_base_url="https://accumk1")
    import pytest
    with pytest.raises(Exception):
        client.create_task_for_request(make_request())


# ── Custom field population ──────────────────────────────────────────

def _make_config(**overrides):
    """Build a PeptideRequestConfig with custom-field ids set. Avoids the
    get_config() env-var requirement for tests."""
    from peptide_request_config import PeptideRequestConfig
    defaults = dict(
        clickup_list_id="L1",
        clickup_api_token="t",
        clickup_webhook_secret="s",
        clickup_field_compound_kind="cfk-id",
        clickup_field_customer_email="cfe-id",
        clickup_field_vendor_producer="cfv-id",
        clickup_field_cas="cfc-id",
        clickup_field_accumk1_link="cfl-id",
        clickup_field_sample_id="cfs-id",
        clickup_opt_compound_kind_peptide="opt-peptide",
        clickup_opt_compound_kind_other="opt-other",
    )
    defaults.update(overrides)
    return PeptideRequestConfig(**defaults)


@patch("clickup_client.requests.post")
def test_create_task_populates_custom_fields_when_config_set(mock_post):
    """Verifies the task-create body includes a custom_fields array with
    the right IDs + option id for the dropdown when config provides them."""
    mock_post.return_value = MagicMock(
        status_code=200, json=lambda: {"id": "tsk_cf", "url": "x"}
    )
    cfg = _make_config()
    client = ClickUpClient(
        api_token="t", list_id="L1",
        accumk1_base_url="https://accumk1", config=cfg,
    )
    req = make_request()
    # Give it a CAS value to exercise that branch
    req.cas_or_reference = "12345-67-8"
    task_id = client.create_task_for_request(req)
    assert task_id == "tsk_cf"
    body = mock_post.call_args.kwargs["json"]
    assert "custom_fields" in body
    fields = {f["id"]: f["value"] for f in body["custom_fields"]}
    # Compound Kind: dropdown value is the OPTION id, not the string
    assert fields["cfk-id"] == "opt-peptide"
    assert fields["cfe-id"] == "a@b.c"
    assert fields["cfv-id"] == "PepMart"
    assert fields["cfc-id"] == "12345-67-8"
    # Accumk1 link is the full URL
    assert fields["cfl-id"].startswith("https://accumk1/requests/")


@patch("clickup_client.requests.post")
def test_create_task_omits_custom_fields_when_config_empty(mock_post):
    """When no custom-field IDs are configured, body must NOT contain a
    custom_fields key. Graceful degrade — task-create still succeeds."""
    from peptide_request_config import PeptideRequestConfig
    mock_post.return_value = MagicMock(
        status_code=200, json=lambda: {"id": "tsk_cf2"}
    )
    cfg = PeptideRequestConfig(
        clickup_list_id="L1", clickup_api_token="t", clickup_webhook_secret="s",
    )
    client = ClickUpClient(
        api_token="t", list_id="L1",
        accumk1_base_url="https://accumk1", config=cfg,
    )
    client.create_task_for_request(make_request())
    body = mock_post.call_args.kwargs["json"]
    assert "custom_fields" not in body


@patch("clickup_client.requests.post")
def test_create_task_skips_missing_data_fields(mock_post):
    """Fields with a configured ID but no source data (e.g. missing CAS)
    must be omitted from the custom_fields array — don't push empty strings."""
    mock_post.return_value = MagicMock(
        status_code=200, json=lambda: {"id": "tsk_cf3"}
    )
    cfg = _make_config()
    client = ClickUpClient(
        api_token="t", list_id="L1",
        accumk1_base_url="https://accumk1", config=cfg,
    )
    req = make_request()
    req.cas_or_reference = None
    client.create_task_for_request(req)
    body = mock_post.call_args.kwargs["json"]
    field_ids = {f["id"] for f in body["custom_fields"]}
    assert "cfc-id" not in field_ids  # CAS skipped
    assert "cfe-id" in field_ids      # email still present


@patch("clickup_client.requests.post")
def test_set_custom_field_posts_correct_url_and_body(mock_post):
    mock_post.return_value = MagicMock(status_code=200, json=lambda: {})
    client = ClickUpClient(
        api_token="t", list_id="L1", accumk1_base_url="https://accumk1",
    )
    client.set_custom_field("tsk_xyz", "cfs-id", "SMP-123")
    args, kwargs = mock_post.call_args
    assert "/task/tsk_xyz/field/cfs-id" in args[0]
    assert kwargs["json"] == {"value": "SMP-123"}


@patch("clickup_client.requests.post")
def test_set_custom_field_raises_on_error(mock_post):
    mock_post.return_value = MagicMock(status_code=400, text="bad field")
    client = ClickUpClient(
        api_token="t", list_id="L1", accumk1_base_url="https://accumk1",
    )
    import pytest
    with pytest.raises(Exception):
        client.set_custom_field("tsk_xyz", "cfs-id", "X")


# ── post_task_comment ────────────────────────────────────────────────

def _make_client():
    return ClickUpClient(
        api_token="t",
        list_id="L",
        accumk1_base_url="https://accumk1.example",
    )


def test_post_task_comment_sends_expected_body():
    client = _make_client()
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    with patch("clickup_client.requests.post", return_value=mock_resp) as m:
        client.post_task_comment("TASK123", "hello world")
    args, kwargs = m.call_args
    assert args[0] == "https://api.clickup.com/api/v2/task/TASK123/comment"
    assert kwargs["json"] == {"comment_text": "hello world", "notify_all": False}
    assert kwargs["timeout"] == 2


def test_post_task_comment_raises_on_non_2xx():
    client = _make_client()
    mock_resp = MagicMock()
    mock_resp.status_code = 500
    mock_resp.text = "boom"
    with patch("clickup_client.requests.post", return_value=mock_resp):
        import pytest
        with pytest.raises(RuntimeError, match="ClickUp post_task_comment failed"):
            client.post_task_comment("TASK123", "hi")


# ── set_task_status ──────────────────────────────────────────────────

def test_set_task_status_sends_put_with_status_body():
    client = _make_client()
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    with patch("clickup_client.requests.put", return_value=mock_resp) as m:
        client.set_task_status("TASK123", "retracted")
    args, kwargs = m.call_args
    assert args[0] == "https://api.clickup.com/api/v2/task/TASK123"
    assert kwargs["json"] == {"status": "retracted"}
    assert kwargs["timeout"] == 2


def test_set_task_status_raises_on_non_2xx():
    client = _make_client()
    mock_resp = MagicMock()
    mock_resp.status_code = 404
    mock_resp.text = "task not found"
    with patch("clickup_client.requests.put", return_value=mock_resp):
        import pytest
        with pytest.raises(RuntimeError, match="ClickUp set_task_status failed"):
            client.set_task_status("NOPE", "retracted")
