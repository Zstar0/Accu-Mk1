"""COA wire vocabulary for NATIVE-BORN HPLC rows (spec 2026-09-10 M7).

COABuilder page 1 is untouched: its vendored ladder indexes by bare Keyword
(last writer wins), matches identity by Title == Analyte{N}Peptide, then
ANALYTE-{n}-ID, and reads ANALYTE-{n}-PUR/QTY (blend) or HPLC-PUR/PEPT-Total
(single), BLEND-PUR/PEPT-Total (aggregates). Native rows carry generic
keywords shared across slots, so this module is the ONE place that maps a
native parent-tier row to the legacy keyword + title the engine expects.
Both legacy_rows (row Title) and sample_meta (Analyte{N}Peptide) derive from
slot_wires() so the two strings the engine compares cannot drift.
"""
from dataclasses import dataclass
from typing import Optional

from coa.native_sections import NativeSectionsError
from lims_analyses.hplc_native import (
    AGGREGATES, KW_BLEND_PURITY, KW_BLEND_TOTAL, KW_IDENTITY, KW_PURITY, KW_QUANTITY, TRIO,
    identity_title, is_native_born, purity_title, quantity_title, resolve_slot_peptides,
)

_NATIVE_KWS = frozenset(TRIO + AGGREGATES)


@dataclass(frozen=True)
class SlotWire:
    slot: int
    display_name: str
    peptide_id: Optional[int]
    reason: Optional[str]

    @property
    def identity_title(self) -> str:
        return identity_title(self.display_name)


class UnresolvedNativeSlotError(NativeSectionsError):
    def __init__(self, *, sample_id: str, slot: int, raw_name: str):
        super().__init__(
            f"{sample_id}: analyte slot {slot} ({raw_name!r}) is unresolved — "
            f"relabel it to a catalog peptide before generating the COA")


def slot_wires(db, parent) -> list[SlotWire]:
    if not is_native_born(parent):
        return []
    return [SlotWire(r.slot, r.display_name, r.peptide_id, r.reason) for r in resolve_slot_peptides(db, parent)]


def is_native_hplc_row(row) -> bool:
    return (getattr(row, "service_origin", None) == "mk1"
            and (getattr(row, "keyword", "") or "").upper() in _NATIVE_KWS)


def wire_keyword(keyword: str, slot: Optional[int], n_slots: int) -> str:
    kw = (keyword or "").upper()
    if kw == KW_IDENTITY:
        return f"ANALYTE-{slot}-ID"
    if kw == KW_PURITY:
        return "HPLC-PUR" if n_slots == 1 else f"ANALYTE-{slot}-PUR"
    if kw == KW_QUANTITY:
        return "PEPT-Total" if n_slots == 1 else f"ANALYTE-{slot}-QTY"
    if kw == KW_BLEND_PURITY:
        return "BLEND-PUR"
    if kw == KW_BLEND_TOTAL:
        return "PEPT-Total"
    raise ValueError(f"not a native HPLC keyword: {keyword!r}")


def wire_title(keyword: str, row_title: str, wire: Optional[SlotWire]) -> str:
    kw = (keyword or "").upper()
    if kw in AGGREGATES or wire is None:
        return row_title
    if kw == KW_IDENTITY:
        return wire.identity_title
    if kw == KW_PURITY:
        return purity_title(wire.display_name)
    if kw == KW_QUANTITY:
        return quantity_title(wire.display_name)
    return row_title
