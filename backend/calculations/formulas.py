"""
Formula implementations for HPLC calculations.
Each formula handles a specific type of calculation with input validation.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class CalculationResult:
    """Result of a single calculation."""
    calculation_type: str
    input_summary: dict
    output_values: dict
    warnings: list[str] = field(default_factory=list)
    success: bool = True
    error: Optional[str] = None


class Formula(ABC):
    """
    Abstract base class for calculation formulas.

    Each formula defines:
    - validate(): Check that required inputs are present
    - execute(): Perform the calculation
    """

    @abstractmethod
    def execute(self, data: dict, settings: dict) -> CalculationResult:
        """
        Execute the formula on sample data.

        Args:
            data: Sample input_data dict with rows and headers
            settings: Application settings dict

        Returns:
            CalculationResult with output values
        """
        pass

    @abstractmethod
    def validate(self, data: dict, settings: dict) -> list[str]:
        """
        Validate that required inputs are present.

        Args:
            data: Sample input_data dict
            settings: Application settings dict

        Returns:
            List of validation error messages (empty if valid)
        """
        pass


class AccumulationFormula(Formula):
    """
    Sum peak areas across retention time windows.

    Inputs:
        - rows with peak_area values
        - Optional: retention_time for windowing
        - Optional: rt_window_start, rt_window_end from settings

    Outputs:
        - total_area: Sum of all peak areas in window
        - peak_count: Number of peaks summed
        - window_summary: Details about RT window used
    """

    def validate(self, data: dict, settings: dict) -> list[str]:
        """Validate accumulation inputs."""
        errors: list[str] = []

        if not data:
            errors.append("No sample data provided")
            return errors

        rows = data.get("rows", [])
        if not rows:
            errors.append("No data rows in sample")
            return errors

        # Check if at least one row has peak_area
        has_area = any(
            row.get("peak_area") is not None
            for row in rows
        )
        if not has_area:
            errors.append("No peak_area values found in data")

        return errors

    def execute(self, data: dict, settings: dict) -> CalculationResult:
        """Execute accumulation calculation."""
        rows = data.get("rows", [])
        warnings: list[str] = []

        # Get RT window settings (optional)
        rt_start = settings.get("rt_window_start")
        rt_end = settings.get("rt_window_end")
        use_window = rt_start is not None and rt_end is not None

        # Convert window bounds to float if present
        if use_window:
            try:
                rt_start = float(rt_start)
                rt_end = float(rt_end)
            except (ValueError, TypeError):
                warnings.append("Invalid RT window settings, using all peaks")
                use_window = False

        total_area = 0.0
        peak_count = 0
        skipped_no_area = 0
        skipped_outside_window = 0

        for row in rows:
            area_val = row.get("peak_area")

            # Skip rows without area
            if area_val is None:
                skipped_no_area += 1
                continue

            # Convert to float
            try:
                area = float(area_val)
            except (ValueError, TypeError):
                skipped_no_area += 1
                continue

            # Check RT window if applicable
            if use_window:
                rt_val = row.get("retention_time")
                if rt_val is not None:
                    try:
                        rt = float(rt_val)
                        if rt < rt_start or rt > rt_end:
                            skipped_outside_window += 1
                            continue
                    except (ValueError, TypeError):
                        # Can't filter by RT, include the peak
                        warnings.append(f"Row has invalid retention_time: {rt_val}")

            total_area += area
            peak_count += 1

        # Build window summary
        window_summary = {
            "window_applied": use_window,
            "rt_start": rt_start if use_window else None,
            "rt_end": rt_end if use_window else None,
            "peaks_outside_window": skipped_outside_window,
        }

        if skipped_no_area > 0:
            warnings.append(f"Skipped {skipped_no_area} rows without valid peak_area")

        return CalculationResult(
            calculation_type="accumulation",
            input_summary={
                "total_rows": len(rows),
                "rows_processed": peak_count + skipped_outside_window,
                "rows_skipped": skipped_no_area,
            },
            output_values={
                "total_area": total_area,
                "peak_count": peak_count,
                "window_summary": window_summary,
            },
            warnings=warnings,
            success=True,
        )


class ResponseFactorFormula(Formula):
    """
    Apply response factor to convert areas to concentrations.

    Inputs:
        - total_area (from accumulation or provided)
        - response_factor from settings

    Outputs:
        - calculated_concentration: area / response_factor
        - applied_factor: The response factor used
    """

    def validate(self, data: dict, settings: dict) -> list[str]:
        """Validate response factor inputs."""
        errors: list[str] = []

        rf = settings.get("response_factor")
        if rf is None:
            errors.append("response_factor not set in settings")
        else:
            try:
                rf_val = float(rf)
                if rf_val == 0:
                    errors.append("response_factor cannot be zero")
                elif rf_val < 0:
                    errors.append("response_factor cannot be negative")
            except (ValueError, TypeError):
                errors.append(f"Invalid response_factor value: {rf}")

        # Need either total_area in data or rows to calculate from
        if not data:
            errors.append("No sample data provided")
        elif not data.get("total_area") and not data.get("rows"):
            errors.append("No total_area or rows provided")

        return errors

    def execute(self, data: dict, settings: dict) -> CalculationResult:
        """Execute response factor calculation."""
        warnings: list[str] = []

        response_factor = float(settings["response_factor"])

        # Get total_area - either directly provided or calculate from rows
        total_area = data.get("total_area")
        if total_area is None:
            # Calculate from rows
            rows = data.get("rows", [])
            total_area = 0.0
            for row in rows:
                area_val = row.get("peak_area")
                if area_val is not None:
                    try:
                        total_area += float(area_val)
                    except (ValueError, TypeError):
                        pass
            warnings.append("Calculated total_area from rows")

        try:
            total_area = float(total_area)
        except (ValueError, TypeError):
            return CalculationResult(
                calculation_type="response_factor",
                input_summary={"total_area": total_area},
                output_values={},
                warnings=warnings,
                success=False,
                error=f"Invalid total_area value: {total_area}",
            )

        calculated_concentration = total_area / response_factor

        return CalculationResult(
            calculation_type="response_factor",
            input_summary={
                "total_area": total_area,
                "response_factor": response_factor,
            },
            output_values={
                "calculated_concentration": calculated_concentration,
                "applied_factor": response_factor,
            },
            warnings=warnings,
            success=True,
        )


class CompoundIdentificationFormula(Formula):
    """
    Identify compounds by matching retention times to configured ranges.

    Inputs:
        - rows with retention_time values
        - compound_ranges setting: JSON dict with format:
          {"CompoundA": {"rt_min": 1.0, "rt_max": 2.0}, ...}

    Outputs:
        - identified_compounds: List of {compound_name, retention_time, peak_area}
        - unidentified_peaks: List of {retention_time, peak_area} that didn't match
        - compound_summary: Dict of compound -> count of peaks
    """

    def validate(self, data: dict, settings: dict) -> list[str]:
        """Validate compound identification inputs."""
        errors: list[str] = []

        # Check compound_ranges setting
        ranges_str = settings.get("compound_ranges")
        if not ranges_str:
            errors.append("compound_ranges setting not configured")
        else:
            try:
                import json
                ranges = json.loads(ranges_str)
                if not isinstance(ranges, dict):
                    errors.append("compound_ranges must be a JSON object")
                elif not ranges:
                    errors.append("compound_ranges is empty - no compounds configured")
                else:
                    # Validate each compound range
                    for name, range_def in ranges.items():
                        if not isinstance(range_def, dict):
                            errors.append(f"Compound '{name}' range must be an object")
                        elif "rt_min" not in range_def or "rt_max" not in range_def:
                            errors.append(f"Compound '{name}' missing rt_min or rt_max")
            except json.JSONDecodeError as e:
                errors.append(f"compound_ranges is invalid JSON: {e}")

        # Check data has rows with retention_time
        if not data:
            errors.append("No sample data provided")
        else:
            rows = data.get("rows", [])
            if not rows:
                errors.append("No data rows in sample")
            else:
                has_rt = any(row.get("retention_time") is not None for row in rows)
                if not has_rt:
                    errors.append("No retention_time values found in data")

        return errors

    def execute(self, data: dict, settings: dict) -> CalculationResult:
        """Execute compound identification."""
        import json

        rows = data.get("rows", [])
        warnings: list[str] = []

        # Parse compound ranges
        ranges = json.loads(settings["compound_ranges"])

        identified_compounds: list[dict] = []
        unidentified_peaks: list[dict] = []
        compound_summary: dict[str, int] = {}
        skipped_no_rt = 0

        for row in rows:
            rt_val = row.get("retention_time")

            # Skip rows without retention time
            if rt_val is None:
                skipped_no_rt += 1
                continue

            try:
                rt = float(rt_val)
            except (ValueError, TypeError):
                skipped_no_rt += 1
                warnings.append(f"Invalid retention_time value: {rt_val}")
                continue

            # Get peak_area if available
            area_val = row.get("peak_area")
            try:
                area = float(area_val) if area_val is not None else None
            except (ValueError, TypeError):
                area = None

            # Check which compound range this RT falls into
            matched_compound = None
            for compound_name, range_def in ranges.items():
                try:
                    rt_min = float(range_def["rt_min"])
                    rt_max = float(range_def["rt_max"])
                    if rt_min <= rt <= rt_max:
                        matched_compound = compound_name
                        break
                except (ValueError, TypeError, KeyError):
                    continue

            if matched_compound:
                identified_compounds.append({
                    "compound_name": matched_compound,
                    "retention_time": rt,
                    "peak_area": area,
                })
                compound_summary[matched_compound] = compound_summary.get(matched_compound, 0) + 1
            else:
                unidentified_peaks.append({
                    "retention_time": rt,
                    "peak_area": area,
                })

        if skipped_no_rt > 0:
            warnings.append(f"Skipped {skipped_no_rt} rows without valid retention_time")

        return CalculationResult(
            calculation_type="compound_id",
            input_summary={
                "total_rows": len(rows),
                "compounds_configured": len(ranges),
                "compound_names": list(ranges.keys()),
            },
            output_values={
                "identified_compounds": identified_compounds,
                "unidentified_peaks": unidentified_peaks,
                "compound_summary": compound_summary,
                "identified_count": len(identified_compounds),
                "unidentified_count": len(unidentified_peaks),
            },
            warnings=warnings,
            success=True,
        )


class DilutionFactorFormula(Formula):
    """
    Adjust concentrations by dilution factor.

    Inputs:
        - concentration (from response_factor or provided)
        - dilution_factor from settings

    Outputs:
        - final_concentration: concentration * dilution_factor
        - dilution_applied: The dilution factor used
    """

    def validate(self, data: dict, settings: dict) -> list[str]:
        """Validate dilution factor inputs."""
        errors: list[str] = []

        df = settings.get("dilution_factor")
        if df is None:
            errors.append("dilution_factor not set in settings")
        else:
            try:
                df_val = float(df)
                if df_val <= 0:
                    errors.append("dilution_factor must be positive")
            except (ValueError, TypeError):
                errors.append(f"Invalid dilution_factor value: {df}")

        if not data:
            errors.append("No sample data provided")
        elif data.get("concentration") is None and data.get("calculated_concentration") is None:
            errors.append("No concentration value provided")

        return errors

    def execute(self, data: dict, settings: dict) -> CalculationResult:
        """Execute dilution factor calculation."""
        warnings: list[str] = []

        dilution_factor = float(settings["dilution_factor"])

        # Get concentration - try multiple keys
        concentration = data.get("concentration") or data.get("calculated_concentration")

        try:
            concentration = float(concentration)
        except (ValueError, TypeError):
            return CalculationResult(
                calculation_type="dilution_factor",
                input_summary={"concentration": concentration},
                output_values={},
                warnings=warnings,
                success=False,
                error=f"Invalid concentration value: {concentration}",
            )

        final_concentration = concentration * dilution_factor

        return CalculationResult(
            calculation_type="dilution_factor",
            input_summary={
                "concentration": concentration,
                "dilution_factor": dilution_factor,
            },
            output_values={
                "final_concentration": final_concentration,
                "dilution_applied": dilution_factor,
            },
            warnings=warnings,
            success=True,
        )


class PurityFormula(Formula):
    """
    Calculate purity percentage using linear calibration equation.

    Uses serial dilution calibration curve: purity_% = (peak_area - intercept) / slope

    Inputs:
        - rows with peak_area values OR total_area already calculated
        - calibration_slope from settings
        - calibration_intercept from settings

    Outputs:
        - purity_percent: Calculated purity percentage
        - total_area: The area used in calculation
        - calibration_used: {slope, intercept}
    """

    def validate(self, data: dict, settings: dict) -> list[str]:
        """Validate purity calculation inputs."""
        errors: list[str] = []

        # Check calibration slope
        slope = settings.get("calibration_slope")
        if slope is None:
            errors.append("calibration_slope not set in settings")
        else:
            try:
                slope_val = float(slope)
                if slope_val == 0:
                    errors.append("calibration_slope cannot be zero")
            except (ValueError, TypeError):
                errors.append(f"Invalid calibration_slope value: {slope}")

        # Check calibration intercept
        intercept = settings.get("calibration_intercept")
        if intercept is None:
            errors.append("calibration_intercept not set in settings")
        else:
            try:
                float(intercept)
            except (ValueError, TypeError):
                errors.append(f"Invalid calibration_intercept value: {intercept}")

        # Check for area data
        if not data:
            errors.append("No sample data provided")
        elif data.get("total_area") is None:
            # Need to calculate from rows
            rows = data.get("rows", [])
            if not rows:
                errors.append("No total_area or rows provided")
            else:
                has_area = any(row.get("peak_area") is not None for row in rows)
                if not has_area:
                    errors.append("No peak_area values found in data")

        return errors

    def execute(self, data: dict, settings: dict) -> CalculationResult:
        """Execute purity calculation."""
        warnings: list[str] = []

        slope = float(settings["calibration_slope"])
        intercept = float(settings["calibration_intercept"])

        # Get total_area - either directly provided or calculate from rows
        total_area = data.get("total_area")
        if total_area is None:
            # Calculate from rows
            rows = data.get("rows", [])
            total_area = 0.0
            for row in rows:
                area_val = row.get("peak_area")
                if area_val is not None:
                    try:
                        total_area += float(area_val)
                    except (ValueError, TypeError):
                        pass
            warnings.append("Calculated total_area from rows")

        try:
            total_area = float(total_area)
        except (ValueError, TypeError):
            return CalculationResult(
                calculation_type="purity",
                input_summary={"total_area": total_area},
                output_values={},
                warnings=warnings,
                success=False,
                error=f"Invalid total_area value: {total_area}",
            )

        # Calculate purity: purity_% = (area - intercept) / slope
        purity_percent = (total_area - intercept) / slope

        # Warn if outside normal range (but still return the value)
        if purity_percent < 0:
            warnings.append(f"Purity {purity_percent:.2f}% is negative - check calibration or input data")
        elif purity_percent > 100:
            warnings.append(f"Purity {purity_percent:.2f}% exceeds 100% - check calibration or input data")

        return CalculationResult(
            calculation_type="purity",
            input_summary={
                "total_area": total_area,
                "calibration_slope": slope,
                "calibration_intercept": intercept,
            },
            output_values={
                "purity_percent": purity_percent,
                "total_area": total_area,
                "calibration_used": {
                    "slope": slope,
                    "intercept": intercept,
                },
            },
            warnings=warnings,
            success=True,
        )
