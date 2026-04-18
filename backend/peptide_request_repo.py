"""Repository layer for peptide_requests."""
import json
from typing import Optional
from uuid import UUID

from psycopg2.extras import RealDictCursor

from backend.mk1_db import get_mk1_conn
from backend.models_peptide_request import PeptideRequest, PeptideRequestCreate


def _row_to_model(row: dict) -> PeptideRequest:
    return PeptideRequest(**row)


class PeptideRequestRepository:
    def create(
        self,
        data: PeptideRequestCreate,
        *,
        idempotency_key: str,
        clickup_list_id: str,
    ) -> PeptideRequest:
        """Insert a new request. Returns existing row if (wp_user_id, idempotency_key)
        already exists. Race-safe via INSERT ... ON CONFLICT DO NOTHING."""
        with get_mk1_conn() as conn:
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute("""
                INSERT INTO peptide_requests (
                    idempotency_key, submitted_by_wp_user_id,
                    submitted_by_email, submitted_by_name,
                    compound_kind, compound_name, vendor_producer,
                    sequence_or_structure, molecular_weight, cas_or_reference,
                    vendor_catalog_number, reason_notes, expected_monthly_volume,
                    clickup_list_id
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                )
                ON CONFLICT (submitted_by_wp_user_id, idempotency_key) DO NOTHING
                RETURNING *
            """, (
                idempotency_key, data.submitted_by_wp_user_id,
                data.submitted_by_email, data.submitted_by_name,
                data.compound_kind, data.compound_name, data.vendor_producer,
                data.sequence_or_structure, data.molecular_weight, data.cas_or_reference,
                data.vendor_catalog_number, data.reason_notes, data.expected_monthly_volume,
                clickup_list_id,
            ))
            row = cur.fetchone()
            if row is None:
                # Conflict hit — another concurrent insert won. Return the existing row.
                cur.execute("""
                    SELECT * FROM peptide_requests
                    WHERE submitted_by_wp_user_id = %s AND idempotency_key = %s
                """, (data.submitted_by_wp_user_id, idempotency_key))
                row = cur.fetchone()
            conn.commit()
            return _row_to_model(dict(row))

    def get_by_id(self, request_id: UUID) -> Optional[PeptideRequest]:
        with get_mk1_conn() as conn:
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute("SELECT * FROM peptide_requests WHERE id = %s", (str(request_id),))
            row = cur.fetchone()
            return _row_to_model(dict(row)) if row else None

    def get_by_clickup_task_id(self, task_id: str) -> Optional[PeptideRequest]:
        """Lookup a peptide request by its ClickUp task id. Used by the webhook
        dispatcher to resolve inbound events back to the owning row."""
        with get_mk1_conn() as conn:
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute(
                "SELECT * FROM peptide_requests WHERE clickup_task_id = %s",
                (task_id,),
            )
            row = cur.fetchone()
            return _row_to_model(dict(row)) if row else None

    def list_by_wp_user(
        self, wp_user_id: int, *, status: Optional[list[str]] = None,
        limit: int = 50, offset: int = 0,
    ) -> tuple[list[PeptideRequest], int]:
        with get_mk1_conn() as conn:
            cur = conn.cursor(cursor_factory=RealDictCursor)
            where = ["submitted_by_wp_user_id = %s"]
            params: list = [wp_user_id]
            if status:
                where.append(f"status = ANY(%s)")
                params.append(status)
            where_sql = " AND ".join(where)
            cur.execute(f"SELECT COUNT(*) AS count FROM peptide_requests WHERE {where_sql}", params)
            total = cur.fetchone()["count"]
            cur.execute(f"""
                SELECT * FROM peptide_requests WHERE {where_sql}
                ORDER BY created_at DESC LIMIT %s OFFSET %s
            """, (*params, limit, offset))
            rows = [_row_to_model(dict(r)) for r in cur.fetchall()]
            return rows, total

    def update_clickup_task_id(self, request_id: UUID, task_id: str) -> None:
        with get_mk1_conn() as conn:
            cur = conn.cursor()
            cur.execute("""
                UPDATE peptide_requests
                SET clickup_task_id = %s, updated_at = NOW()
                WHERE id = %s
            """, (task_id, str(request_id)))
            conn.commit()

    def update_status(
        self, request_id: UUID, *, new_status: str,
        previous_status: Optional[str] = None,
    ) -> None:
        """Update status + set terminal timestamp columns."""
        with get_mk1_conn() as conn:
            cur = conn.cursor()
            terminal_col_sql = ""
            if new_status == "completed":
                terminal_col_sql = ", completed_at = NOW()"
            elif new_status == "rejected":
                terminal_col_sql = ", rejected_at = NOW()"
            elif new_status == "cancelled":
                terminal_col_sql = ", cancelled_at = NOW()"
            prev_sql = ", previous_status = %s" if previous_status is not None else ""
            params: list = [new_status]
            if previous_status is not None:
                params.append(previous_status)
            params.append(str(request_id))
            cur.execute(f"""
                UPDATE peptide_requests
                SET status = %s{prev_sql}{terminal_col_sql}, updated_at = NOW()
                WHERE id = %s
            """, params)
            conn.commit()

    def set_assignees(self, request_id: UUID, assignee_ids: list[str]) -> None:
        with get_mk1_conn() as conn:
            cur = conn.cursor()
            # Use json.dumps for safe encoding — the spec's repr/replace hack
            # would break on any assignee id containing apostrophes or quotes.
            cur.execute("""
                UPDATE peptide_requests
                SET clickup_assignee_ids = %s::jsonb, updated_at = NOW()
                WHERE id = %s
            """, (json.dumps(assignee_ids), str(request_id)))
            conn.commit()

    def find_needing_clickup_create(self, older_than_seconds: int = 60) -> list[PeptideRequest]:
        """Rows with clickup_task_id NULL and older than N seconds."""
        with get_mk1_conn() as conn:
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute("""
                SELECT * FROM peptide_requests
                WHERE clickup_task_id IS NULL
                  AND clickup_create_failed_at IS NULL
                  AND created_at < NOW() - (%s || ' seconds')::interval
                ORDER BY created_at ASC LIMIT 50
            """, (older_than_seconds,))
            return [_row_to_model(dict(r)) for r in cur.fetchall()]
