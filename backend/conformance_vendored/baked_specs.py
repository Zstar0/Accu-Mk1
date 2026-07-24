"""
Hardcoded conformance specs for non-peptide matrices, used until SENAITE
Analysis Specifications are wired up per Sample Type.

Keyed by (SampleTypeTitle, Analysis Keyword). To add a new spec, copy an
existing row, swap in the matrix name + SENAITE analysis keyword, and update
min/max/unit/display.

Later, when SENAITE specs are in place, GenericAssayEngine will prefer those
and fall back to this dict.
"""
from __future__ import annotations

from typing import Optional, TypedDict


class BakedSpec(TypedDict, total=False):
    min: float           # lower bound (inclusive) — None/absent = no lower bound
    max: float           # upper bound (inclusive) — None/absent = no upper bound
    unit: str            # display unit; independent of the analysis's SENAITE unit
    display: str         # human-friendly spec string for the COA (e.g. "0.9% (v/v) ±10%")


# --- Baked per-matrix specs ---------------------------------------------------
# NOTE: Keyword must match the SENAITE Analysis Service "Analysis Keyword",
# not the Title. Check SENAITE Setup → Analysis Services if unsure.

BAKED_SPECS: dict[tuple[str, str], BakedSpec] = {
    # Bacteriostatic Water — USP-style spec, BA at 0.9% v/v ±10%.
    ("Bacteriostatic Water", "Benzyl_Alcohol_Assay"): {
        "min": 0.81,
        "max": 0.99,
        "unit": "v/v",
        "display": "0.9% (v/v) ±10%",
    },
    ("Bacteriostatic Water", "PH-DETERM"): {
        "min": 4.5,
        "max": 7.0,
        "unit": "",
        "display": "4.5 – 7.0",
    },
    # Endotoxin (LAL) — BW limit is far tighter than the peptide default (5.0).
    # `max` is the conformance threshold (result must be < max).
    ("Bacteriostatic Water", "ENDO-LAL"): {
        "max": 0.25,
        "unit": "EU/mL",
        "display": "< 0.25 EU/mL",
    },
    # FILL-NET-CONTENT spec intentionally omitted — depends on label claim,
    # which varies per product. Will come from SENAITE per-sample spec later.
}


# --- Analytical technique per analysis keyword --------------------------------
# Populated into results_table rows as `test_type`, which the PDF template
# renders in the "Test" column. Short pharmacopeial-style labels.

TEST_TECHNIQUES: dict[str, str] = {
    "Benzyl_Alcohol_Assay": "HPLC",
    "PH-DETERM": "pH",
    "FILL-NET-CONTENT": "Gravimetric",
}


def lookup_spec(matrix: str, keyword: str) -> Optional[BakedSpec]:
    """Return the baked spec for (matrix, keyword) or None."""
    if not matrix or not keyword:
        return None
    return BAKED_SPECS.get((matrix, keyword))


def lookup_technique(keyword: str) -> str:
    """Return short analytical technique label, or empty string."""
    return TEST_TECHNIQUES.get(keyword or "", "")
