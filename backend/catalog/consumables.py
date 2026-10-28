"""Consumables catalog (endo worksheet v2, spec 2026-10-10 sections 3.1 and 3.2).

A kind is one CONSUMABLE_KINDS entry plus rows in consumable_types; `specs`
holds the kind's numbers and is validated here. Once a worksheet or a worksheet
item references a type, or a method revision that is no longer a draft links
it, its kind and specs are locked: a wrong number is fixed by retiring the type
and adding a new one, so every result keeps the numbers it was computed with
and every issued revision the numbers it was issued with.
"""
import math

from sqlalchemy import select, union
from sqlalchemy.orm import Session

from models import HplcMethod, Worksheet, WorksheetItem, method_consumables

# Spec entry fields are what GET /consumables/kinds serves to build the admin form.
CONSUMABLE_KINDS: dict[str, dict] = {
    "endo_cartridge": {
        "label": "Endotoxin cartridge",
        "specs": {
            # The cartridge's lambda: its sensitivity is the LOD.
            "sensitivity_eu_ml": {"label": "Sensitivity", "unit": "EU/mL",
                                  "type": "positive_float", "required": True},
        },
    },
}

CONSUMABLE_LOG_FIELDS = ("kind", "name", "manufacturer", "part_number", "instrument_id", "specs", "active")


def is_positive_finite_number(value) -> bool:
    """True for a real number (bool is not one) that is finite and above zero.
    An int too big for a float counts as not finite: math.isfinite raises
    OverflowError on it, which would escape a route's ValueError handler as a 500."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value) and value > 0
    except OverflowError:
        return False


class ConsumableSpecError(ValueError):
    """A kind or specs value the registry refuses (the routes answer 400)."""


def validate_specs(kind: str, specs: dict) -> dict:
    """Return `specs` checked against the kind's registry entry: known kind,
    a dict, no unknown keys, every required key present, numbers positive and
    finite. Raises ConsumableSpecError naming the problem."""
    entry = CONSUMABLE_KINDS.get(kind)
    if entry is None:
        raise ConsumableSpecError(f"unknown kind '{kind}'; known: {', '.join(sorted(CONSUMABLE_KINDS))}")
    if not isinstance(specs, dict):
        raise ConsumableSpecError("specs must be an object")
    unknown = sorted(set(specs) - set(entry["specs"]))
    if unknown:
        raise ConsumableSpecError(f"unknown spec(s) for {kind}: {', '.join(unknown)}")
    clean = {}
    for key, field in entry["specs"].items():
        value = specs.get(key)
        if value is None:
            if field["required"]:
                raise ConsumableSpecError(f"{key} is required for {kind}")
            continue
        if not is_positive_finite_number(value):
            raise ConsumableSpecError(f"{key} must be a positive number")
        clean[key] = float(value)
    return clean


def _issued_method_links():
    """Type ids linked to a method revision that is not a draft (active or
    retired). A draft's links can still change, so they lock nothing."""
    return (select(method_consumables.c.consumable_type_id)
            .join(HplcMethod, HplcMethod.id == method_consumables.c.method_id)
            .where(HplcMethod.status != "draft"))


def consumable_in_use(db: Session, type_id: int) -> bool:
    """True once a worksheet (run cartridge), a worksheet item (row
    cartridge) or a non-draft method revision references the type."""
    for col in (Worksheet.cartridge_type_id, WorksheetItem.cartridge_type_id):
        if db.execute(select(col).where(col == type_id).limit(1)).first() is not None:
            return True
    issued = _issued_method_links().where(method_consumables.c.consumable_type_id == type_id)
    return db.execute(issued.limit(1)).first() is not None


def used_type_ids(db: Session) -> set[int]:
    """Every referenced type id in one query, for list endpoints."""
    q = union(
        select(Worksheet.cartridge_type_id).where(Worksheet.cartridge_type_id.is_not(None)),
        select(WorksheetItem.cartridge_type_id).where(WorksheetItem.cartridge_type_id.is_not(None)),
        _issued_method_links(),
    )
    return set(db.execute(q).scalars().all())


def kinds_payload() -> list[dict]:
    """The registry as GET /consumables/kinds serves it."""
    return [
        {"key": key, "label": entry["label"],
         "specs": [{"key": sk, **field} for sk, field in entry["specs"].items()]}
        for key, entry in CONSUMABLE_KINDS.items()
    ]
