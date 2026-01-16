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
