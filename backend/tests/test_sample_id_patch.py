"""Tests for PATCH /lims/peptide-requests/{id} — sample_id editing.

These tests stub the PeptideRequestRepository and ClickUpClient at the
module level (main.py) so we exercise the route logic without touching
the database or the ClickUp API. Auth is bypassed with a dependency
override because the route is guarded by get_current_user (JWT).
"""
from datetime import datetime
from unittest.mock import MagicMock, patch
from uuid import uuid4

from fastapi.testclient import TestClient

import main as main_module
from auth import get_current_user
from main import app
from models_peptide_request import PeptideRequest


client = TestClient(app)


def _make_row(**overrides) -> PeptideRequest:
    base = dict(
        id=uuid4(),
        created_at=datetime.now(),
        updated_at=datetime.now(),
        source="wp",
        submitted_by_wp_user_id=42,
        submitted_by_email="a@b.c",
        submitted_by_name="Jane",
        compound_kind="peptide",
        compound_name="Retatrutide",
        vendor_producer="PepMart",
        sequence_or_structure=None,
        molecular_weight=None,
        cas_or_reference=None,
        vendor_catalog_number=None,
        reason_notes=None,
        expected_monthly_volume=None,
        status="new",
        previous_status=None,
        rejection_reason=None,
        sample_id=None,
        clickup_task_id="tsk_abc",
        clickup_list_id="L1",
        clickup_assignee_ids=[],
        senaite_service_uid=None,
        wp_coupon_code=None,
        wp_coupon_issued_at=None,
        completed_at=None,
        rejected_at=None,
        cancelled_at=None,
        retired_at=None,
    )
    base.update(overrides)
    return PeptideRequest(**base)


def _override_auth():
    """Bypass JWT — pretend the caller is a valid authenticated user."""
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1, email="lab@x")


def _clear_auth_override():
    app.dependency_overrides.pop(get_current_user, None)


def test_patch_unauthenticated_returns_401():
    """Without the auth override, no Authorization header → 401."""
    _clear_auth_override()
    resp = client.patch(
        f"/lims/peptide-requests/{uuid4()}",
        json={"sample_id": "SMP-1"},
    )
    assert resp.status_code == 401


def test_patch_updates_db_and_pushes_to_clickup():
    _override_auth()
    try:
        row_id = uuid4()
        original = _make_row(id=row_id, sample_id=None, clickup_task_id="tsk_123")
        updated = _make_row(id=row_id, sample_id="SMP-42", clickup_task_id="tsk_123")

        with patch.object(main_module, "PeptideRequestRepository") as MockRepo, \
             patch.object(main_module, "ClickUpClient") as MockClient, \
             patch.object(main_module, "get_peptide_request_config") as MockCfg:
            repo_inst = MockRepo.return_value
            repo_inst.get_by_id.return_value = original
            repo_inst.update_sample_id.return_value = updated
            client_inst = MockClient.return_value
            MockCfg.return_value = MagicMock(
                clickup_api_token="t", clickup_list_id="L1",
                clickup_field_sample_id="cfs-id",
            )

            resp = client.patch(
                f"/lims/peptide-requests/{row_id}",
                json={"sample_id": "SMP-42"},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["sample_id"] == "SMP-42"
            assert "warning" not in body

            repo_inst.update_sample_id.assert_called_once()
            args = repo_inst.update_sample_id.call_args.args
            assert args[1] == "SMP-42"
            client_inst.set_custom_field.assert_called_once_with(
                "tsk_123", "cfs-id", "SMP-42",
            )
    finally:
        _clear_auth_override()


def test_patch_with_null_clears_db_and_pushes_empty_string():
    _override_auth()
    try:
        row_id = uuid4()
        original = _make_row(id=row_id, sample_id="SMP-old", clickup_task_id="tsk_1")
        updated = _make_row(id=row_id, sample_id=None, clickup_task_id="tsk_1")

        with patch.object(main_module, "PeptideRequestRepository") as MockRepo, \
             patch.object(main_module, "ClickUpClient") as MockClient, \
             patch.object(main_module, "get_peptide_request_config") as MockCfg:
            repo_inst = MockRepo.return_value
            repo_inst.get_by_id.return_value = original
            repo_inst.update_sample_id.return_value = updated
            client_inst = MockClient.return_value
            MockCfg.return_value = MagicMock(
                clickup_api_token="t", clickup_list_id="L1",
                clickup_field_sample_id="cfs-id",
            )

            resp = client.patch(
                f"/lims/peptide-requests/{row_id}",
                json={"sample_id": None},
            )
            assert resp.status_code == 200, resp.text
            args = repo_inst.update_sample_id.call_args.args
            assert args[1] is None
            # Empty string pushed to ClickUp — clears the field display.
            client_inst.set_custom_field.assert_called_once_with(
                "tsk_1", "cfs-id", "",
            )
    finally:
        _clear_auth_override()


def test_patch_without_clickup_task_id_skips_push():
    _override_auth()
    try:
        row_id = uuid4()
        original = _make_row(id=row_id, clickup_task_id=None)
        updated = _make_row(id=row_id, sample_id="SMP-7", clickup_task_id=None)

        with patch.object(main_module, "PeptideRequestRepository") as MockRepo, \
             patch.object(main_module, "ClickUpClient") as MockClient:
            repo_inst = MockRepo.return_value
            repo_inst.get_by_id.return_value = original
            repo_inst.update_sample_id.return_value = updated

            resp = client.patch(
                f"/lims/peptide-requests/{row_id}",
                json={"sample_id": "SMP-7"},
            )
            assert resp.status_code == 200, resp.text
            # ClickUpClient never constructed because there's no task to sync.
            MockClient.assert_not_called()
    finally:
        _clear_auth_override()


def test_patch_skips_push_when_field_id_unset():
    _override_auth()
    try:
        row_id = uuid4()
        original = _make_row(id=row_id, clickup_task_id="tsk_z")
        updated = _make_row(id=row_id, sample_id="X", clickup_task_id="tsk_z")

        with patch.object(main_module, "PeptideRequestRepository") as MockRepo, \
             patch.object(main_module, "ClickUpClient") as MockClient, \
             patch.object(main_module, "get_peptide_request_config") as MockCfg:
            repo_inst = MockRepo.return_value
            repo_inst.get_by_id.return_value = original
            repo_inst.update_sample_id.return_value = updated
            MockCfg.return_value = MagicMock(
                clickup_api_token="t", clickup_list_id="L1",
                clickup_field_sample_id="",  # unset
            )

            resp = client.patch(
                f"/lims/peptide-requests/{row_id}",
                json={"sample_id": "X"},
            )
            assert resp.status_code == 200
            MockClient.assert_not_called()
    finally:
        _clear_auth_override()


def test_patch_returns_warning_when_clickup_sync_fails():
    _override_auth()
    try:
        row_id = uuid4()
        original = _make_row(id=row_id, clickup_task_id="tsk_fail")
        updated = _make_row(id=row_id, sample_id="SMP-9", clickup_task_id="tsk_fail")

        with patch.object(main_module, "PeptideRequestRepository") as MockRepo, \
             patch.object(main_module, "ClickUpClient") as MockClient, \
             patch.object(main_module, "get_peptide_request_config") as MockCfg:
            repo_inst = MockRepo.return_value
            repo_inst.get_by_id.return_value = original
            repo_inst.update_sample_id.return_value = updated
            client_inst = MockClient.return_value
            client_inst.set_custom_field.side_effect = RuntimeError("upstream 500")
            MockCfg.return_value = MagicMock(
                clickup_api_token="t", clickup_list_id="L1",
                clickup_field_sample_id="cfs-id",
            )

            resp = client.patch(
                f"/lims/peptide-requests/{row_id}",
                json={"sample_id": "SMP-9"},
            )
            # DB update still succeeded; ClickUp failure surfaces as warning.
            assert resp.status_code == 200
            body = resp.json()
            assert body["sample_id"] == "SMP-9"
            assert body.get("warning", "").startswith("ClickUp sync failed")
    finally:
        _clear_auth_override()


def test_patch_returns_404_when_row_missing():
    _override_auth()
    try:
        with patch.object(main_module, "PeptideRequestRepository") as MockRepo:
            repo_inst = MockRepo.return_value
            repo_inst.get_by_id.return_value = None

            resp = client.patch(
                f"/lims/peptide-requests/{uuid4()}",
                json={"sample_id": "SMP-nope"},
            )
            assert resp.status_code == 404
    finally:
        _clear_auth_override()
