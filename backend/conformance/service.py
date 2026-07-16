"""Selection rule + engine invocation. Mirrors coabuilder senaite_client.py:464-480,
which is NOT part of the vendored engine (it lives in the un-vendored orchestration
layer). Keep this rule identical to source."""
from __future__ import annotations

from conformance_vendored import ConformanceEngine, GenericAssayEngine

from .senaite_input import build_analyses_detailed, fetch_analysis_items, fetch_ar_blob

_PEPTIDE_MATRICES = {"Peptide", "Peptide Blend"}


def build_engine_input(sample_id: str) -> dict:
    """Fetch AR + analyses (2 SENAITE round-trips) and assemble the engine input."""
    ar = fetch_ar_blob(sample_id)
    analyses = fetch_analysis_items(sample_id)
    engine_input = dict(ar)
    engine_input["_Analyses_Detailed"] = build_analyses_detailed(analyses)
    return engine_input


def _select_engine(engine_input: dict) -> str:
    matrix = (engine_input.get("SampleTypeTitle")
              or engine_input.get("SampleType") or "")
    if isinstance(matrix, dict):  # SENAITE reference field
        matrix = matrix.get("title") or ""
    if matrix in _PEPTIDE_MATRICES or not matrix:
        return "peptide"
    return "generic"


def run_conformance(sample_id: str) -> dict:
    engine_input = build_engine_input(sample_id)
    kind = _select_engine(engine_input)
    if kind == "peptide":
        result = ConformanceEngine().process(engine_input)
    else:
        result = GenericAssayEngine().process(engine_input)
    canonical = result.get("canonical", {})
    return {
        "sample_id": sample_id,
        "engine": kind,
        "matrix": result.get("meta", {}).get("matrix")
                  or engine_input.get("SampleTypeTitle")
                  or engine_input.get("SampleType") or "",
        "overall_pass": bool(canonical.get("overall_pass", False)),
        "overall_status_badge": canonical.get("overall_status_badge", ""),
        "results_table": result.get("results_table", []),
        "addon_results": result.get("addon_results", []),
        "nonconformance_reasons": canonical.get("nonconformance_reasons", []),
    }
