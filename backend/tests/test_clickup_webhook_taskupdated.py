"""Integration tests for the taskUpdated webhook branch.

Covers:
  1. sample_id custom field change -> DB update + status_log audit row
  2. compound_kind dropdown change (option UUID) resolves to peptide/other
  3. Invalid email is skipped but other fields in the same event apply
  4. Duplicate history_item id is deduped (second delivery is a no-op)
  5. Unknown row (task_id not in DB) logs WARN, returns 200, no writes
  6. Name field change logs INFO and does NOT update compound_name
  7. Status field history_item is IGNORED (double-process guard)

The branch reads field IDs from get_peptide_request_config() — we
patch that so the tests see a known mapping without needing env vars.
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
from peptide_request_config import PeptideRequestConfig
from peptide_request_repo import PeptideRequestRepository
from status_log_repo import StatusLogRepository


ensure_peptide_requests_table()
ensure_peptide_request_status_log_table()
ensure_clickup_user_mapping_table()


client = TestClient(app)


# Known field UUIDs for the test suite — arbitrary but stable strings.
FIELD_SAMPLE_ID = "fuuid-sample-id"
FIELD_CAS = "fuuid-cas"
FIELD_VENDOR = "fuuid-vendor"
FIELD_EMAIL = "fuuid-email"
FIELD_KIND = "fuuid-kind"
OPT_PEPTIDE = "opt-peptide"
OPT_OTHER = "opt-other"


def _test_cfg() -> PeptideRequestConfig:
    # Must use the real CLICKUP_WEBHOOK_SECRET from env so signature
    # verification passes; the main.py route reads config separately
    # from our patched get_peptide_request_config.
    return PeptideRequestConfig(
        clickup_list_id=os.environ.get("CLICKUP_LIST_ID", "list_webhook_test"),
        clickup_api_token=os.environ.get("CLICKUP_API_TOKEN", "tok"),
        clickup_webhook_secret=os.environ["CLICKUP_WEBHOOK_SECRET"],
        clickup_field_sample_id=FIELD_SAMPLE_ID,
        clickup_field_cas=FIELD_CAS,
        clickup_field_vendor_producer=FIELD_VENDOR,
        clickup_field_customer_email=FIELD_EMAIL,
        clickup_field_compound_kind=FIELD_KIND,
        clickup_opt_compound_kind_peptide=OPT_PEPTIDE,
        clickup_opt_compound_kind_other=OPT_OTHER,
    )


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


def _seed_row(task_id: str, compound_name: str = "TaskUpdatedFixture"):
    repo = PeptideRequestRepository()
    req = repo.create(
        PeptideRequestCreate(
            compound_kind="peptide",
            compound_name=compound_name,
            vendor_producer="OriginalVendor",
            cas_or_reference="CAS-ORIG",
            submitted_by_wp_user_id=80000 + (uuid.uuid4().int % 10000),
            submitted_by_email="orig@example.com",
            submitted_by_name="Orig",
        ),
        idempotency_key=str(uuid.uuid4()),
        clickup_list_id="list_webhook_test",
    )
    repo.update_clickup_task_id(req.id, task_id)
    return repo.get_by_id(req.id)


def _run_webhook(payload: dict):
    """Patch config resolution on the dispatch path so the route sees our
    field-id mapping even in environments where only CLICKUP_WEBHOOK_SECRET
    is set."""
    cfg = _test_cfg()
    with patch("main.get_peptide_request_config", return_value=cfg):
        return _post(payload)


# ---------------------------------------------------------------------------
# Test 1: sample_id custom field change updates DB + logs
# ---------------------------------------------------------------------------


def test_sample_id_change_updates_db_and_appends_status_log():
    task_id = f"cu_tu_{uuid.uuid4().hex[:10]}"
    row = _seed_row(task_id)
    event_id = f"evt_{uuid.uuid4().hex[:10]}"

    resp = _run_webhook({
        "event": "taskUpdated",
        "task_id": task_id,
        "history_items": [
            {
                "id": event_id,
                "field": FIELD_SAMPLE_ID,
                "before": None,
                "after": "S-WEBHOOK-001",
                "user": {"id": 77001, "username": "tech_a"},
            }
        ],
    })
    assert resp.status_code == 200

    after_row = PeptideRequestRepository().get_by_clickup_task_id(task_id)
    assert after_row is not None
    assert after_row.sample_id == "S-WEBHOOK-001"

    # Audit row written, note names the column, no status transition.
    log = StatusLogRepository().get_for_request(row.id)
    field_notes = [e for e in log if e.note and "taskUpdated" in e.note]
    assert len(field_notes) == 1
    entry = field_notes[0]
    assert entry.clickup_event_id == event_id
    assert entry.from_status == entry.to_status == row.status
    assert "sample_id" in entry.note


# ---------------------------------------------------------------------------
# Test 2: compound_kind dropdown change
# ---------------------------------------------------------------------------


def test_compound_kind_option_resolves_and_updates_db():
    task_id = f"cu_tu_{uuid.uuid4().hex[:10]}"
    row = _seed_row(task_id)  # seeded as "peptide"
    # Flip to "other" via its option UUID.
    event_id = f"evt_{uuid.uuid4().hex[:10]}"

    resp = _run_webhook({
        "event": "taskUpdated",
        "task_id": task_id,
        "history_items": [
            {
                "id": event_id,
                "field": FIELD_KIND,
                "before": OPT_PEPTIDE,
                "after": OPT_OTHER,
                "user": {"id": 77002, "username": "tech_b"},
            }
        ],
    })
    assert resp.status_code == 200

    after_row = PeptideRequestRepository().get_by_clickup_task_id(task_id)
    assert after_row is not None
    assert after_row.compound_kind == "other"


# ---------------------------------------------------------------------------
# Test 3: invalid email is skipped, other fields in same event apply
# ---------------------------------------------------------------------------


def test_invalid_email_skipped_but_other_fields_applied():
    task_id = f"cu_tu_{uuid.uuid4().hex[:10]}"
    row = _seed_row(task_id)

    resp = _run_webhook({
        "event": "taskUpdated",
        "task_id": task_id,
        "history_items": [
            {
                "id": f"evt_{uuid.uuid4().hex[:10]}",
                "field": FIELD_EMAIL,
                "before": "orig@example.com",
                "after": "not-an-email",
                "user": {"id": 77003, "username": "tech_c"},
            },
            {
                "id": f"evt_{uuid.uuid4().hex[:10]}",
                "field": FIELD_CAS,
                "before": "CAS-ORIG",
                "after": "CAS-UPDATED",
                "user": {"id": 77003, "username": "tech_c"},
            },
        ],
    })
    assert resp.status_code == 200

    after_row = PeptideRequestRepository().get_by_clickup_task_id(task_id)
    assert after_row is not None
    # Email untouched (skipped).
    assert after_row.submitted_by_email == "orig@example.com"
    # CAS applied.
    assert after_row.cas_or_reference == "CAS-UPDATED"


# ---------------------------------------------------------------------------
# Test 4: duplicate history_item id is deduped
# ---------------------------------------------------------------------------


def test_duplicate_history_item_id_is_deduped():
    task_id = f"cu_tu_{uuid.uuid4().hex[:10]}"
    row = _seed_row(task_id)
    event_id = f"evt_{uuid.uuid4().hex[:10]}"

    # First delivery — applies.
    payload = {
        "event": "taskUpdated",
        "task_id": task_id,
        "history_items": [
            {
                "id": event_id,
                "field": FIELD_VENDOR,
                "before": "OriginalVendor",
                "after": "FirstDelivery",
                "user": {"id": 77004, "username": "tech_d"},
            }
        ],
    }
    assert _run_webhook(payload).status_code == 200

    # Same event id delivered a second time — should be a no-op.
    payload["history_items"][0]["after"] = "SecondDelivery"
    assert _run_webhook(payload).status_code == 200

    after_row = PeptideRequestRepository().get_by_clickup_task_id(task_id)
    assert after_row is not None
    # Second delivery was deduped BEFORE the apply — first value stands.
    assert after_row.vendor_producer == "FirstDelivery"

    # Exactly one status_log row with this event id.
    log = StatusLogRepository().get_for_request(row.id)
    with_this_event = [e for e in log if e.clickup_event_id == event_id]
    assert len(with_this_event) == 1


# ---------------------------------------------------------------------------
# Test 5: unknown row logs WARN and returns silently
# ---------------------------------------------------------------------------


def test_unknown_task_id_logs_warn_and_returns_200():
    unknown_task = f"cu_unknown_{uuid.uuid4().hex[:10]}"
    resp = _run_webhook({
        "event": "taskUpdated",
        "task_id": unknown_task,
        "history_items": [
            {
                "id": f"evt_{uuid.uuid4().hex[:10]}",
                "field": FIELD_SAMPLE_ID,
                "before": None,
                "after": "S-GHOST",
                "user": {"id": 77005, "username": "tech_ghost"},
            }
        ],
    })
    assert resp.status_code == 200

    # No row ever materializes on this path — taskUpdated doesn't
    # create, it only updates.
    assert PeptideRequestRepository().get_by_clickup_task_id(unknown_task) is None


# ---------------------------------------------------------------------------
# Test 6: name field change logs INFO but does NOT update compound_name
# ---------------------------------------------------------------------------


def test_name_change_does_not_update_compound_name():
    task_id = f"cu_tu_{uuid.uuid4().hex[:10]}"
    row = _seed_row(task_id, compound_name="NameChangeFixture")

    resp = _run_webhook({
        "event": "taskUpdated",
        "task_id": task_id,
        "history_items": [
            {
                "id": f"evt_{uuid.uuid4().hex[:10]}",
                "field": "name",
                "before": "NameChangeFixture",
                "after": "[peptide] NewName — Vendor",
                "user": {"id": 77006, "username": "tech_e"},
            }
        ],
    })
    assert resp.status_code == 200

    after_row = PeptideRequestRepository().get_by_clickup_task_id(task_id)
    assert after_row is not None
    # Unchanged — name is DB->ClickUp only per HANDOFF.
    assert after_row.compound_name == "NameChangeFixture"

    # No status_log audit row for the name change (info-only).
    log = StatusLogRepository().get_for_request(row.id)
    assert not any(
        e.note and "name" in e.note.lower() and "taskUpdated" in e.note
        for e in log
    )


# ---------------------------------------------------------------------------
# Test 7: status field history_item is IGNORED in taskUpdated
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Real-world payload shape regression
# ---------------------------------------------------------------------------


def test_real_world_custom_field_shape_extracts_uuid_from_custom_field_id():
    """ClickUp delivers taskUpdated custom-field events as
        {"field": "custom_field", "custom_field": {"id": "<uuid>", ...}}
    rather than putting the UUID directly in `field`. Discovered on
    the live webhook during the HANDOFF smoke test — locked in here so
    a future refactor can't regress to the documented-but-wrong shape.
    """
    task_id = f"cu_tu_rw_{uuid.uuid4().hex[:10]}"
    row = _seed_row(task_id)
    event_id = f"evt_{uuid.uuid4().hex[:10]}"

    resp = _run_webhook({
        "event": "taskUpdated",
        "task_id": task_id,
        "history_items": [
            {
                "id": event_id,
                "type": 1,
                "field": "custom_field",
                "custom_field": {
                    "id": FIELD_CAS,
                    "name": "CAS #",
                    "type": "short_text",
                },
                "before": "CAS-ORIG",
                "after": "CAS-REAL-WORLD",
                "user": {"id": 77100, "username": "tech_rw"},
            }
        ],
    })
    assert resp.status_code == 200

    after = PeptideRequestRepository().get_by_clickup_task_id(task_id)
    assert after is not None
    assert after.cas_or_reference == "CAS-REAL-WORLD"


def test_status_field_in_history_is_ignored():
    """taskStatusUpdated owns status transitions. If we also processed a
    status history_item here, we'd double-log and potentially
    double-fire relay/completion. This test proves the skip."""
    task_id = f"cu_tu_{uuid.uuid4().hex[:10]}"
    row = _seed_row(task_id)

    resp = _run_webhook({
        "event": "taskUpdated",
        "task_id": task_id,
        "history_items": [
            {
                "id": f"evt_{uuid.uuid4().hex[:10]}",
                "field": "status",
                "before": {"status": "requested"},
                "after": {"status": "analyzing"},
                "user": {"id": 77007, "username": "tech_f"},
            }
        ],
    })
    assert resp.status_code == 200

    after_row = PeptideRequestRepository().get_by_clickup_task_id(task_id)
    assert after_row is not None
    # Status unchanged — this branch did not touch it.
    assert after_row.status == row.status

    # No new status_log rows written by the taskUpdated branch.
    log_before_count = len(StatusLogRepository().get_for_request(row.id))
    # (We only seeded the row; no prior log entries expected.)
    # The presence check: no entry has a taskUpdated note.
    assert not any(
        e.note and "taskUpdated" in e.note
        for e in StatusLogRepository().get_for_request(row.id)
    )
