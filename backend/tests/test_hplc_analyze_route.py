"""The /hplc/analyze request and stored record carry the prep form and the intermediate
vial (plan docs/superpowers/plans/2026-10-31-hplc-results-engine.md, Task 6a).

Three layers, because each can fail on its own:

  * the request model (what is refused at the trust boundary, and what is not),
  * the orchestrator, process_hplc_analysis, which is the first place a liquid or bac
    row is reachable at all (AnalysisInput had no form until now),
  * the route over HTTP against an in-memory SQLite database, which proves the columns,
    the NOT NULL relaxation and, above all, that response_model keeps the new keys.

Every number below is worked by hand from the constants at the top, not read back from
the engine: stock 3000 mg / 997.1 = 3.008725 mL, both dilution steps are 990 / 90 = 11,
and the curve is area 1000 -> 100 ug/mL.
"""
import asyncio
import inspect
from dataclasses import replace
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import database
from calculations.hplc_processor import (
    AnalysisInput,
    CalibrationParams,
    IntermediateWeights,
    PeptideParams,
    WeightInputs,
    calculate_identity,
    process_hplc_analysis,
)
from database import Base
from main import (
    MAX_WEIGHING_MG,
    HPLCAnalysisResponse,
    HPLCAnalyzeRequest,
    HPLCWeightsInput,
    app,
    get_current_user,
    get_db,
    run_hplc_analysis,
)
from models import CalibrationCurve, HPLCAnalysis, Peptide

STOCK = {"stock_vial_empty": 10000.0, "stock_vial_with_diluent": 13000.0}  # 3000 mg of diluent
DILUTION = {
    "dil_vial_empty": 9000.0,
    "dil_vial_with_diluent": 9900.0,  # 900 mg of diluent
    "dil_vial_with_diluent_and_sample": 9990.0,  # 90 mg of stock: (900 + 90) / 90 = 11
}
INTERMEDIATE = {
    "int_vial_empty": 8000.0,
    "int_vial_with_diluent": 8500.0,  # 500 mg of diluent
    "int_vial_with_diluent_and_sample": 8550.0,  # 50 mg of stock: (500 + 50) / 50 = 11
}
FIVE_WEIGHTS = {**STOCK, **DILUTION}
DENSITY = 997.1
INJECTIONS = [
    {"peaks": [{"area": 1000.0, "area_percent": 99.0, "retention_time": 10.0}], "main_peak_index": 0}
]
CONC_UG_ML = 100.0  # (1000 - 0) / 10


def _body(weights=None, **over):
    """A request body as it arrives over the wire."""
    return {
        "sample_id_label": "X",
        "peptide_id": 1,
        "weights": dict(FIVE_WEIGHTS if weights is None else weights),
        "injections": INJECTIONS,
        **over,
    }


def _errors(body):
    with pytest.raises(ValidationError) as caught:
        HPLCAnalyzeRequest.model_validate(body)
    return caught.value.errors(include_url=False)


def _quantity_mg(stock_ml, total):
    """The quantity in mg, multiplied in the engine's order: the stock volume already
    rounded to 6 places, the product rounded once at the end."""
    return round(CONC_UG_ML * total * round(stock_ml, 6) / 1000, 4)


def _bac_ml(mass_mg, water=DENSITY, benzyl=1034.72, stock_mg_ml=9.0):
    """calc.js bacVolumeMl, re-derived: 0.9 % benzyl alcohol is a little denser than water."""
    return (mass_mg / water) / (1 - stock_mg_ml / benzyl + stock_mg_ml / water)


# ---- the request model -------------------------------------------------------


def test_request_defaults_to_powder_with_no_intermediate():
    r = HPLCAnalyzeRequest(
        sample_id_label="X", peptide_id=1, weights=HPLCWeightsInput(**FIVE_WEIGHTS), injections=[]
    )
    assert r.prep_form == "powder"
    assert r.declared_volume_ml is None
    assert r.weights.int_vial_empty is None


def test_response_model_declares_every_new_field():
    declared = set(HPLCAnalysisResponse.model_fields)
    assert {"prep_form", "dilution_factor_steps"} <= declared


def test_an_unknown_prep_form_is_refused_with_the_accepted_list():
    with pytest.raises(ValueError, match="powder, liquid, bac"):
        HPLCAnalyzeRequest(
            sample_id_label="X", peptide_id=1, prep_form="tablet",
            weights=HPLCWeightsInput(**FIVE_WEIGHTS), injections=[],
        )


def test_the_existing_callers_bodies_stay_valid_unchanged():
    # NewAnalysis.tsx:531: five weights (EMPTY_WEIGHTS is all zero until the tech types),
    # no instrument, no form. Zero is accepted on purpose: rejecting it would turn today's
    # refused-with-a-problem-code rows into request errors on a shipped screen.
    new_analysis = _body(
        weights={**{k: 0 for k in FIVE_WEIGHTS}}, sample_id_label="Unknown", calibration_curve_id=None,
    )
    # SamplePrepHplcFlyout.tsx:1327 and :1355: a curve id that can be 0, an instrument id,
    # provenance, standard RTs, the audit trail.
    flyout = _body(
        calibration_curve_id=0, sample_prep_id=7, instrument_id=3, source_sharepoint_folder="F",
        chromatogram_data={"times": [1.0], "signals": [2.0]}, run_group_id="g",
        standard_injection_rts={"BPC157": {"rt": 10.1, "source_sample_id": "P-0111"}},
        debug_log=[{"level": "info", "msg": "m"}],
        source_files=[{"filename": "a.csv", "content": "x", "sha256": "0"}],
    )
    for body in (new_analysis, flyout):
        r = HPLCAnalyzeRequest.model_validate(body)
        assert r.prep_form == "powder"
        assert r.declared_volume_ml is None
        assert r.weights.int_vial_with_diluent is None
    assert HPLCAnalyzeRequest.model_validate(new_analysis).weights.stock_vial_empty == 0.0


@pytest.mark.parametrize("form", ["powder", "bac"])
@pytest.mark.parametrize("field", list(FIVE_WEIGHTS))
@pytest.mark.parametrize("how", ["missing", "null"])
def test_a_weighed_form_refuses_a_blank_weighing_naming_the_field(form, field, how):
    weights = {k: v for k, v in FIVE_WEIGHTS.items() if k != field}
    if how == "null":
        weights[field] = None
    (error,) = _errors(_body(weights=weights, prep_form=form))
    assert error["loc"] == ("weights", field)
    assert field in error["msg"] and form in error["msg"]


def test_every_blank_weighing_is_named_not_just_the_first():
    weights = {"dil_vial_empty": 1.0, "dil_vial_with_diluent": 2.0}
    names = {e["loc"][-1] for e in _errors(_body(weights=weights))}
    assert names == {"stock_vial_empty", "stock_vial_with_diluent", "dil_vial_with_diluent_and_sample"}


def test_a_liquid_row_may_leave_its_stock_vial_unweighed():
    r = HPLCAnalyzeRequest.model_validate(_body(weights=DILUTION, prep_form="liquid", declared_volume_ml=3.0))
    # None, never 0: the engine reads only None as "not weighed".
    assert r.weights.stock_vial_empty is None and r.weights.stock_vial_with_diluent is None


@pytest.mark.parametrize("field", list(DILUTION))
def test_a_liquid_row_still_needs_its_dilution_vial(field):
    weights = {k: v for k, v in DILUTION.items() if k != field}
    (error,) = _errors(_body(weights=weights, prep_form="liquid", declared_volume_ml=3.0))
    assert error["loc"] == ("weights", field)


@pytest.mark.parametrize("bad", [None, 0, -1.0, float("nan"), float("inf")])
def test_a_liquid_row_needs_a_positive_finite_declared_volume(bad):
    over = {} if bad is None else {"declared_volume_ml": bad}
    (error,) = _errors(_body(weights=DILUTION, prep_form="liquid", **over))
    assert error["loc"] == ("declared_volume_ml",)


NON_FINITE_OR_HUGE = [float("nan"), float("inf"), float("-inf"), MAX_WEIGHING_MG * 2, -MAX_WEIGHING_MG * 2, 1e308]


@pytest.mark.parametrize("field", list(FIVE_WEIGHTS) + list(INTERMEDIATE))
@pytest.mark.parametrize("bad", NON_FINITE_OR_HUGE, ids=repr)
def test_every_weighing_refuses_nan_infinity_and_absurd_magnitudes(field, bad):
    (error,) = _errors(_body(weights={**FIVE_WEIGHTS, **INTERMEDIATE, field: bad}))
    assert error["loc"] == ("weights", field)


def test_a_nan_that_python_json_would_accept_is_refused_at_the_model():
    raw = '{"sample_id_label": "X", "peptide_id": 1, "injections": [], "weights": {"stock_vial_empty": NaN}}'
    with pytest.raises(ValidationError) as caught:
        HPLCAnalyzeRequest.model_validate_json(raw)
    assert ("weights", "stock_vial_empty") in {e["loc"] for e in caught.value.errors()}


@pytest.mark.parametrize("reading", [0.0, -0.3, 1.0e-9, 6.0e6, MAX_WEIGHING_MG, -MAX_WEIGHING_MG])
def test_a_real_balance_reading_is_never_refused(reading):
    # 6e6 mg is a 6 kg balance at full scale; the ceiling is 1e9 mg.
    r = HPLCAnalyzeRequest.model_validate(_body(weights={**FIVE_WEIGHTS, "stock_vial_empty": reading}))
    assert r.weights.stock_vial_empty == reading


@pytest.mark.parametrize("given", [
    ("int_vial_empty",),
    ("int_vial_with_diluent",),
    ("int_vial_with_diluent_and_sample",),
    ("int_vial_empty", "int_vial_with_diluent"),
    ("int_vial_empty", "int_vial_with_diluent_and_sample"),
    ("int_vial_with_diluent", "int_vial_with_diluent_and_sample"),
])
def test_a_partly_weighed_intermediate_is_refused_naming_each_missing_weighing(given):
    # Passed on as "no intermediate" this would print a one-step quantity, too low by the
    # intermediate factor (11 here). The engine would catch it as intermediate_unweighed,
    # but the tech deserves the field name.
    weights = {**FIVE_WEIGHTS, **{k: INTERMEDIATE[k] for k in given}}
    missing = set(INTERMEDIATE) - set(given)
    errors = _errors(_body(weights=weights))
    assert {e["loc"] for e in errors} == {("weights", name) for name in missing}


def test_a_whole_intermediate_is_accepted():
    r = HPLCAnalyzeRequest.model_validate(_body(weights={**FIVE_WEIGHTS, **INTERMEDIATE}))
    assert r.weights.int_vial_empty == 8000.0


# ---- the engine: identity -----------------------------------------------------


def _peptide(**over):
    return PeptideParams(**{"reference_rt": 10.0, "rt_tolerance": 0.5, "diluent_density": DENSITY, **over})


def test_a_null_rt_tolerance_gives_a_reason_not_a_crash():
    result = calculate_identity(INJECTIONS, _peptide(rt_tolerance=None))
    assert result["conforms"] is None
    assert "tolerance" in result["error"]


@pytest.mark.parametrize("bad", [float("nan"), float("inf")])
def test_a_non_finite_rt_tolerance_is_a_reason_not_a_silent_verdict(bad):
    # NaN makes `delta <= tolerance` False, which would print "does not conform".
    result = calculate_identity(INJECTIONS, _peptide(rt_tolerance=bad))
    assert result["conforms"] is None and "tolerance" in result["error"]


def test_a_usable_rt_tolerance_still_decides_identity():
    assert calculate_identity(INJECTIONS, _peptide())["conforms"] is True
    assert calculate_identity(INJECTIONS, _peptide(reference_rt=12.0))["conforms"] is False
    assert "reference" in calculate_identity(INJECTIONS, _peptide(reference_rt=None))["error"]


# ---- the orchestrator: the form now reaches the engine ------------------------


def _inp(weights=FIVE_WEIGHTS, **over):
    return AnalysisInput(
        injections=INJECTIONS,
        weights=WeightInputs(
            **{**{k: None for k in {**STOCK, **DILUTION}}, **weights}  # absent means None, as the route passes it
        ),
        calibration=CalibrationParams(slope=10.0, intercept=0.0),
        peptide=_peptide(),
        **over,
    )


def test_the_defaults_are_the_powder_path_untouched():
    explicit = process_hplc_analysis(_inp(form="powder", declared_volume_ml=None))
    assert process_hplc_analysis(_inp()) == explicit
    stock_ml = 3000.0 / DENSITY
    assert explicit["stock_volume_ml"] == round(stock_ml, 6)
    assert explicit["quantity_mg"] == _quantity_mg(stock_ml, 11.0)


def test_a_declared_volume_is_ignored_by_a_powder_row():
    assert process_hplc_analysis(_inp(declared_volume_ml=99.0)) == process_hplc_analysis(_inp())


def test_a_liquid_row_reaches_its_declared_volume_through_the_orchestrator():
    result = process_hplc_analysis(_inp(DILUTION, form="liquid", declared_volume_ml=3.0))
    dilution = result["calculation_trace"]["dilution"]
    assert dilution["problem"] is None
    assert result["stock_volume_ml"] == 3.0
    assert dilution["stock_mass_mg"] is None  # never weighed, so not applicable
    assert result["quantity_mg"] == 3.3  # 100 ug/mL * 11 * 3.0 mL / 1000


def test_a_liquid_row_ignores_stock_weighings_it_was_wrongly_given():
    # The stock vial is never weighed for a liquid; garbage there must not move the number.
    result = process_hplc_analysis(
        _inp({**DILUTION, "stock_vial_empty": 5.0, "stock_vial_with_diluent": 5.0}, form="liquid", declared_volume_ml=3.0)
    )
    assert result["quantity_mg"] == 3.3 and result["calculation_trace"]["dilution"]["problem"] is None


def test_a_liquid_row_without_a_declared_volume_says_why_and_has_no_quantity():
    result = process_hplc_analysis(_inp(DILUTION, form="liquid"))
    assert result["calculation_trace"]["dilution"]["problem"] == "no_declared_volume"
    assert result["quantity_mg"] is None and result["stock_volume_ml"] is None


def test_a_bac_row_reaches_its_density_correction_through_the_orchestrator():
    result = process_hplc_analysis(_inp(form="bac"))
    bac_ml = _bac_ml(3000.0)
    powder_ml = 3000.0 / DENSITY
    assert result["stock_volume_ml"] == round(bac_ml, 6)
    assert result["stock_volume_ml"] < round(powder_ml, 6)  # the mixture is denser: 0.03 % less volume
    assert result["quantity_mg"] == _quantity_mg(bac_ml, 11.0)
    assert result["quantity_mg"] != process_hplc_analysis(_inp())["quantity_mg"]


def test_the_form_and_the_intermediate_compose_through_the_orchestrator():
    result = process_hplc_analysis(
        _inp(DILUTION, form="liquid", declared_volume_ml=3.0, intermediate=IntermediateWeights(**INTERMEDIATE))
    )
    assert result["dilution_factor"] == 121.0  # the TOTAL, stock vial to final vial
    assert result["quantity_mg"] == _quantity_mg(3.0, 121.0)
    assert result["calculation_trace"]["quantity"]["dilution_factor_steps"] == {"intermediate": 11.0, "final": 11.0}


def test_an_unknown_form_raises_naming_the_accepted_list():
    with pytest.raises(ValueError, match="powder, liquid, bac"):
        process_hplc_analysis(_inp(form="tablet"))


# ---- the model columns and the migration ---------------------------------------

NEW_COLUMNS = {
    "prep_form": "VARCHAR(10)",
    "declared_volume_ml": "DOUBLE PRECISION",
    "int_vial_empty": "DOUBLE PRECISION",
    "int_vial_with_diluent": "DOUBLE PRECISION",
    "int_vial_with_diluent_and_sample": "DOUBLE PRECISION",
}


def test_every_new_column_is_on_the_model_and_nullable():
    columns = HPLCAnalysis.__table__.columns
    for name in NEW_COLUMNS:
        assert name in columns and columns[name].nullable, name


def test_the_two_stock_weighings_are_nullable_for_a_liquid_row():
    columns = HPLCAnalysis.__table__.columns
    assert columns["stock_vial_empty"].nullable and columns["stock_vial_with_diluent"].nullable
    assert not columns["dil_vial_empty"].nullable  # every form still weighs its dilution vial


def test_every_new_column_has_its_migration_statement():
    # _run_migrations swallows a failed statement and create_all skips an existing table,
    # so a column that is on the model but not in this list simply never exists in prod.
    # Read from source because the list is local to the function.
    source = inspect.getsource(database._run_migrations)
    for name, sql_type in NEW_COLUMNS.items():
        assert f'"ALTER TABLE hplc_analyses ADD COLUMN IF NOT EXISTS {name} {sql_type}"' in source, name
    for name in ("stock_vial_empty", "stock_vial_with_diluent"):
        assert f'"ALTER TABLE hplc_analyses ALTER COLUMN {name} DROP NOT NULL"' in source, name


# ---- the route over HTTP --------------------------------------------------------


@pytest.fixture
def api():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    with Session() as seed:
        peptide = Peptide(name="Test Peptide", abbreviation="TST-1")
        seed.add(peptide)
        seed.flush()
        seed.add(CalibrationCurve(
            peptide_id=peptide.id, slope=10.0, intercept=0.0, r_squared=0.999, is_active=True,
            reference_rt=10.0, rt_tolerance=0.5, diluent_density=DENSITY,
        ))
        seed.commit()
        peptide_id = peptide.id

    def _get_db():
        session = Session()
        try:
            yield session
        finally:
            session.close()

    # Restore, never pop: other test modules install their overrides at import time.
    saved = {key: app.dependency_overrides.get(key) for key in (get_db, get_current_user)}
    app.dependency_overrides[get_db] = _get_db
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=1, email="tech@example.com")
    try:
        yield SimpleNamespace(client=TestClient(app), Session=Session, peptide_id=peptide_id)
    finally:
        for key, value in saved.items():
            if value is None:
                app.dependency_overrides.pop(key, None)
            else:
                app.dependency_overrides[key] = value
        engine.dispose()


def _post(api, **kwargs):
    return api.client.post("/hplc/analyze", json=_body(peptide_id=api.peptide_id, **kwargs))


def _row(api, analysis_id):
    with api.Session() as s:
        return s.get(HPLCAnalysis, analysis_id)


def _row_count(api):
    with api.Session() as s:
        return s.scalar(select(func.count()).select_from(HPLCAnalysis))


def test_a_powder_post_with_no_new_field_computes_as_it_always_did(api):
    r = _post(api)
    assert r.status_code == 201, r.text
    body = r.json()
    stock_ml = 3000.0 / DENSITY
    assert body["quantity_mg"] == _quantity_mg(stock_ml, 11.0)
    assert body["dilution_factor"] == 11.0 and body["stock_volume_ml"] == round(stock_ml, 6)
    # response_model drops any key it does not declare: these two surviving is the test.
    assert body["prep_form"] == "powder"
    assert body["dilution_factor_steps"] == {"intermediate": None, "final": 11.0}
    row = _row(api, body["id"])
    assert row.prep_form == "powder" and row.declared_volume_ml is None and row.int_vial_empty is None


def test_a_two_step_post_stores_the_intermediate_and_reports_both_steps(api):
    r = _post(api, weights={**FIVE_WEIGHTS, **INTERMEDIATE})
    assert r.status_code == 201, r.text
    body = r.json()
    stock_ml = 3000.0 / DENSITY
    assert body["dilution_factor"] == 121.0  # stored as the TOTAL
    assert body["quantity_mg"] == _quantity_mg(stock_ml, 121.0)
    assert body["dilution_factor_steps"] == {"intermediate": 11.0, "final": 11.0}
    row = _row(api, body["id"])
    assert (row.int_vial_empty, row.int_vial_with_diluent, row.int_vial_with_diluent_and_sample) == (8000.0, 8500.0, 8550.0)


def test_a_liquid_post_saves_with_no_stock_weighings(api):
    # The stock columns were NOT NULL, so this 500ed at insert before they were relaxed.
    r = _post(api, weights=DILUTION, prep_form="liquid", declared_volume_ml=3.0)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["prep_form"] == "liquid"
    assert body["stock_volume_ml"] == 3.0 and body["quantity_mg"] == 3.3
    row = _row(api, body["id"])
    assert row.stock_vial_empty is None and row.stock_vial_with_diluent is None
    assert row.prep_form == "liquid" and row.declared_volume_ml == 3.0


def test_a_bac_post_applies_the_density_correction(api):
    r = _post(api, prep_form="bac")
    assert r.status_code == 201, r.text
    assert r.json()["stock_volume_ml"] == round(_bac_ml(3000.0), 6)
    assert r.json()["prep_form"] == "bac"


def test_the_get_routes_carry_the_new_fields_too(api):
    posted = _post(api, weights={**FIVE_WEIGHTS, **INTERMEDIATE}).json()
    got = api.client.get(f"/hplc/analyses/{posted['id']}")
    assert got.status_code == 200
    assert got.json()["prep_form"] == "powder"
    assert got.json()["dilution_factor_steps"] == {"intermediate": 11.0, "final": 11.0}


def test_a_row_saved_before_these_fields_existed_reads_back_with_nulls(api):
    # The 52 dev rows and every prod row: no prep_form column value, no steps in the trace.
    # Fields that were required on the response would 500 both GET routes for all of them.
    with api.Session() as s:
        row = HPLCAnalysis(
            sample_id_label="OLD", peptide_id=api.peptide_id, **FIVE_WEIGHTS,
            calculation_trace={"quantity": {"quantity_mg": 1.0}},
        )
        s.add(row)
        s.commit()
        old_id = row.id
    got = api.client.get(f"/hplc/analyses/{old_id}")
    assert got.status_code == 200, got.text
    assert got.json()["prep_form"] is None and got.json()["dilution_factor_steps"] is None


def test_a_refused_quantity_has_no_steps_but_still_names_the_form(api):
    # A zero stock leg: what the two shipped screens send for an unentered weighing.
    # Accepted, computed, refused with a problem code. Unchanged behaviour.
    r = _post(api, weights={**FIVE_WEIGHTS, "stock_vial_with_diluent": 10000.0})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["quantity_mg"] is None and body["dilution_factor_steps"] is None
    assert body["prep_form"] == "powder"
    assert body["calculation_trace"]["dilution"]["problem"] == "stock_diluent"


def test_an_all_zero_body_from_the_new_analysis_screen_is_still_accepted(api):
    r = _post(api, weights={k: 0 for k in FIVE_WEIGHTS})
    assert r.status_code == 201, r.text
    assert r.json()["quantity_mg"] is None


def test_a_blank_weighing_is_a_422_naming_the_field_and_stores_nothing(api):
    weights = {k: v for k, v in FIVE_WEIGHTS.items() if k != "stock_vial_with_diluent"}
    r = _post(api, weights=weights)
    assert r.status_code == 422
    (detail,) = r.json()["detail"]
    assert detail["loc"] == ["body", "weights", "stock_vial_with_diluent"]
    assert "stock_vial_with_diluent" in detail["msg"] and "powder" in detail["msg"]
    assert _row_count(api) == 0


@pytest.mark.parametrize("literal", ["NaN", "Infinity", "-Infinity", "1e308"])
def test_a_raw_client_cannot_send_a_non_finite_weighing(api, literal):
    # Python's json module accepts NaN and Infinity, so a hand-built body reaches the model.
    raw = ('{"sample_id_label": "X", "peptide_id": %d, "injections": [], "weights": '
           '{"stock_vial_empty": %s, "stock_vial_with_diluent": 13000, "dil_vial_empty": 9000, '
           '"dil_vial_with_diluent": 9900, "dil_vial_with_diluent_and_sample": 9990}}') % (api.peptide_id, literal)
    r = api.client.post("/hplc/analyze", content=raw, headers={"content-type": "application/json"})
    assert r.status_code == 422, r.text
    assert r.json()["detail"][0]["loc"] == ["body", "weights", "stock_vial_empty"]
    assert _row_count(api) == 0


def test_a_partial_intermediate_is_a_422_not_a_one_step_quantity(api):
    r = _post(api, weights={**FIVE_WEIGHTS, "int_vial_empty": 8000.0, "int_vial_with_diluent": 8500.0})
    assert r.status_code == 422
    assert r.json()["detail"][0]["loc"] == ["body", "weights", "int_vial_with_diluent_and_sample"]
    assert _row_count(api) == 0


def test_an_unknown_prep_form_is_a_422_listing_the_forms(api):
    r = _post(api, prep_form="tablet")
    assert r.status_code == 422
    assert "powder, liquid, bac" in r.json()["detail"][0]["msg"]


def test_a_raw_client_cannot_send_a_non_finite_declared_volume(api):
    raw = ('{"sample_id_label": "X", "peptide_id": %d, "injections": [], "prep_form": "liquid", '
           '"declared_volume_ml": NaN, "weights": {"dil_vial_empty": 9000, "dil_vial_with_diluent": 9900, '
           '"dil_vial_with_diluent_and_sample": 9990}}') % api.peptide_id
    r = api.client.post("/hplc/analyze", content=raw, headers={"content-type": "application/json"})
    assert r.status_code == 422, r.text
    assert r.json()["detail"][0]["loc"] == ["body", "declared_volume_ml"]


def test_a_partial_intermediate_that_got_past_the_model_is_still_refused_by_the_engine(api):
    # Defence in depth: model_construct skips validation, as a future caller or a changed
    # validator might. The route must hand the engine the partial intermediate (which
    # refuses it) and not read "some missing" as "none declared", which would print a
    # one-step quantity too low by the intermediate factor.
    request = HPLCAnalyzeRequest.model_construct(
        sample_id_label="X", peptide_id=api.peptide_id, injections=INJECTIONS,
        weights=HPLCWeightsInput.model_construct(
            **FIVE_WEIGHTS, int_vial_empty=8000.0, int_vial_with_diluent=8500.0, int_vial_with_diluent_and_sample=None
        ),
    )
    with api.Session() as db:
        response = asyncio.run(
            run_hplc_analysis(request, db=db, current_user=SimpleNamespace(id=1, email="tech@example.com"))
        )
    assert response.quantity_mg is None
    assert response.calculation_trace["dilution"]["problem"] == "intermediate_unweighed"
