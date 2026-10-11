"""Method run parameters (endo worksheet v2, spec 2026-10-10 section 3.4).

Stored on hplc_methods.run_parameters, keyed by block so validation never
depends on the free-text technique:

    {"endotoxin": {"std_total_dilution": 250, "recon_water_ml": 2,
                   "spike_recovery_min_pct": 50, "spike_recovery_max_pct": 200,
                   "cv_limit_pct": 25}}

Every key is optional; a missing key means Dennis's value below. Content-locked
with the method's other fields (main.py METHOD_LOCKED_FIELDS).
"""
import math
from typing import Optional

ENDO_RUN_PARAM_DEFAULTS = {
    "std_total_dilution": 250,
    "recon_water_ml": 2,
    "spike_recovery_min_pct": 50,
    "spike_recovery_max_pct": 200,
    "cv_limit_pct": 25,
}

# The standard step 1 at 1:10 times the fixed step 3 at 1:2.
MIN_STD_TOTAL_DILUTION = 20


def validate_run_parameters(value: Optional[dict]) -> Optional[dict]:
    """Return the value to store, or raise ValueError naming the problem.
    None clears. A key sent as null means "use the default" and is dropped;
    a block left empty is dropped, and nothing left at all stores None."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("run_parameters must be an object")
    unknown = sorted(set(value) - {"endotoxin"})
    if unknown:
        raise ValueError(f"unknown run_parameters block(s): {', '.join(unknown)}")
    block = value.get("endotoxin")
    if block is None:
        return None
    if not isinstance(block, dict):
        raise ValueError("run_parameters.endotoxin must be an object")
    unknown = sorted(set(block) - set(ENDO_RUN_PARAM_DEFAULTS))
    if unknown:
        raise ValueError(f"unknown endotoxin run parameter(s): {', '.join(unknown)}")
    clean = {}
    for key, v in block.items():
        if v is None:
            continue
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v <= 0:
            raise ValueError(f"endotoxin.{key} must be a positive number")
        clean[key] = v
    effective = {**ENDO_RUN_PARAM_DEFAULTS, **clean}
    if effective["spike_recovery_min_pct"] >= effective["spike_recovery_max_pct"]:
        raise ValueError("endotoxin.spike_recovery_min_pct must be below spike_recovery_max_pct "
                         f"(effective {effective['spike_recovery_min_pct']} and "
                         f"{effective['spike_recovery_max_pct']})")
    if effective["std_total_dilution"] < MIN_STD_TOTAL_DILUTION:
        raise ValueError(f"endotoxin.std_total_dilution must be at least {MIN_STD_TOTAL_DILUTION} "
                         "(step 1 at 1:10 times step 3 at 1:2)")
    return {"endotoxin": clean} if clean else None
