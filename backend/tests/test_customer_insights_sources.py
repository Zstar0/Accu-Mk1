# backend/tests/test_customer_insights_sources.py
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone

import psycopg2
import psycopg2.errors
import pytest

from customer_insights import sources

NOW = datetime(2026, 10, 5, 18, tzinfo=timezone.utc)


class _Cur:
    def __init__(self, fail_on_orders):
        self.fail_on_orders = fail_on_orders

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.sql = sql
        if sql is sources.WC_ORDERS_SQL and self.fail_on_orders:
            raise self.fail_on_orders

    def fetchall(self):
        return []

    def fetchone(self):
        return (None,)


class _Conn:
    def __init__(self, fail_on_orders=None):
        self.fail_on_orders = fail_on_orders
        self.rollbacks = 0

    def cursor(self):
        return _Cur(self.fail_on_orders)

    def rollback(self):
        self.rollbacks += 1


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    sources.clear_cache()
    monkeypatch.setattr(sources, "_sla_records", lambda db, now: None)
    yield
    sources.clear_cache()


def _use(monkeypatch, conn):
    @contextmanager
    def fake():
        yield conn
    monkeypatch.setattr(sources, "get_integration_db", fake)


def test_missing_wc_orders_table_is_an_empty_dataset(monkeypatch) -> None:
    conn = _Conn(psycopg2.errors.UndefinedTable("relation \"wc_orders\" does not exist"))
    _use(monkeypatch, conn)
    ds = sources.load_dataset(None, NOW)
    assert ds.orders == () and ds.synced_at is None and conn.rollbacks == 1


def test_other_is_errors_propagate_and_are_not_cached(monkeypatch) -> None:
    _use(monkeypatch, _Conn(psycopg2.OperationalError("server closed the connection")))
    with pytest.raises(psycopg2.OperationalError):
        sources.load_dataset(None, NOW)
    assert sources._cache == {}


def test_concurrent_cache_misses_share_one_load(monkeypatch) -> None:
    _use(monkeypatch, _Conn())
    calls = []
    real = sources.build_dataset

    def slow_build(**kw):
        calls.append(1)
        time.sleep(0.2)
        return real(**kw)

    monkeypatch.setattr(sources, "build_dataset", slow_build)
    start = threading.Barrier(4)
    results = []

    def worker():
        start.wait()
        results.append(sources.load_dataset(None, NOW))

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(calls) == 1
    assert len(results) == 4 and all(r is results[0] for r in results)
