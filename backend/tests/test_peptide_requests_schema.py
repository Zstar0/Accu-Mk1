"""Verify peptide_requests table exists with correct columns."""
import pytest
from mk1_db import get_mk1_conn, ensure_peptide_requests_table

# The app invokes ensure_*_table() lazily at runtime. In tests we call it
# explicitly so the information_schema queries below have something to find.
# The DDL is idempotent (CREATE TABLE/INDEX IF NOT EXISTS), so this is a
# no-op on subsequent runs.
ensure_peptide_requests_table()

REQUIRED_COLUMNS = {
    "id", "created_at", "updated_at", "idempotency_key",
    "submitted_by_wp_user_id", "submitted_by_email", "submitted_by_name",
    "compound_kind", "compound_name", "vendor_producer",
    "sequence_or_structure", "molecular_weight", "cas_or_reference",
    "vendor_catalog_number", "reason_notes", "expected_monthly_volume",
    "status", "previous_status", "rejection_reason", "sample_id",
    "clickup_task_id", "clickup_list_id", "clickup_assignee_ids",
    "senaite_service_uid", "wp_coupon_code", "wp_coupon_issued_at",
    "completed_at", "rejected_at", "cancelled_at",
    "clickup_create_failed_at", "coupon_failed_at",
    "senaite_clone_failed_at", "wp_relay_failed_at",
}


def test_peptide_requests_table_has_all_columns():
    with get_mk1_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'peptide_requests'
        """)
        actual = {row[0] for row in cur.fetchall()}
        missing = REQUIRED_COLUMNS - actual
        assert not missing, f"Missing columns: {missing}"


def test_peptide_requests_has_idempotency_unique_index():
    with get_mk1_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT indexname FROM pg_indexes
            WHERE tablename = 'peptide_requests'
              AND indexdef ILIKE '%submitted_by_wp_user_id%'
              AND indexdef ILIKE '%idempotency_key%'
              AND indexdef ILIKE '%UNIQUE%'
        """)
        assert cur.fetchone() is not None, "Missing unique index on (wp_user_id, idempotency_key)"
