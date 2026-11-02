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
"""
import json
from pathlib import Path

import pytest

from calculations.hplc_processor import (
    AnalysisInput,
    CalibrationParams,
    PeptideParams,
    WeightInputs,
    process_hplc_analysis,
)

FIXTURES = Path(__file__).parent / "fixtures"
GOLDEN = json.loads((FIXTURES / "hplc_engine_golden.json").read_text(encoding="utf-8"))


def _input_from(case):
    """The engine input a case describes. Keep identical to input_from_case in
    scripts/capture_hplc_golden.py: the pin only means something if this feeds
    the engine exactly what the capture fed it."""
    injections = []
    for i, area in enumerate(case["areas"]):
        peak = {"area": area}
        if case["area_percents"] is not None:
            peak["area_percent"] = case["area_percents"][i]
        if case["retention_times"] is not None:
            peak["retention_time"] = case["retention_times"][i]
        injections.append({"peaks": [peak], "main_peak_index": 0})
    return AnalysisInput(
        injections=injections,
        weights=WeightInputs(**case["weights"]),
        calibration=CalibrationParams(slope=case["slope"], intercept=case["intercept"]),
        # No reference RT, so identity is not computed or pinned here.
        peptide=PeptideParams(reference_rt=None, rt_tolerance=0.5, diluent_density=case["diluent_density"]),
    )


@pytest.mark.parametrize("case", GOLDEN["cases"], ids=lambda c: c["id"])
def test_engine_reproduces_captured_output(case):
    result = process_hplc_analysis(_input_from(case))
    for key in ("quantity_mg", "dilution_factor", "stock_volume_ml",
                "purity_percent", "concentration_ug_ml"):
        assert result[key] == case["expected"][key]


def test_golden_fixture_is_not_empty():
    assert len(GOLDEN["cases"]) >= 150
