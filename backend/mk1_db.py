"""
Direct psycopg2 connection to the accumark_mk1 PostgreSQL database.

This module owns all CRUD operations for tables that live in accumark_mk1:
  - sample_preps

Connection is configured from MK1_DB_* environment variables (same source
as database.py / SQLAlchemy, but using psycopg2 for raw SQL convenience).
"""

import os
from contextlib import contextmanager
from typing import Generator, Optional

import psycopg2
from psycopg2.extras import RealDictCursor

# Load .env file if python-dotenv is available
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass


# ─── Connection ────────────────────────────────────────────────────────────────

def _get_dsn() -> str:
    """Build a psycopg2 DSN from MK1_DB_* environment variables."""
    host     = os.environ.get("MK1_DB_HOST",     "localhost")
    port     = os.environ.get("MK1_DB_PORT",     "5432")
    dbname   = os.environ.get("MK1_DB_NAME",     "accumark_mk1")
    user     = os.environ.get("MK1_DB_USER",     "postgres")
    password = os.environ.get("MK1_DB_PASSWORD", "accumark_dev_secret")
    return f"host={host} port={port} dbname={dbname} user={user} password={password}"


@contextmanager
def get_mk1_db() -> Generator[psycopg2.extensions.connection, None, None]:
    """Context manager that yields an open psycopg2 connection to accumark_mk1."""
    conn = psycopg2.connect(_get_dsn())
    try:
        yield conn
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ─── sample_preps DDL ──────────────────────────────────────────────────────────

_SAMPLE_PREPS_DDL = """
CREATE TABLE IF NOT EXISTS sample_preps (
    -- Identity
    id              SERIAL PRIMARY KEY,
    sample_id       VARCHAR(30)  NOT NULL UNIQUE,   -- e.g. SP-20250302-0001

    -- Wizard session reference (local AccuMk1 session id for traceability)
    wizard_session_id   INTEGER,

    -- Step 1: Sample info
    peptide_id          INTEGER,
    peptide_name        VARCHAR(200),
    peptide_abbreviation VARCHAR(50),
    senaite_sample_id   VARCHAR(200),               -- e.g. P-0085 from SENAITE
    declared_weight_mg  DOUBLE PRECISION,
    target_conc_ug_ml   DOUBLE PRECISION,
    target_total_vol_ul DOUBLE PRECISION,

    -- Step 2: Stock prep measurements (mg from balance)
    stock_vial_empty_mg     DOUBLE PRECISION,
    stock_vial_loaded_mg    DOUBLE PRECISION,

    -- Step 2 derived
    stock_conc_ug_ml        DOUBLE PRECISION,
    required_diluent_vol_ul DOUBLE PRECISION,
    required_stock_vol_ul   DOUBLE PRECISION,

    -- Step 3: Dilution measurements (mg from balance)
    dil_vial_empty_mg           DOUBLE PRECISION,
    dil_vial_with_diluent_mg    DOUBLE PRECISION,
    dil_vial_final_mg           DOUBLE PRECISION,

    -- Step 3 derived
    actual_conc_ug_ml       DOUBLE PRECISION,
    actual_diluent_vol_ul   DOUBLE PRECISION,
    actual_stock_vol_ul     DOUBLE PRECISION,
    actual_total_vol_ul     DOUBLE PRECISION,

    -- Status
    status          VARCHAR(30)  NOT NULL DEFAULT 'awaiting_hplc',
    notes           TEXT,

    -- Timestamps
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sample_preps_sample_id    ON sample_preps (sample_id);
CREATE INDEX IF NOT EXISTS idx_sample_preps_senaite_id   ON sample_preps (senaite_sample_id);
CREATE INDEX IF NOT EXISTS idx_sample_preps_created_at   ON sample_preps (created_at DESC);
"""


def ensure_sample_preps_table() -> None:
    """
    Idempotently create the sample_preps table and its indexes in accumark_mk1.
    Safe to call on every startup — uses CREATE TABLE IF NOT EXISTS.
    """
    with get_mk1_db() as conn:
        with conn.cursor() as cur:
            cur.execute(_SAMPLE_PREPS_DDL)
            # Blend support columns (added after initial DDL)
            cur.execute("ALTER TABLE sample_preps ADD COLUMN IF NOT EXISTS is_blend BOOLEAN DEFAULT FALSE")
            cur.execute("ALTER TABLE sample_preps ADD COLUMN IF NOT EXISTS components_json JSONB")
            cur.execute("ALTER TABLE sample_preps ADD COLUMN IF NOT EXISTS vial_data JSONB")
        conn.commit()


# ─── sample_preps CRUD ─────────────────────────────────────────────────────────

def _generate_sample_id(cur) -> str:
    """Generate next SP-YYYYMMDD-NNNN id scoped to today."""
    from datetime import date
    prefix = f"SP-{date.today().strftime('%Y%m%d')}-"
    cur.execute(
        "SELECT sample_id FROM sample_preps WHERE sample_id LIKE %s ORDER BY sample_id DESC LIMIT 1",
        [prefix + "%"],
    )
    row = cur.fetchone()
    seq = (int(row['sample_id'].split("-")[-1]) + 1) if row else 1
    return f"{prefix}{seq:04d}"


def create_sample_prep(data: dict) -> dict:
    """
    Insert a new sample prep record into accumark_mk1. Returns the full created row.

    Accepted keys: wizard_session_id, peptide_id, peptide_name,
    peptide_abbreviation, senaite_sample_id, declared_weight_mg,
    target_conc_ug_ml, target_total_vol_ul, stock_vial_empty_mg,
    stock_vial_loaded_mg, stock_conc_ug_ml, required_diluent_vol_ul,
    required_stock_vol_ul, dil_vial_empty_mg, dil_vial_with_diluent_mg,
    dil_vial_final_mg, actual_conc_ug_ml, actual_diluent_vol_ul,
    actual_stock_vol_ul, actual_total_vol_ul, status, notes
    """
    cols = [
        "wizard_session_id", "peptide_id", "peptide_name", "peptide_abbreviation",
        "senaite_sample_id", "declared_weight_mg", "target_conc_ug_ml",
        "target_total_vol_ul", "stock_vial_empty_mg", "stock_vial_loaded_mg",
        "stock_conc_ug_ml", "required_diluent_vol_ul", "required_stock_vol_ul",
        "dil_vial_empty_mg", "dil_vial_with_diluent_mg", "dil_vial_final_mg",
        "actual_conc_ug_ml", "actual_diluent_vol_ul", "actual_stock_vol_ul",
        "actual_total_vol_ul", "status", "notes",
        "is_blend", "components_json",
    ]
    with get_mk1_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            sample_id = _generate_sample_id(cur)
            values = [data.get(c) for c in cols]
            placeholders = ", ".join(["%s"] * len(cols))
            col_str = ", ".join(cols)
            cur.execute(
                f"""
                INSERT INTO sample_preps (sample_id, {col_str})
                VALUES (%s, {placeholders})
                RETURNING *
                """,
                [sample_id] + values,
            )
            row = dict(cur.fetchone())
        conn.commit()
    return row


def list_sample_preps(
    search: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
) -> list[dict]:
    """
    List sample preps from accumark_mk1, ordered newest-first.
    Optional search matches sample_id, senaite_sample_id, or peptide_name.
    """
    query = """
        SELECT *
        FROM sample_preps
    """
    params: list = []
    if search:
        query += """
            WHERE sample_id        ILIKE %s
               OR senaite_sample_id ILIKE %s
               OR peptide_name      ILIKE %s
        """
        term = f"%{search}%"
        params.extend([term, term, term])
    query += " ORDER BY created_at DESC LIMIT %s OFFSET %s"
    params.extend([limit, offset])

    with get_mk1_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(query, params)
            return [dict(r) for r in cur.fetchall()]


def get_sample_prep(sample_prep_id: int) -> Optional[dict]:
    """Fetch a single sample prep by integer id (all columns)."""
    with get_mk1_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT * FROM sample_preps WHERE id = %s", [sample_prep_id])
            row = cur.fetchone()
            return dict(row) if row else None


def update_sample_prep(sample_prep_id: int, data: dict) -> Optional[dict]:
    """
    PATCH a sample prep — only update provided keys.
    Automatically bumps updated_at. Returns updated row or None if not found.
    """
    allowed = {
        "senaite_sample_id", "declared_weight_mg", "target_conc_ug_ml",
        "target_total_vol_ul", "stock_vial_empty_mg", "stock_vial_loaded_mg",
        "stock_conc_ug_ml", "required_diluent_vol_ul", "required_stock_vol_ul",
        "dil_vial_empty_mg", "dil_vial_with_diluent_mg", "dil_vial_final_mg",
        "actual_conc_ug_ml", "actual_diluent_vol_ul", "actual_stock_vol_ul",
        "actual_total_vol_ul", "status", "notes",
    }
    updates = {k: v for k, v in data.items() if k in allowed}
    if not updates:
        return get_sample_prep(sample_prep_id)

    set_clause = ", ".join([f"{k} = %s" for k in updates])
    values = list(updates.values()) + [sample_prep_id]

    with get_mk1_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                f"""
                UPDATE sample_preps
                SET {set_clause}, updated_at = NOW()
                WHERE id = %s
                RETURNING *
                """,
                values,
            )
            row = cur.fetchone()
        conn.commit()
    return dict(row) if row else None


def delete_sample_prep(sample_prep_id: int) -> bool:
    """Delete a sample prep by id. Returns True if a row was deleted, False if not found."""
    with get_mk1_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM sample_preps WHERE id = %s RETURNING id",
                [sample_prep_id],
            )
            deleted = cur.fetchone() is not None
        conn.commit()
    return deleted
