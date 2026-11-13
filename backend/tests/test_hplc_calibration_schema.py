"""Calibration Curve Worksheet, Task 1 of plan 2026-11-13-hplc-calibration-curve-worksheet:
the hplc_calibration_sheets table, the new nullable calibration_curves columns, and the
"net, entered by hand" / "worksheet" tag on the curve read model.

Runs against the Postgres database database.py is configured for, which must be a
scratch copy (the harness clones one per run). The boot migrations are applied to it
first, as a deploy would, so the tests prove the statements an existing database gets:

    HPLC_SCRATCH=p4t1 bash C:/tmp/hplc-build/local-pytest.sh ws tests/test_hplc_calibration_schema.py -q
"""
import re
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, text

import database
from models import CalibrationCurve, Peptide

SHEET_NULLABLE = {
    "id": "NO", "peptide_id": "YES", "instrument_id": "YES", "replicate_of_sheet_id": "YES",
    "inputs": "NO", "version": "NO", "calibration_curve_id": "YES", "filed_at": "YES",
    "created_at": "YES", "updated_at": "YES", "created_by_id": "YES", "updated_by_id": "YES",
}
CURVE_COLUMNS = (
    "cas_number", "net_counterion", "net_counterion_mw", "net_equivalents", "net_free_mw",
    "net_stated_fw", "net_ms_mz", "net_ms_ion", "net_assay_pct", "net_water_pct",
    "net_assumption", "net_factor_computed", "net_factor_applied", "net_override_reason",
    "net_parts_used", "serial_dilution", "calibration_sheet_id", "replicate_of_id", "injection",
)
# (table, column) -> pg_constraint.confdeltype: 'n' SET NULL, 'a' NO ACTION.
FK_DELETE_RULES = {
    ("hplc_calibration_sheets", "peptide_id"): "n",
    ("hplc_calibration_sheets", "replicate_of_sheet_id"): "n",
    ("hplc_calibration_sheets", "calibration_curve_id"): "n",
    ("hplc_calibration_sheets", "created_by_id"): "n",
    ("hplc_calibration_sheets", "updated_by_id"): "n",
    ("hplc_calibration_sheets", "instrument_id"): "a",
    ("calibration_curves", "calibration_sheet_id"): "n",
    ("calibration_curves", "replicate_of_id"): "n",
}
SERIAL = {"stock": {"vial_empty_mg": 5000.1}, "levels": [{"aliquot_ul": 500}],
          "level_volume_ul": 1000, "stock_as_top": False, "top_aliquot_ul": 800,
          "diluent_density_mg_ml": 997.1}
NET = {"cas_number": "80714-61-0", "net_counterion": "TFA", "net_counterion_mw": 114.02,
       "net_equivalents": 2.0, "net_free_mw": 1302.4, "net_stated_fw": 1530.44, "net_ms_mz": 651.7,
       "net_ms_ion": "[M+2H]2+", "net_assay_pct": 98.7, "net_water_pct": 3.1,
       "net_assumption": "2 TFA per molecule", "net_factor_computed": 0.8312,
       "net_factor_applied": 0.85, "net_override_reason": "CoA states net content",
       "net_parts_used": ["assay"], "serial_dilution": SERIAL, "injection": 2}


@pytest.fixture(scope="module")
def migrated():
    name = database.engine.url.database or ""
    if not name.startswith("mk1_test"):
        pytest.skip(f"refusing to migrate {name!r}: run through the scratch-database harness")
    database._run_migrations()


@pytest.fixture
def db(migrated):
    session = database.SessionLocal()
    made = []
    try:
        yield session, made
    finally:
        session.rollback()
        for table, row_id in reversed(made):
            session.execute(text(f"DELETE FROM {table} WHERE id = :id"), {"id": row_id})
        session.commit()
        session.close()


@pytest.fixture
def client(migrated):
    from auth import get_current_user
    from main import app

    saved = dict(app.dependency_overrides)
    app.dependency_overrides[get_current_user] = lambda: MagicMock()
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(saved)


def _peptide(db):
    session, made = db
    pep = Peptide(name="Calibration schema test", abbreviation=f"CALSCHEMA-{len(made)}-{id(made)}")
    session.add(pep)
    session.commit()
    made.append(("peptides", pep.id))
    return pep


def _curve(db, peptide_id, **extra):
    session, made = db
    curve = CalibrationCurve(peptide_id=peptide_id, slope=12.5, intercept=-3.0, r_squared=0.9991,
                             is_active=False, standard_data={"concentrations": [1.0], "areas": [12.0]},
                             **extra)
    session.add(curve)
    session.commit()
    made.append(("calibration_curves", curve.id))
    return curve


def _sheet(db, **values):
    session, made = db
    row_id = session.execute(text(
        "INSERT INTO hplc_calibration_sheets (peptide_id, inputs, calibration_curve_id) "
        "VALUES (:peptide_id, CAST(:inputs AS JSON), :curve_id) RETURNING id"), values).scalar_one()
    session.commit()
    made.append(("hplc_calibration_sheets", row_id))
    return row_id


def _columns(session, table):
    return {name: nullable for name, nullable in session.execute(text(
        "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = :t"),
        {"t": table})}


def test_the_sheet_table_and_curve_columns_exist(db):
    from models import HplcCalibrationSheet

    session, _ = db
    assert _columns(session, "hplc_calibration_sheets") == SHEET_NULLABLE
    curves = _columns(session, "calibration_curves")
    assert {name: curves.get(name) for name in CURVE_COLUMNS} == {name: "YES" for name in CURVE_COLUMNS}
    # The model is the source of truth for a fresh database (create_all): same columns.
    assert {c.name for c in HplcCalibrationSheet.__table__.columns} == set(SHEET_NULLABLE)
    assert set(CURVE_COLUMNS) <= {c.name for c in CalibrationCurve.__table__.columns}
    assert all(CalibrationCurve.__table__.columns[name].nullable for name in CURVE_COLUMNS)
    # The version default holds on a row inserted with no version.
    assert session.execute(text(
        "SELECT column_default FROM information_schema.columns "
        "WHERE table_name = 'hplc_calibration_sheets' AND column_name = 'version'")).scalar_one() == "1"


def test_every_new_fk_sets_null_on_delete(db):
    from models import HplcCalibrationSheet

    session, _ = db
    found = {(table, column): rule for table, column, rule in session.execute(text(
        "SELECT c.conrelid::regclass::text, a.attname, c.confdeltype FROM pg_constraint c "
        "JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1] "
        "WHERE c.contype = 'f' AND c.conrelid IN "
        "('hplc_calibration_sheets'::regclass, 'calibration_curves'::regclass)"))}
    assert {key: found.get(key) for key in FK_DELETE_RULES} == FK_DELETE_RULES
    # ... and the model says the same, so a fresh database's create_all builds the same keys.
    tables = {"hplc_calibration_sheets": HplcCalibrationSheet.__table__,
              "calibration_curves": CalibrationCurve.__table__}
    for (table, column), rule in FK_DELETE_RULES.items():
        (fk,) = tables[table].columns[column].foreign_keys
        assert fk.ondelete == ("SET NULL" if rule == "n" else None), (table, column)


def test_deleting_a_filed_curve_nulls_the_sheet_link(db):
    session, _ = db
    pep = _peptide(db)
    curve = _curve(db, pep.id, **NET)
    replicate = _curve(db, pep.id, replicate_of_id=curve.id, injection=2)
    inputs = '{"stock": {"vial_empty_mg": 5000.1}, "levels": [{"aliquot_ul": 500}]}'
    sheet_id = _sheet(db, peptide_id=pep.id, inputs=inputs, curve_id=curve.id)
    session.execute(text("UPDATE calibration_curves SET calibration_sheet_id = :s WHERE id = :c"),
                    {"s": sheet_id, "c": curve.id})
    session.commit()
    gone = {"a": curve.id, "b": replicate.id}

    # Exactly what GET /hplc/peptides/{id}/resync/stream runs ("Add Curve").
    session.execute(delete(CalibrationCurve).where(CalibrationCurve.peptide_id == pep.id))
    session.commit()

    row = session.execute(text(
        "SELECT calibration_curve_id, inputs, version FROM hplc_calibration_sheets WHERE id = :id"),
        {"id": sheet_id}).one()
    assert row.calibration_curve_id is None
    assert row.inputs == {"stock": {"vial_empty_mg": 5000.1}, "levels": [{"aliquot_ul": 500}]}
    assert row.version == 1
    assert session.execute(text("SELECT count(*) FROM calibration_curves WHERE id IN (:a, :b)"),
                           gone).scalar_one() == 0


def test_an_existing_curve_reads_as_entered_by_hand_through_the_list_route(db, client):
    pep = _peptide(db)
    curve = _curve(db, pep.id)
    res = client.get(f"/peptides/{pep.id}/calibrations")
    assert res.status_code == 200
    row = next(r for r in res.json() if r["id"] == curve.id)
    assert row["net_basis"] == "entered_by_hand"
    assert row["net_factor_applied"] is None
    assert {name: row[name] for name in CURVE_COLUMNS} == {name: None for name in CURVE_COLUMNS}
    one = client.get(f"/peptides/{pep.id}/calibrations/{curve.id}").json()
    assert one["net_basis"] == "entered_by_hand"


def test_a_worksheet_curve_keeps_its_net_fields_through_the_list_route(db, client):
    pep = _peptide(db)
    original = _curve(db, pep.id)
    curve = _curve(db, pep.id, replicate_of_id=original.id, **NET)
    sheet_id = _sheet(db, peptide_id=pep.id, inputs="{}", curve_id=curve.id)
    session, _ = db
    session.execute(text("UPDATE calibration_curves SET calibration_sheet_id = :s WHERE id = :c"),
                    {"s": sheet_id, "c": curve.id})
    session.commit()
    want = {**NET, "calibration_sheet_id": sheet_id, "replicate_of_id": original.id}

    listed = client.get(f"/peptides/{pep.id}/calibrations")
    assert listed.status_code == 200
    row = next(r for r in listed.json() if r["id"] == curve.id)
    assert {name: row[name] for name in want} == want
    assert row["net_basis"] == "worksheet"
    one = client.get(f"/peptides/{pep.id}/calibrations/{curve.id}")
    assert one.status_code == 200
    assert {name: one.json()[name] for name in [*want, "net_basis"]} == {**want, "net_basis": "worksheet"}


def test_the_column_check_script_knows_the_new_columns():
    from scripts import check_hplc_columns as check

    assert check.SHEETS_EXPECTED == SHEET_NULLABLE
    assert check.CURVES_EXPECTED == {name: "YES" for name in CURVE_COLUMNS}
    assert check.evaluate({k: ("integer", v) for k, v in SHEET_NULLABLE.items()}, check.SHEETS_EXPECTED)[1] == 0
    assert check.evaluate({}, check.CURVES_EXPECTED)[1] == len(CURVE_COLUMNS)


def test_the_boot_statements_sit_above_the_pinned_last_statement():
    from tests.test_hplc_native_schema import _captured

    stmts = _captured()
    create = [s for s in stmts if "CREATE TABLE IF NOT EXISTS hplc_calibration_sheets" in s]
    assert len(create) == 1
    alters = [s for s in stmts if s.startswith("ALTER TABLE calibration_curves ADD COLUMN IF NOT EXISTS")
              and re.search(r"IF NOT EXISTS (\w+)", s).group(1) in CURVE_COLUMNS]
    assert {re.search(r"IF NOT EXISTS (\w+)", s).group(1) for s in alters} == set(CURVE_COLUMNS)
    # The sheet table first: calibration_sheet_id references it.
    assert stmts.index(create[0]) < min(stmts.index(s) for s in alters)
    assert stmts[-1] == "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS retest_of_sample_id TEXT"
