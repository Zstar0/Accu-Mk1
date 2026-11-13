"""Promote (plan 2026-11-12-hplc-prep-worksheet, Task 6): a finished HPLC worksheet row becomes
one sample_preps row that Process HPLC picks up.

promote_reasons is pure. The rest use test_worksheets_hplc.py's world: an in-memory SQLite
session for the LIMS tables and the real sample_preps table of the Postgres mk1_db is
configured for (they skip where there is none). Every prep a test makes is deleted afterwards.
Locally:

    HPLC_SCRATCH=t6 bash C:/tmp/hplc-build/local-pytest.sh ws tests/test_worksheets_hplc_promote.py -q
"""
import importlib.util
import json
import os
import pathlib
import threading
import uuid
from unittest.mock import MagicMock

import endo_prep_rules
import main
import mk1_db
import psycopg2
import pytest
import worksheets_hplc
import worksheets_hplc_promote as promote_mod
from calculations.hplc_processor import IntermediateWeights, WeightInputs, calculate_dilution_factor
from catalog.method_run_params import hplc_run_params
from hplc_prep import compute_row
from hplc_prep_rules import load_rules
from models import (
    AnalysisService,
    CalibrationCurve,
    HplcPrepRule,
    Instrument,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
    Settings,
    WorksheetItem,
)
from tests.test_worksheets_hplc import (  # noqa: F401  (db, client, promote are fixtures)
    _analysis,
    _form,
    _item,
    _method,
    _peptide,
    _sample,
    _ws,
    client,
    db,
    promote,
)
from worksheets_hplc_promote import promote_reasons

PARAMS = hplc_run_params(None)
DENSITY = PARAMS["diluent_density_mg_ml"]


@pytest.fixture(autouse=True)
def _drop_preps(request):
    """Delete every prep made from an item of this test's session, however it was made. The
    session is asked for at setup, so it is torn down after this fixture, not before."""
    session = request.getfixturevalue("db") if "db" in request.fixturenames else None
    yield
    if session is None:
        return
    ids = [i for (i,) in session.query(WorksheetItem.id).all()]
    for prep in mk1_db.list_sample_preps_for_worksheet_items(ids) if ids else []:
        mk1_db.delete_sample_prep(prep["id"])


# --- the finished rows, one per kind ------------------------------------------------------

# Weighings that read cleanly: no step goes backwards and every volume is near its plan.
_STOCK = {"stock_vial_mg": 5000.0, "stock_vial_diluent_mg": 7991.3}       # 2991.3 mg ~ 3.0 mL
_VIAL = {"vial_mg": 2500.0, "vial_diluent_mg": 3906.0, "vial_all_mg": 3996.0}
_INPUTS = {
    "powder": {**_STOCK, "vials": {"1": dict(_VIAL)}},
    "two_step": {**_STOCK, "declared_mg": 600.0, "vials": {"1": {
        "vial_mg": 2500.0, "vial_diluent_mg": 3936.0, "vial_all_mg": 3996.2,
        "int_vial_mg": 2400.0, "int_vial_diluent_mg": 3858.0, "int_vial_all_mg": 3895.6}}},
    "liquid": {"declared_volume_ml": 3.0, "vials": {"1": dict(_VIAL)}},
    # the sheet's own order: the vial full as received (weighed first), then emptied and dried
    "bac": {"stock_vial_diluent_mg": 8003.6, "stock_vial_mg": 5012.31,
            "vials": {"1": {"vial_mg": 2500.0, "vial_diluent_mg": 3914.0, "vial_all_mg": 3997.0}}},
    # 4 capsules of 2.5 mg in about 30 mL: 333 ug/mL, under the neat ceiling; "+ diluent" blank
    "capsule": {"declared_mg": 2.5, "capsules": 4, "stock_vial_mg": 5000.0, "stock_vial_diluent_mg": 34913.0,
                "vials": {"1": {"vial_mg": 2500.0, "vial_all_mg": 3995.0}}},
}
_FORMS = {"powder": "powder", "two_step": "powder", "liquid": "liquid", "bac": "bac", "capsule": "capsule"}


def _instrument(db, name="HPLC 1290a"):
    inst = Instrument(name=name)
    db.add(inst)
    db.flush()
    return inst


def _solo(db, kind="powder", *, instrument=True, from_analyses=False, sample_id="P-0600", **columns):
    """A finished solo row of `kind` on an open worksheet. from_analyses: a sample born in the
    older LIMS, whose peptide comes from its live analyses (components_source "analyses")."""
    bpc = _peptide(db, "BPC-157")
    ws = _ws(db)
    inst = _instrument(db) if instrument else None
    parent = _sample(db, sample_id, None if from_analyses else [(bpc, "BPC-157", "10")], form=_form(db))
    item = _item(db, ws, parent, prep_form=_FORMS[kind], hplc_prep=_INPUTS[kind],
                 instrument_id=inst.id if inst else None, **columns)
    if from_analyses:
        _analysis(db, bpc, item=item)
    db.commit()
    return ws, item, bpc, inst


def _blend(db, vials=(1, 2), mg=("5", "5"), inputs=None, *, sample_id="P-0700"):
    """A finished two-component blend row, BPC-157 + TB-500, with the catalog vials given."""
    bpc, tb = _peptide(db, "BPC-157"), _peptide(db, "TB-500", "Thymosin Beta-4")
    blend = _peptide(db, "BPC-157 + TB-500", blend_of=((bpc, vials[0]), (tb, vials[1])))
    ws, inst = _ws(db), _instrument(db)
    parent = _sample(db, sample_id, [(bpc, "BPC-157", mg[0]), (tb, "TB-500", mg[1])], form=_form(db))
    v1 = {"vial_mg": 2500.0, "vial_diluent_mg": 3800.0, "vial_all_mg": 3996.0}
    v2 = {"vial_mg": 2600.0, "vial_diluent_mg": 3900.0, "vial_all_mg": 4100.0}
    item = _item(db, ws, parent, prep_form="powder", instrument_id=inst.id,
                 hplc_prep=inputs or {**_STOCK, "vials": {"1": v1, "2": v2}})
    db.commit()
    return ws, item, (bpc, tb, blend), inst


def _url(ws, item):
    return f"/worksheets/{ws.id}/items/{item.id}/hplc/promote"


def _stored(item):
    preps = mk1_db.list_sample_preps_for_worksheet_items([item.id])
    assert len(preps) == 1, preps
    return preps[0]


def _computed(db, row):
    facts = {k: row[k] for k in ("declared_mg", "form", "peptide_id", "components")}
    return compute_row(facts, row["hplc_prep"], load_rules(db), row["params"])


# --- promote_reasons, pure ----------------------------------------------------------------


def _facts(**over):
    """Row facts as sheet_rows serves them: a solo BPC-157 powder row with an instrument."""
    row = {"item_id": 1, "sample_id": "P-0600-S01", "peptide_id": 10, "peptide_name": "BPC-157",
           "is_blend": False, "components_source": "analytes", "declared_mg": 10.0,
           "components": [{"peptide_id": 10, "name": "BPC-157", "abbreviation": "BPC-157",
                           "declared_mg": 10.0, "vial": 1}],
           "form": "powder", "rider_only": False, "instrument_id": 2, "instrument_name": "HPLC 1290a",
           "params": PARAMS, "prep_form": None, "hplc_prep": _INPUTS["powder"], "problems": []}
    row.update(over)
    return row


def _reasons(row, cap=4):
    computed = None
    if row["form"] and row["components"]:
        facts = {k: row[k] for k in ("declared_mg", "form", "peptide_id", "components")}
        computed = compute_row(facts, row["hplc_prep"], [], row["params"])
    return promote_reasons(row, computed, cap)


def test_reasons_is_empty_for_a_finished_powder_row():
    assert _reasons(_facts()) == []


@pytest.mark.parametrize("kind", list(_INPUTS))
def test_reasons_is_empty_for_every_finished_kind(kind):
    assert _reasons(_facts(form=_FORMS[kind], hplc_prep=_INPUTS[kind])) == []


def test_reasons_lists_every_gap_at_once():
    row = _facts(instrument_id=None, declared_mg=None, components=[
        {"peptide_id": 10, "name": "BPC-157", "abbreviation": "BPC-157", "declared_mg": None, "vial": 1}],
        hplc_prep={"stock_vial_mg": 5000.0, "vials": {"1": {"vial_mg": 2500.0, "vial_diluent_mg": 2400.0,
                                                             "vial_all_mg": 2600.0}}})
    assert _reasons(row) == [
        promote_mod.REASON_NO_INSTRUMENT,
        "type the declared weight: the stock concentration is worked out from it",
        "weigh the stock vial: Step 2 needs both of its weighings",
        "Vial 1, Step 3: the vial + diluent weight is less than the empty vial; check the weights",
    ]


def test_reasons_name_every_missing_weighing_of_a_two_step_vial():
    inputs = {**_STOCK, "declared_mg": 600.0, "vials": {"1": {"vial_mg": 2500.0}}}
    assert _reasons(_facts(hplc_prep=inputs)) == [
        "Vial 1, Step 3a: weigh the empty intermediate vial, the intermediate vial + diluent and "
        "the intermediate vial with diluent + stock",
        "Vial 1, Step 3: weigh the vial + diluent and the vial with diluent + stock",
    ]


def test_a_flagged_intermediate_weighing_is_a_reason():
    inputs = {**_STOCK, "declared_mg": 600.0, "vials": {"1": {
        **_INPUTS["two_step"]["vials"]["1"], "int_vial_all_mg": 3858.0}}}
    assert _reasons(_facts(hplc_prep=inputs)) == [
        "Vial 1, Step 3a: the last weight (vial, diluent + stock) is not more than the vial + diluent "
        "weight, so no stock went in; check the weights"]


def test_backwards_stock_weighings_are_a_reason():
    inputs = {**_INPUTS["powder"], "stock_vial_diluent_mg": 4000.0}
    assert _reasons(_facts(hplc_prep=inputs)) == [
        "Step 2: the vial and septum + diluent is not more than the empty vial; check the two weights"]


def test_capsule_liquid_and_rider_reasons():
    no_count = {k: v for k, v in _INPUTS["capsule"].items() if k != "capsules"}
    assert _reasons(_facts(form="capsule", hplc_prep=no_count)) == [promote_mod.REASON_CAPSULE_COUNT]
    too_many = {**_INPUTS["capsule"], "capsules": 1001}
    assert _reasons(_facts(form="capsule", hplc_prep=too_many)) == [
        "a stock of 1001 capsules is more than Process HPLC takes (1000); check the count"]
    no_volume = {"vials": _INPUTS["liquid"]["vials"]}
    assert _reasons(_facts(form="liquid", hplc_prep=no_volume)) == [promote_mod.REASON_LIQUID_VOLUME]
    # a capsule's blank "+ diluent" is fine; a powder's is not
    assert _reasons(_facts(form="capsule", hplc_prep=_INPUTS["capsule"])) == []
    assert _reasons(_facts(hplc_prep={**_STOCK, "vials": {"1": {"vial_mg": 2500.0, "vial_all_mg": 3995.0}}})) == [
        "Vial 1, Step 3: weigh the vial + diluent"]
    assert _reasons(_facts(rider_only=True, form=None)) == [promote_mod.REASON_RIDER]


def test_a_row_without_a_form_or_a_catalog_peptide_says_so_and_is_never_computed():
    assert _reasons(_facts(form=None, problems=["no HPLC prep for this sample form"])) == [
        "this form has no HPLC prep in Mk1"]
    row = _facts(peptide_id=None, components=[], problems=["the sample has no catalog peptide"])
    assert promote_reasons(row, None, 4) == ["the sample has no catalog peptide"]


def test_the_floor_is_never_a_reason():
    # BPC-157 9 mg leads vial 1 at 200 ug/mL, so TB-500 1 mg lands at 22 ug/mL, under the 60 floor
    row = _facts(peptide_id=3, is_blend=True, components=[
        {"peptide_id": 10, "name": "BPC-157", "abbreviation": "BPC-157", "declared_mg": 9.0, "vial": 1},
        {"peptide_id": 11, "name": "TB-500", "abbreviation": "TB-500", "declared_mg": 1.0, "vial": 1}])
    facts = {k: row[k] for k in ("declared_mg", "form", "peptide_id", "components")}
    computed = compute_row(facts, row["hplc_prep"], [], PARAMS)
    assert [w["code"] for w in computed["warnings"]].count("below_floor") == 1
    assert promote_reasons(row, computed, 4) == []


def test_no_instrument_is_a_reason():
    assert _reasons(_facts(instrument_id=None, instrument_name=None)) == [
        "pick the instrument first: a curve is checked against the run's instrument, and a prep "
        "without one cannot be checked"]


def _five_blend(n=5):
    return _facts(peptide_id=3, is_blend=True, components=[
        {"peptide_id": 10 + i, "name": f"P{i}", "abbreviation": f"P{i}", "declared_mg": 2.0, "vial": 1}
        for i in range(n)])


def test_a_blend_over_the_cap_is_a_reason_and_names_the_cap():
    assert _reasons(_five_blend(), cap=4) == [
        "this blend has 5 components and the cap is 4; a partial blend is never filed"]
    assert _reasons(_five_blend(3), cap=2) == [
        "this blend has 3 components and the cap is 2; a partial blend is never filed"]
    assert _reasons(_five_blend(4), cap=4) == []


def test_a_blend_component_with_no_weight_is_a_reason():
    row = _facts(peptide_id=3, is_blend=True, components=[
        {"peptide_id": 10, "name": "BPC-157", "abbreviation": "BPC-157", "declared_mg": None, "vial": 1},
        {"peptide_id": 11, "name": "TB-500", "abbreviation": "TB-500", "declared_mg": 5.0, "vial": 1}])
    assert _reasons(row) == ["type the weight of BPC-157 in the blend split (Step 2b)"]


def test_a_single_peptide_that_is_a_catalog_blend_is_a_reason():
    assert _reasons(_facts(peptide_is_blend=True)) == [promote_mod.REASON_SOLO_BLEND]


@pytest.mark.parametrize("key, value", [("bac_stock_ug_ml", 8000.0), ("benzyl_alcohol_density_mg_ml", 1040.0)])
def test_a_bac_row_whose_method_figures_are_not_the_engines_is_a_reason(key, value):
    # Process HPLC works a bac stock volume out with its own 9000 ug/mL and 1034.72 mg/mL
    # (calculate_dilution_factor passes neither on), so a method that sets others would file
    # a prep whose sheet and certificate disagree
    params = {**PARAMS, key: value}
    stock, ba = params["bac_stock_ug_ml"], params["benzyl_alcohol_density_mg_ml"]
    assert _reasons(_facts(form="bac", hplc_prep=_INPUTS["bac"], params=params)) == [
        f"this method's bac water figures ({stock:g} ug/mL stock, benzyl alcohol at {ba:g} mg/mL) are not "
        "the ones Process HPLC uses (9000 ug/mL, 1034.72 mg/mL); have the method checked before a bac "
        "row is promoted"]
    # the same figures on a powder row change nothing the engine reads
    assert _reasons(_facts(params=params)) == []


def test_the_warnings_that_never_stop_a_promote():
    # volume_off (a vial far from its plan) and split_mismatch warn; neither is a reason
    inputs = {**_STOCK, "vials": {"1": {"vial_mg": 2500.0, "vial_diluent_mg": 3000.0, "vial_all_mg": 3200.0}},
              "components": {"10": {"mg": 4.0}, "11": {"mg": 4.0}}}
    row = _facts(peptide_id=3, is_blend=True, hplc_prep=inputs, components=[
        {"peptide_id": 10, "name": "BPC-157", "abbreviation": "BPC-157", "declared_mg": 5.0, "vial": 1},
        {"peptide_id": 11, "name": "TB-500", "abbreviation": "TB-500", "declared_mg": 5.0, "vial": 1}])
    facts = {k: row[k] for k in ("declared_mg", "form", "peptide_id", "components")}
    computed = compute_row(facts, inputs, [], PARAMS)
    assert {"volume_off", "split_mismatch"} <= {w["code"] for w in computed["warnings"]}
    assert promote_reasons(row, computed, 4) == []
    # capsule_over_neat: a capsule stock above the neat ceiling warns and promotes
    over = {**_INPUTS["capsule"], "stock_vial_diluent_mg": 7991.3}
    row = _facts(form="capsule", hplc_prep=over)
    computed = compute_row({k: row[k] for k in ("declared_mg", "form", "peptide_id", "components")},
                           over, [], PARAMS)
    assert "capsule_over_neat" in {w["code"] for w in computed["warnings"]}
    assert promote_reasons(row, computed, 4) == []


# --- the route ----------------------------------------------------------------------------


def test_promote_writes_one_prep_with_the_typed_weighings(client, db):
    ws, item, bpc, inst = _solo(db, from_analyses=True)
    r = client.post(_url(ws, item))
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"prep", "already", "row"} and body["already"] is False
    assert set(body["prep"]) == {"id", "sample_id", "status"}
    assert body["prep"]["status"] == "awaiting_hplc"
    assert body["row"]["promoted"] is True and body["row"]["prep"] == body["prep"]
    assert body["row"]["components_source"] == "analyses"
    prep = _stored(item)
    vial = db.query(LimsSubSample).filter_by(sample_id=item.sample_id).one()
    computed = _computed(db, body["row"])
    v = computed["vials"][0]
    assert prep["id"] == body["prep"]["id"] and prep["sample_id"] == body["prep"]["sample_id"]
    expected = {
        "worksheet_item_id": item.id, "lims_sub_sample_pk": vial.id, "senaite_sample_id": item.sample_id,
        "peptide_id": bpc.id, "peptide_name": "BPC-157", "peptide_abbreviation": "BPC-157",
        "instrument_id": inst.id, "instrument_name": "HPLC 1290a", "status": "awaiting_hplc",
        "created_by_user_id": 1, "created_by_email": "qa@accumark.test",
        "updated_by_user_id": 1, "updated_by_email": "qa@accumark.test",
        "prep_form": "powder", "declared_weight_mg": 10.0, "declared_volume_ml": None,
        "capsules_used": None, "diluent": "Water", "wizard_session_id": None,
        "target_conc_ug_ml": 200.0, "target_total_vol_ul": 1500.0,
        "stock_vial_empty_mg": 5000.0, "stock_vial_loaded_mg": 7991.3,
        "dil_vial_empty_mg": 2500.0, "dil_vial_with_diluent_mg": 3906.0, "dil_vial_final_mg": 3996.0,
        "int_vial_empty_mg": None, "int_vial_with_diluent_mg": None, "int_vial_final_mg": None,
        "stock_conc_ug_ml": v["stock_conc_ug_ml"], "required_stock_vol_ul": v["plan"]["stock_vol_ul"],
        "required_diluent_vol_ul": v["plan"]["diluent_vol_ul"],
        "actual_conc_ug_ml": v["actual"]["actual_conc_ug_ml"],
        "actual_diluent_vol_ul": v["actual"]["actual_diluent_ul"],
        "actual_stock_vol_ul": v["actual"]["actual_stock_ul"],
        "actual_total_vol_ul": v["actual"]["actual_total_ul"],
        "is_blend": False, "components_json": None, "vial_data": None, "is_standard": False,
        "notes": "the diluent density could not be checked for BPC-157: it has no curve on HPLC 1290a",
    }
    assert {k: prep[k] for k in expected} == expected
    assert all(prep[k] is not None for k in ("stock_conc_ug_ml", "actual_conc_ug_ml", "actual_total_vol_ul"))
    # the row keeps the rule it was promoted under
    db.expire_all()
    rule = db.get(WorksheetItem, item.id).prep_rule
    assert set(rule) == {"event", "locked_at", "locked_by", "user_id", "diluent", "floor_ug_ml", "vials"}
    assert (rule["event"], rule["locked_by"], rule["user_id"]) == ("promote", "promote", 1)
    assert (rule["diluent"], rule["floor_ug_ml"]) == ("Water", 60)
    assert rule["vials"] == [{"vial": 1, "lead": bpc.id, "target": 200}]


def test_promote_stamps_the_vials_analyses_with_the_instrument_and_method(client, db):
    ws, item, bpc, inst = _solo(db)
    method = _method(db, bpc, inst, {"hplc": {}})
    vial = db.query(LimsSubSample).filter_by(sample_id=item.sample_id).one()
    svc = AnalysisService(title="BPC-157 purity", keyword="PUR_BPC157")
    db.add(svc)
    db.flush()
    row = LimsAnalysis(lims_sub_sample_pk=vial.id, analysis_service_id=svc.id, keyword="PUR_BPC157",
                       title="BPC-157 purity", review_state="unassigned")
    db.add(row)
    db.commit()
    assert client.post(_url(ws, item)).status_code == 200
    db.expire_all()
    stamped = db.get(LimsAnalysis, row.id)
    assert (stamped.instrument_id, stamped.method_id) == (inst.id, method.id)


def test_a_failed_analysis_stamp_never_loses_the_prep(client, db, monkeypatch):
    import lims_analyses.prep_bridge as bridge

    def boom(*_a, **_k):
        raise RuntimeError("stamp failed")

    monkeypatch.setattr(bridge, "stamp_prep_assignment", boom)
    ws, item, _bpc, _inst = _solo(db)
    r = client.post(_url(ws, item))
    assert r.status_code == 200, r.text
    _stored(item)
    db.expire_all()
    assert db.get(WorksheetItem, item.id).prep_rule["event"] == "promote"


def test_promote_twice_returns_the_same_prep_and_inserts_nothing(client, db, monkeypatch):
    ws, item, _bpc, _inst = _solo(db)
    first = client.post(_url(ws, item)).json()
    inserts = []
    real = mk1_db.create_sample_prep
    monkeypatch.setattr(mk1_db, "create_sample_prep", lambda data: (inserts.append(data), real(data))[1])
    r = client.post(_url(ws, item))
    assert r.status_code == 200, r.text
    assert r.json()["already"] is True and r.json()["prep"] == first["prep"]
    assert inserts == []
    _stored(item)


def test_a_promote_that_finds_a_prep_from_a_half_commit_heals(client, db, promote):
    ws, item, _bpc, _inst = _solo(db)
    made = promote(item)  # the prep committed, the item's stamp never did
    r = client.post(_url(ws, item))
    assert r.status_code == 200, r.text
    assert r.json()["already"] is True and r.json()["prep"]["id"] == made["id"]
    db.expire_all()
    rule = db.get(WorksheetItem, item.id).prep_rule
    assert rule["event"] == "promote" and rule["healed"] is True
    # built from the stored prep, which holds no diluent or target here
    assert (rule["diluent"], rule["vials"]) == (None, [{"vial": 1, "lead": made["peptide_id"], "target": None}])
    # a promote stamp already there is left as it is
    stamped_at = rule["locked_at"]
    assert client.post(_url(ws, item)).json()["already"] is True
    db.expire_all()
    assert db.get(WorksheetItem, item.id).prep_rule["locked_at"] == stamped_at


def test_a_promote_that_loses_the_race_answers_already(client, db, promote, monkeypatch):
    # another request committed its prep after this one looked: the unique index refuses the
    # insert, and this request reads the winner instead of answering 500
    ws, item, _bpc, _inst = _solo(db)
    winner = promote(item)
    real = worksheets_hplc._preps_by_item
    calls = []

    def first_lookup_misses(ids):
        calls.append(ids)
        return {} if len(calls) == 1 else real(ids)

    monkeypatch.setattr(worksheets_hplc, "_preps_by_item", first_lookup_misses)
    r = client.post(_url(ws, item))
    assert r.status_code == 200, r.text
    assert r.json()["already"] is True and r.json()["prep"]["id"] == winner["id"]
    _stored(item)


def test_a_two_step_row_writes_its_intermediate_weighings(client, db):
    ws, item, _bpc, _inst = _solo(db, "two_step")
    r = client.post(_url(ws, item))
    assert r.status_code == 200, r.text
    prep = _stored(item)
    assert (prep["int_vial_empty_mg"], prep["int_vial_with_diluent_mg"], prep["int_vial_final_mg"]) == (
        2400.0, 3858.0, 3895.6)
    assert prep["declared_weight_mg"] == 600.0


def test_a_one_step_row_never_writes_intermediate_weighings_it_does_not_use(client, db):
    # weighings typed while the row was two-step, then the tech said one step
    ws, item, _bpc, _inst = _solo(db, "two_step")
    item.hplc_prep = {**_INPUTS["two_step"], "two_step": False}
    db.commit()
    assert client.post(_url(ws, item)).status_code == 200
    prep = _stored(item)
    assert (prep["int_vial_empty_mg"], prep["int_vial_with_diluent_mg"], prep["int_vial_final_mg"]) == (
        None, None, None)


def test_a_blend_writes_components_json_and_one_vial_data_entry_per_vial(client, db):
    ws, item, (bpc, tb, blend), inst = _blend(db)
    r = client.post(_url(ws, item))
    assert r.status_code == 200, r.text
    prep = _stored(item)
    assert (prep["is_blend"], prep["peptide_id"], prep["peptide_name"]) == (True, blend.id, "BPC-157 + TB-500")
    assert prep["components_json"] == [
        {"id": bpc.id, "name": "BPC-157", "abbreviation": "BPC-157", "vial_number": 1, "hplc_aliases": None},
        {"id": tb.id, "name": "Thymosin Beta-4", "abbreviation": "TB-500", "vial_number": 2, "hplc_aliases": None}]
    computed = _computed(db, r.json()["row"])
    assert [e["vial_number"] for e in prep["vial_data"]] == [1, 2]
    for entry, v in zip(prep["vial_data"], computed["vials"]):
        assert set(entry) == promote_mod.VIAL_DATA_KEYS
        weighed = item.hplc_prep["vials"][str(v["vial"])]
        assert entry["component_ids"] == v["component_ids"]
        assert (entry["stock_vial_empty_mg"], entry["stock_vial_loaded_mg"]) == (5000.0, 7991.3)
        assert (entry["dil_vial_empty_mg"], entry["dil_vial_with_diluent_mg"], entry["dil_vial_final_mg"]) == (
            weighed["vial_mg"], weighed["vial_diluent_mg"], weighed["vial_all_mg"])
        assert entry["target_conc_ug_ml"] == v["target"]["value"]
        assert entry["actual_conc_ug_ml"] == v["actual"]["actual_conc_ug_ml"]
        assert [a["component_id"] for a in entry["analyte_data"]] == v["component_ids"]
    assert prep["vial_data"][1]["component_abbreviations"] == ["TB-500"]
    # vial 1 in the flat columns
    assert prep["dil_vial_empty_mg"] == 2500.0 and prep["dil_vial_final_mg"] == 3996.0


def test_a_component_moved_to_vial_2_is_vial_2_in_components_json(client, db):
    inputs = {**_STOCK, "components": {}, "vials": {
        "1": {"vial_mg": 2500.0, "vial_diluent_mg": 3800.0, "vial_all_mg": 3996.0},
        "2": {"vial_mg": 2600.0, "vial_diluent_mg": 3900.0, "vial_all_mg": 4100.0}}}
    ws, item, (bpc, tb, _blend_pep), _inst = _blend(db, vials=(1, 1), inputs=inputs)
    item.hplc_prep = {**inputs, "components": {str(tb.id): {"vial": 2}}}
    db.commit()
    r = client.post(_url(ws, item))
    assert r.status_code == 200, r.text
    prep = _stored(item)
    assert {c["id"]: c["vial_number"] for c in prep["components_json"]} == {bpc.id: 1, tb.id: 2}
    assert [(e["vial_number"], e["component_ids"]) for e in prep["vial_data"]] == [(1, [bpc.id]), (2, [tb.id])]


def test_a_blend_whose_floor_is_missed_promotes_and_says_so_in_the_notes(client, db):
    ws, item, _peps, _inst = _blend(db, vials=(1, 1), mg=("9", "1"))
    r = client.post(_url(ws, item))
    assert r.status_code == 200, r.text
    notes = _stored(item)["notes"]
    assert "under the 60 ug/mL floor" in notes


def test_a_capsule_prep_is_neat_and_carries_its_count(client, db):
    ws, item, _bpc, _inst = _solo(db, "capsule")
    r = client.post(_url(ws, item))
    assert r.status_code == 200, r.text
    prep = _stored(item)
    assert (prep["prep_form"], prep["capsules_used"], prep["declared_weight_mg"]) == ("capsule", 4, 10.0)
    # the blank "+ diluent" is stored as the empty vial: the engine reads that as neat
    assert prep["dil_vial_with_diluent_mg"] == prep["dil_vial_empty_mg"] == 2500.0
    assert _through_the_engine(prep)["dilution_factor_total"] == 1.0


def test_a_liquid_prep_carries_its_declared_volume(client, db):
    ws, item, _bpc, _inst = _solo(db, "liquid")
    assert client.post(_url(ws, item)).status_code == 200
    prep = _stored(item)
    assert (prep["prep_form"], prep["declared_volume_ml"], prep["stock_vial_empty_mg"]) == ("liquid", 3.0, None)


def test_a_bac_prep_stores_the_worked_out_weight_and_the_weighings_in_the_engines_order(client, db):
    ws, item, _bpc, _inst = _solo(db, "bac")
    r = client.post(_url(ws, item))
    assert r.status_code == 200, r.text
    prep = _stored(item)
    computed = _computed(db, r.json()["row"])
    assert prep["declared_weight_mg"] == pytest.approx(computed["declared_total_mg"], abs=1e-9)
    # stock_volume_ml reads with_diluent - empty: the full vial is the heavier
    assert (prep["stock_vial_empty_mg"], prep["stock_vial_loaded_mg"]) == (5012.31, 8003.6)


def test_after_promote_the_prep_fields_answer_409(client, db):
    ws, item, _bpc, inst = _solo(db)
    other = _instrument(db, "HPLC 1290b")
    db.commit()
    assert client.post(_url(ws, item)).status_code == 200
    for body in ({"hplc_prep": {"declared_mg": 11.0}}, {"prep_form": "liquid"},
                 {"hplc_prep": {"vials": {"1": {"vial_mg": 2501.0}}}}):
        r = client.patch(f"/worksheets/{ws.id}/items/{item.id}/hplc", json=body)
        assert r.status_code == 409 and r.json()["detail"] == worksheets_hplc.PREP_FINAL, body
    r = client.patch(f"/worksheets/{ws.id}/items/{item.id}", json={"instrument_id": other.id})
    assert r.status_code == 409 and r.json()["detail"] == worksheets_hplc.PREP_FINAL
    db.expire_all()
    assert db.get(WorksheetItem, item.id).instrument_id == inst.id


def test_a_row_that_cannot_be_promoted_answers_409_with_every_reason(client, db):
    ws, item, _bpc, _inst = _solo(db, instrument=False)
    item.hplc_prep = {"vials": {"1": {"vial_mg": 2500.0}}}
    db.commit()
    r = client.post(_url(ws, item))
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert set(detail) == {"message", "reasons"}
    assert detail["message"] == promote_mod.REFUSED_MESSAGE
    assert detail["reasons"] == [
        promote_mod.REASON_NO_INSTRUMENT,
        "weigh the stock vial: Step 2 needs both of its weighings",
        "Vial 1, Step 3: weigh the vial + diluent and the vial with diluent + stock"]
    assert mk1_db.list_sample_preps_for_worksheet_items([item.id]) == []
    db.expire_all()
    assert db.get(WorksheetItem, item.id).prep_rule is None


def test_a_row_with_no_catalog_peptide_is_refused_without_computing(client, db, monkeypatch):
    ws, item, _bpc, _inst = _solo(db, from_analyses=True)
    db.query(LimsAnalysis).delete()
    db.commit()
    import hplc_prep

    def never(*_a, **_k):
        raise AssertionError("compute_row ran on a row with no components")

    monkeypatch.setattr(hplc_prep, "compute_row", never)
    monkeypatch.setattr(promote_mod, "compute_row", never)
    r = client.post(_url(ws, item))
    assert r.status_code == 409
    assert r.json()["detail"]["reasons"] == ["the sample has no catalog peptide"]


def test_a_completed_worksheet_refuses_with_the_same_shape(client, db):
    ws, item, _bpc, _inst = _solo(db)
    ws.status = "completed"
    db.commit()
    r = client.post(_url(ws, item))
    assert r.status_code == 409
    assert r.json()["detail"] == {"message": promote_mod.REFUSED_MESSAGE,
                                  "reasons": [promote_mod.REASON_COMPLETED]}


def test_a_rider_and_a_form_with_no_hplc_prep_are_refused(client, db):
    bpc = _peptide(db, "BPC-157")
    ws, inst = _ws(db), _instrument(db)
    pen = _sample(db, "P-0610", [(bpc, "BPC-157", "10")], form=_form(db, "Pen", None))
    rider_parent = _sample(db, "P-0611", [(bpc, "BPC-157", "10")], form=_form(db, "Lyo", "powder"))
    pen_item = _item(db, ws, pen, instrument_id=inst.id)
    rider = _item(db, ws, rider_parent, role="fentanyl", instrument_id=inst.id)
    db.commit()
    assert client.post(_url(ws, pen_item)).json()["detail"]["reasons"] == ["this form has no HPLC prep in Mk1"]
    assert client.post(_url(ws, rider)).json()["detail"]["reasons"] == [promote_mod.REASON_RIDER]


def test_the_blend_cap_setting_is_read(client, db):
    ws, item, _peps, _inst = _blend(db)
    db.add(Settings(key="hplc_blend_component_cap", value="1"))
    db.commit()
    r = client.post(_url(ws, item))
    assert r.status_code == 409
    assert r.json()["detail"]["reasons"] == [
        "this blend has 2 components and the cap is 1; a partial blend is never filed"]


def test_a_solo_analyte_that_names_a_catalog_blend_is_refused(client, db):
    bpc, tb = _peptide(db, "BPC-157"), _peptide(db, "TB-500")
    blend = _peptide(db, "BPC/TB", blend_of=((bpc, 1), (tb, 1)))
    ws, inst = _ws(db), _instrument(db)
    parent = _sample(db, "P-0620", [(blend, "BPC/TB", "10")], form=_form(db))
    item = _item(db, ws, parent, prep_form="powder", hplc_prep=_INPUTS["powder"], instrument_id=inst.id)
    db.commit()
    r = client.post(_url(ws, item))
    assert r.status_code == 409
    assert r.json()["detail"]["reasons"] == [promote_mod.REASON_SOLO_BLEND]


def test_404_for_an_item_not_on_the_worksheet_a_staging_worksheet_or_an_endo_row(client, db):
    ws, item, _bpc, _inst = _solo(db)
    other = _ws(db)
    staging = _ws(db, status="staging")
    endo = _item(db, ws, db.query(LimsSample).filter_by(sample_id="P-0600").one(), 2, role="endo85")
    db.commit()
    assert client.post(f"/worksheets/{other.id}/items/{item.id}/hplc/promote").status_code == 404
    assert client.post(f"/worksheets/{staging.id}/items/{item.id}/hplc/promote").status_code == 404
    assert client.post("/worksheets/987654/items/1/hplc/promote").status_code == 404
    assert client.post(_url(ws, endo)).status_code == 404


def test_promote_takes_the_locks_in_order_and_holds_them_across_the_insert(client, db, monkeypatch):
    ws, item, _bpc, _inst = _solo(db)
    events = []
    real_ws, real_items = main._worksheet_for_update, endo_prep_rules.lock_items_for_update
    real_insert, real_commit = mk1_db.create_sample_prep, db.commit
    monkeypatch.setattr(main, "_worksheet_for_update",
                        lambda _db, wid: (events.append("worksheet"), real_ws(_db, wid))[1])
    monkeypatch.setattr(endo_prep_rules, "lock_items_for_update",
                        lambda _db, _ws, ids: (events.append(("items", sorted(ids))), real_items(_db, _ws, ids))[1])
    monkeypatch.setattr(mk1_db, "create_sample_prep", lambda data: (events.append("insert"), real_insert(data))[1])
    monkeypatch.setattr(db, "commit", lambda: (events.append("commit"), real_commit())[1])
    assert client.post(_url(ws, item)).status_code == 200
    assert events[:4] == ["worksheet", ("items", [item.id]), "insert", "commit"]


def test_with_mk1_db_down_nothing_is_written_on_either_side(client, db, monkeypatch):
    ws, item, _bpc, _inst = _solo(db)

    def down(_data):
        raise psycopg2.OperationalError("could not connect to server")

    monkeypatch.setattr(mk1_db, "create_sample_prep", down)
    r = client.post(_url(ws, item))
    assert r.status_code == 500
    assert "could not connect to server" in r.json()["detail"]
    db.expire_all()
    assert db.get(WorksheetItem, item.id).prep_rule is None
    assert mk1_db.list_sample_preps_for_worksheet_items([item.id]) == []
    # and down before anything is read: the same 500
    monkeypatch.setattr(worksheets_hplc, "_preps_by_item",
                        lambda _ids: (_ for _ in ()).throw(psycopg2.OperationalError("no route to host")))
    r = client.post(_url(ws, item))
    assert r.status_code == 500 and "no route to host" in r.json()["detail"]


# --- through the engine -------------------------------------------------------------------


def _engine_inputs(prep, vial_number=None):
    """src/lib/hplc-analyze-fields.ts prepAnalyzeFields for a prep with a form: a vial's
    vial_data entry when there is one, else the row; a blank weighing as None; the
    intermediate only when one of its weighings is stored; the volume only for a liquid."""
    vial = next((v for v in prep["vial_data"] or [] if v["vial_number"] == vial_number), None) \
        if vial_number is not None else None
    src = vial or prep
    weights = WeightInputs(
        stock_vial_empty=src.get("stock_vial_empty_mg"), stock_vial_with_diluent=src.get("stock_vial_loaded_mg"),
        dil_vial_empty=src.get("dil_vial_empty_mg"), dil_vial_with_diluent=src.get("dil_vial_with_diluent_mg"),
        dil_vial_with_diluent_and_sample=src.get("dil_vial_final_mg"))
    ints = [src.get(k) for k in ("int_vial_empty_mg", "int_vial_with_diluent_mg", "int_vial_final_mg")]
    inter = IntermediateWeights(*ints) if any(v is not None for v in ints) else None
    volume = prep["declared_volume_ml"] if prep["prep_form"] == "liquid" else None
    return weights, inter, volume


def _through_the_engine(prep, vial_number=None):
    weights, inter, volume = _engine_inputs(prep, vial_number)
    out = calculate_dilution_factor(weights, DENSITY, inter, form=prep["prep_form"], declared_volume_ml=volume)
    assert out["problem"] is None, out
    return out


def _sheet_total(v):
    """The total factor as the engine forms it from the sheet's own steps: each step rounded
    to 6 places, then the product rounded (calculate_dilution_factor's documented order)."""
    final = round(v["actual"]["dilution_factor"], 6)
    if not v["two_step"]:
        return final
    return round(round(v["intermediate"]["actual"]["dilution_factor"], 6) * final, 6)


@pytest.mark.parametrize("kind", list(_INPUTS))
def test_a_promoted_prep_goes_through_the_engine_and_matches_the_sheet(client, db, kind):
    ws, item, _bpc, _inst = _solo(db, kind)
    r = client.post(_url(ws, item))
    assert r.status_code == 200, r.text
    computed = _computed(db, r.json()["row"])
    v = computed["vials"][0]
    out = _through_the_engine(_stored(item))
    assert out["stock_volume_ml"] == pytest.approx(computed["stock"]["total_diluent_ml"], abs=1e-6)
    assert out["dilution_factor"] == pytest.approx(v["actual"]["dilution_factor"], abs=1e-6)
    if v["two_step"]:
        # The engine rounds each step to 6 places and then multiplies (its documented order),
        # so a two-step total can sit 1e-5 from the sheet's unrounded product (988.600397
        # against 988.6003746 here, 2e-8 relative). Each step is held to 1e-6, and the
        # total to the engine's own rounding of the sheet's steps, exactly.
        step = out["intermediate"]["dilution_factor"]
        assert step == pytest.approx(v["intermediate"]["actual"]["dilution_factor"], abs=1e-6)
        assert out["dilution_factor_total"] == pytest.approx(v["dilution_factor_total"], rel=1e-7)
    else:
        assert out["dilution_factor_total"] == pytest.approx(v["dilution_factor_total"], abs=1e-6)
    assert out["dilution_factor_total"] == pytest.approx(_sheet_total(v), abs=1e-12)


def test_every_vial_of_a_promoted_blend_goes_through_the_engine_and_matches_the_sheet(client, db):
    ws, item, (bpc, tb, _blend_pep), _inst = _blend(db)
    r = client.post(_url(ws, item))
    assert r.status_code == 200, r.text
    computed = _computed(db, r.json()["row"])
    prep = _stored(item)
    by_component = {c["id"]: c["vial_number"] for c in prep["components_json"]}
    for v in computed["vials"]:
        for pid in v["component_ids"]:
            # the flyout routes each component by its components_json vial (SamplePrepHplcFlyout)
            out = _through_the_engine(prep, by_component[pid])
            assert out["stock_volume_ml"] == pytest.approx(computed["stock"]["total_diluent_ml"], abs=1e-6)
            assert out["dilution_factor_total"] == pytest.approx(v["dilution_factor_total"], abs=1e-6)


# --- fix round 1 ---------------------------------------------------------------------------


def test_a_declared_weight_of_zero_is_a_reason():
    assert _reasons(_facts(hplc_prep={**_INPUTS["powder"], "declared_mg": 0})) == [promote_mod.REASON_DECLARED_ZERO]


def test_the_backstop_refuses_a_vial_with_no_factor():
    row = _facts()
    computed = compute_row({k: row[k] for k in ("declared_mg", "form", "peptide_id", "components")},
                           row["hplc_prep"], [], PARAMS)
    computed["vials"][0]["dilution_factor_total"] = None  # what no listed reason catches
    assert promote_reasons(row, computed, 4) == ["Vial 1 cannot be worked out from these numbers; check the row"]


def test_a_blend_with_its_split_typed_and_no_total_says_so_in_blend_words():
    row = _facts(peptide_id=3, is_blend=True, declared_mg=None, hplc_prep={
        **_INPUTS["powder"], "components": {"10": {"mg": 5.0}, "11": {"mg": 5.0}}}, components=[
        {"peptide_id": 10, "name": "BPC-157", "abbreviation": "BPC-157", "declared_mg": None, "vial": 1},
        {"peptide_id": 11, "name": "TB-500", "abbreviation": "TB-500", "declared_mg": None, "vial": 1}])
    assert _reasons(row) == [promote_mod.REASON_DECLARED_BLEND]


def test_a_blend_missing_from_the_catalog_is_refused(client, db):
    bpc, tb = _peptide(db, "BPC-157"), _peptide(db, "TB-500")
    ws, inst = _ws(db), _instrument(db)
    parent = _sample(db, "P-0630", [(bpc, "BPC-157", "5"), (tb, "TB-500", "5")], form=_form(db))
    item = _item(db, ws, parent, prep_form="powder", hplc_prep=_INPUTS["powder"], instrument_id=inst.id)
    db.commit()
    r = client.post(_url(ws, item))
    assert r.status_code == 409 and r.json()["detail"]["reasons"] == ["this blend is not in the catalog"]


def test_a_promoted_prep_is_a_production_prep_the_sample_preps_page_lists(client, db):
    ws, item, _bpc, _inst = _solo(db)
    prep_id = client.post(_url(ws, item)).json()["prep"]["id"]
    assert _stored(item)["is_standard"] is False
    r = client.get("/sample-preps", params={"is_standard": "false", "search": item.sample_id})
    assert r.status_code == 200, r.text
    assert prep_id in [p["id"] for p in r.json()]


# The curve density check (ruling on Important 2)


def _curve(db, peptide, instrument, density, *, active=True):
    curve = CalibrationCurve(peptide_id=peptide.id, instrument_id=instrument.id, slope=1.0, intercept=0.0,
                             r_squared=1.0, is_active=active)
    db.add(curve)
    db.flush()
    curve.diluent_density = density  # set after the insert, so a None is stored as NULL, not the default
    db.commit()
    return curve


def _density_sentence(abbr, sheet, curve, *, inactive=False):
    """sheet and curve are the exact texts: shortest round trip, an integer without its .0"""
    q = " (inactive, but with no active curve there it can still be picked)" if inactive else ""
    return (f"The sheet worked this row out with a diluent density of {sheet} mg/mL (from the method). "
            f"Curve {curve.id} for {abbr} on HPLC 1290a{q} uses {_shown(curve.diluent_density)}, and the "
            "certificate is worked out with the curve's. A lab admin has to make them agree before this "
            "row can be promoted.")


def _shown(x):
    return str(int(x)) if float(x).is_integer() else repr(float(x))


def test_a_curve_with_the_sheets_density_promotes(client, db):
    ws, item, bpc, inst = _solo(db)
    _curve(db, bpc, inst, 997.1)
    assert client.post(_url(ws, item)).status_code == 200
    assert _stored(item)["notes"] is None


def test_a_curve_with_another_density_is_refused_and_nothing_is_inserted(client, db):
    ws, item, bpc, inst = _solo(db)
    curve = _curve(db, bpc, inst, 1000.0)
    r = client.post(_url(ws, item))
    assert r.status_code == 409
    assert r.json()["detail"]["reasons"] == [_density_sentence("BPC-157", "997.1", curve)]
    assert "uses 1000," in r.json()["detail"]["reasons"][0]
    assert mk1_db.list_sample_preps_for_worksheet_items([item.id]) == []


def test_two_densities_that_differ_past_six_figures_never_print_alike(client, db):
    ws, item, bpc, inst = _solo(db)
    curve = _curve(db, bpc, inst, 997.1004)
    reason = client.post(_url(ws, item)).json()["detail"]["reasons"][0]
    assert reason == _density_sentence("BPC-157", "997.1", curve)
    assert "of 997.1 mg/mL" in reason and "uses 997.1004," in reason


def test_the_density_reason_comes_with_the_others_at_once(client, db):
    ws, item, bpc, inst = _solo(db)
    curve = _curve(db, bpc, inst, 1000.0)
    item.hplc_prep = {"vials": {"1": dict(_VIAL)}}
    db.commit()
    assert client.post(_url(ws, item)).json()["detail"]["reasons"] == [
        "weigh the stock vial: Step 2 needs both of its weighings", _density_sentence("BPC-157", "997.1", curve)]


def test_the_density_reason_comes_even_when_the_row_cannot_be_computed(client, db):
    ws, item, bpc, inst = _solo(db)
    curve = _curve(db, bpc, inst, 1000.0)
    item.prep_form = None
    db.get(LimsSample, db.get(LimsSubSample, db.query(LimsSubSample.id).filter(
        LimsSubSample.sample_id == item.sample_id).scalar()).parent_sample_pk).sample_form_id = _form(
        db, "Pen", None).id
    db.commit()
    assert client.post(_url(ws, item)).json()["detail"]["reasons"] == [
        promote_mod.REASON_NO_FORM, _density_sentence("BPC-157", "997.1", curve)]


def test_a_blend_whose_one_component_curve_differs_is_refused_and_names_it(client, db):
    ws, item, (bpc, tb, _blend_pep), inst = _blend(db)
    _curve(db, bpc, inst, 997.1)
    curve = _curve(db, tb, inst, 1000.0)
    r = client.post(_url(ws, item))
    assert r.status_code == 409
    assert r.json()["detail"]["reasons"] == [_density_sentence("TB-500", "997.1", curve)]


def test_two_active_curves_are_each_named_by_id(client, db):
    ws, item, bpc, inst = _solo(db)
    _curve(db, bpc, inst, 997.1)
    curve = _curve(db, bpc, inst, 1000.0)
    assert client.post(_url(ws, item)).json()["detail"]["reasons"] == [
        _density_sentence("BPC-157", "997.1", curve)]


def test_no_curve_promotes_and_says_the_density_was_not_checked(client, db):
    ws, item, (bpc, tb, _blend_pep), inst = _blend(db)
    _curve(db, bpc, inst, 997.1)
    assert client.post(_url(ws, item)).status_code == 200
    assert _stored(item)["notes"] == (
        "the diluent density could not be checked for TB-500: it has no curve on HPLC 1290a")


def test_a_curve_with_no_density_is_read_as_the_engine_reads_it(client, db):
    # POST /hplc/analyze passes the curve's NULL straight to the engine, which then has no
    # density and refuses (no_density): never a silent quantity, but never one either
    ws, item, bpc, inst = _solo(db)
    curve = _curve(db, bpc, inst, None)
    assert db.get(CalibrationCurve, curve.id).diluent_density is None
    r = client.post(_url(ws, item))
    assert r.status_code == 409
    assert r.json()["detail"]["reasons"] == [
        f"Curve {curve.id} for BPC-157 on HPLC 1290a has no diluent density, so Process HPLC cannot work "
        "a quantity out with it. A lab admin has to set it (the sheet used 997.1 mg/mL) before this row "
        "can be promoted."]


def test_an_inactive_curve_with_another_density_is_not_a_reason_beside_an_active_one(client, db):
    ws, item, bpc, inst = _solo(db)
    _curve(db, bpc, inst, 997.1)
    _curve(db, bpc, inst, 1000.0, active=False)
    assert client.post(_url(ws, item)).status_code == 200
    assert _stored(item)["notes"] is None


def test_with_no_active_curve_an_inactive_one_that_differs_is_refused_by_id(client, db):
    # the flyout falls back to another curve of the peptide, and analyze takes a hand-picked one
    ws, item, bpc, inst = _solo(db)
    _curve(db, bpc, inst, 997.1, active=False)
    curve = _curve(db, bpc, inst, 1000.0, active=False)
    r = client.post(_url(ws, item))
    assert r.status_code == 409
    assert r.json()["detail"]["reasons"] == [_density_sentence("BPC-157", "997.1", curve, inactive=True)]


def test_with_no_active_curve_an_inactive_one_that_agrees_promotes_with_no_note(client, db):
    ws, item, bpc, inst = _solo(db)
    _curve(db, bpc, inst, 997.1, active=False)
    assert client.post(_url(ws, item)).status_code == 200
    assert _stored(item)["notes"] is None

def test_a_curve_on_another_instrument_is_not_this_rows(client, db):
    ws, item, bpc, _inst = _solo(db)
    _curve(db, bpc, _instrument(db, "HPLC 1290b"), 1000.0)
    assert client.post(_url(ws, item)).status_code == 200


# Important 3, Minor 4 and 5


def test_an_already_answer_leaves_no_transaction_holding_the_locks(client, db):
    ws, item, _bpc, _inst = _solo(db)
    assert client.post(_url(ws, item)).status_code == 200
    r = client.post(_url(ws, item))
    assert r.json()["already"] is True
    assert not db.in_transaction()


def test_a_heal_days_later_stamps_the_rule_the_prep_was_made_under(client, db):
    ws, item, bpc, _inst = _solo(db)
    first = client.post(_url(ws, item)).json()
    db.expire_all()
    stored = db.get(WorksheetItem, item.id)
    stored.prep_rule = None  # the stamp of a half commit never landed
    db.add(HplcPrepRule(peptide_id=bpc.id, target_conc_ug_ml=300, diluent="Water + 0.1% TFA"))
    db.commit()
    r = client.post(_url(ws, item))
    assert r.json()["already"] is True and r.json()["prep"] == first["prep"]
    db.expire_all()
    rule = db.get(WorksheetItem, item.id).prep_rule
    assert rule["healed"] is True and rule["event"] == "promote" and rule["user_id"] == 1
    assert (rule["diluent"], rule["vials"]) == ("Water", [{"vial": 1, "lead": bpc.id, "target": 200.0}])


@pytest.mark.parametrize("vials", [(1, 2), (1, 1)])
def test_a_healed_blend_stamp_names_a_lead_only_for_a_one_component_vial(client, db, vials):
    v1 = {"vial_mg": 2500.0, "vial_diluent_mg": 3800.0, "vial_all_mg": 3996.0}
    inputs = {**_STOCK, "vials": {"1": v1, "2": {"vial_mg": 2600.0, "vial_diluent_mg": 3900.0,
                                                 "vial_all_mg": 4100.0}} if vials == (1, 2) else {"1": v1}}
    ws, item, (bpc, tb, _b), _inst = _blend(db, vials=vials, inputs=inputs)
    assert client.post(_url(ws, item)).status_code == 200
    db.expire_all()
    db.get(WorksheetItem, item.id).prep_rule = None
    db.commit()
    assert client.post(_url(ws, item)).json()["already"] is True
    db.expire_all()
    rule = db.get(WorksheetItem, item.id).prep_rule
    leads = [v["lead"] for v in rule["vials"]]
    assert leads == ([bpc.id, tb.id] if vials == (1, 2) else [None])
    assert rule["floor_ug_ml"] is None and rule["healed"] is True

def test_a_failed_read_after_the_commit_answers_the_prep_without_the_row(client, db, monkeypatch):
    ws, item, _bpc, _inst = _solo(db)
    real, calls = worksheets_hplc.sheet_rows, []

    def second_read_fails(*a, **k):
        calls.append(1)
        if len(calls) == 2:
            raise psycopg2.OperationalError("server closed the connection")
        return real(*a, **k)

    monkeypatch.setattr(worksheets_hplc, "sheet_rows", second_read_fails)
    r = client.post(_url(ws, item))
    assert r.status_code == 200, r.text
    prep = _stored(item)
    assert r.json() == {"prep": {"id": prep["id"], "sample_id": prep["sample_id"], "status": "awaiting_hplc"},
                        "already": False, "row": None}


# Minor 9: the locks block, on Postgres


def test_promote_holds_its_locks_on_postgres_until_the_prep_is_written(monkeypatch):
    if not os.environ.get("MK1_DB_NAME", "").startswith("mk1_test_"):
        pytest.skip("needs the harness's scratch Postgres database")
    from database import DATABASE_URL, Base
    from sqlalchemy import create_engine, exc, text
    from sqlalchemy.orm import sessionmaker

    schema = f"t6_locks_{uuid.uuid4().hex[:8]}"
    admin = create_engine(DATABASE_URL)
    with admin.begin() as conn:
        conn.execute(text(f"CREATE SCHEMA {schema}"))
    engine = create_engine(DATABASE_URL, connect_args={"options": f"-csearch_path={schema}"})
    one, two = sessionmaker(bind=engine)(), sessionmaker(bind=engine)()
    prep_ids, worker = [], None
    try:
        Base.metadata.create_all(engine)
        ws, item, _bpc, _inst = _solo(one)
        ws_id, item_id = ws.id, item.id
        reached, release, out = threading.Event(), threading.Event(), {}
        real = mk1_db.create_sample_prep

        def slow_insert(data):
            reached.set()
            release.wait(10)
            row = real(data)
            prep_ids.append(row["id"])
            return row

        monkeypatch.setattr(mk1_db, "create_sample_prep", slow_insert)

        def run():
            try:
                out["r"] = main.promote_worksheet_item_hplc(
                    worksheet_id=ws_id, item_id=item_id, db=one,
                    current_user=MagicMock(id=1, email="qa@accumark.test"))
            except Exception as e:  # handed to the main thread
                out["e"] = e

        worker = threading.Thread(target=run)
        worker.start()
        assert reached.wait(10), out
        # promote sits in its insert: the worksheet row and the item row are both held
        for attempt in (lambda: main._worksheet_for_update(two, ws_id),
                        lambda: two.execute(text("SELECT id FROM worksheet_items WHERE id = :i FOR UPDATE"),
                                            {"i": item_id}).all()):
            two.execute(text("SET LOCAL lock_timeout = '300ms'"))
            with pytest.raises(exc.OperationalError, match="lock timeout"):
                attempt()
            two.rollback()
        release.set()
        worker.join(15)
        assert "e" not in out and out["r"]["already"] is False, out
        # once promote has committed, the Task 5 PATCH takes the same locks and sees the prep
        two.execute(text("SET LOCAL lock_timeout = '2s'"))
        locked = main._worksheet_for_update(two, ws_id)
        row = two.get(WorksheetItem, item_id, with_for_update=True)
        with pytest.raises(worksheets_hplc.Refused, match="final"):
            worksheets_hplc.apply_patch(two, locked, row, hplc_prep={"declared_mg": 11.0})
        two.rollback()
    finally:
        release.set()
        if worker is not None:
            worker.join(15)  # its prep exists before the cleanup below looks
        one.close()
        two.close()
        for prep in mk1_db.list_sample_preps_for_worksheet_items([item_id]) if "item_id" in dir() else []:
            mk1_db.delete_sample_prep(prep["id"])
        engine.dispose()
        with admin.begin() as conn:
            conn.execute(text(f"DROP SCHEMA {schema} CASCADE"))
        admin.dispose()


# The reason cases the browser's copy is pinned to

_FIXTURES = pathlib.Path(__file__).with_name("fixtures")


def _maker():
    spec = importlib.util.spec_from_file_location(
        "make_hplc_promote_reason_cases", _FIXTURES / "make_hplc_promote_reason_cases.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_reason_cases_file_is_what_promote_reasons_answers_today():
    stored = json.loads((_FIXTURES / "hplc_promote_reason_cases.json").read_text(encoding="utf-8"))
    assert stored == _maker().build()
    assert len({c["name"] for c in stored["cases"]}) == len(stored["cases"])
    assert sum(1 for case in stored["cases"] if not case["reasons"]) >= 7


def test_no_reason_in_the_cases_file_holds_an_em_dash():
    text = (_FIXTURES / "hplc_promote_reason_cases.json").read_text(encoding="utf-8")
    assert "\u2014" not in text and "\\u2014" not in text