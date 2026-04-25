"""Background job: relay a peptide-request status change to WordPress.

Invoked by the ClickUp webhook dispatcher after Approved / Rejected /
Completed transitions (plus any non-email-triggering transitions that still
warrant a WP sync). Forwards the event to integration-service, which owns
customer-facing email and the WP-side request row.

`EMAIL_TRIGGER_STATUSES` controls whether integration-service sends a
customer notification — all other statuses relay silently.
"""
from uuid import UUID
from peptide_request_repo import PeptideRequestRepository
from integration_service_client import IntegrationServiceClient


EMAIL_TRIGGER_STATUSES = {"approved", "rejected", "completed"}


def run_once(
    request_id: UUID,
    *,
    new_status: str,
    previous_status: str | None,
    send_email: bool | None = None,
) -> None:
    """Forward a status change (or a data-only refresh) to wpstar via int-svc.

    `send_email` defaults to True for approved/rejected/completed transitions
    and False otherwise. Pass `send_email=False` explicitly when running a
    data-only relay (e.g. backfilling `wp_coupon_code` after the coupon job
    lands post-completion) so the customer doesn't get a duplicate email.
    """
    repo = PeptideRequestRepository()
    req = repo.get_by_id(request_id)
    if not req:
        return
    if send_email is None:
        send_email = new_status in EMAIL_TRIGGER_STATUSES
    payload = {
        "peptide_request_id": str(req.id),
        "wp_user_id": req.submitted_by_wp_user_id,
        "new_status": new_status,
        "previous_status": previous_status,
        "rejection_reason": req.rejection_reason,
        "compound_name": req.compound_name,
        "wp_coupon_code": req.wp_coupon_code,
        "send_email": send_email,
    }
    client = IntegrationServiceClient()
    client.relay_peptide_request_status(payload)
