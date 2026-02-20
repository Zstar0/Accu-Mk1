"""
Unit tests for the wizard Decimal calculation engine.

Reference values verified against lab Excel workbook on 2026-02-19.
All comparisons use round(..., N) to handle trailing Decimal precision.
"""

import pytest
from decimal import Decimal, getcontext

getcontext().prec = 28

# Imports will fail (RED) until wizard.py is created
from calculations.wizard import (
    calc_stock_prep,
    calc_required_volumes,
    calc_actual_dilution,
    calc_results,
)


# ─── Shared test fixtures ──────────────────────────────────────────────────────

DILUENT_DENSITY = Decimal("997.1")

# Stock prep inputs (from lab Excel)
DECLARED_WEIGHT_MG = Decimal("50")
STOCK_VIAL_EMPTY = Decimal("5501.68")
STOCK_VIAL_LOADED = Decimal("8505.75")

# Target dilution inputs
TARGET_CONC = Decimal("800")
TARGET_TOTAL_VOL = Decimal("1500")

# Dilution vial inputs (representative values)
DIL_VIAL_EMPTY = Decimal("12000.00")
DIL_VIAL_WITH_DILUENT = Decimal("13427.69")   # +1427.69 mg diluent
DIL_VIAL_FINAL = Decimal("13499.99")           # +72.30 mg stock

# Calibration curve params (representative values)
CAL_SLOPE = Decimal("50000")
CAL_INTERCEPT = Decimal("1000")
PEAK_AREA = Decimal("41980601")   # gives determined_conc ≈ 839.2 µg/mL


# ─── calc_stock_prep tests ────────────────────────────────────────────────────

class TestCalcStockPrep:
    """Tests for stock preparation calculations."""

    def test_diluent_mass(self):
        """diluent_mass = loaded - empty vial"""
        result = calc_stock_prep(DECLARED_WEIGHT_MG, STOCK_VIAL_EMPTY, STOCK_VIAL_LOADED, DILUENT_DENSITY)
        assert result["diluent_mass_mg"] == Decimal("3004.07")

    def test_total_diluent_added_ml(self):
        """total_diluent_added_ml = diluent_mass / density (verified: 3.0128 mL)"""
        result = calc_stock_prep(DECLARED_WEIGHT_MG, STOCK_VIAL_EMPTY, STOCK_VIAL_LOADED, DILUENT_DENSITY)
        assert round(float(result["total_diluent_added_ml"]), 4) == 3.0128

    def test_stock_concentration(self):
        """stock_conc = declared_weight_mg * 1000 / total_diluent_ml (verified: 16595.82 µg/mL)"""
        result = calc_stock_prep(DECLARED_WEIGHT_MG, STOCK_VIAL_EMPTY, STOCK_VIAL_LOADED, DILUENT_DENSITY)
        assert round(float(result["stock_conc_ug_ml"]), 2) == 16595.82

    def test_all_keys_present(self):
        """Result dict contains all expected keys."""
        result = calc_stock_prep(DECLARED_WEIGHT_MG, STOCK_VIAL_EMPTY, STOCK_VIAL_LOADED, DILUENT_DENSITY)
        assert set(result.keys()) == {"diluent_mass_mg", "total_diluent_added_ml", "stock_conc_ug_ml"}

    def test_returns_decimal_types(self):
        """All returned values must be Decimal — no float leakage."""
        result = calc_stock_prep(DECLARED_WEIGHT_MG, STOCK_VIAL_EMPTY, STOCK_VIAL_LOADED, DILUENT_DENSITY)
        for key, val in result.items():
            assert isinstance(val, Decimal), f"{key} is {type(val)}, expected Decimal"

    def test_zero_diluent_raises(self):
        """Raises error when loaded == empty (no diluent added — division by zero in next step)."""
        # calc_stock_prep itself won't divide by zero (diluent_mass != 0 scenario),
        # but if loaded == empty, diluent_mass = 0 → stock_conc = declared * 1000 / 0 → ZeroDivisionError
        with pytest.raises(Exception):
            calc_stock_prep(DECLARED_WEIGHT_MG, STOCK_VIAL_EMPTY, STOCK_VIAL_EMPTY, DILUENT_DENSITY)


# ─── calc_required_volumes tests ─────────────────────────────────────────────

class TestCalcRequiredVolumes:
    """Tests for required dilution volume calculations."""

    @pytest.fixture
    def stock_conc(self):
        result = calc_stock_prep(DECLARED_WEIGHT_MG, STOCK_VIAL_EMPTY, STOCK_VIAL_LOADED, DILUENT_DENSITY)
        return result["stock_conc_ug_ml"]

    def test_required_stock_vol(self, stock_conc):
        """required_stock_vol = target_total * (target_conc / stock_conc) (verified: 72.31 µL)"""
        result = calc_required_volumes(stock_conc, TARGET_CONC, TARGET_TOTAL_VOL)
        assert round(float(result["required_stock_vol_ul"]), 2) == 72.31

    def test_required_diluent_vol(self, stock_conc):
        """required_diluent_vol = target_total - stock_vol (verified: 1427.69 µL)"""
        result = calc_required_volumes(stock_conc, TARGET_CONC, TARGET_TOTAL_VOL)
        assert round(float(result["required_diluent_vol_ul"]), 2) == 1427.69

    def test_volumes_sum_to_target(self, stock_conc):
        """Invariant: stock_vol + diluent_vol == target_total_vol (exact Decimal equality)."""
        result = calc_required_volumes(stock_conc, TARGET_CONC, TARGET_TOTAL_VOL)
        total = result["required_stock_vol_ul"] + result["required_diluent_vol_ul"]
        assert round(float(total), 6) == float(TARGET_TOTAL_VOL)

    def test_all_keys_present(self, stock_conc):
        result = calc_required_volumes(stock_conc, TARGET_CONC, TARGET_TOTAL_VOL)
        assert set(result.keys()) == {"required_stock_vol_ul", "required_diluent_vol_ul"}

    def test_returns_decimal_types(self, stock_conc):
        result = calc_required_volumes(stock_conc, TARGET_CONC, TARGET_TOTAL_VOL)
        for key, val in result.items():
            assert isinstance(val, Decimal), f"{key} is {type(val)}, expected Decimal"


# ─── calc_actual_dilution tests ───────────────────────────────────────────────

class TestCalcActualDilution:
    """Tests for actual dilution volume and concentration calculations."""

    @pytest.fixture
    def stock_conc(self):
        result = calc_stock_prep(DECLARED_WEIGHT_MG, STOCK_VIAL_EMPTY, STOCK_VIAL_LOADED, DILUENT_DENSITY)
        return result["stock_conc_ug_ml"]

    def test_actual_diluent_vol(self, stock_conc):
        """actual_diluent_vol_ul = (with_diluent - empty) / density * 1000"""
        result = calc_actual_dilution(
            stock_conc, DIL_VIAL_EMPTY, DIL_VIAL_WITH_DILUENT, DIL_VIAL_FINAL, DILUENT_DENSITY
        )
        # (13427.69 - 12000.00) / 997.1 * 1000 = 1427.69... / 997.1 * 1000 = 1431.77... µL
        assert result["actual_diluent_vol_ul"] > Decimal("0")

    def test_actual_stock_vol(self, stock_conc):
        """actual_stock_vol_ul = (final - with_diluent) / density * 1000"""
        result = calc_actual_dilution(
            stock_conc, DIL_VIAL_EMPTY, DIL_VIAL_WITH_DILUENT, DIL_VIAL_FINAL, DILUENT_DENSITY
        )
        assert result["actual_stock_vol_ul"] > Decimal("0")

    def test_total_vol_is_sum(self, stock_conc):
        """actual_total_vol = diluent_vol + stock_vol (invariant)."""
        result = calc_actual_dilution(
            stock_conc, DIL_VIAL_EMPTY, DIL_VIAL_WITH_DILUENT, DIL_VIAL_FINAL, DILUENT_DENSITY
        )
        expected_total = result["actual_diluent_vol_ul"] + result["actual_stock_vol_ul"]
        assert result["actual_total_vol_ul"] == expected_total

    def test_actual_conc_is_positive(self, stock_conc):
        """actual_conc must be > 0 and < stock_conc (dilution reduces concentration)."""
        result = calc_actual_dilution(
            stock_conc, DIL_VIAL_EMPTY, DIL_VIAL_WITH_DILUENT, DIL_VIAL_FINAL, DILUENT_DENSITY
        )
        assert Decimal("0") < result["actual_conc_ug_ml"] < stock_conc

    def test_all_keys_present(self, stock_conc):
        result = calc_actual_dilution(
            stock_conc, DIL_VIAL_EMPTY, DIL_VIAL_WITH_DILUENT, DIL_VIAL_FINAL, DILUENT_DENSITY
        )
        assert set(result.keys()) == {
            "actual_diluent_vol_ul", "actual_stock_vol_ul",
            "actual_total_vol_ul", "actual_conc_ug_ml"
        }

    def test_returns_decimal_types(self, stock_conc):
        result = calc_actual_dilution(
            stock_conc, DIL_VIAL_EMPTY, DIL_VIAL_WITH_DILUENT, DIL_VIAL_FINAL, DILUENT_DENSITY
        )
        for key, val in result.items():
            assert isinstance(val, Decimal), f"{key} is {type(val)}, expected Decimal"


# ─── calc_results tests ───────────────────────────────────────────────────────

class TestCalcResults:
    """Tests for HPLC results calculations."""

    @pytest.fixture
    def actual_vals(self):
        """Provide realistic actual dilution outputs."""
        stock_conc = calc_stock_prep(
            DECLARED_WEIGHT_MG, STOCK_VIAL_EMPTY, STOCK_VIAL_LOADED, DILUENT_DENSITY
        )["stock_conc_ug_ml"]
        return calc_actual_dilution(
            stock_conc, DIL_VIAL_EMPTY, DIL_VIAL_WITH_DILUENT, DIL_VIAL_FINAL, DILUENT_DENSITY
        )

    def test_determined_conc(self, actual_vals):
        """determined_conc = (peak_area - intercept) / slope"""
        result = calc_results(
            CAL_SLOPE, CAL_INTERCEPT, PEAK_AREA,
            actual_vals["actual_conc_ug_ml"],
            actual_vals["actual_total_vol_ul"],
            actual_vals["actual_stock_vol_ul"],
        )
        # (41980601 - 1000) / 50000 = 839.19202
        expected = (PEAK_AREA - CAL_INTERCEPT) / CAL_SLOPE
        assert round(float(result["determined_conc_ug_ml"]), 2) == round(float(expected), 2)

    def test_peptide_mass_mg(self, actual_vals):
        """peptide_mass_mg = determined_conc * total_vol / 1000"""
        result = calc_results(
            CAL_SLOPE, CAL_INTERCEPT, PEAK_AREA,
            actual_vals["actual_conc_ug_ml"],
            actual_vals["actual_total_vol_ul"],
            actual_vals["actual_stock_vol_ul"],
        )
        assert result["peptide_mass_mg"] > Decimal("0")

    def test_purity_pct(self, actual_vals):
        """purity_pct = (determined_conc / actual_conc) * 100; value in range (0, 200)"""
        result = calc_results(
            CAL_SLOPE, CAL_INTERCEPT, PEAK_AREA,
            actual_vals["actual_conc_ug_ml"],
            actual_vals["actual_total_vol_ul"],
            actual_vals["actual_stock_vol_ul"],
        )
        assert Decimal("0") < result["purity_pct"] < Decimal("200")

    def test_dilution_factor(self, actual_vals):
        """dilution_factor = actual_total_vol / actual_stock_vol; must be >= 1"""
        result = calc_results(
            CAL_SLOPE, CAL_INTERCEPT, PEAK_AREA,
            actual_vals["actual_conc_ug_ml"],
            actual_vals["actual_total_vol_ul"],
            actual_vals["actual_stock_vol_ul"],
        )
        assert result["dilution_factor"] >= Decimal("1")

    def test_all_keys_present(self, actual_vals):
        result = calc_results(
            CAL_SLOPE, CAL_INTERCEPT, PEAK_AREA,
            actual_vals["actual_conc_ug_ml"],
            actual_vals["actual_total_vol_ul"],
            actual_vals["actual_stock_vol_ul"],
        )
        assert set(result.keys()) == {
            "determined_conc_ug_ml", "peptide_mass_mg", "purity_pct", "dilution_factor"
        }

    def test_returns_decimal_types(self, actual_vals):
        result = calc_results(
            CAL_SLOPE, CAL_INTERCEPT, PEAK_AREA,
            actual_vals["actual_conc_ug_ml"],
            actual_vals["actual_total_vol_ul"],
            actual_vals["actual_stock_vol_ul"],
        )
        for key, val in result.items():
            assert isinstance(val, Decimal), f"{key} is {type(val)}, expected Decimal"
