"""
Generic assay engine for non-peptide matrices (Bacteriostatic Water, Sterile
Water, small molecules, etc).

Emits the same `process(senaite_json) -> dict` shape that ConformanceEngine
produces, so SenaiteClient.fetch_sample_data can consume either engine without
changes.

Unlike the peptide ConformanceEngine, this engine:
  - Makes no assumption about peptide slots, blend identity, or blend totals.
  - Builds one results_table row per SENAITE analysis, passing through
    Title/Result/Unit verbatim.
  - Leaves peptide-specific canonical fields empty.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from .addon_parsing import ADDON_KEYWORDS, parse_addon_results
from .baked_specs import lookup_spec, lookup_technique

logger = logging.getLogger(__name__)


# Status conventions mirror the peptide ConformanceEngine:
#   CONFORMS         -> empty color (template default green)
#   DOES NOT CONFORM -> #444F5B dark slate text
#   NOT EVALUATED    -> empty color (template default)
#   NOT TESTED       -> empty color (used when no result present yet)
#
# Overall badge stays PASSED/FAILED/IN REVIEW for the top-level rollup so it
# matches what peptide COAs show on the sample-level status.

_STATUS_CONFORMS = "CONFORMS"
_STATUS_NONCONFORMS = "DOES NOT CONFORM"
_STATUS_NOT_EVALUATED = "NOT EVALUATED"
_STATUS_NOT_TESTED = "NOT TESTED"
_STATUS_MEASURED = "MEASURED"  # informational — result reported, no spec to evaluate against
_COLOR_DEFAULT = ""          # blank = use template's frame color (green)
_COLOR_NONCONFORM = "#444F5B"  # matches peptide "DOES NOT CONFORM" slate

# SENAITE review_state → (status, color) for the no-spec fallback path.
# If a result has been entered (to_be_verified onward) we call it MEASURED —
# the value stands on its own as informational. If no result yet, NOT TESTED.
_STATUS_MAP = {
    "to_be_sampled": (_STATUS_NOT_TESTED, _COLOR_DEFAULT),
    "sample_due": (_STATUS_NOT_TESTED, _COLOR_DEFAULT),
    "sample_received": (_STATUS_NOT_TESTED, _COLOR_DEFAULT),
    "attachment_due": (_STATUS_NOT_TESTED, _COLOR_DEFAULT),
    "to_be_verified": (_STATUS_MEASURED, _COLOR_DEFAULT),
    "verified": (_STATUS_MEASURED, _COLOR_DEFAULT),
    "published": (_STATUS_MEASURED, _COLOR_DEFAULT),
}


def _format_total_qty(dtq: Any) -> str:
    """SENAITE DeclaredTotalQuantity -> SAMPLE SIZE string.

    Mirrors conformance.py's peptide-side formatting ("501.00 mg"). The generic
    engine currently only serves Bacteriostatic Water, where mL is the natural
    unit. If we add other non-peptide matrices later, drive the unit from the
    matrix name. Empty/non-numeric input returns "" so downstream slot-fill
    logic can decide a fallback.
    """
    if dtq is None:
        return ""
    s = str(dtq).strip()
    if not s:
        return ""
    try:
        return f"{float(s):g} mL"
    except (TypeError, ValueError):
        return ""


class GenericAssayEngine:
    """
    Minimal conformance engine for non-peptide samples.

    Responsible for:
      - meta: sample + matrix metadata (same fields as peptide engine)
      - results_table: one row per analysis, faithful to SENAITE values
      - canonical: sample-level status rollup (no blend math)

    Peptide-specific fields (declared_peptides, client_spec, measured) are
    returned empty so downstream CoAData mapping stays uniform.
    """

    def process(self, senaite_json: Dict[str, Any]) -> Dict[str, Any]:
        analyses = senaite_json.get("_Analyses_Detailed", []) or []

        matrix = (
            senaite_json.get("SampleTypeTitle")
            or senaite_json.get("SampleType")
            or ""
        )

        # Partition analyses: addon services (Endotoxin, Sterility) go to
        # addon_results so the COA can render them on page 2; everything else
        # stays in results_table (core BA / pH / Fill rows for BW).
        addon_kw_set = set(ADDON_KEYWORDS)
        analyses_by_keyword: Dict[str, Dict[str, Any]] = {}
        for a in analyses:
            kw = a.get("Keyword")
            if kw and kw in addon_kw_set:
                analyses_by_keyword[kw] = a
        addon_results_table: List[Dict[str, Any]] = parse_addon_results(analyses_by_keyword, matrix)

        results_table: List[Dict[str, Any]] = []
        any_failed = False
        any_pending = False
        fail_reasons: List[str] = []

        for a in analyses:
            if a.get("Keyword") in addon_kw_set:
                continue  # Already routed to addon_results.
            row = self._row_from_analysis(a, matrix)
            if row is None:
                continue
            results_table.append(row)
            status = row.get("status", "")
            if status == _STATUS_NONCONFORMS:
                any_failed = True
                fail_reasons.append(
                    f"{row['test_name']}: {row['result']} outside {row['specification']}"
                )
            elif status in (_STATUS_NOT_TESTED, _STATUS_NOT_EVALUATED):
                any_pending = True

        # Roll addon outcomes into the overall verdict — a failed sterility
        # or endotoxin should mark the whole sample FAILED, and a pending
        # addon should keep it IN REVIEW.
        for row in addon_results_table:
            status = row.get("status", "")
            if status == _STATUS_NONCONFORMS:
                any_failed = True
                fail_reasons.append(
                    f"{row['test_name']}: {row['result']} outside {row['specification']}"
                )
            elif status in ("PENDING", _STATUS_NOT_TESTED, _STATUS_NOT_EVALUATED):
                any_pending = True

        # Overall status: FAILED if any out-of-spec; IN REVIEW if any still
        # pending reviewer verification; PASSED only when all rows verified
        # AND inside spec.
        has_any_rows = bool(results_table) or bool(addon_results_table)
        if any_failed:
            overall_badge = "FAILED"
            overall_pass = False
            reasons = fail_reasons
        elif any_pending or not has_any_rows:
            overall_badge = "IN REVIEW"
            overall_pass = False
            reasons = ["Analyses pending reviewer verification"] if any_pending else ["No analyses present"]
        else:
            overall_badge = "PASSED"
            overall_pass = True
            reasons = []

        date_received = self._format_date(senaite_json.get("DateReceived") or senaite_json.get("getDateReceived"))
        date_published = datetime.now().strftime("%m/%d/%Y")

        return {
            "meta": {
                "sample_id": senaite_json.get("SampleID") or senaite_json.get("id"),
                "client_sample_id": senaite_json.get("getClientSampleID") or senaite_json.get("ClientSampleID") or "",
                "client": senaite_json.get("getClientTitle") or "",
                "matrix": matrix,
                "date_received": date_received,
                "date_published": date_published,
                "lot_code": senaite_json.get("ClientLot") or senaite_json.get("getBatchID") or "",
            },
            "canonical": {
                # Peptide-specific fields intentionally empty for generic engine,
                # EXCEPT declared_blend_total_qty which is reused as the SAMPLE
                # SIZE slot on Generic Page 1 (template stacks reference_identity,
                # matrix_type, sample_name, sample_size, lot_code — empty rows
                # slide up, so leaving this blank causes lot_code to render in
                # the SAMPLE SIZE slot).
                "declared_components": [],
                "declared_blend_total_qty": _format_total_qty(senaite_json.get("DeclaredTotalQuantity")),
                "measured_blend_total_qty": "",
                "measured_blend_total_purity": "",
                "blend_identity_status": "",
                "overall_status_badge": overall_badge,
                "overall_pass": overall_pass,
                "nonconformance_reasons": reasons,
                "results_interpretation": "",
            },
            "declared_peptides": [],
            "client_spec": {},
            "measured": {},
            "results_table": results_table,
            "addon_results": addon_results_table,
        }

    # -- helpers ---------------------------------------------------------------

    def _row_from_analysis(self, analysis: Dict[str, Any], matrix: str) -> Optional[Dict[str, Any]]:
        title = analysis.get("title") or analysis.get("Title") or analysis.get("Keyword")
        if not title:
            logger.warning(f"Skipping analysis with no title: uid={analysis.get('uid')}")
            return None

        keyword = analysis.get("Keyword") or ""
        raw_result = analysis.get("Result")
        unit = (analysis.get("Unit") or "").strip()

        result_str = "" if raw_result in (None, "") else str(raw_result).strip()
        # Append unit if present and not already encoded in the result string.
        # Skip units SENAITE sometimes returns as a self-referential label
        # (e.g. Unit="pH" on a pH test — dimensionless, but the SENAITE service
        # was configured with a unit string).
        display_result = result_str
        if result_str and unit and unit.lower() != "ph" and unit not in result_str:
            display_result = f"{result_str} {unit}"

        # Conformance: baked spec → min/max check → PASSED/FAILED verdict.
        # Falls back to review-state mapping when no spec is defined so pending
        # analyses still render cleanly without claiming pass/fail.
        spec = lookup_spec(matrix, keyword)
        specification, status, status_color, conforms = self._resolve_status(
            spec, raw_result, analysis.get("review_state", "")
        )

        return {
            "test_name": title,
            "analyte_name": title,
            "test_type": lookup_technique(keyword),  # HPLC / pH / Gravimetric — shown in COA "Test" column
            "specification": specification,
            "result": display_result,
            "status": status,
            "status_color": status_color,
            "conforms": conforms,
            "unit": unit,
        }

    def _resolve_status(
        self,
        spec: Optional[Dict[str, Any]],
        raw_result: Any,
        review_state: str,
    ) -> tuple[str, str, str, Optional[bool]]:
        """
        Return (specification_display, status, status_color, conforms).

        Wording matches the peptide ConformanceEngine:
          - In-spec result            -> CONFORMS          (template default color)
          - Out-of-spec result        -> DOES NOT CONFORM  (slate, #444F5B)
          - No spec to evaluate       -> NOT EVALUATED     (template default)
          - No result entered yet     -> NOT TESTED        (template default)
        """
        if spec is not None:
            spec_display = spec.get("display") or self._format_spec_range(spec)
            try:
                val = float(str(raw_result).strip())
            except (TypeError, ValueError):
                # Spec exists but we couldn't parse a number — defer judgment.
                status, color = _STATUS_MAP.get(review_state, (_STATUS_NOT_EVALUATED, _COLOR_DEFAULT))
                return spec_display, status, color, None

            lo = spec.get("min")
            hi = spec.get("max")
            conforms = True
            if lo is not None and val < lo:
                conforms = False
            if hi is not None and val > hi:
                conforms = False

            if not conforms:
                return spec_display, _STATUS_NONCONFORMS, _COLOR_NONCONFORM, False
            # In-spec — call it CONFORMS whether or not the reviewer has
            # verified yet. Consistent with peptide engine which doesn't
            # gate CONFORMS on review_state either.
            return spec_display, _STATUS_CONFORMS, _COLOR_DEFAULT, True

        # No baked spec — fall back to SENAITE-driven spec (future) and
        # review-state mapping.
        specification = self._extract_specification({})
        status, color = _STATUS_MAP.get(review_state, (_STATUS_NOT_EVALUATED, _COLOR_DEFAULT))
        return specification, status, color, None

    @staticmethod
    def _format_spec_range(spec: Dict[str, Any]) -> str:
        lo = spec.get("min")
        hi = spec.get("max")
        unit = spec.get("unit", "")
        unit_suffix = f" {unit}" if unit else ""
        if lo is not None and hi is not None:
            return f"{lo} – {hi}{unit_suffix}"
        if lo is not None:
            return f"≥ {lo}{unit_suffix}"
        if hi is not None:
            return f"≤ {hi}{unit_suffix}"
        return "—"

    def _extract_specification(self, analysis: Dict[str, Any]) -> str:
        """
        Pull a printable spec string from a SENAITE analysis if one is set.

        SENAITE stores min/max ranges on the linked Analysis Specification.
        For now we look at the analysis's ResultsRange or fall back to a
        placeholder. Can be extended later to resolve specs via spec UID.
        """
        rr = analysis.get("ResultsRange") or analysis.get("Specification") or {}
        if isinstance(rr, dict):
            lo = rr.get("min") or rr.get("Min") or ""
            hi = rr.get("max") or rr.get("Max") or ""
            if lo and hi:
                return f"{lo} – {hi}"
            if lo:
                return f"≥ {lo}"
            if hi:
                return f"≤ {hi}"
        return "—"

    def _format_date(self, raw: Optional[str]) -> str:
        if not raw:
            return ""
        # SENAITE returns ISO-ish strings like "2026-04-22T20:30:00".
        for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
            try:
                return datetime.strptime(raw[:19], fmt).strftime("%m/%d/%Y")
            except (ValueError, TypeError):
                continue
        return str(raw)
