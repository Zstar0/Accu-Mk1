import hmac
import hashlib
import logging
from uuid import UUID

from backend.clickup_user_mapping_repo import ClickUpUserMappingRepository
from backend.peptide_request_config import PeptideRequestConfig
from backend.peptide_request_repo import PeptideRequestRepository
from backend.status_log_repo import StatusLogRepository


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
            enqueue_relay_status_to_wp(req.id)
        if mapped == "completed":
            enqueue_completion_side_effects(req.id)

    elif event == "taskAssigneeUpdated":
        assignees = payload.get("assignees", [])
        assignee_ids = [a["id"] for a in assignees if "id" in a]
        prepo.set_assignees(req.id, assignee_ids)

    else:
        # Unknown / unhandled event. 200 OK, no action.
        return


def enqueue_relay_status_to_wp(request_id: UUID) -> None:
    """Stub — Task 13 will implement the WP relay background job."""
    pass


def enqueue_completion_side_effects(request_id: UUID) -> None:
    """Stub — Task 14 will implement coupon + SENAITE side effects."""
    pass
