# backend/customer_insights/sources.py
"""SQL readers + 60 s cached Dataset loader. IS DB via get_integration_db (psycopg2)."""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime

import psycopg2.errors
from sqlalchemy.orm import Session

from customer_insights.dataset import Dataset, build_dataset
from customer_insights.rules import UNPAID_STATUSES
from integration_db import get_integration_db

WC_ORDERS_SQL = """
    SELECT id, order_number, customer_id, billing_email, status, total, discount_total,
           refund_total, coupon_codes, line_items, date_paid_gmt, coupon_lines
    FROM wc_orders
    WHERE date_paid_gmt IS NOT NULL AND status <> ALL(%s)
"""
# One row per order: IS has UNIQUE(order_id) (uq_order_submissions_order_id); DISTINCT ON is defensive.
SUBMISSIONS_SQL = """
    SELECT DISTINCT ON (oid) oid, samples, is_retest, retest_of_order_id, is_transfer, billing
    FROM (
        SELECT CASE WHEN order_id ~ '^[0-9]+$' THEN order_id::bigint END AS oid, payload->'samples' AS samples,
               COALESCE(is_retest, false) AS is_retest, retest_of_order_id,
               COALESCE(is_transfer, false) AS is_transfer, payload->'billing' AS billing, created_at, id
        FROM order_submissions
    ) s
    WHERE oid IS NOT NULL
    ORDER BY oid, created_at DESC, id DESC
"""
# Rep sources, both user meta mirrored in wc_customers.meta_data:
#   agent_history = accumark-commissions `accumark_agent_history` (canonical; JSON [{agent_id, from}])
#   rep_id        = SalesKing `salesking_assigned_agent` (an agent's WP user id, or "none"; fallback)
# ponytail: the customer reconcile skips rows whose WC date_modified did not move, and SalesKing
# reassignments do not bump it, so reps drift until a customer backfill; fix in IS if it bites.
CUSTOMERS_SQL = """
    SELECT id, email, first_name, last_name, company_name,
           (SELECT m->>'value' FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(meta_data) = 'array' THEN meta_data ELSE '[]'::jsonb END) m
            WHERE m->>'key' = 'salesking_assigned_agent' LIMIT 1) AS rep_id,
           (SELECT m->'value' FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(meta_data) = 'array' THEN meta_data ELSE '[]'::jsonb END) m
            WHERE m->>'key' = 'accumark_agent_history' LIMIT 1) AS agent_history
    FROM wc_customers WHERE deleted_at IS NULL
"""
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
_load_lock = threading.Lock()  # single-flight: concurrent cache misses share one load
logger = logging.getLogger(__name__)


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
        logger.exception("customer_insights.sla_records_failed")
        return None


def _cached() -> Dataset | None:
    with _lock:
        hit = _cache.get("ds")
        return hit[1] if hit and time.monotonic() - hit[0] < _CACHE_SECONDS else None


def load_dataset(db: Session, now: datetime) -> Dataset:
    if (ds := _cached()) is not None:
        return ds
    with _load_lock:
        if (ds := _cached()) is not None:  # another caller loaded it while we waited
            return ds
        with get_integration_db() as conn, conn.cursor() as cur:
            try:
                cur.execute(WC_ORDERS_SQL, (list(UNPAID_STATUSES),))
                order_rows = cur.fetchall()
                cur.execute(SYNCED_SQL)
                synced_at = cur.fetchone()[0]
            except psycopg2.errors.UndefinedTable:  # wc_orders not migrated yet: empty, not 500
                logger.warning("customer_insights.wc_orders_missing")
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
