"""Verify clickup_user_mapping table."""
from mk1_db import get_mk1_conn, ensure_clickup_user_mapping_table

# The app invokes ensure_*_table() lazily at runtime. In tests we call it
# explicitly so the information_schema queries below have something to find.
# This table has no FK to other peptide-request tables, so no parent ensure
# is required. The DDL is idempotent (CREATE TABLE/INDEX IF NOT EXISTS), so
# this is a no-op on subsequent runs.
ensure_clickup_user_mapping_table()

REQUIRED = {"clickup_user_id", "accumk1_user_id", "clickup_username",
            "clickup_email", "auto_matched", "created_at", "updated_at", "last_seen_at"}


def test_clickup_user_mapping_columns():
    with get_mk1_conn() as conn:
        cur = conn.cursor()
        cur.execute("""SELECT column_name FROM information_schema.columns
                       WHERE table_name = 'clickup_user_mapping'""")
        actual = {row[0] for row in cur.fetchall()}
        assert REQUIRED <= actual
