"""The S9 pre-deploy gate script — same run/report contract as the S3
identity precheck: env named, exit 0/3, diagnostics never crash."""
import logging

from scripts.s9_demand_precheck import run_precheck
from tests._demand_catalog_helpers import _seed_legacy_ok, _mk_profile


def test_clean_db_exits_zero(db_session, capsys):
    _seed_legacy_ok(db_session)
    assert run_precheck(db_session, "test-env") == 0
    out = capsys.readouterr().out
    assert "environment: test-env" in out
    assert "=== clean ===" in out


def test_empty_catalog_exits_zero_with_note(db_session, capsys):
    assert run_precheck(db_session, "test-env") == 0
    assert "catalog" in capsys.readouterr().out.lower()


def test_violations_exit_three_and_report(db_session, capsys):
    _seed_legacy_ok(db_session)
    _mk_profile(db_session, "heavy_metals", role=None)
    assert run_precheck(db_session, "test-env") == 3
    out = capsys.readouterr().out
    assert "heavy_metals" in out
