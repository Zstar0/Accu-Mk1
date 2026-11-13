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
)

CASES = json.loads((Path(__file__).parent / "fixtures" / "hplc_calibration_cases.json").read_text())["cases"]
NEEDS_AREAS = "Type the peak areas of at least two levels first. The sheet is saved; file it once they are in."
CANNOT = "These numbers cannot be worked out. Correct the sheet, save it and file it again."
NO_PEPTIDE = "Pick the compound first. The curve is filed under it."
NO_INSTRUMENT = "Pick the instrument. A curve belongs to the instrument that ran it."
BLEND = "A curve is for one peptide. A blend's components each have their own."
STALE = "Someone else saved this sheet. It has been reloaded."
RESPONSE_KEYS = {"sheet", "curve", "activation", "refiled_curve_ids"}
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


def _replicate(client, sheet_id, instrument=None):
    """Duplicate for another injection, with fixture case 20's run results typed in."""
    rep = client.post(f"/hplc-calibration-sheets/{sheet_id}/duplicate")
    assert rep.status_code == 201, rep.text
    body = {"version": 1, "inputs": _case(20)}
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
    total = 0.0
    for rt in data["rts"]:
        total += rt
    assert out["curve"]["reference_rt"] == round(total / 4, 4)
    assert _row(session, out["curve"]["id"])["standard_data"] == data


def test_no_rts_files_no_reference_rt(client, seeded):
    inputs = _case(1)
    inputs["levels"][2]["rt"] = None
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
    if path != ("net", "parts_used"):
        assert detail == CANNOT


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
    assert detail == (f"Curve {first['curve']['source_filename']} has been used by 1 analysis, so its numbers are "
                      "part of their record. Start a new worksheet to file a corrected curve.")
    _analysis(session, seeded, first["curve"]["id"])
    assert "used by 2 analyses" in _refused(client, session, sheet["id"], 409, None, version=2)


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
    ops = session.execute(select(AuditLog.operation).where(
        AuditLog.entity_type == "calibration_curve", AuditLog.entity_id == str(rep_curve["id"]))
        .order_by(AuditLog.id)).scalars().all()
    assert ops == ["calibration_curve_filed", "calibration_curve_refiled"]


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
    assert detail.startswith(f"Curve {rep_curve['source_filename']} has been used by 1 analysis")


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


def test_after_resync_deletes_the_curve_the_sheet_files_again(client, seeded, session):
    # Review Focus 1: the re-sync deletes every curve of the peptide (main.py, resync).
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
    fit = lambda c: {"slope": c["slope"], "intercept": c["intercept"], "r_squared": c["r_squared"]}
    assert [op for op, _ in rows] == ["calibration_curve_filed", "calibration_curve_refiled"]
    assert rows[0][1] == {"user_id": user.id, "sheet_id": sheet["id"], "old": None, "new": fit(first["curve"]),
                          "activation": first["activation"]}
    assert rows[1][1] == {"user_id": user.id, "sheet_id": sheet["id"], "old": fit(first["curve"]),
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
