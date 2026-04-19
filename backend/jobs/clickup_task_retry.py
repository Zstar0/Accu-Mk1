"""Retry ClickUp task creation for requests where initial attempt failed.

The POST /api/peptide-requests handler makes a best-effort inline ClickUp
create after persisting the row. If that inline attempt fails (ClickUp
unreachable, 5xx, rate limit, etc.), the row is left with
`clickup_task_id = NULL`. This job sweeps those stuck rows and retries.

After 24h of continuous failure, the row is marked
`clickup_create_failed_at = NOW()` so the UI / reconciliation sweep can
surface it for human intervention — and so this job stops retrying it
(find_needing_clickup_create filters on `clickup_create_failed_at IS NULL`).

Scheduling: Accu-Mk1 v1 has no general-purpose job queue or periodic
scheduler (no Celery, APScheduler, cron). `run_once()` is exposed as an
importable, manually-invokable entrypoint. Operators can wire it to cron
or a future periodic thread. The main protection for the hot path is the
inline best-effort create on POST — this job is the safety net for the
tail of transient failures.
"""
import logging
import os

from backend.clickup_client import ClickUpClient
from backend.mk1_db import get_mk1_conn
from backend.peptide_request_config import get_config
from backend.peptide_request_repo import PeptideRequestRepository


log = logging.getLogger(__name__)


def run_once() -> None:
    """Sweep rows needing ClickUp task creation and retry them.

    For each row with `clickup_task_id IS NULL`, `clickup_create_failed_at
    IS NULL`, and `created_at` older than 60 seconds (avoiding races with
    the inline POST attempt), call ClickUp. On success, write the task id.
    On failure, if the row is > 24h old, terminally mark
    `clickup_create_failed_at = NOW()` so this job stops retrying it.
    """
    repo = PeptideRequestRepository()
    cfg = get_config()
    client = ClickUpClient(
        api_token=cfg.clickup_api_token,
        list_id=cfg.clickup_list_id,
        accumk1_base_url=os.environ.get(
            "ACCUMK1_BASE_URL", "https://accumk1.accumarklabs.com"
        ),
    )
    for req in repo.find_needing_clickup_create():
        try:
            task_id = client.create_task_for_request(req)
            repo.update_clickup_task_id(req.id, task_id)
        except Exception:
            log.exception("retry create clickup failed for %s", req.id)
            # After 24h of attempts, mark as terminally failed so the
            # find_needing_clickup_create filter skips it going forward.
            try:
                with get_mk1_conn() as conn:
                    cur = conn.cursor()
                    cur.execute(
                        """
                        UPDATE peptide_requests
                        SET clickup_create_failed_at = NOW()
                        WHERE id = %s
                          AND created_at < NOW() - INTERVAL '24 hours'
                        """,
                        (str(req.id),),
                    )
                    conn.commit()
            except Exception:
                log.exception(
                    "failed to mark clickup_create_failed_at for %s", req.id
                )
