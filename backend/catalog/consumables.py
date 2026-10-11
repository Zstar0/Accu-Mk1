"""Consumables catalog (endo worksheet v2, spec 2026-10-10 sections 3.1 and 3.2).

A kind is one CONSUMABLE_KINDS entry plus rows in consumable_types; `specs`
holds the kind's numbers and is validated here. Once a worksheet or a worksheet
item references a type, its kind and specs are locked: a wrong number is fixed
by retiring the type and adding a new one, so every result keeps the numbers it
was computed with.
"""
import math

from sqlalchemy import select, union
from sqlalchemy.orm import Session

from models import Worksheet, WorksheetItem

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
        # bool is an int in Python; a checkbox value is not a number here.
        if (isinstance(value, bool) or not isinstance(value, (int, float))
                or not math.isfinite(value) or value <= 0):
            raise ConsumableSpecError(f"{key} must be a positive number")
        clean[key] = float(value)
    return clean


def consumable_in_use(db: Session, type_id: int) -> bool:
    """True once a worksheet (run cartridge) or a worksheet item (row
    cartridge) references the type."""
    for col in (Worksheet.cartridge_type_id, WorksheetItem.cartridge_type_id):
        if db.execute(select(col).where(col == type_id).limit(1)).first() is not None:
            return True
    return False


def used_type_ids(db: Session) -> set[int]:
    """Every referenced type id in one query, for list endpoints."""
    q = union(
        select(Worksheet.cartridge_type_id).where(Worksheet.cartridge_type_id.is_not(None)),
        select(WorksheetItem.cartridge_type_id).where(WorksheetItem.cartridge_type_id.is_not(None)),
    )
    return set(db.execute(q).scalars().all())


def kinds_payload() -> list[dict]:
    """The registry as GET /consumables/kinds serves it."""
    return [
        {"key": key, "label": entry["label"],
         "specs": [{"key": sk, **field} for sk, field in entry["specs"].items()]}
        for key, entry in CONSUMABLE_KINDS.items()
    ]
