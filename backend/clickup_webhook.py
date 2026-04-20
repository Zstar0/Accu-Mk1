import hmac
import hashlib
import logging
from uuid import UUID

from clickup_user_mapping_repo import ClickUpUserMappingRepository
from jobs.relay_status_to_wp import run_once as relay_run_once
from peptide_request_config import PeptideRequestConfig
from peptide_request_repo import PeptideRequestRepository
from status_log_repo import StatusLogRepository


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

    else:
        # Unknown / unhandled event. 200 OK, no action.
        return


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
