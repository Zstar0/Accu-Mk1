"""
Full HPLC analysis pipeline.

Orchestrates purity, quantity, and identity calculations for peptide samples.
Takes parsed peak data + calibration curve + weight inputs and produces
all three results with a complete calculation trace for audit.
"""

import math
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


def _finite(value: Optional[float]) -> bool:
    """A number the arithmetic can use: not None, not NaN, not infinite (calc.js num())."""
    return value is not None and math.isfinite(value)


# The prep forms the engine understands. The endo bench accepts the same three
# (worksheets_endo.ENDO_FORMS); a test pins that set(ENDO_FORMS) <= set(PREP_FORMS)
# instead of importing the tuple, because worksheets_endo imports models and this
# module is the lower layer.
PREP_FORMS = ("powder", "liquid", "bac")

DILUENT_DENSITY_MG_ML = 997.1     # calc.js DEFAULTS.diluentDensityMgPerMl
BENZYL_ALCOHOL_DENSITY = 1034.72  # calc.js benzylAlcoholDensity() default
BAC_STOCK_UG_ML = 9000.0          # 0.9 % benzyl alcohol, calc.js DEFAULTS.bacWaterStockUgPerMl


def bac_volume_ml(
    mass_mg: Optional[float],
    water_density: Optional[float] = DILUENT_DENSITY_MG_ML,
    ba_density: float = BENZYL_ALCOHOL_DENSITY,
    bac_stock_ug_ml: float = BAC_STOCK_UG_ML,
) -> Optional[float]:
    """
    The volume of bacteriostatic water in a vial from its mass (calc.js bacVolumeMl).

    The liquid is water with benzyl alcohol at c mg/mL. Benzyl alcohol (1034.72 mg/mL)
    is DENSER than the water (997.1), so the mixture is denser and a given mass
    occupies slightly LESS volume than mass / water_density (a 0.03 % correction):

        mass = c*V + rho_w*(V - c*V/rho_BA)   =>   V = (mass / rho_w) / (1 - c/rho_BA + c/rho_w)

    with c = bac_stock_ug_ml / 1000 (9 mg/mL at 0.9 %). The mass is the same stock
    vial difference powder weighs. None for no mass or a mass of 0 or less, a density
    that is missing, not finite or 0 or less (calc.js num() reads non-finite as null),
    or a stock that makes the correction non-positive.
    """
    if not (_finite(mass_mg) and mass_mg > 0 and _finite(water_density) and water_density > 0
            and _finite(ba_density) and ba_density > 0):
        return None
    c = bac_stock_ug_ml / 1000  # mg/mL
    correction = 1 - c / ba_density + c / water_density
    if not correction > 0:  # not "<= 0": a NaN stock must be refused too
        return None
    return (mass_mg / water_density) / correction


def stock_volume_ml(
    form: str,
    weights: WeightInputs,
    density: Optional[float],
    *,
    declared_volume_ml: Optional[float] = None,
    ba_density: float = BENZYL_ALCOHOL_DENSITY,
    bac_stock_ug_ml: float = BAC_STOCK_UG_ML,
) -> tuple[Optional[float], Optional[str]]:
    """
    The stock volume (mL) for one prep form, and why not when it cannot be had.

    Returns (volume_ml, problem); exactly one of the two is None. The forms differ
    only in how the volume is obtained (calc.js stockPrep):

        "powder"  weighed: (stock vial with diluent - stock vial empty) / density
        "bac"     the same mass, density corrected for 0.9 % benzyl alcohol
        "liquid"  the customer's declared volume, taken as declared. The stock vial
                  is never weighed, so its weighings are not read at all

    Problems, and the stock-leg problem is decided HERE and nowhere else:

        "stock_diluent"       powder or bac: the stock vial leg is <= 0 or not finite
                              (calc.js guards this with !preDissolved, so "liquid"
                              never raises it: its stock leg is zero on every real row)
        "no_density"          powder or bac: the diluent density is missing, not finite
                              or <= 0
        "no_declared_volume"  liquid: no declared volume, or one that is <= 0 or not
                              finite

    The weighing is checked before the density, so a bench reading is never hidden
    behind a configuration gap. The volume is returned unrounded; the caller rounds.
    An unknown form raises ValueError naming the accepted list.
    """
    if form not in PREP_FORMS:
        raise ValueError(f"prep form must be one of {', '.join(PREP_FORMS)}")

    if form == "liquid":
        if _finite(declared_volume_ml) and declared_volume_ml > 0:
            return declared_volume_ml, None
        return None, "no_declared_volume"

    mass_mg = weights.stock_vial_with_diluent - weights.stock_vial_empty
    if not _finite(mass_mg) or mass_mg <= 0:
        return None, "stock_diluent"
    if not _finite(density) or density <= 0:
        return None, "no_density"

    if form == "bac":
        volume = bac_volume_ml(mass_mg, density, ba_density, bac_stock_ug_ml)
    else:
        volume = mass_mg / density  # mg / (mg/mL) = mL
    # bac_volume_ml refuses only what was checked above or an overridden benzyl alcohol
    # density or stock that makes the correction meaningless; either way it is a
    # density-side gap, not a bench reading.
    return (None, "no_density") if volume is None else (volume, None)


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

    When both apply, "diluent" wins, as in calc.js. In real production data a leg
    that is zero or negative is an UNENTERED weighing, not a reversed one: the
    reading was never typed in.

    Only a missing weighing counts as unweighed. A weighing that is None, or not a
    finite number (NaN, infinity: calc.js num() reads those as null too), leaves the
    volumes that need it None and is NOT a problem: "dilution_factor" is then None
    with "problem" None, which the caller reads as unweighed. The same goes for a
    density that is None, zero or not finite. Under a problem the two leg volumes
    stay, so a tech can see them, and everything worked out from them is None.

    THE CALLER'S OBLIGATION: a blank weighing must arrive as None, never as 0. A
    blank that arrives as 0.0 is not read as unweighed. An empty added-stock or
    added-diluent leg surfaces as the problem "stock" or "diluent", and an unentered
    TARE of 0.0 computes with no problem at all (the whole vial weight reads as
    diluent and the factor comes out far too high). calc.js does exactly the same,
    so this mirrors it rather than regressing from it; the guard is at the request
    boundary, not here.

    "dilution_factor" is total volume / stock volume and never uses the stock
    concentration. That only gives "actual_conc_ug_ml", and the key is present only
    when a finite stock concentration was supplied: a missing key means "not asked
    for", a None value means "asked for and not determinable" (a problem, or
    unweighed). Rounding matches calculate_dilution_factor, place for place:
    volumes to 4, the factor to 6, and the concentration to 4 as quantity's
    concentrations are.
    """
    def volume_ul(heavier: Optional[float], lighter: Optional[float]) -> Optional[float]:
        if not (_finite(heavier) and _finite(lighter) and _finite(density)) or density == 0:
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

    result = {
        "diluent_vol_ul": _round_or_none(diluent_vol_ul, 4),
        "stock_vol_ul": _round_or_none(stock_vol_ul, 4),
        "total_vol_ul": _round_or_none(total_vol_ul, 4),
        "dilution_factor": _round_or_none(dilution_factor, 6),
        "problem": problem,
    }
    if _finite(stock_conc_ug_ml):
        actual_conc_ug_ml = None
        if total_vol_ul is not None:
            actual_conc_ug_ml = stock_conc_ug_ml * stock_vol_ul / total_vol_ul
        result["actual_conc_ug_ml"] = _round_or_none(actual_conc_ug_ml, 4)
    return result


def calculate_dilution_factor(
    weights: WeightInputs,
    density: Optional[float],
    intermediate: Optional[IntermediateWeights] = None,
    *,
    form: str = "powder",
    declared_volume_ml: Optional[float] = None,
) -> dict:
    """
    Calculate dilution factor from 5 balance weights.

    Formula:
        diluent_vol = (dil_vial_with_diluent - dil_vial_empty) / density * 1000 [µL]
        sample_vol = (dil_vial_full - dil_vial_with_diluent) / density * 1000 [µL]
        DF = (diluent_vol + sample_vol) / sample_vol
        stock_vol = stock_volume_ml(form, ...) [mL]: weighed for "powder", density
            corrected for "bac", the declared volume for "liquid"

    Returns dict with all intermediate values for audit trace, plus "problem":
    None when every weighing is usable, else which one is not. The checks are by
    ROLE (which weighing is which), never by time order, and they are asymmetric
    on purpose (the thresholds are calc.js's stockPrep and dilutionActual):

        "stock_diluent"  stock vial leg (with diluent - empty) is <= 0
        "diluent"        diluent added to the dilution vial is < 0
        "stock"          stock added to the dilution vial is <= 0

    Zero added diluent is a legal neat injection; zero added stock is not. A leg
    that is not a finite number (NaN, infinity: calc.js num() reads those as null)
    counts as that leg's problem, and a leg so large its difference overflows is the
    same. The stock-leg code is decided by stock_volume_ml, which raises it for
    "powder" and "bac" only (a "liquid" stock vial is never weighed), and which adds
    "no_declared_volume" for a liquid row without a usable declared volume. A diluent
    density that is None, not finite or <= 0 is "no_density" (reported by the stock
    leg for powder and bac, and by the dilution vial for every form), so a nullable
    calibration column is a reason and not a ZeroDivisionError. When several apply,
    the first listed wins: the stock leg, then "diluent", then "stock", then
    "no_density", then the intermediate's codes below.

    EACH PROBLEM NULLS ONLY WHAT IT TOUCHES, and "problem" no longer says which
    values are None:

        stock leg           "stock_volume_ml" only
        final dilution leg  "dilution_factor", so also "dilution_factor_total"
        intermediate leg    "dilution_factor_total" alone

    The intermediate leg leaves the final vial's own weighings, and so its factor
    and the stock volume, intact: they are good numbers. "problem" is None exactly
    when "stock_volume_ml" and "dilution_factor_total" are both set, which is what
    calculate_quantity gates on: no quantity unless both are known. The audit values
    (masses, volumes) stay under a problem so a tech can see which weighing is wrong,
    except a number that cannot be made from a non-finite weighing, which is None
    rather than NaN so the stored trace stays valid JSON.

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

    In real production data a zero or negative intermediate leg is an UNENTERED
    weighing, not a reversed one. Only None (or a non-finite number) counts as
    unweighed, so THE CALLER'S OBLIGATION is that a blank intermediate weighing
    arrives as None, never as 0: a blank that arrives as 0.0 shows up as
    "intermediate_stock" or "intermediate_diluent" instead of
    "intermediate_unweighed", and an unentered tare of 0.0 computes with no problem
    at all. calc.js does the same; see calculate_intermediate.

    The unweighed case never falls back to the bench sheet's planned target
    concentration (its concForFinal): that is display before the balance, and a
    quantity from a plan rather than a reading would be a made-up result. So
    "dilution_factor_total" is None whenever the final or intermediate leg has a
    problem or is unweighed. Weighings so large that a volume overflows are bounded
    at the request boundary, not here.

    The stock concentration is not known here, so the stored "intermediate" dict
    has no "actual_conc_ug_ml" key. Its absence means "not computed here", not
    "unknown for this row".

    An unknown form raises ValueError (see stock_volume_ml).
    """
    density_ok = _finite(density) and density > 0

    # Diluent and sample masses in the dilution vial (mg). Every prep form ends in a
    # dilution vial, so its two problems are decided here, permanently.
    diluent_mass_mg = weights.dil_vial_with_diluent - weights.dil_vial_empty
    sample_mass_mg = weights.dil_vial_with_diluent_and_sample - weights.dil_vial_with_diluent

    # Volumes (µL), only from finite masses and a usable density.
    diluent_vol_ul = (diluent_mass_mg / density) * 1000 if density_ok and _finite(diluent_mass_mg) else None
    sample_vol_ul = (sample_mass_mg / density) * 1000 if density_ok and _finite(sample_mass_mg) else None

    # Dilution factor
    total_vol_ul = None
    dilution_factor = None
    if diluent_vol_ul is not None and sample_vol_ul is not None:
        total_vol_ul = diluent_vol_ul + sample_vol_ul
        dilution_factor = total_vol_ul / sample_vol_ul if sample_vol_ul > 0 else 0

    dilution_problem = None
    if not _finite(diluent_mass_mg) or diluent_mass_mg < 0:
        dilution_problem = "diluent"
    elif not _finite(sample_mass_mg) or sample_mass_mg <= 0:
        dilution_problem = "stock"
    elif not density_ok:
        dilution_problem = "no_density"

    # Stock volume (mL) for the prep form. The stock-leg problem is decided by
    # stock_volume_ml and nowhere else: a liquid prep never weighs its stock vial, so
    # its leg is always zero and must not be flagged.
    stock_mass_mg = weights.stock_vial_with_diluent - weights.stock_vial_empty
    stock_vol_ml, stock_problem = stock_volume_ml(
        form, weights, density, declared_volume_ml=declared_volume_ml
    )

    # The intermediate vial, when one is declared. Its stock concentration is not
    # known here (that needs the declared mass), and the factor does not use it.
    intermediate_result = None
    intermediate_problem = None
    if intermediate is not None:
        intermediate_result = calculate_intermediate(intermediate, None, density)
        # Literals, not built strings, so a grep for a code finds this line.
        if intermediate_result["problem"] == "diluent":
            intermediate_problem = "intermediate_diluent"
        elif intermediate_result["problem"] == "stock":
            intermediate_problem = "intermediate_stock"
        elif intermediate_result["dilution_factor"] is None:
            intermediate_problem = "intermediate_unweighed"

    # Appended last, so a row with no intermediate reports what it always did and an
    # intermediate never displaces an existing problem.
    problem = stock_problem or dilution_problem or intermediate_problem

    result = {
        "diluent_mass_mg": _round_or_none(diluent_mass_mg if _finite(diluent_mass_mg) else None, 4),
        "diluent_vol_ul": _round_or_none(diluent_vol_ul, 4),
        "sample_mass_mg": _round_or_none(sample_mass_mg if _finite(sample_mass_mg) else None, 4),
        "sample_vol_ul": _round_or_none(sample_vol_ul, 4),
        "total_vol_ul": _round_or_none(total_vol_ul, 4),
        "dilution_factor": None if dilution_problem else round(dilution_factor, 6),
        "stock_mass_mg": _round_or_none(stock_mass_mg if _finite(stock_mass_mg) else None, 4),
        "stock_volume_ml": None if stock_problem else round(stock_vol_ml, 6),
        "problem": problem,
    }

    # Total factor, stock vial to final vial. Each step is already rounded to 6
    # places above, so multiply the rounded steps and round the product: the same
    # order calculate_quantity's chain has always used. With no intermediate the
    # total is the final step's factor, untouched. An intermediate problem leaves the
    # final factor in place and nulls the total alone.
    total = result["dilution_factor"]
    if intermediate_result is not None:
        step = intermediate_result["dilution_factor"]
        total = None if total is None or step is None else round(step * total, 6)
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
        # The total dilution factor or the stock volume is not known (see
        # calculate_dilution_factor for which problem nulls which), so there is no
        # undiluted concentration or mass.
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
