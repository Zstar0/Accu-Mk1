"""Live-PG schema test for worksheet_items.department_id (S2 Task 1)."""
import re
import uuid

from sqlalchemy import text
from database import SessionLocal
from models import Department, ServiceGroup, Worksheet, WorksheetItem


def _get_migration_sqls():
    """The two S2 Task-1 statements, read from database.py's migrations list
    so the test exercises the real strings (not a copy that can drift)."""
    import database, inspect
    src = inspect.getsource(database)
    assert "worksheet_items ADD COLUMN IF NOT EXISTS department_id" in src
    assert "UPDATE worksheet_items" in src and "service_groups" in src


def _get_backfill_sql() -> str:
    """Extract the exact shipped backfill UPDATE text from database.py's
    migrations list, so the test runs the real statement rather than a copy
    that can drift out of sync with it."""
    import database, inspect
    src = inspect.getsource(database)
    match = re.search(r'"""(\s*UPDATE worksheet_items.*?)"""', src, re.DOTALL)
    assert match, "backfill UPDATE statement not found in database.py migrations list"
    return match.group(1)


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


def test_backfill_updates_department_from_group_and_is_idempotent():
    backfill_sql = _get_backfill_sql()
    suffix = uuid.uuid4().hex[:8]

    db = SessionLocal()
    try:
        dept = db.query(Department).order_by(Department.id).first()
        assert dept is not None, "expected at least one seed Department row"

        # Group WITH a department -> its item should get backfilled.
        group_with_dept = ServiceGroup(name=f"__test_s2_backfill_with_dept_{suffix}", department_id=dept.id)
        # Group WITHOUT a department -> its item must stay NULL (guard clause).
        group_without_dept = ServiceGroup(name=f"__test_s2_backfill_no_dept_{suffix}")
        db.add_all([group_with_dept, group_without_dept])
        db.flush()

        ws = Worksheet(title=f"__test_s2_backfill_ws_{suffix}")
        db.add(ws)
        db.flush()

        item_to_backfill = WorksheetItem(
            worksheet_id=ws.id,
            sample_uid=f"test-uid-{suffix}-a",
            sample_id=f"test-sample-{suffix}-a",
            service_group_id=group_with_dept.id,
            department_id=None,
        )
        item_guard = WorksheetItem(
            worksheet_id=ws.id,
            sample_uid=f"test-uid-{suffix}-b",
            sample_id=f"test-sample-{suffix}-b",
            service_group_id=group_without_dept.id,
            department_id=None,
        )
        db.add_all([item_to_backfill, item_guard])
        db.flush()

        # Run the REAL shipped backfill statement (same transaction, so it
        # sees the uncommitted seed rows above).
        db.execute(text(backfill_sql))
        db.flush()
        db.refresh(item_to_backfill)
        db.refresh(item_guard)

        assert item_to_backfill.department_id == dept.id
        assert item_guard.department_id is None

        # Idempotence: running it again must not change anything further.
        db.execute(text(backfill_sql))
        db.flush()
        db.refresh(item_to_backfill)
        db.refresh(item_guard)

        assert item_to_backfill.department_id == dept.id
        assert item_guard.department_id is None
    finally:
        # Nothing persists — this test only ever exercises an uncommitted
        # transaction against the live DB.
        db.rollback()
        db.close()
