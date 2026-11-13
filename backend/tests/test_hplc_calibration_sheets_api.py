"""Calibration Curve Worksheet, Task 4 of plan 2026-11-13-hplc-calibration-curve-worksheet:
the sheet routes (list, create, read, save with a version check, duplicate for another
injection), through the real app against a scratch Postgres copy:

    HPLC_SCRATCH=p4t4 bash C:/tmp/hplc-build/local-pytest.sh ws tests/test_hplc_calibration_sheets_api.py -q
"""
import copy
import json
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

import database
from models import AuditLog, CalibrationCurve, HplcCalibrationSheet, Instrument, Peptide, User

BASE_KEYS = {
    "id", "version", "peptide_id", "peptide_name", "peptide_abbreviation", "instrument_id",
    "instrument_name", "replicate_of_sheet_id", "replicate_of_name", "curve_id", "curve_name",
    "curve_is_active", "filed_at", "updated_at", "updated_by_email", "changed_since_filed",
    "proposed_name", "blocking",
    # Final review I2: true | false on a single sheet's answers, null on a list row.
    "curve_changed_since_filed",
}
FULL_KEYS = BASE_KEYS | {"inputs", "effective_inputs"}

FULL = {
    "standard_id": "P-0111", "cas": "80714-61-0", "supplier": "Cayman", "lot": "27262",
    "coa_weight_mg": 50.0, "diluent_density_mg_ml": 997.1, "level_volume_ul": 1500.0,
    "analyst": "DS", "date": "2026-02-05", "notes": "first run",
    "net": {"counterion": "TFA", "counterion_mw": 114.02, "equivalents": 2.0, "free_mw": 1302.4,
            "stated_fw": 1530.44, "ms_mz": 652.21, "ms_ion": "M+2H", "assay_pct": 98.7,
            "water_pct": 3.1, "assumption": "2 TFA per molecule", "override_factor": 0.85,
            "override_reason": "CoA states net content"},
    "stock": {"vial_mg": 5000.1, "vial_standard_mg": 5030.2, "vial_diluent_mg": 6027.0},
    "stock_as_top": False, "top_aliquot_ul": 150.0,
    "levels": [{"target": t, "vial_mg": 4000.0 + i, "vial_diluent_mg": 4900.0 + i,
                "vial_diluent_std_mg": 5400.0 + i, "peak_area": 1000.0 * (6 - i), "purity": 99.1,
                "rt": 5.2} for i, t in enumerate((1000.0, 500.0, 250.0, 100.0, 10.0, 1.0))],
}

REPLICATE_SENTENCE = "Change the standard or a weighing there, and every injection follows."


@pytest.fixture(scope="module")
def migrated():
    name = database.engine.url.database or ""
    if not name.startswith("mk1_test"):
        pytest.skip(f"refusing to migrate {name!r}: run through the scratch-database harness")
    # The whole boot (create_all and every migration): the dev template can lag the model,
    # instruments.serial_number for one, and these tests insert instruments through it.
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
    u = User(email=f"calsheet-{uuid4().hex}@test.local", hashed_password="x")
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
    pep = Peptide(name="Cal sheet test", abbreviation=f"CS{tag}")
    blend = Peptide(name="Cal sheet blend", abbreviation=f"CSBL{tag}", is_blend=True)
    inst = Instrument(name=f"CSA{tag}", active=True)
    inst2 = Instrument(name=f"CSB{tag}", active=True)
    off = Instrument(name=f"CSX{tag}", active=False)
    session.add_all([pep, blend, inst, inst2, off])
    session.commit()
    return SimpleNamespace(peptide=pep.id, abbr=pep.abbreviation, blend=blend.id, inst=inst.id,
                           inst_name=inst.name, inst2=inst2.id, inst2_name=inst2.name, off=off.id)


def _create(client, seeded, inputs=None):
    body = {"peptide_id": seeded.peptide, "instrument_id": seeded.inst}
    if inputs is not None:
        body["inputs"] = inputs
    res = client.post("/hplc-calibration-sheets", json=body)
    assert res.status_code == 201, res.text
    return res.json()


def _curve(session, peptide_id, name, instrument_id=None):
    curve = CalibrationCurve(peptide_id=peptide_id, slope=1.0, intercept=0.0, r_squared=1.0,
                             is_active=False, source_filename=name, instrument_id=instrument_id)
    session.add(curve)
    session.commit()
    return curve.id


def _file(session, sheet_id, curve_id):
    """What Task 5's "File curve" leaves behind: the link and the filing time."""
    from datetime import datetime

    sheet = session.get(HplcCalibrationSheet, sheet_id)
    sheet.calibration_curve_id = curve_id
    # updated_at too: the column's onupdate would otherwise stamp it a moment after filed_at.
    sheet.filed_at = sheet.updated_at = datetime.utcnow()
    session.commit()


def _raw(body):
    """A JSON body that may carry NaN or Infinity, as Python's json (and a raw client) writes it."""
    return {"content": json.dumps(body), "headers": {"content-type": "application/json"}}


def _stored(session, sheet_id):
    session.expire_all()
    sheet = session.get(HplcCalibrationSheet, sheet_id)
    return copy.deepcopy(sheet.inputs), sheet.version, sheet.peptide_id, sheet.instrument_id


def test_read_model_declares_every_key(client, seeded):
    first = _create(client, seeded)
    second = _create(client, seeded)
    assert set(first) == FULL_KEYS
    got = client.get(f"/hplc-calibration-sheets/{first['id']}")
    assert got.status_code == 200
    assert set(got.json()) == FULL_KEYS
    listed = client.get("/hplc-calibration-sheets", params={"peptide_id": seeded.peptide})
    assert listed.status_code == 200
    rows = listed.json()
    assert [r["id"] for r in rows] == [second["id"], first["id"]]  # newest updated_at first
    assert all(set(r) == BASE_KEYS for r in rows)
    assert all(r["curve_changed_since_filed"] is None for r in rows)
    assert first["curve_changed_since_filed"] is False and got.json()["curve_changed_since_filed"] is False
    assert client.get("/hplc-calibration-sheets/999999999").status_code == 404


def test_create_starts_six_blank_levels_at_the_workbook_targets(client, seeded):
    from hplc_calibration import blank_inputs

    res = client.post("/hplc-calibration-sheets", json={})
    assert res.status_code == 201
    out = res.json()
    assert out["inputs"] == blank_inputs()
    assert [L["target"] for L in out["inputs"]["levels"]] == [1000, 500, 250, 100, 10, 1]
    assert out["version"] == 1
    assert out["peptide_id"] is None and out["instrument_id"] is None
    assert out["curve_id"] is None and out["changed_since_filed"] is False
    assert out["proposed_name"] == "1290-undated-std"


def test_a_save_round_trips_every_input_key(client, seeded, session, user):
    from hplc_calibration import blank_inputs

    sheet = _create(client, seeded)
    res = client.patch(f"/hplc-calibration-sheets/{sheet['id']}", json={"version": 1, "inputs": FULL})
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["version"] == 2
    assert out["updated_by_email"] == user.email
    assert set(FULL) == set(blank_inputs())
    assert out["inputs"] == FULL
    assert client.get(f"/hplc-calibration-sheets/{sheet['id']}").json()["inputs"] == FULL
    assert _stored(session, sheet["id"])[0] == FULL
    ops = session.execute(select(AuditLog.operation, AuditLog.details).where(
        AuditLog.entity_type == "hplc_calibration_sheet",
        AuditLog.entity_id == str(sheet["id"])).order_by(AuditLog.id)).all()
    assert [(op, d) for op, d in ops] == [
        ("hplc_calibration_sheet_created", {"user_id": user.id, "version": 1}),
        ("hplc_calibration_sheet_saved", {"user_id": user.id, "version": 2}),
    ]


@pytest.mark.parametrize("bad", [
    {"net": {"water_percent": 5}},
    {"levels": [{"target": 1000, "peak_areas": 5}]},
    {"stock": {"vial_mg": "5000"}},
    {"stock_as_top": 1},
    {"colour": "blue"},
])
def test_a_misspelled_key_is_a_422_not_a_silent_drop(client, seeded, session, bad):
    sheet = _create(client, seeded, FULL)
    before = _stored(session, sheet["id"])
    res = client.patch(f"/hplc-calibration-sheets/{sheet['id']}", json={"version": 1, "inputs": bad})
    assert res.status_code == 422, res.text
    assert _stored(session, sheet["id"]) == before
    top = client.patch(f"/hplc-calibration-sheets/{sheet['id']}", json={"version": 1, "colour": "blue"})
    assert top.status_code == 422
    assert _stored(session, sheet["id"]) == before


def test_a_stale_version_is_a_409_and_changes_nothing(client, seeded, session):
    sheet = _create(client, seeded, FULL)
    first = client.patch(f"/hplc-calibration-sheets/{sheet['id']}", json={"version": 1, "instrument_id": seeded.inst2})
    assert first.status_code == 200
    before = _stored(session, sheet["id"])
    res = client.patch(f"/hplc-calibration-sheets/{sheet['id']}",
                       json={"version": 1, "instrument_id": seeded.inst, "inputs": {"levels": [{"target": 5}]}})
    assert res.status_code == 409
    assert res.json()["detail"] == "Someone else saved this sheet. It has been reloaded."
    assert _stored(session, sheet["id"]) == before
    assert before[1] == 2


def _at(path, value):
    def apply(inputs):
        holder = inputs
        for p in path[:-1]:
            holder = holder[p]
        holder[path[-1]] = value
    return apply


REFUSALS = [
    ("nan weighing", _at(("stock", "vial_mg"), float("nan")), "Stock Vial + cap (mg): that is not a number"),
    ("inf peak area", _at(("levels", 0, "peak_area"), float("inf")), "Level 1, Peak Area: that is not a number"),
    ("nan net", _at(("net", "assay_pct"), float("-inf")), "CoA assay (%): that is not a number"),
    ("negative weighing", _at(("stock", "vial_mg"), -1.0), "Stock Vial + cap (mg): a balance reading"),
    ("huge weighing", _at(("levels", 1, "vial_diluent_mg"), 2e9), "Level 2, Vial, cap and Diluent (mg): a balance reading"),
    ("negative coa weight", _at(("coa_weight_mg",), -0.5), "Weight from COA (mg): a balance reading"),
    ("zero target", _at(("levels", 0, "target"), 0), "Level 1, Target (ug/mL): must be at least 0.000001."),
    ("tiny target", _at(("levels", 0, "target"), 9e-7), "Level 1, Target (ug/mL): must be at least 0.000001."),
    ("negative density", _at(("diluent_density_mg_ml",), -997.1), "Diluent density (mg/mL): must be from 500 to 2000."),
    ("tiny density", _at(("diluent_density_mg_ml",), 9e-7), "Diluent density (mg/mL): must be from 500 to 2000."),
    ("density in g/mL", _at(("diluent_density_mg_ml",), 0.9971), "Diluent density (mg/mL): must be from 500 to 2000."),
    ("density under 500", _at(("diluent_density_mg_ml",), 499.99), "Diluent density (mg/mL): must be from 500 to 2000."),
    ("density over 2000", _at(("diluent_density_mg_ml",), 2000.01), "Diluent density (mg/mL): must be from 500 to 2000."),
    ("zero level volume", _at(("level_volume_ul",), 0), "Level volume (uL): must be at least 0.000001."),
    ("tiny level volume", _at(("level_volume_ul",), 9e-7), "Level volume (uL): must be at least 0.000001."),
    ("zero aliquot", _at(("top_aliquot_ul",), 0), "Aliquot (uL): must be at least 0.000001."),
    ("tiny aliquot", _at(("top_aliquot_ul",), 9e-7), "Aliquot (uL): must be at least 0.000001."),
    ("zero override", _at(("net", "override_factor"), 0),
     "Net factor, entered by hand: must be more than 0 and no more than 2."),
    ("override over 2", _at(("net", "override_factor"), 2.01),
     "Net factor, entered by hand: must be more than 0 and no more than 2."),
    ("zero free mw", _at(("net", "free_mw"), 0), "Free-peptide MW (g/mol): must be at least 1."),
    ("free mw under 1", _at(("net", "free_mw"), 0.999), "Free-peptide MW (g/mol): must be at least 1."),
    ("negative stated fw", _at(("net", "stated_fw"), -1530.0), "Stated FW on the CoA (g/mol): must be at least 1."),
    ("stated fw under 1", _at(("net", "stated_fw"), 0.5), "Stated FW on the CoA (g/mol): must be at least 1."),
    ("zero counterion mw", _at(("net", "counterion_mw"), 0), "Counterion mass (g/mol per eq): must be at least 1."),
    ("tiny counterion mw", _at(("net", "counterion_mw"), 1e-300), "Counterion mass (g/mol per eq): must be at least 1."),
    ("zero equivalents", _at(("net", "equivalents"), 0), "Equivalents (n): must be from 0.01 to 100."),
    ("equivalents under 0.01", _at(("net", "equivalents"), 0.009), "Equivalents (n): must be from 0.01 to 100."),
    ("equivalents over 100", _at(("net", "equivalents"), 100.01), "Equivalents (n): must be from 0.01 to 100."),
    ("zero ms", _at(("net", "ms_mz"), 0), "Mass spec on the CoA (m/z): must be at least 1."),
    ("ms under 1", _at(("net", "ms_mz"), 0.5), "Mass spec on the CoA (m/z): must be at least 1."),
    ("zero assay", _at(("net", "assay_pct"), 0), "CoA assay (%): must be more than 0 and no more than 150"),
    ("assay over 150", _at(("net", "assay_pct"), 150.5), "CoA assay (%): must be more than 0 and no more than 150"),
    ("negative water", _at(("net", "water_pct"), -0.1), "Water, Karl Fischer (%): must be 0 or more and less than 100"),
    ("water 100", _at(("net", "water_pct"), 100), "Water, Karl Fischer (%): must be 0 or more and less than 100"),
    ("huge peak area", _at(("levels", 2, "peak_area"), 1e13), "Level 3, Peak Area: that number is far too large"),
    ("huge negative rt", _at(("levels", 2, "rt"), -1e300), "Level 3, RT (min): that number is far too large"),
    ("negative rt", _at(("levels", 2, "rt"), -0.1), "Level 3, RT (min): must be 0 or more."),
    ("no levels", _at(("levels",), []), "The sheet needs at least one level."),
    ("null levels", _at(("levels",), None), "The sheet needs at least one level."),
    ("13 levels", _at(("levels",), [{"target": 1.0}] * 13), "A sheet holds at most 12 levels."),
    ("null level", _at(("levels", 1), None), "Level 2: the row is empty."),
    ("unknown counterion", _at(("net", "counterion"), "Citrate"),
     "Counterion: pick one of Acetate, TFA, HCl, Iodide, Sodium or Other, or leave it blank."),
    ("unknown ion", _at(("net", "ms_ion"), "M+5H"), "Ion: pick one of M, M+H, M+2H"),
    ("date not iso", _at(("date",), "05/02/2026"), "Date: write it as YYYY-MM-DD"),
    ("date not a day", _at(("date",), "2026-02-30"), "Date: write it as YYYY-MM-DD"),
    ("long lot", _at(("lot",), "x" * 201), "Lot #: at most 200 characters"),
    ("long notes", _at(("notes",), "x" * 2001), "Notes: at most 2000 characters"),
    ("long assumption", _at(("net", "assumption"), "x" * 2001), "Counterion assumption, in words: at most 2000 characters"),
]


@pytest.mark.parametrize("name,change,reason", REFUSALS, ids=[r[0] for r in REFUSALS])
def test_each_refusal_names_its_reason(client, seeded, session, name, change, reason):
    sheet = _create(client, seeded, FULL)
    before = _stored(session, sheet["id"])
    inputs = copy.deepcopy(FULL)
    change(inputs)
    res = client.patch(f"/hplc-calibration-sheets/{sheet['id']}", **_raw({"version": 1, "inputs": inputs}))
    assert res.status_code == 400, res.text
    assert reason in res.json()["detail"]
    assert _stored(session, sheet["id"]) == before
    # The same refusal on create, and nothing is made.
    count = session.execute(select(HplcCalibrationSheet.id)).all()
    made = client.post("/hplc-calibration-sheets", **_raw({"inputs": inputs}))
    assert made.status_code == 400 and reason in made.json()["detail"]
    assert session.execute(select(HplcCalibrationSheet.id)).all() == count


def test_the_typed_limits_still_save(client, seeded):
    inputs = copy.deepcopy(FULL)
    inputs["net"].update(assay_pct=150, water_pct=0, counterion="Other", ms_ion="")
    inputs["stock"]["vial_mg"] = 0
    inputs["levels"] = [{"target": 1.0}] * 12
    sheet = _create(client, seeded, inputs)
    assert len(sheet["inputs"]["levels"]) == 12
    assert sheet["inputs"]["net"]["counterion"] == "Other"


ACCEPTED_BOUNDS = [
    (("net", "free_mw"), 1), (("net", "stated_fw"), 1), (("net", "counterion_mw"), 1), (("net", "ms_mz"), 1),
    (("net", "equivalents"), 0.01), (("net", "equivalents"), 100),
    (("net", "override_factor"), 2), (("net", "override_factor"), 1e-9),
    (("levels", 0, "target"), 1e-6), (("diluent_density_mg_ml",), 500), (("diluent_density_mg_ml",), 2000),
    (("level_volume_ul",), 1e-6),
    (("top_aliquot_ul",), 1e-6), (("stock", "vial_mg"), 0), (("net", "assay_pct"), 150), (("net", "water_pct"), 0),
]


@pytest.mark.parametrize("path,value", ACCEPTED_BOUNDS, ids=[f"{p[-1]}={v}" for p, v in ACCEPTED_BOUNDS])
def test_each_bound_itself_saves(client, seeded, path, value):
    inputs = copy.deepcopy(FULL)
    inputs["net"]["counterion"] = "Other"  # so counterion_mw is read, not the table's
    _at(path, value)(inputs)
    sheet = _create(client, seeded, inputs)
    holder = sheet["inputs"]
    for p in path:
        holder = holder[p]
    assert holder == value


def test_the_tiny_counterion_body_is_refused_and_nothing_is_stored(client, seeded, session):
    # The review's C1 body: it used to be stored and then break the sheet and the list for everyone.
    inputs = copy.deepcopy(FULL)
    inputs["net"].update(counterion="Other", counterion_mw=1e-300, stated_fw=1e12)
    count = session.execute(select(HplcCalibrationSheet.id)).all()
    res = client.post("/hplc-calibration-sheets", json={"inputs": inputs})
    assert res.status_code == 400
    assert session.execute(select(HplcCalibrationSheet.id)).all() == count


def _raising(*_a, **_k):
    raise OverflowError("cannot work this out")


def test_inputs_that_cannot_be_worked_out_are_never_stored(client, seeded, session, monkeypatch):
    import hplc_calibration

    sentence = "These numbers cannot be worked out. Check the values just typed."
    sheet = _create(client, seeded, FULL)
    before = _stored(session, sheet["id"])
    count = session.execute(select(HplcCalibrationSheet.id)).all()
    monkeypatch.setattr(hplc_calibration, "work_out_sheet", _raising)
    made = client.post("/hplc-calibration-sheets", json={"inputs": FULL})
    assert made.status_code == 400 and made.json()["detail"] == sentence
    assert session.execute(select(HplcCalibrationSheet.id)).all() == count
    changed = copy.deepcopy(FULL)
    changed["lot"] = "other lot"
    res = client.patch(f"/hplc-calibration-sheets/{sheet['id']}", json={"version": 1, "inputs": changed})
    assert res.status_code == 400 and res.json()["detail"] == sentence
    assert _stored(session, sheet["id"]) == before
    # The same guard on a replicate's save (its effective inputs are worked out). Here the
    # original cannot be worked out either, so the refusal names it (Task 5, carried item).
    monkeypatch.undo()
    orig_name = f"orig-{uuid4().hex}"
    _file(session, sheet["id"], _curve(session, seeded.peptide, orig_name, seeded.inst))
    rep = client.post(f"/hplc-calibration-sheets/{sheet['id']}/duplicate").json()
    rep_before = _stored(session, rep["id"])
    monkeypatch.setattr(hplc_calibration, "work_out_sheet", _raising)
    res = client.patch(f"/hplc-calibration-sheets/{rep['id']}",
                       json={"version": 1, "inputs": {"levels": [{"peak_area": 5.0}]}})
    assert res.status_code == 400
    assert res.json()["detail"] == f"The original sheet, {orig_name}, cannot be worked out. Correct it there."
    assert _stored(session, rep["id"]) == rep_before


def test_one_unworkable_sheet_never_breaks_the_read_or_the_list(client, seeded, monkeypatch):
    import hplc_calibration

    sheet = _create(client, seeded, FULL)
    monkeypatch.setattr(hplc_calibration, "work_out_sheet", _raising)
    got = client.get(f"/hplc-calibration-sheets/{sheet['id']}")
    assert got.status_code == 200
    assert got.json()["blocking"] == ["cannot_be_worked_out"]
    assert got.json()["inputs"] == FULL
    listed = client.get("/hplc-calibration-sheets", params={"peptide_id": seeded.peptide})
    assert listed.status_code == 200
    assert [r["blocking"] for r in listed.json() if r["id"] == sheet["id"]] == [["cannot_be_worked_out"]]


@pytest.mark.parametrize("stored", [{"levels": {"a": 1}}, [1, 2], {"levels": [1, "x"]}, {"net": [1], "levels": []}])
def test_malformed_stored_inputs_read_and_duplicate_without_a_500(client, seeded, session, stored):
    # Possible only by a direct database write.
    sheet = _create(client, seeded, FULL)
    _file(session, sheet["id"], _curve(session, seeded.peptide, f"bad-{uuid4().hex}", seeded.inst))
    row = session.get(HplcCalibrationSheet, sheet["id"])
    row.inputs = stored
    session.commit()
    got = client.get(f"/hplc-calibration-sheets/{sheet['id']}")
    assert got.status_code == 200
    assert got.json()["blocking"] == ["cannot_be_worked_out"]
    listed = client.get("/hplc-calibration-sheets", params={"peptide_id": seeded.peptide})
    assert listed.status_code == 200
    dup = client.post(f"/hplc-calibration-sheets/{sheet['id']}/duplicate")
    assert dup.status_code == 201
    levels = stored.get("levels") if isinstance(stored, dict) else None
    assert len(dup.json()["inputs"]["levels"]) == (len(levels) if isinstance(levels, list) else 0)
    assert client.get(f"/hplc-calibration-sheets/{dup.json()['id']}").status_code == 200


def test_an_unchanged_save_writes_nothing(client, seeded, session, user):
    sheet = _create(client, seeded, FULL)
    _file(session, sheet["id"], _curve(session, seeded.peptide, f"same-{uuid4().hex}", seeded.inst))
    session.expire_all()
    stamped = session.get(HplcCalibrationSheet, sheet["id"]).updated_at
    audits = session.execute(select(AuditLog.id).where(AuditLog.entity_id == str(sheet["id"]),
                                                       AuditLog.entity_type == "hplc_calibration_sheet")).all()
    for body in ({}, {"inputs": copy.deepcopy(FULL)},
                 {"inputs": FULL, "peptide_id": seeded.peptide, "instrument_id": seeded.inst}):
        res = client.patch(f"/hplc-calibration-sheets/{sheet['id']}", json={"version": 1, **body})
        assert res.status_code == 200, res.text
        assert res.json()["version"] == 1
        assert res.json()["changed_since_filed"] is False
    session.expire_all()
    assert session.get(HplcCalibrationSheet, sheet["id"]).updated_at == stamped
    assert session.execute(select(AuditLog.id).where(AuditLog.entity_id == str(sheet["id"]),
                                                     AuditLog.entity_type == "hplc_calibration_sheet")).all() == audits
    # The stale-version check still comes first.
    assert client.patch(f"/hplc-calibration-sheets/{sheet['id']}", json={"version": 7}).status_code == 409


@pytest.mark.parametrize("body,reason", [
    ({"peptide_id": 999999999}, "That peptide is not on file"),
    ({"peptide_id": 2 ** 40}, "That peptide is not on file"),
    ({"instrument_id": 999999999}, "That instrument is not on file or is no longer in use"),
    ({"version": 2 ** 53}, "version: that number is far too large"),
    ({"inputs": None}, "A sheet always keeps its inputs"),
])
def test_each_sheet_level_refusal_names_its_reason(client, seeded, session, body, reason):
    sheet = _create(client, seeded, FULL)
    before = _stored(session, sheet["id"])
    res = client.patch(f"/hplc-calibration-sheets/{sheet['id']}", json={"version": 1, **body})
    assert res.status_code == 400, res.text
    assert reason in res.json()["detail"]
    assert _stored(session, sheet["id"]) == before


def test_an_inactive_instrument_is_refused(client, seeded, session):
    res = client.post("/hplc-calibration-sheets", json={"instrument_id": seeded.off})
    assert res.status_code == 400
    assert "That instrument is not on file or is no longer in use" in res.json()["detail"]
    sheet = _create(client, seeded)
    res = client.patch(f"/hplc-calibration-sheets/{sheet['id']}", json={"version": 1, "instrument_id": seeded.off})
    assert res.status_code == 400
    assert _stored(session, sheet["id"])[3] == seeded.inst


def test_a_blend_peptide_is_refused(client, seeded, session):
    sentence = "A curve is for one peptide. A blend's components each have their own."
    res = client.post("/hplc-calibration-sheets", json={"peptide_id": seeded.blend})
    assert res.status_code == 400 and res.json()["detail"] == sentence
    sheet = _create(client, seeded)
    res = client.patch(f"/hplc-calibration-sheets/{sheet['id']}", json={"version": 1, "peptide_id": seeded.blend})
    assert res.status_code == 400 and res.json()["detail"] == sentence
    assert _stored(session, sheet["id"])[2] == seeded.peptide


def test_changing_the_instrument_of_a_filed_sheet_is_refused(client, seeded, session):
    # Review Focus 4: re-filing would move a curve analyses used on one instrument onto another.
    sheet = _create(client, seeded, FULL)
    curve_id = _curve(session, seeded.peptide, f"rf4-{uuid4().hex}", seeded.inst)
    _file(session, sheet["id"], curve_id)
    before = _stored(session, sheet["id"])
    sentence = (f"This curve is filed on {seeded.inst_name}. To run the same vials on another instrument, "
                "use Duplicate for another injection.")
    for body in ({"instrument_id": seeded.inst2}, {"instrument_id": None}, {"peptide_id": None}):
        res = client.patch(f"/hplc-calibration-sheets/{sheet['id']}", json={"version": 1, **body})
        assert res.status_code == 409, body
        assert res.json()["detail"] == sentence
        assert _stored(session, sheet["id"]) == before
    # Sending the same instrument and peptide back is not a change.
    same = client.patch(f"/hplc-calibration-sheets/{sheet['id']}",
                        json={"version": 1, "instrument_id": seeded.inst, "peptide_id": seeded.peptide})
    assert same.status_code == 200
    assert (same.json()["changed_since_filed"], same.json()["version"]) == (False, 1)
    # Once a re-sync deletes the curve (Review Focus 1), the sheet is free again.
    session.delete(session.get(CalibrationCurve, curve_id))
    session.commit()
    freed = client.patch(f"/hplc-calibration-sheets/{sheet['id']}", json={"version": 1, "instrument_id": seeded.inst2})
    assert freed.status_code == 200, freed.text
    assert freed.json()["instrument_id"] == seeded.inst2


def test_duplicate_needs_a_filed_original(client, seeded, session):
    sheet = _create(client, seeded, FULL)
    count = session.execute(select(HplcCalibrationSheet.id)).all()
    res = client.post(f"/hplc-calibration-sheets/{sheet['id']}/duplicate")
    assert res.status_code == 400
    assert res.json()["detail"] == "File the curve first. The copy is named after it."
    assert session.execute(select(HplcCalibrationSheet.id)).all() == count
    assert client.post("/hplc-calibration-sheets/999999999/duplicate").status_code == 404


def test_duplicate_of_a_duplicate_points_at_the_original(client, seeded, session, user):
    from hplc_calibration import blank_replicate_inputs

    sheet = _create(client, seeded, FULL)
    _file(session, sheet["id"], _curve(session, seeded.peptide, f"orig-{uuid4().hex}", seeded.inst))
    res = client.post(f"/hplc-calibration-sheets/{sheet['id']}/duplicate")
    assert res.status_code == 201, res.text
    rep = res.json()
    assert set(rep) == FULL_KEYS
    assert rep["replicate_of_sheet_id"] == sheet["id"]
    assert (rep["peptide_id"], rep["instrument_id"]) == (seeded.peptide, seeded.inst)
    assert rep["inputs"] == blank_replicate_inputs(6)
    assert rep["version"] == 1 and rep["curve_id"] is None
    again = client.post(f"/hplc-calibration-sheets/{rep['id']}/duplicate")
    assert again.status_code == 201
    assert again.json()["replicate_of_sheet_id"] == sheet["id"]
    audit = session.execute(select(AuditLog.operation, AuditLog.details).where(
        AuditLog.entity_type == "hplc_calibration_sheet", AuditLog.entity_id == str(rep["id"]))).all()
    assert [(op, d) for op, d in audit] == [("hplc_calibration_sheet_created", {"user_id": user.id, "version": 1})]


def test_a_replicate_save_refuses_a_weighing(client, seeded, session):
    sheet = _create(client, seeded, FULL)
    curve_name = f"orig-{uuid4().hex}"
    _file(session, sheet["id"], _curve(session, seeded.peptide, curve_name, seeded.inst))
    rep = client.post(f"/hplc-calibration-sheets/{sheet['id']}/duplicate").json()
    before = _stored(session, rep["id"])
    sentence = f"This sheet is another injection of {curve_name}. {REPLICATE_SENTENCE}"
    for body in ({"inputs": {"levels": [{"vial_mg": 4000.0}]}},
                 {"inputs": copy.deepcopy(FULL)},
                 {"peptide_id": seeded.peptide}):
        res = client.patch(f"/hplc-calibration-sheets/{rep['id']}", json={"version": 1, **body})
        assert res.status_code == 400, body
        assert res.json()["detail"] == sentence
        assert _stored(session, rep["id"]) == before
    # A misspelled run result is still a 422; a number out of range a 400.
    assert client.patch(f"/hplc-calibration-sheets/{rep['id']}",
                        json={"version": 1, "inputs": {"levels": [{"peak_areaa": 1}]}}).status_code == 422
    # A wrong type is a 422 too, never the "another injection" sentence.
    for wrong in ({"levels": None}, {"levels": {"peak_area": 1}}, {"notes": 5}):
        res = client.patch(f"/hplc-calibration-sheets/{rep['id']}", json={"version": 1, "inputs": wrong})
        assert res.status_code == 422, wrong
    assert _stored(session, rep["id"]) == before
    bad = client.patch(f"/hplc-calibration-sheets/{rep['id']}",
                       **_raw({"version": 1, "inputs": {"levels": [{"peak_area": float("nan")}]}}))
    assert bad.status_code == 400 and "Level 1, Peak Area" in bad.json()["detail"]
    hole = client.patch(f"/hplc-calibration-sheets/{rep['id']}",
                        json={"version": 1, "inputs": {"levels": [{"peak_area": 1.0}, None]}})
    assert hole.status_code == 400 and hole.json()["detail"].startswith("Level 2: the row is empty.")
    assert _stored(session, rep["id"]) == before
    # Its own instrument is free until its own curve is filed; run results save.
    ok = client.patch(f"/hplc-calibration-sheets/{rep['id']}", json={
        "version": 1, "instrument_id": seeded.inst2,
        "inputs": {"notes": "second injection", "levels": [{"peak_area": 5.0, "purity": 98.0, "rt": 5.3}]}})
    assert ok.status_code == 200, ok.text
    assert ok.json()["inputs"] == {"notes": "second injection",
                                   "levels": [{"peak_area": 5.0, "purity": 98.0, "rt": 5.3}]}


def test_effective_inputs_take_the_originals_weighings_and_the_replicates_areas(client, seeded, session):
    from hplc_calibration import replicate_prep, work_out_sheet

    sheet = _create(client, seeded, FULL)
    _file(session, sheet["id"], _curve(session, seeded.peptide, f"orig-{uuid4().hex}", seeded.inst))
    rep = client.post(f"/hplc-calibration-sheets/{sheet['id']}/duplicate").json()
    areas = [{"peak_area": 2000.0 * (6 - i), "purity": None, "rt": 5.4} for i in range(6)]
    out = client.patch(f"/hplc-calibration-sheets/{rep['id']}",
                       json={"version": 1, "inputs": {"notes": "inj 2", "levels": areas}}).json()
    eff = out["effective_inputs"]
    assert eff == replicate_prep(FULL, out["inputs"])
    assert eff["stock"] == FULL["stock"] and eff["net"] == FULL["net"] and eff["notes"] == "inj 2"
    assert [L["vial_mg"] for L in eff["levels"]] == [L["vial_mg"] for L in FULL["levels"]]
    assert [L["peak_area"] for L in eff["levels"]] == [a["peak_area"] for a in areas]
    assert out["blocking"] == work_out_sheet(eff)["blocking"]
    # A weighing corrected on the original reaches the replicate.
    fixed = copy.deepcopy(FULL)
    fixed["stock"]["vial_standard_mg"] = 5031.0
    assert client.patch(f"/hplc-calibration-sheets/{sheet['id']}",
                        json={"version": 1, "inputs": fixed}).status_code == 200
    again = client.get(f"/hplc-calibration-sheets/{rep['id']}").json()
    assert again["effective_inputs"]["stock"]["vial_standard_mg"] == 5031.0


def test_blocking_comes_from_the_working_out(client, seeded):
    inputs = copy.deepcopy(FULL)
    inputs["net"]["override_reason"] = None
    inputs["net"]["assumption"] = None
    out = _create(client, seeded, inputs)
    assert out["blocking"] == ["net_assumption_missing", "override_reason_missing"]
    listed = client.get("/hplc-calibration-sheets", params={"peptide_id": seeded.peptide}).json()
    assert next(r for r in listed if r["id"] == out["id"])["blocking"] == out["blocking"]


def test_proposed_name_follows_calsheetname(client, seeded, session):
    sheet = _create(client, seeded, FULL)
    name = f"{seeded.inst_name}-2026-02-05-{seeded.abbr}"
    assert sheet["proposed_name"] == name
    # A taken name gets -2, then -3.
    _curve(session, seeded.peptide, name)
    assert client.get(f"/hplc-calibration-sheets/{sheet['id']}").json()["proposed_name"] == f"{name}-2"
    _curve(session, seeded.peptide, f"{name}-2")
    assert client.get(f"/hplc-calibration-sheets/{sheet['id']}").json()["proposed_name"] == f"{name}-3"
    # Filed: the curve's own name, and the replicate is named after it.
    filed = f"{name}-3"
    curve_id = _curve(session, seeded.peptide, filed, seeded.inst)
    _file(session, sheet["id"], curve_id)
    got = client.get(f"/hplc-calibration-sheets/{sheet['id']}").json()
    assert (got["proposed_name"], got["curve_name"], got["curve_id"]) == (filed, filed, curve_id)
    assert got["curve_is_active"] is False and got["changed_since_filed"] is False
    rep = client.post(f"/hplc-calibration-sheets/{sheet['id']}/duplicate").json()
    assert rep["proposed_name"] == f"{filed}-Inj2"
    assert rep["replicate_of_name"] == filed
    _curve(session, seeded.peptide, f"{filed}-Inj2", seeded.inst)
    assert client.get(f"/hplc-calibration-sheets/{rep['id']}").json()["proposed_name"] == f"{filed}-Inj3"
    # Moved to another instrument: that instrument's own name, from the original's date.
    moved = client.patch(f"/hplc-calibration-sheets/{rep['id']}",
                         json={"version": 1, "instrument_id": seeded.inst2}).json()
    assert moved["proposed_name"] == f"{seeded.inst2_name}-2026-02-05-{seeded.abbr}"
    # No instrument at all: still an injection of the original (calSheetName: !cal.instrument).
    none = client.patch(f"/hplc-calibration-sheets/{rep['id']}", json={"version": 2, "instrument_id": None}).json()
    assert none["proposed_name"] == f"{filed}-Inj3"


def test_the_list_filters_by_peptide(client, seeded, session):
    mine = _create(client, seeded)
    other = client.post("/hplc-calibration-sheets", json={}).json()
    rows = client.get("/hplc-calibration-sheets", params={"peptide_id": seeded.peptide}).json()
    assert [r["id"] for r in rows] == [mine["id"]]
    everything = client.get("/hplc-calibration-sheets").json()
    assert {mine["id"], other["id"]} <= {r["id"] for r in everything}


def test_the_list_pages_newest_first(client, seeded):
    ids = [_create(client, seeded)["id"] for _ in range(3)]
    page = {"peptide_id": seeded.peptide}
    assert [r["id"] for r in client.get("/hplc-calibration-sheets", params={**page, "limit": 2}).json()] == ids[:0:-1]
    assert [r["id"] for r in client.get("/hplc-calibration-sheets",
                                        params={**page, "limit": 2, "offset": 2}).json()] == ids[:1]
    assert len(client.get("/hplc-calibration-sheets", params={"limit": 500}).json()) <= 500
    for bad in ({"limit": 0}, {"limit": 501}, {"offset": -1}):
        assert client.get("/hplc-calibration-sheets", params=bad).status_code == 422


def _list_queries(client, peptide_id):
    from sqlalchemy import event

    seen = []

    def count(*_a, **_k):
        seen.append(1)

    event.listen(database.engine, "before_cursor_execute", count)
    try:
        res = client.get("/hplc-calibration-sheets", params={"peptide_id": peptide_id})
    finally:
        event.remove(database.engine, "before_cursor_execute", count)
    assert res.status_code == 200
    return len(res.json()), len(seen)


def test_the_list_queries_do_not_grow_with_the_page(client, seeded, session):
    def one_filed_family():
        sheet = _create(client, seeded, FULL)
        _file(session, sheet["id"], _curve(session, seeded.peptide, f"q-{uuid4().hex}", seeded.inst))
        rep = client.post(f"/hplc-calibration-sheets/{sheet['id']}/duplicate").json()
        client.patch(f"/hplc-calibration-sheets/{rep['id']}", json={"version": 1, "instrument_id": seeded.inst2})
        _create(client, seeded)

    one_filed_family()
    rows_small, small = _list_queries(client, seeded.peptide)
    for _ in range(3):
        one_filed_family()
    rows_big, big = _list_queries(client, seeded.peptide)
    assert (rows_small, rows_big) == (3, 12)
    assert big == small
