"""Schema + seed assertions for the priority feature. Runs against the dev DB.

`_run_migrations()` is idempotent, so the module calls it directly at import
rather than relying on the app's startup lifespan having run.
"""
from sqlalchemy import text

from database import engine, _run_migrations

_run_migrations()


def _cols(table: str) -> set[str]:
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT column_name FROM information_schema.columns WHERE table_name = :t"
        ), {"t": table}).scalars().all()
    return set(rows)


def test_priorities_table_seeded_with_three_rows():
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT key, rank, icon, color, pulse, is_default, is_active FROM priorities ORDER BY rank"
        )).all()
    by_key = {r[0]: r for r in rows}
    assert set(by_key) >= {"default", "high", "expedited"}
    assert by_key["default"][1:] == (0, "minus", "zinc", False, True, True)
    assert by_key["high"][1:] == (10, "chevron-up", "amber", False, False, True)
    assert by_key["expedited"][1:] == (20, "chevrons-up", "red", True, False, True)


def test_single_default_index_exists():
    with engine.connect() as c:
        n = c.execute(text(
            "SELECT count(*) FROM pg_indexes WHERE indexname = 'uq_priorities_single_default'"
        )).scalar()
    assert n == 1


def test_level_columns_exist():
    assert "priority_key" in _cols("lims_orders")
    assert "priority_source" in _cols("lims_orders")
    assert {"priority_key", "sla_priority_key", "sla_priority_source",
            "sla_target_minutes", "sla_snapshot_at"} <= _cols("lims_samples")
    assert {"priority_key", "sla_priority_key", "sla_priority_source",
            "sla_target_minutes", "sla_snapshot_at"} <= _cols("lims_sub_samples")
    assert {"wp_customer_user_id", "priority_key", "note"} <= _cols("customer_priorities")
    assert {"level", "entity_id", "old_key", "new_key", "source"} <= _cols("priority_audit")


def test_sla_priority_tiers_has_fk_to_priorities():
    with engine.connect() as c:
        n = c.execute(text(
            "SELECT count(*) FROM information_schema.table_constraints "
            "WHERE table_name='sla_priority_tiers' AND constraint_name='fk_sla_priority_tiers_priority'"
        )).scalar()
    assert n == 1
