"""The HPLC prep worksheet's rows on the server (plan 2026-11-12-hplc-prep-worksheet, Task 5):
the stored inputs (worksheet_items.hplc_prep), their validator and merge, the sheet's row facts
and the two routes, plus the instrument guard on the existing item PATCH.

The validator and merge tests are pure. The rest use an in-memory SQLite session (the
test_endo_v2_worksheets.py pattern) and the real sample_preps table of the Postgres mk1_db is
configured for, which is how a promoted row is told; they skip where there is none. Items get
ids far above any real worksheet_items id, so a dev-copy prep never matches one, and every
prep a test creates is deleted afterwards. Locally:

    HPLC_SCRATCH=t5 bash C:/tmp/hplc-build/local-pytest.sh ws tests/test_worksheets_hplc.py -q
"""
import copy
import itertools
import json
import re
from unittest.mock import MagicMock

import mk1_db
import psycopg2
import pytest
import worksheets_endo
import worksheets_hplc
from auth import get_current_user
from catalog.method_run_params import HPLC_RUN_PARAM_DEFAULTS
from database import Base, get_db
from fastapi.testclient import TestClient
from main import app
from models import (
    HplcMethod,
    Instrument,
    LimsSample,
    LimsSampleForm,
    LimsSubSample,
    Peptide,
    Settings,
    Worksheet,
    WorksheetItem,
    blend_components,
    instrument_methods,
    peptide_methods,
)
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from tests.test_endo_v2_worksheets import _count_sql

# --- the merge, pure -------------------------------------------------------------------


def test_merge_replaces_removes_and_keeps():
    stored = {"declared_mg": 10.0, "diluent": "Water", "two_step": True,
              "vials": {"1": {"vial_mg": 2500.1, "target_ug_ml": 200}}}
    before = copy.deepcopy(stored)
    patch = {"declared_mg": 12.5, "diluent": None, "capsules": 4,
             "vials": {"1": {"vial_mg": None, "vial_all_mg": 3996.4}, "2": {"lead_id": 36}}}
    patch_before = copy.deepcopy(patch)
    out = worksheets_hplc.merge_hplc_prep(stored, patch)
    assert out == {"declared_mg": 12.5, "two_step": True, "capsules": 4,
                   "vials": {"1": {"target_ug_ml": 200, "vial_all_mg": 3996.4},
                             "2": {"lead_id": 36}}}
    # never mutates its arguments, and shares nothing with them
    assert stored == before and patch == patch_before
    out["vials"]["1"]["target_ug_ml"] = 1
    assert stored["vials"]["1"]["target_ug_ml"] == 200


def test_merge_drops_an_emptied_vial_and_an_emptied_map():
    stored = {"declared_mg": 10.0, "vials": {"1": {"vial_mg": 1.0}, "2": {"vial_mg": 2.0}},
              "components": {"36": {"mg": 5.0}}}
    out = worksheets_hplc.merge_hplc_prep(
        stored, {"vials": {"1": {"vial_mg": None}}, "components": {"36": {"mg": None}}})
    assert out == {"declared_mg": 10.0, "vials": {"2": {"vial_mg": 2.0}}}
    # a whole vial sent as null goes, and a patch of nulls over nothing adds nothing
    assert worksheets_hplc.merge_hplc_prep(out, {"vials": {"2": None}}) == {"declared_mg": 10.0}
    assert worksheets_hplc.merge_hplc_prep(None, {"vials": {"1": {"vial_mg": None}}}) is None
    # None when nothing is left
    assert worksheets_hplc.merge_hplc_prep({"declared_mg": 10.0}, {"declared_mg": None}) is None
    assert worksheets_hplc.merge_hplc_prep(None, {}) is None


# --- the validator, pure -----------------------------------------------------------------

# The plan's own example of the stored shape: every key the validator accepts.
_FULL = {
    "declared_mg": 10.0, "declared_volume_ml": 3.0, "capsules": 4, "diluent": "Water + 0.1% TFA",
    "diluent_ul": 3000, "two_step": True, "stock_vial_mg": 5012.31, "stock_vial_diluent_mg": 8003.6,
    "components": {"36": {"mg": 5.0, "vial": 2, "target": 175}},
    "vials": {"1": {"lead_id": 36, "target_ug_ml": 200, "target_volume_ul": 1500,
                    "vial_mg": 2500.1, "vial_diluent_mg": 3800.2, "vial_all_mg": 3996.4,
                    "int_target_ug_ml": 5000, "int_volume_ul": 1500,
                    "int_vial_mg": 2500.0, "int_vial_diluent_mg": 3950.0, "int_vial_all_mg": 3995.0}},
}


def test_validate_accepts_the_stored_shape_zero_and_null_everywhere():
    assert worksheets_hplc.validate_hplc_prep_patch(_FULL) == _FULL
    nulls = {k: None for k in _FULL}
    assert worksheets_hplc.validate_hplc_prep_patch(nulls) == nulls
    deep_nulls = {"components": {"36": {k: None for k in _FULL["components"]["36"]}, "7": None},
                  "vials": {"1": {k: None for k in _FULL["vials"]["1"]}, "2": None}}
    assert worksheets_hplc.validate_hplc_prep_patch(deep_nulls) == deep_nulls
    zeros = {"declared_mg": 0, "stock_vial_mg": 0.0, "vials": {"7": {"vial_mg": 0}},
             "components": {"1": {"mg": 0, "target": 0, "vial": 7}}, "two_step": False,
             "diluent": "Water"}
    assert worksheets_hplc.validate_hplc_prep_patch(zeros) == zeros


@pytest.mark.parametrize("patch, key", [
    ({"foo": 1}, "foo"),                                            # unknown key, each level
    ({"components": {"36": {"bar": 1}}}, "bar"),
    ({"vials": {"1": {"baz": 1}}}, "baz"),
    ({"declared_mg": float("nan")}, "declared_mg"),                 # not finite
    ({"declared_mg": float("inf")}, "declared_mg"),
    ({"diluent_ul": 10**400}, "diluent_ul"),
    ({"vials": {"1": {"vial_mg": float("-inf")}}}, "vial_mg"),
    ({"declared_mg": -1}, "declared_mg"),                           # below zero
    ({"declared_volume_ml": -0.1}, "declared_volume_ml"),
    ({"stock_vial_diluent_mg": -5}, "stock_vial_diluent_mg"),
    ({"components": {"36": {"mg": -1}}}, "mg"),
    ({"components": {"36": {"target": -1}}}, "target"),
    ({"vials": {"1": {"target_ug_ml": -0.5}}}, "target_ug_ml"),
    ({"vials": {"1": {"int_volume_ul": -1}}}, "int_volume_ul"),
    ({"declared_mg": "10"}, "declared_mg"),                         # a string is never a number
    ({"stock_vial_mg": ""}, "stock_vial_mg"),
    ({"declared_mg": True}, "declared_mg"),                         # nor is a boolean
    ({"vials": {"1": {"vial_all_mg": "3996.4"}}}, "vial_all_mg"),
    ({"capsules": 0}, "capsules"),                                  # whole numbers of at least 1
    ({"capsules": 2.0}, "capsules"),
    ({"capsules": True}, "capsules"),
    ({"capsules": "4"}, "capsules"),
    ({"vials": {"1": {"lead_id": 0}}}, "lead_id"),
    ({"vials": {"1": {"lead_id": 36.0}}}, "lead_id"),
    ({"components": {"36": {"vial": 0}}}, "vial"),                  # a vial outside 1 to 7
    ({"components": {"36": {"vial": 8}}}, "vial"),
    ({"components": {"36": {"vial": 1.0}}}, "vial"),
    ({"components": {"01": {}}}, "01"),                             # map keys: positive whole numbers
    ({"components": {"+1": {}}}, "+1"),
    ({"components": {"0": {}}}, "0"),
    ({"vials": {"1.0": {}}}, "1.0"),
    ({"vials": {"a": {}}}, "a"),
    ({"vials": {" 1": {}}}, " 1"),
    ({"two_step": 1}, "two_step"),                                  # a boolean
    ({"two_step": "true"}, "two_step"),
    ({"diluent": "Methanol"}, "diluent"),                           # one of HPLC_DILUENTS
    ({"diluent": 5}, "diluent"),
    ({"vials": [1]}, "vials"),                                      # maps and entries are objects
    ({"components": {"36": "x"}}, "components.36"),
    ({"vials": {"1": 5}}, "vials.1"),
])
def test_validate_names_the_bad_key(patch, key):
    with pytest.raises(ValueError, match=re.escape(key)):
        worksheets_hplc.validate_hplc_prep_patch(patch)


@pytest.mark.parametrize("patch", [None, [], "x", 5])
def test_validate_refuses_a_patch_that_is_not_an_object(patch):
    with pytest.raises(ValueError, match="^hplc_prep must be an object$"):
        worksheets_hplc.validate_hplc_prep_patch(patch)


def test_prep_final_is_the_endo_wording():
    assert worksheets_hplc.PREP_FINAL == worksheets_endo.PREP_FINAL


# --- the world: SQLite for the session, Postgres for sample_preps --------------------------

# Far above any real worksheet_items id (test_sample_preps_hplc_columns.py's rule).
_IDS = itertools.count(2_000_000_000 - 9000)


@pytest.fixture
def db():
    try:
        mk1_db.ensure_sample_preps_table()
    except psycopg2.OperationalError:
        pytest.skip("no Postgres reachable at the configured MK1_DB_* address")
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1, email="qa@accumark.test")
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture
def promote():
    """promote(item) gives the item a sample_preps row, as a promote would; deleted after."""
    created = []

    def make(item):
        row = mk1_db.create_sample_prep({"peptide_id": 1, "status": "awaiting_hplc",
                                         "worksheet_item_id": item.id})
        created.append(row["id"])
        return row

    try:
        yield make
    finally:
        for prep_id in created:
            mk1_db.delete_sample_prep(prep_id)


def _ws(db, status="open"):
    ws = Worksheet(title="HPLC 11/12/2026", status=status)
    db.add(ws)
    db.flush()
    return ws


def _peptide(db, abbreviation, name=None, *, blend_of=()):
    """A catalog peptide; with blend_of ((component, vial_number), ...) a blend."""
    pep = Peptide(name=name or abbreviation, abbreviation=abbreviation, is_blend=bool(blend_of))
    db.add(pep)
    db.flush()
    for order, (component, vial) in enumerate(blend_of):
        db.execute(blend_components.insert().values(
            blend_id=pep.id, component_id=component.id, display_order=order, vial_number=vial))
    return pep


def _form(db, name="Lyophilized Powder", hplc_prep="powder"):
    form = LimsSampleForm(name=name, route="injectable", hplc_prep=hplc_prep)
    db.add(form)
    db.flush()
    return form


def _sample(db, sample_id, analytes, *, declared="10.00", form=None, sample_type_title="Peptide"):
    """A parent sample; analytes are (peptide or None, name, declared_quantity) slots."""
    parent = LimsSample(
        sample_id=sample_id, external_lims_uid=f"SEN-{sample_id}", declared_total_quantity=declared,
        sample_type_title=sample_type_title, client_order_number="WP-5541",
        sample_form_id=form.id if form else None,
        analytes=json.dumps([{"name": name, "declared_quantity": qty,
                              "peptide_id": pep.id if pep else None} for pep, name, qty in analytes]))
    db.add(parent)
    db.flush()
    return parent


def _item(db, ws, parent, n=1, *, role="hplc", **columns):
    vial = LimsSubSample(sample_id=f"{parent.sample_id}-S{n:02d}", parent_sample_pk=parent.id,
                         vial_sequence=n, external_lims_uid=f"mk1://hplc-{parent.sample_id}-{n}",
                         assignment_role=role)
    item = WorksheetItem(id=next(_IDS), worksheet_id=ws.id, sample_uid=vial.external_lims_uid,
                         sample_id=vial.sample_id, sort_order=n, **columns)
    db.add_all([vial, item])
    db.flush()
    return item


def _method(db, peptide, instrument, run_parameters, name="HPLC M1"):
    method = HplcMethod(name=name, run_parameters=run_parameters)
    db.add(method)
    db.flush()
    db.execute(peptide_methods.insert().values(peptide_id=peptide.id, method_id=method.id))
    db.execute(instrument_methods.insert().values(instrument_id=instrument.id, method_id=method.id))
    return method


_ROW_KEYS = {
    "item_id", "sample_id", "parent_sample_id", "order_number", "identity", "peptide_id",
    "peptide_name", "is_blend", "components", "declared_mg", "sample_form", "sample_bac", "form",
    "rider_only", "instrument_id", "instrument_name", "params", "prep_form", "hplc_prep",
    "promoted", "prep", "problems",
}


def _rows(db, ws):
    rows = worksheets_hplc.sheet_rows(db, ws)
    assert all(set(r) == _ROW_KEYS for r in rows)
    return rows


# --- the read model ------------------------------------------------------------------------


def test_sheet_rows_serve_a_solo_peptide_row(db):
    bpc = _peptide(db, "BPC-157")
    form = _form(db)
    inst = Instrument(name="HPLC 1290a")
    db.add(inst)
    db.flush()
    _method(db, bpc, inst, {"hplc": {"default_target_ug_ml": 150}})
    parent = _sample(db, "P-0120", [(bpc, "BPC-157", "10 mg")], form=form)
    ws = _ws(db)
    item = _item(db, ws, parent, instrument_id=inst.id)
    db.commit()
    assert _rows(db, ws) == [{
        "item_id": item.id, "sample_id": "P-0120-S01", "parent_sample_id": "P-0120",
        "order_number": "WP-5541", "identity": "BPC-157",
        "peptide_id": bpc.id, "peptide_name": "BPC-157", "is_blend": False,
        "components": [{"peptide_id": bpc.id, "name": "BPC-157", "abbreviation": "BPC-157",
                        "declared_mg": 10.0, "vial": 1}],
        "declared_mg": 10.0,
        "sample_form": {"id": form.id, "name": "Lyophilized Powder", "hplc_prep": "powder"},
        "sample_bac": False, "form": "powder", "rider_only": False,
        "instrument_id": inst.id, "instrument_name": "HPLC 1290a",
        "params": {**HPLC_RUN_PARAM_DEFAULTS, "default_target_ug_ml": 150},
        "prep_form": None, "hplc_prep": {}, "promoted": False, "prep": None, "problems": [],
    }]


def test_a_solo_component_without_its_own_quantity_takes_the_sample_weight(db):
    bpc = _peptide(db, "BPC-157")
    parent = _sample(db, "P-0121", [(bpc, "BPC-157", None)], declared="12.5", form=_form(db))
    ws = _ws(db)
    _item(db, ws, parent)
    db.commit()
    [row] = _rows(db, ws)
    assert row["components"][0]["declared_mg"] == 12.5 and row["declared_mg"] == 12.5
    # no instrument: no method, so the defaults
    assert (row["instrument_id"], row["instrument_name"], row["params"]) == (
        None, None, HPLC_RUN_PARAM_DEFAULTS)


def test_a_blend_row_carries_its_components_with_their_default_vials(db):
    bpc, tb = _peptide(db, "BPC-157"), _peptide(db, "TB-500", "Thymosin Beta-4")
    ghk = _peptide(db, "GHK-Cu")
    blend = _peptide(db, "BPC/TB", "BPC-157 + TB-500", blend_of=((bpc, 1), (tb, 2)))
    _peptide(db, "BPC/TB/GHK", blend_of=((bpc, 1), (tb, 1), (ghk, 1)))  # a superset: no match
    _peptide(db, "BPC/TB 2", blend_of=((tb, 1), (bpc, 1)))  # the same set, a higher id: not taken
    form = _form(db)
    parent = _sample(db, "P-0130", [(bpc, "BPC-157", "5 mg"), (tb, "TB-500", "5")],
                     declared="10", form=form)
    ws = _ws(db)
    item = _item(db, ws, parent)
    db.commit()
    assert _rows(db, ws) == [{
        "item_id": item.id, "sample_id": "P-0130-S01", "parent_sample_id": "P-0130",
        "order_number": "WP-5541", "identity": "BPC-157, TB-500",
        "peptide_id": blend.id, "peptide_name": "BPC-157 + TB-500", "is_blend": True,
        "components": [
            {"peptide_id": bpc.id, "name": "BPC-157", "abbreviation": "BPC-157",
             "declared_mg": 5.0, "vial": 1},
            {"peptide_id": tb.id, "name": "Thymosin Beta-4", "abbreviation": "TB-500",
             "declared_mg": 5.0, "vial": 2},
        ],
        "declared_mg": 10.0,
        "sample_form": {"id": form.id, "name": "Lyophilized Powder", "hplc_prep": "powder"},
        "sample_bac": False, "form": "powder", "rider_only": False,
        "instrument_id": None, "instrument_name": None, "params": HPLC_RUN_PARAM_DEFAULTS,
        "prep_form": None, "hplc_prep": {}, "promoted": False, "prep": None, "problems": [],
    }]


def test_a_blend_missing_from_the_catalog_says_so(db):
    bpc, ghk = _peptide(db, "BPC-157"), _peptide(db, "GHK-Cu")
    tb = _peptide(db, "TB-500")
    _peptide(db, "BPC/TB", blend_of=((bpc, 1), (tb, 2)))
    parent = _sample(db, "P-0131", [(bpc, "BPC-157", "5"), (ghk, "GHK-Cu", "50")], form=_form(db))
    ws = _ws(db)
    _item(db, ws, parent)
    db.commit()
    [row] = _rows(db, ws)
    assert (row["peptide_id"], row["peptide_name"], row["is_blend"], row["components"]) == (
        None, None, True, [])
    assert row["problems"] == ["this blend is not in the catalog"]


@pytest.mark.parametrize("analytes, problem", [
    ([(None, "BPC-157", "10")], "the sample has no catalog peptide"),
    ([], "the sample has no catalog peptide"),
    # one slot resolved and one not: never served as a solo row of the whole weight
    ([("bpc", "BPC-157", "5"), (None, "Mystery", "5")], "an analyte of the sample has no catalog peptide"),
])
def test_a_sample_without_catalog_peptides_says_so(db, analytes, problem):
    bpc = _peptide(db, "BPC-157")
    slots = [(bpc if pep == "bpc" else pep, name, qty) for pep, name, qty in analytes]
    parent = _sample(db, "P-0132", slots, form=_form(db))
    ws = _ws(db)
    _item(db, ws, parent)
    db.commit()
    [row] = _rows(db, ws)
    assert (row["peptide_id"], row["components"], row["problems"]) == (None, [], [problem])


def test_the_row_form_wins_then_bac_then_the_sample_form(db):
    bpc = _peptide(db, "BPC-157")
    liquid = _form(db, "Reconstituted Solution", "liquid")
    ws = _ws(db)
    plain = _sample(db, "P-0140", [(bpc, "BPC-157", "10")], form=liquid)
    bac = _sample(db, "BW-0140", [(bpc, "BPC-157", "10")], form=liquid)
    _item(db, ws, plain, 1)
    _item(db, ws, plain, 2, prep_form="capsule")
    _item(db, ws, bac, 3)
    _item(db, ws, bac, 4, prep_form="powder")
    db.commit()
    rows = _rows(db, ws)
    assert [(r["form"], r["sample_bac"], r["prep_form"]) for r in rows] == [
        ("liquid", False, None), ("capsule", False, "capsule"),
        ("bac", True, None), ("powder", True, "powder")]
    # a bac row works its weight out from its weighings: no declared weight is no problem
    bare = _sample(db, "BW-0141", [(bpc, "BPC-157", None)], declared=None, form=liquid)
    _item(db, ws, bare, 5)
    db.commit()
    assert _rows(db, ws)[-1]["problems"] == []


def test_a_form_with_no_hplc_prep_serves_a_null_form(db):
    bpc = _peptide(db, "BPC-157")
    pen = _form(db, "Pen", None)
    ws = _ws(db)
    _item(db, ws, _sample(db, "P-0150", [(bpc, "BPC-157", "10")], form=pen), 1)
    _item(db, ws, _sample(db, "P-0151", [(bpc, "BPC-157", "10")], form=None), 1)
    db.commit()
    rows = _rows(db, ws)
    assert rows[0]["sample_form"] == {"id": pen.id, "name": "Pen", "hplc_prep": None}
    assert rows[1]["sample_form"] is None
    for row in rows:
        assert row["form"] is None
        assert row["problems"] == ["no HPLC prep for this sample form"]


def test_no_declared_weight_is_a_problem_until_one_is_typed(db):
    bpc = _peptide(db, "BPC-157")
    parent = _sample(db, "P-0155", [(bpc, "BPC-157", None)], declared=None, form=_form(db))
    ws = _ws(db)
    item = _item(db, ws, parent)
    db.commit()
    [row] = _rows(db, ws)
    assert row["declared_mg"] is None and row["problems"] == ["no declared weight"]
    item.hplc_prep = {"declared_mg": 9.8}
    db.commit()
    assert _rows(db, ws)[0]["problems"] == []


def test_a_rider_only_item_has_no_prep(db):
    bpc = _peptide(db, "BPC-157")
    ws = _ws(db)
    _item(db, ws, _sample(db, "P-0160", [(bpc, "BPC-157", "10")], form=_form(db)), role="fentanyl")
    db.commit()
    [row] = _rows(db, ws)
    assert (row["rider_only"], row["form"], row["problems"]) == (True, None, [])


def test_other_benches_are_left_out_in_the_worksheet_order(db):
    bpc = _peptide(db, "BPC-157")
    parent = _sample(db, "P-0170", [(bpc, "BPC-157", "10")], form=_form(db))
    ws = _ws(db)
    second = _item(db, ws, parent, 2)
    _item(db, ws, parent, 3, role="endo85")
    first = _item(db, ws, parent, 1)
    db.commit()
    assert [r["item_id"] for r in _rows(db, ws)] == [first.id, second.id]


def test_a_promoted_row_says_so(db, promote):
    bpc = _peptide(db, "BPC-157")
    ws = _ws(db)
    item = _item(db, ws, _sample(db, "P-0180", [(bpc, "BPC-157", "10")], form=_form(db)))
    db.commit()
    prep = promote(item)
    [row] = _rows(db, ws)
    assert row["promoted"] is True
    assert row["prep"] == {"id": prep["id"], "sample_id": prep["sample_id"], "status": "awaiting_hplc"}


def test_sheet_rows_run_a_fixed_number_of_queries(db):
    bpc, tb = _peptide(db, "BPC-157"), _peptide(db, "TB-500")
    _peptide(db, "BPC/TB", blend_of=((bpc, 1), (tb, 2)))
    form = _form(db)
    inst = Instrument(name="HPLC 1290a")
    db.add(inst)
    db.flush()
    _method(db, bpc, inst, {"hplc": {}})
    # one row of each kind against three: the blend lookup runs only when a blend row exists
    ws_one, ws_many = _ws(db), _ws(db)
    _item(db, ws_one, _sample(db, "P-0190", [(bpc, "BPC-157", "10")], form=form), instrument_id=inst.id)
    _item(db, ws_one, _sample(db, "P-0290", [(bpc, "BPC-157", "5"), (tb, "TB-500", "5")], form=form))
    for n in range(3):
        solo = _sample(db, f"P-019{n + 1}", [(bpc, "BPC-157", "10")], form=form)
        blend = _sample(db, f"P-029{n + 1}", [(bpc, "BPC-157", "5"), (tb, "TB-500", "5")], form=form)
        _item(db, ws_many, solo, instrument_id=inst.id)
        _item(db, ws_many, blend)
    db.commit()
    with _count_sql(db) as one:
        worksheets_hplc.sheet_rows(db, ws_one)
    with _count_sql(db) as many:
        rows = worksheets_hplc.sheet_rows(db, ws_many)
    assert len(rows) == 6 and len(many) == len(one)


# --- the routes ----------------------------------------------------------------------------


def _world(db, **item_columns):
    bpc = _peptide(db, "BPC-157")
    ws = _ws(db)
    item = _item(db, ws, _sample(db, "P-0200", [(bpc, "BPC-157", "10")], form=_form(db)),
                 **item_columns)
    db.commit()
    return ws, item


def test_get_serves_the_sheet(client, db):
    ws, item = _world(db)
    r = client.get(f"/worksheets/{ws.id}/hplc")
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["worksheet_id"], body["status"], body["blend_cap"]) == (ws.id, "open", 4)
    assert [row["item_id"] for row in body["rows"]] == [item.id]
    assert set(body["rows"][0]) == _ROW_KEYS


def test_get_is_404_for_a_missing_or_staging_worksheet(client, db):
    staging = _ws(db, status="staging")
    db.commit()
    assert client.get(f"/worksheets/{staging.id}/hplc").status_code == 404
    assert client.get("/worksheets/987654/hplc").status_code == 404


@pytest.mark.parametrize("value, cap", [
    (None, 4), ("2", 2), ("1", 1), ("4", 4), ("9", 4), ("0", 1), ("-3", 1), ("two", 4), ("2.5", 4),
])
def test_the_blend_cap_comes_from_settings_clamped(client, db, value, cap):
    ws, _ = _world(db)
    if value is not None:
        db.add(Settings(key="hplc_blend_component_cap", value=value))
        db.commit()
    assert client.get(f"/worksheets/{ws.id}/hplc").json()["blend_cap"] == cap


def test_patch_merges_and_returns_the_row(client, db):
    ws, item = _world(db)
    url = f"/worksheets/{ws.id}/items/{item.id}/hplc"
    r = client.patch(url, json={"prep_form": "liquid", "hplc_prep": {
        "declared_volume_ml": 3.0, "vials": {"1": {"vial_mg": 2500.1, "target_ug_ml": 200}}}})
    assert r.status_code == 200, r.text
    row = r.json()
    assert set(row) == _ROW_KEYS
    assert (row["item_id"], row["prep_form"], row["form"]) == (item.id, "liquid", "liquid")
    assert row["hplc_prep"] == {"declared_volume_ml": 3.0,
                                "vials": {"1": {"vial_mg": 2500.1, "target_ug_ml": 200}}}
    r = client.patch(url, json={"hplc_prep": {"diluent": "Water", "vials": {"1": {"vial_mg": None}}}})
    assert r.status_code == 200, r.text
    expected = {"declared_volume_ml": 3.0, "vials": {"1": {"target_ug_ml": 200}}, "diluent": "Water"}
    assert r.json()["hplc_prep"] == expected and r.json()["prep_form"] == "liquid"
    db.expire_all()
    assert db.get(WorksheetItem, item.id).hplc_prep == expected
    # clearing the form and every input leaves the columns NULL
    r = client.patch(url, json={"prep_form": None, "hplc_prep": {
        "declared_volume_ml": None, "vials": None, "diluent": None}})
    assert r.status_code == 200 and r.json()["hplc_prep"] == {} and r.json()["form"] == "powder"
    db.expire_all()
    stored = db.get(WorksheetItem, item.id)
    assert (stored.prep_form, stored.hplc_prep) == (None, None)


@pytest.mark.parametrize("body, reason", [
    ({"hplc_prep": {"capsules": "4"}}, "capsules"),
    ({"hplc_prep": {"vials": {"01": {}}}}, "01"),
    ({"hplc_prep": None}, "hplc_prep"),
    ({"hplc_prep": [1]}, "hplc_prep"),
    ({"prep_form": "tablet"}, "powder, liquid, bac, capsule"),
    ({"prep_form": 3}, "powder, liquid, bac, capsule"),
])
def test_patch_refuses_a_bad_patch_with_the_reason(client, db, body, reason):
    ws, item = _world(db)
    r = client.patch(f"/worksheets/{ws.id}/items/{item.id}/hplc", json=body)
    assert r.status_code == 400 and reason in r.json()["detail"]
    db.expire_all()
    assert db.get(WorksheetItem, item.id).hplc_prep is None


def test_patch_refuses_a_completed_worksheet(client, db):
    ws, item = _world(db)
    ws.status = "completed"
    db.commit()
    r = client.patch(f"/worksheets/{ws.id}/items/{item.id}/hplc", json={"hplc_prep": {"declared_mg": 1}})
    assert r.status_code == 409 and r.json()["detail"] == "Worksheet is completed"


def test_patch_refuses_a_promoted_row(client, db, promote):
    ws, item = _world(db, prep_form="powder")
    item.hplc_prep = {"declared_mg": 10.0}
    db.commit()
    promote(item)
    url = f"/worksheets/{ws.id}/items/{item.id}/hplc"
    for body in ({"hplc_prep": {"declared_mg": 11.0}}, {"hplc_prep": {"declared_mg": None}},
                 {"prep_form": "liquid"}, {"prep_form": None}):
        r = client.patch(url, json=body)
        assert r.status_code == 409 and r.json()["detail"] == worksheets_hplc.PREP_FINAL, body
    db.expire_all()
    stored = db.get(WorksheetItem, item.id)
    assert (stored.prep_form, stored.hplc_prep) == ("powder", {"declared_mg": 10.0})


def test_a_patch_that_changes_nothing_on_a_promoted_row_is_fine(client, db, promote):
    ws, item = _world(db, prep_form="powder")
    item.hplc_prep = {"declared_mg": 10.0}
    db.commit()
    promote(item)
    url = f"/worksheets/{ws.id}/items/{item.id}/hplc"
    for body in ({"prep_form": "powder", "hplc_prep": {"declared_mg": 10.0}},
                 {"hplc_prep": {"capsules": None, "vials": {"1": {"vial_mg": None}}}}, {}):
        r = client.patch(url, json=body)
        assert r.status_code == 200, (body, r.text)
        assert r.json()["promoted"] is True and r.json()["hplc_prep"] == {"declared_mg": 10.0}


def test_the_item_route_refuses_an_instrument_change_on_a_promoted_row(client, db, promote):
    one, two = Instrument(name="HPLC 1290a", senaite_uid="uid-1"), Instrument(name="HPLC 1290b")
    db.add_all([one, two])
    db.flush()
    ws, item = _world(db, instrument_id=one.id, instrument_uid="uid-1")
    promote(item)
    url = f"/worksheets/{ws.id}/items/{item.id}"
    for body in ({"instrument_id": two.id}, {"instrument_id": None},
                 {"instrument_uid": "uid-2"}, {"instrument_uid": ""}):
        r = client.patch(url, json=body)
        assert r.status_code == 409 and r.json()["detail"] == worksheets_hplc.PREP_FINAL, body
    # the same instrument, and fields that are not the instrument, still save
    for body in ({"instrument_id": one.id}, {"instrument_uid": "uid-1"}, {"prep_status": "complete"}):
        assert client.patch(url, json=body).status_code == 200, body
    db.expire_all()
    stored = db.get(WorksheetItem, item.id)
    assert (stored.instrument_id, stored.instrument_uid, stored.prep_status) == (
        one.id, "uid-1", "complete")


def test_an_unpromoted_row_still_changes_instrument(client, db):
    one = Instrument(name="HPLC 1290a")
    db.add(one)
    db.flush()
    ws, item = _world(db)
    r = client.patch(f"/worksheets/{ws.id}/items/{item.id}", json={"instrument_id": one.id})
    assert r.status_code == 200, r.text
    r = client.get(f"/worksheets/{ws.id}/hplc")
    assert r.json()["rows"][0]["instrument_id"] == one.id


def test_an_endo_row_is_not_an_hplc_row(client, db):
    ws, item = _world(db)
    parent = db.query(LimsSample).filter_by(sample_id="P-0200").one()
    endo = _item(db, ws, parent, 2, role="endo85")
    db.commit()
    r = client.patch(f"/worksheets/{ws.id}/items/{endo.id}/hplc", json={"hplc_prep": {"declared_mg": 1}})
    assert r.status_code == 404
    # nor is an item of another worksheet, a missing item or a staging worksheet's item
    other = _ws(db)
    staging = _ws(db, status="staging")
    db.commit()
    assert client.patch(f"/worksheets/{other.id}/items/{item.id}/hplc", json={}).status_code == 404
    assert client.patch(f"/worksheets/{ws.id}/items/1/hplc", json={}).status_code == 404
    item.worksheet_id = staging.id
    db.commit()
    assert client.patch(f"/worksheets/{staging.id}/items/{item.id}/hplc", json={}).status_code == 404
