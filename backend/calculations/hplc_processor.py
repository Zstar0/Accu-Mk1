"""
Full HPLC analysis pipeline.

Orchestrates purity, quantity, and identity calculations for peptide samples.
Takes parsed peak data + calibration curve + weight inputs and produces
all three results with a complete calculation trace for audit.
"""

from dataclasses import dataclass
from typing import Optional


@dataclass
class WeightInputs:
    """Five balance weights entered by the lab tech."""
    stock_vial_empty: float          # mg — vial + cap
    stock_vial_with_diluent: float   # mg — vial + cap + diluent
    dil_vial_empty: float            # mg — vial + cap
    dil_vial_with_diluent: float     # mg — vial + cap + diluent
    dil_vial_with_diluent_and_sample: float  # mg — vial + cap + diluent + sample


@dataclass
class CalibrationParams:
    """Calibration curve parameters for quantity calculation."""
    slope: float
    intercept: float


@dataclass
class PeptideParams:
    """Peptide reference parameters for identity check."""
    reference_rt: Optional[float]
    rt_tolerance: float
    diluent_density: float  # mg/mL


@dataclass
class AnalysisInput:
    """All inputs needed for a full HPLC analysis."""
    # Parsed peak data per injection (list of dicts from parser)
    injections: list[dict]
    # Weights from balance
    weights: WeightInputs
    # Calibration curve
    calibration: CalibrationParams
    # Peptide reference
    peptide: PeptideParams


def calculate_dilution_factor(
    weights: WeightInputs, density: float
) -> dict:
    """
    Calculate dilution factor from 5 balance weights.

    Formula:
        diluent_vol = (dil_vial_with_diluent - dil_vial_empty) / density * 1000 [µL]
        sample_vol = (dil_vial_full - dil_vial_with_diluent) / density * 1000 [µL]
        DF = (diluent_vol + sample_vol) / sample_vol
        stock_vol = (stock_vial_diluent - stock_vial_empty) / 1000 [mL]

    Returns dict with all intermediate values for audit trace.
    """
    # Diluent volume in the dilution vial (µL)
    diluent_mass_mg = weights.dil_vial_with_diluent - weights.dil_vial_empty
    diluent_vol_ul = (diluent_mass_mg / density) * 1000

    # Sample volume added to the dilution vial (µL)
    sample_mass_mg = weights.dil_vial_with_diluent_and_sample - weights.dil_vial_with_diluent
    sample_vol_ul = (sample_mass_mg / density) * 1000

    # Dilution factor
    total_vol_ul = diluent_vol_ul + sample_vol_ul
    dilution_factor = total_vol_ul / sample_vol_ul if sample_vol_ul > 0 else 0

    # Stock volume (mL) — from stock vial weights, using diluent density
    stock_mass_mg = weights.stock_vial_with_diluent - weights.stock_vial_empty
    stock_volume_ml = stock_mass_mg / density  # Convert mg to mL using diluent density (mg/mL)

    return {
        "diluent_mass_mg": round(diluent_mass_mg, 4),
        "diluent_vol_ul": round(diluent_vol_ul, 4),
        "sample_mass_mg": round(sample_mass_mg, 4),
        "sample_vol_ul": round(sample_vol_ul, 4),
        "total_vol_ul": round(total_vol_ul, 4),
        "dilution_factor": round(dilution_factor, 6),
        "stock_mass_mg": round(stock_mass_mg, 4),
        "stock_volume_ml": round(stock_volume_ml, 6),
    }


def calculate_purity_from_injections(injections: list[dict]) -> dict:
    """
    Calculate purity from injection data.

    Each injection dict should have 'peaks' list and 'main_peak_index'.
    Returns purity result with individual values.
    """
    values = []
    names = []

    for inj in injections:
        main_idx = inj.get("main_peak_index", -1)
        peaks = inj.get("peaks", [])
        if main_idx >= 0 and main_idx < len(peaks):
            area_pct = peaks[main_idx].get("area_percent", 0)
            values.append(area_pct)
            names.append(inj.get("injection_name", ""))

    if not values:
        return {"purity_percent": None, "individual_values": [], "error": "No main peaks found"}

    avg = sum(values) / len(values)

    rsd = None
    if len(values) > 1:
        mean = avg
        variance = sum((v - mean) ** 2 for v in values) / (len(values) - 1)
        std_dev = variance ** 0.5
        rsd = (std_dev / mean) * 100 if mean != 0 else None

    return {
        "purity_percent": round(avg, 4),
        "individual_values": [round(v, 4) for v in values],
        "injection_names": names,
        "rsd_percent": round(rsd, 4) if rsd is not None else None,
    }


def calculate_quantity(
    injections: list[dict],
    calibration: CalibrationParams,
    dilution: dict,
) -> dict:
    """
    Calculate quantity (mass in mg) from peak areas.

    Steps:
    1. Average main peak areas across injections
    2. Solve calibration equation: Conc = (avg_area - intercept) / slope
    3. Apply dilution factor: undiluted_conc = conc * DF
    4. Calculate mass: mass_mg = undiluted_conc * stock_vol / 1000

    Returns quantity result with calculation trace.
    """
    areas = []
    for inj in injections:
        main_idx = inj.get("main_peak_index", -1)
        peaks = inj.get("peaks", [])
        if main_idx >= 0 and main_idx < len(peaks):
            areas.append(peaks[main_idx].get("area", 0))

    if not areas:
        return {"quantity_mg": None, "error": "No main peak areas found"}

    avg_area = sum(areas) / len(areas)

    # Solve calibration equation: Area = slope * Conc + intercept
    # => Conc = (Area - intercept) / slope
    if calibration.slope == 0:
        return {"quantity_mg": None, "error": "Calibration slope is zero"}

    concentration = (avg_area - calibration.intercept) / calibration.slope  # µg/mL

    # Apply dilution factor
    undiluted_conc = concentration * dilution["dilution_factor"]  # µg/mL in stock

    # Mass = undiluted_conc (µg/mL) * stock_volume (mL) / 1000 (µg→mg)
    stock_vol = dilution["stock_volume_ml"]
    mass_ug = undiluted_conc * stock_vol
    mass_mg = mass_ug / 1000

    return {
        "quantity_mg": round(mass_mg, 4),
        "individual_areas": [round(a, 4) for a in areas],
        "avg_main_peak_area": round(avg_area, 4),
        "concentration_ug_ml": round(concentration, 4),
        "undiluted_concentration_ug_ml": round(undiluted_conc, 4),
        "mass_ug": round(mass_ug, 4),
        "stock_volume_ml": round(stock_vol, 6),
        "dilution_factor": round(dilution["dilution_factor"], 6),
        "calibration_slope": calibration.slope,
        "calibration_intercept": calibration.intercept,
    }


def calculate_identity(
    injections: list[dict],
    peptide: PeptideParams,
) -> dict:
    """
    Check identity by comparing sample RT to reference RT.

    CONFORMS if |avg_sample_RT - reference_RT| <= tolerance.

    Returns identity result with RT comparison details.
    """
    if peptide.reference_rt is None:
        return {
            "conforms": None,
            "error": "No reference RT set for this peptide",
        }

    rts = []
    for inj in injections:
        main_idx = inj.get("main_peak_index", -1)
        peaks = inj.get("peaks", [])
        if main_idx >= 0 and main_idx < len(peaks):
            rts.append(peaks[main_idx].get("retention_time", 0))

    if not rts:
        return {"conforms": None, "error": "No main peak RTs found"}

    avg_rt = sum(rts) / len(rts)
    delta = abs(avg_rt - peptide.reference_rt)
    conforms = delta <= peptide.rt_tolerance

    return {
        "conforms": conforms,
        "sample_rt": round(avg_rt, 4),
        "reference_rt": peptide.reference_rt,
        "rt_delta": round(delta, 4),
        "rt_tolerance": peptide.rt_tolerance,
        "individual_rts": [round(rt, 4) for rt in rts],
    }


def process_hplc_analysis(input_data: AnalysisInput) -> dict:
    """
    Run the full HPLC analysis pipeline.

    Returns a dict with purity, quantity, identity results
    and a complete calculation trace for audit.
    """
    trace = {}

    # Step 1: Dilution factor from weights
    dilution = calculate_dilution_factor(input_data.weights, input_data.peptide.diluent_density)
    trace["dilution"] = dilution

    # Step 2: Purity (Area% averaging)
    purity = calculate_purity_from_injections(input_data.injections)
    trace["purity"] = purity

    # Step 3: Quantity (calibration curve + dilution)
    quantity = calculate_quantity(
        input_data.injections, input_data.calibration, dilution
    )
    trace["quantity"] = quantity

    # Step 4: Identity (RT matching)
    identity = calculate_identity(input_data.injections, input_data.peptide)
    trace["identity"] = identity

    return {
        "purity_percent": purity.get("purity_percent"),
        "quantity_mg": quantity.get("quantity_mg"),
        "identity_conforms": identity.get("conforms"),
        "identity_rt_delta": identity.get("rt_delta"),
        "dilution_factor": dilution.get("dilution_factor"),
        "stock_volume_ml": dilution.get("stock_volume_ml"),
        "avg_main_peak_area": quantity.get("avg_main_peak_area"),
        "concentration_ug_ml": quantity.get("concentration_ug_ml"),
        "calculation_trace": trace,
    }
