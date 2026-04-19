"""Tests for backend/jobs/clickup_task_retry.py.

Verifies the retry sweep for rows where the inline ClickUp create on POST
failed to land a task id. Covers three scenarios:

  1. Row > 60s old with clickup_task_id=NULL → job creates and writes the id.
  2. Row < 60s old → not picked up (age guard), mock is NOT called.
  3. Row > 24h old, create raises → clickup_create_failed_at set,
     task_id stays NULL.

Backdating `created_at` for scenarios 1 and 3 is legitimate test setup:
DEFAULT NOW() on INSERT makes direct SQL the cleanest way to fake age.

HTTP is mocked by patching ClickUpClient where the job module imports it
(`backend.jobs.clickup_task_retry.ClickUpClient`) — not at the requests
layer — so we never hit the network regardless of what the real client
does under the hood.
"""
import os
import uuid

from unittest.mock import patch
from psycopg2.extras import RealDictCursor

# Env vars must be set BEFORE importing the job module so get_config()
# inside run_once() can resolve them.
os.environ.setdefault("CLICKUP_LIST_ID", "fake-list-id")
os.environ.setdefault("CLICKUP_API_TOKEN", "fake-clickup-token")
os.environ.setdefault("CLICKUP_WEBHOOK_SECRET", "fake-webhook-secret")
os.environ.setdefault("MK1_DB_HOST", "localhost")

from backend.mk1_db import ensure_peptide_requests_table, get_mk1_conn
from backend.models_peptide_request import PeptideRequestCreate
from backend.peptide_request_repo import PeptideRequestRepository
from backend.jobs.clickup_task_retry import run_once


# Idempotent DDL — matches the pattern used elsewhere in the suite.
ensure_peptide_requests_table()


def _fetch_row(request_id) -> dict:
    with get_mk1_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute(
            "SELECT * FROM peptide_requests WHERE id = %s",
            (str(request_id),),
        )
        return dict(cur.fetchone())


def _backdate(request_id, interval_sql: str) -> None:
    """Shift a row's created_at into the past so age-gated queries pick it
    up (or the 24h terminal-fail branch fires). Uses an interval literal
    like '65 seconds' or '25 hours'.
    """
    with get_mk1_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            f"UPDATE peptide_requests "
            f"SET created_at = NOW() - INTERVAL '{interval_sql}' "
            f"WHERE id = %s",
            (str(request_id),),
        )
        conn.commit()


def _make_request(wp_user_id: int, compound_name: str = "Tesamorelin"):
    repo = PeptideRequestRepository()
    return repo.create(
        PeptideRequestCreate(
            compound_kind="peptide",
            compound_name=compound_name,
            vendor_producer="TestVendor",
            submitted_by_wp_user_id=wp_user_id,
            submitted_by_email=f"user{wp_user_id}@test.c",
            submitted_by_name=f"User{wp_user_id}",
        ),
        idempotency_key=str(uuid.uuid4()),
        clickup_list_id="list_retry_test",
    )


@patch("backend.jobs.clickup_task_retry.ClickUpClient")
def test_retry_picks_up_and_creates(mock_client_cls):
    # Unique wp_user_id per test avoids collisions with other test files
    # that share this DB table.
    req = _make_request(wp_user_id=9001, compound_name="Sermorelin-Retry1")
    # Backdate past the 60s age guard so find_needing_clickup_create() sees it.
    _backdate(req.id, "65 seconds")

    # Stub the client instance returned by ClickUpClient(...) so we control
    # create_task_for_request's return value. The shared-fixture DB may hold
    # other aged rows from prior tests, so route every call through this
    # stub by returning a generated id per request — the assertion below
    # validates that OUR row received the expected id.
    mock_instance = mock_client_cls.return_value
    mock_instance.create_task_for_request.side_effect = (
        lambda r: "tsk_retry_1" if r.id == req.id else f"tsk_other_{r.id}"
    )

    run_once()

    # Confirm our target row was processed (at least one call was for it).
    target_calls = [
        c for c in mock_instance.create_task_for_request.call_args_list
        if c.args and c.args[0].id == req.id
    ]
    assert len(target_calls) == 1
    row = _fetch_row(req.id)
    assert row["clickup_task_id"] == "tsk_retry_1"
    assert row["clickup_create_failed_at"] is None


@patch("backend.jobs.clickup_task_retry.ClickUpClient")
def test_retry_does_not_pick_up_recent_rows(mock_client_cls):
    # Freshly-created row: created_at ~ NOW(), so the 60s age guard in
    # find_needing_clickup_create() should exclude it.
    req = _make_request(wp_user_id=9002, compound_name="Retry-TooNew")

    mock_instance = mock_client_cls.return_value

    run_once()

    mock_instance.create_task_for_request.assert_not_called()
    row = _fetch_row(req.id)
    assert row["clickup_task_id"] is None
    assert row["clickup_create_failed_at"] is None


@patch("backend.jobs.clickup_task_retry.ClickUpClient")
def test_retry_marks_terminally_failed_after_24h(mock_client_cls):
    req = _make_request(wp_user_id=9003, compound_name="Retry-Terminal")
    # Backdate past 24h so the failure branch's `created_at < NOW() - 24h`
    # guard fires and sets clickup_create_failed_at.
    _backdate(req.id, "25 hours")

    mock_instance = mock_client_cls.return_value
    mock_instance.create_task_for_request.side_effect = RuntimeError(
        "ClickUp 500"
    )

    run_once()

    mock_instance.create_task_for_request.assert_called_once()
    row = _fetch_row(req.id)
    assert row["clickup_task_id"] is None
    assert row["clickup_create_failed_at"] is not None
