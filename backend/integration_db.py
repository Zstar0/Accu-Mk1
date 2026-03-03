"""
PostgreSQL connection to the Integration Service database.
Provides read-only access to order_submissions and ingestions tables for debugging.

Supports multiple environments:
  - "local" (default): Local Docker container
  - "production": Production server
  
Environment can be switched at runtime via set_environment().
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
    pass  # dotenv not installed, use environment variables directly


# Runtime environment setting (can be changed via API)
_current_environment: str = os.environ.get("INTEGRATION_DB_ENV", "local").lower()


def get_environment() -> str:
    """Get the current database environment."""
    return _current_environment


def set_environment(env: str) -> str:
    """
    Set the database environment at runtime.
    
    Args:
        env: "local" or "production"
        
    Returns:
        The new environment value
    """
    global _current_environment
    env = env.lower()
    if env not in ("local", "production"):
        raise ValueError(f"Invalid environment: {env}. Must be 'local' or 'production'")
    _current_environment = env
    return _current_environment


def get_available_environments() -> list[str]:
    """Get list of available environments."""
    return ["local", "production"]


def get_wordpress_host() -> str:
    """Get the WordPress host URL for the current environment."""
    env = _current_environment
    if env == "production":
        return os.environ.get("WORDPRESS_PROD_HOST", "https://accumarklabs.kinsta.cloud")
    else:
        return os.environ.get("WORDPRESS_LOCAL_HOST", "https://accumarklabs.local")


def get_connection_config() -> dict:
    """
    Get PostgreSQL connection config based on current environment.
    
    Returns dict with: host, port, database, user, password
    """
    env = _current_environment
    
    if env == "production":
        prefix = "INTEGRATION_DB_PROD_"
    else:  # local
        prefix = "INTEGRATION_DB_LOCAL_"
    
    return {
        "host": os.environ.get(f"{prefix}HOST", "localhost"),
        "port": int(os.environ.get(f"{prefix}PORT", "5432")),
        "database": os.environ.get(f"{prefix}NAME", "accumark_integration"),
        "user": os.environ.get(f"{prefix}USER", "postgres"),
        "password": os.environ.get(f"{prefix}PASSWORD", "accumark_dev_secret"),
    }


def get_connection_string() -> str:
    """Get PostgreSQL connection string from environment."""
    config = get_connection_config()
    return (
        f"host={config['host']} "
        f"port={config['port']} "
        f"dbname={config['database']} "
        f"user={config['user']} "
        f"password={config['password']}"
    )


@contextmanager
def get_integration_db() -> Generator:
    """
    Context manager for Integration Service database connection.
    
    Usage:
        with get_integration_db() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM order_submissions")
                rows = cur.fetchall()
    """
    conn = None
    try:
        conn = psycopg2.connect(get_connection_string())
        yield conn
    finally:
        if conn:
            conn.close()


def fetch_orders(
    search: Optional[str] = None,
    limit: int = 50,
    offset: int = 0
) -> list[dict]:
    """
    Fetch orders from order_submissions table.
    
    Args:
        search: Optional order_id search term
        limit: Max records to return
        offset: Pagination offset
        
    Returns:
        List of order dicts
    """
    query = """
        SELECT
            id,
            order_id,
            order_number,
            status,
            samples_expected,
            samples_delivered,
            error_message,
            payload,
            sample_results,
            created_at,
            updated_at,
            completed_at
        FROM order_submissions
    """
    params: list = []
    
    if search:
        query += " WHERE order_id ILIKE %s OR order_number ILIKE %s"
        search_term = f"%{search}%"
        params.extend([search_term, search_term])
    
    query += " ORDER BY created_at DESC LIMIT %s OFFSET %s"
    params.extend([limit, offset])
    
    with get_integration_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(query, params)
            rows = cur.fetchall()
            # Convert to regular dicts and handle UUID serialization
            return [dict(row) for row in rows]


def fetch_ingestions_for_order(order_id: str) -> list[dict]:
    """
    Fetch all ingestions linked to an order.
    
    Args:
        order_id: The WordPress order ID (string)
        
    Returns:
        List of ingestion dicts
    """
    # First, get the order_submission UUID from order_id
    find_order_query = """
        SELECT id FROM order_submissions WHERE order_id = %s
    """
    
    ingestions_query = """
        SELECT 
            i.id,
            i.sample_id,
            i.coa_version,
            i.order_ref,
            i.status,
            i.s3_key,
            i.verification_code,
            i.error_message,
            i.created_at,
            i.updated_at,
            i.completed_at,
            i.processing_time_ms
        FROM ingestions i
        WHERE i.order_submission_id = %s
        ORDER BY i.created_at DESC
    """
    
    with get_integration_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Find order submission UUID
            cur.execute(find_order_query, [order_id])
            order_row = cur.fetchone()
            
            if not order_row:
                return []
            
            # Fetch ingestions
            cur.execute(ingestions_query, [order_row['id']])
            rows = cur.fetchall()
            return [dict(row) for row in rows]


def fetch_attempts_for_order(order_id: str) -> list[dict]:
    """
    Fetch all submission attempts for an order.

    Args:
        order_id: The WordPress order ID (string)

    Returns:
        List of attempt dicts
    """
    find_order_query = """
        SELECT id FROM order_submissions WHERE order_id = %s
    """

    attempts_query = """
        SELECT
            id,
            attempt_number,
            event_id,
            status,
            error_message,
            samples_processed,
            created_at
        FROM order_submission_attempts
        WHERE order_submission_id = %s
        ORDER BY attempt_number ASC
    """

    with get_integration_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(find_order_query, [order_id])
            order_row = cur.fetchone()

            if not order_row:
                return []

            cur.execute(attempts_query, [order_row['id']])
            rows = cur.fetchall()
            return [dict(row) for row in rows]


def fetch_coa_generations_for_order(order_id: str) -> list[dict]:
    """
    Fetch all COA generations linked to an order.

    Linked via order_submission_id directly, or via ingestions.

    Args:
        order_id: The WordPress order ID (string)

    Returns:
        List of COA generation dicts
    """
    find_order_query = """
        SELECT id FROM order_submissions WHERE order_id = %s
    """

    generations_query = """
        SELECT
            g.id,
            g.sample_id,
            g.generation_number,
            g.verification_code,
            g.content_hash,
            g.status,
            g.anchor_status,
            g.anchor_tx_hash,
            g.chromatogram_s3_key,
            g.published_at,
            g.superseded_at,
            g.created_at
        FROM coa_generations g
        WHERE g.order_submission_id = %s
           OR g.ingestion_id IN (
               SELECT i.id FROM ingestions i WHERE i.order_submission_id = %s
           )
        ORDER BY g.created_at DESC
    """

    with get_integration_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(find_order_query, [order_id])
            order_row = cur.fetchone()

            if not order_row:
                return []

            order_uuid = order_row['id']
            cur.execute(generations_query, [order_uuid, order_uuid])
            rows = cur.fetchall()
            return [dict(row) for row in rows]


def fetch_sample_events_for_order(order_id: str) -> list[dict]:
    """
    Fetch all sample status events for an order.

    Args:
        order_id: The WordPress order ID (string)

    Returns:
        List of sample event dicts
    """
    find_order_query = """
        SELECT id FROM order_submissions WHERE order_id = %s
    """

    events_query = """
        SELECT
            id,
            sample_id,
            transition,
            new_status,
            event_id,
            event_timestamp,
            wp_notified,
            wp_status_sent,
            wp_error,
            created_at
        FROM sample_status_events
        WHERE order_submission_id = %s
        ORDER BY created_at DESC
    """

    with get_integration_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(find_order_query, [order_id])
            order_row = cur.fetchone()

            if not order_row:
                return []

            cur.execute(events_query, [order_row['id']])
            rows = cur.fetchall()
            return [dict(row) for row in rows]


def fetch_access_logs_for_order(order_id: str) -> list[dict]:
    """
    Fetch all COA access logs for an order.

    Linked via ingestions belonging to this order.

    Args:
        order_id: The WordPress order ID (string)

    Returns:
        List of access log dicts
    """
    find_order_query = """
        SELECT id FROM order_submissions WHERE order_id = %s
    """

    logs_query = """
        SELECT
            l.id,
            l.sample_id,
            l.coa_version,
            l.action,
            l.requester_ip,
            l.user_agent,
            l.requested_by,
            l.timestamp
        FROM coa_access_logs l
        WHERE l.ingestion_id IN (
            SELECT i.id FROM ingestions i WHERE i.order_submission_id = %s
        )
        ORDER BY l.timestamp DESC
    """

    with get_integration_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(find_order_query, [order_id])
            order_row = cur.fetchone()

            if not order_row:
                return []

            cur.execute(logs_query, [order_row['id']])
            rows = cur.fetchall()
            # Convert INET type to string
            for row in rows:
                if row.get('requester_ip') is not None:
                    row['requester_ip'] = str(row['requester_ip'])
            return [dict(row) for row in rows]


def search_sample_ids_by_verification_code(search: str, limit: int = 50) -> list[str]:
    """
    Search for SENAITE sample IDs by verification code (ILIKE).

    Searches both ingestions.verification_code and coa_generations.verification_code.

    Args:
        search: Partial or full verification code to search for
        limit: Max results

    Returns:
        List of distinct sample_id strings (e.g. ["P-0085", "P-0102"])
    """
    query = """
        SELECT DISTINCT sample_id FROM (
            SELECT sample_id FROM ingestions
              WHERE verification_code ILIKE %s AND sample_id IS NOT NULL
            UNION
            SELECT sample_id FROM coa_generations
              WHERE verification_code ILIKE %s AND sample_id IS NOT NULL
        ) combined
        ORDER BY sample_id DESC
        LIMIT %s
    """
    search_term = f"%{search}%"
    with get_integration_db() as conn:
        with conn.cursor() as cur:
            cur.execute(query, [search_term, search_term, limit])
            return [row[0] for row in cur.fetchall()]


def search_sample_ids_by_order_number(search: str, limit: int = 50) -> list[str]:
    """
    Search for SENAITE sample IDs by WordPress order number (ILIKE).

    Searches both:
    - order_submissions.order_number / order_id (stores bare number like "3066")
    - ingestions.order_ref (stores WP-prefixed like "WP-3066")

    Args:
        search: Partial or full order number to search for (e.g. "WP-3066" or "3066")
        limit: Max results

    Returns:
        List of distinct sample_id strings (e.g. ["P-0085", "P-0102"])
    """
    query = """
        SELECT DISTINCT sample_id FROM (
            -- Search via order_submissions join
            SELECT i.sample_id
            FROM ingestions i
            JOIN order_submissions o ON i.order_submission_id = o.id
            WHERE (o.order_number ILIKE %s OR o.order_id ILIKE %s)
              AND i.sample_id IS NOT NULL
            UNION
            -- Search via ingestions.order_ref (has WP- prefix)
            SELECT sample_id
            FROM ingestions
            WHERE order_ref ILIKE %s AND sample_id IS NOT NULL
        ) combined
        ORDER BY sample_id DESC
        LIMIT %s
    """
    search_term = f"%{search}%"
    with get_integration_db() as conn:
        with conn.cursor() as cur:
            cur.execute(query, [search_term, search_term, search_term, limit])
            return [row[0] for row in cur.fetchall()]


def test_connection() -> dict:
    """Test the database connection. Returns status info."""
    config = get_connection_config()
    env = get_environment()
    wordpress_host = get_wordpress_host()
    try:
        with get_integration_db() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                return {
                    "connected": True,
                    "environment": env,
                    "database": config["database"],
                    "host": config["host"],
                    "wordpress_host": wordpress_host,
                }
    except Exception as e:
        return {
            "connected": False,
            "environment": env,
            "wordpress_host": wordpress_host,
            "error": str(e),
        }


# ---------------------------------------------------------------------------
# Sample Preps table — HPLC sample preparation records
# ---------------------------------------------------------------------------

SAMPLE_PREPS_DDL = """
CREATE TABLE IF NOT EXISTS sample_preps (
    -- Identity
    id              SERIAL PRIMARY KEY,
    sample_id       VARCHAR(30)  NOT NULL UNIQUE,   -- e.g. SP-20250302-0001

    -- Wizard session reference (local AccuMk1 session id for traceability)
    wizard_session_id   INTEGER,

    -- Step 1: Sample info
    peptide_id          INTEGER     NOT NULL,
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
    status          VARCHAR(30)  NOT NULL DEFAULT 'in_progress',
    notes           TEXT,

    -- Timestamps (consistent with the rest of the integration DB)
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sample_preps_sample_id    ON sample_preps (sample_id);
CREATE INDEX IF NOT EXISTS idx_sample_preps_senaite_id   ON sample_preps (senaite_sample_id);
CREATE INDEX IF NOT EXISTS idx_sample_preps_created_at   ON sample_preps (created_at DESC);
"""


def ensure_sample_preps_table() -> None:
    """
    Idempotently create the sample_preps table and its indexes.
    Safe to call on every startup — uses CREATE TABLE IF NOT EXISTS.
    """
    with get_integration_db() as conn:
        with conn.cursor() as cur:
            cur.execute(SAMPLE_PREPS_DDL)
        conn.commit()


def _generate_sample_id(cur) -> str:
    """Generate next SP-YYYYMMDD-NNNN id scoped to today."""
    from datetime import date
    prefix = f"SP-{date.today().strftime('%Y%m%d')}-"
    cur.execute(
        "SELECT sample_id FROM sample_preps WHERE sample_id LIKE %s ORDER BY sample_id DESC LIMIT 1",
        [prefix + "%"],
    )
    row = cur.fetchone()
    seq = (int(row[0].split("-")[-1]) + 1) if row else 1
    return f"{prefix}{seq:04d}"


def create_sample_prep(data: dict) -> dict:
    """
    Insert a new sample prep record. Returns the full created row.

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
    ]
    with get_integration_db() as conn:
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
    List sample preps ordered newest-first.
    Optional search matches sample_id, senaite_sample_id, or peptide_name.
    """
    query = """
        SELECT
            id, sample_id, wizard_session_id,
            peptide_id, peptide_name, peptide_abbreviation, senaite_sample_id,
            declared_weight_mg, target_conc_ug_ml, target_total_vol_ul,
            stock_conc_ug_ml, actual_conc_ug_ml,
            status, notes, created_at, updated_at
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

    with get_integration_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(query, params)
            return [dict(r) for r in cur.fetchall()]


def get_sample_prep(sample_prep_id: int) -> Optional[dict]:
    """Fetch a single sample prep by integer id (all columns)."""
    with get_integration_db() as conn:
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

    with get_integration_db() as conn:
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
