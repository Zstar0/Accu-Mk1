"""Integration tests for the ClickUp webhook dispatcher.

Exercises the full path: POST /webhooks/clickup -> signature verify ->
dispatch_event -> repo writes. Uses the live accumark_mk1 test DB (tables
are ensured by the repo tests' conftest pattern, replicated here).
"""
import hashlib
import hmac
import json
import os
import uuid

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

# DDL is idempotent — ensure all three tables exist for the webhook dispatch
# path (peptide_requests row, status log writes, and user mapping upserts).
ensure_peptide_requests_table()
ensure_peptide_request_status_log_table()
ensure_clickup_user_mapping_table()


client = TestClient(app)


def sign(body: bytes, secret: str) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def _post(payload: dict):
    body = json.dumps(payload).encode()
    secret = os.environ["CLICKUP_WEBHOOK_SECRET"]
    sig = sign(body, secret)
    return client.post(
        "/webhooks/clickup",
        content=body,
        headers={"X-Signature": sig, "Content-Type": "application/json"},
    )


def _make_request(wp_user_id: int, task_id: str):
    """Create a peptide_requests row and back-fill its clickup_task_id."""
    repo = PeptideRequestRepository()
    req = repo.create(
        PeptideRequestCreate(
            compound_kind="peptide",
            compound_name="WebhookDispatchFixture",
            vendor_producer="PepMart",
            submitted_by_wp_user_id=wp_user_id,
            submitted_by_email="fixture@example.com",
            submitted_by_name="Fixture User",
        ),
        idempotency_key=str(uuid.uuid4()),
        clickup_list_id="list_abc",
    )
    repo.update_clickup_task_id(req.id, task_id)
    return repo.get_by_id(req.id)


def test_task_status_updated_with_mapped_column():
    task_id = f"cu_task_{uuid.uuid4().hex[:10]}"
    req = _make_request(wp_user_id=201, task_id=task_id)
    event_id = f"evt_{uuid.uuid4().hex[:10]}"

    resp = _post({
        "event": "taskStatusUpdated",
        "task_id": task_id,
        "history_items": [{
            "id": event_id,
            "after": {"status": "Approved"},
            "user": {"id": "cu_u_42", "username": "alice", "email": "alice@example.com"},
            "comment": None,
        }],
    })
    assert resp.status_code == 200

    # Request row flipped to approved, history row exists.
    repo = PeptideRequestRepository()
    after = repo.get_by_id(req.id)
    assert after.status == "approved"
    history = StatusLogRepository().get_for_request(req.id)
    assert any(h.to_status == "approved" and h.clickup_event_id == event_id for h in history)


def test_task_status_updated_with_unmapped_column():
    task_id = f"cu_task_{uuid.uuid4().hex[:10]}"
    req = _make_request(wp_user_id=202, task_id=task_id)

    resp = _post({
        "event": "taskStatusUpdated",
        "task_id": task_id,
        "history_items": [{
            "id": f"evt_{uuid.uuid4().hex[:10]}",
            "after": {"status": "Weird Custom Column"},
            "user": {"id": "cu_u_43", "username": "bob", "email": "bob@example.com"},
        }],
    })
    assert resp.status_code == 200

    repo = PeptideRequestRepository()
    after = repo.get_by_id(req.id)
    # Status unchanged — unmapped column must not mutate state.
    assert after.status == req.status
    history = StatusLogRepository().get_for_request(req.id)
    # No log row appended for this request.
    assert history == []


def test_duplicate_event_id_dedups():
    task_id = f"cu_task_{uuid.uuid4().hex[:10]}"
    req = _make_request(wp_user_id=203, task_id=task_id)
    event_id = f"evt_{uuid.uuid4().hex[:10]}"
    payload = {
        "event": "taskStatusUpdated",
        "task_id": task_id,
        "history_items": [{
            "id": event_id,
            "after": {"status": "Approved"},
            "user": {"id": "cu_u_44", "username": "carol", "email": "carol@example.com"},
        }],
    }

    r1 = _post(payload)
    r2 = _post(payload)
    assert r1.status_code == 200
    assert r2.status_code == 200

    history = StatusLogRepository().get_for_request(req.id)
    matching = [h for h in history if h.clickup_event_id == event_id]
    assert len(matching) == 1


def test_task_assignee_updated():
    task_id = f"cu_task_{uuid.uuid4().hex[:10]}"
    req = _make_request(wp_user_id=204, task_id=task_id)

    resp = _post({
        "event": "taskAssigneeUpdated",
        "task_id": task_id,
        "assignees": [{"id": "u1"}, {"id": "u2"}],
    })
    assert resp.status_code == 200

    after = PeptideRequestRepository().get_by_id(req.id)
    assert sorted(after.clickup_assignee_ids) == ["u1", "u2"]


def test_unknown_event_returns_200_no_action():
    task_id = f"cu_task_{uuid.uuid4().hex[:10]}"
    req = _make_request(wp_user_id=205, task_id=task_id)

    resp = _post({
        "event": "somethingElse",
        "task_id": task_id,
    })
    assert resp.status_code == 200

    after = PeptideRequestRepository().get_by_id(req.id)
    assert after.status == req.status
    assert after.clickup_assignee_ids == req.clickup_assignee_ids
    history = StatusLogRepository().get_for_request(req.id)
    assert history == []
