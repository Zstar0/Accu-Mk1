"""The S9 pre-deploy gate script — same run/report contract as the S3
identity precheck: env named, exit 0/3, diagnostics never crash."""
import logging

from sqlalchemy import text

from models import AnalysisProfile
from scripts.s9_demand_precheck import run_precheck
from tests._demand_catalog_helpers import _seed_legacy_ok, _mk_profile


def test_clean_db_exits_zero(db_session, capsys):
    _seed_legacy_ok(db_session)
    assert run_precheck(db_session, "test-env") == 0
    out = capsys.readouterr().out
    assert "environment: test-env" in out
    assert "=== clean ===" in out


def test_legacy_key_states_reported(db_session, capsys):
    """Absorbs the slice's manual pre-deploy SQL audit — the four legacy
    rows' vials_required/fulfillment_role/fulfillment_dim/active state is
    visible in every gate run, clean or not."""
    _seed_legacy_ok(db_session)
    assert run_precheck(db_session, "test-env") == 0
    out = capsys.readouterr().out
    assert ("legacy key hplcpurity_identity: vials_required=1 "
            "fulfillment_role=hplc fulfillment_dim=role active=True") in out
    assert ("legacy key bac_water_panel: vials_required=1 "
            "fulfillment_role=hplc fulfillment_dim=role active=True") in out
    assert ("legacy key endotoxin: vials_required=1 "
            "fulfillment_role=endo fulfillment_dim=role active=True") in out
    assert ("legacy key sterility_pcr: vials_required=1 "
            "fulfillment_role=ster fulfillment_dim=role active=True") in out


def test_legacy_key_missing_reported(db_session, capsys):
    _seed_legacy_ok(db_session)
    db_session.query(AnalysisProfile).filter_by(key="endotoxin").delete()
    assert run_precheck(db_session, "test-env") == 3
    out = capsys.readouterr().out
    assert "legacy key endotoxin: MISSING" in out


def test_empty_catalog_exits_zero_with_note(db_session, capsys):
    assert run_precheck(db_session, "test-env") == 0
    assert "catalog" in capsys.readouterr().out.lower()


def test_violations_exit_three_and_report(db_session, capsys):
    _seed_legacy_ok(db_session)
    _mk_profile(db_session, "heavy_metals", role=None)
    assert run_precheck(db_session, "test-env") == 3
    out = capsys.readouterr().out
    assert "heavy_metals" in out


def test_partial_migration_missing_vial_roles_reports_absent_not_crash(db_session, capsys):
    """verify_demand_catalog also reads vial_roles (VialRole.code /
    .department_id), not just analysis_profiles. database.py's migration
    runner commits each CREATE TABLE statement individually and swallows a
    failure into a "migration_skipped" warning (database.py:1636-1649) —
    the same swallowing behavior the S3 precheck's docstring exists to guard
    against — and vial_roles' CREATE TABLE statement comes AFTER analysis_
    profiles' in that list, so a DB with analysis_profiles present (and
    non-empty) but vial_roles missing is a real partial-migration shape, not
    a hypothetical. Must report the catalog layer absent and exit 0, never
    crash on the VialRole query — the exact class of failure the S3 script
    hit in prod on 2026-08-14 (UndefinedColumn, after its gates had already
    passed)."""
    from models import AnalysisProfile
    db_session.add(AnalysisProfile(
        key="hplcpurity_identity", name="T", is_addon=True, vials_required=1,
        fulfillment_dim="role", fulfillment_role="hplc", active=True,
    ))
    db_session.flush()
    db_session.execute(text("DROP TABLE vial_roles"))

    code = run_precheck(db_session, "test-env")
    out = capsys.readouterr().out

    assert code == 0
    assert "vial_roles" in out
    assert "absent" in out.lower()
