"""
Wizard sample prep calculation engine.

All arithmetic uses Decimal internally. No float intermediate values.
Callers must convert inputs from float with Decimal(str(value)).
Callers must convert outputs to float with float(value) at the API boundary.

Four calculation stages map to the 5-step wizard:
  Stage 1 (Stock Prep):       calc_stock_prep()
  Stage 2 (Required Volumes): calc_required_volumes()
  Stage 3 (Actual Dilution):  calc_actual_dilution()
  Stage 4 (Results):          calc_results()
"""

from decimal import Decimal, getcontext

# 28-digit precision — sufficient for all chained wizard calculations
getcontext().prec = 28


def calc_stock_prep(
    declared_weight_mg: Decimal,
    stock_vial_empty_mg: Decimal,
    stock_vial_loaded_mg: Decimal,
    diluent_density: Decimal,
) -> dict:
    """
    Stage 1: Calculate stock preparation values.

    Args:
        declared_weight_mg:  Supplier-declared peptide weight (mg). Text input by tech.
        stock_vial_empty_mg: Empty stock vial + cap weight (mg). Balance reading.
        stock_vial_loaded_mg: Stock vial weight after adding diluent (mg). Balance reading.
        diluent_density:     Diluent density (mg/mL). From Peptide.diluent_density.

    Returns dict with Decimal values:
        diluent_mass_mg:        Mass of diluent added to stock vial (mg)
        total_diluent_added_ml: Volume of diluent added (mL)
        stock_conc_ug_ml:       Stock solution concentration (µg/mL)

    Verified against lab Excel: declared=50mg, empty=5501.68mg, loaded=8505.75mg ->
        diluent_mass=3004.07mg, total_diluent=3.0128mL, stock_conc=16595.82µg/mL
    """
    diluent_mass_mg = stock_vial_loaded_mg - stock_vial_empty_mg
    total_diluent_added_ml = diluent_mass_mg / diluent_density
    stock_conc_ug_ml = (declared_weight_mg * Decimal("1000")) / total_diluent_added_ml
    return {
        "diluent_mass_mg": diluent_mass_mg,
        "total_diluent_added_ml": total_diluent_added_ml,
        "stock_conc_ug_ml": stock_conc_ug_ml,
    }


def calc_required_volumes(
    stock_conc_ug_ml: Decimal,
    target_conc_ug_ml: Decimal,
    target_total_vol_ul: Decimal,
) -> dict:
    """
    Stage 2: Calculate required stock and diluent volumes to hit target concentration.

    Args:
        stock_conc_ug_ml:    Stock solution concentration from Stage 1 (µg/mL)
        target_conc_ug_ml:   Desired final concentration (µg/mL). Tech input.
        target_total_vol_ul: Desired total final volume (µL). Tech input.

    Returns dict with Decimal values:
        required_stock_vol_ul:   Volume of stock solution to pipette (µL)
        required_diluent_vol_ul: Volume of diluent to add (µL)

    Invariant: required_stock_vol_ul + required_diluent_vol_ul == target_total_vol_ul

    Verified: stock_conc=16595.82, target_conc=800, target_vol=1500 ->
        stock_vol=72.31µL, diluent_vol=1427.69µL
    """
    required_stock_vol_ul = target_total_vol_ul * (target_conc_ug_ml / stock_conc_ug_ml)
    required_diluent_vol_ul = target_total_vol_ul - required_stock_vol_ul
    return {
        "required_stock_vol_ul": required_stock_vol_ul,
        "required_diluent_vol_ul": required_diluent_vol_ul,
    }


def calc_actual_dilution(
    stock_conc_ug_ml: Decimal,
    dil_vial_empty_mg: Decimal,
    dil_vial_with_diluent_mg: Decimal,
    dil_vial_final_mg: Decimal,
    diluent_density: Decimal,
) -> dict:
    """
    Stage 3: Calculate actual dilution volumes and concentration from measured vial weights.

    Tech weighs the dilution vial at 3 points:
      1. Empty vial (dil_vial_empty_mg)
      2. After adding diluent (dil_vial_with_diluent_mg)
      3. After adding stock aliquot (dil_vial_final_mg)

    Args:
        stock_conc_ug_ml:         Stock concentration from Stage 1 (µg/mL)
        dil_vial_empty_mg:        Empty dilution vial + cap (mg). Balance reading.
        dil_vial_with_diluent_mg: Dilution vial after adding diluent (mg). Balance reading.
        dil_vial_final_mg:        Dilution vial after adding stock aliquot (mg). Balance reading.
        diluent_density:          Diluent density (mg/mL). From Peptide.diluent_density.

    Returns dict with Decimal values:
        actual_diluent_vol_ul: Actual diluent volume added (µL)
        actual_stock_vol_ul:   Actual stock volume pipetted (µL)
        actual_total_vol_ul:   Actual total solution volume (µL)
        actual_conc_ug_ml:     Actual final concentration (µg/mL)
    """
    actual_diluent_mass_mg = dil_vial_with_diluent_mg - dil_vial_empty_mg
    actual_diluent_vol_ul = actual_diluent_mass_mg / diluent_density * Decimal("1000")

    actual_stock_mass_mg = dil_vial_final_mg - dil_vial_with_diluent_mg
    actual_stock_vol_ul = actual_stock_mass_mg / diluent_density * Decimal("1000")

    actual_total_vol_ul = actual_diluent_vol_ul + actual_stock_vol_ul
    actual_conc_ug_ml = stock_conc_ug_ml * actual_stock_vol_ul / actual_total_vol_ul

    return {
        "actual_diluent_vol_ul": actual_diluent_vol_ul,
        "actual_stock_vol_ul": actual_stock_vol_ul,
        "actual_total_vol_ul": actual_total_vol_ul,
        "actual_conc_ug_ml": actual_conc_ug_ml,
    }


def calc_results(
    calibration_slope: Decimal,
    calibration_intercept: Decimal,
    peak_area: Decimal,
    actual_conc_ug_ml: Decimal,
    actual_total_vol_ul: Decimal,
    actual_stock_vol_ul: Decimal,
) -> dict:
    """
    Stage 4: Calculate HPLC results from peak area and calibration curve.

    Run after tech enters the peak area from the HPLC instrument report.

    Args:
        calibration_slope:      Slope from active CalibrationCurve (area/conc)
        calibration_intercept:  Intercept from active CalibrationCurve
        peak_area:              Peak area reading from HPLC instrument
        actual_conc_ug_ml:      Actual concentration from Stage 3 (µg/mL)
        actual_total_vol_ul:    Actual total volume from Stage 3 (µL)
        actual_stock_vol_ul:    Actual stock volume from Stage 3 (µL) — used for dilution factor

    Returns dict with Decimal values:
        determined_conc_ug_ml: Back-calculated concentration from HPLC peak (µg/mL)
        peptide_mass_mg:        Total peptide mass in the dilution vial (mg)
        purity_pct:             Purity percentage vs actual concentration (%)
        dilution_factor:        actual_total_vol / actual_stock_vol (dimensionless)
    """
    determined_conc_ug_ml = (peak_area - calibration_intercept) / calibration_slope
    peptide_mass_mg = determined_conc_ug_ml * actual_total_vol_ul / Decimal("1000")
    purity_pct = (determined_conc_ug_ml / actual_conc_ug_ml) * Decimal("100")
    dilution_factor = actual_total_vol_ul / actual_stock_vol_ul

    return {
        "determined_conc_ug_ml": determined_conc_ug_ml,
        "peptide_mass_mg": peptide_mass_mg,
        "purity_pct": purity_pct,
        "dilution_factor": dilution_factor,
    }
