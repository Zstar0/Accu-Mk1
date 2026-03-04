"""
One-time migration: SQLite → PostgreSQL.
Run inside the accu-mk1-backend container where both databases are reachable.

Usage:
    docker exec accu-mk1-backend python migrate_sqlite_to_pg.py
"""

import os
import sqlite3
from contextlib import closing

import psycopg2
from psycopg2.extras import execute_values

# ── Configuration ──────────────────────────────────────────────────────────

SQLITE_PATH = "data/accu-mk1.db"

PG_HOST = os.environ.get("MK1_DB_HOST", "host.docker.internal")
PG_PORT = os.environ.get("MK1_DB_PORT", "5432")
PG_NAME = os.environ.get("MK1_DB_NAME", "accumark_mk1")
PG_USER = os.environ.get("MK1_DB_USER", "postgres")
PG_PASSWORD = os.environ.get("MK1_DB_PASSWORD", "accumark_dev_secret")

# Tables in FK-safe insertion order
TABLES = [
    "users",
    "settings",
    "audit_logs",
    "instruments",
    "peptides",
    "hplc_methods",
    "calibration_curves",
    "peptide_methods",
    "jobs",
    "samples",
    "results",
    "wizard_sessions",
    "wizard_measurements",
    "hplc_analyses",
    "sharepoint_file_cache",
]


def migrate():
    # Connect to SQLite
    sqlite_conn = sqlite3.connect(SQLITE_PATH)
    sqlite_conn.row_factory = sqlite3.Row

    # Connect to PostgreSQL
    pg_conn = psycopg2.connect(
        host=PG_HOST, port=PG_PORT, dbname=PG_NAME,
        user=PG_USER, password=PG_PASSWORD,
    )

    # First: create schema using SQLAlchemy
    print("Creating schema in PostgreSQL...")
    from sqlalchemy import create_engine
    from database import Base
    import models  # noqa: F401 — registers models with Base

    pg_url = f"postgresql+psycopg2://{PG_USER}:{PG_PASSWORD}@{PG_HOST}:{PG_PORT}/{PG_NAME}"
    sa_engine = create_engine(pg_url)
    Base.metadata.create_all(bind=sa_engine)
    sa_engine.dispose()
    print("Schema created.\n")

    # Migrate each table
    total_rows = 0
    with closing(sqlite_conn), closing(pg_conn):
        pg_cur = pg_conn.cursor()

        # Discover boolean columns in PG so we can convert SQLite int → bool
        pg_cur.execute("""
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = 'public' AND data_type = 'boolean'
        """)
        bool_cols = {}
        for tname, cname in pg_cur.fetchall():
            bool_cols.setdefault(tname, set()).add(cname)

        # Discover PG columns per table so we skip columns that don't exist in PG
        pg_cur.execute("""
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
        """)
        pg_columns = {}
        for tname, cname in pg_cur.fetchall():
            pg_columns.setdefault(tname, set()).add(cname)

        for table in TABLES:
            # Read from SQLite
            try:
                rows = sqlite_conn.execute(f"SELECT * FROM {table}").fetchall()
            except sqlite3.OperationalError as e:
                print(f"  SKIP {table}: {e}")
                continue

            if not rows:
                print(f"  {table}: 0 rows (empty)")
                continue

            sqlite_cols = rows[0].keys()
            pg_table_cols = pg_columns.get(table, set())

            # Only migrate columns that exist in BOTH databases
            columns = [c for c in sqlite_cols if c in pg_table_cols]
            skipped = [c for c in sqlite_cols if c not in pg_table_cols]
            if skipped:
                print(f"  {table}: skipping SQLite-only columns: {skipped}")

            col_str = ", ".join(f'"{c}"' for c in columns)
            placeholders = ", ".join(["%s"] * len(columns))

            # Map from filtered columns back to original sqlite row indices
            sqlite_col_indices = {c: i for i, c in enumerate(sqlite_cols)}
            col_indices = [sqlite_col_indices[c] for c in columns]

            # Convert SQLite integers to Python bools for boolean PG columns
            table_bools = bool_cols.get(table, set())
            bool_positions = [i for i, c in enumerate(columns) if c in table_bools]

            def convert_row(row, _col_idx=col_indices, _bool_pos=bool_positions):
                vals = [row[i] for i in _col_idx]
                for idx in _bool_pos:
                    if vals[idx] is not None:
                        vals[idx] = bool(vals[idx])
                return tuple(vals)

            # Truncate PG table first (in case of re-run)
            pg_cur.execute(f'TRUNCATE TABLE "{table}" CASCADE')

            # Insert rows
            values = [convert_row(row) for row in rows]
            insert_sql = f'INSERT INTO "{table}" ({col_str}) VALUES ({placeholders})'
            pg_cur.executemany(insert_sql, values)

            print(f"  {table}: {len(rows)} rows migrated")
            total_rows += len(rows)

            # Reset sequence if table has an 'id' column
            if "id" in columns:
                pg_cur.execute(
                    f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), "
                    f"COALESCE((SELECT MAX(id) FROM \"{table}\"), 0) + 1, false)"
                )

        pg_conn.commit()
        print(f"\nMigration complete: {total_rows} total rows across {len(TABLES)} tables.")


if __name__ == "__main__":
    migrate()
