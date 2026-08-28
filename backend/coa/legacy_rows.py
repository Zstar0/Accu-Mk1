"""Legacy-family rows projection for the COA wire document (seam 4, slice 1).

Emits SENAITE-cased dicts matching exactly what COABuilder's engines read
from `_Analyses_Detailed`. Row selection is delegated wholesale to
list_parent_analyses_senaite_shape — current-row resolution, retest
supersession, tier guard, and the cross-provenance canonical-wins keyword
collapse all live there; this module only filters to legacy families
(service_origin == 'senaite') and re-cases.

FAIL-CLOSED (NativeSectionsError): zero legacy rows (after the skip-state
filter below), a row without a keyword, or a row whose review_state is
None. Until pure-native samples exist, an empty legacy set can only mean a
broken mirror, and an empty results table on a certificate is the silent
failure this program exists to prevent. Result may be None (pending micro
lines are legal — the engines own pending semantics).

Skip states: mirrors the SENAITE path's `_collect_analyses_details`, which
always dropped review_state in {"retracted", "rejected", "cancelled"}
before this wire path existed. Mk1's emitter deliberately surfaces live
shadow rows with mirror_review_state='retracted' (correction window) and
permanently 'rejected' (A7 remove-analysis cascade) elsewhere in the app —
those must not reach the COA wire. Filtered BEFORE the zero-row check so an
all-skip-state sample hits the existing fail-closed empty abort.

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

# Wire contract, twin-pinned (see FIELD_CONTRACT docstring above) alongside
# src/coabuilder_core/legacy_rows.py in the coabuilder repo. Move both sides
# together.
SKIP_STATES = frozenset({"retracted", "rejected", "cancelled"})


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
    # review_state=None aborts producer-side (consumer requires a string;
    # same treatment as the missing-keyword abort below) — checked before
    # the skip-state filter so a None can't silently pass as "not in
    # SKIP_STATES".
    for r in legacy:
        if r.review_state is None:
            raise NativeSectionsError(
                f"legacy rows: analysis {r.uid} on {parent.sample_id} has "
                f"review_state=None — aborting")
    # Skip-state rows (retracted/rejected/cancelled) never ride the wire —
    # see module docstring. Filtered BEFORE the zero-row check so an
    # all-skip-state sample hits the existing fail-closed empty abort.
    legacy = [r for r in legacy if r.review_state not in SKIP_STATES]
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
