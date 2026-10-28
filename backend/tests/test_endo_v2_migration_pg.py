"""Endo worksheet v2 migration on Postgres (spec 2026-10-10 section 3.8).

The switch uses Postgres-only SQL (AT TIME ZONE, ALTER COLUMN SET DEFAULT), so
this file runs only when MK1_TEST_POSTGRES_URL names a Postgres it may write to,
and skips everywhere else. Inside the stack container (Task 20):

    MK1_TEST_POSTGRES_URL="postgresql+psycopg2://$MK1_DB_USER:$MK1_DB_PASSWORD@$MK1_DB_HOST:$MK1_DB_PORT/$MK1_DB_NAME" \\
        python -m pytest tests/test_endo_v2_migration_pg.py -q

Everything runs in a throwaway schema that is dropped afterwards, never in the
database's own tables (test_per_substance_reconciler.py's SessionLocal idiom
would rewrite real worksheets).
"""
import os
from datetime import datetime

import pytest
from sqlalchemy import create_engine, inspect, text

import models  # noqa: F401  (register the tables on Base, as init_db does)
import flags.models  # noqa: F401
import documents.models  # noqa: F401
import groups.models  # noqa: F401
import boards.models  # noqa: F401
from database import Base, _run_endo_v2_migrations

URL = os.environ.get("MK1_TEST_POSTGRES_URL")
SCHEMA = "endo_v2_migration_test"

pytestmark = pytest.mark.skipif(not URL, reason="set MK1_TEST_POSTGRES_URL to run the Postgres migration test")

NEW_ITEM_COLUMNS = ("prep_form", "prep_water_ml", "prep_total_dilution", "prep_steps", "cartridge_type_id",
                    "result_reading", "result_reader", "result_entered_at", "result_entered_by_user_id")


@pytest.fixture
def pg():
    admin = create_engine(URL)
    with admin.begin() as c:
        c.execute(text(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE"))
        c.execute(text(f"CREATE SCHEMA {SCHEMA}"))
    engine = create_engine(URL, connect_args={"options": f"-csearch_path={SCHEMA}"})
    try:
        Base.metadata.create_all(engine)
        # create_all builds the old tables WITH the new columns; drop them to get
        # the shape a deployed database has before this release (create_all never
        # alters an existing table, which is why the migration exists).
        with engine.begin() as c:
            c.execute(text("ALTER TABLE worksheets DROP COLUMN endo_prep, "
                           "DROP COLUMN cartridge_type_id, DROP COLUMN endo_method_id"))
            c.execute(text("ALTER TABLE worksheet_items "
                           + ", ".join(f"DROP COLUMN {col}" for col in NEW_ITEM_COLUMNS)))
            c.execute(text("ALTER TABLE instruments DROP COLUMN serial_number"))
            c.execute(text("ALTER TABLE hplc_methods DROP COLUMN run_parameters"))
            c.execute(text("INSERT INTO business_hours_config (id, open_time, close_time, timezone, working_days, "
                           "created_at, updated_at) "
                           "VALUES (1, '09:00', '17:00', 'America/Los_Angeles', '[0, 1, 2, 3, 4]', NOW(), NOW())"))
        yield engine
    finally:
        engine.dispose()
        with admin.begin() as c:
            c.execute(text(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE"))
        admin.dispose()


def _ws(conn, title, status, created_at):
    return conn.execute(text(
        "INSERT INTO worksheets (title, status, created_at, updated_at) "
        "VALUES (:t, :s, :c, :c) RETURNING id"), {"t": title, "s": status, "c": created_at}).scalar()


def _preps(engine):
    with engine.connect() as c:
        return dict(c.execute(text("SELECT title, endo_prep FROM worksheets")).all())


def test_switch_runs_once_in_lab_time_and_never_reflips(pg):
    with pg.begin() as c:
        # Naive UTC, as the app stores it. 08:00 UTC on 10-08 is 01:00 on 10-08 in
        # Los Angeles; 05:00 UTC on 10-08 is still 10-07 there.
        _ws(c, "open-1008-lab", "open", datetime(2026, 10, 8, 8, 0))
        _ws(c, "open-1007-lab", "open", datetime(2026, 10, 8, 5, 0))
        _ws(c, "staging-1009", "staging", datetime(2026, 10, 9, 12, 0))
        _ws(c, "completed-1009", "completed", datetime(2026, 10, 9, 12, 0))
        _ws(c, "open-0930", "open", datetime(2026, 9, 30, 12, 0))

    _run_endo_v2_migrations(pg)

    assert _preps(pg) == {
        "open-1008-lab": "2ml",
        "open-1007-lab": "stock",
        "staging-1009": "2ml",
        "completed-1009": "stock",
        "open-0930": "stock",
    }
    insp = inspect(pg)
    # After the switch a new worksheet defaults to 2 mL (Postgres reports
    # '2ml'::character varying); spec 12's rollback drops this default.
    default = next(col["default"] for col in insp.get_columns("worksheets")
                   if col["name"] == "endo_prep")
    assert default is not None and default.startswith("'2ml'"), default
    assert set(NEW_ITEM_COLUMNS) <= {col["name"] for col in insp.get_columns("worksheet_items")}
    assert "serial_number" in {col["name"] for col in insp.get_columns("instruments")}
    assert "run_parameters" in {col["name"] for col in insp.get_columns("hplc_methods")}
    with pg.connect() as c:
        indexes = set(c.execute(text("SELECT indexname FROM pg_indexes WHERE schemaname = :s"),
                                {"s": SCHEMA}).scalars())
    assert {"uq_instruments_serial_number", "uq_consumable_types_part_number",
            "uq_method_consumable_default"} <= indexes

    # The lab switches one worksheet back to stock; a new worksheet takes the default.
    with pg.begin() as c:
        c.execute(text("UPDATE worksheets SET endo_prep = 'stock' WHERE title = 'open-1008-lab'"))
        _ws(c, "new-after-release", "open", datetime(2026, 10, 12, 16, 0))

    _run_endo_v2_migrations(pg)   # the next boot

    assert _preps(pg) == {
        "open-1008-lab": "stock",
        "open-1007-lab": "stock",
        "staging-1009": "2ml",
        "completed-1009": "stock",
        "open-0930": "stock",
        "new-after-release": "2ml",
    }
