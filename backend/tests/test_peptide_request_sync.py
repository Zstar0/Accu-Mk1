"""Tests for the sync-from-ClickUp service (compute_diff + apply_actions).

These tests exercise the pure orchestration logic with mocked
ClickUpClient and repo dependencies. The DB is real (so
create_from_clickup_task / mark_retired / update_status exercise their
SQL) but the ClickUp HTTP surface is stubbed.

Baseline: test_clickup_webhook_taskcreated.py seeds the
peptide_requests table fixture; we reuse ensure_* to guarantee the
schema exists before the module's module-level inserts run.
"""
import uuid
from datetime import datetime
from unittest.mock import MagicMock
from uuid import uuid4

from clickup_user_mapping_repo import ClickUpUserMappingRepository
from mk1_db import (
    ensure_clickup_user_mapping_table,
    ensure_peptide_request_status_log_table,
    ensure_peptide_requests_table,
)
from models_peptide_request import PeptideRequest, PeptideRequestCreate
from peptide_request_config import PeptideRequestConfig
from peptide_request_repo import PeptideRequestRepository
from peptide_request_sync import apply_actions, compute_diff
from status_log_repo import StatusLogRepository


ensure_peptide_requests_table()
ensure_peptide_request_status_log_table()
ensure_clickup_user_mapping_table()


def _make_cfg() -> PeptideRequestConfig:
    """Minimal config — only the column_map + list_id matter for these
    tests. API tokens / webhook secrets are irrelevant because we mock
    the ClickUpClient entirely."""
    return PeptideRequestConfig(
        clickup_list_id="list_sync_test",
        clickup_api_token="tok",
        clickup_webhook_secret="sec",
    )


def _fake_task(
    task_id: str,
    name: str = "TestTask",
    column: str = "requested",
    url: str = "https://app.clickup.com/t/xyz",
    creator: str = "tech_a",
) -> dict:
    return {
        "id": task_id,
        "name": name,
        "status": {"status": column, "type": "open"},
        "url": url,
        "creator": {"id": 77001, "username": creator, "email": "t@a.b"},
    }


def _seed_row(clickup_task_id: str, compound_name: str) -> PeptideRequest:
    """Seed a WP-path row and stamp its clickup_task_id. Returns the
    row after the task id stamp so the caller sees the live state."""
    repo = PeptideRequestRepository()
    seed = repo.create(
        PeptideRequestCreate(
            compound_kind="peptide",
            compound_name=compound_name,
            vendor_producer="V",
            submitted_by_wp_user_id=9999 + len(clickup_task_id) % 1000,
            submitted_by_email=f"{uuid.uuid4().hex[:6]}@t.com",
            submitted_by_name="Seed",
        ),
        idempotency_key=str(uuid.uuid4()),
        clickup_list_id="list_sync_test",
    )
    repo.update_clickup_task_id(seed.id, clickup_task_id)
    row = repo.get_by_id(seed.id)
    assert row is not None
    return row


# ---------------------------------------------------------------------------
# compute_diff
# ---------------------------------------------------------------------------


def test_compute_diff_buckets_tasks_and_rows_correctly():
    """Three buckets, all three populated, no false positives on a
    matching pair. Retired rows excluded from the "missing from ClickUp"
    bucket."""
    cfg = _make_cfg()

    # Task A — in ClickUp, no row -> in_clickup_not_mk1
    task_only_id = f"cu_only_{uuid.uuid4().hex[:8]}"
    task_only = _fake_task(task_only_id, name="TaskOnly", column="requested")

    # Task B + matching row, matching status -> neither bucket
    matching_tid = f"cu_match_{uuid.uuid4().hex[:8]}"
    _seed_row(matching_tid, "MatchCompound")
    # map "requested" -> "new", and the seeded row starts at "new".
    matching_task = _fake_task(matching_tid, name="MatchCompound", column="requested")

    # Task C + row with DIFFERENT status -> status_mismatch
    mismatch_tid = f"cu_mis_{uuid.uuid4().hex[:8]}"
    mismatch_row = _seed_row(mismatch_tid, "MismatchCompound")
    # Bump DB status away from "new" so the diff fires.
    PeptideRequestRepository().update_status(
        mismatch_row.id, new_status="in_process", previous_status="new"
    )
    mismatch_task = _fake_task(
        mismatch_tid, name="MismatchCompound", column="requested"  # -> new
    )

    # Row D — clickup_task_id set but task not in fetch -> in_mk1_not_clickup
    missing_tid = f"cu_missing_{uuid.uuid4().hex[:8]}"
    _seed_row(missing_tid, "MissingFromClickUp")

    # Row E — retired, task also absent. MUST be excluded from bucket 2.
    retired_tid = f"cu_retired_{uuid.uuid4().hex[:8]}"
    retired_row = _seed_row(retired_tid, "RetiredNoise")
    PeptideRequestRepository().mark_retired(retired_row.id)

    fake_client = MagicMock()
    fake_client.list_tasks.return_value = [task_only, matching_task, mismatch_task]

    out = compute_diff(fake_client, PeptideRequestRepository(), cfg)

    task_ids_only = [x["task_id"] for x in out["in_clickup_not_mk1"]]
    assert task_only_id in task_ids_only
    assert matching_tid not in task_ids_only
    assert mismatch_tid not in task_ids_only

    missing_task_ids = [x["clickup_task_id"] for x in out["in_mk1_not_clickup"]]
    assert missing_tid in missing_task_ids
    assert retired_tid not in missing_task_ids  # retired excluded
    assert matching_tid not in missing_task_ids
    assert mismatch_tid not in missing_task_ids

    mismatch_ids = [x["clickup_task_id"] for x in out["status_mismatch"]]
    assert mismatch_tid in mismatch_ids
    one = next(x for x in out["status_mismatch"] if x["clickup_task_id"] == mismatch_tid)
    assert one["mk1_status"] == "in_process"
    assert one["clickup_column"] == "requested"
    assert one["mapped_status"] == "new"

    # And the view-model shape the frontend expects:
    if out["in_clickup_not_mk1"]:
        item = next(
            x for x in out["in_clickup_not_mk1"] if x["task_id"] == task_only_id
        )
        assert item["name"] == "TaskOnly"
        assert item["clickup_status"] == "requested"
        assert item["creator_username"] == "tech_a"


def test_compute_diff_skips_unmapped_columns():
    """If a ClickUp column isn't in column_map, we log+bail instead of
    surfacing a status_mismatch with mapped_status=None — which would
    force the UI to apply a None status and crash on apply."""
    cfg = _make_cfg()

    tid = f"cu_unmapped_{uuid.uuid4().hex[:8]}"
    _seed_row(tid, "UnmappedCompound")
    task = _fake_task(tid, column="Some Unknown Column")

    fake_client = MagicMock()
    fake_client.list_tasks.return_value = [task]

    out = compute_diff(fake_client, PeptideRequestRepository(), cfg)
    mismatch_ids = [x["clickup_task_id"] for x in out["status_mismatch"]]
    assert tid not in mismatch_ids


# ---------------------------------------------------------------------------
# apply_actions
# ---------------------------------------------------------------------------


def test_apply_actions_materialize_creates_row_with_source_manual():
    cfg = _make_cfg()
    task_id = f"cu_apply_{uuid.uuid4().hex[:8]}"
    compound_name = f"APPLY-{uuid.uuid4().hex[:6]}"

    fake_client = MagicMock()
    fake_client.get_task.return_value = _fake_task(
        task_id, name=compound_name, column="requested"
    )

    res = apply_actions(
        {
            "materialize_task_ids": [task_id],
            "retire_row_ids": [],
            "fix_status_pairs": [],
        },
        fake_client,
        PeptideRequestRepository(),
        StatusLogRepository(),
        ClickUpUserMappingRepository(),
        cfg,
    )

    assert res["materialized"] == 1
    assert res["retired"] == 0
    assert res["fixed_status"] == 0
    assert res["errors"] == []

    row = PeptideRequestRepository().get_by_clickup_task_id(task_id)
    assert row is not None
    assert row.source == "manual"
    assert row.status == "new"
    assert row.compound_name == compound_name


def test_apply_actions_retire_sets_retired_at_and_logs():
    cfg = _make_cfg()
    task_id = f"cu_ret_{uuid.uuid4().hex[:8]}"
    row = _seed_row(task_id, "RetireMe")

    fake_client = MagicMock()

    res = apply_actions(
        {
            "materialize_task_ids": [],
            "retire_row_ids": [str(row.id)],
            "fix_status_pairs": [],
        },
        fake_client,
        PeptideRequestRepository(),
        StatusLogRepository(),
        ClickUpUserMappingRepository(),
        cfg,
    )
    assert res["retired"] == 1
    assert res["errors"] == []

    after = PeptideRequestRepository().get_by_id(row.id)
    assert after is not None
    assert after.retired_at is not None

    log = StatusLogRepository().get_for_request(row.id)
    assert any(e.note == "Retired via Sync from ClickUp" for e in log)


def test_apply_actions_fix_status_updates_and_logs():
    cfg = _make_cfg()
    task_id = f"cu_fix_{uuid.uuid4().hex[:8]}"
    row = _seed_row(task_id, "FixMe")
    # Seeded at "new". Move to "in_process" via apply.

    fake_client = MagicMock()

    res = apply_actions(
        {
            "materialize_task_ids": [],
            "retire_row_ids": [],
            "fix_status_pairs": [
                {"row_id": str(row.id), "target_status": "in_process"}
            ],
        },
        fake_client,
        PeptideRequestRepository(),
        StatusLogRepository(),
        ClickUpUserMappingRepository(),
        cfg,
    )
    assert res["fixed_status"] == 1
    assert res["errors"] == []

    after = PeptideRequestRepository().get_by_id(row.id)
    assert after is not None
    assert after.status == "in_process"
    assert after.previous_status == "new"

    log = StatusLogRepository().get_for_request(row.id)
    assert any(
        e.note == "Status synced from ClickUp via sync modal"
        and e.from_status == "new"
        and e.to_status == "in_process"
        for e in log
    )


def test_apply_actions_unmapped_column_errors_but_other_actions_proceed():
    """Error-isolation contract: a single bad item records an error but
    the rest of the payload still executes."""
    cfg = _make_cfg()
    bad_task_id = f"cu_bad_{uuid.uuid4().hex[:8]}"
    good_task_id = f"cu_good_{uuid.uuid4().hex[:8]}"

    fake_client = MagicMock()

    def get_task_side_effect(tid: str) -> dict:
        if tid == bad_task_id:
            return _fake_task(tid, name="Bad", column="Some Unknown Column")
        return _fake_task(tid, name="Good", column="requested")

    fake_client.get_task.side_effect = get_task_side_effect

    res = apply_actions(
        {
            "materialize_task_ids": [bad_task_id, good_task_id],
            "retire_row_ids": [],
            "fix_status_pairs": [],
        },
        fake_client,
        PeptideRequestRepository(),
        StatusLogRepository(),
        ClickUpUserMappingRepository(),
        cfg,
    )
    assert res["materialized"] == 1  # good still applied
    assert len(res["errors"]) == 1
    err = res["errors"][0]
    assert err["type"] == "materialize"
    assert err["id"] == bad_task_id
    assert "unmapped" in err["reason"].lower()

    # Good row landed; bad row absent.
    assert PeptideRequestRepository().get_by_clickup_task_id(good_task_id) is not None
    assert PeptideRequestRepository().get_by_clickup_task_id(bad_task_id) is None
