"""End-to-end: submit -> ClickUp task created -> webhook status changes -> WP relay + coupon + SENAITE all called.

This ties Tasks 1-15 together as one cohesive happy-path run:
  POST /peptide-requests  -> inline ClickUp create (mocked)
  POST /webhooks/clickup      -> signature verify + dispatch
  run_all (synchronous)       -> coupon + SENAITE side-effects (mocked)
  run_once (synchronous)      -> WP relay (mocked)
  GET  /peptide-requests  -> final state: status=completed, wp_coupon_code set

Mocking strategy:

* ClickUp and integration-service clients both do `import requests; requests.post(...)`.
  They share the SAME `requests` module object, so patching both
  `backend.clickup_client.requests.post` AND `backend.integration_service_client.requests.post`
  with separate MagicMocks clobbers the first patch with the second (both target
  the same attribute on the shared `requests` module). We patch once at
  `requests.post` and route by URL via `side_effect`.

* The ClickUp webhook dispatcher would normally spawn daemon threads for `relay`
  and `completion side-effects`, racing the synchronous calls below. We patch
  `backend.clickup_webhook.enqueue_relay_status_to_wp` and
  `enqueue_completion_side_effects` to no-ops so only the synchronous `run_all`
  + `run_once` calls produce the asserted final state. That matches the spec's
  "in test, call synchronously."

* `clickup_task_id` is randomized per run so repeated test runs against the
  shared accumark_mk1 test DB do not collide on the webhook's task-id lookup.
"""
import hashlib
import hmac
import json
import os
import uuid
from unittest.mock import MagicMock, patch

# Set required env vars BEFORE importing client / config modules so constructors
# can resolve them. `setdefault` keeps any caller-provided value.
os.environ.setdefault("ACCUMK1_INTERNAL_SERVICE_TOKEN", "test-token")
os.environ.setdefault("CLICKUP_LIST_ID", "list_test")
os.environ.setdefault("CLICKUP_API_TOKEN", "tok")
os.environ.setdefault("CLICKUP_WEBHOOK_SECRET", "secret")
os.environ.setdefault("INTEGRATION_SERVICE_URL", "http://fake")
os.environ.setdefault("INTEGRATION_SERVICE_TOKEN", "fake")
os.environ.setdefault("MK1_DB_HOST", "localhost")

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402
from mk1_db import (  # noqa: E402
    ensure_clickup_user_mapping_table,
    ensure_peptide_request_status_log_table,
    ensure_peptide_requests_table,
)

# Idempotent DDL so the E2E test is self-sufficient and does not depend on
# test-module ordering.
ensure_peptide_requests_table()
ensure_peptide_request_status_log_table()
ensure_clickup_user_mapping_table()


def _sign(body: bytes, secret: str) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def _mock_response(body: dict) -> MagicMock:
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = body
    resp.raise_for_status.return_value = None
    return resp


@patch("clickup_webhook.enqueue_completion_side_effects", lambda _id: None)
@patch(
    "clickup_webhook.enqueue_relay_status_to_wp",
    lambda _id, new_status, previous_status: None,
)
@patch("integration_service_client.requests.post")
def test_happy_path(mock_post):
    """Happy path: POST -> webhook -> sync jobs -> final state reflects all side effects.

    `mock_post` is the sole intercept for all outbound HTTP in this test
    (ClickUp's `clickup_client` and `integration_service_client` both import
    the same `requests` module, so one patch covers both). `side_effect`
    routes by URL to avoid order assumptions between the ClickUp create
    (inline in POST) and the three integration-service calls (run_all coupon,
    run_all senaite, run_once relay).
    """
    task_id = f"tsk_e2e_{uuid.uuid4().hex[:8]}"

    def _route(url, *args, **kwargs):
        # ClickUp task create — api.clickup.com/.../task
        if "api.clickup.com" in url:
            return _mock_response({"id": task_id, "url": "x"})
        # Integration-service endpoints
        if "/coupons/single-use" in url:
            return _mock_response(
                {"coupon_code": "E2E-CODE", "issued_at": "2026-04-17T00:00:00Z"}
            )
        if "/senaite/services/clone" in url:
            return _mock_response({"service_uid": "svc_e2e"})
        if "/wp/peptide-request-status" in url:
            return _mock_response({"wp_accepted": True})
        raise AssertionError(f"unexpected URL in test: {url}")

    mock_post.side_effect = _route

    # 1. POST /peptide-requests as integration-service.
    client = TestClient(app)
    headers = {
        "X-Service-Token": os.environ["ACCUMK1_INTERNAL_SERVICE_TOKEN"],
        "Idempotency-Key": str(uuid.uuid4()),
    }
    body = {
        "compound_kind": "peptide",
        "compound_name": "E2E-Test",
        "vendor_producer": "PepMart",
        "submitted_by_wp_user_id": 9999,
        "submitted_by_email": "e2e@test.com",
        "submitted_by_name": "E2E",
    }
    resp = client.post("/peptide-requests", headers=headers, json=body)
    assert resp.status_code == 201, resp.text
    req_id = resp.json()["id"]
    assert resp.json()["clickup_task_id"] == task_id

    # 2. Simulate ClickUp webhook: Completed
    webhook_body = json.dumps({
        "event": "taskStatusUpdated",
        "task_id": task_id,
        "history_items": [{
            "id": f"evt_{uuid.uuid4()}",
            "field": "status",
            "before": {"status": "approved"},
            "after": {"status": "completed"},
            "user": {"id": "cu_test", "username": "t", "email": "t@lab.com"},
        }],
    }).encode()
    secret = os.environ["CLICKUP_WEBHOOK_SECRET"]
    sig = _sign(webhook_body, secret)
    wh_resp = client.post(
        "/webhooks/clickup",
        content=webhook_body,
        headers={"X-Signature": sig, "Content-Type": "application/json"},
    )
    assert wh_resp.status_code == 200, wh_resp.text

    # 3. Run background jobs synchronously (the real `enqueue_*` helpers were
    # patched to no-ops above so the webhook doesn't spawn competing threads).
    from uuid import UUID

    from jobs.completion_side_effects import run_all
    from jobs.relay_status_to_wp import run_once

    run_all(UUID(req_id))
    run_once(UUID(req_id), new_status="completed", previous_status="approved")

    # 4. Verify final state
    final = client.get(f"/peptide-requests/{req_id}", headers=headers)
    assert final.status_code == 200, final.text
    data = final.json()
    assert data["status"] == "completed"
    assert data["wp_coupon_code"] == "E2E-CODE"
    assert data["senaite_service_uid"] == "svc_e2e"

    # All four outbound calls fired (1 ClickUp create + 3 integration-service).
    urls = [call.args[0] for call in mock_post.call_args_list]
    assert any("api.clickup.com" in u for u in urls)
    assert any("/coupons/single-use" in u for u in urls)
    assert any("/senaite/services/clone" in u for u in urls)
    assert any("/wp/peptide-request-status" in u for u in urls)
