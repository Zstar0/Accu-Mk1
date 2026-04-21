"""ClickUp webhook dispatcher for peptide_requests.

Subscribed events (webhook id 6bd2e887-303c-4bbe-b458-17bfd3b03c91):
  - taskCreated         — materialize a row from a lab-tech-created task
  - taskStatusUpdated   — map ClickUp column -> internal status, log + relay
  - taskAssigneeUpdated — track assignees on the peptide_requests row
  - taskDeleted         — retire the row (preserve history)
  - taskUpdated         — custom-field drift sync (this module's newest
                          branch; see _handle_task_updated). Subscription
                          is performed OUT-OF-BAND via a PUT to
                          api.clickup.com/api/v2/webhook/{id} after code
                          deploy so we never receive events we can't yet
                          handle.

Change-management rule: the subscription list and the dispatch switch
must stay in lockstep. Add a branch here FIRST, deploy, then update
the subscription — not the other way around.
"""
import hmac
import hashlib
import logging
import os
from uuid import UUID

from pydantic import ValidationError, EmailStr, TypeAdapter

from clickup_client import ClickUpClient
from clickup_user_mapping_repo import ClickUpUserMappingRepository
from jobs.relay_status_to_wp import run_once as relay_run_once
from peptide_request_config import PeptideRequestConfig
from peptide_request_repo import PeptideRequestRepository
from status_log_repo import StatusLogRepository


# Pre-built validator for the EmailStr check in taskUpdated. Reusing a
# TypeAdapter avoids spinning up a one-off model on every event and
# keeps the error path (ValidationError) identical to the WP-submission
# path, which is what the downstream logging assumes.
_EMAIL_VALIDATOR = TypeAdapter(EmailStr)


log = logging.getLogger(__name__)


def verify_signature(raw_body: bytes, provided_sig: str | None, secret: str) -> bool:
    if not provided_sig:
        return False
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, provided_sig)


def dispatch_event(
    payload: dict,
    cfg: PeptideRequestConfig,
    prepo: PeptideRequestRepository,
    lrepo: StatusLogRepository,
    urepo: ClickUpUserMappingRepository,
) -> None:
    """Route a verified ClickUp webhook payload to the appropriate handler.

    Shape assumptions (per ClickUp v2 webhook docs):
      payload["event"]         — event name (e.g. "taskStatusUpdated")
      payload["task_id"]       — ClickUp task id
      payload["history_items"] — list of change records (status updates)
      payload["assignees"]     — list of assignees (taskAssigneeUpdated)
    """
    event = payload.get("event")
    task_id = payload.get("task_id")
    if not task_id:
        return

    # taskCreated is the one branch that INTENTIONALLY handles unknown
    # task ids — its whole job is to materialize a row for a task we've
    # never seen before. Every other branch requires an existing row,
    # so resolve + bail here for them.
    if event == "taskCreated":
        _handle_task_created(task_id, payload, cfg, prepo, lrepo, urepo)
        return

    req = prepo.get_by_clickup_task_id(task_id)
    if not req:
        log.warning("Webhook for unknown clickup_task_id=%s", task_id)
        return
    history_items = payload.get("history_items", [])

    if event == "taskStatusUpdated":
        if not history_items:
            return
        hi = history_items[0]
        event_id = hi.get("id")
        after_status = (hi.get("after") or {}).get("status")
        user = hi.get("user") or {}
        actor_mapping = (
            urepo.upsert(
                clickup_user_id=user.get("id", "unknown"),
                clickup_username=user.get("username", ""),
                clickup_email=user.get("email"),
            )
            if user.get("id")
            else None
        )

        mapped = cfg.map_column_to_status(after_status or "")
        if not mapped:
            # Unmapped columns do NOT fail the webhook — log ERROR and bail.
            # TODO: fire admin alert once notification plumbing exists.
            log.error("UNMAPPED CLICKUP COLUMN: %r (task=%s)", after_status, task_id)
            return

        prev = req.status
        # on_hold is special: preserve the prior status so leaving on_hold can
        # restore it. All other transitions clear previous_status implicitly.
        if mapped == "on_hold" and req.status != "on_hold":
            prepo.update_status(req.id, new_status=mapped, previous_status=prev)
        else:
            prepo.update_status(req.id, new_status=mapped)

        inserted = lrepo.append(
            peptide_request_id=req.id,
            from_status=prev,
            to_status=mapped,
            source="clickup",
            clickup_event_id=event_id,
            actor_clickup_user_id=user.get("id"),
            actor_accumk1_user_id=(
                actor_mapping.accumk1_user_id if actor_mapping else None
            ),
            note=hi.get("comment"),
        )
        if not inserted:
            # Duplicate clickup_event_id — short-circuit any downstream jobs.
            return
        if mapped in ("approved", "rejected", "completed"):
            enqueue_relay_status_to_wp(req.id, new_status=mapped, previous_status=prev)
        if mapped == "completed":
            enqueue_completion_side_effects(req.id)

    elif event == "taskAssigneeUpdated":
        assignees = payload.get("assignees", [])
        assignee_ids = [a["id"] for a in assignees if "id" in a]
        prepo.set_assignees(req.id, assignee_ids)

    elif event == "taskDeleted":
        # Retire-on-delete: the tech deleted the ClickUp task, but the
        # Accu-Mk1 row is the source of truth — we don't cascade the
        # delete. Stamp retired_at and log audit entry. Silent from the
        # customer's perspective (no WP relay, no coupon, no SENAITE).
        if req.retired_at is not None:
            # Already retired — ClickUp may re-deliver the event. No-op.
            return
        updated = prepo.mark_retired(req.id)
        if updated is None:
            # Race: another handler retired between get_by_clickup_task_id
            # and mark_retired. Treat as no-op.
            return
        # Audit log. to_status mirrors current status — no workflow
        # transition occurred; the `note` carries the semantic signal.
        user = payload.get("user") or {}
        lrepo.append(
            peptide_request_id=req.id,
            from_status=req.status,
            to_status=req.status,
            source="clickup",
            clickup_event_id=payload.get("event_id"),
            actor_clickup_user_id=(
                str(user.get("id")) if user.get("id") else None
            ),
            actor_accumk1_user_id=None,
            note="Task deleted in ClickUp — retired",
        )

    elif event == "taskUpdated":
        _handle_task_updated(req, history_items, cfg, prepo, lrepo)

    else:
        # Unknown / unhandled event. 200 OK, no action.
        return


def _handle_task_updated(
    req,
    history_items: list,
    cfg: PeptideRequestConfig,
    prepo: PeptideRequestRepository,
    lrepo: StatusLogRepository,
) -> None:
    """Apply custom-field drift from a ClickUp taskUpdated event.

    Scope:
      * Each ``history_items`` entry describes ONE field change. ClickUp
        batches multiple changes into a single event, so a customer
        editing three fields in ClickUp arrives here as one event with
        three items.
      * ``field`` may be a plain name ("name", "status") OR a custom
        field UUID. We route by shape:
          - "name"       -> log INFO, don't touch DB (name format
                            "[kind] X — Y" is fragile; DB->ClickUp
                            only per HANDOFF).
          - "status"     -> skip entirely. taskStatusUpdated fires
                            separately and is the source of truth for
                            status transitions; processing it here
                            would double-write status_log and
                            double-fire relay_status_to_wp.
          - custom UUID  -> reverse-map via cfg.custom_field_id_to_column,
                            extract the `after` value, apply.
          - anything else -> DEBUG + skip.
      * Dedup per history_item id: status_log has a partial unique
        index on clickup_event_id; we check that before applying to
        avoid a redundant UPDATE on a re-delivered event.
      * One status_log row per distinct history_item we actually
        applied. ``from_status == to_status == req.status`` — these
        aren't transitions, they're audit markers that a field
        changed. The `note` names the field(s).

    Does NOT enqueue WP relay or completion side effects: field
    updates are orthogonal to customer milestones (those fire on
    status transitions only).
    """
    if not history_items:
        return

    # Collect successful field applies in a single UPDATE per history
    # item (usually just one field per item, but the shape allows
    # multiple values to land on the same row — we take the last one
    # wins per item). Re-look-up the row after each apply so the next
    # iteration sees fresh state — matters if two history items in the
    # same payload touch the same column.
    for hi in history_items:
        event_id = hi.get("id")
        field = hi.get("field") or ""

        # Status is handled by taskStatusUpdated; skipping here is
        # critical — otherwise we'd double-process.
        if field == "status":
            continue

        if field == "name":
            before = (hi.get("before") or {}).get("title") if isinstance(hi.get("before"), dict) else hi.get("before")
            after = (hi.get("after") or {}).get("title") if isinstance(hi.get("after"), dict) else hi.get("after")
            log.info(
                "taskUpdated: name change on task %s (%r -> %r) — not syncing to DB",
                req.clickup_task_id, before, after,
            )
            continue

        # Dedup BEFORE the apply: if the status_log already has a row
        # with this event id, someone (us, a prior delivery) already
        # processed it. Skipping the DB write avoids the updated_at
        # bump, which matters for diff noise.
        if event_id and _already_processed(lrepo, req.id, event_id):
            log.debug("taskUpdated: history_item %s already processed", event_id)
            continue

        column = cfg.custom_field_id_to_column(field)
        if column is None:
            # Not a field we sync, not an error.
            log.debug("taskUpdated: ignoring unmapped field %r on task %s",
                      field, req.clickup_task_id)
            continue

        raw_after = hi.get("after")
        value = _extract_field_value(column, raw_after, cfg)
        if value is _SKIP_FIELD:
            # Specific reasons are logged inside _extract_field_value.
            continue

        try:
            prepo.update_fields(req.id, **{column: value})
        except ValueError:
            log.exception(
                "taskUpdated: update_fields rejected column %r for task %s",
                column, req.clickup_task_id,
            )
            continue

        # Append the audit entry. Dedup is defense-in-depth — the
        # _already_processed check above is the primary gate, but if
        # the payload carries duplicate history_items in a single call
        # (not observed in the wild, but allowed by the schema) the
        # partial unique index catches it.
        lrepo.append(
            peptide_request_id=req.id,
            from_status=req.status,
            to_status=req.status,
            source="clickup",
            clickup_event_id=event_id,
            actor_clickup_user_id=(
                str((hi.get("user") or {}).get("id"))
                if (hi.get("user") or {}).get("id")
                else None
            ),
            actor_accumk1_user_id=None,
            note=f"Field updated via taskUpdated: {column}",
        )


# Sentinel used by _extract_field_value to distinguish "skip this field
# for non-value reasons" (validation failed, unresolvable option, etc.)
# from "the tech cleared the field to None" which is a legitimate
# write. A plain None return would collapse the two.
_SKIP_FIELD = object()


def _extract_field_value(column: str, raw_after, cfg: PeptideRequestConfig):
    """Convert a ClickUp `after` payload into the value to write.

    compound_kind arrives as a dropdown option UUID (or a list containing
    one); all other fields are plain string values. Email values go
    through Pydantic EmailStr; invalid emails return _SKIP_FIELD so
    the caller bypasses the apply without aborting the event.
    """
    if column == "compound_kind":
        option_id = raw_after
        # ClickUp dropdown payloads sometimes wrap the option id in a
        # list, and sometimes deliver it as a dict with orderindex+id.
        # Handle both shapes defensively.
        if isinstance(option_id, list):
            option_id = option_id[0] if option_id else ""
        if isinstance(option_id, dict):
            option_id = option_id.get("id") or option_id.get("orderindex") or ""
        resolved = cfg.compound_kind_option_to_value(str(option_id) if option_id else "")
        if resolved is None:
            log.warning(
                "taskUpdated: unresolvable compound_kind option %r — skipping field",
                option_id,
            )
            return _SKIP_FIELD
        return resolved

    if column == "submitted_by_email":
        # Accept None/""/missing as clear-to-empty; reject invalid format.
        if raw_after is None or raw_after == "":
            return None
        try:
            _EMAIL_VALIDATOR.validate_python(raw_after)
        except ValidationError:
            log.warning(
                "taskUpdated: invalid email %r — skipping field",
                raw_after,
            )
            return _SKIP_FIELD
        return raw_after

    # Plain-string fields: sample_id, cas_or_reference, vendor_producer.
    # None / empty string collapse to None for the DB so the column
    # actually clears rather than storing "".
    if raw_after is None or raw_after == "":
        return None
    return str(raw_after)


def _already_processed(lrepo: StatusLogRepository, request_id, event_id: str) -> bool:
    """Return True if a status_log row with this clickup_event_id already
    exists for this request. Uses the existing get_for_request read
    rather than a dedicated SELECT — keeps the dedup logic in-Python and
    avoids a schema migration for a secondary index. History is bounded
    (status transitions + field updates per request) so the linear scan
    is cheap enough for webhook-scale traffic."""
    if not event_id:
        return False
    for entry in lrepo.get_for_request(request_id):
        if entry.clickup_event_id == event_id:
            return True
    return False


def _handle_task_created(
    task_id: str,
    payload: dict,
    cfg: PeptideRequestConfig,
    prepo: PeptideRequestRepository,
    lrepo: StatusLogRepository,
    urepo: ClickUpUserMappingRepository,
) -> None:
    """Materialize a peptide_requests row from a lab-tech-created ClickUp task.

    Flow:
      1. Idempotency gate: if we already have a row for this task id,
         this is either our OWN create (webhook fires for WP-submitted
         rows too) or a ClickUp re-delivery. Either way: silent return.
      2. Fetch the task detail via ClickUp REST (webhook payload is thin).
      3. Map the ClickUp column to our internal status. Unmapped -> log
         ERROR and bail. We refuse to insert a stub row with a bogus
         status; the tech should fix the column mapping or rename the
         ClickUp column.
      4. Upsert the creator's user mapping (mirrors taskStatusUpdated).
      5. Insert the peptide_requests row with source='manual'.
      6. Append a status_log entry for audit trail.
    """
    existing = prepo.get_by_clickup_task_id(task_id)
    if existing is not None:
        # Our own create, or a re-delivery — nothing to do.
        return

    client = ClickUpClient(
        api_token=cfg.clickup_api_token,
        list_id=cfg.clickup_list_id,
        accumk1_base_url=os.environ.get(
            "ACCUMK1_BASE_URL", "https://accumk1.accumarklabs.com"
        ),
    )
    task = client.get_task(task_id)

    status_obj = task.get("status") or {}
    column_name = status_obj.get("status") or ""
    mapped = cfg.map_column_to_status(column_name)
    if not mapped:
        # Refuse to insert a stub with a bogus status. Mirrors the
        # taskStatusUpdated branch's unmapped-column policy.
        # TODO: admin alert once notification plumbing exists.
        log.error(
            "UNMAPPED CLICKUP COLUMN on taskCreated: %r (task=%s)",
            column_name, task_id,
        )
        return

    creator = task.get("creator") or {}
    actor_mapping = None
    if creator.get("id"):
        actor_mapping = urepo.upsert(
            clickup_user_id=str(creator.get("id")),
            clickup_username=creator.get("username", ""),
            clickup_email=creator.get("email"),
        )

    req = prepo.create_from_clickup_task(
        task_dict=task,
        mapped_status=mapped,
        clickup_task_id=task_id,
        clickup_list_id=cfg.clickup_list_id,
    )

    # Audit trail. clickup_event_id is best-effort from the webhook
    # payload — taskCreated doesn't always carry a history_items entry,
    # but some ClickUp deliveries include a top-level `event_id`.
    event_id = payload.get("event_id")
    lrepo.append(
        peptide_request_id=req.id,
        from_status=None,
        to_status=mapped,
        source="clickup",
        clickup_event_id=event_id,
        actor_clickup_user_id=str(creator.get("id")) if creator.get("id") else None,
        actor_accumk1_user_id=(
            actor_mapping.accumk1_user_id if actor_mapping else None
        ),
        note="Manual task created in ClickUp",
    )


def enqueue_relay_status_to_wp(
    request_id: UUID, new_status: str, previous_status: str | None
) -> None:
    """Schedule a background relay of this status change to WP.

    Accu-Mk1 does not have a general-purpose job queue (no Celery, APScheduler,
    or worker pool today — see file_watcher.py / scale_agent.py). We use a
    daemon thread to match the lightweight concurrency model already in the
    codebase. Retry is best-effort with exponential-ish backoff; after all
    attempts fail we mark the row with wp_relay_failed_at so the UI and any
    future reconciliation sweep can surface it.
    """
    import threading
    threading.Thread(
        target=_relay_with_retry,
        args=(request_id, new_status, previous_status),
        daemon=True,
    ).start()


def _relay_with_retry(
    request_id: UUID, new_status: str, previous_status: str | None
) -> None:
    import time
    delays = [60, 300, 900, 3600, 14400]
    for i, delay in enumerate([0, *delays]):
        if delay:
            time.sleep(delay)
        try:
            relay_run_once(
                request_id,
                new_status=new_status,
                previous_status=previous_status,
            )
            return
        except Exception as e:
            log.warning("relay attempt %d failed: %s", i + 1, e)
    # All retries exhausted — mark the row for admin attention.
    from mk1_db import get_mk1_conn
    try:
        with get_mk1_conn() as conn:
            cur = conn.cursor()
            cur.execute(
                "UPDATE peptide_requests SET wp_relay_failed_at = NOW() WHERE id = %s",
                (str(request_id),),
            )
            conn.commit()
    except Exception as e:
        log.error("failed to mark wp_relay_failed_at for %s: %s", request_id, e)


def enqueue_completion_side_effects(request_id: UUID) -> None:
    """Schedule coupon + SENAITE side effects in a background daemon thread.

    Mirrors the lightweight concurrency model used by enqueue_relay_status_to_wp
    (no job queue in v1). `run_all` catches per-function failures and writes a
    `*_failed_at` timestamp so the UI can surface them.
    """
    import threading
    from jobs.completion_side_effects import run_all
    threading.Thread(target=run_all, args=(request_id,), daemon=True).start()
