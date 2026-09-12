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

Native-born HPLC rows (service_origin == 'mk1', keyword in the HPLC
trio/aggregates) also ride this wire: coa/hplc_shim.py maps their
slot-generic keywords/titles into the same legacy vocabulary the engine
reads, keyed by the parent's resolved analyte slots. An unresolved slot
(no catalog peptide) aborts generation rather than shipping a blank title.

Spec: docs/superpowers/specs/2026-08-26-coa-legacy-rows-mk1-source-design.md
"""
from coa.hplc_shim import (
    UnresolvedNativeSlotError, is_native_hplc_row, slot_wires, wire_keyword, wire_title,
)
from coa.identity_verdict import identity_wire_result
from coa.native_sections import NativeSectionsError
from lims_analyses.hplc_native import TRIO

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
    legacy = [r for r in shaped if r.service_origin == "senaite" or is_native_hplc_row(r)]
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
    # {} for SENAITE-born parents (slot_wires short-circuits there).
    wires = {w.slot: w for w in slot_wires(db, parent)}
    n_slots = len(wires)
    rows = []
    for r in legacy:
        keyword, title = r.keyword, r.title
        if is_native_hplc_row(r):
            if (r.keyword or "").upper() in TRIO:
                wire = wires.get(r.slot)
                if wire is None:
                    raise NativeSectionsError(
                        f"legacy rows: {parent.sample_id} row {r.uid} (slot {r.slot}) "
                        f"has no registry analyte slot — registry/rows drift")
                if r.peptide_id is None or wire.peptide_id is None:
                    raise UnresolvedNativeSlotError(
                        sample_id=parent.sample_id, slot=r.slot, raw_name=wire.display_name)
                keyword = wire_keyword(r.keyword, r.slot, n_slots)
                title = wire_title(r.keyword, r.title, wire)
            else:
                keyword = wire_keyword(r.keyword, None, n_slots)
        if not (keyword or "").strip():
            raise NativeSectionsError(
                f"legacy rows: analysis {r.uid} on {parent.sample_id} has no "
                f"keyword — aborting")
        # Identity rows: Mk1 owns the verdict (coa/identity_verdict.py).
        # A conforming value rides as the literal "Conforms" token so
        # COABuilder never re-derives conformance from the slot-title vs
        # peptide-name pair (P-1986 class); everything else rides raw.
        # identity_wire_result keeps receiving the ROW keyword (e.g.
        # HPLC-IDENTITY) so is_identity_keyword still recognises it.
        wire_result = identity_wire_result(
            db, keyword=r.keyword, result=r.result,
            analysis_service_id=getattr(r, "analysis_service_id", None),
        )
        rows.append({
            "uid": r.uid,
            "Keyword": keyword,
            "Title": title,
            "ServiceTitle": title,
            "Result": wire_result,
            "Unit": r.unit,
            "review_state": r.review_state,
            "ResultCaptureDate": r.captured,
        })
    return rows
