"""COA wire vocabulary for NATIVE-BORN Bac Water rows (spec 2026-10-05 MB5).

Created minimal by the intake section (task M1) because the catalog seed
needs LEGACY_BW_ARCHETYPE before the COA section lands. The COA section
extends THIS file (is_native_bw_row, wire mapping); the keyword constants
live in catalog/bw_keys.py and are only re-exported here, never redefined.
"""
from catalog.bw_keys import BW_NATIVE_KEYWORDS, NATIVE_TO_LEGACY_KEYWORD  # noqa: F401

# The ONLY coa_archetype value that routes native BW rows onto page 1 via
# this shim. Imported by catalog/bw_native_seed.py.
LEGACY_BW_ARCHETYPE = "legacy_bw"


# --- COA wire (MB5) ---------------------------------------------------------
# A native BW row rides coa/legacy_rows.py's page-1 wire under the SENAITE
# keyword/title COABuilder's GenericAssayEngine already reads (baked-spec
# fallback, technique column, variance keying). This module is the ONE place
# that mapping lives. Keep it import-light: main.py and native_sections import
# it, so it must never import coa.native_sections / coa.hplc_shim /
# coa.legacy_rows at module level.


def is_native_bw_row(row) -> bool:
    """A native-born Bac Water panel row: an mk1-origin service carrying one
    of the native BW keywords. Twin of coa.hplc_shim.is_native_hplc_row."""
    return (getattr(row, "service_origin", None) == "mk1"
            and (getattr(row, "keyword", "") or "").upper() in BW_NATIVE_KEYWORDS)


def bw_wire_keyword(keyword: str) -> str:
    """Native BW keyword -> the legacy SENAITE keyword on the wire."""
    try:
        return NATIVE_TO_LEGACY_KEYWORD[(keyword or "").upper()]
    except KeyError:
        raise ValueError(f"not a native BW keyword: {keyword!r}") from None


def bw_wire_title(db, keyword: str, row_title: str) -> str:
    """The title the legacy SENAITE service carries for this row's wire
    keyword, read from the Mk1 catalog (origin='senaite' only; lowest id wins
    for determinism), so a native row prints the same test name a SENAITE-born
    BW certificate prints. Falls back to the native row's own title when there
    is no catalog to consult (db=None, the unit-test seam legacy_rows already
    tolerates) or no legacy service row exists."""
    if db is None:
        return row_title
    from sqlalchemy import select

    from models import AnalysisService
    title = db.execute(
        select(AnalysisService.title).where(
            AnalysisService.keyword == bw_wire_keyword(keyword),
            AnalysisService.origin == "senaite",
        ).order_by(AnalysisService.id)
    ).scalars().first()
    return title or row_title
