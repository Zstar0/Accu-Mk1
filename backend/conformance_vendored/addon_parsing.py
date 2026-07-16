"""Shared add-on analysis parsers (Endotoxin LAL, Sterility PCR).

Used by both ConformanceEngine (peptide path) and GenericAssayEngine (BW /
non-peptide path) so both engines emit identical addon_results rows. Keeping
this in one place prevents the two paths from drifting on Pass/Fail mappings,
specs, or status colors.
"""
from __future__ import annotations

from typing import Any, Dict, List

from .baked_specs import lookup_spec


ADDON_KEYWORDS: tuple[str, ...] = ("ENDO-LAL", "STER-PCR")

# Default endotoxin conformance threshold (< 5.0 EU/mL passes) for matrices
# without a per-matrix spec — e.g. peptides. Bacteriostatic Water overrides this
# to 0.25 via baked_specs (keyed by (SampleTypeTitle, "ENDO-LAL")).
_ENDO_SPEC_DEFAULT = 5.0
_ENDO_UNIT = "EU/mL"
_NONCONFORM_COLOR = "#444F5B"


def _endo_spec(matrix: str) -> tuple[float, str]:
    """Resolve (threshold, COA spec string) for endotoxin given the sample matrix.

    Prefers the per-matrix baked spec (its `max` is the threshold); falls back to
    the 5.0 default so peptides and unknown matrices are unchanged.
    """
    spec = lookup_spec(matrix, "ENDO-LAL") or {}
    limit = spec.get("max", _ENDO_SPEC_DEFAULT)
    display = spec.get("display") or f"< {limit} EU/mL"
    return limit, display


def _is_blank(value: Any) -> bool:
    """True when SENAITE hasn't entered a result yet."""
    return value is None or str(value).strip().lower() in ("none", "")


def parse_endotoxin(analysis: Dict[str, Any], matrix: str = "") -> Dict[str, Any]:
    """Build an addon_results row for an ENDO-LAL analysis.

    `matrix` selects the conformance threshold: Bacteriostatic Water uses
    < 0.25 EU/mL, peptides and unspecified matrices use the 5.0 default.
    """
    endo_limit, endo_spec = _endo_spec(matrix)
    e_res = analysis.get("Result", "")

    if _is_blank(e_res):
        return {
            "test_name": "Endotoxin (LAL)",
            "analyte_name": "Endotoxin",
            "test_type": "LIMIT",
            "specification": endo_spec,
            "result": "PENDING",
            "status": "PENDING",
            "conforms": None,
            "unit": _ENDO_UNIT,
            "status_color": "",
        }

    try:
        e_val = float(str(e_res).strip())
    except (ValueError, TypeError):
        return {
            "test_name": "Endotoxin (LAL)",
            "analyte_name": "Endotoxin",
            "test_type": "LIMIT",
            "specification": endo_spec,
            "result": "Fail",
            "status": "NOT EVALUATED",
            "conforms": None,
            "unit": _ENDO_UNIT,
            "status_color": "",
        }

    if e_val < endo_limit:
        return {
            "test_name": "Endotoxin (LAL)",
            "analyte_name": "Endotoxin",
            "test_type": "LIMIT",
            "specification": endo_spec,
            "result": "Pass",
            "status": "CONFORMS",
            "conforms": True,
            "unit": _ENDO_UNIT,
            "status_color": "",
        }
    return {
        "test_name": "Endotoxin (LAL)",
        "analyte_name": "Endotoxin",
        "test_type": "LIMIT",
        "specification": endo_spec,
        "result": "Fail",
        "status": "DOES NOT CONFORM",
        "conforms": False,
        "unit": _ENDO_UNIT,
        "status_color": _NONCONFORM_COLOR,
    }


def parse_sterility(analysis: Dict[str, Any]) -> Dict[str, Any]:
    """Build an addon_results row for a STER-PCR analysis."""
    raw_res = str(analysis.get("Result", "")).strip()
    title = analysis.get("title") or "Rapid Sterility Screening (PCR)"

    if _is_blank(raw_res):
        return {
            "test_name": title,
            "analyte_name": title,
            "test_type": "LIMIT",
            "specification": "Not Detected",
            "result": "PENDING",
            "status": "PENDING",
            "conforms": None,
            "unit": "",
            "status_color": "",
        }

    if raw_res == "0" or raw_res.lower() in ("not detected", "no growth", "negative"):
        s_res = "Pass"
    elif raw_res == "1" or raw_res.lower() in ("detected", "growth", "positive"):
        s_res = "Fail"
    else:
        s_res = raw_res

    if s_res.lower() in ("fail", "detected"):
        return {
            "test_name": title,
            "analyte_name": title,
            "test_type": "LIMIT",
            "specification": "Not Detected",
            "result": s_res,
            "status": "DOES NOT CONFORM",
            "conforms": False,
            "unit": "",
            "status_color": _NONCONFORM_COLOR,
        }
    return {
        "test_name": title,
        "analyte_name": title,
        "test_type": "LIMIT",
        "specification": "Not Detected",
        "result": s_res,
        "status": "CONFORMS",
        "conforms": True,
        "unit": "",
        "status_color": "",
    }


def parse_addon_results(
    analyses_by_keyword: Dict[str, Dict[str, Any]], matrix: str = ""
) -> List[Dict[str, Any]]:
    """Extract addon_results rows for any addon analyses present in the index.

    `analyses_by_keyword` is a {Keyword: analysis_dict} mapping (the same shape
    ConformanceEngine builds via `_index_analyses`). `matrix` is the sample's
    SampleTypeTitle, used to select per-matrix specs (e.g. the endotoxin limit).
    Returns rows in a stable order: Endotoxin first, Sterility second — matching
    how the existing PDF Page 2 template lays them out.
    """
    rows: List[Dict[str, Any]] = []
    endo = analyses_by_keyword.get("ENDO-LAL")
    if endo:
        rows.append(parse_endotoxin(endo, matrix))
    ster = analyses_by_keyword.get("STER-PCR")
    if ster:
        rows.append(parse_sterility(ster))
    return rows
