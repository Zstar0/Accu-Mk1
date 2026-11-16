"""The hplc block in method run parameters (plan 2026-11-12 hplc prep rules, task 1). Pure."""
import json
from pathlib import Path

import pytest

from calculations import hplc_processor
from catalog.method_run_params import (
    HPLC_RUN_PARAM_DEFAULTS,
    hplc_run_params,
    validate_run_parameters,
)

DEFAULTS_FIXTURE = Path(__file__).parent / "fixtures" / "hplc_run_param_defaults.json"


def test_defaults_are_the_shared_fixtures():
    # The TypeScript table (src/lib/hplc-run-params.ts) is held to the same file.
    fixture = json.loads(DEFAULTS_FIXTURE.read_text(encoding="utf-8"))["defaults"]
    assert HPLC_RUN_PARAM_DEFAULTS == fixture
    assert list(HPLC_RUN_PARAM_DEFAULTS) == list(fixture)


def test_defaults_are_the_engines_own_constants():
    assert HPLC_RUN_PARAM_DEFAULTS["diluent_density_mg_ml"] == hplc_processor.DILUENT_DENSITY_MG_ML
    assert HPLC_RUN_PARAM_DEFAULTS["benzyl_alcohol_density_mg_ml"] == hplc_processor.BENZYL_ALCOHOL_DENSITY
    assert HPLC_RUN_PARAM_DEFAULTS["bac_stock_ug_ml"] == hplc_processor.BAC_STOCK_UG_ML


def test_intermediate_target_is_5000_not_the_volume():
    assert HPLC_RUN_PARAM_DEFAULTS["intermediate_target_ug_ml"] == 5000
    assert HPLC_RUN_PARAM_DEFAULTS["intermediate_volume_ul"] == 1500


def test_missing_and_null_keys_take_the_default():
    assert hplc_run_params(None) == HPLC_RUN_PARAM_DEFAULTS
    assert hplc_run_params({"hplc": {"floor_ug_ml": None}})["floor_ug_ml"] == 60
    assert hplc_run_params({"hplc": {"floor_ug_ml": 40}})["floor_ug_ml"] == 40


def test_both_blocks_survive_a_save():
    out = validate_run_parameters({"endotoxin": {"cv_limit_pct": 20}, "hplc": {"floor_ug_ml": 40}})
    assert out == {"endotoxin": {"cv_limit_pct": 20}, "hplc": {"floor_ug_ml": 40}}


def test_null_keys_and_empty_blocks_are_dropped():
    assert validate_run_parameters({"hplc": {"floor_ug_ml": None}}) is None
    assert validate_run_parameters({"endotoxin": {}, "hplc": {"floor_ug_ml": 40}}) == {"hplc": {"floor_ug_ml": 40}}


def test_unknown_keys_are_refused_by_name():
    with pytest.raises(ValueError, match="unknown hplc run parameter\\(s\\): nope"):
        validate_run_parameters({"hplc": {"nope": 1}})
    with pytest.raises(ValueError, match="unknown run_parameters block\\(s\\): pcr"):
        validate_run_parameters({"pcr": {}})


def test_values_must_be_positive_finite():
    for bad in (0, -1, float("inf"), float("nan"), "200", True):
        with pytest.raises(ValueError, match="hplc.default_target_ug_ml must be a positive number"):
            validate_run_parameters({"hplc": {"default_target_ug_ml": bad}})


def test_cross_field_rules_read_effective_values():
    # a floor at or above the target can never be met
    with pytest.raises(ValueError, match="hplc.floor_ug_ml must be below default_target_ug_ml"):
        validate_run_parameters({"hplc": {"floor_ug_ml": 200}})
    # an intermediate weaker than the final target cannot be diluted down to it
    with pytest.raises(ValueError, match="hplc.intermediate_target_ug_ml must be above default_target_ug_ml"):
        validate_run_parameters({"hplc": {"intermediate_target_ug_ml": 150}})
    with pytest.raises(ValueError, match="hplc.volume_tolerance_pct must be at most 100"):
        validate_run_parameters({"hplc": {"volume_tolerance_pct": 150}})


def test_endotoxin_alone_validates_exactly_as_before():
    assert validate_run_parameters({"endotoxin": {"cv_limit_pct": 20}}) == {"endotoxin": {"cv_limit_pct": 20}}
    assert validate_run_parameters({"endotoxin": None}) is None
