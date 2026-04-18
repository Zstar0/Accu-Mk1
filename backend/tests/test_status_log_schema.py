"""Verify status log table."""
from backend.mk1_db import (
    get_mk1_conn,
    ensure_peptide_requests_table,
    ensure_peptide_request_status_log_table,
)

# The app invokes ensure_*_table() lazily at runtime. In tests we call it
# explicitly so the information_schema queries below have something to find.
# The parent table must exist first because status log FKs peptide_requests(id).
# The DDL is idempotent (CREATE TABLE/INDEX IF NOT EXISTS), so this is a
# no-op on subsequent runs.
ensure_peptide_requests_table()
ensure_peptide_request_status_log_table()

REQUIRED_COLUMNS = {
    "id", "peptide_request_id", "from_status", "to_status",
    "source", "clickup_event_id", "actor_clickup_user_id",
    "actor_accumk1_user_id", "note", "created_at",
}


def test_status_log_columns():
    with get_mk1_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'peptide_request_status_log'
        """)
        actual = {row[0] for row in cur.fetchall()}
        assert REQUIRED_COLUMNS <= actual, f"Missing: {REQUIRED_COLUMNS - actual}"


def test_status_log_clickup_event_id_unique():
    with get_mk1_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT indexname FROM pg_indexes
            WHERE tablename = 'peptide_request_status_log'
              AND indexdef ILIKE '%UNIQUE%'
              AND indexdef ILIKE '%clickup_event_id%'
        """)
        assert cur.fetchone() is not None
