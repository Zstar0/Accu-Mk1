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

from pydantic import EmailStr, TypeAdapter, ValidationError

from clickup_client import ClickUpClient
from clickup_user_mapping_repo import ClickUpUserMappingRepository
from peptide_request_config import PeptideRequestConfig
from peptide_request_repo import PeptideRequestRepository
from status_log_repo import StatusLogRepository


log = logging.getLogger(__name__)


# Fields we sync bidirectionally. Order here controls the default
# iteration order in compute_diff (stable, deterministic output).
# Mirrors repo.PeptideRequestRepository._UPDATE_FIELDS_WHITELIST.
_BIDIRECTIONAL_FIELDS: tuple[str, ...] = (
    "sample_id",
    "compound_kind",
    "cas_or_reference",
    "vendor_producer",
    "submitted_by_email",
)


_EMAIL_VALIDATOR = TypeAdapter(EmailStr)


def _extract_clickup_field_value(
    task: dict, field_id: str
) -> Optional[str]:
    """Pull a custom-field value out of a ClickUp task dict.

    ClickUp v2 task payloads carry ``custom_fields`` as a list of
    ``{"id": ..., "value": ...}`` entries. Missing / absent entries
    collapse to None (treated as "empty" by the drift comparator).

    Dropdown fields put the selected option id in ``value`` directly
    (a string). We return it as-is — compound_kind handling above the
    string layer resolves option UUID to column value.
    """
    if not field_id:
        return None
    for f in task.get("custom_fields") or []:
        if f.get("id") != field_id:
            continue
        val = f.get("value")
        if val is None:
            return None
        # ClickUp sometimes returns a dict / list for dropdowns. We
        # pass scalars through; callers handle dropdown-specific
        # resolution.
        return val
    return None


def _normalize_for_compare(v) -> str:
    """Collapse None and '' to the same bucket so rows where both
    sides are empty aren't flagged as drift."""
    if v is None:
        return ""
    return str(v)


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
    field_drift: list[dict] = []

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

        # Bucket 4: per-field drift across the 5 bidirectional-sync
        # columns. Runs independently of status_mismatch — a row can
        # have both status AND field drift. We iterate the fixed field
        # order so output is deterministic.
        field_drift.extend(_compute_field_drift(r, t, cfg))

    return {
        "in_clickup_not_mk1": in_clickup_not_mk1,
        "in_mk1_not_clickup": in_mk1_not_clickup,
        "status_mismatch": status_mismatch,
        "field_drift": field_drift,
    }


def _compute_field_drift(row, task: dict, cfg: PeptideRequestConfig) -> list[dict]:
    """Emit one drift item per field that differs between DB and ClickUp.

    Rules (see HANDOFF_PEPTIDE_REQUEST.md):
      * Both sides 'empty' (None / '') -> NOT drift.
      * compound_kind: resolve the ClickUp option UUID to
        'peptide'/'other' via cfg. Unresolvable option -> SKIP this
        field for this row (not surfaced as drift; we can't safely
        apply it either direction).
      * submitted_by_email: if the ClickUp value fails EmailStr
        validation, SKIP (don't surface drift we can't safely
        resolve). Empty/None ClickUp values are still compared (they
        represent 'cleared').
      * All other fields: straight normalized-string comparison.
    """
    field_to_id = {
        "sample_id":          cfg.clickup_field_sample_id,
        "compound_kind":      cfg.clickup_field_compound_kind,
        "cas_or_reference":   cfg.clickup_field_cas,
        "vendor_producer":    cfg.clickup_field_vendor_producer,
        "submitted_by_email": cfg.clickup_field_customer_email,
    }
    out: list[dict] = []

    for field in _BIDIRECTIONAL_FIELDS:
        field_id = field_to_id.get(field) or ""
        # Unconfigured field id (env not set) — skip silently. The
        # sync feature is already graceful-degrade on missing custom
        # fields at create time (see ClickUpClient._build_custom_fields).
        if not field_id:
            continue

        db_value = getattr(row, field, None)
        cu_raw = _extract_clickup_field_value(task, field_id)

        if field == "compound_kind":
            resolved = None
            # compound_kind may arrive as a raw string OR a list
            # containing the option id; defensively flatten.
            if isinstance(cu_raw, list):
                cu_raw_scalar = cu_raw[0] if cu_raw else ""
            elif isinstance(cu_raw, dict):
                cu_raw_scalar = cu_raw.get("id") or ""
            else:
                cu_raw_scalar = cu_raw
            if cu_raw_scalar:
                resolved = cfg.compound_kind_option_to_value(str(cu_raw_scalar))
            if cu_raw_scalar and resolved is None:
                # Unresolvable — skip this field for this pair.
                log.warning(
                    "field_drift: unresolvable compound_kind option %r for task %s",
                    cu_raw_scalar,
                    row.clickup_task_id,
                )
                continue
            cu_value_for_compare = resolved
        elif field == "submitted_by_email":
            # Invalid email -> skip (can't safely resolve).
            if cu_raw not in (None, ""):
                try:
                    _EMAIL_VALIDATOR.validate_python(cu_raw)
                except ValidationError:
                    log.warning(
                        "field_drift: invalid email %r for task %s — skipping",
                        cu_raw,
                        row.clickup_task_id,
                    )
                    continue
            cu_value_for_compare = cu_raw
        else:
            cu_value_for_compare = cu_raw

        if _normalize_for_compare(db_value) == _normalize_for_compare(cu_value_for_compare):
            continue

        out.append(
            {
                "row_id": str(row.id),
                "task_id": row.clickup_task_id,
                "compound_name": row.compound_name,
                "field": field,
                "db_value": db_value if db_value is not None else None,
                "clickup_value": cu_value_for_compare
                if cu_value_for_compare not in (None, "")
                else None,
            }
        )
    return out


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
    field_drift_resolved = 0

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

    for item in actions.get("resolve_field_drift", []) or []:
        try:
            raw_row_id = item.get("row_id") if isinstance(item, dict) else item.row_id
            field = item.get("field") if isinstance(item, dict) else item.field
            value_to_use = (
                item.get("value_to_use")
                if isinstance(item, dict)
                else item.value_to_use
            )
            row_uuid = (
                raw_row_id if isinstance(raw_row_id, UUID) else UUID(str(raw_row_id))
            )

            # Whitelist field up front so ValueError from update_fields
            # surfaces as a user-facing reason rather than a 500.
            if field not in PeptideRequestRepository._UPDATE_FIELDS_WHITELIST:
                errors.append(
                    {
                        "type": "field_drift",
                        "id": f"{raw_row_id}/{field}",
                        "reason": f"unsupported field {field!r}",
                    }
                )
                continue
            if value_to_use not in ("db", "clickup"):
                errors.append(
                    {
                        "type": "field_drift",
                        "id": f"{raw_row_id}/{field}",
                        "reason": (
                            f"value_to_use must be 'db' or 'clickup', got {value_to_use!r}"
                        ),
                    }
                )
                continue

            # Re-fetch both sides — diff may have been stale by the
            # time the tech clicked Apply.
            row = prepo.get_by_id(row_uuid)
            if row is None:
                errors.append(
                    {
                        "type": "field_drift",
                        "id": f"{raw_row_id}/{field}",
                        "reason": "row not found",
                    }
                )
                continue
            task_id = row.clickup_task_id
            if not task_id:
                errors.append(
                    {
                        "type": "field_drift",
                        "id": f"{raw_row_id}/{field}",
                        "reason": "row has no clickup_task_id",
                    }
                )
                continue
            fresh_task = client.get_task(task_id)

            if value_to_use == "db":
                db_value = getattr(row, field, None)
                field_id_map = {
                    "sample_id":          cfg.clickup_field_sample_id,
                    "compound_kind":      cfg.clickup_field_compound_kind,
                    "cas_or_reference":   cfg.clickup_field_cas,
                    "vendor_producer":    cfg.clickup_field_vendor_producer,
                    "submitted_by_email": cfg.clickup_field_customer_email,
                }
                field_id = field_id_map.get(field) or ""
                if not field_id:
                    errors.append(
                        {
                            "type": "field_drift",
                            "id": f"{raw_row_id}/{field}",
                            "reason": f"no clickup field id configured for {field}",
                        }
                    )
                    continue
                if field == "compound_kind":
                    # Translate column value -> option UUID.
                    if db_value == "peptide":
                        option_id = cfg.clickup_opt_compound_kind_peptide
                    elif db_value == "other":
                        option_id = cfg.clickup_opt_compound_kind_other
                    else:
                        errors.append(
                            {
                                "type": "field_drift",
                                "id": f"{raw_row_id}/{field}",
                                "reason": f"unmapped compound_kind value {db_value!r}",
                            }
                        )
                        continue
                    if not option_id:
                        errors.append(
                            {
                                "type": "field_drift",
                                "id": f"{raw_row_id}/{field}",
                                "reason": (
                                    f"no option UUID configured for compound_kind={db_value!r}"
                                ),
                            }
                        )
                        continue
                    client.set_custom_field(task_id, field_id, option_id)
                else:
                    # ClickUp accepts "" to clear string fields.
                    client.set_custom_field(
                        task_id, field_id,
                        db_value if db_value is not None else "",
                    )
            else:  # value_to_use == "clickup"
                field_id_map = {
                    "sample_id":          cfg.clickup_field_sample_id,
                    "compound_kind":      cfg.clickup_field_compound_kind,
                    "cas_or_reference":   cfg.clickup_field_cas,
                    "vendor_producer":    cfg.clickup_field_vendor_producer,
                    "submitted_by_email": cfg.clickup_field_customer_email,
                }
                field_id = field_id_map.get(field) or ""
                cu_raw = _extract_clickup_field_value(fresh_task, field_id)
                if field == "compound_kind":
                    option_id_scalar = cu_raw
                    if isinstance(option_id_scalar, list):
                        option_id_scalar = (
                            option_id_scalar[0] if option_id_scalar else ""
                        )
                    if isinstance(option_id_scalar, dict):
                        option_id_scalar = option_id_scalar.get("id") or ""
                    resolved = cfg.compound_kind_option_to_value(
                        str(option_id_scalar) if option_id_scalar else ""
                    )
                    if resolved is None:
                        errors.append(
                            {
                                "type": "field_drift",
                                "id": f"{raw_row_id}/{field}",
                                "reason": "unresolvable compound_kind option",
                            }
                        )
                        continue
                    prepo.update_fields(row_uuid, compound_kind=resolved)
                elif field == "submitted_by_email":
                    if cu_raw in (None, ""):
                        prepo.update_fields(row_uuid, submitted_by_email=None)
                    else:
                        try:
                            _EMAIL_VALIDATOR.validate_python(cu_raw)
                        except ValidationError:
                            errors.append(
                                {
                                    "type": "field_drift",
                                    "id": f"{raw_row_id}/{field}",
                                    "reason": f"invalid email {cu_raw!r}",
                                }
                            )
                            continue
                        prepo.update_fields(row_uuid, submitted_by_email=cu_raw)
                else:
                    prepo.update_fields(
                        row_uuid,
                        **{field: cu_raw if cu_raw not in (None, "") else None},
                    )

            field_drift_resolved += 1
        except Exception as e:  # noqa: BLE001
            log.exception("apply_actions: field_drift failed for %s", item)
            errors.append(
                {
                    "type": "field_drift",
                    "id": str(
                        item.get("row_id") if isinstance(item, dict) else ""
                    ),
                    "reason": str(e),
                }
            )

    return {
        "materialized": materialized,
        "retired": retired,
        "fixed_status": fixed_status,
        "field_drift_resolved": field_drift_resolved,
        "errors": errors,
    }
