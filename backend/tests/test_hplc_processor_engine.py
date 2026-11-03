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
    QUANTITY_MG_PLACES,
    SUBMITTED_MG_PLACES,
    CalibrationParams,
    IntermediateWeights,
    WeightInputs,
    bac_volume_ml,
    calculate_dilution_factor,
    calculate_intermediate,
    calculate_quantity,
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


def test_a_problem_keeps_the_quantity_trace_inputs_and_drops_only_the_derived_echoes():
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
        "dilution_factor_steps",
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


@pytest.mark.parametrize("bad", [math.nan, math.inf, 0.0, None, -DENSITY, -math.inf])
def test_an_unusable_density_leaves_the_intermediate_unweighed(bad):
    # One predicate for the whole engine: missing, not finite, zero or negative. A
    # negative density used to give negative intermediate volumes and the bench code
    # "diluent" while the final vial called the same input "no_density".
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

def test_the_default_form_is_powder_and_the_forms_differ_only_in_the_stock_leg():
    default = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY)
    assert default == calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY, form="powder")
    liquid = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY, form="liquid", declared_volume_ml=3.0)
    bac = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY, form="bac")
    for other in (liquid, bac):
        assert other["stock_volume_ml"] != default["stock_volume_ml"]
    # "form" is each row's own label of which form produced it, not a difference in
    # outcome, so it is excluded from the comparisons below and asserted per row after them.
    # Only the stock volume differs for bac; a liquid row also has no stock vial mass.
    assert {k: v for k, v in bac.items() if k not in ("stock_volume_ml", "form")} == {
        k: v for k, v in default.items() if k not in ("stock_volume_ml", "form")
    }
    assert liquid["stock_mass_mg"] is None
    assert {k: v for k, v in liquid.items() if k not in ("stock_volume_ml", "stock_mass_mg", "form")} == {
        k: v for k, v in default.items() if k not in ("stock_volume_ml", "stock_mass_mg", "form")
    }
    assert (default["form"], bac["form"], liquid["form"]) == ("powder", "bac", "liquid")


def test_the_stored_trace_names_the_form_that_produced_the_row_problem_or_not():
    inp = _input_from(FORWARD_CASE)
    for form, declared in (("powder", None), ("bac", None), ("liquid", 3.0), ("liquid", None)):
        trace = process_hplc_analysis(replace(inp, form=form, declared_volume_ml=declared))["calculation_trace"]
        assert trace["dilution"]["form"] == form
    # the last row is a liquid with no declared volume: a problem row still says which form it is
    assert trace["dilution"]["problem"] == "no_declared_volume"


def test_the_stock_volume_keeps_its_six_place_rounding_for_every_form():
    mass = FORWARD_WEIGHTS.stock_vial_with_diluent - FORWARD_WEIGHTS.stock_vial_empty
    powder = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY)
    assert powder["stock_volume_ml"] == round(mass / DENSITY, 6)
    bac = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY, form="bac")
    assert bac["stock_volume_ml"] == round(bac_volume_ml(mass, DENSITY), 6)
    liquid = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY, form="liquid", declared_volume_ml=3.1234567891)
    assert liquid["stock_volume_ml"] == 3.123457


@pytest.mark.parametrize(
    "stock_empty, stock_full",
    [(math.nan, math.inf), (None, None), (0.0, 0.0)],
    ids=["garbage", "absent", "zero"],
)
def test_a_liquid_row_never_reads_its_stock_vial(stock_empty, stock_full):
    # Not even to flag a garbage value: the stock vial of a pre-dissolved sample is
    # never weighed (calc.js:204 guards the stock-leg problem with !preDissolved), so
    # a caller with nothing to weigh may pass None as well as zero. Reading None
    # raised a TypeError before the stock volume was reached.
    w = replace(FORWARD_WEIGHTS, stock_vial_empty=stock_empty, stock_vial_with_diluent=stock_full)
    d = calculate_dilution_factor(w, DENSITY, form="liquid", declared_volume_ml=3.0)
    assert d["problem"] is None
    assert d["stock_volume_ml"] == 3.0
    assert d["stock_mass_mg"] is None  # never weighed, so no audit mass
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


INT_DILUENT_BAD = replace(INT_WEIGHTS, int_vial_with_diluent=INT_WEIGHTS.int_vial_empty - 1)
INT_UNWEIGHED = replace(INT_WEIGHTS, int_vial_with_diluent=None)


@pytest.mark.parametrize(
    "bad_intermediate, code",
    [
        (INT_LEG_BAD, "intermediate_stock"),
        (INT_DILUENT_BAD, "intermediate_diluent"),
        (INT_UNWEIGHED, "intermediate_unweighed"),
    ],
    ids=["intermediate_stock", "intermediate_diluent", "intermediate_unweighed"],
)
def test_an_intermediate_problem_nulls_the_total_alone(bad_intermediate, code):
    ok = _two_step()
    d = _two_step(intermediate=bad_intermediate)
    assert d["problem"] == code
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
    # The invariant behind calculate_quantity's gate: "problem" is None exactly when the
    # total and the stock volume are both set. The gate also checks the values themselves
    # (Task 5), so on a dict that calculate_dilution_factor built the two never disagree.
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
@pytest.mark.parametrize("bad", [math.nan, math.inf, -math.inf, None], ids=["nan", "inf", "-inf", "none"])
def test_a_missing_or_non_finite_final_vial_weighing_is_a_problem_not_a_crash(field, code, is_stock_vial, bad):
    # None is how a blank weighing arrives (Task 6): it was a TypeError at the subtraction.
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
@pytest.mark.parametrize("bad", [math.nan, math.inf, None], ids=["nan", "inf", "none"])
def test_a_missing_or_non_finite_final_vial_weighing_gives_no_quantity(field, code, is_stock_vial, bad):
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


# ---- Task 4: nothing non-finite comes OUT either ------------------------------
#
# The inputs are checked above; a usable density can still overflow the arithmetic.
# 1e-310 is positive and finite, but every volume divided by it is infinite and the
# dilution factor (inf / inf) NaN. The density arrives from the nullable
# calibration_curves.diluent_density column, not the request body, so Task 6's
# request-boundary checks do not cover it.
def _assert_nothing_non_finite(d):
    json.dumps(d, allow_nan=False)  # the stored trace must stay valid JSON


def test_a_density_that_overflows_every_volume_is_a_problem_not_a_nan_factor():
    d = calculate_dilution_factor(FORWARD_WEIGHTS, 1e-310)
    assert d["problem"] == "stock_diluent"
    assert d["stock_volume_ml"] is None
    assert d["dilution_factor"] is None and d["dilution_factor_total"] is None
    _assert_nothing_non_finite(d)


def test_a_density_that_overflows_a_volume_is_never_a_quantity():
    inp = _input_from(FORWARD_CASE)
    result = process_hplc_analysis(replace(inp, peptide=replace(inp.peptide, diluent_density=1e-310)))
    assert result["quantity_mg"] is None
    assert result["dilution_factor"] is None and result["stock_volume_ml"] is None
    assert result["calculation_trace"]["quantity"]["error"] == "stock_diluent"
    json.dumps(result, allow_nan=False)


def test_a_density_that_overflows_the_intermediate_does_not_leak_nan_into_it():
    d = calculate_dilution_factor(FORWARD_WEIGHTS, 1e-310, intermediate=INT_WEIGHTS)
    assert d["intermediate"]["dilution_factor"] is None
    assert d["dilution_factor_total"] is None
    _assert_nothing_non_finite(d)


def test_an_overflowing_stock_volume_nulls_only_the_stock_volume():
    # A stock leg of 1e300 mg at density 1e-10 is 1e310 mL, which does not exist; the
    # dilution vial (about 1e16 uL) is fine, so only the stock leg is at fault.
    w = replace(FORWARD_WEIGHTS, stock_vial_empty=0.0, stock_vial_with_diluent=1e300)
    d = calculate_dilution_factor(w, 1e-10)
    assert d["problem"] == "stock_diluent"
    assert d["stock_volume_ml"] is None
    assert d["dilution_factor"] is not None and math.isfinite(d["dilution_factor"])
    _assert_nothing_non_finite(d)


def test_an_overflowing_bac_stock_volume_is_the_stock_legs_problem():
    w = replace(FORWARD_WEIGHTS, stock_vial_empty=0.0, stock_vial_with_diluent=1e300)
    d = calculate_dilution_factor(w, 1e-10, form="bac")
    assert d["problem"] == "stock_diluent" and d["stock_volume_ml"] is None
    _assert_nothing_non_finite(d)


def test_a_total_volume_that_overflows_is_the_dilution_vials_problem():
    # Each leg is a finite volume (about 1.0e308 and 8.0e307 uL) but their sum is not.
    w = replace(
        FORWARD_WEIGHTS,
        dil_vial_empty=-1.0e308,
        dil_vial_with_diluent=0.0,
        dil_vial_with_diluent_and_sample=0.8e308,
    )
    d = calculate_dilution_factor(w, DENSITY)
    assert d["problem"] == "stock"
    assert d["dilution_factor"] is None and d["dilution_factor_total"] is None
    assert d["total_vol_ul"] is None
    assert d["stock_volume_ml"] == calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY)["stock_volume_ml"]
    _assert_nothing_non_finite(d)


def test_an_overflowing_diluent_volume_is_the_diluent_legs_problem():
    w = replace(FORWARD_WEIGHTS, dil_vial_empty=0.0, dil_vial_with_diluent=1.7e308,
                dil_vial_with_diluent_and_sample=1.7e308 + 1e300)
    d = calculate_dilution_factor(w, 1e-5)
    assert d["problem"] == "diluent"
    assert d["dilution_factor"] is None
    _assert_nothing_non_finite(d)


def test_an_overflowing_intermediate_is_unweighed_not_a_nan_total():
    # Same rule as a non-finite intermediate weighing: calc.js round() reads a
    # non-finite number as null, so the vial reads as unweighed.
    i = calculate_intermediate(INT_WEIGHTS, STOCK_CONC, 1e-310)
    assert i["problem"] is None and i["dilution_factor"] is None
    assert i["diluent_vol_ul"] is None and i["stock_vol_ul"] is None
    assert i["actual_conc_ug_ml"] is None
    json.dumps(i, allow_nan=False)


def test_an_intermediate_factor_that_overflows_is_unweighed_not_infinite():
    # Both volumes are finite (about 1e308 uL of diluent and 1e-320 uL of stock) but
    # their ratio is not.
    tiny_stock = IntermediateWeights(int_vial_empty=-1e308, int_vial_with_diluent=0.0,
                                     int_vial_with_diluent_and_sample=1e-320)
    i = calculate_intermediate(tiny_stock, STOCK_CONC, DENSITY)
    assert i["problem"] is None
    assert i["dilution_factor"] is None and i["total_vol_ul"] is None
    assert i["actual_conc_ug_ml"] is None
    json.dumps(i, allow_nan=False)
    d = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY, intermediate=tiny_stock)
    assert d["problem"] == "intermediate_unweighed" and d["dilution_factor_total"] is None
    json.dumps(d, allow_nan=False)


@pytest.mark.parametrize("form", ["powder", "bac"])
@pytest.mark.parametrize("field", ["stock_vial_empty", "stock_vial_with_diluent"])
def test_a_weighed_form_with_a_blank_stock_weighing_says_stock_diluent(form, field):
    # powder and bac genuinely need the stock vial; a blank (None) one is "missing",
    # which is what the stock_diluent sentence already tells a tech. A liquid row, whose
    # stock vial is never weighed, is the contrast and is covered above.
    w = replace(FORWARD_WEIGHTS, **{field: None})
    assert stock_volume_ml(form, w, DENSITY) == (None, "stock_diluent")
    d = calculate_dilution_factor(w, DENSITY, form=form)
    assert d["problem"] == "stock_diluent"
    assert d["stock_volume_ml"] is None and d["stock_mass_mg"] is None
    # The dilution vial is fine, so its factor survives, as for any stock-leg problem.
    assert d["dilution_factor"] == calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY)["dilution_factor"]
    json.dumps(d, allow_nan=False)


def test_a_blank_stock_weighing_does_not_make_a_liquid_row_a_problem():
    w = replace(FORWARD_WEIGHTS, stock_vial_empty=None, stock_vial_with_diluent=None)
    assert stock_volume_ml("liquid", w, DENSITY, declared_volume_ml=3.0) == (3.0, None)


# ---- Task 4: the total itself must be a number --------------------------------
#
# Each step's factor can be finite and their product not. A huge tare keeps the
# diluent volume enormous and a sample leg a hair above zero (a tech entering nearly
# the same value twice) keeps the factor enormous: about 4.4e305 per vial here, so
# the total would be inf with problem None, and the stored trace would not survive
# strict JSON.
_HUGE_FACTOR_FINAL = replace(
    FORWARD_WEIGHTS,
    dil_vial_empty=-1e290, dil_vial_with_diluent=0.0, dil_vial_with_diluent_and_sample=2.3e-16,
)
_HUGE_FACTOR_INTERMEDIATE = IntermediateWeights(
    int_vial_empty=-1e290, int_vial_with_diluent=0.0, int_vial_with_diluent_and_sample=2.3e-16
)


def test_a_total_that_overflows_from_two_finite_steps_is_a_problem_not_infinity():
    d = calculate_dilution_factor(_HUGE_FACTOR_FINAL, DENSITY, intermediate=_HUGE_FACTOR_INTERMEDIATE)
    # The premise: both steps really are finite and their product really is not.
    assert math.isfinite(d["dilution_factor"]) and math.isfinite(d["intermediate"]["dilution_factor"])
    assert math.isinf(d["dilution_factor"] * d["intermediate"]["dilution_factor"])
    # The intermediate row of the table: the total alone is null, the good numbers stay.
    assert d["problem"] == "intermediate_stock"
    assert d["dilution_factor_total"] is None
    assert d["stock_volume_ml"] == calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY)["stock_volume_ml"]
    json.dumps(d, allow_nan=False)


def test_a_total_that_overflows_gives_no_quantity():
    inp = _input_from(FORWARD_CASE)
    result = process_hplc_analysis(
        replace(inp, weights=_HUGE_FACTOR_FINAL, intermediate=_HUGE_FACTOR_INTERMEDIATE)
    )
    assert result["quantity_mg"] is None
    assert result["calculation_trace"]["quantity"]["error"] == "intermediate_stock"
    json.dumps(result, allow_nan=False)


def test_a_huge_but_finite_total_is_not_mistaken_for_an_overflow():
    # One huge step beside an ordinary one multiplies to a finite total: no problem.
    d = calculate_dilution_factor(_HUGE_FACTOR_FINAL, DENSITY, intermediate=INT_WEIGHTS)
    assert d["problem"] is None
    assert math.isfinite(d["dilution_factor_total"]) and d["dilution_factor_total"] > 1e300


def test_a_negative_total_volume_that_overflows_is_none_not_minus_infinity():
    # Found by the sweep below. Both volumes are finite and negative (a backwards
    # weighing) and their sum is -inf. The sample volume is not positive, so the factor
    # was 0 (it is None since the fix wave), and a check on the factor alone missed the
    # total volume. The total is checked in its own right, which is what this pins.
    w = replace(
        FORWARD_WEIGHTS,
        dil_vial_empty=1e308, dil_vial_with_diluent=-5e-324, dil_vial_with_diluent_and_sample=-1e308,
    )
    diluent_vol = (w.dil_vial_with_diluent - w.dil_vial_empty) / DENSITY * 1000
    sample_vol = (w.dil_vial_with_diluent_and_sample - w.dil_vial_with_diluent) / DENSITY * 1000
    # The premise: both volumes are finite and negative, and their sum really is -inf.
    assert math.isfinite(diluent_vol) and math.isfinite(sample_vol)
    assert diluent_vol < 0 and sample_vol < 0 and diluent_vol + sample_vol == -math.inf
    d = calculate_dilution_factor(w, DENSITY)
    assert d["problem"] == "diluent"
    assert d["total_vol_ul"] is None
    json.dumps(d, allow_nan=False)


# Property checks over the input space, in three layers that promise DIFFERENT things.
#
# 1. Adversarial draws (seeded): every weighing, the density, the form and the declared
#    volume from values that include None, NaN, infinity, zero, a negative, a denormal
#    and the edges of the float range. This finds problems on the refusal paths and
#    single-leg sites. It does NOT promise to find a condition that needs both vials to
#    be extreme at once: about a fifth of the weighing values and more than half the
#    densities are refusals, so most draws exit early, and a two-vial joint condition
#    (the product of two huge factors overflowing) is reached by about 2 draws in
#    40,000. Reordering the rng calls or editing a value list can silently lose it.
# 2. A finite-only stratum (seeded): about 15 finite values, ordinary densities, and an
#    intermediate always present, so a total is computed far more often. It asserts its
#    own coverage, so it cannot decay unnoticed.
# 3. A deterministic grid of extreme vials: tare, diluent leg and sample leg at their
#    extremes on BOTH vials, as a plain loop. This is the layer that guarantees the
#    two-vial joint conditions, and it asserts that it reaches them.
#
# Every layer checks the same promises. The engine does not raise. The trace survives
# strict JSON (no NaN or infinity anywhere). A problem is set exactly when the stock
# volume or the total factor is missing. And the total is what it should be: never
# present without a final factor, equal to the final factor when there is no
# intermediate, else round(step * final, 6). The per-leg tests above pin which leg
# nulls which value; these catch what no one thought to write a test for.
_SWEEP_VALUES = [
    0.0, 1e-300, 2.3e-16, 1e-320, 5e-324, -5e-324, 1.0, -1.0, 1234.5, 2959.75,
    1e290, -1e290, 1e308, -1e308, 1.7e308, math.nan, math.inf, -math.inf, None,
]
_SWEEP_DENSITIES = [997.1, 1034.72, 500.0, 1e-5, 1e-310, 5e-324, 1e300, 0.0, -997.1, math.nan, math.inf, None]
_SWEEP_DECLARED = [None, 0.0, -3.0, 3.0, 1e308, 5e-324, math.nan, math.inf]

_FINITE_VALUES = [
    0.0, 1e-300, 2.3e-16, 1.0, -1.0, 1234.5, 2959.75, 1e-100, 1e100, 1e290, -1e290,
    1e308, -1e308, 1.7e308, 5e-324,
]
_FINITE_DENSITIES = [997.1, 1034.72, 500.0, 1100.0]
_FINITE_DECLARED = [3.0, 30.0]

# Leg masses (mg) for the grid. A vial is built as (-diluent leg, 0.0, sample leg), so the
# two legs are exactly these values whatever their size.
_GRID_LEGS = [0.0, 5e-324, 1e-300, 2.3e-16, 1.0, 1234.5, 1e290, 1.7e308, -1.0, -1.7e308]


def _vial(diluent_leg, sample_leg):
    return -diluent_leg, 0.0, sample_leg


def _dilution_failure(args, kwargs):
    """(why this call breaks an engine promise or None, the result or None)."""
    try:
        d = calculate_dilution_factor(*args, **kwargs)
        json.dumps(d, allow_nan=False)
    except Exception as error:  # noqa: BLE001 - the point is that nothing may escape
        return (repr(error)[:80], args, kwargs), None
    factor, total = d["dilution_factor"], d["dilution_factor_total"]
    step = None if d["intermediate"] is None else d["intermediate"]["dilution_factor"]
    if (d["problem"] is None) != (d["stock_volume_ml"] is not None and total is not None):
        return ("problem and values disagree", args, kwargs), d
    if total is not None and factor is None:
        return ("a total without a factor", args, kwargs), d
    if d["intermediate"] is None and total != factor:
        return ("no intermediate, but total != factor", args, kwargs), d
    if d["intermediate"] is not None and total is not None and total != round(step * factor, 6):
        return ("total != round(step * final, 6)", args, kwargs), d
    return None, d


def _product_line(d):
    """(both step factors exist, so a total is computed; their product overflows)."""
    step = None if d is None or d["intermediate"] is None else d["intermediate"]["dilution_factor"]
    reached = d is not None and d["dilution_factor"] is not None and step is not None
    return reached, reached and math.isinf(d["dilution_factor"] * step)


def _total_volume_overflows(w, density):
    """Both dilution volumes are finite but their sum is not (independent arithmetic)."""
    diluent_vol = (w.dil_vial_with_diluent - w.dil_vial_empty) / density * 1000
    sample_vol = (w.dil_vial_with_diluent_and_sample - w.dil_vial_with_diluent) / density * 1000
    return math.isfinite(diluent_vol) and math.isfinite(sample_vol) and not math.isfinite(diluent_vol + sample_vol)


def test_no_input_makes_the_dilution_raise_or_leak_a_non_finite_number():
    import random

    rng = random.Random(20261102)
    failures = []
    for _ in range(40_000):
        w = WeightInputs(*(rng.choice(_SWEEP_VALUES) for _ in range(5)))
        inter = None if rng.random() < 0.5 else IntermediateWeights(*(rng.choice(_SWEEP_VALUES) for _ in range(3)))
        args = (w, rng.choice(_SWEEP_DENSITIES), inter)
        kwargs = {"form": rng.choice(PREP_FORMS), "declared_volume_ml": rng.choice(_SWEEP_DECLARED)}
        failure, _ = _dilution_failure(args, kwargs)
        if failure:
            failures.append(failure)
    assert failures == []


def test_the_same_promises_hold_on_a_finite_only_stratum_that_reaches_the_total():
    import random

    rng = random.Random(20261103)
    failures, reached, overflowed = [], 0, 0
    for _ in range(40_000):
        w = WeightInputs(*(rng.choice(_FINITE_VALUES) for _ in range(5)))
        inter = IntermediateWeights(*(rng.choice(_FINITE_VALUES) for _ in range(3)))
        args = (w, rng.choice(_FINITE_DENSITIES), inter)
        kwargs = {"form": rng.choice(PREP_FORMS), "declared_volume_ml": rng.choice(_FINITE_DECLARED)}
        failure, d = _dilution_failure(args, kwargs)
        if failure:
            failures.append(failure)
        line, over = _product_line(d)
        reached += line
        overflowed += over
    assert failures == []
    # The coverage this stratum exists for. Measured: 756 and 22; the floors leave room
    # for a different Python's random.choice, and fail loudly if an edit starves it.
    assert reached >= 300 and overflowed >= 8, (reached, overflowed)


def test_the_same_promises_hold_on_a_grid_of_extreme_vials():
    import itertools

    base_stock = (0.0, 2959.75)  # a sound stock vial, so the dilution vials are the variable
    failures, reached, product_overflows, volume_overflows = [], 0, 0, 0
    intermediates = [IntermediateWeights(*_vial(d, s)) for d, s in itertools.product(_GRID_LEGS, _GRID_LEGS)]
    for (fd, fs), density in itertools.product(itertools.product(_GRID_LEGS, _GRID_LEGS), (997.1, 1e-5)):
        w = WeightInputs(*base_stock, *_vial(fd, fs))
        volume_overflows += _total_volume_overflows(w, density)
        for inter in [None, *intermediates]:
            failure, d = _dilution_failure((w, density, inter), {})
            if failure:
                failures.append(failure)
            line, over = _product_line(d)
            reached += line
            product_overflows += over
    assert failures == []
    # The guarantee: every two-vial joint condition is reached, on every run. Measured at
    # a few hundred product overflows over several thousand reached totals.
    assert reached >= 1000 and product_overflows >= 50, (reached, product_overflows)
    assert volume_overflows >= 1


# ---- Task 5: the quantity reads the total factor ------------------------------
#
# Until Task 5, calculate_quantity multiplied by the final step's factor alone, so a
# complete two-step row would have printed a quantity too LOW by the intermediate
# factor (about 6x here). It now reads dilution_factor_total, and its gate stands on
# that and on stock_volume_ml, never on dilution_factor: an intermediate-only problem
# leaves a perfectly good final factor in place, and computing from it would be the
# same understatement reached by a different route.
_FORWARD_INPUT = _input_from(FORWARD_CASE)
INJECTIONS, CAL = _FORWARD_INPUT.injections, _FORWARD_INPUT.calibration

# What Dennis's calc.js says for FORWARD_CASE's weighings, areas and curve with INT_WEIGHTS
# as the intermediate vial: stockPrep, dilutionActual for each vial, the product of the two
# unrounded factors (calc.js:1832) and sampleResult (calc.js:1254), run under node by
# backend/scripts/dennis_two_step_oracle.cjs (which needs Dennis's private repo and prints
# exactly these constants). An oracle written by someone else, not this engine's output.
# He rounds nothing; the engine rounds each factor and the stock volume to 6 places and
# the mass to 4, so the two agree to a few parts in 1e7, not exactly.
DENNIS_TWO_STEP = {"dilution_factor_total": 39.720449314194, "peptide_mass_mg": 97.02898393319467}
DENNIS_ONE_STEP_MASS_MG = 16.156357495897744


def test_quantity_uses_the_total_factor_on_a_two_step_row():
    d = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY, intermediate=INT_WEIGHTS)
    q = calculate_quantity(INJECTIONS, CAL, d)
    assert q["dilution_factor"] == d["dilution_factor_total"] != d["dilution_factor"]
    assert q["dilution_factor_steps"] == {
        "intermediate": d["intermediate"]["dilution_factor"],
        "final": d["dilution_factor"],
    }


def test_a_one_step_row_reports_its_single_factor_as_the_total():
    d = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY)
    q = calculate_quantity(INJECTIONS, CAL, d)
    assert q["dilution_factor"] == d["dilution_factor"] == d["dilution_factor_total"]
    assert q["dilution_factor_steps"] == {"intermediate": None, "final": d["dilution_factor"]}
    # The same number the golden pin holds for this row.
    assert q["quantity_mg"] == FORWARD_CASE["expected"]["quantity_mg"]


def test_two_step_quantity_is_the_one_step_quantity_times_the_intermediate_factor():
    one = calculate_quantity(INJECTIONS, CAL, calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY))
    two = calculate_quantity(
        INJECTIONS, CAL, calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY, intermediate=INT_WEIGHTS)
    )
    factor = calculate_intermediate(INT_WEIGHTS, STOCK_CONC, DENSITY)["dilution_factor"]
    # mass_ug, not quantity_mg: the mg figure is rounded to 4 places, which would swamp a
    # tight comparison. A 6x mistake would miss by far more than this.
    assert two["mass_ug"] == pytest.approx(one["mass_ug"] * factor, rel=1e-6)


def test_two_step_quantity_agrees_with_dennis_calc_js():
    two = process_hplc_analysis(replace(_FORWARD_INPUT, intermediate=INT_WEIGHTS))
    assert two["dilution_factor"] == two["calculation_trace"]["dilution"]["dilution_factor_total"]
    # Dennis rounds nothing; the engine's departures from him are bounded, and the bounds
    # below ADD (pytest.approx would take the larger, leaving one inert). The total: each
    # factor and their product are rounded to 6 places, 5e-7 * 6.6 + 5e-7 * 6.0 + 5e-7 =
    # 6.8e-6. The mass: half a unit of its 4th place (5e-5 mg) plus the relative effect of
    # four 6-place roundings, 5e-7 / 6.0 + 5e-7 / 6.6 + 5e-7 / 39.7 (the product) +
    # 5e-7 / 2.97 (the stock volume) = 3.4e-7, taken as 4e-7. Measured: 4.3e-6 and 1.6e-5.
    assert abs(two["dilution_factor"] - DENNIS_TWO_STEP["dilution_factor_total"]) <= 7e-6
    mass = DENNIS_TWO_STEP["peptide_mass_mg"]
    assert abs(two["quantity_mg"] - mass) <= 5e-5 + 4e-7 * mass
    # And his one-step figure for the same row is the number the golden pin holds.
    one = process_hplc_analysis(_FORWARD_INPUT)
    assert one["quantity_mg"] == pytest.approx(DENNIS_ONE_STEP_MASS_MG, abs=5e-5)


def test_a_flagged_dilution_refuses_to_report_a_quantity():
    # A regression guard: Task 2's gate already did this on a one-step row.
    q = calculate_quantity(INJECTIONS, CAL, calculate_dilution_factor(FINAL_LEG_BAD, DENSITY))
    assert q["quantity_mg"] is None
    assert q["error"] == "stock"


def test_an_intermediate_only_problem_gives_no_quantity_from_one_step_of_the_prep():
    d = _two_step(intermediate=INT_LEG_BAD)
    # The premise: a good final factor is in place and only the total is lost.
    assert d["dilution_factor"] is not None and d["dilution_factor_total"] is None
    q = calculate_quantity(INJECTIONS, CAL, d)
    assert q["quantity_mg"] is None
    assert q["error"] == "intermediate_stock"
    assert "dilution_factor_steps" not in q


@pytest.mark.parametrize("hole", ["dilution_factor_total", "stock_volume_ml"])
@pytest.mark.parametrize("value", [None, math.nan, math.inf], ids=["none", "nan", "inf"])
def test_the_quantity_gate_stands_on_the_total_and_the_stock_volume_not_on_problem_or_the_final_factor(hole, value):
    # None is what Task 4 produces; NaN and infinity are what the gate's _finite (rather than
    # "is not None") keeps out if that no-NaN invariant ever regresses.
    d = _two_step()
    d[hole] = value
    d["problem"] = None  # a dict whose problem does not say what is missing
    assert d["dilution_factor"] is not None  # the final factor alone would have let a quantity through
    q = calculate_quantity(INJECTIONS, CAL, d)
    assert q["quantity_mg"] is None
    assert q["error"] == "dilution_incomplete"
    json.dumps(q, allow_nan=False)


def test_a_hand_built_intermediate_without_its_factor_is_not_a_crash():
    # The one lookup that used to be a bare subscript. The quantity does not need the step
    # (the total carries both), so the row is not refused; the step just reads as absent.
    d = _two_step()
    d["intermediate"] = {}
    q = calculate_quantity(INJECTIONS, CAL, d)
    assert q["quantity_mg"] is not None
    assert q["dilution_factor_steps"] == {"intermediate": None, "final": d["dilution_factor"]}


def test_a_problem_still_wins_over_complete_values():
    d = _two_step()
    d["problem"] = "stock"
    q = calculate_quantity(INJECTIONS, CAL, d)
    assert q["quantity_mg"] is None and q["error"] == "stock"


# calculate_quantity returns no NaN or infinity, like calculate_dilution_factor (Task 4).
# A finite factor times a large concentration can overflow, and so can the concentration
# itself (a tiny slope), and a number that does is not a quantity.
_OK_DILUTION = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY)
_FAILURE_KEYS = {
    "quantity_mg", "error", "individual_areas", "avg_main_peak_area",
    "concentration_ug_ml", "calibration_slope", "calibration_intercept",
}


def _one_injection(*areas):
    return [{"peaks": [{"area": area}], "main_peak_index": 0} for area in areas]


@pytest.mark.parametrize(
    "area, slope, intercept, concentration_survives",
    [
        (1e307, 1.0, 0.0, True),         # only the mass overflows: a finite factor times a large concentration
        (1e308, 1.0, 0.0, True),         # the undiluted concentration overflows
        (1.0, 5e-324, 0.0, False),       # the concentration itself overflows (a tiny slope)
        (1.7e308, 1.0, -1.7e308, False),  # area minus intercept overflows
    ],
    ids=["mass", "undiluted", "tiny_slope", "area_minus_intercept"],
)
def test_an_overflowing_quantity_is_refused_not_infinity(area, slope, intercept, concentration_survives):
    q = calculate_quantity(_one_injection(area), CalibrationParams(slope, intercept), _OK_DILUTION)
    assert q["quantity_mg"] is None
    assert q["error"] == "quantity_not_finite"
    # The failure keeps the quantity section's inputs; only a concentration that overflowed is None.
    assert set(q) == _FAILURE_KEYS
    assert (q["concentration_ug_ml"] is not None) == concentration_survives
    json.dumps(q, allow_nan=False)  # the stored trace must stay valid JSON


def test_an_overflowing_quantity_survives_the_pipeline_as_valid_json():
    inp = replace(
        _FORWARD_INPUT, injections=_one_injection(1e307), calibration=CalibrationParams(1.0, 0.0)
    )
    result = process_hplc_analysis(inp)
    assert result["quantity_mg"] is None
    assert result["calculation_trace"]["quantity"]["error"] == "quantity_not_finite"
    json.dumps(result, allow_nan=False)


@pytest.mark.parametrize(
    "injections, calibration",
    [
        (_one_injection(math.nan), CalibrationParams(1.0, 0.0)),
        (_one_injection(math.inf), CalibrationParams(1.0, 0.0)),
        (_one_injection(1.7e308, 1.7e308), CalibrationParams(1.0, 0.0)),  # finite areas, the sum overflows
        (_one_injection(1.0), CalibrationParams(math.nan, 0.0)),
        (_one_injection(1.0), CalibrationParams(1.0, math.inf)),
    ],
    ids=["nan_area", "inf_area", "area_sum_overflows", "nan_slope", "inf_intercept"],
)
def test_a_non_finite_area_or_calibration_is_refused_not_echoed(injections, calibration):
    q = calculate_quantity(injections, calibration, _OK_DILUTION)
    assert q == {"quantity_mg": None, "error": "quantity_not_finite"}
    json.dumps(q, allow_nan=False)


# The sweep for calculate_quantity. Its domain is what the function is really handed:
# dilution dicts that calculate_dilution_factor produced (one step, two steps, every
# problem code, a huge but finite total, a huge stock volume) crossed with finite areas,
# slopes and intercepts that include the extremes. Non-finite areas and calibrations are
# the input boundary's job and have their own cases above; they are not drawn here.
#
# The expected error is worked out independently, in the precedence the function
# documents: a zero slope, then non-finite areas or calibration, then the dilution's
# problem, then a missing total or stock volume, then an overflow in the arithmetic.
_QUANTITY_AREAS = [0.0, 1.0, 1234.5, 23396.5746, -1.0, 1e100, 1e300, 1e307, 1.7e308, -1e300]
_QUANTITY_SLOPES = [9.038015, 1.0, -9.038015, 1e-5, 1e-300, 5e-324, 1e300, 0.0]
_QUANTITY_INTERCEPTS = [0.0, 18.846082, -1e300, 1e300, 1.7e308, -1.7e308]


def _holed(key, value):
    """A two-step dilution whose problem is None but whose `key` is `value`: a dict that
    calculate_dilution_factor did not build, which the gate must refuse by its values."""
    d = _two_step()
    d[key], d["problem"] = value, None
    return d


def _handbuilt_dilutions():
    plain = calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY)
    return [
        plain,
        _two_step(),
        _two_step(weights=STOCK_LEG_BAD),
        _two_step(weights=FINAL_LEG_BAD),
        _two_step(intermediate=INT_LEG_BAD),
        _two_step(intermediate=INT_UNWEIGHED),
        calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY, form="liquid", declared_volume_ml=3.0),
        calculate_dilution_factor(FORWARD_WEIGHTS, DENSITY, form="bac"),
        calculate_dilution_factor(FORWARD_WEIGHTS, 1e-5),  # a stock volume near 3e8 mL
        calculate_dilution_factor(FORWARD_WEIGHTS, 1e-310),  # every volume overflows
        calculate_dilution_factor(_HUGE_FACTOR_FINAL, DENSITY, intermediate=INT_WEIGHTS),  # a total above 1e300
        calculate_dilution_factor(_HUGE_FACTOR_FINAL, DENSITY, intermediate=_HUGE_FACTOR_INTERMEDIATE),
        # Dicts whose problem is None but whose total or stock volume is missing (None), or
        # present and not a number (NaN, infinity): the only source of "dilution_incomplete".
        _holed("dilution_factor_total", None),
        _holed("stock_volume_ml", None),
        _holed("dilution_factor_total", math.nan),
        _holed("stock_volume_ml", math.inf),
    ]


def _is_number(value):
    return value is not None and math.isfinite(value)


def _expected_quantity(areas, calibration, d):
    """(the error the function must give or None, the kind of outcome, the mass in ug a quantity must have).

    Kinds: "boundary" (the 2-key refusal), "problem", "incomplete", "overflow" and
    "below_precision" (the 7-key refusals), "one_step" and "two_step" (a quantity).
    """
    if calibration.slope == 0:
        return "Calibration slope is zero", "boundary", None
    avg = sum(areas) / len(areas)
    if not all(math.isfinite(v) for v in (avg, calibration.slope, calibration.intercept, *areas)):
        return "quantity_not_finite", "boundary", None
    if d["problem"]:
        return d["problem"], "problem", None
    total, volume = d["dilution_factor_total"], d["stock_volume_ml"]
    if not (_is_number(total) and _is_number(volume)):
        return "dilution_incomplete", "incomplete", None
    conc = (avg - calibration.intercept) / calibration.slope
    mass_ug = conc * total * volume
    if not all(math.isfinite(v) for v in (conc, conc * total, mass_ug)):
        return "quantity_not_finite", "overflow", None
    # A positive concentration can still work out to a mass that rounds away, and then
    # there is no number to report: 0 mg with no problem is the false zero the fix wave
    # exists to kill. THREE places, the precision prep_bridge submits onto the vial with
    # (`f"{v:.3f}"`), not the four the engine publishes: a mass of 0.0001 mg is a number
    # in the trace and the string "0" on the vial. Written out rather than imported,
    # because this oracle must say what the engine owes, not read it back from the engine.
    if round(mass_ug / 1000, 3) == 0 and conc > 0:
        return "quantity_below_precision", "below_precision", None
    return None, "one_step" if d["intermediate"] is None else "two_step", mass_ug


def _quantity_failure(areas, calibration, d):
    """(why this call breaks a promise or None, the kind of outcome the oracle expects)."""
    try:
        q = calculate_quantity(_one_injection(*areas), calibration, d)
        json.dumps(q, allow_nan=False)
    except Exception as error:  # noqa: BLE001 - the point is that nothing may escape
        return (repr(error)[:80], areas, calibration, d), None
    expected, kind, mass_ug = _expected_quantity(areas, calibration, d)

    def broke(why):
        return (why, areas, calibration, d), kind

    if q.get("error") != expected:
        return broke(f"error {q.get('error')!r}, expected {expected!r}")
    if (q["quantity_mg"] is None) != (expected is not None):
        return broke("quantity_mg and error disagree")
    if kind == "boundary":
        if set(q) != {"quantity_mg", "error"}:
            return broke("a boundary refusal that carries a payload")
    elif expected is not None:
        # The shape follows the error, so a collapse to the two keys is caught here.
        if set(q) != _FAILURE_KEYS:
            return broke("a failure that collapsed the section")
    else:
        step = None if d["intermediate"] is None else d["intermediate"]["dilution_factor"]
        if (
            q["dilution_factor"] != d["dilution_factor_total"]
            or q["stock_volume_ml"] != d["stock_volume_ml"]
            or q["dilution_factor_steps"] != {"intermediate": step, "final": d["dilution_factor"]}
        ):
            return broke("a quantity whose echoes do not read the total")
        # The number, not the label: an engine that multiplied by the final factor while still
        # echoing the total would pass the checks above. Both figures are rounded to 4 places.
        if (
            abs(q["mass_ug"] - mass_ug) > 5e-5 + 1e-12 * abs(mass_ug)
            or abs(q["quantity_mg"] - mass_ug / 1000) > 5e-5 + 1e-12 * abs(mass_ug)
        ):
            return broke("a quantity that does not multiply the total")
    return None, kind


def _assert_floors(kinds, **floors):
    short = {kind: (kinds[kind], floor) for kind, floor in floors.items() if kinds[kind] < floor}
    assert short == {}, (short, dict(kinds))


def test_no_input_makes_the_quantity_raise_or_leak_a_non_finite_number():
    import random
    from collections import Counter

    rng = random.Random(20261104)
    pool = _handbuilt_dilutions()
    for _ in range(3000):  # real dilutions from random finite weighings, most of them refusals
        w = WeightInputs(*(rng.choice(_FINITE_VALUES) for _ in range(5)))
        inter = None if rng.random() < 0.3 else IntermediateWeights(*(rng.choice(_FINITE_VALUES) for _ in range(3)))
        pool.append(
            calculate_dilution_factor(
                w, rng.choice(_FINITE_DENSITIES), inter,
                form=rng.choice(PREP_FORMS), declared_volume_ml=rng.choice(_FINITE_DECLARED),
            )
        )
    failures, kinds = [], Counter()
    for _ in range(40_000):
        areas = [rng.choice(_QUANTITY_AREAS) for _ in range(rng.randint(1, 3))]
        calibration = CalibrationParams(rng.choice(_QUANTITY_SLOPES), rng.choice(_QUANTITY_INTERCEPTS))
        failure, kind = _quantity_failure(areas, calibration, rng.choice(pool))
        if failure:
            failures.append(failure)
        kinds[kind] += 1
    assert failures == []
    # The coverage this sweep exists for, one floor per path that can break a promise: a
    # quantity from one step and from two (only the two-step one tells the total from the
    # final factor), the overflow refusal, and the gate's refusal by value. Measured: 369
    # one-step and 84 two-step quantities, 697 overflow refusals, 45 incomplete. The floors
    # leave room for a different Python's random.choice and fail loudly if an edit starves
    # a path. Only about 3 % of random weighings reach a quantity at all, which is why the
    # grid below exists.
    _assert_floors(kinds, one_step=150, two_step=30, overflow=300, incomplete=15)


def test_the_same_promises_hold_on_a_grid_of_every_area_slope_and_intercept():
    import itertools
    from collections import Counter

    failures, kinds = [], Counter()
    for d in _handbuilt_dilutions():
        for area, slope, intercept in itertools.product(_QUANTITY_AREAS, _QUANTITY_SLOPES, _QUANTITY_INTERCEPTS):
            failure, kind = _quantity_failure([area], CalibrationParams(slope, intercept), d)
            if failure:
                failures.append(failure)
            kinds[kind] += 1
    assert failures == []
    # The guarantee: every dilution shape meets every extreme, on every run. Deterministic,
    # so the floors sit close to the measured 743 one-step and 280 two-step quantities,
    # 1462 overflow refusals, 1680 incomplete and 35 below precision, out of 7,680 calls.
    # The first two were 771 and 287 until the fix wave: 35 draws whose mass rounded away
    # used to be counted as quantities, and every one of them was a published 0.0 mg.
    _assert_floors(
        kinds, one_step=740, two_step=275, overflow=1400, incomplete=1600, below_precision=30
    )


# ---- Fix wave: a volume that rounds away is not a volume ----------------------
#
# Three routes still reached a quantity of exactly 0.0 mg with problem None, every one
# of them inside the request layer's own validation bounds: a declared volume that
# passes Field(gt=0) and rounds away at the six places the row stores, a stock leg
# above stock_volume_ml's `mass_mg <= 0` check whose volume rounds away the same way,
# and a sample volume that underflows to 0.0 while its mass is above zero (the mirror
# of calculate_intermediate, which checks the VOLUME and is immune). Zero is finite, so
# the quantity gate passed it: 0.00 mg printed with no problem line, and prep_bridge
# submits it onto the vial as "0", which is the path to a certificate.
#
# Each row must report the code of the LEG that produced it, not "dilution_incomplete":
# CalculationVisuals.tsx deliberately carries no copy for that code, so a tech would
# read a raw code instead of the sentence the leg already has.

# A stock leg of 0.0004 mg: 4.01e-7 mL, which rounds to 0.0 at six places.
TINY_STOCK_LEG = replace(
    FORWARD_WEIGHTS, stock_vial_with_diluent=FORWARD_WEIGHTS.stock_vial_empty + 0.0004
)
# A sample leg of 5e-324 mg, whose volume underflows to 0.0. Built off a 0.0 base
# because FORWARD_WEIGHTS.dil_vial_with_diluent + 5e-324 is a float no-op, which would
# make the leg exactly 0.0 and test the already-covered `sample_mass_mg <= 0` branch.
UNDERFLOW_SAMPLE_LEG = replace(
    FORWARD_WEIGHTS,
    dil_vial_empty=-(FORWARD_WEIGHTS.dil_vial_with_diluent - FORWARD_WEIGHTS.dil_vial_empty),
    dil_vial_with_diluent=0.0,
    dil_vial_with_diluent_and_sample=5e-324,
)


@pytest.mark.parametrize(
    "overrides, code",
    [
        ({"form": "liquid", "declared_volume_ml": 4e-7}, "no_declared_volume"),
        ({"weights": TINY_STOCK_LEG}, "stock_diluent"),
        ({"weights": TINY_STOCK_LEG, "form": "bac"}, "stock_diluent"),
        ({"weights": UNDERFLOW_SAMPLE_LEG}, "stock"),
    ],
    ids=["liquid_declared_volume", "powder_stock_leg", "bac_stock_leg", "final_vial_underflow"],
)
def test_a_stock_volume_that_rounds_to_zero_is_not_a_quantity(overrides, code):
    result = process_hplc_analysis(replace(_FORWARD_INPUT, **overrides))
    assert result["quantity_mg"] is None
    assert result["calculation_trace"]["dilution"]["problem"] == code
    assert result["calculation_trace"]["quantity"]["error"] == code
    # Nothing that does not depend on the weighings moves.
    assert result["purity_percent"] == FORWARD_CASE["expected"]["purity_percent"]
    assert result["concentration_ug_ml"] == FORWARD_CASE["expected"]["concentration_ug_ml"]
    json.dumps(result, allow_nan=False)


# A stock leg of 0.005 mg: 5.0145e-6 mL, which SURVIVES the six-place rounding as 5e-06,
# so the guards above do not fire. On this row (concentration 822.9454 ug/mL, total factor
# 6.613877) the mass it makes is 2.72e-5 mg, which rounds to 0.0 at the four places the
# quantity is published in.
SMALL_SURVIVING_STOCK_LEG = replace(
    FORWARD_WEIGHTS, stock_vial_with_diluent=FORWARD_WEIGHTS.stock_vial_empty + 0.005
)


@pytest.mark.parametrize(
    "overrides",
    [
        {"form": "liquid", "declared_volume_ml": 5e-6},
        {"weights": SMALL_SURVIVING_STOCK_LEG},
        # 1.8e-5 mL of stock gives 9.8e-5 mg, which PUBLISHES as 0.0001 mg: a number at the
        # engine's four places, and the string "0" once prep_bridge formats it to three and
        # strips the zeros. The guard has to be at the consumer's precision to catch it.
        {"form": "liquid", "declared_volume_ml": 1.8e-5},
    ],
    ids=["liquid_declared_volume", "powder_stock_leg", "publishes_as_a_number_submits_as_zero"],
)
def test_a_quantity_that_rounds_to_zero_is_not_a_result(overrides):
    # The same false zero one layer down: the INPUTS are guarded above, but the mass is
    # published as round(mass_mg, 4), so a volume and a total that each survive their own
    # rounding can still multiply out below 0.00005 mg and publish as 0.0 with no problem.
    result = process_hplc_analysis(replace(_FORWARD_INPUT, **overrides))
    dilution = result["calculation_trace"]["dilution"]
    # The premise: nothing the dilution computed is a problem, and both values the mass is
    # built from are above zero. So this is not reachable by any guard on the inputs.
    assert dilution["problem"] is None
    assert dilution["stock_volume_ml"] > 0 and dilution["dilution_factor_total"] > 0
    assert result["quantity_mg"] is None
    # The code, not just the refusal: the weighings may be perfectly good, so no leg's
    # code would be honest here, and a code with no copy prints raw at the bench.
    assert result["calculation_trace"]["quantity"]["error"] == "quantity_below_precision"
    # The concentration is a real measurement and is kept, as under every other refusal.
    assert result["concentration_ug_ml"] == FORWARD_CASE["expected"]["concentration_ug_ml"]
    assert result["calculation_trace"]["quantity"]["concentration_ug_ml"] > 0
    json.dumps(result, allow_nan=False)


def test_the_precision_guard_is_the_one_the_submitted_value_uses():
    # The mass has THREE precisions: the engine publishes 4 places, prep_bridge submits 3
    # (and strips trailing zeros), and both bench screens show 2. The guard must sit at the
    # VALUE-CARRYING consumer's, because a number the vial receives as "0" is the false
    # zero whatever the engine stored. Imported, not mirrored by hand, so the two cannot
    # drift apart; the import is local because prep_bridge pulls in the ORM.
    from lims_analyses.prep_bridge import _fmt_num

    # The smallest mass the guard lets through, and the bridge formats the STORED value, so
    # both roundings apply: the guard's at SUBMITTED_MG_PLACES and the trace's at
    # QUANTITY_MG_PLACES. Half of the last place is the boundary, not a whole place.
    smallest_allowed = 0.5 * 10 ** -SUBMITTED_MG_PLACES  # 0.0005 mg
    assert round(smallest_allowed, SUBMITTED_MG_PLACES) != 0  # the guard allows it
    assert _fmt_num(round(smallest_allowed, QUANTITY_MG_PLACES)) != "0"
    assert _fmt_num(round(smallest_allowed / 10, QUANTITY_MG_PLACES)) == "0"
    # And the engine's own publishing precision is finer, so it is NOT a safe guard: 0.0001 mg
    # is a number in the trace and "0" on the vial, which is what the first guard let through.
    assert QUANTITY_MG_PLACES > SUBMITTED_MG_PLACES
    assert _fmt_num(10 ** -QUANTITY_MG_PLACES) == "0"


def test_a_negative_quantity_that_rounds_to_zero_is_still_a_result():
    # The guard above asks for a POSITIVE concentration. A negative one (an area below the
    # curve's intercept) is a different story: the fixture holds a negative quantity, so a
    # small negative number is a reported result and must not be turned into a problem.
    # Concentration -0.002 ug/mL, so the mass is -3.93e-5 mg: it rounds to zero, and the
    # guard must leave it alone.
    q = calculate_quantity(_one_injection(0.0), CalibrationParams(1.0, 0.002), _OK_DILUTION)
    assert q["concentration_ug_ml"] < 0
    assert q["quantity_mg"] == 0.0 and "error" not in q


@pytest.mark.parametrize("key", ["dilution_factor_total", "stock_volume_ml"])
def test_the_quantity_gate_refuses_a_zero_total_or_stock_volume(key):
    # The belt behind the three fixes above. Nothing calculate_dilution_factor builds can
    # hand the gate a zero any more, so this is a hand-built dict, as _holed's own cases
    # are: a future path that produces one must fail closed instead of printing 0.00 mg.
    q = calculate_quantity(INJECTIONS, CAL, _holed(key, 0.0))
    assert q["quantity_mg"] is None and q["error"] == "dilution_incomplete"
