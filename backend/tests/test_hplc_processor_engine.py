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
    BAC_STOCK_UG_ML,
    BENZYL_ALCOHOL_DENSITY,
    DILUENT_DENSITY_MG_ML,
    PREP_FORMS,
    IntermediateWeights,
    WeightInputs,
    bac_volume_ml,
    calculate_dilution_factor,
    calculate_intermediate,
    process_hplc_analysis,
    stock_volume_ml,
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


def test_a_stock_problem_nulls_the_stock_volume_and_keeps_the_audit_keys():
    # Task 4 narrowed this (Task 2's review, Minor 2): a stock-leg problem used to
    # null the dilution factor too, though the dilution vial's weighings were fine.
    ok = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY)
    bad = calculate_dilution_factor(
        replace(FORWARD_WEIGHTS, stock_vial_with_diluent=FORWARD_WEIGHTS.stock_vial_empty), DENSITY
    )
    assert set(bad) == set(ok)
    assert bad["stock_volume_ml"] is None
    assert bad["dilution_factor"] == ok["dilution_factor"]
    # The intermediate values stay, so a tech can see which weighing is wrong.
    assert bad["stock_mass_mg"] == 0.0
    assert bad["diluent_mass_mg"] == ok["diluent_mass_mg"]


def test_a_problem_gives_no_quantity_rather_than_a_crash():
    inp = _input_from(FORWARD_CASE)
    bad_weights = replace(inp.weights, stock_vial_with_diluent=inp.weights.stock_vial_empty)
    result = process_hplc_analysis(replace(inp, weights=bad_weights))
    assert result["quantity_mg"] is None
    # Task 4: a stock-only problem nulls the stock volume and keeps the factor.
    assert result["stock_volume_ml"] is None
    assert result["dilution_factor"] is not None
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
    # Task 4: an intermediate-only problem nulls the total alone. The final vial's
    # weighings are fine, so its factor and the stock volume are good numbers.
    plain = calculate_dilution_factor(FORWARD_WEIGHTS, 997.1)
    assert d["dilution_factor"] == plain["dilution_factor"]
    assert d["stock_volume_ml"] == plain["stock_volume_ml"]


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
    # Task 4: the total alone is null; the final vial's own factor is a good number.
    assert d["dilution_factor_total"] is None
    assert d["dilution_factor"] == calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY)["dilution_factor"]

    negative_diluent = replace(INT_WEIGHTS, int_vial_with_diluent=INT_WEIGHTS.int_vial_empty - 1)
    d = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY, intermediate=negative_diluent)
    assert d["problem"] == "intermediate_diluent"
    assert d["dilution_factor_total"] is None


def test_a_row_that_already_has_a_problem_keeps_its_code_and_a_total_only_if_its_legs_allow():
    # The stock-leg code is reported first (pinned above), and an intermediate,
    # complete or not, never displaces an existing problem. Task 4: the total is
    # None only when the final dilution leg or the intermediate is at fault, so a
    # stock-leg problem beside a complete intermediate keeps it.
    two_step_total = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY, intermediate=INT_WEIGHTS)[
        "dilution_factor_total"
    ]
    bad_stock_leg = replace(FORWARD_WEIGHTS, stock_vial_with_diluent=FORWARD_WEIGHTS.stock_vial_empty)
    bad_final_stock = replace(
        FORWARD_WEIGHTS, dil_vial_with_diluent_and_sample=FORWARD_WEIGHTS.dil_vial_with_diluent
    )
    unweighed = replace(INT_WEIGHTS, int_vial_with_diluent_and_sample=None)
    for weights, code in ((bad_stock_leg, "stock_diluent"), (bad_final_stock, "stock")):
        for intermediate in (INT_WEIGHTS, unweighed):
            d = calculate_dilution_factor(weights, DENSITY, intermediate=intermediate)
            assert d["problem"] == code
            if code == "stock_diluent" and intermediate is INT_WEIGHTS:
                assert d["dilution_factor_total"] == two_step_total
            else:
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


# ---- Task 4: the stock volume, per prep form --------------------------------
#
# The expected numbers for bac water come from Dennis's calc.js, run under node on
# the same masses and densities (bacVolumeMl, calc.js:262), not from this engine.
# Python and JS both evaluate (m / rw) / (1 - c / rba + c / rw) left to right in
# IEEE doubles, so the values are bit-identical and compared exactly.
BAC_FROM_BENCH_SHEET = {
    # (mass_mg, water_density): mL
    (29_913.0, 997.1): 29.990158110239037,
    (9_293.38, 997.1): 9.317351505316525,
    (1_000.0, 997.1): 1.0025794173181906,
    (5_000.5, 997.1): 5.013398376299612,
    (9_293.38, 500.0): 18.415459492618222,
    (29_913.0, 1100.0): 27.20768061672894,
}


def test_the_engine_understands_every_form_the_endo_bench_accepts():
    from worksheets_endo import ENDO_FORMS
    assert set(ENDO_FORMS) <= set(PREP_FORMS)


def test_the_constants_are_the_bench_sheets():
    assert PREP_FORMS == ("powder", "liquid", "bac")
    assert DILUENT_DENSITY_MG_ML == 997.1
    assert BENZYL_ALCOHOL_DENSITY == 1034.72
    assert BAC_STOCK_UG_ML == 9000.0


def test_powder_stock_volume_is_todays_formula():
    vol, problem = stock_volume_ml("powder", FORWARD_WEIGHTS, 997.1)
    assert problem is None
    assert vol == (FORWARD_WEIGHTS.stock_vial_with_diluent - FORWARD_WEIGHTS.stock_vial_empty) / 997.1


def test_stock_volume_tracks_the_density_it_is_given():
    # The golden master cannot cover this: all 66 prod curves are 997.1, so an
    # engine that hardcoded that constant would pass the test above and the pin.
    mass = FORWARD_WEIGHTS.stock_vial_with_diluent - FORWARD_WEIGHTS.stock_vial_empty
    assert stock_volume_ml("powder", FORWARD_WEIGHTS, 500.0)[0] == mass / 500.0
    assert (stock_volume_ml("powder", FORWARD_WEIGHTS, 500.0)[0]
            != stock_volume_ml("powder", FORWARD_WEIGHTS, 997.1)[0])


def test_liquid_stock_volume_is_the_declared_volume():
    vol, problem = stock_volume_ml("liquid", FORWARD_WEIGHTS, 997.1, declared_volume_ml=3.0)
    assert (vol, problem) == (3.0, None)


def test_liquid_without_a_declared_volume_says_why():
    assert stock_volume_ml("liquid", FORWARD_WEIGHTS, 997.1)[1] == "no_declared_volume"
    assert stock_volume_ml("liquid", FORWARD_WEIGHTS, 997.1, declared_volume_ml=0)[1] == "no_declared_volume"


@pytest.mark.parametrize("bad", [-3.0, math.nan, math.inf, -math.inf])
def test_liquid_refuses_an_unusable_declared_volume(bad):
    assert stock_volume_ml("liquid", FORWARD_WEIGHTS, 997.1, declared_volume_ml=bad) == (None, "no_declared_volume")


def test_bac_volume_is_density_corrected_for_benzyl_alcohol():
    # 30 mL of 0.9 % benzyl alcohol water weighs ~29.91 g. Benzyl alcohol (1034.72
    # mg/mL) is DENSER than the water (997.1), so the mixture is denser and a given
    # mass occupies slightly LESS volume than mass / 997.1: the correction is small
    # and downward (calc.js:262, 9293.38 mg gives 9.3174 mL against 9.3204).
    assert bac_volume_ml(29_913.0) == pytest.approx(30.0, abs=0.05)
    assert bac_volume_ml(29_913.0) < 29_913.0 / 997.1


@pytest.mark.parametrize("key", list(BAC_FROM_BENCH_SHEET), ids=str)
def test_bac_volume_matches_the_bench_sheet(key):
    mass, water_density = key
    assert bac_volume_ml(mass, water_density) == BAC_FROM_BENCH_SHEET[key]


def test_bac_volume_defaults_to_the_diluent_density():
    assert bac_volume_ml(9_293.38) == bac_volume_ml(9_293.38, 997.1)


def test_bac_rejects_a_non_positive_mass():
    assert bac_volume_ml(0) is None


@pytest.mark.parametrize(
    "mass, water_density, ba_density",
    [
        (-5.0, 997.1, 1034.72),
        (None, 997.1, 1034.72),
        (math.nan, 997.1, 1034.72),
        (math.inf, 997.1, 1034.72),
        (100.0, 0.0, 1034.72),
        (100.0, -1.0, 1034.72),
        (100.0, None, 1034.72),
        (100.0, math.nan, 1034.72),
        (100.0, 997.1, 0.0),
        (100.0, 997.1, -1.0),
        (100.0, 997.1, math.inf),
    ],
)
def test_bac_volume_is_none_for_input_it_cannot_use(mass, water_density, ba_density):
    # calc.js: null for no mass, a mass of 0 or less, or a diluent density of 0 or
    # less. The benzyl alcohol density is an argument here (calc.js reads it from
    # Lab rules and falls back to 1034.72), so a non-positive one is refused too.
    assert bac_volume_ml(mass, water_density, ba_density) is None


def test_bac_volume_refuses_a_stock_that_makes_the_correction_meaningless():
    # 1 - c/rba + c/rw <= 0 would divide by zero or flip the sign of the volume.
    assert bac_volume_ml(100.0, 997.1, ba_density=5.0) is None


def test_bac_stock_volume_is_the_corrected_volume_of_the_same_mass_powder_weighs():
    mass = FORWARD_WEIGHTS.stock_vial_with_diluent - FORWARD_WEIGHTS.stock_vial_empty
    vol, problem = stock_volume_ml("bac", FORWARD_WEIGHTS, 997.1)
    assert problem is None
    assert vol == bac_volume_ml(mass, 997.1)
    assert vol < stock_volume_ml("powder", FORWARD_WEIGHTS, 997.1)[0]  # denser mixture, less volume


def test_an_unknown_form_names_the_accepted_list():
    with pytest.raises(ValueError, match="powder"):
        stock_volume_ml("capsule", FORWARD_WEIGHTS, 997.1)


def test_an_unknown_form_is_refused_by_the_dilution_factor_too():
    with pytest.raises(ValueError, match="powder, liquid, bac"):
        calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY, form="capsule")


def test_a_null_diluent_density_says_why_instead_of_raising():
    assert stock_volume_ml("powder", FORWARD_WEIGHTS, None)[1] == "no_density"


def test_an_unweighed_stock_vial_is_flagged_for_powder_but_not_for_liquid():
    # A liquid row never weighs its stock vial, so its stock leg is zero on
    # every real row. Powder keeps Task 2's behaviour.
    w = replace(FORWARD_WEIGHTS, stock_vial_empty=0.0, stock_vial_with_diluent=0.0)
    assert stock_volume_ml("powder", w, 997.1)[1] == "stock_diluent"
    assert stock_volume_ml("bac", w, 997.1)[1] == "stock_diluent"
    assert stock_volume_ml("liquid", w, 997.1, declared_volume_ml=3.0) == (3.0, None)


def test_a_stock_only_problem_keeps_a_computable_dilution_factor():
    # The two prod rows behind Task 2's review Minor 2: dilution legs fine, stock
    # leg unentered. The factor is a real 1.0 and only the stock volume is unknown.
    w = replace(FORWARD_WEIGHTS, stock_vial_empty=0.0, stock_vial_with_diluent=0.0,
                dil_vial_with_diluent=FORWARD_WEIGHTS.dil_vial_empty)
    d = calculate_dilution_factor(w, 997.1)
    assert d["problem"] == "stock_diluent"
    assert d["stock_volume_ml"] is None
    assert d["dilution_factor"] is not None


def test_a_dilution_leg_problem_keeps_a_computable_stock_volume():
    w = replace(FORWARD_WEIGHTS, dil_vial_with_diluent=FORWARD_WEIGHTS.dil_vial_empty - 1)
    d = calculate_dilution_factor(w, 997.1)
    assert d["problem"] == "diluent"
    assert d["dilution_factor"] is None
    assert d["stock_volume_ml"] is not None


def test_calculate_dilution_factor_reaches_the_declared_volume_for_a_liquid_row():
    # The integration path: the whole point of scoping stock_diluent by form.
    w = replace(FORWARD_WEIGHTS, stock_vial_empty=0.0, stock_vial_with_diluent=0.0)
    d = calculate_dilution_factor(w, 997.1, form="liquid", declared_volume_ml=3.0)
    assert d["problem"] is None
    assert d["stock_volume_ml"] == 3.0
    assert d["dilution_factor"] is not None


# ---- Task 4: the per-form routing inside calculate_dilution_factor ------------

def test_the_default_form_is_powder_and_the_form_changes_only_the_stock_volume():
    default = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY)
    assert default == calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY, form="powder")
    liquid = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY, form="liquid", declared_volume_ml=3.0)
    bac = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY, form="bac")
    for other in (liquid, bac):
        assert other["stock_volume_ml"] != default["stock_volume_ml"]
        assert {k: v for k, v in other.items() if k != "stock_volume_ml"} == {
            k: v for k, v in default.items() if k != "stock_volume_ml"
        }


def test_the_stock_volume_keeps_its_six_place_rounding_for_every_form():
    mass = FORWARD_WEIGHTS.stock_vial_with_diluent - FORWARD_WEIGHTS.stock_vial_empty
    powder = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY)
    assert powder["stock_volume_ml"] == round(mass / DENSITY, 6)
    bac = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY, form="bac")
    assert bac["stock_volume_ml"] == round(bac_volume_ml(mass, DENSITY), 6)
    liquid = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY, form="liquid", declared_volume_ml=3.1234567891)
    assert liquid["stock_volume_ml"] == 3.123457


def test_a_liquid_row_never_reads_its_stock_vial():
    # Not even to flag a garbage value: the stock vial of a pre-dissolved sample is
    # never weighed (calc.js:204 guards the stock-leg problem with !preDissolved).
    w = replace(FORWARD_WEIGHTS, stock_vial_empty=math.nan, stock_vial_with_diluent=math.inf)
    d = calculate_dilution_factor(w, DENSITY, form="liquid", declared_volume_ml=3.0)
    assert d["problem"] is None
    assert d["stock_volume_ml"] == 3.0
    assert d["stock_mass_mg"] is None  # an audit number the engine cannot make; not NaN
    json.dumps(d, allow_nan=False)


def test_a_liquid_row_without_a_declared_volume_loses_only_the_stock_volume():
    d = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY, form="liquid")
    assert d["problem"] == "no_declared_volume"
    assert d["stock_volume_ml"] is None
    assert d["dilution_factor"] == calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY)["dilution_factor"]


def test_a_bac_row_with_an_unweighed_stock_vial_is_flagged():
    w = replace(FORWARD_WEIGHTS, stock_vial_empty=0.0, stock_vial_with_diluent=0.0)
    d = calculate_dilution_factor(w, DENSITY, form="bac")
    assert d["problem"] == "stock_diluent"
    assert d["stock_volume_ml"] is None


@pytest.mark.parametrize("bad", [None, 0.0, -997.1, math.nan, math.inf])
def test_an_unusable_density_is_a_problem_not_a_crash(bad):
    # The route passes cal.diluent_density straight through and the column is
    # nullable. calc.js reads a missing, zero or non-finite density as null.
    d = calculate_dilution_factor(FORWARD_WEIGHTS, bad)
    assert d["problem"] == "no_density"
    assert d["dilution_factor"] is None and d["dilution_factor_total"] is None
    assert d["stock_volume_ml"] is None
    json.dumps(d, allow_nan=False)
    # The masses need no density, so a tech still sees the weighings.
    assert d["stock_mass_mg"] == calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY)["stock_mass_mg"]


def test_a_liquid_row_keeps_its_declared_volume_when_only_the_density_is_missing():
    # calc.js stockPrep never uses the density for a pre-dissolved vial.
    d = calculate_dilution_factor(FORWARD_WEIGHTS, None, form="liquid", declared_volume_ml=3.0)
    assert d["problem"] == "no_density"
    assert d["stock_volume_ml"] == 3.0
    assert d["dilution_factor"] is None


def test_a_row_with_no_density_and_an_intermediate_does_not_crash():
    d = calculate_dilution_factor(FORWARD_WEIGHTS, None, intermediate=INT_WEIGHTS)
    assert d["problem"] == "no_density"
    assert d["dilution_factor_total"] is None


# ---- Task 4: what each problem nulls ------------------------------------------
#
# Three places a weighing can fail, and each nulls only what it touches:
#
#   stock leg           nulls stock_volume_ml                        keeps dilution_factor and the total
#   final dilution leg  nulls dilution_factor, so also the total     keeps stock_volume_ml
#   intermediate leg    nulls dilution_factor_total ALONE            keeps dilution_factor, stock_volume_ml
#
# and quantity_mg is None whenever the total or the stock volume is. `problem`
# keeps reporting the first code by precedence: stock leg, then final diluent,
# then final stock, then the intermediate.
STOCK_LEG_BAD = replace(FORWARD_WEIGHTS, stock_vial_with_diluent=FORWARD_WEIGHTS.stock_vial_empty)
FINAL_LEG_BAD = replace(FORWARD_WEIGHTS, dil_vial_with_diluent_and_sample=FORWARD_WEIGHTS.dil_vial_with_diluent)
INT_LEG_BAD = replace(INT_WEIGHTS, int_vial_with_diluent_and_sample=INT_WEIGHTS.int_vial_with_diluent)


def _two_step(weights=FORWARD_WEIGHTS, intermediate=INT_WEIGHTS):
    return calculate_dilution_factor(weights, DENSITY, intermediate=intermediate)


def test_a_stock_leg_problem_nulls_only_the_stock_volume():
    ok = _two_step()
    d = _two_step(weights=STOCK_LEG_BAD)
    assert d["problem"] == "stock_diluent"
    assert d["stock_volume_ml"] is None
    assert d["dilution_factor"] == ok["dilution_factor"]
    assert d["dilution_factor_total"] == ok["dilution_factor_total"]
    assert d["intermediate"] == ok["intermediate"]


def test_a_final_dilution_leg_problem_nulls_the_factor_and_the_total_and_keeps_the_stock_volume():
    ok = _two_step()
    d = _two_step(weights=FINAL_LEG_BAD)
    assert d["problem"] == "stock"
    assert d["dilution_factor"] is None and d["dilution_factor_total"] is None
    assert d["stock_volume_ml"] == ok["stock_volume_ml"]
    assert d["intermediate"] == ok["intermediate"]


def test_an_intermediate_problem_nulls_the_total_alone():
    ok = _two_step()
    d = _two_step(intermediate=INT_LEG_BAD)
    assert d["problem"] == "intermediate_stock"
    assert d["dilution_factor_total"] is None
    assert d["dilution_factor"] == ok["dilution_factor"]
    assert d["stock_volume_ml"] == ok["stock_volume_ml"]


def test_an_unweighed_intermediate_nulls_the_total_alone():
    ok = _two_step()
    d = _two_step(intermediate=replace(INT_WEIGHTS, int_vial_with_diluent=None))
    assert d["problem"] == "intermediate_unweighed"
    assert d["dilution_factor_total"] is None
    assert d["dilution_factor"] == ok["dilution_factor"]
    assert d["stock_volume_ml"] == ok["stock_volume_ml"]


# (stock leg bad, final leg bad, intermediate bad) -> what ends up None, and the code
COMBINATIONS = [
    # (stock, final, intermediate) bad | (stock_volume, factor, total) None | problem
    ((False, False, False), (False, False, False), None),
    ((True,  False, False), (True,  False, False), "stock_diluent"),
    ((False, True,  False), (False, True,  True),  "stock"),
    ((False, False, True),  (False, False, True),  "intermediate_stock"),
    ((True,  True,  False), (True,  True,  True),  "stock_diluent"),
    ((True,  False, True),  (True,  False, True),  "stock_diluent"),
    ((False, True,  True),  (False, True,  True),  "stock"),
    ((True,  True,  True),  (True,  True,  True),  "stock_diluent"),
]


def _combination_weights(base, stock_bad, final_bad):
    changes = {}
    if stock_bad:
        changes["stock_vial_with_diluent"] = base.stock_vial_empty
    if final_bad:
        changes["dil_vial_with_diluent_and_sample"] = base.dil_vial_with_diluent
    return replace(base, **changes)


@pytest.mark.parametrize("bad, none_values, code", COMBINATIONS, ids=[str(c[0]) for c in COMBINATIONS])
def test_every_combination_of_failing_legs_nulls_exactly_what_it_touches(bad, none_values, code):
    stock_bad, final_bad, int_bad = bad
    d = _two_step(
        weights=_combination_weights(FORWARD_WEIGHTS, stock_bad, final_bad),
        intermediate=INT_LEG_BAD if int_bad else INT_WEIGHTS,
    )
    assert d["problem"] == code
    assert (
        d["stock_volume_ml"] is None,
        d["dilution_factor"] is None,
        d["dilution_factor_total"] is None,
    ) == none_values
    # The invariant calculate_quantity relies on: it gates on "problem", and the
    # rule is "no quantity when the total or the stock volume is None".
    assert (d["problem"] is None) == (d["stock_volume_ml"] is not None and d["dilution_factor_total"] is not None)


@pytest.mark.parametrize("bad, none_values, code", COMBINATIONS[1:], ids=[str(c[0]) for c in COMBINATIONS[1:]])
def test_no_quantity_is_reported_whenever_the_total_or_the_stock_volume_is_none(bad, none_values, code):
    stock_bad, final_bad, int_bad = bad
    inp = _input_from(FORWARD_CASE)
    result = process_hplc_analysis(
        replace(
            inp,
            weights=_combination_weights(inp.weights, stock_bad, final_bad),
            intermediate=INT_LEG_BAD if int_bad else INT_WEIGHTS,
        )
    )
    assert result["quantity_mg"] is None
    assert result["calculation_trace"]["quantity"]["error"] == code
    # Purity and concentration do not depend on the weighings.
    assert result["purity_percent"] == FORWARD_CASE["expected"]["purity_percent"]
    assert result["concentration_ug_ml"] == FORWARD_CASE["expected"]["concentration_ug_ml"]


# ---- Task 4: the final vial refuses non-finite weighings ----------------------
#
# calc.js num() reads NaN and infinity as null. Without this the factor came out
# NaN or infinite with problem None, which "is not None" and so sailed into
# calculate_quantity (Task 3's review, Minor 1). Task 6 also rejects them at the
# request boundary; the engine is reachable from the worksheet path too.
FINAL_VIAL_FIELDS = [
    # field, the code of the leg it sits in, whether it belongs to the stock vial
    ("stock_vial_empty", "stock_diluent", True),
    ("stock_vial_with_diluent", "stock_diluent", True),
    ("dil_vial_empty", "diluent", False),
    ("dil_vial_with_diluent", "diluent", False),
    ("dil_vial_with_diluent_and_sample", "stock", False),
]


@pytest.mark.parametrize("field, code, is_stock_vial", FINAL_VIAL_FIELDS)
@pytest.mark.parametrize("bad", [math.nan, math.inf, -math.inf])
def test_a_non_finite_final_vial_weighing_is_a_problem_not_a_nan_value(field, code, is_stock_vial, bad):
    ok = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY)
    d = calculate_dilution_factor(replace(FORWARD_WEIGHTS, **{field: bad}), DENSITY)
    assert d["problem"] == code
    json.dumps(d, allow_nan=False)  # the stored trace must stay valid JSON
    # Each failure nulls only what it touches.
    if is_stock_vial:
        assert d["stock_volume_ml"] is None
        assert d["dilution_factor"] == ok["dilution_factor"]
    else:
        assert d["dilution_factor"] is None and d["dilution_factor_total"] is None
        assert d["stock_volume_ml"] == ok["stock_volume_ml"]
    for key, value in d.items():
        assert not isinstance(value, float) or math.isfinite(value), key


@pytest.mark.parametrize("field, code, is_stock_vial", FINAL_VIAL_FIELDS)
@pytest.mark.parametrize("bad", [math.nan, math.inf])
def test_a_non_finite_final_vial_weighing_gives_no_quantity(field, code, is_stock_vial, bad):
    inp = _input_from(FORWARD_CASE)
    result = process_hplc_analysis(replace(inp, weights=replace(inp.weights, **{field: bad})))
    assert result["quantity_mg"] is None
    assert result["calculation_trace"]["quantity"]["error"] == code
    json.dumps(result, allow_nan=False)


def test_a_non_finite_stock_vial_does_not_poison_a_bac_row():
    d = calculate_dilution_factor(
        replace(FORWARD_WEIGHTS, stock_vial_with_diluent=math.nan), DENSITY, form="bac"
    )
    assert d["problem"] == "stock_diluent" and d["stock_volume_ml"] is None
