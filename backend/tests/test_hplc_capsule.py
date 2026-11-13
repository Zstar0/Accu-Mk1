"""Capsule in the HPLC results engine (plan 2026-11-12-hplc-prep-worksheet, Task 1).

A capsule is prepped as a powder: several capsules are emptied into one weighed stock vial
and injected neat. The rule the lab's owner set on 2026-11-12 is that a capsule's reported
quantity is PER CAPSULE: the mass found in the stock divided by how many capsules went in,
before the result is rounded and before the too-small-to-report check.

The Postgres test at the bottom runs the real migration SQL in a throwaway schema of the
database the backend is configured for, and skips where there is none (a laptop with no
Postgres). Run it in the stack harness:

    bash C:/tmp/hplc-build/stack-pytest-ws.sh tests/test_hplc_capsule.py -q -rs
"""
from dataclasses import replace

import pytest

from calculations.hplc_processor import (
    PREP_FORMS,
    AnalysisInput,
    CalibrationParams,
    PeptideParams,
    WeightInputs,
    calculate_dilution_factor,
    calculate_quantity,
    process_hplc_analysis,
    stock_volume_ml,
)
from main import HPLCAnalysisResponse
from tests.test_hplc_analyze_route import (  # noqa: F401  (api is a fixture)
    CONC_UG_ML,
    DENSITY,
    DILUTION,
    _errors,
    _body,
    _post,
    _row,
    api,
)

# Four 10 mg capsules emptied into one stock vial and injected neat: the "+ diluent"
# weighing equals the empty one, so no diluent was added and the factor is 1.
NEAT = WeightInputs(1000.0, 3006.0, 1000.0, 1000.0, 1200.0)
NEAT_STOCK_ML = 2006.0 / DENSITY


def _input(form="powder", capsules=None, area=198_830.0, weights=NEAT):
    """One AnalysisInput on the neat vial. Area 198 830 on a slope of 10 is 19 883 ug/mL,
    which over the 2.0118 mL stock is about 40 mg."""
    return AnalysisInput(
        injections=[{"peaks": [{"area": area, "area_percent": 99.0, "retention_time": 10.0}], "main_peak_index": 0}],
        weights=weights,
        calibration=CalibrationParams(slope=10.0, intercept=0.0),
        peptide=PeptideParams(reference_rt=10.0, rt_tolerance=0.5, diluent_density=DENSITY),
        form=form,
        capsules_used=capsules,
    )


def _quantity(form, capsules, **over):
    return process_hplc_analysis(_input(form, capsules, **over))


# ---- the engine ----------------------------------------------------------------


def test_capsule_stock_volume_is_a_powders():
    w = WeightInputs(1000.0, 3006.0, 1000.0, 1000.0, 1200.0)
    assert stock_volume_ml("capsule", w, 997.1) == stock_volume_ml("powder", w, 997.1)


def test_capsule_quantity_is_per_capsule():
    # four 10 mg capsules in one stock, injected neat: the stock holds about 40 mg
    total = _quantity(form="powder", capsules=None)
    per = _quantity(form="capsule", capsules=4)
    assert total["quantity_mg"] == pytest.approx(40.0, abs=0.01)
    assert per["quantity_mg"] == pytest.approx(total["quantity_mg"] / 4, abs=1e-4)
    assert per["calculation_trace"]["quantity"]["capsule_total_mg"] == pytest.approx(total["quantity_mg"], abs=1e-4)
    assert per["calculation_trace"]["quantity"]["capsules_used"] == 4


def test_the_per_capsule_figure_is_rounded_once_from_the_unrounded_total():
    # Divided before rounding: rounding the total first and dividing that would be off by
    # up to 0.00005 / n, and the brief puts the division ahead of the rounding.
    per = _quantity("capsule", 3)
    mass_mg = (198_830.0 / 10.0) * 1.0 * round(NEAT_STOCK_ML, 6) / 1000  # conc * factor * stock
    assert per["quantity_mg"] == round(mass_mg / 3, 4)


def test_a_capsule_row_is_otherwise_a_powder_row():
    powder = _quantity("powder", None)
    capsule = _quantity("capsule", 1)
    assert capsule["quantity_mg"] == powder["quantity_mg"]  # one capsule is the whole stock
    assert capsule["stock_volume_ml"] == powder["stock_volume_ml"]
    assert capsule["dilution_factor"] == powder["dilution_factor"] == 1.0
    assert capsule["calculation_trace"]["dilution"]["form"] == "capsule"


def test_a_neat_vial_has_a_factor_of_one():
    w = WeightInputs(1000.0, 3006.0, 1000.0, 1000.0, 1200.0)   # "+ diluent" == empty: no diluent
    d = calculate_dilution_factor(w, 997.1, form="capsule")
    assert d["problem"] is None and d["dilution_factor_total"] == 1.0


def test_too_small_is_judged_on_the_per_capsule_figure():
    # About 0.004 mg in the stock, which reports; a tenth of it per capsule is 0.0004 mg,
    # which rounds away at the three places the vial carries, so it must not report.
    area = 0.004 * 1000 / round(NEAT_STOCK_ML, 6) * 10.0
    total = _quantity("powder", None, area=area)
    assert total["quantity_mg"] == pytest.approx(0.004, abs=1e-6)
    per = _quantity("capsule", 10, area=area)
    assert per["quantity_mg"] is None
    q = per["calculation_trace"]["quantity"]
    assert q["error"] == "quantity_below_precision"
    assert q["capsules_used"] == 10 and q["capsule_total_mg"] == pytest.approx(0.004, abs=1e-6)


def test_a_capsule_with_no_usable_count_reports_nothing_never_the_stock_total():
    for bad in (None, 0, -2, True, 2.0):
        result = _quantity("capsule", bad)
        assert result["quantity_mg"] is None, bad
        assert result["calculation_trace"]["quantity"] == {"quantity_mg": None, "error": "no_capsule_count"}, bad


def test_a_count_on_any_other_form_changes_nothing():
    for form in ("powder", "bac"):
        assert _quantity(form, 4) == _quantity(form, None)
    liquid = replace(_input("liquid", None, weights=replace(NEAT, stock_vial_empty=None, stock_vial_with_diluent=None)),
                     declared_volume_ml=2.0)
    assert process_hplc_analysis(replace(liquid, capsules_used=4)) == process_hplc_analysis(liquid)


def test_calculate_quantity_refuses_a_count_that_is_not_one():
    d = calculate_dilution_factor(NEAT, DENSITY, form="capsule")
    inj = _input().injections
    for bad in (0, -1, True, 2.5):
        with pytest.raises(ValueError, match="capsules_used"):
            calculate_quantity(inj, CalibrationParams(10.0, 0.0), d, capsules_used=bad)


def test_endo_forms_are_still_a_subset_of_prep_forms():
    from worksheets_endo import ENDO_FORMS

    assert set(ENDO_FORMS) <= set(PREP_FORMS)
    assert "capsule" in PREP_FORMS


# ---- the route -------------------------------------------------------------------


def test_route_requires_a_count_for_a_capsule():
    for over in ({}, {"capsules_used": None}):
        (error,) = _errors(_body(prep_form="capsule", **over))
        assert error["loc"] == ("capsules_used",) and "capsules_used" in error["msg"]
    for bad in (0, -1, True, 2.5, "3"):
        errors = _errors(_body(prep_form="capsule", capsules_used=bad))
        assert [e["loc"] for e in errors] == [("capsules_used",)], bad


def test_route_refuses_a_count_on_a_powder():
    for form, over in (("powder", {}), ("bac", {}), ("liquid", {"declared_volume_ml": 3.0})):
        weights = DILUTION if form == "liquid" else None
        (error,) = _errors(_body(weights=weights, prep_form=form, capsules_used=2, **over))
        assert error["loc"] == ("capsules_used",) and form in error["msg"]


def test_a_capsule_needs_its_stock_vial_weighed_like_a_powder():
    errors = _errors(_body(weights=DILUTION, prep_form="capsule", capsules_used=2))
    assert {e["loc"] for e in errors} == {("weights", "stock_vial_empty"), ("weights", "stock_vial_with_diluent")}


def test_route_stores_and_returns_capsules_used(api):
    assert "capsules_used" in HPLCAnalysisResponse.model_fields
    r = _post(api, prep_form="capsule", capsules_used=4)
    assert r.status_code == 201, r.text
    body = r.json()
    stock_ml = round(3000.0 / DENSITY, 6)
    assert body["prep_form"] == "capsule" and body["capsules_used"] == 4
    assert body["quantity_mg"] == round(CONC_UG_ML * 11.0 * stock_ml / 1000 / 4, 4)
    assert _row(api, body["id"]).capsules_used == 4
    got = api.client.get(f"/hplc/analyses/{body['id']}")
    assert got.status_code == 200 and got.json()["capsules_used"] == 4
    # A powder row stores NULL: the column means something only to a capsule row.
    powder = _post(api).json()
    assert powder["capsules_used"] is None and _row(api, powder["id"]).capsules_used is None


# ---- the schema --------------------------------------------------------------------


def test_capsules_used_is_a_nullable_column_with_its_migration_and_its_post_deploy_check():
    import inspect

    import database
    from models import HPLCAnalysis
    from scripts.check_hplc_columns import EXPECTED, FORMS_PREP

    assert HPLCAnalysis.__table__.columns["capsules_used"].nullable
    source = inspect.getsource(database._run_migrations)
    assert '"ALTER TABLE hplc_analyses ADD COLUMN IF NOT EXISTS capsules_used INTEGER"' in source
    assert EXPECTED["capsules_used"] == "YES" and FORMS_PREP["capsule"] == "capsule"


def test_the_widen_runs_after_the_add_only_check_and_before_the_capsule_fill():
    from tests.test_sample_forms_schema import _captured

    sqls = _captured()
    add_only, widen = [i for i, s in enumerate(sqls) if "ck_lims_sample_forms_hplc_prep" in s]
    old_fill, capsule_fill = [i for i, s in enumerate(sqls) if "UPDATE lims_sample_forms SET hplc_prep" in s]
    seed = next(i for i, s in enumerate(sqls) if "INSERT INTO lims_sample_forms" in s)
    assert add_only < widen < seed < old_fill < capsule_fill
    assert "hplc_prep IN ('powder','liquid','capsule')" in sqls[widen]
    assert "'capsule'" not in sqls[old_fill]  # a failed widen must not take the powder fill down too
    assert "WHERE hplc_prep IS NULL" in sqls[capsule_fill]


def test_the_model_check_allows_a_capsule_form_and_still_refuses_bac(db_session):
    from sqlalchemy.exc import IntegrityError

    from models import LimsSampleForm

    db_session.add(LimsSampleForm(name="Softgel", route="oral", hplc_prep="capsule"))
    db_session.flush()  # no raise
    db_session.add(LimsSampleForm(name="Gel", route="oral", hplc_prep="bac"))
    with pytest.raises(IntegrityError):
        db_session.flush()


_SCHEMA = "hplc_capsule_check_test"
_OLD_CHECK = "CHECK (hplc_prep IN ('powder','liquid'))"


@pytest.fixture
def db():
    """lims_sample_forms alone, in a throwaway schema of the configured Postgres."""
    from sqlalchemy import create_engine, text
    from sqlalchemy.exc import OperationalError

    import database

    if not database.DATABASE_URL.startswith("postgresql"):
        pytest.skip("needs Postgres")
    admin = create_engine(database.DATABASE_URL)
    try:
        with admin.begin() as c:
            c.execute(text(f"DROP SCHEMA IF EXISTS {_SCHEMA} CASCADE"))
            c.execute(text(f"CREATE SCHEMA {_SCHEMA}"))
    except OperationalError:
        admin.dispose()
        pytest.skip("no Postgres reachable at the configured MK1_DB_* address")
    engine = create_engine(database.DATABASE_URL, connect_args={"options": f"-csearch_path={_SCHEMA}"})
    try:
        # The table as the boot builds it on prod (create_all never reaches an existing
        # table), with a stub for the one table its foreign key names.
        with engine.begin() as c:
            c.execute(text("CREATE TABLE users (id SERIAL PRIMARY KEY)"))
        _boot(engine, _migration("CREATE TABLE IF NOT EXISTS lims_sample_forms")
              + _migration("ALTER TABLE lims_sample_forms ADD COLUMN IF NOT EXISTS"))
        yield engine
    finally:
        engine.dispose()
        with admin.begin() as c:
            c.execute(text(f"DROP SCHEMA IF EXISTS {_SCHEMA} CASCADE"))
        admin.dispose()


def _migration(*needles):
    """The real boot statements that mention every needle, in boot order."""
    from tests.test_sample_forms_schema import _captured

    return [s for s in _captured() if all(n in s for n in needles)]


def _boot(engine, statements):
    from sqlalchemy import text

    for sql in statements:  # one statement, one commit, as _run_migrations runs them
        with engine.begin() as c:
            c.execute(text(sql))


def _check(engine):
    from sqlalchemy import text

    with engine.connect() as c:
        return c.execute(text(
            "SELECT oid, pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE conname = 'ck_lims_sample_forms_hplc_prep' AND conrelid = 'lims_sample_forms'::regclass"
        )).one_or_none()


def _set_check(engine, definition):
    from sqlalchemy import text

    with engine.begin() as c:
        c.execute(text("ALTER TABLE lims_sample_forms DROP CONSTRAINT IF EXISTS ck_lims_sample_forms_hplc_prep"))
        if definition:
            c.execute(text(f"ALTER TABLE lims_sample_forms ADD CONSTRAINT ck_lims_sample_forms_hplc_prep {definition}"))


def _insert(engine, name, prep):
    from sqlalchemy import text

    with engine.begin() as c:
        c.execute(text(
            "INSERT INTO lims_sample_forms (name, route, is_default, active, sort_order, hplc_prep) "
            "VALUES (:n, 'oral', false, true, 0, :p)"), {"n": name, "p": prep})


def test_the_capsule_form_row_is_backfilled_and_the_check_allows_it(db):
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    checks = _migration("ck_lims_sample_forms_hplc_prep")
    fills = _migration("UPDATE lims_sample_forms SET hplc_prep")
    assert len(checks) == 2 and len(fills) == 2  # add-only then widen; powder/liquid then capsule

    for start in (_OLD_CHECK, None):  # a database that has the old CHECK, and one with none
        _set_check(db, start)
        _boot(db, checks)
        oid, definition = _check(db)
        assert "capsule" in definition and "powder" in definition and "liquid" in definition, start
        _boot(db, checks)  # every later boot: nothing happens
        assert _check(db) == (oid, definition), start

    with db.begin() as c:
        c.execute(text("DELETE FROM lims_sample_forms"))
    for name, prep in (("Capsule", None), ("Lyophilized Powder", None), ("Tablet", None),
                       ("Pen", None), (" capsule two", None)):
        _insert(db, name, prep)
    _boot(db, fills)
    with db.connect() as c:
        got = dict(c.execute(text("SELECT name, hplc_prep FROM lims_sample_forms")).all())
    assert got == {"Capsule": "capsule", "Lyophilized Powder": "powder", "Tablet": None,
                   "Pen": None, " capsule two": None}

    # A value set by hand is never overwritten on a later boot.
    with db.begin() as c:
        c.execute(text("UPDATE lims_sample_forms SET hplc_prep = 'powder' WHERE name = 'Capsule'"))
    _boot(db, fills)
    with db.connect() as c:
        assert c.execute(text("SELECT hplc_prep FROM lims_sample_forms WHERE name = 'Capsule'")).scalar() == "powder"

    # The CHECK still refuses what is not a prep kind a form can hold.
    with pytest.raises(IntegrityError):
        _insert(db, "Gel", "bac")
