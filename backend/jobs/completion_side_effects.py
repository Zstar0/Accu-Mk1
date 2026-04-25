"""Completion side-effects: coupon + SENAITE service clone.

Invoked by the ClickUp webhook dispatcher when a peptide request transitions
to `completed`. Two independent side effects fire:

  1. Issue a $250 single-use WP coupon via integration-service (always).
  2. Clone the BPC-157 SENAITE template and rename it to
     "{compound_name} - Identity (HPLC)" (peptide path only — `other` compounds
     are handled manually by the lab).

Each side effect is idempotent: re-running after a successful attempt is a
no-op (checks the `wp_coupon_code` / `senaite_service_uid` columns). On
exception, `run_all` catches per-function and writes a `*_failed_at` timestamp
so the UI and any reconciliation sweep can surface it.

In prod: wrap with retry logic (1m, 5m, 15m, 1h, 4h for coupon; 3 attempts
for SENAITE). v1 does NOT implement retry — single attempt, failed_at on
exception. Retry belongs to a follow-up task.
"""
import logging
import re
from uuid import UUID

from integration_service_client import IntegrationServiceClient
from mk1_db import get_mk1_conn
from peptide_request_config import get_config
from peptide_request_repo import PeptideRequestRepository


log = logging.getLogger(__name__)


def _new_senaite_keyword(compound_name: str) -> str:
    """Derive a SENAITE service keyword from the compound name.

    Strip non-alphanumerics, take the first 4 chars uppercased, append `-ID`.
    Falls back to `NEW-ID` if the compound_name has no alphanumerics.
    """
    alnum = re.sub(r"[^A-Za-z0-9]", "", compound_name)
    return f"{alnum[:4].upper() or 'NEW'}-ID"


def run_coupon(request_id: UUID) -> None:
    """Issue a single-use $250 WP coupon. Idempotent on `wp_coupon_code`."""
    repo = PeptideRequestRepository()
    req = repo.get_by_id(request_id)
    if not req or req.wp_coupon_code:
        return
    cfg = get_config()
    if not cfg.coupon_enabled:
        log.info(
            "coupon skipped: PEPTIDE_COUPON_ENABLED not set; "
            "no WooCommerce coupon will be issued (request %s)",
            request_id,
        )
        return
    client = IntegrationServiceClient()
    result = client.issue_coupon({
        "wp_user_id": req.submitted_by_wp_user_id,
        "amount_usd": 250,
        "peptide_request_id": str(req.id),
    })
    with get_mk1_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            UPDATE peptide_requests
            SET wp_coupon_code = %s, wp_coupon_issued_at = NOW(), updated_at = NOW()
            WHERE id = %s
        """, (result["coupon_code"], str(request_id)))
        conn.commit()
    # Data-only relay so wpstar's snapshot picks up wp_coupon_code on the
    # detail page. The coupon job runs async after the original
    # completion-transition relay already fired — without this follow-up,
    # the snapshot stays at wp_coupon_code=NULL and the "$250 coupon
    # waiting" banner has no code to display. send_email=False because the
    # completion email already fired on the original transition.
    try:
        from jobs.relay_status_to_wp import run_once as relay_run_once
        relay_run_once(
            request_id,
            new_status="completed",
            previous_status="completed",
            send_email=False,
        )
    except Exception:
        log.exception("post-coupon relay failed for %s", request_id)


def run_senaite_clone(request_id: UUID) -> None:
    """Clone the BPC-157 SENAITE template into a new Identity (HPLC) service.

    Idempotent on `senaite_service_uid`. Skips entirely for non-peptide
    compounds (`compound_kind='other'`) — those are handled manually.
    """
    repo = PeptideRequestRepository()
    req = repo.get_by_id(request_id)
    if not req or req.senaite_service_uid:
        return
    if req.compound_kind != "peptide":
        return
    cfg = get_config()
    if not cfg.senaite_clone_enabled:
        log.info(
            "senaite_clone skipped: PEPTIDE_SENAITE_CLONE_ENABLED not set; "
            "lab tech will clone the template manually (request %s)",
            request_id,
        )
        return
    client = IntegrationServiceClient()
    result = client.clone_senaite_service({
        "template_keyword": cfg.senaite_peptide_template_keyword,
        "new_name": f"{req.compound_name} - Identity (HPLC)",
        "new_keyword": _new_senaite_keyword(req.compound_name),
    })
    with get_mk1_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            UPDATE peptide_requests
            SET senaite_service_uid = %s, updated_at = NOW()
            WHERE id = %s
        """, (result["service_uid"], str(request_id)))
        conn.commit()


def run_all(request_id: UUID) -> None:
    """Run coupon and SENAITE side effects independently; isolate failures.

    Each function runs under its own try/except so one failure does not
    prevent the other from succeeding. On exception, mark the corresponding
    `*_failed_at` column so the UI / reconciliation sweep can act on it.
    """
    for label, fn, failure_col in (
        ("coupon", run_coupon, "coupon_failed_at"),
        ("senaite_clone", run_senaite_clone, "senaite_clone_failed_at"),
    ):
        try:
            fn(request_id)
        except Exception:
            log.exception("side-effect %s failed for %s", label, request_id)
            try:
                with get_mk1_conn() as conn:
                    cur = conn.cursor()
                    cur.execute(
                        f"UPDATE peptide_requests SET {failure_col} = NOW() WHERE id = %s",
                        (str(request_id),),
                    )
                    conn.commit()
            except Exception:
                log.exception(
                    "failed to mark %s for %s", failure_col, request_id
                )
