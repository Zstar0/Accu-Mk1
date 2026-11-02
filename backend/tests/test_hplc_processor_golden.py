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

import pytest

from calculations.hplc_processor import process_hplc_analysis
from scripts.capture_hplc_golden import input_from_case as _input_from

FIXTURES = Path(__file__).parent / "fixtures"
GOLDEN = json.loads((FIXTURES / "hplc_engine_golden.json").read_text(encoding="utf-8"))

# The comparison below is driven by each case's own `expected` dict, so a case
# with an empty `expected`, or a recapture that drops a key, would pass silently.
assert all(
    {"quantity_mg", "dilution_factor", "stock_volume_ml", "purity_percent", "concentration_ug_ml"}
    <= set(c["expected"])
    for c in GOLDEN["cases"]
), "every golden case must carry all five expected keys"

FLAGGED = set(GOLDEN["flagged"])


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
    # sign-off. The fixture's `expected` still holds what the old engine gave.
    case = _case(case_id)
    result = process_hplc_analysis(_input_from(case))
    assert result["quantity_mg"] is None
    assert result["calculation_trace"]["dilution"]["problem"] is not None
    assert case["expected"]["quantity_mg"] is not None   # it used to produce a number


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
