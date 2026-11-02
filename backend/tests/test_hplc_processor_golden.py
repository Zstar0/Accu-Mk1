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


@pytest.mark.parametrize("case", GOLDEN["cases"], ids=lambda c: c["id"])
def test_engine_reproduces_captured_output(case):
    result = process_hplc_analysis(_input_from(case))
    # The whole dict, so a failure shows every key that moved, and a key added
    # to the fixture later is pinned without touching this test.
    assert {key: result[key] for key in case["expected"]} == case["expected"]


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
