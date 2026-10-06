# backend/customer_insights/sources.py
"""SQL readers + 60 s cached Dataset loader. IS DB via get_integration_db (psycopg2)."""
from __future__ import annotations

import threading
import time
from datetime import datetime

from sqlalchemy.orm import Session

from customer_insights.dataset import Dataset, build_dataset
from customer_insights.rules import UNPAID_STATUSES
from integration_db import get_integration_db

WC_ORDERS_SQL = """
    SELECT id, order_number, customer_id, billing_email, status, total, discount_total,
           refund_total, coupon_codes, line_items, date_paid_gmt
    FROM wc_orders
    WHERE date_paid_gmt IS NOT NULL AND status <> ALL(%s)
"""
SUBMISSIONS_SQL = """
    SELECT CASE WHEN order_id ~ '^[0-9]+$' THEN order_id::bigint END, payload->'samples', COALESCE(is_retest, false),
           retest_of_order_id, COALESCE(is_transfer, false), payload->'billing'
    FROM order_submissions
    WHERE order_id ~ '^[0-9]+$'
"""
CUSTOMERS_SQL = "SELECT id, email, first_name, last_name, company_name FROM wc_customers WHERE deleted_at IS NULL"
# Published PRIMARY COAs only (same rule as Analyte Trends): one row per COA.
COAS_SQL = """
    SELECT DISTINCT ON (r.verification_code)
           r.order_number, r.sample_id, r.product_name, r.overall_status, r.published_at
    FROM published_coa_results r
    JOIN coa_generations cg ON cg.id = r.coa_generation_id
    WHERE cg.status = 'published' AND cg.parent_generation_id IS NULL
      AND (r.is_blend_overall OR NOT r.is_blend)
    ORDER BY r.verification_code, r.id
"""
SYNCED_SQL = "SELECT max(synced_at) FROM wc_orders"

_CACHE_SECONDS = 60
_cache: dict[str, tuple[float, Dataset]] = {}
_lock = threading.Lock()


def _sla_records(db: Session, now: datetime) -> list[dict] | None:
    """Per-sample SLA records (Task 7 adds sla_perf.sample_records). None until then / on failure."""
    try:
        from sla_perf import sample_records  # noqa: F401  (added in Task 7)
    except ImportError:
        return None
    import main  # local: main imports this package's router

    try:
        return main.sla_sample_records(db, now)
    except Exception:
        return None


def load_dataset(db: Session, now: datetime) -> Dataset:
    with _lock:
        hit = _cache.get("ds")
        if hit and time.monotonic() - hit[0] < _CACHE_SECONDS:
            return hit[1]
    with get_integration_db() as conn, conn.cursor() as cur:
        try:
            cur.execute(WC_ORDERS_SQL, (list(UNPAID_STATUSES),))
            order_rows = cur.fetchall()
            cur.execute(SYNCED_SQL)
            synced_at = cur.fetchone()[0]
        except Exception:  # wc_orders not migrated yet (Plan 1 pending): empty, not 500
            conn.rollback()
            order_rows, synced_at = [], None
        cur.execute(SUBMISSIONS_SQL)
        sub_rows = cur.fetchall()
        cur.execute(CUSTOMERS_SQL)
        cust_rows = cur.fetchall()
        cur.execute(COAS_SQL)
        coa_rows = cur.fetchall()
    ds = build_dataset(order_rows=order_rows, submission_rows=sub_rows, customer_rows=cust_rows,
                       coa_rows=coa_rows, sla_records=_sla_records(db, now), synced_at=synced_at)
    with _lock:
        _cache["ds"] = (time.monotonic(), ds)
    return ds


def clear_cache() -> None:
    with _lock:
        _cache.clear()
