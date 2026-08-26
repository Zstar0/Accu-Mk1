"""Legacy-family rows projection for the COA wire document (seam 4, slice 1).

Emits SENAITE-cased dicts matching exactly what COABuilder's engines read
from `_Analyses_Detailed`. Row selection is delegated wholesale to
list_parent_analyses_senaite_shape — current-row resolution, retest
supersession, tier guard, and the cross-provenance canonical-wins keyword
collapse all live there; this module only filters to legacy families
(service_origin == 'senaite') and re-cases.

FAIL-CLOSED (NativeSectionsError): zero legacy rows, or a row without a
keyword. Until pure-native samples exist, an empty legacy set can only mean
a broken mirror, and an empty results table on a certificate is the silent
failure this program exists to prevent. Result may be None (pending micro
lines are legal — the engines own pending semantics).

Spec: docs/superpowers/specs/2026-08-26-coa-legacy-rows-mk1-source-design.md
"""
from coa.native_sections import NativeSectionsError

# Twin contract: src/coabuilder_core/legacy_rows.py + tests/
# test_legacy_rows_contract.py in the coabuilder repo pin the same tuple.
# Move both sides together.
FIELD_CONTRACT = (
    "uid", "Keyword", "Title", "ServiceTitle",
    "Result", "Unit", "review_state", "ResultCaptureDate",
)


def _shaped_rows(db, sample_id):
    from lims_analyses.service import list_parent_analyses_senaite_shape
    return list_parent_analyses_senaite_shape(db, sample_id)


def build_legacy_rows(db, parent) -> list[dict]:
    shaped = _shaped_rows(db, parent.sample_id)
    # Check for unresolvable service_origin (None) — indicates a broken service FK
    for r in shaped:
        if r.service_origin is None:
            raise NativeSectionsError(
                f"legacy rows: analysis {r.uid} on {parent.sample_id} has "
                f"unresolvable service origin — aborting")
    legacy = [r for r in shaped if r.service_origin == "senaite"]
    if not legacy:
        raise NativeSectionsError(
            f"legacy rows: no legacy-family analyses found for "
            f"{parent.sample_id} — refusing to assemble an empty results "
            f"table (mirror gap?)")
    rows = []
    for r in legacy:
        if not (r.keyword or "").strip():
            raise NativeSectionsError(
                f"legacy rows: analysis {r.uid} on {parent.sample_id} has no "
                f"keyword — aborting")
        rows.append({
            "uid": r.uid,
            "Keyword": r.keyword,
            "Title": r.title,
            "ServiceTitle": r.title,
            "Result": r.result,
            "Unit": r.unit,
            "review_state": r.review_state,
            "ResultCaptureDate": r.captured,
        })
    return rows
