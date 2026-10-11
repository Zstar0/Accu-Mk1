"""Endotoxin worksheet v2 on the server (spec
docs/superpowers/specs/2026-10-10-endo-worksheet-v2-design.md, sections 3.6,
3.7, 4 and 10).

This module holds the values the run and row fields accept, the worksheet's
endo method, its allowed cartridges and the reader-serial lookup. The method
is resolved in a fixed number of queries and pinned at first print or first
reading. The 2 mL maths runs in the browser (src/lib/endo-prep-2ml.ts). The
server validates and stores what the bench typed or the reader exported. It
never writes a method onto analyses or worksheet items."""
import math
import re
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import (
    AuditLog, ConsumableType, HplcMethod, Instrument, LimsAnalysis, LimsSubSample,
    WorksheetItem, method_consumables, method_services,
)

ENDO_PREP_VALUES = ("2ml", "stock")
ENDO_FORMS = ("powder", "liquid", "bac")
# The consumable kind a worksheet's cartridges come from (catalog/consumables.py).
ENDO_CARTRIDGE = "endo_cartridge"
CARTRIDGE_REFUSED = ("That cartridge is retired, not an endotoxin cartridge, "
                     "or not allowed by this worksheet's method")
# worksheet_items.result_reading is String(40); Postgres refuses longer text.
_READING_MAX = 40
# Dead rows never speak for a vial: a retracted original keeps its old service
# while the current retest row carries the live one.
_DEAD_STATES = ("rejected", "retracted")


def parse_reading(text: str) -> tuple[bool, float]:
    """The instrument's display as typed: "0.8", "0", "<0.05" or "< 0.05".
    Returns (is_less_than, value). Raises ValueError with a readable reason.
    Same grammar as Dennis's parseResult (calc.js at 5ef2a62): whitespace is
    ignored, then an optional "<" and a plain decimal. A "<" needs a value
    above zero (spec 3.7)."""
    s = (text or "").strip()
    if not s:
        raise ValueError("A reading cannot be empty; send null to clear it")
    if len(s) > _READING_MAX:
        raise ValueError(f"A reading is at most {_READING_MAX} characters")
    m = re.fullmatch(r"(<)?([0-9]*\.?[0-9]+)", re.sub(r"\s+", "", s))
    if not m:
        raise ValueError(f"'{s}' is not a reading: type a number such as 0.8, "
                         "or < and a number such as <0.05")
    lt, value = bool(m.group(1)), float(m.group(2))
    if lt and value <= 0:
        raise ValueError("A '<' reading needs a number above zero, such as <0.05")
    return lt, value


def validate_prep_steps(value) -> list:
    """A row's own step values (spec 3.7): exactly three entries, one per
    step. Each entry is null (standard), or [sample_ul, ratio] for step 1 and
    [sample_ul] for steps 2 and 3. A null field inside an entry means standard
    for that field. sample_ul > 0; step 1 ratio >= 1. Raises ValueError."""
    if not isinstance(value, list) or len(value) != 3:
        raise ValueError("prep_steps needs exactly three entries, one per step")
    for i, entry in enumerate(value, start=1):
        if entry is None:
            continue
        width = 2 if i == 1 else 1
        if not isinstance(entry, list) or not 1 <= len(entry) <= width:
            shape = "[sample_ul, ratio]" if i == 1 else "[sample_ul]"
            raise ValueError(f"prep_steps step {i} must be {shape} or null")
        for v in entry:
            try:
                ok = v is None or (not isinstance(v, bool) and isinstance(v, (int, float))
                                   and math.isfinite(v))
            except OverflowError:  # an int too big for a float: a 400, not a 500
                ok = False
            if not ok:
                raise ValueError(f"prep_steps step {i} values must be numbers or null")
        if entry[0] is not None and entry[0] <= 0:
            raise ValueError(f"prep_steps step {i}: sample uL must be greater than zero")
        if i == 1 and len(entry) == 2 and entry[1] is not None and entry[1] < 1:
            raise ValueError("prep_steps step 1: ratio must be at least 1")
    return value


def _endo_method_id(db: Session, worksheet_id: int) -> Optional[int]:
    """The one active default method behind every endo row's vial (spec 4.1),
    or None.

    Three queries whatever the row count: the rows with their vials, the
    vials' live analyses, then those services' active default methods. Never
    per item: a per-item lookup in the shared serializer is the fan-out class
    behind the 2026-09-15 pool outage. The rule is strict. A worksheet with
    no endo rows, an endo row with no vial (a legacy bare parent id), a vial
    with no live analysis, or a service with no active default method all
    resolve to None. So do two rows that disagree."""
    from main import _bench_kind_for_item  # lazy: main imports this module too

    rows = db.execute(
        select(WorksheetItem.analyses_json, LimsSubSample.id.label("vial_pk"),
               LimsSubSample.assignment_role)
        .outerjoin(LimsSubSample, LimsSubSample.sample_id == WorksheetItem.sample_id)
        .where(WorksheetItem.worksheet_id == worksheet_id)
    ).all()
    vial_pks = {r.vial_pk for r in rows
                if _bench_kind_for_item(r.assignment_role, r.analyses_json) == "endo"}
    if not vial_pks or None in vial_pks:
        return None
    services_by_vial: dict[int, set[int]] = {pk: set() for pk in vial_pks}
    for pk, service_id in db.execute(
        select(LimsAnalysis.lims_sub_sample_pk, LimsAnalysis.analysis_service_id).where(
            LimsAnalysis.lims_sub_sample_pk.in_(vial_pks),
            # The vial-row "current" idiom: the newest row of a retest chain.
            LimsAnalysis.retested.is_(False),
            LimsAnalysis.review_state.notin_(_DEAD_STATES),
        )
    ).all():
        services_by_vial[pk].add(service_id)
    if not all(services_by_vial.values()):
        return None
    method_by_service = dict(db.execute(
        select(method_services.c.analysis_service_id, method_services.c.method_id)
        .join(HplcMethod, HplcMethod.id == method_services.c.method_id)
        .where(method_services.c.analysis_service_id.in_(set().union(*services_by_vial.values())),
               method_services.c.is_default.is_(True),
               HplcMethod.status == "active")
    ).all())
    methods = {method_by_service.get(s) for services in services_by_vial.values() for s in services}
    return methods.pop() if len(methods) == 1 and None not in methods else None


def _method_payload(db: Session, method_id: int) -> Optional[dict]:
    """The endo_method wire shape: the revision, its stored run_parameters
    (as is; the browser applies Dennis's defaults to missing keys) and every
    endo cartridge linked to it, retired ones included. Two queries."""
    method = db.execute(select(HplcMethod).where(HplcMethod.id == method_id)).scalar_one_or_none()
    if method is None:
        return None
    links = db.execute(
        select(ConsumableType, method_consumables.c.is_default)
        .join(method_consumables, method_consumables.c.consumable_type_id == ConsumableType.id)
        .where(method_consumables.c.method_id == method.id,
               ConsumableType.kind == ENDO_CARTRIDGE)
        .order_by(ConsumableType.name)
    ).all()
    return {
        "id": method.id,
        "name": method.name,
        "revision": method.revision,
        "status": method.status,
        "run_parameters": method.run_parameters,
        "cartridges": [
            {"id": ct.id, "name": ct.name,
             "sensitivity_eu_ml": (ct.specs or {}).get("sensitivity_eu_ml"),
             "is_default": bool(is_default), "active": ct.active}
            for ct, is_default in links
        ],
    }


def resolve_endo_method(db: Session, worksheet) -> Optional[dict]:
    """The worksheet's endo method (spec 4.1). This is the pinned revision
    when there is one, else the single active default method every endo row
    resolves to, else None. At most five queries. Callers: GET
    /worksheets/{id}, the item PATCH and the reader import, never a list."""
    method_id = worksheet.endo_method_id or _endo_method_id(db, worksheet.id)
    return _method_payload(db, method_id) if method_id else None


def allowed_cartridge_ids(db: Session, worksheet) -> set[int]:
    """Cartridges a run or a row may choose (spec 4.3). A method that lists
    one or more endo cartridges allows only its active ones. When no method
    resolves (the legacy ENDO-LAL test, say), or the method lists none yet
    (lead decision 2026-10-10), every active endo cartridge is allowed."""
    method = resolve_endo_method(db, worksheet)
    if method is not None and method["cartridges"]:
        return {c["id"] for c in method["cartridges"] if c["active"]}
    return set(db.execute(select(ConsumableType.id).where(
        ConsumableType.kind == ENDO_CARTRIDGE, ConsumableType.active.is_(True))).scalars())


def pin_endo_method(db: Session, worksheet, user_id: Optional[int]) -> bool:
    """Store the resolved method revision on the worksheet at its first print
    or first reading (spec 4.1). After that its run parameters and cartridges
    never move. A no-op when already pinned, when nothing resolves, or on a
    completed worksheet (read-only). Callers commit."""
    if worksheet.endo_method_id is not None or worksheet.status == "completed":
        return False
    method_id = _endo_method_id(db, worksheet.id)
    if method_id is None:
        return False
    worksheet.endo_method_id = method_id
    db.add(AuditLog(
        operation="endo_method_pinned",
        entity_type="worksheet",
        entity_id=str(worksheet.id),
        details={"user_id": user_id, "old": None, "new": method_id},
    ))
    return True


def instrument_id_for_serial(db: Session, serial) -> Optional[int]:
    """The active instrument a reader record's serial names (spec 4.5), or
    None. serial_number is stored stripped and is unique where set (Task 4),
    so the reader's serial is stripped too and matched exactly."""
    s = serial.strip() if isinstance(serial, str) else ""
    if not s:
        return None
    return db.execute(select(Instrument.id).where(
        Instrument.serial_number == s, Instrument.active.is_(True))).scalar_one_or_none()


def cartridge_sensitivities(db: Session, ids) -> dict[int, Optional[float]]:
    """Sensitivity (EU/mL) per consumable type id, retired types included,
    because a result keeps the cartridge it was computed with. ONE query for
    a whole page of worksheets."""
    if not ids:
        return {}
    return {
        r.id: (r.specs or {}).get("sensitivity_eu_ml")
        for r in db.execute(select(ConsumableType.id, ConsumableType.specs)
                            .where(ConsumableType.id.in_(ids))).all()
    }
