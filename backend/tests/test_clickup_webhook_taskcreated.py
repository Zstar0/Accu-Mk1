"""Integration tests for the taskCreated webhook branch.

Exercises the manual-task materialization path: a lab tech creates a
task directly in ClickUp, the taskCreated webhook fires, and we insert
a peptide_requests row with source='manual'.

Follows the pattern from test_clickup_webhook_dispatch.py — ensures all
three tables exist, signs the payload with the real secret, and posts
through the live FastAPI TestClient so the full verify->dispatch path
is covered.
"""
import hashlib
import hmac
import json
import os
import uuid
from unittest.mock import patch

from fastapi.testclient import TestClient

from main import app
from mk1_db import (
    ensure_clickup_user_mapping_table,
    ensure_peptide_request_status_log_table,
    ensure_peptide_requests_table,
)
from models_peptide_request import PeptideRequestCreate
from peptide_request_repo import PeptideRequestRepository
from status_log_repo import StatusLogRepository


ensure_peptide_requests_table()
ensure_peptide_request_status_log_table()
ensure_clickup_user_mapping_table()


client = TestClient(app)


def _sign(body: bytes, secret: str) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def _post(payload: dict):
    body = json.dumps(payload).encode()
    secret = os.environ["CLICKUP_WEBHOOK_SECRET"]
    sig = _sign(body, secret)
    return client.post(
        "/webhooks/clickup",
        content=body,
        headers={"X-Signature": sig, "Content-Type": "application/json"},
    )


def _fake_task(task_id: str, name: str, column: str = "requested") -> dict:
    return {
        "id": task_id,
        "name": name,
        "description": "",
        "status": {"status": column, "type": "open"},
        "creator": {
            "id": 99001,
            "username": "lab_tech_auto",
            "email": "tech@accumarklabs.com",
        },
    }


def test_task_created_inserts_manual_row():
    task_id = f"cu_manual_{uuid.uuid4().hex[:10]}"
    compound_name = f"MANUAL-{uuid.uuid4().hex[:6]}"
    fake_task = _fake_task(task_id, compound_name, column="requested")

    with patch(
        "clickup_webhook.ClickUpClient.get_task",
        return_value=fake_task,
    ):
        resp = _post({
            "event": "taskCreated",
            "task_id": task_id,
            "event_id": f"evt_{uuid.uuid4().hex[:10]}",
        })
    assert resp.status_code == 200

    repo = PeptideRequestRepository()
    row = repo.get_by_clickup_task_id(task_id)
    assert row is not None, "taskCreated did not materialize a row"
    assert row.source == "manual"
    assert row.compound_name == compound_name
    # "requested" maps to "new" per DEFAULT_COLUMN_MAP.
    assert row.status == "new"
    # Placeholder identity fields land as designed.
    assert row.submitted_by_wp_user_id == 0
    assert row.submitted_by_email == "manual@accumarklabs.com"
    assert row.submitted_by_name == "lab_tech_auto"
    assert row.vendor_producer == "Unknown"
    assert row.compound_kind == "other"

    # Audit log entry written with from_status=None.
    history = StatusLogRepository().get_for_request(row.id)
    assert len(history) >= 1
    entry = history[0]
    assert entry.from_status is None
    assert entry.to_status == "new"
    assert entry.source == "clickup"
    assert entry.note == "Manual task created in ClickUp"


def test_task_created_is_idempotent_on_existing_row():
    """If a row already exists for this clickup_task_id (e.g. our own
    create, or a webhook re-delivery), don't insert a duplicate and
    don't throw."""
    task_id = f"cu_existing_{uuid.uuid4().hex[:10]}"

    # Seed an existing row via the WP path and back-fill its task id.
    repo = PeptideRequestRepository()
    seed = repo.create(
        PeptideRequestCreate(
            compound_kind="peptide",
            compound_name="ExistingTaskFixture",
            vendor_producer="PepMart",
            submitted_by_wp_user_id=901,
            submitted_by_email="existing@example.com",
            submitted_by_name="Existing User",
        ),
        idempotency_key=str(uuid.uuid4()),
        clickup_list_id="list_abc",
    )
    repo.update_clickup_task_id(seed.id, task_id)

    # get_task MUST NOT be called because the idempotency gate fires first.
    with patch("clickup_webhook.ClickUpClient.get_task") as mock_get:
        resp = _post({
            "event": "taskCreated",
            "task_id": task_id,
            "event_id": f"evt_{uuid.uuid4().hex[:10]}",
        })
        assert resp.status_code == 200
        assert mock_get.call_count == 0

    # Still exactly one row, and it's still the WP-sourced seed.
    after = repo.get_by_clickup_task_id(task_id)
    assert after is not None
    assert after.id == seed.id
    assert after.source == "wp"  # unchanged


def test_task_created_skips_unmapped_column():
    task_id = f"cu_unmapped_{uuid.uuid4().hex[:10]}"
    compound_name = f"UNMAPPED-{uuid.uuid4().hex[:6]}"
    fake_task = _fake_task(task_id, compound_name, column="Some Weird Column")

    with patch(
        "clickup_webhook.ClickUpClient.get_task",
        return_value=fake_task,
    ):
        resp = _post({
            "event": "taskCreated",
            "task_id": task_id,
            "event_id": f"evt_{uuid.uuid4().hex[:10]}",
        })
    # Webhook still returns 200 — unmapped columns log+bail, not fail.
    assert resp.status_code == 200

    repo = PeptideRequestRepository()
    assert repo.get_by_clickup_task_id(task_id) is None
