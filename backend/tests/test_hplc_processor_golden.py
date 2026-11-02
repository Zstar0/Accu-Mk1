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
from scripts.capture_hplc_golden import build_case
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
