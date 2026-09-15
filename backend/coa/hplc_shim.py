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

# Slice 8: the ONLY legal COA archetype value that routes native HPLC rows
# through this shim (owned here per plan; imported by the seed, legacy_rows,
# native_sections, and the main.py route).
LEGACY_HPLC_ARCHETYPE = "legacy_hplc"


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
    wires = [SlotWire(r.slot, r.display_name, r.peptide_id, r.reason) for r in resolve_slot_peptides(db, parent)]
    if len(wires) > 4:
        raise NativeSectionsError(
            "COABuilder page 1 renders at most 4 analyte slots")
    return wires


def is_native_hplc_row(row) -> bool:
    return (getattr(row, "service_origin", None) == "mk1"
            and (getattr(row, "keyword", "") or "").upper() in _NATIVE_KWS)


def native_hplc_service_archetypes(db, parent) -> dict | None:
    """{analysis_service_id: coa_archetype} for every native profile ordered
    on this sample (require_archetype=False — archetype is a rendering
    concern, not a visibility one; see native_sections._ordered_native_profiles).

    Returns None (not {}) when ownership could not be resolved at all (the
    IS order lookup failed, or db/parent lack what it needs) — distinct from
    a successful lookup that simply found no owner for a given service.
    coa/legacy_rows.py treats None as "can't tell, admit unchanged" and a
    resolved-but-absent service as "no legacy_hplc owner, exclude": a real
    primary-COA build already fail-closes on this same IS lookup one layer
    up (native_sections Rule 1), so tolerating an unresolvable lookup here
    is not new risk — it only keeps this module's own unit tests (which
    construct rows without wiring catalog/IS data) working unchanged.
    """
    from coa.native_sections import _lab_added_profile_keys, _ordered_native_profiles
    from sub_samples.service import fetch_sample_services

    if getattr(parent, "id", None) is None:
        # A real ORM LimsSample always has a pk; a SimpleNamespace/test
        # double built without one is a signal this isn't a resolvable
        # sample — skip the (network) lookup entirely rather than guess.
        return None
    try:
        raw = fetch_sample_services(parent.sample_id)
        services = dict(((raw or {}).get("services")) or {})
        for key in _lab_added_profile_keys(db, parent.id):
            if not services.get(key):
                services[key] = True
        profiles = _ordered_native_profiles(
            db, services, (raw or {}).get("package"), require_archetype=False)
    except Exception:  # noqa: BLE001 — an unresolvable lookup is "can't tell", not fatal
        return None
    mapping: dict = {}
    for prof in profiles:
        for svc in prof.analysis_services:
            mapping.setdefault(svc.id, prof.coa_archetype)
    return mapping


def native_hplc_profile_archetype(db, parent, row) -> str | None:
    """Owning native profile's coa_archetype for a single native HPLC row.
    Convenience wrapper over native_hplc_service_archetypes for one-off
    callers; coa/legacy_rows.py resolves the whole sample once per build
    (see native_hplc_service_archetypes) rather than calling this per row."""
    service_id = getattr(row, "analysis_service_id", None)
    if service_id is None:
        return None
    archetypes = native_hplc_service_archetypes(db, parent)
    return None if archetypes is None else archetypes.get(service_id)


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
