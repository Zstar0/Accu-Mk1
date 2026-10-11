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
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from catalog.method_run_params import ENDO_RUN_PARAM_DEFAULTS
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
        # ascii(): '0,8' still reads '0,8', but a lone surrogate is escaped,
        # so the 400 can be encoded (echoed raw, it became a 500).
        raise ValueError(f"{ascii(s)} is not a reading: type a number such as 0.8, "
                         "or < and a number such as <0.05")
    lt, value = bool(m.group(1)), float(m.group(2))
    if lt and value <= 0:
        raise ValueError("A '<' reading needs a number above zero, such as <0.05")
    return lt, value


def _finite(v) -> bool:
    """math.isfinite, except that an int too big for a float counts as not
    finite. isfinite raises OverflowError on 10**400, which would be a 500;
    spec 10 wants a 400 with the reason."""
    try:
        return math.isfinite(v)
    except OverflowError:
        return False


def check_storable(value, what: str) -> None:
    """Refuse a reader-import value that cannot be stored and served back
    (spec 10: a 400 with the reason, never a 500). FastAPI's json.loads
    accepts NaN, Infinity (1e400 arrives as inf), lone surrogates and NUL.
    Postgres json refuses NaN and Infinity at commit; a lone surrogate cannot
    be written as UTF-8, so the response and every later GET of the stored
    record would fail; Postgres refuses a NUL in a query parameter (the
    reader serial lookup). The reason never echoes the value. Walks without
    recursion. Raises ValueError."""
    stack = [value]
    while stack:
        v = stack.pop()
        if isinstance(v, dict):
            stack.extend(v.items())
        elif isinstance(v, (list, tuple)):
            stack.extend(v)
        elif ((isinstance(v, float) and not math.isfinite(v))
              or (isinstance(v, str) and not _clean_text(v))):
            raise ValueError(f"{what} holds NaN, Infinity, a NUL character or invalid Unicode")


def _clean_text(s: str) -> bool:
    """Writable as UTF-8 (no lone surrogate) and free of NUL."""
    try:
        s.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return "\x00" not in s


# The reader record (spec 8.4) as the browser sends it; the server adds
# imported_at and imported_by_user_id and recomputes valid and why.
READER_RECORD_KEYS = frozenset((
    "test_id", "result", "reader", "slot", "operator", "tested_at", "temp_start", "temp_end",
    "software", "cartridge_lot", "cartridge_expiry", "cartridge_range", "spike_level",
    "recovery", "rec_min", "rec_max", "sample_cv", "spike_cv", "cv_limit", "reader_pass",
    "valid", "why", "file_name",
))
_RECORD_TEXT_MAX = 200
_RECORD_WHY_MAX = 20


def _number(v) -> bool:
    """A real, finite number: int or float, never a bool."""
    return isinstance(v, (int, float)) and not isinstance(v, bool) and _finite(v)


def _short_text(v) -> bool:
    return isinstance(v, str) and len(v) <= _RECORD_TEXT_MAX


def check_reader_record(record: dict) -> None:
    """Spec 8.4's keys with plain values only, so a stored record stays small
    and flat: a deep value would commit and then fail every later
    serialization of the worksheet. Each value is null, true/false, a finite
    number or text of at most 200 characters; `why` is a list of at most 20
    such texts. Raises ValueError naming the key."""
    for key in sorted(record):
        v = record[key]
        if key not in READER_RECORD_KEYS:
            raise ValueError(f"the reader record has an unknown key {ascii(key)}")
        if key == "why":
            if not (isinstance(v, list) and len(v) <= _RECORD_WHY_MAX
                    and all(_short_text(s) for s in v)):
                raise ValueError(f"the reader record's why must be a list of at most "
                                 f"{_RECORD_WHY_MAX} texts of at most {_RECORD_TEXT_MAX} characters")
        elif not (v is None or isinstance(v, bool) or _number(v) or _short_text(v)):
            raise ValueError(f"the reader record's {key} must be null, true/false, a finite "
                             f"number or text of at most {_RECORD_TEXT_MAX} characters")


def reader_shows(record: dict, parsed: tuple[bool, float]) -> bool:
    """True when the reader record's `result` (the reading exactly as the
    reader showed it, spec 8.4) parses to `parsed`, the reading being
    imported. A missing or unreadable result fails closed."""
    result = record.get("result")
    try:
        return isinstance(result, str) and parse_reading(result) == parsed
    except ValueError:
        return False


def endo_run_params(run_params: Optional[dict]) -> dict:
    """A method's stored run_parameters ({"endotoxin": {...}} or None) with
    every missing key at Dennis's value: the browser's runParamsFrom."""
    return {**ENDO_RUN_PARAM_DEFAULTS, **((run_params or {}).get("endotoxin") or {})}


def reader_validity(record: dict, run_params: Optional[dict]) -> tuple[bool, list[str]]:
    """The server's own verdict on a reader test (spec 4.5), never the
    browser's: spike recovery inside the method's range and both CVs at or
    under its limit. The limits come from the worksheet's method
    run_parameters ({"endotoxin": {...}}, missing keys at Dennis's values),
    never from the file's rec_min, rec_max or cv_limit. A missing or
    non-numeric number fails closed. Wording follows readerValidity
    (src/lib/endo-reader.ts, Task 9), which applies the same fail-closed rule."""
    limits = endo_run_params(run_params)
    lo, hi, cv = (limits["spike_recovery_min_pct"], limits["spike_recovery_max_pct"],
                  limits["cv_limit_pct"])
    why = []
    recovery = record.get("recovery")
    if not _number(recovery):
        why.append("no spike recovery")
    elif not lo <= recovery <= hi:
        why.append(f"spike recovery {recovery:g} % outside {lo:g}-{hi:g} %")
    for key, name in (("sample_cv", "sample CV"), ("spike_cv", "spike CV")):
        value = record.get(key)
        if not _number(value):
            why.append(f"no {name}")
        elif value > cv:
            why.append(f"{name} {value:g} % over {cv:g} %")
    return not why, why


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
            ok = v is None or (not isinstance(v, bool) and isinstance(v, (int, float))
                               and _finite(v))
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
    with no live endotoxin analysis, or a service with no active default
    method all resolve to None. So do two rows that disagree. Only a vial's
    endotoxin analyses count (main.py's keyword rule): a live STER-PCR beside
    the ENDO analysis on the same vial says nothing about its method."""
    # lazy: main imports this module too
    from main import _bench_kind_for_item, _bench_kind_for_keyword

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
    for pk, service_id, keyword in db.execute(
        select(LimsAnalysis.lims_sub_sample_pk, LimsAnalysis.analysis_service_id,
               LimsAnalysis.keyword).where(
            LimsAnalysis.lims_sub_sample_pk.in_(vial_pks),
            # The vial-row "current" idiom: the newest row of a retest chain.
            LimsAnalysis.retested.is_(False),
            LimsAnalysis.review_state.notin_(_DEAD_STATES),
        )
    ).all():
        if _bench_kind_for_keyword(keyword) == "endo":
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
    resolves to, else None. A completed worksheet never pinned resolves None:
    every reading and print pins, so it was worked on Dennis's values. At
    most five queries. Callers: GET /worksheets/{id}, the item PATCH and the
    reader import, never a list."""
    if worksheet.endo_method_id is None and worksheet.status == "completed":
        return None
    method_id = worksheet.endo_method_id or _endo_method_id(db, worksheet.id)
    return _method_payload(db, method_id) if method_id else None


def allowed_cartridge_ids(db: Session, worksheet) -> set[int]:
    """Cartridges a run or a row may choose (spec 4.3). A method that lists
    one or more endo cartridges allows only its active ones. When no method
    resolves (the legacy ENDO-LAL test, say), or the method lists none yet
    (lead decision 2026-10-10), every active endo cartridge is allowed."""
    return cartridge_ids_allowed_by(db, resolve_endo_method(db, worksheet))


def cartridge_ids_allowed_by(db: Session, method: Optional[dict]) -> set[int]:
    """allowed_cartridge_ids for a method already resolved (the reader import
    resolves it once per request). One query at most."""
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


# The endo v2 row fields the item PATCH accepts (spec 3.7). Sent = set; an
# explicit null clears; omitted = untouched (model_fields_set).
_PREP_FIELDS = ("prep_form", "prep_water_ml", "prep_total_dilution", "prep_steps")
ENDO_ITEM_FIELDS = (*_PREP_FIELDS, "cartridge_type_id", "result_reading")
# The fixed parts of the 2 mL steps that stay in code (spec 4.4): step 1's
# standard ratio and the fixed 1:2 of step 3.
STEP1_STANDARD_RATIO = 10
STEP3_RATIO = 2


def _step1_ratio(steps) -> float:
    """The row's step 1 ratio: its own (prep_steps[0][1]) when set, else 1:10."""
    first = steps[0] if isinstance(steps, list) and steps else None
    if isinstance(first, list) and len(first) == 2 and first[1] is not None:
        # float(): a huge int ratio (10**308 passed _finite) would make an int
        # floor that the :g message cannot format (500); as a float it is inf.
        return float(first[1])
    return STEP1_STANDARD_RATIO


def check_item_endo_fields(db: Session, worksheet, item, values: dict) -> dict:
    """Validate the row fields one PATCH sent. Writes nothing. Returns the
    values to store (a reading trimmed) or raises ValueError with the reason.
    Saving a reading always stores the row's cartridge (spec 3.1), so a
    reading needs one, sent now or already on the row. For the same reason a
    cartridge cannot be cleared from under a stored reading. A total below
    step 1's ratio x 2 cannot be made, because step 2 would need a ratio
    under 1:1. A row with no total of its own runs on the method's standard
    total (std_total_dilution, 250 when unset), so that one is checked the
    same way. Tube overflow is only a screen warning."""
    out = dict(values)
    form = values.get("prep_form")
    if form is not None and form not in ENDO_FORMS:
        raise ValueError(f"prep_form must be one of {', '.join(ENDO_FORMS)}")
    water = values.get("prep_water_ml")
    if water is not None and not (_finite(water) and water > 0):
        raise ValueError("prep_water_ml must be a number greater than zero")
    total = values.get("prep_total_dilution")
    if total is not None and not _finite(total):
        raise ValueError("prep_total_dilution must be a number")
    if values.get("prep_steps") is not None:
        out["prep_steps"] = validate_prep_steps(values["prep_steps"])
    total_after = out.get("prep_total_dilution", item.prep_total_dilution)
    floor_check = "prep_total_dilution" in values or "prep_steps" in values
    cartridge = values.get("cartridge_type_id")
    # Resolved once, and only when a check below needs it.
    method = (resolve_endo_method(db, worksheet)
              if cartridge is not None or (floor_check and total_after is None) else None)
    if floor_check:
        if total_after is None:
            total_after = endo_run_params(
                method["run_parameters"] if method else None)["std_total_dilution"]
        floor = STEP3_RATIO * _step1_ratio(out.get("prep_steps", item.prep_steps))
        if total_after < floor:
            raise ValueError(f"prep_total_dilution must be at least {floor:g} (the step 1 "
                             f"ratio x the fixed 1:{STEP3_RATIO} step) or step 2 cannot be made")
    if cartridge is not None and cartridge not in cartridge_ids_allowed_by(db, method):
        raise ValueError(CARTRIDGE_REFUSED)
    if values.get("result_reading") is not None:
        parse_reading(values["result_reading"])
        out["result_reading"] = values["result_reading"].strip()
    reading_after = out.get("result_reading", item.result_reading)
    cartridge_after = out.get("cartridge_type_id", item.cartridge_type_id)
    if reading_after is not None and cartridge_after is None:
        raise ValueError("A reading needs the row's cartridge: send cartridge_type_id with it")
    return out


def apply_item_endo_fields(db: Session, worksheet, item, values: dict,
                           user_id: Optional[int]) -> None:
    """Store values from check_item_endo_fields, with their audit rows. A new
    reading stamps who and when and pins the worksheet's method (spec 4.1).
    The reader record (lead decision 2026-10-10) is handled two ways. A typed
    reading keeps result_reader: the page flags the mismatch, and validity
    still comes from the record. Clearing the reading clears the record too,
    and the audit row keeps the cleared record as old_reader. Callers commit."""
    base = {"user_id": user_id, "worksheet_id": worksheet.id, "sample_id": item.sample_id}

    def audit(operation: str, old, new, **extra) -> None:
        db.add(AuditLog(operation=operation, entity_type="worksheet_item",
                        entity_id=str(item.id),
                        details={**base, "old": old, "new": new, **extra}))

    # The prep inputs (spec 9): one row for what this PATCH changes, if anything.
    changed = [f for f in _PREP_FIELDS if f in values and values[f] != getattr(item, f)]
    if changed:
        audit("endo_prep_inputs_set", {f: getattr(item, f) for f in changed},
              {f: values[f] for f in changed})
    for field in _PREP_FIELDS:
        if field in values:
            setattr(item, field, values[field])
    if "cartridge_type_id" in values and values["cartridge_type_id"] != item.cartridge_type_id:
        audit("endo_cartridge_set", item.cartridge_type_id, values["cartridge_type_id"])
        item.cartridge_type_id = values["cartridge_type_id"]
    if "result_reading" in values and values["result_reading"] != item.result_reading:
        new = values["result_reading"]
        if new is None:
            audit("endo_reading_cleared", item.result_reading, None, old_reader=item.result_reader)
            item.result_reader = None
        else:
            audit("endo_reading_set", item.result_reading, new)
        item.result_reading = new
        # Naive UTC, like made_at / ran_at; the serializer appends the Z.
        item.result_entered_at = (datetime.now(timezone.utc).replace(tzinfo=None)
                                  if new is not None else None)
        item.result_entered_by_user_id = user_id if new is not None else None
    if values.get("result_reading") is not None:
        pin_endo_method(db, worksheet, user_id)
