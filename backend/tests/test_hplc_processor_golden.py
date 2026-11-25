"""Golden master for the HPLC results engine (plan
docs/superpowers/plans/2026-10-31-hplc-results-engine.md, Task 1).

A characterization test: it passes against the engine as it stood when the
fixture was captured, and every later change must show that a one-step powder
row still gives these exact numbers. tests/fixtures/hplc_engine_golden.json is
written by scripts/capture_hplc_golden.py from prod rows. Its `expected` values
are what the engine computed at capture time, NOT prod's stored quantity_mg
(which the fixture does not carry), so equality is exact and no tolerance is
ever the answer to a failure here. Case ids are opaque on purpose: the fixture
holds numbers only, no sample labels.

The one deliberate exception is the `flagged` rows (weighings with a zero or
negative leg, which the engine now refuses instead of computing from): they are
left out of the main comparison and asserted separately as an expected change.

How a case becomes an engine input lives in ONE place, the capture script's
input_from_case, imported below, so the test feeds the engine exactly what the
capture fed it.
"""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from calculations.hplc_processor import process_hplc_analysis
from scripts.capture_hplc_golden import build_case, capture, capture_statement
from scripts.capture_hplc_golden import input_from_case as _input_from

FIXTURES = Path(__file__).parent / "fixtures"
GOLDEN = json.loads((FIXTURES / "hplc_engine_golden.json").read_text(encoding="utf-8"))

FLAGGED = set(GOLDEN["flagged"])

EXPECTED_KEYS = {"quantity_mg", "dilution_factor", "stock_volume_ml", "purity_percent", "concentration_ug_ml"}

# What the engine reported for every row in `flagged` BEFORE Task 2: exactly
# 0.0 mg (all five, in the 2026-11-02 pre-change capture), from a zero or
# negative leg. It is a literal here and NOT read from the fixture on purpose:
# a recapture runs today's engine, which rewrites each flagged case's own
# expected["quantity_mg"] to None, and the positional case ids renumber on
# every recapture, so neither the fixture nor anything keyed by id can carry
# this. This constant is the repo's only record that these rows ever printed
# a number.
SUPERSEDED_QUANTITY_MG = 0.0


def _case(case_id):
    return next(c for c in GOLDEN["cases"] if c["id"] == case_id)


@pytest.mark.parametrize(
    "case", [c for c in GOLDEN["cases"] if c["id"] not in FLAGGED], ids=lambda c: c["id"]
)
def test_engine_reproduces_captured_output(case):
    result = process_hplc_analysis(_input_from(case))
    # The whole dict, so a failure shows every key that moved, and a key added
    # to the fixture later is pinned without touching this test.
    assert {key: result[key] for key in case["expected"]} == case["expected"]


@pytest.mark.parametrize("case_id", GOLDEN["flagged"])
def test_rows_with_impossible_weighings_now_refuse(case_id):
    # The one deliberate break from the pin (Task 2): these rows used to produce
    # a garbage number from a zero or negative leg and now give None. Every one
    # is a prod row whose reported quantity changes, so the count goes in the
    # sign-off. Asserts only the NEW behaviour, which survives a recapture; what
    # the rows used to report is SUPERSEDED_QUANTITY_MG above.
    case = _case(case_id)
    result = process_hplc_analysis(_input_from(case))
    assert result["quantity_mg"] is None, f"used to report {SUPERSEDED_QUANTITY_MG} mg"
    assert result["calculation_trace"]["dilution"]["problem"] is not None
    # Nothing that does not depend on the weighings changes: the sign-off is
    # quantity, dilution factor and stock volume only.
    assert result["concentration_ug_ml"] == case["expected"]["concentration_ug_ml"]
    assert result["purity_percent"] == case["expected"]["purity_percent"]
    # A recapture rebuilds a row's inputs from its stored trace. If a problem
    # collapsed the quantity section, every flagged row would drop out of the
    # next capture as a skip, taking the proof of this change with it.
    row = SimpleNamespace(
        calculation_trace=result["calculation_trace"],
        diluent_density=case["diluent_density"],
        **case["weights"],
    )
    rebuilt, skipped = build_case(row)
    assert skipped is None
    assert (rebuilt["areas"], rebuilt["slope"], rebuilt["intercept"]) == (
        case["areas"], case["slope"], case["intercept"]
    )


def test_exactly_five_prod_rows_change_their_reported_quantity():
    # The count that goes into the sign-off, pinned. It also guards the
    # parametrize above, which silently collects zero tests if `flagged` is empty.
    # A recapture that finds more (or fewer) flagged rows must update this on
    # purpose, with the sign-off.
    assert len(GOLDEN["flagged"]) == 5


def test_every_golden_case_carries_all_five_expected_keys():
    # The main comparison is driven by each case's own `expected`, so a case with
    # an empty `expected`, or a recapture that drops a key, would pass silently.
    missing = {c["id"]: sorted(EXPECTED_KEYS - set(c["expected"])) for c in GOLDEN["cases"]}
    assert {cid: keys for cid, keys in missing.items() if keys} == {}


def test_golden_fixture_is_not_empty():
    assert len(GOLDEN["cases"]) >= 150


def test_golden_fixture_pins_real_multi_injection_rows():
    # The most recent prod rows are almost all single injection; the capture adds
    # every multi-injection row so the averaging path is pinned by real data.
    assert any(len(case["areas"]) > 1 for case in GOLDEN["cases"])


def test_flagged_ids_are_real_case_ids():
    assert set(GOLDEN["flagged"]) <= {case["id"] for case in GOLDEN["cases"]}


def test_fixture_records_its_source():
    assert isinstance(GOLDEN["source"], str) and GOLDEN["source"].strip()


# ---- Task 6a: the capture script carries the prep form ------------------------
#
# A liquid or bac row rebuilt as a powder would pin a WRONG expected value into the
# artefact the sign-off rests on, and the capture would still look clean. These pin that
# the form, the declared volume and the intermediate vial ride in the case, and that an
# all-powder table still captures to exactly the shape it always had.

LEGACY_CASE_KEYS = {
    "weights", "areas", "area_percents", "retention_times", "slope", "intercept", "diluent_density", "expected",
}
INT_WEIGHINGS = {"int_vial_empty": 8000.0, "int_vial_with_diluent": 8500.0, "int_vial_with_diluent_and_sample": 8550.0}
NO_INTERMEDIATE = {name: None for name in INT_WEIGHINGS}


def _forward_pinned_case():
    """A pinned prod row with all three legs comfortably positive (so every form below
    computes), chosen by property because the opaque ids renumber on a recapture."""
    for case in GOLDEN["cases"]:
        w = case["weights"]
        legs = (
            w["stock_vial_with_diluent"] - w["stock_vial_empty"],
            w["dil_vial_with_diluent"] - w["dil_vial_empty"],
            w["dil_vial_with_diluent_and_sample"] - w["dil_vial_with_diluent"],
        )
        if case["id"] not in FLAGGED and all(leg > 1.0 for leg in legs):
            return case
    raise AssertionError("no unflagged pinned case has three legs above 1.0 mg")


FWD = _forward_pinned_case()


def _fetched_row(case=FWD, **over):
    """A row as capture_statement returns it: a stored trace that carries the inputs."""
    trace = {"quantity": {
        "individual_areas": case["areas"],
        "calibration_slope": case["slope"],
        "calibration_intercept": case["intercept"],
    }}
    if case["area_percents"] is not None:
        trace["purity"] = {"individual_values": case["area_percents"]}
    if case["retention_times"] is not None:
        trace["identity"] = {"individual_rts": case["retention_times"]}
    attrs = {
        "id": 1, "sample_id_label": "X", "weighs_backwards": False, "quantity_mg": None,
        "calibration_curve_id": 1, "diluent_density": case["diluent_density"],
        "prep_form": None, "declared_volume_ml": None, **NO_INTERMEDIATE, **case["weights"],
    }
    return SimpleNamespace(calculation_trace=trace, **{**attrs, **over})


def test_a_powder_row_rebuilds_the_pinned_case_with_the_shape_it_always_had():
    for prep_form in (None, "powder"):
        case, skipped = build_case(_fetched_row(prep_form=prep_form))
        assert skipped is None
        assert set(case) == LEGACY_CASE_KEYS  # no new key, so the fixture stays byte-identical
        assert case == {key: FWD[key] for key in LEGACY_CASE_KEYS}


def test_a_case_without_the_new_keys_is_a_one_step_powder_input():
    inp = _input_from(FWD)
    assert (inp.form, inp.declared_volume_ml, inp.intermediate) == ("powder", None, None)


def test_a_liquid_row_carries_its_form_and_pins_the_declared_volume():
    row = _fetched_row(prep_form="liquid", declared_volume_ml=3.0, stock_vial_empty=None, stock_vial_with_diluent=None)
    case, skipped = build_case(row)  # None stock weighings must not reach math.isfinite
    assert skipped is None
    assert (case["prep_form"], case["declared_volume_ml"]) == ("liquid", 3.0)
    assert case["weights"]["stock_vial_empty"] is None
    assert case["expected"]["stock_volume_ml"] == 3.0
    assert case["expected"]["stock_volume_ml"] != FWD["expected"]["stock_volume_ml"]  # not rebuilt as a powder
    assert case["expected"]["quantity_mg"] is not None


def test_a_bac_row_is_pinned_with_the_density_correction():
    case, skipped = build_case(_fetched_row(prep_form="bac"))
    assert skipped is None and case["prep_form"] == "bac"
    assert case["declared_volume_ml"] is None
    # A little denser than water, so a little less volume for the same mass (about 0.03 %).
    assert 0 < case["expected"]["stock_volume_ml"] < FWD["expected"]["stock_volume_ml"]
    assert case["expected"]["stock_volume_ml"] == pytest.approx(FWD["expected"]["stock_volume_ml"], rel=1e-3)


def test_a_two_step_row_carries_its_intermediate_vial():
    case, skipped = build_case(_fetched_row(**INT_WEIGHINGS))
    assert skipped is None and case["intermediate"] == INT_WEIGHINGS
    # The intermediate step is 550 / 50 = 11, so the total is 11x the one-step factor.
    assert case["expected"]["dilution_factor"] == pytest.approx(FWD["expected"]["dilution_factor"] * 11, rel=1e-5)
    assert case["expected"]["quantity_mg"] == pytest.approx(FWD["expected"]["quantity_mg"] * 11, rel=1e-5)


def test_a_captured_non_default_case_replays_through_the_shared_builder():
    case, _ = build_case(_fetched_row(prep_form="liquid", declared_volume_ml=3.0, **NO_INTERMEDIATE))
    result = process_hplc_analysis(_input_from(case))
    assert {key: result[key] for key in case["expected"]} == case["expected"]


def test_the_capture_counts_how_many_rows_defaulted_to_powder():
    old = _fetched_row()  # then made into a row from before the columns: the attributes do not exist at all
    for name in ("prep_form", "declared_volume_ml", *INT_WEIGHINGS):
        delattr(old, name)
    rows = [
        old,
        _fetched_row(prep_form=None),
        _fetched_row(prep_form="powder"),
        _fetched_row(prep_form="liquid", declared_volume_ml=3.0),
    ]
    fixture, counts = capture(rows, "test")
    assert len(fixture["cases"]) == 4
    assert counts["prep_form_defaulted_to_powder"] == 2
    assert counts["cases_by_prep_form"] == {"powder": 3, "liquid": 1}
    assert counts["cases_with_intermediate"] == 0


def test_the_capture_query_selects_every_column_the_form_needs():
    # build_case reads these with getattr (a row of the old shape has none), so a dropped
    # column would default every row to powder without a single error. Pin the query.
    selected = set(capture_statement().selected_columns.keys())
    assert {"prep_form", "declared_volume_ml", *INT_WEIGHINGS} <= selected
