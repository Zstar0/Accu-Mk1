"""Builds tests/fixtures/hplc_promote_reason_cases.json: worksheets_hplc_promote.promote_reasons
over a fixed set of rows, so the browser's copy of the sentences (src, promoteReasons) can be
pinned to the server's. tests/test_worksheets_hplc_promote.py rebuilds the cases in memory and
asserts they equal the file. Regenerate (from the worktree root):

    C:/tmp/hplc-build/venv/Scripts/python.exe backend/tests/fixtures/make_hplc_promote_reason_cases.py

Pure: no database is touched."""
import copy
import json
import pathlib
import sys

BACKEND = pathlib.Path(__file__).resolve().parents[2]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from catalog.method_run_params import hplc_run_params
from hplc_prep import compute_row
from worksheets_hplc_promote import promote_reasons

OUT = pathlib.Path(__file__).with_name("hplc_promote_reason_cases.json")
ABOUT = (
    "promote_reasons(row, computed, blend_cap) from backend/worksheets_hplc_promote.py over fixed rows. "
    "row is the row facts exactly as GET /worksheets/{id}/hplc serves them; computed is "
    "hplc_prep.compute_row(row's declared_mg, form, peptide_id, components; row.hplc_prep; no rules; "
    "row.params), or null when the row has a null form or no components and is never computed; "
    "reasons is the answer, in order. Not in this file, because the server decides them outside "
    "promote_reasons: the completed worksheet (promote_row), a single peptide that is a catalog blend "
    "(promote_row adds peptide_is_blend from the catalog, which the sheet does not serve), the curve "
    "density check (needs the calibration curves), and the backstop (no real compute_row output reaches "
    "it). Regenerate: C:/tmp/hplc-build/venv/Scripts/python.exe "
    "backend/tests/fixtures/make_hplc_promote_reason_cases.py"
)
PARAMS = hplc_run_params(None)
STOCK = {"stock_vial_mg": 5000.0, "stock_vial_diluent_mg": 7991.3}
VIAL = {"vial_mg": 2500.0, "vial_diluent_mg": 3906.0, "vial_all_mg": 3996.0}
TWO_STEP_VIAL = {"vial_mg": 2500.0, "vial_diluent_mg": 3936.0, "vial_all_mg": 3996.2,
                 "int_vial_mg": 2400.0, "int_vial_diluent_mg": 3858.0, "int_vial_all_mg": 3895.6}
BAC = {"stock_vial_diluent_mg": 8003.6, "stock_vial_mg": 5012.31,
       "vials": {"1": {"vial_mg": 2500.0, "vial_diluent_mg": 3914.0, "vial_all_mg": 3997.0}}}
CAPSULE = {"declared_mg": 2.5, "capsules": 4, "stock_vial_mg": 5000.0, "stock_vial_diluent_mg": 34913.0,
           "vials": {"1": {"vial_mg": 2500.0, "vial_all_mg": 3995.0}}}


def _component(pid, abbreviation, mg, vial=1, name=None):
    return {"peptide_id": pid, "name": name or abbreviation, "abbreviation": abbreviation,
            "declared_mg": mg, "vial": vial}


def row(**over):
    """A solo BPC-157 powder row with an instrument, every key the sheet route serves."""
    out = {
        "item_id": 1999990001, "sample_id": "P-0600-S01", "parent_sample_id": "P-0600",
        "order_number": "WP-5541", "identity": "BPC-157",
        "peptide_id": 10, "peptide_name": "BPC-157", "is_blend": False,
        "components": [_component(10, "BPC-157", 10.0)], "components_source": "analytes",
        "declared_mg": 10.0,
        "sample_form": {"id": 1, "name": "Lyophilized Powder", "hplc_prep": "powder"},
        "sample_bac": False, "form": "powder", "rider_only": False,
        "instrument_id": 2, "instrument_name": "HPLC 1290a", "params": PARAMS,
        "prep_form": None, "hplc_prep": {**STOCK, "vials": {"1": dict(VIAL)}},
        "promoted": False, "prep": None, "problems": [],
    }
    out.update(over)
    return copy.deepcopy(out)


def blend(components, **over):
    return row(peptide_id=3, peptide_name="BPC-157 + TB-500", identity="BPC-157, TB-500",
               is_blend=True, components=components, **over)


def _vials(*weighed):
    return {str(n): dict(v) for n, v in enumerate(weighed, 1)}


BPC_TB = [_component(10, "BPC-157", 5.0, 1), _component(11, "TB-500", 5.0, 2, "Thymosin Beta-4")]

# (name, row, blend_cap, expected count: 0 clean, 1 isolated, None many)
CASES = [
    ("clean powder", row(), 4, 0),
    ("clean powder two-step", row(hplc_prep={**STOCK, "declared_mg": 600.0, "vials": {"1": TWO_STEP_VIAL}}), 4, 0),
    ("clean liquid", row(form="liquid", prep_form="liquid",
                         hplc_prep={"declared_volume_ml": 3.0, "vials": {"1": dict(VIAL)}}), 4, 0),
    ("clean bac", row(form="bac", sample_bac=True, declared_mg=None, hplc_prep=BAC), 4, 0),
    ("clean capsule", row(form="capsule", prep_form="capsule", hplc_prep=CAPSULE), 4, 0),
    ("clean blend in two vials", blend(BPC_TB, hplc_prep={**STOCK, "vials": _vials(
        {"vial_mg": 2500.0, "vial_diluent_mg": 3800.0, "vial_all_mg": 3996.0},
        {"vial_mg": 2600.0, "vial_diluent_mg": 3900.0, "vial_all_mg": 4100.0})}), 4, 0),
    ("below the floor is never a reason", blend([_component(10, "BPC-157", 9.0), _component(11, "TB-500", 1.0)]), 4, 0),
    ("rider only", row(rider_only=True, form=None), 4, 1),
    ("no HPLC prep for the form", row(form=None, sample_form={"id": 4, "name": "Pen", "hplc_prep": None},
                                      problems=["no HPLC prep for this sample form"]), 4, 1),
    ("no catalog peptide", row(peptide_id=None, peptide_name=None, components=[], components_source=None,
                               problems=["the sample has no catalog peptide"]), 4, 1),
    ("an analyte with no catalog peptide", row(peptide_id=None, peptide_name=None, components=[],
                                               problems=["an analyte of the sample has no catalog peptide"]), 4, 1),
    ("a test ordered with no catalog peptide", row(peptide_id=None, peptide_name=None, components=[],
                                                   components_source="analyses",
                                                   problems=["a test ordered on the sample has no catalog peptide"]), 4, 1),
    ("blend not in the catalog", row(peptide_id=None, peptide_name=None, is_blend=True, components=[],
                                     problems=["this blend is not in the catalog"]), 4, 1),
    ("blend over the cap", blend([_component(10 + i, f"P{i}", 2.0) for i in range(5)]), 4, 1),
    ("no instrument", row(instrument_id=None, instrument_name=None), 4, 1),
    ("no declared weight", row(declared_mg=None, components=[_component(10, "BPC-157", None)]), 4, 1),
    ("a blend with its split typed and no total", blend(
        [_component(10, "BPC-157", None, 1), _component(11, "TB-500", None, 2)], declared_mg=None,
        hplc_prep={**STOCK, "components": {"10": {"mg": 5.0}, "11": {"mg": 5.0}}, "vials": _vials(
            {"vial_mg": 2500.0, "vial_diluent_mg": 3800.0, "vial_all_mg": 3996.0},
            {"vial_mg": 2600.0, "vial_diluent_mg": 3900.0, "vial_all_mg": 4100.0})}), 4, 1),
    ("declared weight of 0", row(hplc_prep={**STOCK, "declared_mg": 0, "vials": {"1": dict(VIAL)}}), 4, 1),
    ("capsule with no count", row(form="capsule", prep_form="capsule",
                                  hplc_prep={k: v for k, v in CAPSULE.items() if k != "capsules"}), 4, 1),
    ("capsule count over 1000", row(form="capsule", prep_form="capsule", hplc_prep={**CAPSULE, "capsules": 1001}), 4, 1),
    ("bac method figures", row(form="bac", sample_bac=True, declared_mg=None, hplc_prep=BAC,
                               params={**PARAMS, "bac_stock_ug_ml": 8000.0}), 4, 1),
    ("liquid with no volume", row(form="liquid", prep_form="liquid", hplc_prep={"vials": {"1": dict(VIAL)}}), 4, 1),
    ("stock vial not weighed", row(hplc_prep={"stock_vial_mg": 5000.0, "vials": {"1": dict(VIAL)}}), 4, 1),
    ("stock weighings backwards", row(hplc_prep={**STOCK, "stock_vial_diluent_mg": 4000.0,
                                                 "vials": {"1": dict(VIAL)}}), 4, 1),
    ("Step 3 weighing missing", row(hplc_prep={**STOCK, "vials": {"1": {"vial_mg": 2500.0, "vial_all_mg": 3995.0}}}), 4, 1),
    ("Step 3 diluent flagged", row(hplc_prep={**STOCK, "vials": {"1": {**VIAL, "vial_diluent_mg": 2400.0}}}), 4, 1),
    ("Step 3 stock flagged", row(hplc_prep={**STOCK, "vials": {"1": {**VIAL, "vial_all_mg": 3906.0}}}), 4, 1),
    ("Step 3a weighings missing", row(hplc_prep={**STOCK, "declared_mg": 600.0, "vials": {"1": {
        k: v for k, v in TWO_STEP_VIAL.items() if not k.startswith("int_")}}}), 4, 1),
    ("Step 3a stock flagged", row(hplc_prep={**STOCK, "declared_mg": 600.0, "vials": {"1": {
        **TWO_STEP_VIAL, "int_vial_all_mg": 3858.0}}}), 4, 1),
    ("a blend component with no weight", blend([_component(10, "BPC-157", None), _component(11, "TB-500", 5.0)]), 4, 1),
    ("everything missing at once", row(instrument_id=None, instrument_name=None, declared_mg=None,
                                       components=[_component(10, "BPC-157", None)],
                                       hplc_prep={"vials": {"1": {"vial_mg": 2500.0}}}), 4, None),
]


def _computed(r):
    if not (r["form"] and r["components"]):
        return None
    facts = {k: r[k] for k in ("declared_mg", "form", "peptide_id", "components")}
    return compute_row(facts, r["hplc_prep"], [], r["params"])


def build() -> dict:
    cases = []
    for name, r, cap, count in CASES:
        computed = _computed(r)
        reasons = promote_reasons(r, computed, cap)
        if count is not None and len(reasons) != count:
            raise AssertionError(f"case {name!r}: expected {count} reason(s), got {reasons}")
        if count is None and len(reasons) < 3:
            raise AssertionError(f"case {name!r}: expected several reasons, got {reasons}")
        cases.append({"name": name, "row": r, "computed": computed, "blend_cap": cap, "reasons": reasons})
    # through JSON, so the in-memory answer compares equal to the file
    return json.loads(json.dumps({"about": ABOUT, "cases": cases}, allow_nan=False))


if __name__ == "__main__":
    OUT.write_text(json.dumps(build(), indent=1, allow_nan=False) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {OUT}")
