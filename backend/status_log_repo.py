"""Repository layer for peptide_request_status_log."""
from typing import Optional
from uuid import UUID

import psycopg2
from psycopg2.extras import RealDictCursor

from backend.mk1_db import get_mk1_conn
from backend.models_peptide_request import StatusLogEntry


class StatusLogRepository:
    def append(
        self, *, peptide_request_id: UUID, from_status: Optional[str],
        to_status: str, source: str, clickup_event_id: Optional[str],
        actor_clickup_user_id: Optional[str], actor_accumk1_user_id: Optional[UUID],
        note: Optional[str],
    ) -> bool:
        """Insert a status-log row. Returns True on insert, False on dedupe.

        Dedupe is driven by the partial unique index on clickup_event_id
        (idx_status_log_clickup_event, WHERE clickup_event_id IS NOT NULL).
        We detect the violation via psycopg2.errors.UniqueViolation and
        confirm the constraint name before swallowing it — any other unique
        violation bubbles up.
        """
        with get_mk1_conn() as conn:
            # Default cursor (tuple) is fine for writes — we don't read rows back.
            cur = conn.cursor()
            try:
                cur.execute("""
                    INSERT INTO peptide_request_status_log (
                        peptide_request_id, from_status, to_status, source,
                        clickup_event_id, actor_clickup_user_id,
                        actor_accumk1_user_id, note
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """, (
                    str(peptide_request_id), from_status, to_status, source,
                    clickup_event_id, actor_clickup_user_id,
                    str(actor_accumk1_user_id) if actor_accumk1_user_id else None,
                    note,
                ))
                conn.commit()
                return True
            except psycopg2.errors.UniqueViolation as e:
                # Unique violation — only treat as dedup if it's the event-id index.
                # Any other unique violation is a bug we want to surface.
                conn.rollback()
                constraint = getattr(e.diag, "constraint_name", None)
                if constraint == "idx_status_log_clickup_event":
                    return False
                raise

    def get_for_request(self, peptide_request_id: UUID) -> list[StatusLogEntry]:
        """Return all status-log rows for a request, oldest first."""
        with get_mk1_conn() as conn:
            # RealDictCursor so StatusLogEntry(**dict(row)) works on full rows.
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute("""
                SELECT * FROM peptide_request_status_log
                WHERE peptide_request_id = %s
                ORDER BY created_at ASC
            """, (str(peptide_request_id),))
            return [StatusLogEntry(**dict(r)) for r in cur.fetchall()]
