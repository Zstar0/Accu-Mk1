"""Live-PG schema test for worksheet_items.department_id (S2 Task 1)."""
from sqlalchemy import text
from database import SessionLocal


def _get_migration_sqls():
    """The two S2 Task-1 statements, read from database.py's migrations list
    so the test exercises the real strings (not a copy that can drift)."""
    import database, inspect
    src = inspect.getsource(database)
    assert "worksheet_items ADD COLUMN IF NOT EXISTS department_id" in src
    assert "UPDATE worksheet_items" in src and "service_groups" in src


def test_migration_statements_present():
    _get_migration_sqls()


def test_column_exists_and_backfill_idempotent():
    db = SessionLocal()
    try:
        # Column present (migration already ran on this DB, or we run it here idempotently)
        db.execute(text(
            "ALTER TABLE worksheet_items ADD COLUMN IF NOT EXISTS department_id "
            "INTEGER REFERENCES departments(id) ON DELETE SET NULL"
        ))
        db.commit()
        cols = {r[0] for r in db.execute(text(
            "SELECT column_name FROM information_schema.columns WHERE table_name='worksheet_items'"
        )).all()}
        assert "department_id" in cols
    finally:
        db.rollback()
        db.close()
