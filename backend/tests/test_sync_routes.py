"""Route-level tests for /lims/peptide-requests/sync/*.

Focus: auth gating + happy-path smoke. The underlying compute_diff /
apply_actions logic is covered in test_peptide_request_sync.py; these
tests just verify the FastAPI wiring (dependency injection, status
codes, JSON envelope, body validation).

ClickUpClient is patched at the main.py module scope so the route
constructs a MagicMock instead of hitting the real ClickUp API.
"""
from unittest.mock import MagicMock, patch
from uuid import uuid4

from fastapi.testclient import TestClient

import main as main_module
from auth import get_current_user
from main import app


client = TestClient(app)


def _override_auth():
    app.dependency_overrides[get_current_user] = lambda: MagicMock(
        id=1, email="lab@x"
    )


def _clear_auth_override():
    app.dependency_overrides.pop(get_current_user, None)


def test_sync_diff_requires_auth():
    """Without the auth override, no Authorization header -> 401. This
    is the contract we care about — the endpoint is not public."""
    _clear_auth_override()
    resp = client.get("/lims/peptide-requests/sync/diff")
    assert resp.status_code == 401


def test_sync_apply_requires_auth():
    _clear_auth_override()
    resp = client.post(
        "/lims/peptide-requests/sync/apply",
        json={
            "materialize_task_ids": [],
            "retire_row_ids": [],
            "fix_status_pairs": [],
        },
    )
    assert resp.status_code == 401


def test_sync_diff_returns_three_buckets():
    """Auth present + service layer mocked -> returns the dict shape
    with all three keys, passed through unchanged."""
    _override_auth()
    try:
        fake_diff = {
            "in_clickup_not_mk1": [{"task_id": "t1", "name": "A"}],
            "in_mk1_not_clickup": [{"row_id": "r1", "compound_name": "B"}],
            "status_mismatch": [{"row_id": "r2", "mk1_status": "new"}],
        }
        with patch.object(main_module, "ClickUpClient"), patch.object(
            main_module, "peptide_request_compute_sync_diff", return_value=fake_diff
        ):
            resp = client.get("/lims/peptide-requests/sync/diff")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert set(body.keys()) == {
                "in_clickup_not_mk1",
                "in_mk1_not_clickup",
                "status_mismatch",
            }
            assert body == fake_diff
    finally:
        _clear_auth_override()


def test_sync_apply_accepts_body_and_returns_counts():
    _override_auth()
    try:
        fake_result = {
            "materialized": 1,
            "retired": 0,
            "fixed_status": 0,
            "errors": [],
        }
        with patch.object(main_module, "ClickUpClient"), patch.object(
            main_module,
            "peptide_request_apply_sync_actions",
            return_value=fake_result,
        ) as mock_apply:
            row_id = str(uuid4())
            resp = client.post(
                "/lims/peptide-requests/sync/apply",
                json={
                    "materialize_task_ids": ["tsk_apply_1"],
                    "retire_row_ids": [row_id],
                    "fix_status_pairs": [
                        {"row_id": row_id, "target_status": "in_process"},
                    ],
                },
            )
            assert resp.status_code == 200, resp.text
            assert resp.json() == fake_result

            # The route forwards the parsed body to the service layer.
            # Pydantic will have parsed UUIDs into UUID objects — confirm
            # the service received the three keys.
            assert mock_apply.call_count == 1
            passed = mock_apply.call_args.args[0]
            assert "materialize_task_ids" in passed
            assert "retire_row_ids" in passed
            assert "fix_status_pairs" in passed
            assert passed["materialize_task_ids"] == ["tsk_apply_1"]
    finally:
        _clear_auth_override()
