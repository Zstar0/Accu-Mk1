"""Sync-from-ClickUp service layer.

Computes discrepancies between the ClickUp sandbox list and the
``peptide_requests`` table, and applies tech-selected actions to
reconcile them. The webhook pipeline handles the steady-state
(taskCreated, taskStatusUpdated, taskDeleted); this module exists for
the case where a webhook was missed (outage, clock skew, delivery
failure) or for the initial backfill of tasks that pre-date the sync
feature.

Three buckets, mirrored in the frontend modal:

    in_clickup_not_mk1   — task has no DB row; action = materialize
    in_mk1_not_clickup   — DB row's task id isn't in the list fetch;
                           action = retire
    status_mismatch      — row + task both exist but the DB status
                           doesn't match the current ClickUp column's
                           mapped status; action = update DB status

The module is intentionally framework-agnostic (plain functions, no
FastAPI dependencies) so it can be unit-tested with mocked repos/
clients and reused from a future reconciliation cron if we ever add
one.
"""
from __future__ import annotations

import logging
from typing import Optional
from uuid import UUID

from clickup_client import ClickUpClient
from clickup_user_mapping_repo import ClickUpUserMappingRepository
from peptide_request_config import PeptideRequestConfig
from peptide_request_repo import PeptideRequestRepository
from status_log_repo import StatusLogRepository


log = logging.getLogger(__name__)


def _clickup_column(task: dict) -> str:
    """Extract the column name from a ClickUp task dict. v2 nests it
    under ``status.status``; defaults to empty string so callers can
    normalize/compare without None-checks."""
    status_obj = task.get("status") or {}
    return status_obj.get("status") or ""


def compute_diff(
    client: ClickUpClient,
    prepo: PeptideRequestRepository,
    cfg: PeptideRequestConfig,
) -> dict:
    """Compute the three discrepancy buckets as serializable dicts.

    The return shape is the contract with the frontend modal:

        {
          "in_clickup_not_mk1": [
              {task_id, name, clickup_status, clickup_url,
               creator_username}, ...
          ],
          "in_mk1_not_clickup": [
              {row_id, clickup_task_id, compound_name, status,
               created_at}, ...
          ],
          "status_mismatch": [
              {row_id, clickup_task_id, compound_name, mk1_status,
               clickup_column, mapped_status}, ...
          ],
        }

    All ids are strings (UUIDs stringified) so the JSON is round-trip
    safe in the browser. created_at is ISO 8601 for the same reason.
    """
    tasks = client.list_tasks(include_closed=True, include_subtasks=False)
    rows = prepo.list_all_with_clickup_ids()

    tasks_by_id: dict[str, dict] = {}
    for t in tasks:
        tid = t.get("id")
        if tid:
            tasks_by_id[tid] = t

    rows_by_task_id: dict[str, object] = {
        r.clickup_task_id: r for r in rows if r.clickup_task_id
    }

    in_clickup_not_mk1: list[dict] = []
    in_mk1_not_clickup: list[dict] = []
    status_mismatch: list[dict] = []

    # Bucket 1: ClickUp -> no row
    for tid, t in tasks_by_id.items():
        if tid in rows_by_task_id:
            continue
        creator = t.get("creator") or {}
        in_clickup_not_mk1.append(
            {
                "task_id": tid,
                "name": t.get("name") or "",
                "clickup_status": _clickup_column(t),
                "clickup_url": t.get("url") or "",
                "creator_username": creator.get("username") or "",
            }
        )

    # Bucket 2: row -> no task, AND bucket 3: status drift
    for tid, r in rows_by_task_id.items():
        t = tasks_by_id.get(tid)
        if t is None:
            in_mk1_not_clickup.append(
                {
                    "row_id": str(r.id),
                    "clickup_task_id": tid,
                    "compound_name": r.compound_name,
                    "status": r.status,
                    "created_at": r.created_at.isoformat()
                    if r.created_at
                    else None,
                }
            )
            continue
        column = _clickup_column(t)
        mapped = cfg.map_column_to_status(column)
        if mapped is None:
            # Unmapped column — treat as "no drift we can express".
            # The tech should fix the column map before a sync; emitting
            # a status_mismatch row with mapped_status=None would invite
            # a broken apply call.
            log.warning(
                "compute_diff: unmapped ClickUp column %r on task %s",
                column,
                tid,
            )
            continue
        if mapped != r.status:
            status_mismatch.append(
                {
                    "row_id": str(r.id),
                    "clickup_task_id": tid,
                    "compound_name": r.compound_name,
                    "mk1_status": r.status,
                    "clickup_column": column,
                    "mapped_status": mapped,
                }
            )

    return {
        "in_clickup_not_mk1": in_clickup_not_mk1,
        "in_mk1_not_clickup": in_mk1_not_clickup,
        "status_mismatch": status_mismatch,
    }


def _materialize_one(
    task_id: str,
    client: ClickUpClient,
    prepo: PeptideRequestRepository,
    lrepo: StatusLogRepository,
    urepo: ClickUpUserMappingRepository,
    cfg: PeptideRequestConfig,
) -> Optional[dict]:
    """Materialize a single ClickUp task into a peptide_requests row.

    Returns an error dict on failure (so the caller can surface it in
    the apply response's ``errors`` array), or None on success. Parallels
    clickup_webhook._handle_task_created but without the webhook payload
    scaffolding.
    """
    task = client.get_task(task_id)
    column = _clickup_column(task)
    mapped = cfg.map_column_to_status(column)
    if mapped is None:
        log.warning(
            "apply_actions: skipping materialize for task %s — "
            "unmapped ClickUp column %r",
            task_id,
            column,
        )
        return {
            "type": "materialize",
            "id": task_id,
            "reason": f"unmapped ClickUp column: {column!r}",
        }

    creator = task.get("creator") or {}
    actor_mapping = None
    creator_id = creator.get("id")
    if creator_id:
        actor_mapping = urepo.upsert(
            clickup_user_id=str(creator_id),
            clickup_username=creator.get("username", "") or "",
            clickup_email=creator.get("email"),
        )

    req = prepo.create_from_clickup_task(
        task_dict=task,
        mapped_status=mapped,
        clickup_task_id=task_id,
        clickup_list_id=cfg.clickup_list_id,
    )
    lrepo.append(
        peptide_request_id=req.id,
        from_status=None,
        to_status=mapped,
        source="clickup",
        clickup_event_id=None,
        actor_clickup_user_id=str(creator_id) if creator_id else None,
        actor_accumk1_user_id=(
            actor_mapping.accumk1_user_id if actor_mapping else None
        ),
        note="Materialized via Sync from ClickUp",
    )
    return None


def apply_actions(
    actions: dict,
    client: ClickUpClient,
    prepo: PeptideRequestRepository,
    lrepo: StatusLogRepository,
    urepo: ClickUpUserMappingRepository,
    cfg: PeptideRequestConfig,
) -> dict:
    """Execute the tech-selected actions.

    ``actions`` shape (matches the frontend payload):

        {
          "materialize_task_ids": ["abc", "def", ...],
          "retire_row_ids":       ["<uuid>", ...],
          "fix_status_pairs":     [{"row_id": "<uuid>",
                                    "target_status": "in_process"}, ...],
        }

    Errors in one item NEVER abort the rest. Every failure lands in the
    ``errors`` array so the UI can show the tech exactly which rows to
    re-check, while the other actions still persist. Counts in the
    result only include successes.
    """
    errors: list[dict] = []
    materialized = 0
    retired = 0
    fixed_status = 0

    for task_id in actions.get("materialize_task_ids", []) or []:
        try:
            err = _materialize_one(task_id, client, prepo, lrepo, urepo, cfg)
            if err is not None:
                errors.append(err)
            else:
                materialized += 1
        except Exception as e:  # noqa: BLE001 — we report, don't crash
            log.exception("apply_actions: materialize failed for %s", task_id)
            errors.append(
                {"type": "materialize", "id": task_id, "reason": str(e)}
            )

    for row_id in actions.get("retire_row_ids", []) or []:
        try:
            row_uuid = row_id if isinstance(row_id, UUID) else UUID(str(row_id))
            before = prepo.get_by_id(row_uuid)
            if before is None:
                errors.append(
                    {"type": "retire", "id": str(row_id), "reason": "row not found"}
                )
                continue
            result = prepo.mark_retired(row_uuid)
            if result is None:
                # Already retired — idempotent no-op, not an error.
                continue
            lrepo.append(
                peptide_request_id=row_uuid,
                from_status=before.status,
                to_status=before.status,
                source="accumk1_admin",
                clickup_event_id=None,
                actor_clickup_user_id=None,
                actor_accumk1_user_id=None,
                note="Retired via Sync from ClickUp",
            )
            retired += 1
        except Exception as e:  # noqa: BLE001
            log.exception("apply_actions: retire failed for %s", row_id)
            errors.append({"type": "retire", "id": str(row_id), "reason": str(e)})

    for pair in actions.get("fix_status_pairs", []) or []:
        try:
            raw_row_id = pair.get("row_id") if isinstance(pair, dict) else pair.row_id
            raw_target = (
                pair.get("target_status")
                if isinstance(pair, dict)
                else pair.target_status
            )
            row_uuid = (
                raw_row_id if isinstance(raw_row_id, UUID) else UUID(str(raw_row_id))
            )
            before = prepo.get_by_id(row_uuid)
            if before is None:
                errors.append(
                    {
                        "type": "fix_status",
                        "id": str(raw_row_id),
                        "reason": "row not found",
                    }
                )
                continue
            prepo.update_status(
                row_uuid,
                new_status=raw_target,
                previous_status=before.status,
            )
            lrepo.append(
                peptide_request_id=row_uuid,
                from_status=before.status,
                to_status=raw_target,
                source="accumk1_admin",
                clickup_event_id=None,
                actor_clickup_user_id=None,
                actor_accumk1_user_id=None,
                note="Status synced from ClickUp via sync modal",
            )
            fixed_status += 1
        except Exception as e:  # noqa: BLE001
            log.exception("apply_actions: fix_status failed for %s", pair)
            errors.append(
                {
                    "type": "fix_status",
                    "id": str(pair.get("row_id") if isinstance(pair, dict) else ""),
                    "reason": str(e),
                }
            )

    return {
        "materialized": materialized,
        "retired": retired,
        "fixed_status": fixed_status,
        "errors": errors,
    }
