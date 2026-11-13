"""Method run parameters (endo worksheet v2, spec 2026-10-10 section 3.4).

Stored on hplc_methods.run_parameters, keyed by block so validation never
depends on the free-text technique:

    {"endotoxin": {"std_total_dilution": 250, "recon_water_ml": 2,
                   "spike_recovery_min_pct": 50, "spike_recovery_max_pct": 200,
                   "cv_limit_pct": 25},
     "hplc": {"default_target_ug_ml": 200, "floor_ug_ml": 60, ...}}

Either block may be present alone. Every key is optional; a missing key means
the default below (Dennis's values for endotoxin, the HPLC prep worksheet's
for hplc). Content-locked with the method's other fields (main.py
METHOD_LOCKED_FIELDS).
"""
from typing import Optional

from calculations.hplc_processor import (
    BAC_STOCK_UG_ML,
    BENZYL_ALCOHOL_DENSITY,
    DILUENT_DENSITY_MG_ML,
)
from catalog.consumables import is_positive_finite_number

ENDO_RUN_PARAM_DEFAULTS = {
    "std_total_dilution": 250,
    "recon_water_ml": 2,
    "spike_recovery_min_pct": 50,
    "spike_recovery_max_pct": 200,
    "cv_limit_pct": 25,
}

# The standard step 1 at 1:10 times the fixed step 3 at 1:2.
MIN_STD_TOTAL_DILUTION = 20

# The HPLC prep worksheet's defaults. The densities and the bac stock are the
# results engine's own constants, so the worksheet and the engine agree.
HPLC_RUN_PARAM_DEFAULTS = {
    "default_target_ug_ml": 200,
    "intermediate_target_ug_ml": 5000,
    "intermediate_volume_ul": 1500,
    "two_step_threshold_mg": 500,
    "bac_stock_ug_ml": BAC_STOCK_UG_ML,
    "bac_target_ug_ml": 500,
    "capsule_neat_max_ug_ml": 350,
    "diluent_density_mg_ml": DILUENT_DENSITY_MG_ML,
    "benzyl_alcohol_density_mg_ml": BENZYL_ALCOHOL_DENSITY,
    "floor_ug_ml": 60,
    "target_volume_ul": 1500,
    "sample_diluent_ul": 3000,
    "volume_tolerance_pct": 15,
}


def hplc_run_params(run_params: Optional[dict]) -> dict:
    """A method's stored run_parameters ({"hplc": {...}} or None) with every
    missing or null hplc key at its default: the HPLC twin of
    worksheets_endo.endo_run_params."""
    stored = (run_params or {}).get("hplc") or {}
    return {**HPLC_RUN_PARAM_DEFAULTS, **{k: v for k, v in stored.items() if v is not None}}


def _clean_block(name: str, block, defaults: dict) -> dict:
    """The block's non-null keys, each a positive finite number, or raise."""
    if not isinstance(block, dict):
        raise ValueError(f"run_parameters.{name} must be an object")
    unknown = sorted(set(block) - set(defaults))
    if unknown:
        raise ValueError(f"unknown {name} run parameter(s): {', '.join(unknown)}")
    clean = {}
    for key, v in block.items():
        if v is None:
            continue
        if not is_positive_finite_number(v):
            raise ValueError(f"{name}.{key} must be a positive number")
        clean[key] = v
    return clean


def _clean_hplc(block) -> dict:
    clean = _clean_block("hplc", block, HPLC_RUN_PARAM_DEFAULTS)
    effective = {**HPLC_RUN_PARAM_DEFAULTS, **clean}
    if effective["floor_ug_ml"] >= effective["default_target_ug_ml"]:
        raise ValueError("hplc.floor_ug_ml must be below default_target_ug_ml "
                         f"(effective {effective['floor_ug_ml']} and "
                         f"{effective['default_target_ug_ml']})")
    if effective["intermediate_target_ug_ml"] <= effective["default_target_ug_ml"]:
        raise ValueError("hplc.intermediate_target_ug_ml must be above default_target_ug_ml "
                         f"(effective {effective['intermediate_target_ug_ml']} and "
                         f"{effective['default_target_ug_ml']})")
    if effective["volume_tolerance_pct"] > 100:
        raise ValueError("hplc.volume_tolerance_pct must be at most 100 "
                         f"(effective {effective['volume_tolerance_pct']})")
    return clean


def validate_run_parameters(value: Optional[dict]) -> Optional[dict]:
    """Return the value to store, or raise ValueError naming the problem.
    None clears. A key sent as null means "use the default" and is dropped;
    a block left empty is dropped, and nothing left at all stores None."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("run_parameters must be an object")
    unknown = sorted(set(value) - set(_BLOCK_CLEANERS))
    if unknown:
        raise ValueError(f"unknown run_parameters block(s): {', '.join(unknown)}")
    out = {}
    for name, clean_block in _BLOCK_CLEANERS.items():
        block = value.get(name)
        if block is None:
            continue
        clean = clean_block(block)
        if clean:
            out[name] = clean
    return out or None


def _clean_endotoxin(block) -> dict:
    clean = _clean_block("endotoxin", block, ENDO_RUN_PARAM_DEFAULTS)
    effective = {**ENDO_RUN_PARAM_DEFAULTS, **clean}
    if effective["spike_recovery_min_pct"] >= effective["spike_recovery_max_pct"]:
        raise ValueError("endotoxin.spike_recovery_min_pct must be below spike_recovery_max_pct "
                         f"(effective {effective['spike_recovery_min_pct']} and "
                         f"{effective['spike_recovery_max_pct']})")
    if effective["std_total_dilution"] < MIN_STD_TOTAL_DILUTION:
        raise ValueError(f"endotoxin.std_total_dilution must be at least {MIN_STD_TOTAL_DILUTION} "
                         "(step 1 at 1:10 times step 3 at 1:2)")
    return clean


_BLOCK_CLEANERS = {"endotoxin": _clean_endotoxin, "hplc": _clean_hplc}
