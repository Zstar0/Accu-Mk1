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
