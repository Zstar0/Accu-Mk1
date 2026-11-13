"""Calibration Curve Worksheet, Task 5 of plan 2026-11-13-hplc-calibration-curve-worksheet:
"File curve" turns a worked-out sheet into a calibration_curves row (or re-files its own),
decides whether it becomes the active curve, and re-files an original's other injections.
Through the real app against a scratch Postgres copy that holds real curves:

    HPLC_SCRATCH=p4t5 bash C:/tmp/hplc-build/local-pytest.sh ws tests/test_hplc_calibration_file_api.py -q

Every refusal is checked to write nothing: this peptide's curves, every other curve in the
copy, the sheet row and the curve audit rows are compared before and after.
"""
import copy
import json
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, func, select

import database
import hplc_calibration
from models import (
    AnalysisService,
    AuditLog,
    CalibrationCurve,
    HPLCAnalysis,
    HplcCalibrationSheet,
    Instrument,
    Peptide,
    PeptideAnalyte,
    User,
    WizardSession,
)

CASES = json.loads((Path(__file__).parent / "fixtures" / "hplc_calibration_cases.json").read_text())["cases"]
NEEDS_AREAS = "Type the peak areas of at least two levels first. The sheet is saved; file it once they are in."
CANNOT = "These numbers cannot be worked out. Correct the sheet, save it and file it again."
NO_PEPTIDE = "Pick the compound first. The curve is filed under it."
NO_INSTRUMENT = "Pick the instrument. A curve belongs to the instrument that ran it."
BLEND = "A curve is for one peptide. A blend's components each have their own."
STALE = "Someone else saved this sheet. It has been reloaded."
RESPONSE_KEYS = {"sheet", "curve", "activation", "refiled_curve_ids", "warnings"}
SLOPE_NOT_POSITIVE = ("The fit's slope is not positive, so this is not a usable curve. Check that each peak area "
                      "is typed against its own level.")
DENSITY_RANGE = "Diluent density (mg/mL): must be from 500 to 2000."
DEFAULT_DENSITY = hplc_calibration.HPLC_RUN_PARAM_DEFAULTS["diluent_density_mg_ml"]
SERIAL_KEYS = ("stock", "levels", "level_volume_ul", "stock_as_top", "top_aliquot_ul", "diluent_density_mg_ml")
CURVE_COLUMNS = [c.name for c in CalibrationCurve.__table__.columns]
_REAL_WORK_OUT = hplc_calibration.work_out_sheet


def _case(n):
    """Fixture case n, counted from 1 as the brief counts them."""
    return copy.deepcopy(CASES[n - 1]["inputs"])


def _expect(n):
    return CASES[n - 1]["expect"]


@pytest.fixture(scope="module")
def migrated():
    name = database.engine.url.database or ""
    if not name.startswith("mk1_test"):
        pytest.skip(f"refusing to migrate {name!r}: run through the scratch-database harness")
    database.init_db()


@pytest.fixture
def session(migrated):
    s = database.SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


@pytest.fixture
def user(session):
    u = User(email=f"calfile-{uuid4().hex}@test.local", hashed_password="x")
    session.add(u)
    session.commit()
    return SimpleNamespace(id=u.id, email=u.email)


@pytest.fixture
def client(migrated, user):
    from auth import get_current_user
    from main import app

    saved = dict(app.dependency_overrides)
    app.dependency_overrides[get_current_user] = lambda: user
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(saved)


@pytest.fixture
def seeded(session):
    tag = uuid4().hex[:8]
    pep = Peptide(name="Cal file test", abbreviation=f"CF{tag}")
    other = Peptide(name="Cal file other", abbreviation=f"CFO{tag}")
    blend = Peptide(name="Cal file blend", abbreviation=f"CFBL{tag}", is_blend=True)
    inst = Instrument(name=f"CFA{tag}", active=True)
    inst2 = Instrument(name=f"CFB{tag}", active=True)
    session.add_all([pep, other, blend, inst, inst2])
    session.commit()
    return SimpleNamespace(peptide=pep.id, abbr=pep.abbreviation, other=other.id, blend=blend.id,
                           inst=inst.id, inst_name=inst.name, inst2=inst2.id, inst2_name=inst2.name)


def _sheet(client, seeded, inputs, instrument=None):
    res = client.post("/hplc-calibration-sheets", json={
        "peptide_id": seeded.peptide, "instrument_id": instrument or seeded.inst, "inputs": inputs})
    assert res.status_code == 201, res.text
    return res.json()


def _file(client, sheet_id, version=None):
    """POST file; version None sends the sheet's current version."""
    if version is None:
        got = client.get(f"/hplc-calibration-sheets/{sheet_id}")
        version = got.json()["version"] if got.status_code == 200 else 1
    return client.post(f"/hplc-calibration-sheets/{sheet_id}/file", json={"version": version})


def _filed(client, sheet_id, version=None):
    res = _file(client, sheet_id, version)
    assert res.status_code == 200, res.text
    out = res.json()
    assert set(out) == RESPONSE_KEYS
    assert isinstance(out["warnings"], list)
    return out


def _curve(session, peptide_id, instrument_id, active, name=None):
    curve = CalibrationCurve(peptide_id=peptide_id, slope=3.0, intercept=1.0, r_squared=0.99, is_active=active,
                             instrument_id=instrument_id, source_filename=name or f"old-{uuid4().hex}")
    session.add(curve)
    session.commit()
    return curve.id


def _row(session, curve_id):
    session.expire_all()
    c = session.get(CalibrationCurve, curve_id)
    return {k: copy.deepcopy(getattr(c, k)) for k in CURVE_COLUMNS}


def _world(session, sheet_ids=()):
    """Every curve row whole, the given sheet rows, and the curve audit rows."""
    session.expire_all()
    curves = {c.id: {k: copy.deepcopy(getattr(c, k)) for k in CURVE_COLUMNS}
              for c in session.execute(select(CalibrationCurve)).scalars()}
    sheets = {}
    for sid in sheet_ids:
        s = session.get(HplcCalibrationSheet, sid)
        sheets[sid] = (copy.deepcopy(s.inputs), s.version, s.calibration_curve_id, s.filed_at, s.updated_at)
    audits = session.scalar(select(func.count()).select_from(AuditLog).where(
        AuditLog.entity_type == "calibration_curve"))
    return curves, sheets, audits


def _others(session, seeded):
    """The curves this test did not make: the copy's real ones. Filing must never move them."""
    session.expire_all()
    return session.execute(
        select(CalibrationCurve.id, CalibrationCurve.is_active, CalibrationCurve.slope)
        .where(CalibrationCurve.peptide_id.notin_([seeded.peptide, seeded.other]))
        .order_by(CalibrationCurve.id)).all()


def _refused(client, session, sheet_id, status, detail, version=None, sheets=()):
    before = _world(session, (sheet_id, *sheets))
    res = _file(client, sheet_id, version)
    assert res.status_code == status, res.text
    if detail is not None:
        assert detail in res.json()["detail"], res.json()["detail"]
    assert _world(session, (sheet_id, *sheets)) == before
    return res.json()["detail"]


def _analysis(session, seeded, curve_id):
    session.add(HPLCAnalysis(sample_id_label="P-T5", peptide_id=seeded.peptide, dil_vial_empty=1.0,
                             dil_vial_with_diluent=2.0, dil_vial_with_diluent_and_sample=3.0,
                             calibration_curve_id=curve_id))
    session.commit()


def _session(session, seeded, curve_id):
    """A prep wizard session on the curve (wizard_sessions.calibration_curve_id)."""
    session.add(WizardSession(peptide_id=seeded.peptide, calibration_curve_id=curve_id))
    session.commit()


def _replicate(client, sheet_id, instrument=None, inputs=None):
    """Duplicate for another injection, with fixture case 20's run results (or `inputs`) typed in."""
    rep = client.post(f"/hplc-calibration-sheets/{sheet_id}/duplicate")
    assert rep.status_code == 201, rep.text
    body = {"version": 1, "inputs": inputs or _case(20)}
    if instrument is not None:
        body["instrument_id"] = instrument
    res = client.patch(f"/hplc-calibration-sheets/{rep.json()['id']}", json=body)
    assert res.status_code == 200, res.text
    return res.json()


# ---- what a filing writes --------------------------------------------------------------


def test_first_filing_writes_the_net_derivation_and_the_weighings(client, seeded, session, user):
    inputs = _case(7)
    # A peptide with two analytes: the curve takes the first by slot, as from-standard does.
    service = session.scalar(select(AnalysisService.id).limit(1))
    first = None
    if service is not None:
        second = PeptideAnalyte(peptide_id=seeded.peptide, analysis_service_id=service, slot=2)
        first = PeptideAnalyte(peptide_id=seeded.peptide, analysis_service_id=service, slot=1)
        session.add_all([second, first])
        session.commit()
        first = first.id
    sheet = _sheet(client, seeded, inputs)
    out = _filed(client, sheet["id"])
    curve = out["curve"]
    name = f"{seeded.inst_name}-2026-02-05-{seeded.abbr}"
    expect = _expect(7)
    assert curve["net_factor_computed"] == pytest.approx(0.9083756614997731, rel=1e-12)
    assert curve["net_factor_applied"] == 0.85
    assert curve["net_override_reason"] == "Re-assayed in house, 85 % net"
    assert curve["net_parts_used"] == ["assay", "counterion", "water"]
    assert curve["serial_dilution"] == {k: inputs[k] for k in SERIAL_KEYS}
    assert curve["stock_concentration_ug_ml"] == pytest.approx(expect["stock_conc_ug_ml"], rel=1e-12)
    assert curve["net_basis"] == "worksheet"
    assert (curve["net_counterion"], curve["net_counterion_mw"], curve["net_equivalents"]) == ("Acetate", 60.05, 2)
    assert (curve["net_free_mw"], curve["net_stated_fw"]) == (4731.3, 4731.3)
    assert (curve["net_assay_pct"], curve["net_water_pct"]) == (99.3, 6.2)
    assert curve["net_assumption"] == "lean 2, undeclared on the CoA"
    assert (curve["net_ms_mz"], curve["net_ms_ion"]) == (None, None)
    assert curve["source_filename"] == name
    assert (curve["peptide_id"], curve["instrument_id"], curve["instrument"]) == (
        seeded.peptide, seeded.inst, seeded.inst_name)
    assert curve["peptide_analyte_id"] == first
    assert (curve["source_sample_id"], curve["cas_number"], curve["vendor"], curve["lot_number"]) == (
        "P-0129", "2381089-83-2", "Cayman Chemical", "39747")
    assert (curve["standard_weight_mg"], curve["operator"], curve["notes"]) == (5, "DN", "")
    assert curve["run_date"].startswith("2026-02-05")
    assert curve["diluent_density"] == expect["density"]
    assert (curve["calibration_sheet_id"], curve["replicate_of_id"], curve["injection"]) == (sheet["id"], None, None)
    assert (curve["created_by_email"], curve["updated_by_email"]) == (user.email, user.email)
    assert curve["source_date"] is not None
    # What was written is what is read back.
    stored = _row(session, curve["id"])
    assert stored["serial_dilution"] == curve["serial_dilution"]
    assert stored["net_parts_used"] == ["assay", "counterion", "water"]
    read = out["sheet"]
    assert (read["curve_id"], read["curve_name"], read["proposed_name"]) == (curve["id"], name, name)
    assert read["filed_at"] is not None and read["changed_since_filed"] is False
    assert read["version"] == sheet["version"]  # filing is not a save
    assert out["refiled_curve_ids"] == []


def test_the_stored_fit_is_the_lab_tools_unrounded(client, seeded, session):
    out = _filed(client, _sheet(client, seeded, _case(1))["id"])
    fit = _expect(1)["fit"]
    stored = _row(session, out["curve"]["id"])
    assert stored["slope"] == pytest.approx(8.56174109270027, rel=1e-12)
    assert stored["slope"] != round(8.56174109270027, 6)
    assert stored["intercept"] == pytest.approx(fit["intercept"], rel=1e-12)
    assert stored["r_squared"] == pytest.approx(fit["r2"], rel=1e-12)


def test_standard_data_is_the_shape_analyze_reads(client, seeded, session):
    inputs = _case(13)
    out = _filed(client, _sheet(client, seeded, inputs)["id"])
    data = out["curve"]["standard_data"]
    assert set(data) == {"concentrations", "areas", "rts"}
    assert len(data["concentrations"]) == len(data["areas"]) == len(data["rts"]) == 4
    assert data["areas"] == [L["peak_area"] for L in inputs["levels"][:4]]
    assert data["rts"] == [L["rt"] for L in inputs["levels"][:4]]
    expect = [L["actual_conc_ug_ml"] for L in _expect(13)["levels"][:4]]
    assert data["concentrations"] == pytest.approx(expect, rel=1e-12)
    # Round 2 N2.1: the average over the four fitted points, as the Peptides page works it out.
    assert out["curve"]["reference_rt"] == round(sum(data["rts"]) / 4, 4)
    assert _row(session, out["curve"]["id"])["standard_data"] == data


def _rt_avg(inputs):
    avg = _REAL_WORK_OUT(inputs)["rt_avg"]
    return None if avg is None else round(avg, 4)


def _fitted_rts(inputs):
    """The typed RTs of the fitted levels (a concentration and a peak area), in level order."""
    return [L["rt"] for L in _REAL_WORK_OUT(inputs)["levels"]
            if L["actual_conc_ug_ml"] is not None and L["peak_area"] is not None and L["rt"] is not None]


def test_every_rt_typed_files_the_fitted_average(client, seeded):
    # Round 2 N2.1: reference_rt is the average over the fitted points, as every other writer has it.
    inputs = _case(1)
    curve = _filed(client, _sheet(client, seeded, inputs)["id"])["curve"]
    rts = curve["standard_data"]["rts"]
    assert len(rts) == 6 and rts == _fitted_rts(inputs)
    assert curve["reference_rt"] == round(sum(rts) / len(rts), 4) and curve["reference_rt"] is not None


def test_a_partial_rt_column_files_the_fitted_average(client, seeded):
    # Final review M2: one blank RT used to file no reference RT at all.
    inputs = _case(1)
    inputs["levels"][2]["rt"] = None
    curve = _filed(client, _sheet(client, seeded, inputs)["id"])["curve"]
    assert "rts" not in curve["standard_data"]
    typed = _fitted_rts(inputs)
    assert len(typed) == 5
    assert curve["reference_rt"] == round(sum(typed) / len(typed), 4)


def test_an_unfitted_levels_rt_does_not_move_the_reference_rt(client, seeded):
    # Round 2 N2.1, case 13: four fitted levels, RTs typed on all six.
    inputs = _case(13)
    fitted = _fitted_rts(inputs)
    assert len(fitted) == 4
    curve = _filed(client, _sheet(client, seeded, inputs)["id"])["curve"]
    assert curve["standard_data"]["rts"] == fitted
    assert curve["reference_rt"] == round(sum(fitted) / 4, 4) != _rt_avg(inputs)
    unfitted = [i for i, L in enumerate(_REAL_WORK_OUT(inputs)["levels"])
                if L["actual_conc_ug_ml"] is None or L["peak_area"] is None]
    assert unfitted
    for i in unfitted:
        inputs["levels"][i]["rt"] = 9.5
    moved = _filed(client, _sheet(client, seeded, inputs, instrument=seeded.inst2)["id"])["curve"]
    assert moved["reference_rt"] == curve["reference_rt"]


def test_no_rts_files_no_reference_rt(client, seeded):
    inputs = _case(1)
    for L in inputs["levels"]:
        L["rt"] = None
    curve = _filed(client, _sheet(client, seeded, inputs)["id"])["curve"]
    assert "rts" not in curve["standard_data"] and curve["reference_rt"] is None


# ---- refusals that write nothing --------------------------------------------------------


def test_filing_needs_two_peak_areas(client, seeded, session):
    inputs = _case(1)
    for L in inputs["levels"][1:]:
        L["peak_area"] = None
    sheet = _sheet(client, seeded, inputs)
    assert _refused(client, session, sheet["id"], 400, None) == NEEDS_AREAS
    for L in inputs["levels"]:
        L["peak_area"] = None
    blank = _sheet(client, seeded, inputs)
    assert _refused(client, session, blank["id"], 400, None) == NEEDS_AREAS
    assert session.scalar(select(func.count()).select_from(CalibrationCurve).where(
        CalibrationCurve.peptide_id == seeded.peptide)) == 0


def test_filing_needs_the_assumption_once_a_counterion_applies(client, seeded, session):
    sheet = _sheet(client, seeded, _case(9))
    _refused(client, session, sheet["id"], 400, "write the counterion assumption and its basis in words")


def test_an_override_needs_its_reason(client, seeded, session):
    sheet = _sheet(client, seeded, _case(8))
    _refused(client, session, sheet["id"], 400, "the factor is entered by hand: write why before the curve is filed")


def test_filing_needs_an_instrument_and_a_single_peptide(client, seeded, session):
    no_pep = client.post("/hplc-calibration-sheets", json={"instrument_id": seeded.inst, "inputs": _case(1)}).json()
    assert _refused(client, session, no_pep["id"], 400, None) == NO_PEPTIDE
    no_inst = client.post("/hplc-calibration-sheets", json={"peptide_id": seeded.peptide, "inputs": _case(1)}).json()
    assert _refused(client, session, no_inst["id"], 400, None) == NO_INSTRUMENT
    # A blend cannot be picked through the routes; a sheet can only reach one by a direct write.
    blend = _sheet(client, seeded, _case(1))
    session.get(HplcCalibrationSheet, blend["id"]).peptide_id = seeded.blend
    session.commit()
    assert _refused(client, session, blend["id"], 400, None) == BLEND


def test_a_retired_instrument_is_refused(client, seeded, session):
    sheet = _sheet(client, seeded, _case(1))
    session.get(Instrument, seeded.inst).active = False
    session.commit()
    detail = _refused(client, session, sheet["id"], 400, None)
    assert detail == f"{seeded.inst_name} is retired. A curve cannot be filed on it."


def test_a_stale_version_is_refused(client, seeded, session):
    sheet = _sheet(client, seeded, _case(1))
    assert _refused(client, session, sheet["id"], 409, None, version=2) == STALE
    assert client.post(f"/hplc-calibration-sheets/{sheet['id']}/file", json={"version": 1, "x": 1}).status_code == 422
    assert client.post(f"/hplc-calibration-sheets/{sheet['id']}/file", json={"version": "1"}).status_code == 422
    assert _file(client, 999999999).status_code == 404


@pytest.mark.parametrize("net", [
    {"counterion": "Acetate", "equivalents": 0, "free_mw": 0},
    {"counterion": "Acetate", "stated_fw": 0, "free_mw": None, "equivalents": 0},
    {"counterion": "Acetate", "free_mw": -120.1, "equivalents": 2},
], ids=["acetate eq 0 free 0", "stated 0", "free negative"])
def test_the_three_nonsense_net_blocks_are_refused(client, seeded, session, net):
    # The save refuses all three, so they reach a sheet only by a direct write.
    sheet = _sheet(client, seeded, _case(1))
    row = session.get(HplcCalibrationSheet, sheet["id"])
    inputs = copy.deepcopy(row.inputs)
    inputs["net"].update(net, assumption="written", override_factor=None)
    row.inputs = inputs
    session.commit()
    _refused(client, session, sheet["id"], 400, None)
    assert session.scalar(select(func.count()).select_from(CalibrationCurve).where(
        CalibrationCurve.peptide_id == seeded.peptide)) == 0


def _poisoned(path, value):
    """work_out_sheet as it is, with one number in its result replaced."""
    def worked_out(inputs):
        out = _REAL_WORK_OUT(inputs)
        holder = out
        for p in path[:-1]:
            holder = holder[p]
        holder[path[-1]] = value
        return out
    return worked_out


@pytest.mark.parametrize("path,value", [
    (("stock_conc_ug_ml",), float("inf")),
    (("factor_applied",), float("nan")),
    (("net", "factor"), float("-inf")),
    (("levels", 2, "rt"), float("inf")),
    (("levels", 1, "actual_conc_ug_ml"), float("nan")),
    (("fit", "intercept"), float("nan")),
    (("fit", "slope"), 0.0),
    (("net", "parts_used"), ["assay", 5]),
    (("blocking",), None),
], ids=["stock", "factor applied", "factor", "rt", "concentration", "intercept", "zero slope", "parts",
        "no blocking"])
def test_nothing_non_finite_is_ever_filed(client, seeded, session, monkeypatch, path, value):
    import hplc_calibration

    sheet = _sheet(client, seeded, _case(1))
    monkeypatch.setattr(hplc_calibration, "work_out_sheet", _poisoned(path, value))
    detail = _refused(client, session, sheet["id"], 400, None)
    assert detail == (SLOPE_NOT_POSITIVE if path == ("fit", "slope") else CANNOT)


def test_reversed_peak_areas_give_a_negative_slope_and_are_refused(client, seeded, session):
    # Review C1: areas typed bottom to top fitted a negative slope, filed it and switched off
    # the working active curve.
    others = _others(session, seeded)
    active = _curve(session, seeded.peptide, seeded.inst, True)
    inputs = _case(1)
    areas = [L["peak_area"] for L in inputs["levels"]][::-1]
    for L, a in zip(inputs["levels"], areas):
        L["peak_area"] = a
    sheet = _sheet(client, seeded, inputs)
    detail = _refused(client, session, sheet["id"], 400, None)
    assert detail == SLOPE_NOT_POSITIVE
    assert _row(session, active)["is_active"] is True
    assert _others(session, seeded) == others


@pytest.mark.parametrize("density", [0.9971, 499.9, 2000.1, 10 ** 400],
                         ids=["unit slip", "just below", "just above", "integer past float range"])
def test_a_stored_density_outside_the_range_is_refused_at_filing(client, seeded, session, density):
    # 10 ** 400: math.isfinite raised OverflowError on it (a 500); the band comparison alone refuses it.
    # The save refuses it now; a sheet saved before that can still hold one.
    sheet = _sheet(client, seeded, _case(1))
    row = session.get(HplcCalibrationSheet, sheet["id"])
    row.inputs = {**copy.deepcopy(row.inputs), "diluent_density_mg_ml": density}
    session.commit()
    assert _refused(client, session, sheet["id"], 400, None) == DENSITY_RANGE


def test_a_typed_density_files_with_a_warning(client, seeded, session):
    blank = _filed(client, _sheet(client, seeded, _case(1))["id"])
    assert blank["warnings"] == [] and blank["curve"]["diluent_density"] == DEFAULT_DENSITY
    inputs = _case(1)
    inputs["diluent_density_mg_ml"] = 1000.0
    out = _filed(client, _sheet(client, seeded, inputs, instrument=seeded.inst2)["id"])
    assert out["curve"]["diluent_density"] == 1000.0 and out["curve"]["is_active"] is True
    assert out["warnings"] == [(
        "This curve is filed with a diluent density of 1000 mg/mL. The prep worksheet works with its method's "
        f"density ({DEFAULT_DENSITY:.15g} unless the method sets another) and refuses to promote a prep while the "
        "curve's differs.")]


@pytest.mark.parametrize("stored", ["0.9971", True, [997.1], {"v": 997.1}])
def test_a_stored_density_that_is_not_a_number_is_refused_at_filing(client, seeded, session, stored):
    sheet = _sheet(client, seeded, _case(1))
    row = session.get(HplcCalibrationSheet, sheet["id"])
    row.inputs = {**copy.deepcopy(row.inputs), "diluent_density_mg_ml": stored}
    session.commit()
    assert _refused(client, session, sheet["id"], 400, None) == DENSITY_RANGE


def test_a_replicate_refused_for_its_originals_density_names_the_original(client, seeded, session):
    original = _filed(client, _sheet(client, seeded, _case(1))["id"])
    sid = original["sheet"]["id"]
    rep = _replicate(client, sid)
    row = session.get(HplcCalibrationSheet, sid)
    row.inputs = {**copy.deepcopy(row.inputs), "diluent_density_mg_ml": 0.9971}
    session.commit()
    assert _refused(client, session, rep["id"], 400, None, sheets=(sid,)) == (
        f"The original sheet, {original['curve']['source_filename']}, has a diluent density outside 500 to 2000. "
        "Correct it there.")


def _poor_fit_warning(r2):
    return (f"R squared is {r2:.4f}, below 0.99, so this curve was filed but not made active. Check the peak "
            "areas against their levels. If the curve is right, star it on the Peptides page.")


def _probe_order():
    """Case 1 with its areas in the order that keeps the slope positive with the smallest r squared."""
    inputs = _case(1)
    areas = [L["peak_area"] for L in inputs["levels"]]
    for L, j in zip(inputs["levels"], (1, 3, 5, 2, 4, 0)):
        L["peak_area"] = areas[j]
    return inputs


def test_a_hopeless_fit_files_inactive_and_leaves_the_active_curve_alone(client, seeded, session):
    others = _others(session, seeded)
    active = _curve(session, seeded.peptide, seeded.inst, True)
    inactive = _curve(session, seeded.peptide, seeded.inst, False)
    before = {cid: _row(session, cid) for cid in (active, inactive)}
    inputs = _probe_order()
    fit = _REAL_WORK_OUT(inputs)["fit"]
    assert fit["slope"] > 0 and fit["r2"] < 1e-4
    out = _filed(client, _sheet(client, seeded, inputs)["id"])
    assert out["activation"] == {"active": False, "reason": "poor_fit", "deactivated_ids": [],
                                 "other_active_ids": [active]}
    assert out["curve"]["is_active"] is False
    assert out["warnings"] == [_poor_fit_warning(fit["r2"])]
    assert {cid: _row(session, cid) for cid in before} == before
    assert _others(session, seeded) == others


def test_a_poor_fit_on_an_empty_slot_still_files_inactive(client, seeded, session):
    out = _filed(client, _sheet(client, seeded, _probe_order())["id"])
    assert out["activation"] == {"active": False, "reason": "poor_fit", "deactivated_ids": [],
                                 "other_active_ids": []}


@pytest.mark.parametrize("area,active", [(5147.0, True), (5170.0, False)], ids=["just above", "just below"])
def test_the_r_squared_floor_is_0_99(client, seeded, session, area, active):
    inputs = _case(1)
    inputs["levels"][1]["peak_area"] = area
    r2 = _REAL_WORK_OUT(inputs)["fit"]["r2"]
    assert (r2 >= 0.99) is active and abs(r2 - 0.99) < 0.001
    old = _curve(session, seeded.peptide, seeded.inst, True)
    old_row = _row(session, old)
    out = _filed(client, _sheet(client, seeded, inputs)["id"])
    assert out["curve"]["is_active"] is active
    assert out["activation"]["reason"] == ("replaced" if active else "poor_fit")
    assert out["warnings"] == ([] if active else [_poor_fit_warning(r2)])
    assert _row(session, old) == (old_row if not active else {**old_row, "is_active": False})


def test_a_refile_below_the_floor_keeps_is_active_and_warns(client, seeded, session):
    inputs = _case(1)
    sheet = _sheet(client, seeded, inputs)
    first = _filed(client, sheet["id"])
    assert first["curve"]["is_active"] is True and first["warnings"] == []
    inputs = _probe_order()
    assert client.patch(f"/hplc-calibration-sheets/{sheet['id']}",
                        json={"version": 1, "inputs": inputs}).status_code == 200
    out = _filed(client, sheet["id"], version=2)
    r2 = _REAL_WORK_OUT(inputs)["fit"]["r2"]
    assert out["curve"]["id"] == first["curve"]["id"] and out["curve"]["is_active"] is True
    assert out["activation"]["reason"] == "refiled"
    assert out["warnings"] == [(f"R squared is {r2:.4f}, below 0.99, so check it: this curve is active and was "
                                "updated in place.")]


def test_text_too_long_for_the_curve_is_refused(client, seeded, session):
    inputs = _case(1)
    inputs["lot"] = "L" * 150
    sheet = _sheet(client, seeded, inputs)
    detail = _refused(client, session, sheet["id"], 400, None)
    assert detail.startswith("Lot #: at most 100 characters")
    inputs = _case(1)
    inputs["cas"] = "1" * 41
    detail = _refused(client, session, _sheet(client, seeded, inputs)["id"], 400, None)
    assert detail.startswith("CAS number: at most 40 characters")


# ---- activation ---------------------------------------------------------------------------


def test_first_filing_on_an_empty_slot_is_active(client, seeded, session):
    others = _others(session, seeded)
    elsewhere = _curve(session, seeded.peptide, seeded.inst2, True)
    out = _filed(client, _sheet(client, seeded, _case(1))["id"])
    assert out["activation"] == {"active": True, "reason": "first_active", "deactivated_ids": [],
                                 "other_active_ids": []}
    assert out["curve"]["is_active"] is True and out["sheet"]["curve_is_active"] is True
    assert _row(session, elsewhere)["is_active"] is True
    assert _others(session, seeded) == others


def test_first_filing_replaces_the_one_active_curve(client, seeded, session):
    others = _others(session, seeded)
    old = _curve(session, seeded.peptide, seeded.inst, True)
    inactive = _curve(session, seeded.peptide, seeded.inst, False)
    on_inst2 = _curve(session, seeded.peptide, seeded.inst2, True)
    other_pep = _curve(session, seeded.other, seeded.inst, True)
    before = {cid: _row(session, cid) for cid in (inactive, on_inst2, other_pep)}
    old_row = _row(session, old)
    out = _filed(client, _sheet(client, seeded, _case(1))["id"])
    assert out["activation"] == {"active": True, "reason": "replaced", "deactivated_ids": [old],
                                 "other_active_ids": []}
    assert _row(session, old) == {**old_row, "is_active": False}
    assert {cid: _row(session, cid) for cid in before} == before
    assert _others(session, seeded) == others


def test_two_active_curves_already_file_inactive_and_touch_neither(client, seeded, session):
    # Review Focus 3: the KISSPEPTIN-10 shape (curves 81 and 90 on one instrument).
    others = _others(session, seeded)
    a = _curve(session, seeded.peptide, seeded.inst, True)
    b = _curve(session, seeded.peptide, seeded.inst, True)
    before = {cid: _row(session, cid) for cid in (a, b)}
    out = _filed(client, _sheet(client, seeded, _case(1))["id"])
    assert out["activation"] == {"active": False, "reason": "several_active", "deactivated_ids": [],
                                 "other_active_ids": [a, b]}
    assert out["curve"]["is_active"] is False
    assert {cid: _row(session, cid) for cid in before} == before
    assert _others(session, seeded) == others


def test_a_same_instrument_replicate_files_inactive_as_inj2(client, seeded, session):
    original = _filed(client, _sheet(client, seeded, _case(1))["id"])
    name = original["curve"]["source_filename"]
    rep = _replicate(client, original["sheet"]["id"])
    out = _filed(client, rep["id"])
    curve = out["curve"]
    assert (curve["source_filename"], curve["injection"], curve["replicate_of_id"]) == (
        f"{name}-Inj2", 2, original["curve"]["id"])
    assert out["activation"] == {"active": False, "reason": "replicate", "deactivated_ids": [],
                                 "other_active_ids": []}
    assert curve["slope"] == pytest.approx(_expect(20)["fit"]["slope"], rel=1e-12)
    assert curve["notes"] == "Inj2"
    assert curve["serial_dilution"]["stock"] == _case(1)["stock"]
    assert _row(session, original["curve"]["id"])["is_active"] is True
    # Rule 5: a second duplicate of the same original takes the next free name.
    third = _filed(client, _replicate(client, original["sheet"]["id"])["id"])["curve"]
    assert (third["source_filename"], third["injection"]) == (f"{name}-Inj3", 3)


def test_a_replicate_on_another_instrument_files_as_its_own_curve(client, seeded, session):
    original = _filed(client, _sheet(client, seeded, _case(1))["id"])
    rep = _replicate(client, original["sheet"]["id"], instrument=seeded.inst2)
    out = _filed(client, rep["id"])
    curve = out["curve"]
    assert curve["source_filename"] == f"{seeded.inst2_name}-2026-02-05-{seeded.abbr}"
    assert (curve["instrument_id"], curve["instrument"]) == (seeded.inst2, seeded.inst2_name)
    assert (curve["injection"], curve["replicate_of_id"]) == (None, original["curve"]["id"])
    assert out["activation"]["reason"] == "first_active" and curve["is_active"] is True
    assert _row(session, original["curve"]["id"])["is_active"] is True


# ---- re-filing ------------------------------------------------------------------------------


def test_refiling_updates_in_place_and_keeps_is_active(client, seeded, session, user):
    inputs = _case(1)
    sheet = _sheet(client, seeded, inputs)
    first = _filed(client, sheet["id"])
    cid = first["curve"]["id"]
    # Starred elsewhere since: the re-file must not star it again.
    row = session.get(CalibrationCurve, cid)
    row.is_active = False
    session.commit()
    rival = _curve(session, seeded.peptide, seeded.inst, True)
    rival_row = _row(session, rival)
    # Rule 1: no-op save keeps "changed since filed" false, a real save sets it.
    same = client.patch(f"/hplc-calibration-sheets/{sheet['id']}", json={"version": 1, "inputs": inputs}).json()
    assert same["changed_since_filed"] is False
    inputs["levels"][0]["peak_area"] = 8600.0
    saved = client.patch(f"/hplc-calibration-sheets/{sheet['id']}", json={"version": 1, "inputs": inputs}).json()
    assert saved["changed_since_filed"] is True
    out = _filed(client, sheet["id"], version=2)
    assert out["curve"]["id"] == cid
    assert out["curve"]["slope"] != first["curve"]["slope"]
    assert out["curve"]["is_active"] is False
    assert out["activation"] == {"active": False, "reason": "refiled", "deactivated_ids": [],
                                 "other_active_ids": []}
    assert out["sheet"]["changed_since_filed"] is False
    assert _row(session, rival) == rival_row
    assert out["curve"]["created_at"] == first["curve"]["created_at"]
    assert out["curve"]["created_by_email"] == user.email
    assert session.scalar(select(func.count()).select_from(CalibrationCurve).where(
        CalibrationCurve.calibration_sheet_id == sheet["id"])) == 1


def test_refiling_a_used_curve_is_refused(client, seeded, session):
    # Review Focus 2.
    inputs = _case(1)
    sheet = _sheet(client, seeded, inputs)
    first = _filed(client, sheet["id"])
    _analysis(session, seeded, first["curve"]["id"])
    inputs["levels"][0]["peak_area"] = 8600.0
    assert client.patch(f"/hplc-calibration-sheets/{sheet['id']}",
                        json={"version": 1, "inputs": inputs}).status_code == 200
    detail = _refused(client, session, sheet["id"], 409, None, version=2)
    assert detail == (f"Curve {first['curve']['source_filename']} has been used by 1 analysis and 0 prep sessions, "
                      "so its numbers are part of their record. Start a new worksheet to file a corrected curve.")
    _analysis(session, seeded, first["curve"]["id"])
    assert "used by 2 analyses and 0 prep sessions" in _refused(client, session, sheet["id"], 409, None, version=2)


def test_refiling_a_curve_a_prep_session_uses_is_refused(client, seeded, session):
    # Review I2: a wizard session works its quantity out again from the curve on every read.
    inputs = _case(1)
    sheet = _sheet(client, seeded, inputs)
    first = _filed(client, sheet["id"])
    _session(session, seeded, first["curve"]["id"])
    inputs["levels"][0]["peak_area"] = 8600.0
    assert client.patch(f"/hplc-calibration-sheets/{sheet['id']}",
                        json={"version": 1, "inputs": inputs}).status_code == 200
    detail = _refused(client, session, sheet["id"], 409, None, version=2)
    assert detail == (f"Curve {first['curve']['source_filename']} has been used by 0 analyses and 1 prep session, "
                      "so its numbers are part of their record. Start a new worksheet to file a corrected curve.")
    _session(session, seeded, first["curve"]["id"])
    _analysis(session, seeded, first["curve"]["id"])
    assert "used by 1 analysis and 2 prep sessions" in _refused(client, session, sheet["id"], 409, None, version=2)


def test_refiling_an_original_with_a_replicate_a_prep_session_uses_is_refused_whole(client, seeded, session):
    inputs = _case(1)
    original = _filed(client, _sheet(client, seeded, inputs)["id"])
    sid = original["sheet"]["id"]
    rep = _replicate(client, sid)
    rep_curve = _filed(client, rep["id"])["curve"]
    _session(session, seeded, rep_curve["id"])
    inputs["stock"]["vial_standard_mg"] = 15729.5
    assert client.patch(f"/hplc-calibration-sheets/{sid}", json={"version": 1, "inputs": inputs}).status_code == 200
    detail = _refused(client, session, sid, 409, None, version=2, sheets=(rep["id"],))
    assert detail.startswith(f"Curve {rep_curve['source_filename']} has been used by 0 analyses and 1 prep session")


def test_refiling_an_original_refiles_its_replicates(client, seeded, session):
    from hplc_calibration import replicate_prep, work_out_sheet

    inputs = _case(1)
    original = _filed(client, _sheet(client, seeded, inputs)["id"])
    sid = original["sheet"]["id"]
    rep = _replicate(client, sid)
    rep_curve = _filed(client, rep["id"])["curve"]
    unfiled = _replicate(client, sid)
    unfiled_before = _world(session, (unfiled["id"], rep["id"]))[1]
    inputs["stock"]["vial_standard_mg"] = 15729.5
    assert client.patch(f"/hplc-calibration-sheets/{sid}", json={"version": 1, "inputs": inputs}).status_code == 200
    out = _filed(client, sid, version=2)
    assert out["refiled_curve_ids"] == [rep_curve["id"]]
    after = _row(session, rep_curve["id"])
    expect = work_out_sheet(replicate_prep(inputs, rep["inputs"]))
    assert after["slope"] == pytest.approx(expect["fit"]["slope"], rel=1e-12)
    assert after["slope"] != rep_curve["slope"]
    assert after["serial_dilution"]["stock"] == inputs["stock"]
    assert after["stock_concentration_ug_ml"] == pytest.approx(expect["stock_conc_ug_ml"], rel=1e-12)
    assert (after["is_active"], after["source_filename"], after["injection"]) == (
        False, rep_curve["source_filename"], 2)
    # The replicate sheets themselves are not written; the unfiled one is untouched.
    assert _world(session, (unfiled["id"], rep["id"]))[1] == unfiled_before
    rows = session.execute(select(AuditLog.operation, AuditLog.details).where(
        AuditLog.entity_type == "calibration_curve", AuditLog.entity_id == str(rep_curve["id"]))
        .order_by(AuditLog.id)).all()
    assert [op for op, _ in rows] == ["calibration_curve_filed", "calibration_curve_refiled"]
    # Final review M5: the replicate's row names the replicate's own version.
    assert [d["version"] for _, d in rows] == [rep["version"], rep["version"]]
    assert out["warnings"] == []


def test_refiling_an_original_with_a_used_replicate_is_refused_whole(client, seeded, session):
    inputs = _case(1)
    original = _filed(client, _sheet(client, seeded, inputs)["id"])
    sid = original["sheet"]["id"]
    rep = _replicate(client, sid)
    rep_curve = _filed(client, rep["id"])["curve"]
    _analysis(session, seeded, rep_curve["id"])
    inputs["stock"]["vial_standard_mg"] = 15729.5
    assert client.patch(f"/hplc-calibration-sheets/{sid}", json={"version": 1, "inputs": inputs}).status_code == 200
    detail = _refused(client, session, sid, 409, None, version=2, sheets=(rep["id"],))
    assert detail.startswith(f"Curve {rep_curve['source_filename']} has been used by 1 analysis and 0 prep sessions")


def test_a_replicate_that_cannot_follow_the_corrected_original_is_refused_whole(client, seeded, session):
    inputs = _case(1)
    original = _filed(client, _sheet(client, seeded, inputs)["id"])
    sid = original["sheet"]["id"]
    rep = _replicate(client, sid)
    _filed(client, rep["id"])
    # The original's areas are kept; the replicate's own are then cleared by a direct write,
    # so the corrected preparation leaves the replicate without a fit.
    row = session.get(HplcCalibrationSheet, rep["id"])
    row.inputs = {"notes": None, "levels": [{"peak_area": None, "purity": None, "rt": None}] * 6}
    session.commit()
    inputs["stock"]["vial_standard_mg"] = 15729.5
    assert client.patch(f"/hplc-calibration-sheets/{sid}", json={"version": 1, "inputs": inputs}).status_code == 200
    detail = _refused(client, session, sid, 400, None, version=2, sheets=(rep["id"],))
    assert "-Inj2" in detail


def test_a_curve_moved_to_another_instrument_is_not_refiled(client, seeded, session):
    sheet = _sheet(client, seeded, _case(1))
    cid = _filed(client, sheet["id"])["curve"]["id"]
    assert client.patch(f"/peptides/{seeded.peptide}/calibrations/{cid}",
                        json={"instrument_id": seeded.inst2}).status_code == 200
    _refused(client, session, sheet["id"], 409, "Start a new worksheet")


def test_a_deleted_curve_files_again_as_a_fresh_row(client, seeded, session):
    # Review Focus 1: the re-sync deletes every curve of the peptide (main.py, resync). This runs
    # the same DELETE the re-sync runs, not the re-sync route itself (final review M6).
    inputs = _case(7)
    sheet = _sheet(client, seeded, inputs)
    first = _filed(client, sheet["id"])["curve"]["id"]
    session.execute(delete(CalibrationCurve).where(CalibrationCurve.peptide_id == seeded.peptide))
    session.commit()
    got = client.get(f"/hplc-calibration-sheets/{sheet['id']}").json()
    assert got["curve_id"] is None and got["inputs"] == inputs
    again = _filed(client, sheet["id"])
    assert again["curve"]["id"] != first
    assert again["activation"]["reason"] == "first_active"
    assert again["sheet"]["curve_id"] == again["curve"]["id"]


def test_a_filed_curve_is_usable_by_analyze_on_its_instrument(client, seeded, session):
    cid = _filed(client, _sheet(client, seeded, _case(1))["id"])["curve"]["id"]
    listed = client.get(f"/peptides/{seeded.peptide}/calibrations")
    assert listed.status_code == 200
    mine = next(c for c in listed.json() if c["id"] == cid)
    assert mine["net_basis"] == "worksheet" and mine["net_parts_used"] == []
    body = {"sample_id_label": f"T5-{uuid4().hex[:6]}", "peptide_id": seeded.peptide, "calibration_curve_id": cid,
            "weights": {"stock_vial_empty": 10000.0, "stock_vial_with_diluent": 13000.0, "dil_vial_empty": 9000.0,
                        "dil_vial_with_diluent": 9900.0, "dil_vial_with_diluent_and_sample": 9990.0},
            "injections": [{"peaks": [{"area": 1000.0, "area_percent": 99.0, "retention_time": 6.39}],
                            "main_peak_index": 0}]}
    same = client.post("/hplc/analyze", json={**body, "instrument_id": seeded.inst})
    assert same.status_code == 201, same.text
    assert same.json()["calibration_curve_id"] == cid
    other = client.post("/hplc/analyze", json={**body, "instrument_id": seeded.inst2})
    assert other.status_code == 400
    assert f"Calibration curve {cid} belongs to instrument" in other.json()["detail"]


def test_the_audit_row_carries_old_and_new_fit(client, seeded, session, user):
    inputs = _case(1)
    sheet = _sheet(client, seeded, inputs)
    first = _filed(client, sheet["id"])
    cid = first["curve"]["id"]
    inputs["levels"][0]["peak_area"] = 8600.0
    client.patch(f"/hplc-calibration-sheets/{sheet['id']}", json={"version": 1, "inputs": inputs})
    second = _filed(client, sheet["id"], version=2)
    rows = session.execute(select(AuditLog.operation, AuditLog.details).where(
        AuditLog.entity_type == "calibration_curve", AuditLog.entity_id == str(cid)).order_by(AuditLog.id)).all()
    # Final review I2 and M5: the record also holds the density and the reference RT, and the row
    # names the sheet version that was filed.
    fit = lambda c: {"slope": c["slope"], "intercept": c["intercept"], "r_squared": c["r_squared"],
                     "diluent_density": c["diluent_density"], "reference_rt": c["reference_rt"],
                     "notes": c["notes"], "vendor": c["vendor"], "source_sample_id": c["source_sample_id"],
                     "peptide_analyte_id": c["peptide_analyte_id"]}
    assert [op for op, _ in rows] == ["calibration_curve_filed", "calibration_curve_refiled"]
    assert rows[0][1] == {"user_id": user.id, "sheet_id": sheet["id"], "version": 1, "old": None,
                          "new": fit(first["curve"]), "activation": first["activation"]}
    assert rows[1][1] == {"user_id": user.id, "sheet_id": sheet["id"], "version": 2, "old": fit(first["curve"]),
                          "new": fit(second["curve"]), "activation": second["activation"]}


# ---- the original's own inputs ----------------------------------------------------------------


def test_a_replicate_names_its_original_when_that_cannot_be_worked_out(client, seeded, session):
    original = _filed(client, _sheet(client, seeded, _case(1))["id"])
    sid = original["sheet"]["id"]
    rep = _replicate(client, sid)
    row = session.get(HplcCalibrationSheet, sid)
    row.inputs = [1, 2]  # a direct write only
    session.commit()
    sentence = (f"The original sheet, {original['curve']['source_filename']}, cannot be worked out. "
                "Correct it there.")
    assert _refused(client, session, rep["id"], 400, None) == sentence
    res = client.patch(f"/hplc-calibration-sheets/{rep['id']}",
                       json={"version": rep["version"], "inputs": {"notes": "x", "levels": []}})
    assert res.status_code == 400 and res.json()["detail"] == sentence


# ---- final review C1: an injection never files under a compound its original does not have ----------

HAS_INJECTIONS = ("Injections duplicated from this sheet carry the same compound, so the compound cannot change "
                  "here. Start a new calibration worksheet for the other compound.")


def _injection_on_another_compound(original_name):
    return (f"This sheet is another injection of {original_name}, which is on a different compound now, so it is "
            "not filed. Start a new calibration worksheet for this compound.")


def _original_on_another_compound(injection_name):
    return (f"The injection {injection_name} is on a different compound from this sheet, so nothing was filed. "
            "Start a new calibration worksheet for this sheet's compound.")


def _original_not_filed(original_name):
    return f"The original worksheet, {original_name}, is not filed. File it first, then file this one."


def _preparation_changed(original_name, injection_filed=False):
    return (f"The original worksheet, {original_name}, has a changed preparation that is not filed yet. File it "
            "first, then file this one." + (" Filing the original also re-files this injection." if injection_filed
                                             else ""))


def _version(client, sheet_id):
    return client.get(f"/hplc-calibration-sheets/{sheet_id}").json()["version"]


def _deleted_original(client, seeded, instrument=None, file_injection=False):
    """An original filed on the test peptide and instrument A, one injection (on `instrument`, else A,
    filed or not), then the original's curve deleted on the Peptides page: the door the review found."""
    original = _filed(client, _sheet(client, seeded, _case(1))["id"])
    rep = _replicate(client, original["sheet"]["id"], instrument=instrument)
    rep_curve = _filed(client, rep["id"])["curve"] if file_injection else None
    res = client.delete(f"/peptides/{seeded.peptide}/calibrations/{original['curve']['id']}")
    assert res.status_code == 204, res.text
    return original["sheet"]["id"], rep, rep_curve


@pytest.mark.parametrize("file_injection", [False, True], ids=["unfiled injection", "filed injection"])
def test_an_original_with_injections_cannot_change_compound(client, seeded, session, file_injection):
    # Review sequences 1 and 2 now stop here.
    sid, rep, _ = _deleted_original(client, seeded, seeded.inst2, file_injection)
    before = _world(session, (sid, rep["id"]))
    for peptide in (seeded.other, None):
        res = client.patch(f"/hplc-calibration-sheets/{sid}",
                           json={"version": _version(client, sid), "peptide_id": peptide})
        assert res.status_code == 409 and res.json()["detail"] == HAS_INJECTIONS
    assert _world(session, (sid, rep["id"])) == before


def test_an_original_without_injections_still_changes_compound(client, seeded):
    sheet = _sheet(client, seeded, _case(1))
    res = client.patch(f"/hplc-calibration-sheets/{sheet['id']}", json={"version": 1, "peptide_id": seeded.other})
    assert res.status_code == 200 and res.json()["peptide_id"] == seeded.other


def test_an_original_with_injections_may_change_instrument_and_the_injection_keeps_its_own(client, seeded, session):
    # Review sequence 3, ruled accepted: the injection keeps its own instrument and files by the
    # ordinary rules for it, once the original is filed again (I1).
    sid, rep, _ = _deleted_original(client, seeded)
    res = client.patch(f"/hplc-calibration-sheets/{sid}",
                       json={"version": _version(client, sid), "instrument_id": seeded.inst2})
    assert res.status_code == 200 and res.json()["instrument_id"] == seeded.inst2
    name = res.json()["proposed_name"]
    assert _refused(client, session, rep["id"], 409, None, sheets=(sid,)) == _original_not_filed(name)
    again = _filed(client, sid)
    assert (again["curve"]["instrument_id"], again["refiled_curve_ids"]) == (seeded.inst2, [])
    out = _filed(client, rep["id"])
    curve = out["curve"]
    assert (curve["peptide_id"], curve["instrument_id"]) == (seeded.peptide, seeded.inst)
    assert curve["source_filename"] == f"{seeded.inst_name}-2026-02-05-{seeded.abbr}"
    assert (curve["injection"], curve["replicate_of_id"]) == (None, again["curve"]["id"])
    assert out["activation"]["reason"] == "first_active" and curve["is_active"] is True


def test_an_injection_on_another_compound_than_its_original_is_not_filed(client, seeded, session):
    original = _filed(client, _sheet(client, seeded, _case(1))["id"])
    sid = original["sheet"]["id"]
    rep = _replicate(client, sid, instrument=seeded.inst2)
    row = session.get(HplcCalibrationSheet, rep["id"])
    row.peptide_id = seeded.other  # the routes no longer allow this; a direct write only
    session.commit()
    detail = _refused(client, session, rep["id"], 409, None, sheets=(sid,))
    assert detail == _injection_on_another_compound(original["curve"]["source_filename"])


def test_an_original_whose_filed_injection_is_on_another_compound_is_refused_whole(client, seeded, session):
    sid, rep, rep_curve = _deleted_original(client, seeded, seeded.inst2, file_injection=True)
    row = session.get(HplcCalibrationSheet, sid)
    row.peptide_id = seeded.other  # what the PATCH allowed before this fix; a direct write now
    session.commit()
    detail = _refused(client, session, sid, 409, None, sheets=(rep["id"],))
    assert detail == _original_on_another_compound(rep_curve["source_filename"])


# ---- final review I1: an injection is not filed while its original has unfiled changes -----------


def test_an_injection_waits_for_its_original_to_be_filed_again(client, seeded, session):
    # Review probe A: the injection filed the original's newest weighing, which its page never showed.
    inputs = _case(1)
    original = _filed(client, _sheet(client, seeded, inputs)["id"])
    sid = original["sheet"]["id"]
    rep = _replicate(client, sid)
    inputs["stock"]["vial_standard_mg"] = 15729.5
    assert client.patch(f"/hplc-calibration-sheets/{sid}", json={"version": 1, "inputs": inputs}).status_code == 200
    detail = _refused(client, session, rep["id"], 409, None, sheets=(sid,))
    assert detail == _preparation_changed(original["curve"]["source_filename"])
    again = _filed(client, sid, version=2)
    out = _filed(client, rep["id"])
    assert out["curve"]["stock_concentration_ug_ml"] == again["curve"]["stock_concentration_ug_ml"]
    assert out["curve"]["serial_dilution"]["stock"] == inputs["stock"]


def test_a_filed_injection_takes_the_corrected_preparation_through_its_original(client, seeded, session):
    inputs = _case(1)
    original = _filed(client, _sheet(client, seeded, inputs)["id"])
    sid = original["sheet"]["id"]
    rep = _replicate(client, sid)
    rep_curve = _filed(client, rep["id"])["curve"]
    inputs["stock"]["vial_standard_mg"] = 15729.5
    assert client.patch(f"/hplc-calibration-sheets/{sid}", json={"version": 1, "inputs": inputs}).status_code == 200
    detail = _refused(client, session, rep["id"], 409, None, sheets=(sid,))
    assert detail == _preparation_changed(original["curve"]["source_filename"], injection_filed=True)
    again = _filed(client, sid, version=2)
    assert again["refiled_curve_ids"] == [rep_curve["id"]]
    after = _row(session, rep_curve["id"])
    assert after["stock_concentration_ug_ml"] == again["curve"]["stock_concentration_ug_ml"]
    assert after["stock_concentration_ug_ml"] != rep_curve["stock_concentration_ug_ml"]
    # The original filed and unchanged: the injection files (re-files) again.
    assert _file(client, rep["id"]).status_code == 200


# ---- round 2 N1: the trigger is the original's PREPARATION, by value, not its timestamps -----------

_PREP_COLUMNS = ("stock_concentration_ug_ml", "net_counterion", "net_counterion_mw", "net_equivalents",
                 "net_free_mw", "net_stated_fw", "net_ms_mz", "net_ms_ion", "net_assay_pct", "net_water_pct",
                 "net_assumption", "net_factor_computed", "net_factor_applied", "net_override_reason",
                 "net_parts_used", "cas_number", "lot_number", "standard_weight_mg", "operator", "run_date",
                 "vendor", "source_sample_id", "diluent_density")


def _preparation(row):
    """What an injection takes from its original, as a curve row holds it: each level's own run
    results (peak area, purity, RT) left out."""
    serial = copy.deepcopy(row["serial_dilution"])
    for L in serial["levels"]:
        for k in hplc_calibration._REP_LEVEL_OWN:
            L.pop(k, None)
    return {**{k: row[k] for k in _PREP_COLUMNS}, "serial_dilution": serial}


def test_an_original_saved_with_only_its_own_run_results_changed_does_not_hold_its_injections(client, seeded,
                                                                                              session):
    # Review probe P7: the original's curve is used, so the original can never be re-filed; a save
    # that changed only its own peak area used to strand the injection for good.
    inputs = _case(1)
    original = _filed(client, _sheet(client, seeded, inputs)["id"])
    sid, ocid = original["sheet"]["id"], original["curve"]["id"]
    rep = _replicate(client, sid, instrument=seeded.inst2)
    _analysis(session, seeded, ocid)
    inputs["levels"][0]["peak_area"] = 8600.0
    assert client.patch(f"/hplc-calibration-sheets/{sid}", json={"version": 1, "inputs": inputs}).status_code == 200
    assert client.get(f"/hplc-calibration-sheets/{sid}").json()["changed_since_filed"] is True
    out = _filed(client, rep["id"])
    assert out["curve"]["replicate_of_id"] == ocid
    assert _preparation(_row(session, out["curve"]["id"])) == _preparation(_row(session, ocid))


def test_a_changed_stock_weighing_holds_the_injection_until_it_is_put_back(client, seeded, session):
    # Review probe A, and the way back the timestamp rule did not have.
    inputs = _case(1)
    filed_inputs = copy.deepcopy(inputs)
    original = _filed(client, _sheet(client, seeded, inputs)["id"])
    sid, ocid = original["sheet"]["id"], original["curve"]["id"]
    rep = _replicate(client, sid, instrument=seeded.inst2)
    inputs["stock"]["vial_standard_mg"] = 15729.5
    assert client.patch(f"/hplc-calibration-sheets/{sid}", json={"version": 1, "inputs": inputs}).status_code == 200
    detail = _refused(client, session, rep["id"], 409, None, sheets=(sid,))
    assert detail == _preparation_changed(original["curve"]["source_filename"])
    assert client.patch(f"/hplc-calibration-sheets/{sid}",
                        json={"version": 2, "inputs": filed_inputs}).status_code == 200
    out = _filed(client, rep["id"])
    assert _preparation(_row(session, out["curve"]["id"])) == _preparation(_row(session, ocid))


@pytest.mark.parametrize("change", [{"assay_pct": 98.5}, {"counterion": "TFA"}], ids=["assay", "counterion"])
def test_a_changed_net_peptide_input_holds_the_injection(client, seeded, session, change):
    inputs = _case(1)
    original = _filed(client, _sheet(client, seeded, inputs)["id"])
    sid = original["sheet"]["id"]
    rep = _replicate(client, sid, instrument=seeded.inst2)
    inputs["net"].update(change)
    assert client.patch(f"/hplc-calibration-sheets/{sid}", json={"version": 1, "inputs": inputs}).status_code == 200
    detail = _refused(client, session, rep["id"], 409, None, sheets=(sid,))
    assert detail == _preparation_changed(original["curve"]["source_filename"])


def _original_in_use(original_name):
    return (f"The original worksheet, {original_name}, has a changed preparation, but its curve or the curve of "
            "one of its injections is part of an analysis's or a prep session's record, so it cannot be filed "
            "again. Put its preparation back as it was filed, or start a new worksheet.")


@pytest.mark.parametrize("used", ["original by an analysis", "injection by a prep session"])
def test_a_changed_preparation_on_an_original_that_cannot_be_refiled_says_so(client, seeded, session, used):
    # Round 3 R2, review sequence Q5: the round 2 sentence sent the chemist to a File that is refused.
    inputs = _case(1)
    filed_inputs = copy.deepcopy(inputs)
    original = _filed(client, _sheet(client, seeded, inputs)["id"])
    sid, ocid, name = original["sheet"]["id"], original["curve"]["id"], original["curve"]["source_filename"]
    rep = _replicate(client, sid, instrument=seeded.inst2)
    rep_curve = _filed(client, rep["id"])["curve"]
    if used.startswith("original"):
        _analysis(session, seeded, ocid)
    else:
        _session(session, seeded, rep_curve["id"])
    inputs["stock"]["vial_standard_mg"] = 15729.5
    assert client.patch(f"/hplc-calibration-sheets/{sid}", json={"version": 1, "inputs": inputs}).status_code == 200
    assert _refused(client, session, rep["id"], 409, None, sheets=(sid,)) == _original_in_use(name)
    assert _file(client, sid).status_code == 409  # what the round 2 sentence sent the chemist to
    assert client.patch(f"/hplc-calibration-sheets/{sid}",
                        json={"version": 2, "inputs": filed_inputs}).status_code == 200
    if used.startswith("original"):
        assert _file(client, rep["id"]).status_code == 200
    else:  # the injection's own curve is in use: its own File says that, not the original's sentence
        assert "has been used by" in _refused(client, session, rep["id"], 409, None)


def test_an_unfiled_injection_of_an_original_in_use_is_told_the_way_out(client, seeded, session):
    original = _filed(client, _sheet(client, seeded, _case(1))["id"])
    sid = original["sheet"]["id"]
    inputs = _case(1)
    rep = _replicate(client, sid, instrument=seeded.inst2)
    _analysis(session, seeded, original["curve"]["id"])
    inputs["net"]["assay_pct"] = 98.5
    assert client.patch(f"/hplc-calibration-sheets/{sid}", json={"version": 1, "inputs": inputs}).status_code == 200
    detail = _refused(client, session, rep["id"], 409, None, sheets=(sid,))
    assert detail == _original_in_use(original["curve"]["source_filename"])


def test_the_originals_vendor_edited_on_the_peptides_page_does_not_hold_the_injection(client, seeded, session):
    # The vendor and the source sample are read from the filing record, not the editable column.
    original = _filed(client, _sheet(client, seeded, _case(1))["id"])
    rep = _replicate(client, original["sheet"]["id"], instrument=seeded.inst2)
    res = client.patch(f"/peptides/{seeded.peptide}/calibrations/{original['curve']['id']}",
                       json={"vendor": "Edited vendor", "source_sample_id": "P-9999"})
    assert res.status_code == 200, res.text
    assert _filed(client, rep["id"])["curve"]["vendor"] == "Cayman Chemical"


def test_an_original_curve_without_its_weighings_holds_the_injection(client, seeded, session):
    # Fail closed: a curve that does not hold what was filed cannot show the preparation is unchanged.
    original = _filed(client, _sheet(client, seeded, _case(1))["id"])
    sid = original["sheet"]["id"]
    rep = _replicate(client, sid, instrument=seeded.inst2)
    row = session.get(CalibrationCurve, original["curve"]["id"])
    row.serial_dilution = None  # a direct write only
    session.commit()
    detail = _refused(client, session, rep["id"], 409, None, sheets=(sid,))
    assert detail == _preparation_changed(original["curve"]["source_filename"])


# ---- round 2 N4: an original whose compound was deleted may be given one ---------------------------


def test_an_original_whose_compound_was_deleted_may_take_another(client, seeded, session):
    # Review probe P4.
    original = _filed(client, _sheet(client, seeded, _case(1))["id"])
    sid = original["sheet"]["id"]
    rep = _replicate(client, sid, instrument=seeded.inst2)
    assert client.delete(f"/peptides/{seeded.peptide}").status_code == 200
    res = client.patch(f"/hplc-calibration-sheets/{sid}", json={"version": _version(client, sid),
                                                                 "peptide_id": seeded.other})
    assert res.status_code == 200, res.text
    assert res.json()["peptide_id"] == seeded.other
    again = _filed(client, sid)
    assert again["curve"]["peptide_id"] == seeded.other
    detail = _refused(client, session, rep["id"], 409, None, sheets=(sid,))
    assert detail == _injection_on_another_compound(again["curve"]["source_filename"])


# ---- final review I2: a re-file says what it replaced, and the sheet says so beforehand -----------


def _peptides_page_edit(client, seeded, curve, exclude=True, density=990.0):
    body = {"diluent_density": density}
    if exclude:
        body["standard_data"] = {**curve["standard_data"], "excluded_indices": [0]}
    res = client.patch(f"/peptides/{seeded.peptide}/calibrations/{curve['id']}", json=body)
    assert res.status_code == 200, res.text
    return res.json()


def _replaced(name, *parts):
    return (f"Curve {name} was changed on the Peptides page since it was filed, and filing replaced those changes: "
            + "; ".join(parts) + ".")


def _fit_part(c):
    return (f"its slope was {c['slope']:.15g}, its intercept {c['intercept']:.15g} and its r squared "
            f"{c['r_squared']:.15g}")


def test_a_refile_says_what_it_replaced_on_the_peptides_page(client, seeded, session, user):
    # Review probe B: the re-file put an excluded point back and the density back without a word.
    sheet = _sheet(client, seeded, _case(1))
    first = _filed(client, sheet["id"])
    cid, name = first["curve"]["id"], first["curve"]["source_filename"]
    assert first["sheet"]["curve_changed_since_filed"] is False
    edited = _peptides_page_edit(client, seeded, first["curve"])
    assert edited["slope"] != first["curve"]["slope"] and edited["diluent_density"] == 990.0
    got = client.get(f"/hplc-calibration-sheets/{sheet['id']}").json()
    assert (got["curve_changed_since_filed"], got["changed_since_filed"]) == (True, False)
    # The Peptides page works the reference RT out again from the points it keeps.
    assert edited["reference_rt"] != first["curve"]["reference_rt"]
    out = _filed(client, sheet["id"])
    assert out["warnings"] == [_replaced(name, _fit_part(edited), "the points excluded there are back in the fit",
                                         "its diluent density was 990 mg/mL",
                                         f"its reference RT was {edited['reference_rt']:.15g} min")]
    assert out["curve"]["reference_rt"] == first["curve"]["reference_rt"]
    curve = out["curve"]
    assert curve["slope"] == first["curve"]["slope"] and curve["diluent_density"] == DEFAULT_DENSITY
    assert "excluded_indices" not in curve["standard_data"]
    assert out["sheet"]["curve_changed_since_filed"] is False
    assert client.get(f"/hplc-calibration-sheets/{sheet['id']}").json()["curve_changed_since_filed"] is False
    # The audit row keeps what was replaced.
    old = session.execute(select(AuditLog.details).where(
        AuditLog.entity_type == "calibration_curve", AuditLog.entity_id == str(cid))
        .order_by(AuditLog.id.desc()).limit(1)).scalar_one()["old"]
    # Round 2 N3: what the Peptides page set is kept, the exclusion too (only `old` carries it).
    assert old == {"slope": edited["slope"], "intercept": edited["intercept"], "r_squared": edited["r_squared"],
                   "diluent_density": 990.0, "reference_rt": edited["reference_rt"], "notes": edited["notes"],
                   "vendor": edited["vendor"], "source_sample_id": edited["source_sample_id"],
                   "peptide_analyte_id": edited["peptide_analyte_id"], "excluded_indices": [0]}


def _panel_text(v):
    """CalibrationPanel.tsx handleSave sends each text box as `trim() || null`."""
    return (v or "").strip() or None


def _ui_save(client, seeded, curve, notes):
    """What CalibrationPanel.tsx handleSave sends: every box as it stands (text trimmed, an empty
    box null), the points with them."""
    std = curve["standard_data"]
    body = {
        "reference_rt": curve["reference_rt"], "rt_tolerance": curve["rt_tolerance"],
        "diluent_density": curve["diluent_density"], "instrument_id": curve["instrument_id"],
        "peptide_analyte_id": curve["peptide_analyte_id"], "notes": _panel_text(notes),
        "source_sample_id": _panel_text(curve["source_sample_id"]), "vendor": _panel_text(curve["vendor"]),
        "standard_data": {"concentrations": std["concentrations"], "areas": std["areas"],
                          "rts": std.get("rts", []), "excluded_indices": []},
    }
    res = client.patch(f"/peptides/{seeded.peptide}/calibrations/{curve['id']}", json=body)
    assert res.status_code == 200, res.text
    return res.json()


@pytest.mark.parametrize("case", [1, 13])
def test_a_peptides_page_save_of_the_same_values_reads_unchanged(client, seeded, case):
    # Round 2 N2: that page rounds the fit to 6 places and works the RT out from the fitted points.
    first = _filed(client, _sheet(client, seeded, _case(case))["id"])
    sid, c = first["sheet"]["id"], first["curve"]
    after = _ui_save(client, seeded, c, c["notes"])
    assert after["reference_rt"] == c["reference_rt"]
    assert client.get(f"/hplc-calibration-sheets/{sid}").json()["curve_changed_since_filed"] is False
    assert _filed(client, sid)["warnings"] == []


@pytest.mark.parametrize("case", [1, 13])
def test_a_notes_only_save_on_the_peptides_page_names_the_notes_alone(client, seeded, case):
    # Review probes P1 and P2, round 2 N3: changed for the true reason, and the fit is not blamed.
    first = _filed(client, _sheet(client, seeded, _case(case))["id"])
    sid, c = first["sheet"]["id"], first["curve"]
    after = _ui_save(client, seeded, c, "edited on the Peptides page")
    assert after["reference_rt"] == c["reference_rt"]
    assert client.get(f"/hplc-calibration-sheets/{sid}").json()["curve_changed_since_filed"] is True
    out = _filed(client, sid)
    assert out["warnings"] == [_replaced(c["source_filename"], "its notes were changed")]
    assert "edited on the Peptides page" not in out["warnings"][0]
    assert out["curve"]["notes"] == c["notes"]


@pytest.mark.parametrize("typed", [{"notes": "Run on the new column\n"}, {"supplier": "Cayman Chemical "},
                                   {"notes": ""}, {"standard_id": " P-0111"}],
                         ids=["notes newline", "supplier space", "empty notes", "standard id space"])
def test_a_save_with_nothing_typed_reads_unchanged_whatever_the_edge_spaces(client, seeded, typed):
    # Round 3 R1, review sequence Q4: the panel trims, the worksheet files text as typed.
    inputs = _case(1)
    inputs.update(typed)
    first = _filed(client, _sheet(client, seeded, inputs)["id"])
    sid, c = first["sheet"]["id"], first["curve"]
    _ui_save(client, seeded, c, c["notes"])
    assert client.get(f"/hplc-calibration-sheets/{sid}").json()["curve_changed_since_filed"] is False
    assert _filed(client, sid)["warnings"] == []
    # A real edit is still named.
    _ui_save(client, seeded, c, (c["notes"] or "") + " checked")
    assert client.get(f"/hplc-calibration-sheets/{sid}").json()["curve_changed_since_filed"] is True
    assert _filed(client, sid)["warnings"] == [_replaced(c["source_filename"], "its notes were changed")]


def test_a_curve_never_touched_reads_unchanged_and_refiles_without_that_warning(client, seeded):
    sheet = _sheet(client, seeded, _case(1))
    first = _filed(client, sheet["id"])
    assert client.get(f"/hplc-calibration-sheets/{sheet['id']}").json()["curve_changed_since_filed"] is False
    again = _filed(client, sheet["id"])
    assert again["warnings"] == [] and again["sheet"]["curve_changed_since_filed"] is False
    assert again["curve"]["id"] == first["curve"]["id"]


def test_an_unfiled_sheet_reads_curve_unchanged(client, seeded):
    sheet = _sheet(client, seeded, _case(1))
    assert sheet["curve_changed_since_filed"] is False
    listed = client.get("/hplc-calibration-sheets", params={"peptide_id": seeded.peptide}).json()
    assert [r["curve_changed_since_filed"] for r in listed] == [None]  # never worked out per list row


def test_an_original_refile_says_what_it_replaced_on_an_injection(client, seeded, session):
    inputs = _case(1)
    original = _filed(client, _sheet(client, seeded, inputs)["id"])
    sid = original["sheet"]["id"]
    rep = _replicate(client, sid)
    rep_curve = _filed(client, rep["id"])["curve"]
    _peptides_page_edit(client, seeded, rep_curve, exclude=False, density=1000.0)
    assert client.get(f"/hplc-calibration-sheets/{rep['id']}").json()["curve_changed_since_filed"] is True
    inputs["stock"]["vial_standard_mg"] = 15729.5
    assert client.patch(f"/hplc-calibration-sheets/{sid}", json={"version": 1, "inputs": inputs}).status_code == 200
    out = _filed(client, sid, version=2)
    assert out["refiled_curve_ids"] == [rep_curve["id"]]
    assert out["warnings"] == [_replaced(rep_curve["source_filename"], "its diluent density was 1000 mg/mL")]
    assert client.get(f"/hplc-calibration-sheets/{rep['id']}").json()["curve_changed_since_filed"] is False


# ---- final review M1: a deadlock with a curve delete is a 409 -------------------------------------

DEADLOCK = "Someone changed one of these curves at the same moment, so nothing was filed. Try again."


def test_a_deadlock_is_a_409_that_writes_nothing(client, seeded, session, monkeypatch):
    from sqlalchemy.exc import OperationalError

    import main

    class Deadlock(Exception):
        pgcode = "40P01"

    def deadlocked(*args, **kwargs):
        raise OperationalError("SELECT ... FOR UPDATE", {}, Deadlock("deadlock detected"))

    sheet = _sheet(client, seeded, _case(1))
    monkeypatch.setattr(main, "_cal_curve_fields", deadlocked)
    assert _refused(client, session, sheet["id"], 409, None) == DEADLOCK


# ---- deferred from Task 5: poor-fit injections ------------------------------------------------------


def _poor_injection():
    """Case 20's run results with its areas reordered: a positive slope, r squared far below the floor."""
    rep = _case(20)
    areas = [L["peak_area"] for L in rep["levels"]]
    for L, j in zip(rep["levels"], (1, 3, 5, 2, 4, 0)):
        L["peak_area"] = areas[j]
    fit = _REAL_WORK_OUT(hplc_calibration.replicate_prep(_case(1), rep))["fit"]
    assert fit["slope"] > 0 and fit["r2"] < 0.99
    return rep, fit["r2"]


def test_a_poor_fit_injection_on_the_same_instrument_files_inactive_with_the_warning(client, seeded, session):
    original = _filed(client, _sheet(client, seeded, _case(1))["id"])
    inputs, r2 = _poor_injection()
    out = _filed(client, _replicate(client, original["sheet"]["id"], inputs=inputs)["id"])
    assert out["activation"] == {"active": False, "reason": "replicate", "deactivated_ids": [],
                                 "other_active_ids": []}
    assert out["warnings"] == [_poor_fit_warning(r2)]
    assert _row(session, original["curve"]["id"])["is_active"] is True


def test_a_poor_fit_injection_on_another_instrument_files_inactive(client, seeded, session):
    original = _filed(client, _sheet(client, seeded, _case(1))["id"])
    inputs, r2 = _poor_injection()
    out = _filed(client, _replicate(client, original["sheet"]["id"], instrument=seeded.inst2, inputs=inputs)["id"])
    assert out["activation"] == {"active": False, "reason": "poor_fit", "deactivated_ids": [],
                                 "other_active_ids": []}
    assert out["curve"]["is_active"] is False and out["warnings"] == [_poor_fit_warning(r2)]


def test_a_poor_fit_injection_beside_two_active_curves_touches_neither(client, seeded, session):
    original = _filed(client, _sheet(client, seeded, _case(1))["id"])
    a = _curve(session, seeded.peptide, seeded.inst2, True)
    b = _curve(session, seeded.peptide, seeded.inst2, True)
    before = {cid: _row(session, cid) for cid in (a, b)}
    inputs, r2 = _poor_injection()
    out = _filed(client, _replicate(client, original["sheet"]["id"], instrument=seeded.inst2, inputs=inputs)["id"])
    assert out["activation"] == {"active": False, "reason": "poor_fit", "deactivated_ids": [],
                                 "other_active_ids": [a, b]}
    assert out["warnings"] == [_poor_fit_warning(r2)]
    assert {cid: _row(session, cid) for cid in before} == before


def test_an_original_refile_warns_about_a_poor_fit_injection(client, seeded, session):
    inputs = _case(1)
    original = _filed(client, _sheet(client, seeded, inputs)["id"])
    sid = original["sheet"]["id"]
    rep = _replicate(client, sid)
    rep_curve = _filed(client, rep["id"])["curve"]
    poor, r2 = _poor_injection()
    assert client.patch(f"/hplc-calibration-sheets/{rep['id']}",
                        json={"version": rep["version"], "inputs": poor}).status_code == 200
    inputs["stock"]["vial_standard_mg"] = 15729.5
    assert client.patch(f"/hplc-calibration-sheets/{sid}", json={"version": 1, "inputs": inputs}).status_code == 200
    out = _filed(client, sid, version=2)
    r2 = _REAL_WORK_OUT(hplc_calibration.replicate_prep(inputs, poor))["fit"]["r2"]
    assert out["warnings"] == [(
        f"The injection {rep_curve['source_filename']} was re-filed with R squared {r2:.4f}, below 0.99, so check "
        "it: it is not active and was updated in place.")]
