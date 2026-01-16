"""
Core calculation engine for processing HPLC sample data.
Orchestrates formula execution and result collection.
"""

from calculations.formulas import (
    Formula,
    CalculationResult,
    AccumulationFormula,
    ResponseFactorFormula,
    DilutionFactorFormula,
    CompoundIdentificationFormula,
)


# Registry of available calculation types
FORMULA_REGISTRY: dict[str, type[Formula]] = {
    "accumulation": AccumulationFormula,
    "response_factor": ResponseFactorFormula,
    "dilution_factor": DilutionFactorFormula,
    "compound_id": CompoundIdentificationFormula,
}


class CalculationEngine:
    """
    Core engine for running calculations on sample data.

    Loads settings and executes formulas against sample input_data.
    """

    def __init__(self, settings: dict):
        """
        Initialize engine with settings.

        Args:
            settings: Dict of key-value settings (from database)
                Expected keys: response_factor, rt_window_start, rt_window_end, dilution_factor
        """
        self.settings = settings

    def get_formula(self, calculation_type: str) -> Formula:
        """
        Get formula instance for the given calculation type.

        Args:
            calculation_type: Type identifier (e.g., 'accumulation', 'response_factor')

        Returns:
            Formula instance

        Raises:
            ValueError: If calculation type is unknown
        """
        if calculation_type not in FORMULA_REGISTRY:
            raise ValueError(f"Unknown calculation type: {calculation_type}")
        return FORMULA_REGISTRY[calculation_type]()

    def calculate(self, sample_data: dict, calculation_type: str) -> CalculationResult:
        """
        Run specified calculation on sample data.

        Args:
            sample_data: Sample's input_data dict containing rows and headers
            calculation_type: Type of calculation to perform

        Returns:
            CalculationResult with output values and any warnings
        """
        try:
            formula = self.get_formula(calculation_type)

            # Validate inputs
            validation_errors = formula.validate(sample_data, self.settings)
            if validation_errors:
                return CalculationResult(
                    calculation_type=calculation_type,
                    input_summary={"validation_errors": validation_errors},
                    output_values={},
                    warnings=[],
                    success=False,
                    error=f"Validation failed: {'; '.join(validation_errors)}",
                )

            # Execute calculation
            return formula.execute(sample_data, self.settings)

        except Exception as e:
            return CalculationResult(
                calculation_type=calculation_type,
                input_summary={},
                output_values={},
                warnings=[],
                success=False,
                error=str(e),
            )

    def calculate_all(self, sample_data: dict) -> list[CalculationResult]:
        """
        Run all applicable calculations on sample data.

        Determines which calculations apply based on available data and settings.

        Args:
            sample_data: Sample's input_data dict

        Returns:
            List of CalculationResult for each calculation performed
        """
        results: list[CalculationResult] = []

        # Always run accumulation if we have rows with peak_area
        results.append(self.calculate(sample_data, "accumulation"))

        # Run response factor if setting exists
        if self.settings.get("response_factor"):
            results.append(self.calculate(sample_data, "response_factor"))

        # Run dilution factor if setting exists
        if self.settings.get("dilution_factor"):
            results.append(self.calculate(sample_data, "dilution_factor"))

        # Run compound identification if compound_ranges setting exists and is not empty
        compound_ranges = self.settings.get("compound_ranges")
        if compound_ranges and compound_ranges != "{}":
            results.append(self.calculate(sample_data, "compound_id"))

        return results

    @staticmethod
    def get_available_types() -> list[str]:
        """Get list of all available calculation types."""
        return list(FORMULA_REGISTRY.keys())
