"""Integration tests for the taskDeleted webhook branch.

Exercises the retire-on-delete path: a lab tech deletes a ClickUp task,
the taskDeleted webhook fires, and we stamp retired_at on the
corresponding peptide_requests row WITHOUT deleting it. Purely additive;
no side effects toward WP or SENAITE.

Follows the pattern from test_clickup_webhook_taskcreated.py.
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


def _seed_request(task_id: str) -> "object":
    """Seed a WP-sourced peptide_requests row with a clickup_task_id."""
    repo = PeptideRequestRepository()
    seed = repo.create(
        PeptideRequestCreate(
            compound_kind="peptide",
            compound_name=f"RetireFixture-{uuid.uuid4().hex[:6]}",
            vendor_producer="PepMart",
            submitted_by_wp_user_id=902,
            submitted_by_email="retire-fixture@example.com",
            submitted_by_name="Retire Fixture User",
        ),
        idempotency_key=str(uuid.uuid4()),
        clickup_list_id="list_retire_test",
    )
    repo.update_clickup_task_id(seed.id, task_id)
    return seed


def test_task_deleted_sets_retired_at_and_logs():
    task_id = f"cu_del_{uuid.uuid4().hex[:10]}"
    seed = _seed_request(task_id)

    repo = PeptideRequestRepository()
    before = repo.get_by_clickup_task_id(task_id)
    assert before is not None
    assert before.retired_at is None

    resp = _post({
        "event": "taskDeleted",
        "task_id": task_id,
        "event_id": f"evt_{uuid.uuid4().hex[:10]}",
        "user": {"id": 12345, "username": "deleting_tech"},
    })
    assert resp.status_code == 200

    # Row still exists (no cascade delete), retired_at is populated.
    after = repo.get_by_clickup_task_id(task_id)
    assert after is not None, "row was deleted — should have been retired instead"
    assert after.id == seed.id
    assert after.retired_at is not None
    assert after.status == before.status  # status unchanged

    # Audit log has a retired entry.
    history = StatusLogRepository().get_for_request(seed.id)
    retire_entries = [h for h in history if h.note and "retired" in h.note.lower()]
    assert len(retire_entries) == 1
    entry = retire_entries[0]
    assert entry.source == "clickup"
    assert entry.actor_clickup_user_id == "12345"
    assert entry.from_status == entry.to_status  # no workflow transition


def test_task_deleted_is_idempotent():
    """ClickUp may re-deliver taskDeleted events. Second call must be a
    silent no-op: retired_at preserved at its original value, no new
    status_log row appended."""
    task_id = f"cu_del_idem_{uuid.uuid4().hex[:10]}"
    seed = _seed_request(task_id)

    # First delete
    resp1 = _post({
        "event": "taskDeleted",
        "task_id": task_id,
        "event_id": f"evt_{uuid.uuid4().hex[:10]}",
    })
    assert resp1.status_code == 200

    repo = PeptideRequestRepository()
    after_first = repo.get_by_clickup_task_id(task_id)
    assert after_first is not None
    assert after_first.retired_at is not None
    first_retired_at = after_first.retired_at

    history_before = StatusLogRepository().get_for_request(seed.id)
    retire_count_before = sum(
        1 for h in history_before if h.note and "retired" in h.note.lower()
    )
    assert retire_count_before == 1

    # Second delete — re-delivery
    resp2 = _post({
        "event": "taskDeleted",
        "task_id": task_id,
        "event_id": f"evt_{uuid.uuid4().hex[:10]}",  # different event id
    })
    assert resp2.status_code == 200

    after_second = repo.get_by_clickup_task_id(task_id)
    assert after_second is not None
    # retired_at unchanged (no second UPDATE).
    assert after_second.retired_at == first_retired_at

    history_after = StatusLogRepository().get_for_request(seed.id)
    retire_count_after = sum(
        1 for h in history_after if h.note and "retired" in h.note.lower()
    )
    assert retire_count_after == 1, "idempotent call appended a second retire log"


def test_task_deleted_unknown_task_is_silent_noop():
    """Unknown clickup_task_id (never tracked, or already cleaned up):
    200 OK, no exception, no row changes."""
    task_id = f"cu_del_unknown_{uuid.uuid4().hex[:10]}"

    resp = _post({
        "event": "taskDeleted",
        "task_id": task_id,
        "event_id": f"evt_{uuid.uuid4().hex[:10]}",
    })
    assert resp.status_code == 200

    repo = PeptideRequestRepository()
    assert repo.get_by_clickup_task_id(task_id) is None
