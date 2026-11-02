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
    stock_vial_empty: float          # mg, vial + cap
    stock_vial_with_diluent: float   # mg, vial + cap + diluent
    dil_vial_empty: float            # mg, vial + cap
    dil_vial_with_diluent: float     # mg, vial + cap + diluent
    dil_vial_with_diluent_and_sample: float  # mg, vial + cap + diluent + sample


@dataclass
class IntermediateWeights:
    """Three balance weights for the intermediate vial of a two-step dilution.

    All Optional: a declared intermediate can be partly weighed, and the engine
    must refuse that state rather than crash on it.
    """
    int_vial_empty: Optional[float]                    # mg, vial + cap
    int_vial_with_diluent: Optional[float]             # mg, vial + cap + diluent
    int_vial_with_diluent_and_sample: Optional[float]  # mg, vial + cap + diluent + stock


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
    # Phase 13: standard injection RT override
    standard_injection_rt: Optional[float] = None
    standard_injection_source: Optional[str] = None  # e.g. "P-0111"


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
    # Intermediate vial of a two-step dilution; None for the usual one-step prep
    intermediate: Optional[IntermediateWeights] = None


def _round_or_none(value: Optional[float], places: int) -> Optional[float]:
    return None if value is None else round(value, places)


def calculate_intermediate(
    weights: IntermediateWeights,
    stock_conc_ug_ml: Optional[float],
    density: Optional[float],
) -> dict:
    """
    The intermediate vial of a two-step dilution, from its three weighings.

    Mirrors calc.js dilutionActual (the bench sheet's own arithmetic), with the
    same asymmetric thresholds as the dilution vial in calculate_dilution_factor:

        "diluent"  diluent added is < 0 (zero is a legal neat transfer)
        "stock"    stock added is <= 0

    A weighing that was not made leaves the volumes that need it None and is NOT a
    problem: "dilution_factor" is then None with "problem" None, which the caller
    reads as unweighed. Under a problem the two leg volumes stay, so a tech can see
    them, and everything worked out from them is None.

    "dilution_factor" is total volume / stock volume and never uses the stock
    concentration, which only gives "actual_conc_ug_ml" (None when it is unknown).
    Rounding matches calculate_dilution_factor, place for place: volumes to 4, the
    factor to 6, and the concentration to 4 as quantity's concentrations are.
    """
    def volume_ul(heavier: Optional[float], lighter: Optional[float]) -> Optional[float]:
        if heavier is None or lighter is None or not density:
            return None
        return (heavier - lighter) / density * 1000

    diluent_vol_ul = volume_ul(weights.int_vial_with_diluent, weights.int_vial_empty)
    stock_vol_ul = volume_ul(weights.int_vial_with_diluent_and_sample, weights.int_vial_with_diluent)

    problem = None
    if diluent_vol_ul is not None and diluent_vol_ul < 0:
        problem = "diluent"
    elif stock_vol_ul is not None and stock_vol_ul <= 0:
        problem = "stock"

    total_vol_ul = None
    if diluent_vol_ul is not None and stock_vol_ul is not None and not problem:
        total_vol_ul = diluent_vol_ul + stock_vol_ul

    # Past the guards above, a total means stock_vol_ul > 0, so neither division can fail.
    dilution_factor = None if total_vol_ul is None else total_vol_ul / stock_vol_ul
    actual_conc_ug_ml = None
    if total_vol_ul is not None and stock_conc_ug_ml is not None:
        actual_conc_ug_ml = stock_conc_ug_ml * stock_vol_ul / total_vol_ul

    return {
        "diluent_vol_ul": _round_or_none(diluent_vol_ul, 4),
        "stock_vol_ul": _round_or_none(stock_vol_ul, 4),
        "total_vol_ul": _round_or_none(total_vol_ul, 4),
        "actual_conc_ug_ml": _round_or_none(actual_conc_ug_ml, 4),
        "dilution_factor": _round_or_none(dilution_factor, 6),
        "problem": problem,
    }


def calculate_dilution_factor(
    weights: WeightInputs,
    density: float,
    intermediate: Optional[IntermediateWeights] = None,
) -> dict:
    """
    Calculate dilution factor from 5 balance weights.

    Formula:
        diluent_vol = (dil_vial_with_diluent - dil_vial_empty) / density * 1000 [µL]
        sample_vol = (dil_vial_full - dil_vial_with_diluent) / density * 1000 [µL]
        DF = (diluent_vol + sample_vol) / sample_vol
        stock_vol = (stock_vial_diluent - stock_vial_empty) / 1000 [mL]

    Returns dict with all intermediate values for audit trace, plus "problem":
    None when every weighing is usable, else which one is not. The checks are by
    ROLE (which weighing is which), never by time order, and they are asymmetric
    on purpose (the thresholds are calc.js's stockPrep and dilutionActual):

        "stock_diluent"  stock vial leg (with diluent - empty) is <= 0
        "diluent"        diluent added to the dilution vial is < 0
        "stock"          stock added to the dilution vial is <= 0

    Zero added diluent is a legal neat injection; zero added stock is not. When
    several apply, the first listed wins. Under any problem "dilution_factor" and
    "stock_volume_ml" are None, so no quantity can be computed from the row.

    A two-step dilution declares an intermediate vial (calculate_intermediate), and
    "dilution_factor" stays the final step's factor. "dilution_factor_total" is the
    factor from the stock vial to the final vial: the final step's when there is no
    intermediate, else the product of the two steps, each rounded to 6 places before
    they are multiplied and the product rounded to 6 again. "intermediate" is the
    calculate_intermediate dict, or None. The intermediate adds problems, reported
    only when none of the above applies:

        "intermediate_diluent"    its added diluent is < 0
        "intermediate_stock"      its added stock is <= 0
        "intermediate_unweighed"  declared, but not every weighing was made

    The unweighed case never falls back to the bench sheet's planned target
    concentration (its concForFinal): that is display before the balance, and a
    quantity from a plan rather than a reading would be a made-up result. So
    "dilution_factor_total" is None exactly when "problem" is set.
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

    # Dilution-leg problems. Every prep form ends in a dilution vial, so these two
    # stay here.
    dilution_problem = None
    if diluent_mass_mg < 0:
        dilution_problem = "diluent"
    elif sample_mass_mg <= 0:
        dilution_problem = "stock"

    # Stock volume (mL), from stock vial weights, using diluent density.
    # The stock-leg problem is decided HERE and nowhere else: it is the one check
    # that moves out when prep forms arrive (a liquid prep never weighs its stock
    # vial, so its leg is always zero and must not be flagged).
    stock_mass_mg = weights.stock_vial_with_diluent - weights.stock_vial_empty
    stock_volume_ml = stock_mass_mg / density  # Convert mg to mL using diluent density (mg/mL)
    stock_problem = "stock_diluent" if stock_mass_mg <= 0 else None

    # The intermediate vial, when one is declared. Its stock concentration is not
    # known here (that needs the declared mass), and the factor does not use it.
    intermediate_result = None
    intermediate_problem = None
    if intermediate is not None:
        intermediate_result = calculate_intermediate(intermediate, None, density)
        if intermediate_result["problem"]:
            intermediate_problem = "intermediate_" + intermediate_result["problem"]
        elif intermediate_result["dilution_factor"] is None:
            intermediate_problem = "intermediate_unweighed"

    # Appended last, so a row with no intermediate reports what it always did and an
    # intermediate never displaces an existing problem.
    problem = stock_problem or dilution_problem or intermediate_problem

    result = {
        "diluent_mass_mg": round(diluent_mass_mg, 4),
        "diluent_vol_ul": round(diluent_vol_ul, 4),
        "sample_mass_mg": round(sample_mass_mg, 4),
        "sample_vol_ul": round(sample_vol_ul, 4),
        "total_vol_ul": round(total_vol_ul, 4),
        "dilution_factor": None if problem else round(dilution_factor, 6),
        "stock_mass_mg": round(stock_mass_mg, 4),
        "stock_volume_ml": None if problem else round(stock_volume_ml, 6),
        "problem": problem,
    }

    # Total factor, stock vial to final vial. Each step is already rounded to 6
    # places above, so multiply the rounded steps and round the product: the same
    # order calculate_quantity's chain has always used. With no intermediate the
    # total is the final step's factor, untouched.
    total = result["dilution_factor"]
    if total is not None and intermediate_result is not None:
        total = round(intermediate_result["dilution_factor"] * total, 6)
    result["dilution_factor_total"] = total
    result["intermediate"] = intermediate_result
    return result


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

    Returns quantity result with calculation trace. A weighing problem from
    calculate_dilution_factor gives no quantity, never a number computed from a
    bad weighing: "quantity_mg" is None and "error" names the problem. What does
    not depend on the weighings is still returned (areas, calibration, and the
    concentration, which is (avg_area - intercept) / slope), so the trace stays
    readable and a recapture can still rebuild the row's inputs from it.
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

    problem = dilution.get("problem")
    if problem:
        # No dilution factor or stock volume, so no undiluted concentration or mass.
        return {
            "quantity_mg": None,
            "error": problem,
            "individual_areas": [round(a, 4) for a in areas],
            "avg_main_peak_area": round(avg_area, 4),
            "concentration_ug_ml": round(concentration, 4),
            "calibration_slope": calibration.slope,
            "calibration_intercept": calibration.intercept,
        }

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

    Phase 13: Prefers standard_injection_rt when available (same-method comparison,
    delta ~0.02 min). Falls back to calibration curve reference_rt when not provided
    (may be from a different method, delta can exceed 6 min causing false failures).

    Returns identity result with RT comparison details and reference source tracking.
    """
    # Phase 13: prefer standard injection RT over calibration curve reference RT
    effective_rt = (
        peptide.standard_injection_rt
        if peptide.standard_injection_rt is not None
        else peptide.reference_rt
    )
    reference_source = (
        "standard_injection"
        if peptide.standard_injection_rt is not None
        else "calibration_curve"
    )

    if effective_rt is None:
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
    delta = abs(avg_rt - effective_rt)
    conforms = delta <= peptide.rt_tolerance

    return {
        "conforms": conforms,
        "sample_rt": round(avg_rt, 4),
        "reference_rt": effective_rt,  # The RT actually used for comparison
        "rt_delta": round(delta, 4),
        "rt_tolerance": peptide.rt_tolerance,
        "individual_rts": [round(rt, 4) for rt in rts],
        # Phase 13: source tracking
        "reference_source": reference_source,
        "reference_source_id": peptide.standard_injection_source,
        "calibration_curve_rt": peptide.reference_rt,  # Always included for audit
    }


def process_hplc_analysis(input_data: AnalysisInput) -> dict:
    """
    Run the full HPLC analysis pipeline.

    Returns a dict with purity, quantity, identity results
    and a complete calculation trace for audit.
    """
    trace = {}

    # Step 1: Dilution factor from weights
    dilution = calculate_dilution_factor(
        input_data.weights,
        input_data.peptide.diluent_density,
        intermediate=input_data.intermediate,
    )
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
