"""
Calibration curve calculations for HPLC peptide quantitation.

Provides:
- Linear regression (pure Python, no numpy dependency)
- Calibration curve generation from concentration/area pairs
"""


def calculate_calibration_curve(
    concentrations: list[float], areas: list[float]
) -> dict:
    """
    Calculate linear regression for calibration curve.

    Uses least-squares method: Area = slope * Concentration + intercept

    Args:
        concentrations: Standard concentrations (x values)
        areas: Corresponding peak areas (y values)

    Returns:
        Dict with slope, intercept, r_squared

    Raises:
        ValueError: If fewer than 2 data points or mismatched lengths
    """
    if len(concentrations) != len(areas):
        raise ValueError(
            f"Mismatched lengths: {len(concentrations)} concentrations vs {len(areas)} areas"
        )

    n = len(concentrations)
    if n < 2:
        raise ValueError(f"Need at least 2 data points, got {n}")

    # Filter out None/NaN pairs
    pairs = [
        (c, a)
        for c, a in zip(concentrations, areas)
        if c is not None and a is not None
    ]
    n = len(pairs)
    if n < 2:
        raise ValueError(f"Need at least 2 valid data points after filtering, got {n}")

    xs = [p[0] for p in pairs]
    ys = [p[1] for p in pairs]

    # Sums for linear regression
    sum_x = sum(xs)
    sum_y = sum(ys)
    sum_xy = sum(x * y for x, y in pairs)
    sum_x2 = sum(x * x for x in xs)
    sum_y2 = sum(y * y for y in ys)

    # Slope and intercept
    denominator = n * sum_x2 - sum_x * sum_x
    if denominator == 0:
        raise ValueError("Cannot compute regression: all x values are identical")

    slope = (n * sum_xy - sum_x * sum_y) / denominator
    intercept = (sum_y - slope * sum_x) / n

    # R-squared (coefficient of determination)
    ss_res = sum((y - (slope * x + intercept)) ** 2 for x, y in pairs)
    mean_y = sum_y / n
    ss_tot = sum((y - mean_y) ** 2 for y in ys)

    r_squared = 1 - (ss_res / ss_tot) if ss_tot != 0 else 0.0

    return {
        "slope": round(slope, 6),
        "intercept": round(intercept, 6),
        "r_squared": round(r_squared, 6),
        "n_points": n,
    }
