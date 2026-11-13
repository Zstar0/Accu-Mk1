"""HPLC prep rules (plan 2026-11-12-hplc-prep-rules, Task 2), the HPLC twin
of endo_prep_rules.

A rule sets, for one peptide (a solo peptide, a blend component or a blend)
and a weight band, the autosampler vial's target concentration, the
peptide's target as a blend component, which component leads a blend, the
floor, the diluent and the instrument it usually runs on. A null value means
the method default (catalog.method_run_params.HPLC_RUN_PARAM_DEFAULTS, and
Water for the diluent). Outside the table a rule is always a snapshot dict.
match_rule, component_target, pick_lead, row_diluent, row_instrument and
row_floor are pure and mirrored by the browser (Task 4);
backend/tests/fixtures/hplc_prep_rule_cases.json pins the two to identical
answers.

A component's own line is matched on the component's declared_mg; a row's
own line on the row's declared total. For a solo row `components` is the one
peptide and `row_rule` is that peptide's line."""
import math
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from endo_prep_rules import OVERLAP_RULE, _band_text, _bounds
from models import HplcPrepRule

HPLC_DILUENTS = ("Water", "Water + 0.1% TFA")
DEFAULT_DILUENT = "Water"

_SNAPSHOT_KEYS = ("id", "peptide_id", "min_mg", "max_mg", "target_conc_ug_ml",
                  "blend_target_conc_ug_ml", "lead_component_id", "lead_priority",
                  "floor_ug_ml", "diluent", "default_instrument_id", "status", "note",
                  "sort_order", "active")


def snapshot(rule) -> dict:
    """A rule row as a plain JSON-safe dict: what matching reads and what the
    rules API serves."""
    return {key: getattr(rule, key) for key in _SNAPSHOT_KEYS}


def load_rules(db: Session, *, active_only: bool = True) -> list[dict]:
    """Every rule as a snapshot, in list order (sort_order, then id). One query."""
    q = select(HplcPrepRule).order_by(HplcPrepRule.sort_order, HplcPrepRule.id)
    if active_only:
        q = q.where(HplcPrepRule.active.is_(True))
    return [snapshot(r) for r in db.execute(q).scalars()]


def _in_band(rule: dict, weight_mg: Optional[float]) -> bool:
    """weight > min_mg and weight <= max_mg, a null bound meaning none. A row
    with no weight sits only in a line with both bounds null."""
    lo, hi = rule["min_mg"], rule["max_mg"]
    if weight_mg is None:
        return lo is None and hi is None
    return (lo is None or weight_mg > lo) and (hi is None or weight_mg <= hi)


def _width(rule: dict) -> float:
    """(max_mg or infinity) - (min_mg or 0). Every open band is infinitely
    wide, so any closed band beats it."""
    hi = math.inf if rule["max_mg"] is None else rule["max_mg"]
    return hi - (rule["min_mg"] or 0)


def match_rule(rules: list[dict], *, peptide_id: Optional[int],
               weight_mg: Optional[float]) -> Optional[dict]:
    """The active line for this peptide whose band holds the weight, or None.
    Of several the narrowest band wins; a tie goes to the lowest sort_order,
    then the lowest id. Returns the snapshot from `rules` itself, not a copy."""
    if peptide_id is None:
        return None
    hits = [r for r in rules
            if r["active"] and r["peptide_id"] == peptide_id and _in_band(r, weight_mg)]
    if not hits:
        return None
    return min(hits, key=lambda r: (_width(r), r["sort_order"], r["id"]))


def component_target(rules: list[dict], *, peptide_id: Optional[int],
                     weight_mg: Optional[float], in_blend: bool, default: float) -> dict:
    """A peptide's target concentration and where it came from: its blend
    target when it is in a blend and its line sets one, else its target
    alone, else `default` (the method's)."""
    line = match_rule(rules, peptide_id=peptide_id, weight_mg=weight_mg)
    if line is not None and in_blend and line["blend_target_conc_ug_ml"] is not None:
        return {"value": line["blend_target_conc_ug_ml"], "source": "blend_rule",
                "rule_id": line["id"]}
    if line is not None and line["target_conc_ug_ml"] is not None:
        return {"value": line["target_conc_ug_ml"], "source": "rule", "rule_id": line["id"]}
    return {"value": default, "source": "default", "rule_id": None}


def _own_line(rules: list[dict], component: dict) -> Optional[dict]:
    """A component's own line, matched on the component's declared_mg (a missing
    key is no weight)."""
    return match_rule(rules, peptide_id=component["peptide_id"],
                      weight_mg=component.get("declared_mg"))


def pick_lead(rules: list[dict], components: list[dict], *, row_rule: Optional[dict],
              chosen_id: Optional[int] = None) -> Optional[dict]:
    """Which component of one autosampler vial leads, and why. `components`
    is the vial's [{"peptide_id", "declared_mg"}] in display order. In turn:
    the tech's pick ("chosen"); with 2+ components, the blend line's lead
    ("rule") and the component whose own line has the lowest lead_priority
    ("preferred", a tie to the first listed); the greatest declared_mg among
    those with one ("heaviest", a tie to the first); else the first."""
    if not components:
        return None
    ids = [c["peptide_id"] for c in components]
    if chosen_id is not None and chosen_id in ids:
        return {"peptide_id": chosen_id, "why": "chosen"}
    if len(components) > 1:
        lead = row_rule["lead_component_id"] if row_rule is not None else None
        if lead is not None and lead in ids:
            return {"peptide_id": lead, "why": "rule"}
        ranked = [(line["lead_priority"], i) for i, line in
                  enumerate(_own_line(rules, c) for c in components)
                  if line is not None and line["lead_priority"] is not None]
        if ranked:
            return {"peptide_id": ids[min(ranked)[1]], "why": "preferred"}
    weighed = [(-c["declared_mg"], i) for i, c in enumerate(components)
               if c.get("declared_mg") is not None]
    if weighed:
        return {"peptide_id": ids[min(weighed)[1]], "why": "heaviest"}
    return {"peptide_id": ids[0], "why": "first"}


def _row_value(rules: list[dict], key: str, row_rule: Optional[dict],
               components: list[dict], no_opinion=None) -> Optional[dict]:
    """The line that sets `key` for a row: the row's own line if it sets it,
    else the first component, in order, whose own line does (a component
    line whose value is `no_opinion` counts as not setting it); else None."""
    if row_rule is not None and row_rule[key] is not None:
        return row_rule
    for component in components:
        line = _own_line(rules, component)
        if line is not None and line[key] is not None and line[key] != no_opinion:
            return line
    return None


def row_diluent(rules: list[dict], *, row_rule: Optional[dict],
                components: list[dict]) -> dict:
    """The row's diluent and the line that set it (DEFAULT_DILUENT, rule_id None,
    when no line names one). The row's own line wins whatever it says; a
    component line that names DEFAULT_DILUENT is no opinion, as in the lab's
    tool, where any listed peptide's TFA decides and Water is never listed."""
    line = _row_value(rules, "diluent", row_rule, components, no_opinion=DEFAULT_DILUENT)
    if line is None:
        return {"diluent": DEFAULT_DILUENT, "rule_id": None}
    return {"diluent": line["diluent"], "rule_id": line["id"]}


def row_instrument(rules: list[dict], *, row_rule: Optional[dict],
                   components: list[dict]) -> Optional[int]:
    """The instrument the row usually runs on: the row's own line if it names
    one, else the first component, in order, whose own line does; None when
    no line names one."""
    line = _row_value(rules, "default_instrument_id", row_rule, components)
    return None if line is None else line["default_instrument_id"]


def row_floor(row_rule: Optional[dict], *, default: float) -> float:
    """The row's line's floor, else `default` (the method's)."""
    if row_rule is None or row_rule["floor_ug_ml"] is None:
        return default
    return row_rule["floor_ug_ml"]


_REQUIRED_FIELDS = ("peptide_id", "status", "active")
_NUMBER_FIELDS = ("min_mg", "max_mg", "target_conc_ug_ml", "blend_target_conc_ug_ml",
                  "lead_priority", "floor_ug_ml")
_POSITIVE_FIELDS = ("target_conc_ug_ml", "blend_target_conc_ug_ml", "floor_ug_ml")
LEAD_PRIORITY_TIE = "ties go to the component listed first"


def check_rule(db: Session, values: dict, sent, *, rule_id: Optional[int] = None) -> list[str]:
    """The save checks on a rule as it will be stored. `values` holds every
    snapshot field after this request; `sent` names the fields the request
    sent. A refusal raises ValueError with the reason (the routes answer
    400). Each check runs only when a field it reads was sent, so a line that
    an old value no longer fits (a retired instrument, a new method floor)
    can still be deactivated or re-noted. Only a blend line sets a floor, and
    on a blend line the floor check compares the effective floor and target,
    each falling back to HPLC_RUN_PARAM_DEFAULTS.
    Returns the warnings, for an active line only: a band that overlaps
    another active line of the same peptide, and a lead_priority an active
    line of another peptide already uses."""
    from catalog.method_run_params import HPLC_RUN_PARAM_DEFAULTS
    from models import Instrument, Peptide, blend_components

    sent = set(sent)
    for field in _REQUIRED_FIELDS:
        if field in sent and values[field] is None:
            raise ValueError(f"{field} cannot be empty")
    for field in _NUMBER_FIELDS:
        # An int is always finite (and math.isfinite raises on one too big for a float).
        if (field in sent and isinstance(values[field], float)
                and not math.isfinite(values[field])):
            raise ValueError(f"{field} must be a finite number")
    peptide = db.get(Peptide, values["peptide_id"]) if values["peptide_id"] is not None else None
    if "peptide_id" in sent and peptide is None:
        raise ValueError(f"peptide {values['peptide_id']} not found")
    for field in _POSITIVE_FIELDS:
        if field in sent and values[field] is not None and values[field] <= 0:
            raise ValueError(f"{field} must be greater than zero")
    for field in ("min_mg", "max_mg"):
        if field in sent and values[field] is not None and values[field] < 0:
            raise ValueError(f"{field} must not be negative")
    lo, hi = values["min_mg"], values["max_mg"]
    if sent & {"min_mg", "max_mg"} and lo is not None and hi is not None and lo >= hi:
        raise ValueError("min_mg must be below max_mg")
    priority = values["lead_priority"]
    if "lead_priority" in sent and priority is not None and (
            isinstance(priority, bool) or not 1 <= priority <= 999
            or priority != int(priority)):
        raise ValueError("lead_priority must be a whole number from 1 to 999")
    diluent = values["diluent"]
    if "diluent" in sent and diluent is not None and diluent not in HPLC_DILUENTS:
        raise ValueError(f"diluent '{diluent}' is not one of: {', '.join(HPLC_DILUENTS)}")
    instrument_id = values["default_instrument_id"]
    if "default_instrument_id" in sent and instrument_id is not None:
        instrument = db.get(Instrument, instrument_id)
        if instrument is None or not instrument.active:
            raise ValueError(f"instrument {instrument_id} is not an active instrument")
    lead = values["lead_component_id"]
    if sent & {"peptide_id", "lead_component_id"} and lead is not None and peptide is not None:
        if not peptide.is_blend:
            raise ValueError("only a blend line names a lead")
        member = db.execute(select(blend_components.c.id).where(
            blend_components.c.blend_id == peptide.id,
            blend_components.c.component_id == lead)).first()
        if member is None:
            raise ValueError(f"peptide {lead} is not a component of blend {peptide.id}")
    if (sent & {"peptide_id", "blend_target_conc_ug_ml", "lead_priority"}
            and peptide is not None and peptide.is_blend
            and (values["blend_target_conc_ug_ml"] is not None or priority is not None)):
        raise ValueError("blend_target_conc_ug_ml and lead_priority are for component lines: "
                         "a blend is never a component of another blend")
    # The floor is the blend's: row_floor reads only the row's own line, and a
    # solo peptide has no other component to hold to it.
    if (sent & {"peptide_id", "floor_ug_ml"} and values["floor_ug_ml"] is not None
            and peptide is not None and not peptide.is_blend):
        raise ValueError("only a blend line sets a floor")
    if (sent & {"peptide_id", "floor_ug_ml", "target_conc_ug_ml"}
            and peptide is not None and peptide.is_blend):
        floor = values["floor_ug_ml"]
        target = values["target_conc_ug_ml"]
        floor = HPLC_RUN_PARAM_DEFAULTS["floor_ug_ml"] if floor is None else floor
        target = HPLC_RUN_PARAM_DEFAULTS["default_target_ug_ml"] if target is None else target
        if floor >= target:
            raise ValueError(f"the floor {floor:g} ug/mL must be below the target "
                             f"{target:g} ug/mL")
    if not values["active"]:
        return []
    mine_lo, mine_hi = _bounds(values)
    others = [r for r in load_rules(db) if r["id"] != rule_id]
    warnings = [
        f"overlaps rule {other['id']} ({_band_text(other)}) {OVERLAP_RULE}"
        for other in others
        if other["peptide_id"] == values["peptide_id"]
        and mine_lo < _bounds(other)[1] and _bounds(other)[0] < mine_hi
    ]
    if priority is not None:
        warnings += [
            f"lead_priority {priority:g} is also used by rule {other['id']}; {LEAD_PRIORITY_TIE}"
            for other in others
            if other["lead_priority"] == priority and other["peptide_id"] != values["peptide_id"]
        ]
    return warnings
