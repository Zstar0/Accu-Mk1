"""Live-DB schema + seed tests for the SLA tier model (revises A).

Runs against the accumark_mk1 Postgres the backend is wired to. Verifies the
migration in database._run_migrations: sla_tiers + sla_priority_tiers exist,
service_groups has sla_tier_id, the default-tier seed is idempotent, and the
single-default partial index is present.

Run in the backend container:
    docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_sla_schema.py -q'
"""
from sqlalchemy import text

from database import _run_migrations, engine

_run_migrations()


def test_seed_default_tier_idempotent_when_run_twice():
    _run_migrations()
    _run_migrations()
    with engine.connect() as c:
        n = c.execute(
            text("SELECT count(*) FROM sla_tiers WHERE is_default")
        ).scalar()
    assert n == 1


def test_default_tier_encodes_old_24h_goal():
    with engine.connect() as c:
        row = c.execute(
            text("SELECT name, target_minutes FROM sla_tiers WHERE is_default")
        ).fetchone()
    assert row is not None
    name, target_minutes = row
    assert target_minutes == 1440


def test_sla_targets_table_dropped():
    with engine.connect() as c:
        exists = c.execute(
            text("SELECT to_regclass('public.sla_targets')")
        ).scalar()
    assert exists is None


def test_priority_tiers_table_and_service_group_column_exist():
    with engine.connect() as c:
        pt = c.execute(text("SELECT to_regclass('public.sla_priority_tiers')")).scalar()
        col = c.execute(
            text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name='service_groups' AND column_name='sla_tier_id'"
            )
        ).fetchone()
    assert pt is not None
    assert col is not None


def test_single_default_partial_index_exists():
    with engine.connect() as c:
        rows = c.execute(
            text("SELECT indexname FROM pg_indexes WHERE tablename='sla_tiers'")
        ).fetchall()
    assert "uq_sla_tier_single_default" in {r[0] for r in rows}
