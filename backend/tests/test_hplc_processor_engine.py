"""Role checks on the HPLC engine's weighings (plan
docs/superpowers/plans/2026-10-31-hplc-results-engine.md, Task 2).

Each check is by ROLE (which weighing is which), never by time order. The
thresholds are Dennis Nguyen's (calc.js stockPrep and dilutionActual), including
the asymmetry: zero added diluent is a legal neat injection, zero added stock is
not, and a zero stock-vial leg is not.

What the stock-leg test catches in prod data is a stock vial weighing that was
never entered (leg exactly 0.0), not a weighing performed in reverse; the
strictly negative branch has no real row and is covered by the handwritten
cases below only.
"""
import json
from dataclasses import replace
from pathlib import Path

from calculations.hplc_processor import (
    WeightInputs,
    calculate_dilution_factor,
    process_hplc_analysis,
)
from scripts.capture_hplc_golden import input_from_case as _input_from

GOLDEN = json.loads(
    (Path(__file__).parent / "fixtures" / "hplc_engine_golden.json").read_text(encoding="utf-8")
)
DENSITY = 997.1


def _legs(weights):
    return (
        weights["stock_vial_with_diluent"] - weights["stock_vial_empty"],
        weights["dil_vial_with_diluent"] - weights["dil_vial_empty"],
        weights["dil_vial_with_diluent_and_sample"] - weights["dil_vial_with_diluent"],
    )


def _forward_case():
    """A real prod row whose three legs are all comfortably positive.

    Not "any case": the fixture's flagged rows carry degenerate weights (some
    are all 1.0), which would make every mutation below vacuous. Selected by
    property, not by id, because the opaque ids renumber on any recapture.
    """
    flagged = set(GOLDEN["flagged"])
    for case in GOLDEN["cases"]:
        if case["id"] not in flagged and all(leg > 1.0 for leg in _legs(case["weights"])):
            return case
    raise AssertionError("no unflagged fixture case has three legs above 1.0 mg")


FORWARD_CASE = _forward_case()
FORWARD_WEIGHTS = WeightInputs(**FORWARD_CASE["weights"])


def test_forward_weighings_have_no_problem():
    d = calculate_dilution_factor(FORWARD_WEIGHTS, 997.1)
    assert d["problem"] is None
    assert d["dilution_factor"] > 0 and d["stock_volume_ml"] > 0


def test_stock_vial_lighter_than_empty_is_flagged():
    w = replace(FORWARD_WEIGHTS, stock_vial_with_diluent=FORWARD_WEIGHTS.stock_vial_empty - 5)
    d = calculate_dilution_factor(w, 997.1)
    assert d["problem"] == "stock_diluent"
    assert d["stock_volume_ml"] is None


def test_stock_vial_never_weighed_is_flagged():
    # The shape prod actually produces: stock leg exactly 0.0, not negative.
    w = replace(FORWARD_WEIGHTS, stock_vial_with_diluent=FORWARD_WEIGHTS.stock_vial_empty)
    d = calculate_dilution_factor(w, 997.1)
    assert d["problem"] == "stock_diluent"
    assert d["stock_volume_ml"] is None


def test_negative_added_diluent_is_flagged():
    w = replace(FORWARD_WEIGHTS, dil_vial_with_diluent=FORWARD_WEIGHTS.dil_vial_empty - 1)
    assert calculate_dilution_factor(w, 997.1)["problem"] == "diluent"


def test_zero_added_diluent_is_legal():
    w = replace(FORWARD_WEIGHTS, dil_vial_with_diluent=FORWARD_WEIGHTS.dil_vial_empty)
    d = calculate_dilution_factor(w, 997.1)
    assert d["problem"] is None
    assert d["dilution_factor"] is not None  # a neat injection has a real factor


def test_zero_added_stock_is_flagged():
    w = replace(FORWARD_WEIGHTS, dil_vial_with_diluent_and_sample=FORWARD_WEIGHTS.dil_vial_with_diluent)
    d = calculate_dilution_factor(w, 997.1)
    assert d["problem"] == "stock"
    assert d["dilution_factor"] is None


def test_negative_added_stock_is_flagged():
    w = replace(
        FORWARD_WEIGHTS,
        dil_vial_with_diluent_and_sample=FORWARD_WEIGHTS.dil_vial_with_diluent - 1,
    )
    assert calculate_dilution_factor(w, 997.1)["problem"] == "stock"


def test_when_several_problems_apply_the_stock_leg_is_reported_first():
    # Three of the five flagged prod rows have all three legs at 0.0, so both
    # "stock_diluent" and "stock" apply; swapping the operands of the precedence
    # would change which code those rows report.
    all_zero_legs = WeightInputs(1.0, 1.0, 1.0, 1.0, 1.0)
    assert calculate_dilution_factor(all_zero_legs, DENSITY)["problem"] == "stock_diluent"
    # With the stock leg fine, a negative added diluent outranks a zero added stock.
    empty = FORWARD_WEIGHTS.dil_vial_empty
    diluent_then_stock = replace(
        FORWARD_WEIGHTS, dil_vial_with_diluent=empty - 1, dil_vial_with_diluent_and_sample=empty - 1
    )
    assert calculate_dilution_factor(diluent_then_stock, DENSITY)["problem"] == "diluent"


def test_a_problem_nulls_both_derived_values_and_keeps_the_audit_keys():
    ok = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY)
    bad = calculate_dilution_factor(
        replace(FORWARD_WEIGHTS, stock_vial_with_diluent=FORWARD_WEIGHTS.stock_vial_empty), DENSITY
    )
    assert set(bad) == set(ok)
    assert bad["dilution_factor"] is None and bad["stock_volume_ml"] is None
    # The intermediate values stay, so a tech can see which weighing is wrong.
    assert bad["stock_mass_mg"] == 0.0
    assert bad["diluent_mass_mg"] == ok["diluent_mass_mg"]


def test_a_problem_gives_no_quantity_rather_than_a_crash():
    inp = _input_from(FORWARD_CASE)
    bad_weights = replace(inp.weights, stock_vial_with_diluent=inp.weights.stock_vial_empty)
    result = process_hplc_analysis(replace(inp, weights=bad_weights))
    assert result["quantity_mg"] is None
    assert result["dilution_factor"] is None and result["stock_volume_ml"] is None
    assert result["calculation_trace"]["dilution"]["problem"] == "stock_diluent"
    # Purity and concentration do not depend on the weighings.
    assert result["purity_percent"] == FORWARD_CASE["expected"]["purity_percent"]
    assert result["concentration_ug_ml"] == FORWARD_CASE["expected"]["concentration_ug_ml"]


def test_a_problem_keeps_the_quantity_trace_inputs_and_drops_only_the_weighing_values():
    # The capture script and the trace UI read the areas, the calibration and the
    # concentration out of trace["quantity"], so a problem must not collapse it.
    inp = _input_from(FORWARD_CASE)
    ok = process_hplc_analysis(inp)["calculation_trace"]["quantity"]
    bad_weights = replace(inp.weights, stock_vial_with_diluent=inp.weights.stock_vial_empty)
    bad = process_hplc_analysis(replace(inp, weights=bad_weights))["calculation_trace"]["quantity"]
    assert set(bad) == {
        "quantity_mg", "error", "individual_areas", "avg_main_peak_area",
        "concentration_ug_ml", "calibration_slope", "calibration_intercept",
    }
    assert bad["quantity_mg"] is None and bad["error"] == "stock_diluent"
    for key in ("individual_areas", "avg_main_peak_area", "concentration_ug_ml",
                "calibration_slope", "calibration_intercept"):
        assert bad[key] == ok[key]
    # Everything that needs a dilution factor or a stock volume is gone.
    assert set(ok) - set(bad) == {
        "undiluted_concentration_ug_ml", "mass_ug", "stock_volume_ml", "dilution_factor",
    }
