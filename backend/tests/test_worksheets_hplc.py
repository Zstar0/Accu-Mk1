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
import types
from unittest.mock import MagicMock

import main
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
    AnalysisService,
    HplcMethod,
    Instrument,
    LimsAnalysis,
    LimsSample,
    LimsSampleForm,
    LimsSubSample,
    Peptide,
    ServiceGroup,
    Settings,
    Worksheet,
    WorksheetItem,
    blend_components,
    instrument_methods,
    peptide_methods,
    service_group_members,
)
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from tests.test_endo_v2_worksheets import _count_sql
from tests.test_spec_rules import _mk_identity_service

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
    # the ceilings themselves are allowed (D1)
    tops = {"capsules": 2**53 - 1, "declared_mg": 1e12, "diluent_ul": 10**12,
            "components": {"36": {"mg": 1e12, "target": 1e12}},
            "vials": {"1": {"lead_id": 2**53 - 1, "vial_all_mg": 1e9}}}  # a weighing: B4
    assert worksheets_hplc.validate_hplc_prep_patch(tops) == tops


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
    # fix round 2, D1: past 2**53 - 1 JavaScript rounds a whole number, and no balance reads 1e12
    ({"capsules": 2**53}, "capsules"),
    ({"vials": {"1": {"lead_id": 2**53}}}, "lead_id"),
    ({"declared_mg": 1e12 * 1.5}, "declared_mg"),
    ({"diluent_ul": 10**13}, "diluent_ul"),
    ({"components": {"36": {"mg": 2e12}}}, "mg"),
    ({"components": {"36": {"target": 2e12}}}, "target"),
    ({"vials": {"1": {"target_ug_ml": 2e12}}}, "target_ug_ml"),
    ({"vials": {"1": {"int_vial_all_mg": 2e12}}}, "int_vial_all_mg"),
    # D2: a vial is 1 to 7, as a component's vial is
    ({"vials": {"8": {}}}, "8"),
    ({"vials": {"36": None}}, "36"),
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
    """A parent sample; analytes are (peptide or None, name, declared_quantity) slots, or None
    for a sample born in the older LIMS (no analytes column at all)."""
    parent = LimsSample(
        sample_id=sample_id, external_lims_uid=f"SEN-{sample_id}", declared_total_quantity=declared,
        sample_type_title=sample_type_title, client_order_number="WP-5541",
        sample_form_id=form.id if form else None,
        analytes=None if analytes is None else json.dumps([
            {"name": name, "declared_quantity": qty, "peptide_id": pep.id if pep else None}
            for pep, name, qty in analytes]))
    db.add(parent)
    db.flush()
    return parent


def _analysis(db, peptide, *, parent=None, item=None, state="assigned"):
    """A live (or dead, by `state`) analysis on a peptide-linked service, on the parent or on
    the item's vial: what the analyses fallback reads."""
    svc = _mk_identity_service(db, peptide.id, f"{peptide.abbreviation}-PURITY-{next(_IDS)}")
    vial_pk = (db.query(LimsSubSample).filter_by(sample_id=item.sample_id).one().id
               if item is not None else None)
    db.add(LimsAnalysis(lims_sample_pk=parent.id if parent is not None else None,
                        lims_sub_sample_pk=vial_pk, analysis_service_id=svc.id,
                        keyword=svc.keyword, title=svc.title, review_state=state,
                        provenance="canonical"))
    db.flush()


def _item(db, ws, parent, n=1, *, role="hplc", **columns):
    # the vial's id far above any real one too: other_preps reads sample_preps by vial (B8)
    vial = LimsSubSample(id=next(_IDS), sample_id=f"{parent.sample_id}-S{n:02d}", parent_sample_pk=parent.id,
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
    "peptide_name", "is_blend", "components", "components_source", "declared_mg", "sample_form", "sample_bac", "form",
    "rider_only", "instrument_id", "instrument_name", "params", "prep_form", "hplc_prep",
    "promoted", "prep", "problems", "other_preps",
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
        "components_source": "analytes",
        "declared_mg": 10.0,
        "sample_form": {"id": form.id, "name": "Lyophilized Powder", "hplc_prep": "powder"},
        "sample_bac": False, "form": "powder", "rider_only": False,
        "instrument_id": inst.id, "instrument_name": "HPLC 1290a",
        "params": {**HPLC_RUN_PARAM_DEFAULTS, "default_target_ug_ml": 150},
        "prep_form": None, "hplc_prep": {}, "promoted": False, "prep": None, "problems": [],
        "other_preps": [],
    }]


@pytest.mark.parametrize("quantity", [None, "10"])
def test_a_solo_component_takes_the_row_weight(db, quantity):
    # the row's weight is converted from IU where the sample was ordered in IU; the analyte's
    # raw quantity is not, so a solo component never shows it under an mg key
    bpc = _peptide(db, "BPC-157")
    parent = _sample(db, "P-0121", [(bpc, "BPC-157", quantity)], declared="12.5", form=_form(db))
    ws = _ws(db)
    _item(db, ws, parent)
    db.commit()
    [row] = _rows(db, ws)
    assert row["components"][0]["declared_mg"] == 12.5 and row["declared_mg"] == 12.5
    # no instrument: no method, so the defaults
    assert (row["instrument_id"], row["instrument_name"], row["params"]) == (
        None, None, HPLC_RUN_PARAM_DEFAULTS)


@pytest.mark.parametrize("decoy_first, decoy_active", [
    (True, False),   # a retired blend of the same set, the LOWER id: the active one wins
    (False, True),   # both active: the lowest id wins
])
def test_a_blend_row_carries_its_components_with_their_default_vials(db, decoy_first, decoy_active):
    bpc, tb = _peptide(db, "BPC-157"), _peptide(db, "TB-500", "Thymosin Beta-4")
    ghk = _peptide(db, "GHK-Cu")

    def decoy():
        pep = _peptide(db, "BPC/TB 2", blend_of=((tb, 1), (bpc, 1)))  # the same set
        pep.active = decoy_active

    if decoy_first:
        decoy()
    blend = _peptide(db, "BPC/TB", "BPC-157 + TB-500", blend_of=((bpc, 1), (tb, 2)))
    _peptide(db, "BPC/TB/GHK", blend_of=((bpc, 1), (tb, 1), (ghk, 1)))  # a superset: no match
    if not decoy_first:
        decoy()
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
        "components_source": "analytes",
        "declared_mg": 10.0,
        "sample_form": {"id": form.id, "name": "Lyophilized Powder", "hplc_prep": "powder"},
        "sample_bac": False, "form": "powder", "rider_only": False,
        "instrument_id": None, "instrument_name": None, "params": HPLC_RUN_PARAM_DEFAULTS,
        "prep_form": None, "hplc_prep": {}, "promoted": False, "prep": None, "problems": [],
        "other_preps": [],
    }]


def test_an_inactive_blend_is_still_the_match_when_it_is_the_only_one(db):
    # the sample is what it is: a retired blend still names it, and that is no problem
    bpc, tb = _peptide(db, "BPC-157"), _peptide(db, "TB-500")
    retired = _peptide(db, "BPC/TB", blend_of=((bpc, 1), (tb, 2)))
    retired.active = False
    parent = _sample(db, "P-0133", [(bpc, "BPC-157", "5"), (tb, "TB-500", "5")], form=_form(db))
    ws = _ws(db)
    _item(db, ws, parent)
    db.commit()
    [row] = _rows(db, ws)
    assert (row["peptide_id"], row["is_blend"], row["problems"]) == (retired.id, True, [])


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
    (None, "the sample has no catalog peptide"),  # no analytes and no analysis peptide either
    # one slot resolved and one not: never served as a solo row of the whole weight
    ([("bpc", "BPC-157", "5"), (None, "Mystery", "5")], "an analyte of the sample has no catalog peptide"),
])
def test_a_sample_without_catalog_peptides_says_so(db, analytes, problem):
    bpc = _peptide(db, "BPC-157")
    slots = None if analytes is None else [
        (bpc if pep == "bpc" else pep, name, qty) for pep, name, qty in analytes]
    parent = _sample(db, "P-0132", slots, form=_form(db))
    ws = _ws(db)
    _item(db, ws, parent)
    db.commit()
    [row] = _rows(db, ws)
    assert (row["peptide_id"], row["components"], row["problems"]) == (None, [], [problem])
    assert row["components_source"] == ("analytes" if analytes and analytes[0][0] else None)


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


def test_no_declared_weight_is_no_problem(db):
    # the sheet has a Declared Peptide Wt (mg) box for it (fix round 1 ruling)
    bpc = _peptide(db, "BPC-157")
    parent = _sample(db, "P-0155", [(bpc, "BPC-157", None)], declared=None, form=_form(db))
    ws = _ws(db)
    _item(db, ws, parent)
    db.commit()
    [row] = _rows(db, ws)
    assert row["declared_mg"] is None and row["components"][0]["declared_mg"] is None
    assert row["problems"] == []


# --- the analyses fallback: a sample born in the older LIMS has no analytes ------------------


def test_a_sample_without_analytes_takes_its_one_analysis_peptide(db):
    bpc = _peptide(db, "BPC-157")
    form = _form(db)
    parent = _sample(db, "P-0076", None, declared=None, form=form)
    ws = _ws(db)
    item = _item(db, ws, parent)
    _analysis(db, bpc, item=item)  # on the vial
    _analysis(db, bpc, parent=parent)  # and on the parent: still one peptide
    db.commit()
    assert _rows(db, ws) == [{
        "item_id": item.id, "sample_id": "P-0076-S01", "parent_sample_id": "P-0076",
        "order_number": "WP-5541", "identity": None,
        "peptide_id": bpc.id, "peptide_name": "BPC-157", "is_blend": False,
        "components": [{"peptide_id": bpc.id, "name": "BPC-157", "abbreviation": "BPC-157",
                        "declared_mg": None, "vial": 1}],
        "components_source": "analyses",
        "declared_mg": None,
        "sample_form": {"id": form.id, "name": "Lyophilized Powder", "hplc_prep": "powder"},
        "sample_bac": False, "form": "powder", "rider_only": False,
        "instrument_id": None, "instrument_name": None, "params": HPLC_RUN_PARAM_DEFAULTS,
        "prep_form": None, "hplc_prep": {}, "promoted": False, "prep": None, "problems": [],
        "other_preps": [],
    }]


def test_a_sample_without_analytes_takes_the_blend_its_analyses_name(db):
    bpc, tb = _peptide(db, "BPC-157"), _peptide(db, "TB-500", "Thymosin Beta-4")
    # the blend's own order: TB-500 first
    blend = _peptide(db, "BPC/TB", "BPC-157 + TB-500", blend_of=((tb, 2), (bpc, 1)))
    form = _form(db)
    parent = _sample(db, "P-0077", None, declared="10", form=form)
    ws = _ws(db)
    item = _item(db, ws, parent)
    _analysis(db, bpc, parent=parent)
    _analysis(db, tb, item=item)
    db.commit()
    assert _rows(db, ws) == [{
        "item_id": item.id, "sample_id": "P-0077-S01", "parent_sample_id": "P-0077",
        "order_number": "WP-5541", "identity": None,
        "peptide_id": blend.id, "peptide_name": "BPC-157 + TB-500", "is_blend": True,
        "components": [
            {"peptide_id": tb.id, "name": "Thymosin Beta-4", "abbreviation": "TB-500",
             "declared_mg": None, "vial": 2},
            {"peptide_id": bpc.id, "name": "BPC-157", "abbreviation": "BPC-157",
             "declared_mg": None, "vial": 1},
        ],
        "components_source": "analyses",
        "declared_mg": 10.0,
        "sample_form": {"id": form.id, "name": "Lyophilized Powder", "hplc_prep": "powder"},
        "sample_bac": False, "form": "powder", "rider_only": False,
        "instrument_id": None, "instrument_name": None, "params": HPLC_RUN_PARAM_DEFAULTS,
        "prep_form": None, "hplc_prep": {}, "promoted": False, "prep": None, "problems": [],
        "other_preps": [],
    }]


def test_analysis_peptides_that_are_no_catalog_blend_say_so(db):
    bpc, ghk = _peptide(db, "BPC-157"), _peptide(db, "GHK-Cu")
    tb = _peptide(db, "TB-500")
    _peptide(db, "BPC/TB", blend_of=((bpc, 1), (tb, 2)))
    parent = _sample(db, "P-0078", None, form=_form(db))
    ws = _ws(db)
    item = _item(db, ws, parent)
    _analysis(db, bpc, item=item)
    _analysis(db, ghk, item=item)
    db.commit()
    [row] = _rows(db, ws)
    assert (row["peptide_id"], row["is_blend"], row["components"], row["components_source"]) == (
        None, True, [], "analyses")
    assert row["problems"] == ["this blend is not in the catalog"]


def test_dead_analysis_rows_are_not_counted(db):
    bpc, tb, ghk, sema = (_peptide(db, a) for a in ("BPC-157", "TB-500", "GHK-Cu", "Semaglutide"))
    parent = _sample(db, "P-0079", None, form=_form(db))
    ws = _ws(db)
    item = _item(db, ws, parent)
    _analysis(db, bpc, item=item)
    for pep, state in ((tb, "retracted"), (ghk, "rejected"), (sema, "cancelled")):
        _analysis(db, pep, item=item, state=state)
    db.commit()
    [row] = _rows(db, ws)
    assert (row["peptide_id"], row["is_blend"], row["components_source"]) == (bpc.id, False, "analyses")


def test_the_samples_own_analytes_win_over_its_analyses(db):
    bpc, tb = _peptide(db, "BPC-157"), _peptide(db, "TB-500")
    parent = _sample(db, "P-0080", [(bpc, "BPC-157", "10")], form=_form(db))
    ws = _ws(db)
    item = _item(db, ws, parent)
    _analysis(db, tb, item=item)
    db.commit()
    [row] = _rows(db, ws)
    assert (row["peptide_id"], row["components_source"]) == (bpc.id, "analytes")
    assert [c["peptide_id"] for c in row["components"]] == [bpc.id]


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
    # one row of each kind against three: the blend and analyses lookups run only when a row
    # needs them. Kinds: a solo and a blend from analytes, a solo and a blend from analyses.
    def rows_of_each_kind(ws, tag):
        _item(db, ws, _sample(db, f"P-1{tag}", [(bpc, "BPC-157", "10")], form=form),
              instrument_id=inst.id)
        _item(db, ws, _sample(db, f"P-2{tag}", [(bpc, "BPC-157", "5"), (tb, "TB-500", "5")], form=form))
        old_solo = _item(db, ws, _sample(db, f"P-3{tag}", None, form=form), instrument_id=inst.id)
        _analysis(db, bpc, item=old_solo)
        old_blend = _item(db, ws, _sample(db, f"P-4{tag}", None, form=form))
        _analysis(db, bpc, item=old_blend)
        _analysis(db, tb, item=old_blend)

    ws_one, ws_many = _ws(db), _ws(db)
    rows_of_each_kind(ws_one, "000")
    for n in range(3):
        rows_of_each_kind(ws_many, f"10{n}")
    db.commit()
    db.refresh(ws_one)
    db.refresh(ws_many)
    with _count_sql(db) as one:
        worksheets_hplc.sheet_rows(db, ws_one)
    with _count_sql(db) as many:
        rows = worksheets_hplc.sheet_rows(db, ws_many)
    assert len(rows) == 12 and all(r["peptide_id"] for r in rows)
    assert len(many) == len(one) == 10


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


def test_the_item_route_refuses_a_form_change_on_a_promoted_row(client, db, promote):
    ws, item = _world(db, prep_form="powder")
    promote(item)
    url = f"/worksheets/{ws.id}/items/{item.id}"
    for body in ({"prep_form": "liquid"}, {"prep_form": None}):
        r = client.patch(url, json=body)
        assert r.status_code == 409 and r.json()["detail"] == worksheets_hplc.PREP_FINAL, body
    # the same form, and the fields that are not prep fields, still save
    for body in ({"prep_form": "powder"}, {"made": True}, {"prep_status": "complete"}):
        assert client.patch(url, json=body).status_code == 200, body
    db.expire_all()
    stored = db.get(WorksheetItem, item.id)
    assert (stored.prep_form, stored.prep_status) == ("powder", "complete")
    assert stored.made_at is not None


def test_the_item_route_still_changes_the_form_of_other_rows(client, db, promote):
    ws, item = _world(db)
    parent = db.query(LimsSample).filter_by(sample_id="P-0200").one()
    endo = _item(db, ws, parent, 2, role="endo85")
    db.commit()
    promote(endo)  # a sample_preps row says nothing about an endotoxin row
    for row in (item, endo):
        r = client.patch(f"/worksheets/{ws.id}/items/{row.id}", json={"prep_form": "liquid"})
        assert r.status_code == 200, r.text
    db.expire_all()
    assert [db.get(WorksheetItem, i).prep_form for i in (item.id, endo.id)] == ["liquid", "liquid"]


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


# --- fix round 2 ---------------------------------------------------------------------------

# C: the identity is the customer's: the parent's identity, else the served peptide names.


def test_the_identity_is_the_parents_peptide_name_without_analytes(db):
    parent = _sample(db, "P-0079", None, form=_form(db))
    parent.peptide_name = "BPC-157 (client label)"
    ws = _ws(db)
    _item(db, ws, parent, analyses_json=json.dumps([{"peptide_name": "BPC-157"}]))
    db.commit()
    assert _rows(db, ws)[0]["identity"] == "BPC-157 (client label)"


def test_the_identity_falls_back_to_the_served_peptide_names(db):
    _peptide(db, "BPC-157", "Catalog BPC")  # never the catalog's name
    form = _form(db)
    parent = _sample(db, "P-0080", None, form=form)
    ws = _ws(db)
    _item(db, ws, parent, analyses_json=json.dumps(
        [{"peptide_name": "BPC-157"}, {"peptide_name": "TB-500"}, {"peptide_name": "BPC-157"}]))
    bare = _item(db, ws, _sample(db, "P-0081", None, form=form), 2)
    db.commit()
    rows = {r["item_id"]: r for r in _rows(db, ws)}
    assert [r["identity"] for r in rows.values() if r["item_id"] != bare.id] == ["BPC-157, TB-500"]
    assert rows[bare.id]["identity"] is None  # nothing declared, nothing served


# D3, D4, D5


def test_a_rider_only_row_refuses_an_hplc_prep_patch(client, db):
    ws, _ = _world(db)
    parent = db.query(LimsSample).filter_by(sample_id="P-0200").one()
    rider = _item(db, ws, parent, 2, role="fentanyl")
    db.commit()
    r = client.patch(f"/worksheets/{ws.id}/items/{rider.id}/hplc", json={"hplc_prep": {"declared_mg": 1}})
    assert r.status_code == 400 and r.json()["detail"] == "this row has no prep"
    db.expire_all()
    assert db.get(WorksheetItem, rider.id).hplc_prep is None


def test_an_analysis_peptide_missing_from_the_catalog_names_the_ordered_test(db):
    bpc = _peptide(db, "BPC-157")
    parent = _sample(db, "P-0082", None, form=_form(db))
    ws = _ws(db)
    item = _item(db, ws, parent)
    _analysis(db, bpc, item=item)
    _analysis(db, types.SimpleNamespace(id=987_654_321, abbreviation="GONE"), item=item)
    db.commit()
    [row] = _rows(db, ws)
    assert (row["peptide_id"], row["components"], row["components_source"]) == (None, [], "analyses")
    assert row["problems"] == ["a test ordered on the sample has no catalog peptide"]


def test_an_analyte_naming_no_catalog_peptide_says_so(db):
    gone = types.SimpleNamespace(id=987_654_321)
    parent = _sample(db, "P-0083", [(gone, "Mystery", "10")], form=_form(db))
    ws = _ws(db)
    _item(db, ws, parent)
    db.commit()
    [row] = _rows(db, ws)
    assert (row["peptide_id"], row["components"], row["components_source"]) == (None, [], "analytes")
    assert row["problems"] == ["an analyte of the sample has no catalog peptide"]


# A: a promoted HPLC row's instrument never changes, by any route.


@pytest.fixture
def sole_instrument(db, monkeypatch):
    """The catalog leaves one instrument for every item, so a Ran tick would stamp it."""
    inst = Instrument(name="HPLC 1290a")
    db.add(inst)
    db.flush()
    monkeypatch.setattr(main, "_sole_instrument_for_item", lambda _db, _it, prefer=None: (inst.id, []))
    return inst


def _promoted_and_plain(db, promote, **columns):
    ws, item = _world(db, **columns)
    parent = db.query(LimsSample).filter_by(sample_id="P-0200").one()
    plain = _item(db, ws, parent, 2, **columns)
    db.commit()
    promote(item)
    return ws, item, plain


def _instruments(db, *items):
    db.expire_all()
    return [(db.get(WorksheetItem, it.id).instrument_id, db.get(WorksheetItem, it.id).ran_at is not None)
            for it in items]


def test_a_ran_tick_never_stamps_an_instrument_on_a_promoted_row(client, db, promote, sole_instrument):
    ws, item, plain = _promoted_and_plain(db, promote)
    for row in (item, plain):
        r = client.patch(f"/worksheets/{ws.id}/items/{row.id}", json={"ran": True})
        assert r.status_code == 200, r.text
    assert _instruments(db, item, plain) == [(None, True), (sole_instrument.id, True)]


def test_bulk_ran_ticks_never_stamp_an_instrument_on_a_promoted_row(client, db, promote, sole_instrument):
    ws, item, plain = _promoted_and_plain(db, promote)
    r = client.post(f"/worksheets/{ws.id}/bench-ticks", json={"ran": True})
    assert r.status_code == 200 and r.json()["changed"] == 2, r.text
    assert _instruments(db, item, plain) == [(None, True), (sole_instrument.id, True)]


def test_apply_method_instrument_skips_a_promoted_row_and_says_so(client, db, promote):
    one, two = Instrument(name="HPLC 1290a"), Instrument(name="HPLC 1290b")
    db.add_all([one, two])
    db.flush()
    ws, item, plain = _promoted_and_plain(db, promote, instrument_id=one.id)
    method = HplcMethod(name="HPLC M2")
    db.add(method)
    db.flush()
    db.execute(instrument_methods.insert().values(instrument_id=two.id, method_id=method.id))
    db.commit()
    r = client.post(f"/worksheets/{ws.id}/apply-method-instrument",
                    json={"method_id": method.id, "instrument_id": two.id})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["items_updated"] == 1
    assert body["skipped_promoted"] == [{"item_id": item.id, "sample_id": item.sample_id}]
    assert [i for i, _ in _instruments(db, item, plain)] == [one.id, two.id]


def test_the_item_route_locks_an_hplc_row_whenever_an_instrument_or_form_is_sent(client, db, monkeypatch):
    # A3: the locks are taken on what the request SENDS, then the locked re-read is judged;
    # a value equal to the first, unlocked read still takes them
    import endo_prep_rules

    one = Instrument(name="HPLC 1290a")
    db.add(one)
    db.flush()
    ws, item = _world(db, instrument_id=one.id, prep_form="powder")
    parent = db.query(LimsSample).filter_by(sample_id="P-0200").one()
    endo = _item(db, ws, parent, 2, role="endo85")
    db.commit()
    locked = []
    real = endo_prep_rules.lock_items_for_update
    monkeypatch.setattr(endo_prep_rules, "lock_items_for_update",
                        lambda _db, _ws, ids: (locked.append(sorted(ids)), real(_db, _ws, ids))[1])
    url = f"/worksheets/{ws.id}/items/{item.id}"
    for body in ({"instrument_id": one.id}, {"prep_form": "powder"}, {"ran": True}):
        locked.clear()
        assert client.patch(url, json=body).status_code == 200, body
        # (a form is also an endo field, whose path locks too: taking a held lock is a no-op)
        assert locked and all(ids == [item.id] for ids in locked), body
    # no instrument, form or Ran tick sent, or not an HPLC row: no locks, as before
    for row, body in ((item, {"prep_status": "in_progress"}), (endo, {"instrument_id": one.id})):
        locked.clear()
        assert client.patch(f"/worksheets/{ws.id}/items/{row.id}", json=body).status_code == 200
        assert locked == [], body


# --- fix wave (backend) ----------------------------------------------------------------------

# B1: the components map cannot grow past the row's own components.


def test_validate_refuses_more_than_seven_component_keys_in_one_patch():
    seven = {str(n): {"mg": 1.0} for n in range(1, 8)}
    assert worksheets_hplc.validate_hplc_prep_patch({"components": seven})
    with pytest.raises(ValueError, match=r"hplc_prep\.components has 8 keys"):
        worksheets_hplc.validate_hplc_prep_patch({"components": {**seven, "8": {"mg": 1.0}}})
    assert worksheets_hplc.MAX_COMPONENTS == 7


def test_patch_refuses_a_component_key_that_is_not_the_rows_and_stores_nothing(client, db):
    ws, item = _world(db)
    url = f"/worksheets/{ws.id}/items/{item.id}/hplc"
    r = client.patch(url, json={"hplc_prep": {"declared_mg": 9.0, "components": {"987654": {"mg": 1.0}}}})
    assert r.status_code == 400
    assert r.json()["detail"] == "hplc_prep.components key '987654' is not a component of this row"
    db.expire_all()
    assert db.get(WorksheetItem, item.id).hplc_prep is None
    # eight keys in one body: refused before the row is looked at
    r = client.patch(url, json={"hplc_prep": {"components": {str(n): {"mg": 1.0} for n in range(1, 9)}}})
    assert r.status_code == 400 and "components has 8 keys" in r.json()["detail"]
    # the row's own component still saves, and a null for a stray key only removes
    bpc = db.query(Peptide).filter_by(abbreviation="BPC-157").one()
    r = client.patch(url, json={"hplc_prep": {"components": {str(bpc.id): {"target": 150}, "987654": None}}})
    assert r.status_code == 200, r.text
    assert r.json()["hplc_prep"] == {"components": {str(bpc.id): {"target": 150}}}


# B4: the sheet refuses the weighings and volumes the engine would refuse.


def test_the_ceilings_are_the_analyze_routes_own():
    assert worksheets_hplc.MAX_WEIGHING_MG == main.MAX_WEIGHING_MG
    assert worksheets_hplc.MAX_DECLARED_VOLUME_ML == main.MAX_DECLARED_VOLUME_ML


@pytest.mark.parametrize("make, top", [
    (lambda v: {"stock_vial_diluent_mg": v}, 1e9),
    (lambda v: {"vials": {"1": {"vial_mg": v}}}, 1e9),
    (lambda v: {"vials": {"2": {"int_vial_all_mg": v}}}, 1e9),
    (lambda v: {"declared_volume_ml": v}, 1e6),
])
def test_a_weighing_or_a_volume_above_the_engines_ceiling_is_refused(make, top):
    assert worksheets_hplc.validate_hplc_prep_patch(make(top)) == make(top)
    with pytest.raises(ValueError, match=f"must be a number from 0 to {top:.0f}"):
        worksheets_hplc.validate_hplc_prep_patch(make(top * (1 + 1e-9)))


# B7: the branch's statements in ensure_sample_preps_table run once per process.


class _FakeConn:
    def __init__(self, log, fail_on=None):
        self.log, self.fail_on = log, fail_on

    def cursor(self, **_k):
        conn = self

        class _Cur:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def execute(self, sql, *a):
                if conn.fail_on and conn.fail_on in sql:
                    raise psycopg2.OperationalError("lock timeout")
                conn.log.append(sql)
        return _Cur()

    def commit(self):
        self.log.append("COMMIT")

    def rollback(self):
        pass

    def close(self):
        pass


def test_the_hplc_statements_of_ensure_run_once_per_process_and_again_after_a_failure(monkeypatch):
    import contextlib

    log, fail = [], {"on": "uq_sample_preps_worksheet_item"}

    @contextlib.contextmanager
    def fake():
        yield _FakeConn(log, fail["on"])

    monkeypatch.setattr(mk1_db, "get_mk1_db", fake)
    monkeypatch.setattr(mk1_db, "_hplc_columns_ready", False)
    def new():  # the eight ADD COLUMNs and the unique index this branch added
        return [s for s in log if any(f" {c} " in s for c in mk1_db._HPLC_PREP_COLUMNS)
                or "uq_sample_preps_worksheet_item" in s]

    with pytest.raises(psycopg2.OperationalError):
        mk1_db.ensure_sample_preps_table()
    assert mk1_db._hplc_columns_ready is False  # a failure leaves the flag unset
    fail["on"] = None
    log.clear()
    mk1_db.ensure_sample_preps_table()
    assert mk1_db._hplc_columns_ready is True and len(new()) == 9
    old = [s for s in log if s.startswith("ALTER") and s not in new()]
    log.clear()
    mk1_db.ensure_sample_preps_table()
    assert new() == []
    # the statements from before this branch run every time, as they did
    assert [s for s in log if s.startswith("ALTER")] == old and len(old) == 13


# B8: a vial that already has a prep says so.


def _prep_on(vial_pk, item_id=None):
    return mk1_db.create_sample_prep({"peptide_id": 1, "status": "awaiting_hplc",
                                      "lims_sub_sample_pk": vial_pk, "worksheet_item_id": item_id})


def test_other_preps_lists_the_vials_preps_not_made_from_this_row_newest_first(db):
    ws, item = _world(db)
    parent = db.query(LimsSample).filter_by(sample_id="P-0200").one()
    bare = _item(db, ws, parent, 2)
    db.commit()
    vial_pk = db.query(LimsSubSample.id).filter_by(sample_id=item.sample_id).scalar()
    made = []
    try:
        made.append(_prep_on(vial_pk))                    # the old wizard's prep
        made.append(_prep_on(vial_pk, next(_IDS)))        # promoted from another worksheet's row
        made.append(_prep_on(vial_pk, item.id))           # this row's own promote
        rows = {r["item_id"]: r for r in _rows(db, ws)}
        slim = lambda p: {"id": p["id"], "sample_id": p["sample_id"], "status": p["status"]}  # noqa: E731
        assert rows[item.id]["other_preps"] == [slim(made[1]), slim(made[0])]
        assert rows[item.id]["prep"] == slim(made[2]) and rows[item.id]["promoted"] is True
        assert rows[bare.id]["other_preps"] == [] and rows[bare.id]["promoted"] is False
    finally:
        for p in made:
            mk1_db.delete_sample_prep(p["id"])


def test_other_preps_is_one_mk1_db_query_whatever_the_row_count(db, monkeypatch):
    ws, item = _world(db)
    parent = db.query(LimsSample).filter_by(sample_id="P-0200").one()
    for n in range(2, 6):
        _item(db, ws, parent, n)
    db.commit()
    calls = []
    real = mk1_db.list_sample_preps_for_worksheet_items_or_vials
    monkeypatch.setattr(mk1_db, "list_sample_preps_for_worksheet_items_or_vials",
                        lambda *a: (calls.append(a), real(*a))[1])
    assert len(_rows(db, ws)) == 5 and len(calls) == 1


# B9: a no-op instrument send leaves a promoted row's analyses alone.


def test_a_no_op_instrument_uid_never_rewrites_a_promoted_rows_analyses(client, db, promote):
    bpc = _peptide(db, "BPC-157")
    inst = Instrument(name="HPLC 1290a", senaite_uid="uid-1")
    db.add(inst)
    db.flush()
    _method(db, bpc, inst, {"hplc": {}})
    svc = AnalysisService(title="BPC-157 purity", keyword="PUR_BPC157_SG", peptide_id=bpc.id)
    group = ServiceGroup(name="HPLC group")
    db.add_all([svc, group])
    db.flush()
    db.execute(service_group_members.insert().values(service_group_id=group.id, analysis_service_id=svc.id))
    ws = _ws(db)
    parent = _sample(db, "P-0210", [(bpc, "BPC-157", "10")], form=_form(db))
    analyses = json.dumps([{"keyword": "PUR_BPC157_SG"}])
    cols = dict(instrument_id=inst.id, instrument_uid="uid-1", service_group_id=group.id, analyses_json=analyses)
    item, plain = _item(db, ws, parent, 1, **cols), _item(db, ws, parent, 2, **cols)
    db.commit()
    promote(item)
    for row in (item, plain):
        r = client.patch(f"/worksheets/{ws.id}/items/{row.id}", json={"instrument_uid": "uid-1"})
        assert r.status_code == 200, r.text
    db.expire_all()
    assert db.get(WorksheetItem, item.id).analyses_json == analyses
    assert json.loads(db.get(WorksheetItem, plain.id).analyses_json) == [
        {"keyword": "PUR_BPC157_SG", "method": "HPLC M1"}]  # an unpromoted row still resolves


# B12: a worksheet gone before the lock is a 404.


def test_a_worksheet_deleted_before_the_lock_is_404(db, monkeypatch):
    from fastapi import HTTPException

    ws, item = _world(db)
    monkeypatch.setattr(main, "_worksheet_for_update", lambda _db, _wid: None)
    with pytest.raises(HTTPException) as caught:
        main._promoted_hplc_rows_locked(db, ws.id, [item])
    assert caught.value.status_code == 404


# B13: the tests the reviews named.


def test_with_both_matching_blends_retired_the_lowest_id_wins(db):
    bpc, tb = _peptide(db, "BPC-157"), _peptide(db, "TB-500")
    first = _peptide(db, "BPC/TB", blend_of=((bpc, 1), (tb, 2)))
    second = _peptide(db, "BPC/TB 2", blend_of=((tb, 1), (bpc, 1)))
    first.active = second.active = False
    parent = _sample(db, "P-0134", [(bpc, "BPC-157", "5"), (tb, "TB-500", "5")], form=_form(db))
    ws = _ws(db)
    _item(db, ws, parent)
    db.commit()
    [row] = _rows(db, ws)
    assert (row["peptide_id"], row["problems"]) == (min(first.id, second.id), [])


def test_apply_method_instrument_leaves_a_promoted_rows_vial_analyses_unstamped(client, db, promote):
    from models import method_services

    one, two = Instrument(name="HPLC 1290a"), Instrument(name="HPLC 1290b")
    db.add_all([one, two])
    db.flush()
    ws, item, plain = _promoted_and_plain(db, promote, instrument_id=one.id)
    method = HplcMethod(name="HPLC M2")
    svc = AnalysisService(title="BPC-157 purity", keyword="PUR_BPC157_AMI")
    db.add_all([method, svc])
    db.flush()
    db.execute(instrument_methods.insert().values(instrument_id=two.id, method_id=method.id))
    db.execute(method_services.insert().values(method_id=method.id, analysis_service_id=svc.id))
    rows = []
    for it in (item, plain):
        vial = db.query(LimsSubSample).filter_by(sample_id=it.sample_id).one()
        rows.append(LimsAnalysis(lims_sub_sample_pk=vial.id, analysis_service_id=svc.id, keyword=svc.keyword,
                                 title=svc.title, review_state="unassigned"))
    db.add_all(rows)
    db.commit()
    r = client.post(f"/worksheets/{ws.id}/apply-method-instrument",
                    json={"method_id": method.id, "instrument_id": two.id})
    assert r.status_code == 200 and r.json()["stamped"] == 1, r.text
    db.expire_all()
    assert [(db.get(LimsAnalysis, a.id).instrument_id, db.get(LimsAnalysis, a.id).method_id) for a in rows] == [
        (None, None), (two.id, method.id)]


def test_each_instrument_writer_fails_closed_when_mk1_db_is_down(db, promote, monkeypatch):
    # an HPLC row's promoted state cannot be read: 500, and nothing is written
    one, two = Instrument(name="HPLC 1290a"), Instrument(name="HPLC 1290b")
    db.add_all([one, two])
    db.flush()
    ws, item = _world(db, instrument_id=one.id)
    method = HplcMethod(name="HPLC M2")
    db.add(method)
    db.flush()
    db.execute(instrument_methods.insert().values(instrument_id=two.id, method_id=method.id))
    db.commit()

    def down(_ids):
        raise psycopg2.OperationalError("could not connect to server")

    monkeypatch.setattr(worksheets_hplc, "_preps_by_item", down)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1, email="qa@accumark.test")
    try:
        client = TestClient(app, raise_server_exceptions=False)
        for method_, url, body in (
                ("PATCH", f"/worksheets/{ws.id}/items/{item.id}", {"instrument_id": two.id}),
                ("POST", f"/worksheets/{ws.id}/bench-ticks", {"ran": True}),
                ("POST", f"/worksheets/{ws.id}/apply-method-instrument",
                 {"method_id": method.id, "instrument_id": two.id})):
            assert client.request(method_, url, json=body).status_code == 500, url
            db.expire_all()
            stored = db.get(WorksheetItem, item.id)
            assert (stored.instrument_id, stored.ran_at) == (one.id, None), url
    finally:
        app.dependency_overrides.clear()