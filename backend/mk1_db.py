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


# Canonical alias used by newer modules (peptide_requests, status_log, etc.).
# Kept alongside get_mk1_db for backward compatibility with existing callers.
get_mk1_conn = get_mk1_db


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
            # Phase 09: Standard prep metadata
            cur.execute("ALTER TABLE sample_preps ADD COLUMN IF NOT EXISTS is_standard BOOLEAN DEFAULT FALSE")
            cur.execute("ALTER TABLE sample_preps ADD COLUMN IF NOT EXISTS manufacturer VARCHAR(200)")
            cur.execute("ALTER TABLE sample_preps ADD COLUMN IF NOT EXISTS standard_notes TEXT")
            cur.execute("ALTER TABLE sample_preps ADD COLUMN IF NOT EXISTS instrument_name VARCHAR(200)")
            cur.execute("ALTER TABLE sample_preps ADD COLUMN IF NOT EXISTS instrument_id INTEGER")
            # User tracking
            cur.execute("ALTER TABLE sample_preps ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER")
            cur.execute("ALTER TABLE sample_preps ADD COLUMN IF NOT EXISTS created_by_email VARCHAR(320)")
            cur.execute("ALTER TABLE sample_preps ADD COLUMN IF NOT EXISTS updated_by_user_id INTEGER")
            cur.execute("ALTER TABLE sample_preps ADD COLUMN IF NOT EXISTS updated_by_email VARCHAR(320)")
        conn.commit()


# ─── peptide_requests DDL ──────────────────────────────────────────────────────

_PEPTIDE_REQUESTS_DDL = """
CREATE TABLE IF NOT EXISTS peptide_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    idempotency_key TEXT NOT NULL,
    submitted_by_wp_user_id INTEGER NOT NULL,
    submitted_by_email TEXT NOT NULL,
    submitted_by_name TEXT NOT NULL,
    compound_kind TEXT NOT NULL CHECK (compound_kind IN ('peptide', 'other')),
    compound_name TEXT NOT NULL,
    vendor_producer TEXT NOT NULL,
    sequence_or_structure TEXT,
    molecular_weight NUMERIC,
    cas_or_reference TEXT,
    vendor_catalog_number TEXT,
    reason_notes TEXT,
    expected_monthly_volume INTEGER,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN (
        'new', 'approved', 'ordering_standard', 'sample_prep_created',
        'in_process', 'on_hold', 'completed', 'rejected', 'cancelled'
    )),
    previous_status TEXT,
    rejection_reason TEXT,
    sample_id TEXT,
    clickup_task_id TEXT,
    clickup_list_id TEXT NOT NULL,
    clickup_assignee_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    senaite_service_uid TEXT,
    wp_coupon_code TEXT,
    wp_coupon_issued_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    rejected_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    clickup_create_failed_at TIMESTAMPTZ,
    coupon_failed_at TIMESTAMPTZ,
    senaite_clone_failed_at TIMESTAMPTZ,
    wp_relay_failed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_peptide_requests_idempotency
    ON peptide_requests (submitted_by_wp_user_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_peptide_requests_wp_user
    ON peptide_requests (submitted_by_wp_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_peptide_requests_status
    ON peptide_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_peptide_requests_clickup_task
    ON peptide_requests (clickup_task_id) WHERE clickup_task_id IS NOT NULL;
"""


def ensure_peptide_requests_table() -> None:
    """
    Idempotently create the peptide_requests table and its indexes in accumark_mk1.
    Safe to call on every startup — uses CREATE TABLE/INDEX IF NOT EXISTS.

    Enables the pgcrypto extension first because gen_random_uuid() is the
    default for the `id` column.
    """
    with get_mk1_db() as conn:
        with conn.cursor() as cur:
            cur.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto;")
            cur.execute(_PEPTIDE_REQUESTS_DDL)
        conn.commit()


# ─── peptide_request_status_log DDL ────────────────────────────────────────────

_PEPTIDE_REQUEST_STATUS_LOG_DDL = """
CREATE TABLE IF NOT EXISTS peptide_request_status_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    peptide_request_id UUID NOT NULL REFERENCES peptide_requests(id) ON DELETE CASCADE,
    from_status TEXT,
    to_status TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('clickup', 'accumk1_admin', 'system')),
    clickup_event_id TEXT,
    actor_clickup_user_id TEXT,
    actor_accumk1_user_id UUID,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_status_log_clickup_event
    ON peptide_request_status_log (clickup_event_id)
    WHERE clickup_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_status_log_request
    ON peptide_request_status_log (peptide_request_id, created_at DESC);
"""


def ensure_peptide_request_status_log_table() -> None:
    """
    Idempotently create the peptide_request_status_log table and its indexes
    in accumark_mk1. Safe to call on every startup — uses CREATE TABLE/INDEX
    IF NOT EXISTS.

    Enables the pgcrypto extension first because gen_random_uuid() is the
    default for the `id` column. The parent peptide_requests table must already
    exist (FK reference); call ensure_peptide_requests_table() first.
    """
    with get_mk1_db() as conn:
        with conn.cursor() as cur:
            cur.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto;")
            cur.execute(_PEPTIDE_REQUEST_STATUS_LOG_DDL)
        conn.commit()


# ─── clickup_user_mapping DDL ──────────────────────────────────────────────────

_CLICKUP_USER_MAPPING_DDL = """
CREATE TABLE IF NOT EXISTS clickup_user_mapping (
    clickup_user_id TEXT PRIMARY KEY,
    accumk1_user_id UUID,
    clickup_username TEXT NOT NULL,
    clickup_email TEXT,
    auto_matched BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clickup_user_mapping_unmapped
    ON clickup_user_mapping (accumk1_user_id) WHERE accumk1_user_id IS NULL;
"""


def ensure_clickup_user_mapping_table() -> None:
    """
    Idempotently create the clickup_user_mapping table and its indexes in
    accumark_mk1. Safe to call on every startup — uses CREATE TABLE/INDEX
    IF NOT EXISTS.

    Enables the pgcrypto extension first to stay consistent with the other
    peptide-request ensure-functions (harmless and idempotent; safeguards
    any future edit that introduces a UUID default on this table).
    """
    with get_mk1_db() as conn:
        with conn.cursor() as cur:
            cur.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto;")
            cur.execute(_CLICKUP_USER_MAPPING_DDL)
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
        "is_blend", "components_json", "vial_data",
        "is_standard", "manufacturer", "standard_notes", "instrument_name", "instrument_id",
        "created_by_user_id", "created_by_email", "updated_by_user_id", "updated_by_email",
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
    is_standard: Optional[bool] = None,
    limit: int = 100,
    offset: int = 0,
) -> list[dict]:
    """
    List sample preps from accumark_mk1, ordered newest-first.
    Optional search matches sample_id, senaite_sample_id, or peptide_name.
    Optional is_standard filter limits to standard or non-standard preps.
    """
    query = """
        SELECT *
        FROM sample_preps
    """
    params: list = []
    conditions: list[str] = []
    if search:
        conditions.append(
            "(sample_id ILIKE %s OR senaite_sample_id ILIKE %s OR peptide_name ILIKE %s)"
        )
        term = f"%{search}%"
        params.extend([term, term, term])
    if is_standard is not None:
        conditions.append("is_standard = %s")
        params.append(is_standard)
    if conditions:
        query += " WHERE " + " AND ".join(conditions)
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
        "instrument_name", "instrument_id", "manufacturer", "standard_notes",
        "is_standard", "is_blend", "components_json", "vial_data",
        "created_by_user_id", "created_by_email",
        "updated_by_user_id", "updated_by_email",
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
