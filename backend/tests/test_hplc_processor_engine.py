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
import math
from dataclasses import replace
from pathlib import Path

import pytest

from calculations.hplc_processor import (
    IntermediateWeights,
    WeightInputs,
    calculate_dilution_factor,
    calculate_intermediate,
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


# ---- Task 3: the intermediate step and the total dilution factor ----------------
#
# A two-step prep for a high-concentration sample: stock vial -> intermediate vial
# -> dilution vial. The bench plan is a 9000 ug/mL stock taken to 1500 ug/mL in
# 1500 uL, which is 250 uL of stock into 1250 uL of diluent. Weighed at the
# balance's 0.1 mg: the vial 2950.0 mg, then +1246.4 mg of diluent, then +249.0 mg
# of stock (a hair under plan, as a real pipetting is). Every leg is comfortably
# positive so the mutation checks below are not vacuous.
INT_WEIGHTS = IntermediateWeights(
    int_vial_empty=2950.0,
    int_vial_with_diluent=4196.4,
    int_vial_with_diluent_and_sample=4445.4,
)
STOCK_CONC = 9000.0

# What the bench sheet itself says for those weighings: calc.js dilutionActual run
# on the same three weighings, a 9000 ug/mL stock and density 997.1, then rounded
# to the engine's places. An oracle written by someone else, not this engine's output.
INT_FROM_BENCH_SHEET = {
    "diluent_vol_ul": 1250.0251,
    "stock_vol_ul": 249.7242,
    "total_vol_ul": 1499.7493,
    "actual_conc_ug_ml": 1498.5957,
    "dilution_factor": 6.005622,
    "problem": None,
}


def _unrounded_factor(empty, with_diluent, with_all):
    """total volume / stock volume, straight from three weighings, no rounding."""
    diluent_ul = (with_diluent - empty) / DENSITY * 1000
    stock_ul = (with_all - with_diluent) / DENSITY * 1000
    return (diluent_ul + stock_ul) / stock_ul


def test_no_intermediate_leaves_total_equal_to_the_single_factor():
    d = calculate_dilution_factor(FORWARD_WEIGHTS, 997.1)
    assert d["dilution_factor_total"] == d["dilution_factor"]
    assert d["intermediate"] is None


def test_total_is_the_product_of_the_two_legs():
    d = calculate_dilution_factor(FORWARD_WEIGHTS, 997.1, intermediate=INT_WEIGHTS)
    expected = round(d["intermediate"]["dilution_factor"] * d["dilution_factor"], 6)
    assert d["dilution_factor_total"] == expected
    assert d["problem"] is None


def test_total_multiplies_the_rounded_legs_not_the_raw_ones():
    # The rounding order is load-bearing: each leg is rounded to 6 places FIRST,
    # then multiplied (the order calculate_quantity's chain has always used).
    # Multiplying the raw legs lands on a different sixth decimal for these
    # weighings, which is what makes this a test and not a coincidence.
    w = FORWARD_WEIGHTS
    final_raw = _unrounded_factor(w.dil_vial_empty, w.dil_vial_with_diluent, w.dil_vial_with_diluent_and_sample)
    int_raw = _unrounded_factor(
        INT_WEIGHTS.int_vial_empty,
        INT_WEIGHTS.int_vial_with_diluent,
        INT_WEIGHTS.int_vial_with_diluent_and_sample,
    )
    rounded_legs = round(round(int_raw, 6) * round(final_raw, 6), 6)
    raw_legs = round(int_raw * final_raw, 6)
    assert rounded_legs != raw_legs  # the fixture really does discriminate
    d = calculate_dilution_factor(w, DENSITY, intermediate=INT_WEIGHTS)
    assert d["dilution_factor_total"] == rounded_legs


def test_the_intermediate_matches_the_bench_sheet():
    assert calculate_intermediate(INT_WEIGHTS, STOCK_CONC, DENSITY) == INT_FROM_BENCH_SHEET


def test_the_intermediate_factor_does_not_need_the_stock_concentration():
    # The engine is never told the stock concentration (it needs the declared mass),
    # so the factor must not depend on it; only the concentration display does.
    i = calculate_intermediate(INT_WEIGHTS, None, DENSITY)
    assert i["dilution_factor"] == INT_FROM_BENCH_SHEET["dilution_factor"]
    # Absent, not None: a stored null would read as "unknown for this row" when it
    # means "never asked for here". None is kept for "asked for, not determinable".
    assert "actual_conc_ug_ml" not in i
    unweighed = calculate_intermediate(replace(INT_WEIGHTS, int_vial_with_diluent_and_sample=None), STOCK_CONC, DENSITY)
    assert "actual_conc_ug_ml" in unweighed and unweighed["actual_conc_ug_ml"] is None


def test_intermediate_with_zero_added_stock_is_flagged():
    iw = replace(INT_WEIGHTS, int_vial_with_diluent_and_sample=INT_WEIGHTS.int_vial_with_diluent)
    i = calculate_intermediate(iw, 9000.0, 997.1)
    assert i["problem"] == "stock"
    assert i["dilution_factor"] is None
    # Dennis keeps the two leg volumes so a tech can see them, and works nothing out.
    assert i["diluent_vol_ul"] == INT_FROM_BENCH_SHEET["diluent_vol_ul"]
    assert i["total_vol_ul"] is None and i["actual_conc_ug_ml"] is None


def test_intermediate_with_negative_added_stock_is_flagged():
    iw = replace(INT_WEIGHTS, int_vial_with_diluent_and_sample=INT_WEIGHTS.int_vial_with_diluent - 1)
    assert calculate_intermediate(iw, STOCK_CONC, DENSITY)["problem"] == "stock"


def test_intermediate_with_negative_added_diluent_is_flagged():
    iw = replace(INT_WEIGHTS, int_vial_with_diluent=INT_WEIGHTS.int_vial_empty - 1)
    i = calculate_intermediate(iw, STOCK_CONC, DENSITY)
    assert i["problem"] == "diluent"
    assert i["dilution_factor"] is None


def test_when_both_intermediate_legs_are_bad_the_diluent_is_reported_first():
    # Both legs run backwards: 5000 -> 4000 -> 3000. calc.js reports "diluent", so
    # swapping the two branches would change which vial a tech is sent to check.
    both_bad = IntermediateWeights(5000.0, 4000.0, 3000.0)
    assert calculate_intermediate(both_bad, STOCK_CONC, DENSITY)["problem"] == "diluent"
    d = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY, intermediate=both_bad)
    assert d["problem"] == "intermediate_diluent"


def test_intermediate_with_zero_added_diluent_is_legal():
    # Same asymmetry as the final vial: zero diluent is a neat transfer (factor 1),
    # zero stock is not a dilution at all.
    iw = replace(
        INT_WEIGHTS,
        int_vial_with_diluent=INT_WEIGHTS.int_vial_empty,
        int_vial_with_diluent_and_sample=INT_WEIGHTS.int_vial_empty + 249.0,
    )
    i = calculate_intermediate(iw, STOCK_CONC, DENSITY)
    assert i["problem"] is None
    assert i["dilution_factor"] == 1.0
    assert i["actual_conc_ug_ml"] == STOCK_CONC


@pytest.mark.parametrize(
    "field",
    ["int_vial_empty", "int_vial_with_diluent", "int_vial_with_diluent_and_sample"],
)
def test_declared_intermediate_with_missing_weighings_does_not_compute(field):
    iw = replace(INT_WEIGHTS, **{field: None})
    d = calculate_dilution_factor(FORWARD_WEIGHTS, 997.1, intermediate=iw)
    assert d["dilution_factor_total"] is None
    assert d["problem"] == "intermediate_unweighed"
    # No fallback to a planned number: nothing the engine returns is a stand-in
    # for the weighing that was not made.
    assert d["intermediate"]["dilution_factor"] is None
    assert "actual_conc_ug_ml" not in d["intermediate"]
    # A row with a problem has neither derived value, same as every other problem.
    assert d["dilution_factor"] is None and d["stock_volume_ml"] is None


@pytest.mark.parametrize(
    "field",
    ["int_vial_empty", "int_vial_with_diluent", "int_vial_with_diluent_and_sample"],
)
@pytest.mark.parametrize("bad", [math.nan, math.inf, -math.inf])
def test_a_non_finite_intermediate_weighing_is_unweighed_not_a_nan_total(field, bad):
    # calc.js num() reads NaN and infinity as null, so the sheet calls the vial
    # unweighed. Without the check the total came out NaN, which "is not None" and
    # so sailed past the problem gate.
    iw = replace(INT_WEIGHTS, **{field: bad})
    d = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY, intermediate=iw)
    assert d["problem"] == "intermediate_unweighed"
    assert d["dilution_factor_total"] is None
    json.dumps(d, allow_nan=False)  # the stored trace must stay valid JSON


@pytest.mark.parametrize("bad", [math.nan, math.inf, 0.0, None])
def test_an_unusable_density_leaves_the_intermediate_unweighed(bad):
    i = calculate_intermediate(INT_WEIGHTS, STOCK_CONC, bad)
    assert i["problem"] is None and i["dilution_factor"] is None


@pytest.mark.parametrize("bad", [math.nan, math.inf])
def test_a_non_finite_stock_concentration_is_treated_as_not_supplied(bad):
    i = calculate_intermediate(INT_WEIGHTS, bad, DENSITY)
    assert i["dilution_factor"] == INT_FROM_BENCH_SHEET["dilution_factor"]
    assert "actual_conc_ug_ml" not in i


def test_declared_intermediate_with_nothing_weighed_does_not_compute():
    d = calculate_dilution_factor(
        FORWARD_WEIGHTS, DENSITY, intermediate=IntermediateWeights(None, None, None)
    )
    assert d["dilution_factor_total"] is None
    assert d["problem"] == "intermediate_unweighed"


def test_a_bad_intermediate_leg_flags_the_row_and_names_the_intermediate():
    # The bare "stock" and "diluent" codes already mean the final dilution vial, so
    # a tech reading one must not be sent to the wrong vial.
    zero_stock = replace(INT_WEIGHTS, int_vial_with_diluent_and_sample=INT_WEIGHTS.int_vial_with_diluent)
    d = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY, intermediate=zero_stock)
    assert d["problem"] == "intermediate_stock"
    assert d["dilution_factor_total"] is None and d["dilution_factor"] is None

    negative_diluent = replace(INT_WEIGHTS, int_vial_with_diluent=INT_WEIGHTS.int_vial_empty - 1)
    d = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY, intermediate=negative_diluent)
    assert d["problem"] == "intermediate_diluent"
    assert d["dilution_factor_total"] is None


def test_a_row_that_already_has_a_problem_has_no_total_and_keeps_its_code():
    # The stock-leg code is reported first (pinned above), and an intermediate,
    # complete or not, never displaces an existing problem.
    bad_stock_leg = replace(FORWARD_WEIGHTS, stock_vial_with_diluent=FORWARD_WEIGHTS.stock_vial_empty)
    bad_final_stock = replace(
        FORWARD_WEIGHTS, dil_vial_with_diluent_and_sample=FORWARD_WEIGHTS.dil_vial_with_diluent
    )
    unweighed = replace(INT_WEIGHTS, int_vial_with_diluent_and_sample=None)
    for weights, code in ((bad_stock_leg, "stock_diluent"), (bad_final_stock, "stock")):
        for intermediate in (INT_WEIGHTS, unweighed):
            d = calculate_dilution_factor(weights, DENSITY, intermediate=intermediate)
            assert d["problem"] == code
            assert d["dilution_factor_total"] is None
            # the audit values stay, so a tech can see which weighing is wrong
            assert d["intermediate"] is not None


def test_a_complete_intermediate_leaves_the_final_leg_values_untouched():
    plain = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY)
    two_step = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY, intermediate=INT_WEIGHTS)
    assert set(two_step) == set(plain)
    assert {k: v for k, v in two_step.items() if k not in ("dilution_factor_total", "intermediate")} == {
        k: v for k, v in plain.items() if k not in ("dilution_factor_total", "intermediate")
    }


def test_the_pipeline_carries_the_intermediate_into_the_trace():
    inp = _input_from(FORWARD_CASE)
    one_step = process_hplc_analysis(inp)
    assert one_step["calculation_trace"]["dilution"]["intermediate"] is None
    two_step = process_hplc_analysis(replace(inp, intermediate=INT_WEIGHTS))
    trace = two_step["calculation_trace"]["dilution"]
    assert trace["intermediate"]["dilution_factor"] == INT_FROM_BENCH_SHEET["dilution_factor"]
    assert trace["dilution_factor_total"] is not None


def test_a_declared_but_unweighed_intermediate_gives_no_quantity():
    inp = _input_from(FORWARD_CASE)
    result = process_hplc_analysis(
        replace(inp, intermediate=IntermediateWeights(2950.0, None, None))
    )
    assert result["quantity_mg"] is None
    assert result["calculation_trace"]["quantity"]["error"] == "intermediate_unweighed"
    # Purity and concentration do not depend on the weighings.
    assert result["purity_percent"] == FORWARD_CASE["expected"]["purity_percent"]
