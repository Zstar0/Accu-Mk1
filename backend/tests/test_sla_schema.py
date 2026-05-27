"""Live-DB schema + seed tests for sla_targets (sub-project A).

These run against the accumark_mk1 Postgres the backend is wired to (the
codebase convention — see test_status_log_schema.py). They verify the migration
in database._run_migrations: the default-row seed is idempotent and the partial
unique indexes that enforce wildcard uniqueness are present.

Requires pytest in the runtime; run inside the backend container:
    docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_sla_schema.py -q'
"""
from sqlalchemy import text

from database import _run_migrations, engine

# Migrations are idempotent (CREATE ... IF NOT EXISTS + seed guarded by NOT
# EXISTS), so calling at import time is a no-op on an already-migrated DB.
_run_migrations()


def test_seed_idempotent_when_run_twice():
    # The real guard under test is the seed's `WHERE NOT EXISTS (... is_default)`.
    # Running migrations again must NOT insert a second default row.
    _run_migrations()
    _run_migrations()
    with engine.connect() as c:
        n = c.execute(
            text("SELECT count(*) FROM sla_targets WHERE is_default")
        ).scalar()
    assert n == 1


def test_default_row_encodes_old_24h_goal():
    with engine.connect() as c:
        row = c.execute(
            text(
                "SELECT analysis_service_id, priority, target_minutes "
                "FROM sla_targets WHERE is_default"
            )
        ).fetchone()
    assert row is not None
    service_id, priority, target_minutes = row
    assert service_id is None  # catch-all: any service
    assert priority is None  # catch-all: any priority
    assert target_minutes == 1440  # the former hardcoded 24h goal


def test_partial_unique_indexes_exist():
    expected = {
        "uq_sla_svc_prio",
        "uq_sla_svc_only",
        "uq_sla_prio_only",
        "uq_sla_single_default",
    }
    with engine.connect() as c:
        rows = c.execute(
            text("SELECT indexname FROM pg_indexes WHERE tablename = 'sla_targets'")
        ).fetchall()
    present = {r[0] for r in rows}
    assert expected <= present, f"Missing partial indexes: {expected - present}"
