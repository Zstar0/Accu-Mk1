"""Grain tests for the /reports/sync-status and /reports/resync source set.

`published_coa_results` is a read model that must mirror published PRIMARY COAs
only — one row per analyte per lab result. Additional COAs (children, i.e.
`parent_generation_id IS NOT NULL`) are rebranded copies of a result that already
has a primary COA and carry no extra lab workload, so they must never enter the
table: they have their own verification_code, and every reader dedupes by
verification_code, so a copy cannot be collapsed and would double-count.

The behaviour under test lives entirely in SQL, so a fake cursor would prove
nothing. These tests execute the real query strings from main against an
in-memory SQLite database. The statements are plain ANSI (no Postgres-specific
syntax), and the same source-set definition was verified read-only against prod
Postgres on 2026-09-10 (2811 published primaries, 2811 present -> zero missing).
"""
import sqlite3

import pytest

import main as main_module


def _db():
    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE coa_generations ("
        " id TEXT, sample_id TEXT, verification_code TEXT, status TEXT,"
        " coa_data TEXT, published_at TEXT, created_at TEXT,"
        " parent_generation_id TEXT)"
    )
    conn.execute("CREATE TABLE published_coa_results (verification_code TEXT)")

    def gen(code, status="published", parent=None, coa_data="{}"):
        conn.execute(
            "INSERT INTO coa_generations"
            " (id, sample_id, verification_code, status, coa_data, published_at,"
            "  created_at, parent_generation_id)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (code, "S-" + code, code, status, coa_data, "2026-09-01", "2026-09-01", parent),
        )

    def report(code):
        conn.execute("INSERT INTO published_coa_results (verification_code) VALUES (?)", (code,))

    # Primary COA, correctly present in the read model.
    gen("PRIM-OK")
    report("PRIM-OK")
    # Primary COA genuinely absent from the read model — a real sync gap.
    gen("PRIM-GAP")
    # Additional COA absent from the read model — expected, not a gap.
    gen("ACOA-GAP", parent="PRIM-OK")
    # Additional COA sitting in the read model (2026-04 backfill leftover) — must be purged.
    gen("ACOA-IN", parent="PRIM-OK")
    report("ACOA-IN")
    # Superseded primary whose row was never cleaned up — must be purged.
    gen("PRIM-SUPERSEDED", status="superseded")
    report("PRIM-SUPERSEDED")

    conn.commit()
    return conn


@pytest.fixture()
def db():
    conn = _db()
    yield conn
    conn.close()


def _codes(conn, sql):
    return {r[0] for r in conn.execute(sql).fetchall()}


def test_additional_coa_absent_from_report_table_is_not_reported_missing(db):
    """An ACOA is a copy of an already-reported result — it is never owed a row."""
    assert "ACOA-GAP" not in _codes(db, main_module._REPORTS_MISSING_CODES_SQL)


def test_primary_coa_absent_from_report_table_is_reported_missing(db):
    """A primary COA that never landed is a real gap and must still be surfaced."""
    assert "PRIM-GAP" in _codes(db, main_module._REPORTS_MISSING_CODES_SQL)


def test_additional_coa_row_in_report_table_is_reported_orphaned(db):
    """Backfilled ACOA rows inflate every dashboard total and must be flagged."""
    assert "ACOA-IN" in _codes(db, main_module._REPORTS_ORPHANED_CODES_SQL)


def test_superseded_primary_row_in_report_table_is_reported_orphaned(db):
    """Pre-existing orphan behaviour must survive the grain change."""
    assert "PRIM-SUPERSEDED" in _codes(db, main_module._REPORTS_ORPHANED_CODES_SQL)


def test_correctly_synced_primary_is_neither_missing_nor_orphaned(db):
    assert "PRIM-OK" not in _codes(db, main_module._REPORTS_MISSING_CODES_SQL)
    assert "PRIM-OK" not in _codes(db, main_module._REPORTS_ORPHANED_CODES_SQL)


def test_resync_backfill_never_selects_an_additional_coa(db):
    """The resync INSERT loop reads this query — an ACOA here corrupts the table."""
    rows = db.execute(main_module._REPORTS_MISSING_ROWS_SQL).fetchall()
    assert [r[2] for r in rows] == ["PRIM-GAP"]


def test_resync_delete_purges_additional_and_superseded_rows_only(db):
    db.execute(main_module._REPORTS_DELETE_ORPHANS_SQL)
    remaining = {r[0] for r in db.execute("SELECT verification_code FROM published_coa_results")}
    assert remaining == {"PRIM-OK"}


def test_source_counts_exclude_additional_coas(db):
    """The banner compares these against the report table; children must not inflate them."""
    assert db.execute(main_module._REPORTS_SOURCE_COUNT_SQL).fetchone()[0] == 2
    assert db.execute(main_module._REPORTS_SOURCE_CODES_SQL).fetchone()[0] == 2
