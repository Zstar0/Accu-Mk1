"""Endotoxin method prep rules (endo slice 5, spec
docs/superpowers/specs/2026-10-14-endo-slice5-method-rules-design.md).

A rule sets a 2 mL row's default total dilution, step 1 ratio and cartridge
for one catalog peptide and a weight band. Outside the table a rule is always
a snapshot dict, so a row lock can hold a full copy that later edits never
reach. match_rule is mirrored line for line by src/lib/endo-prep-rules.ts
matchRule; backend/tests/fixtures/endo_prep_rule_cases.json pins the two to
identical answers.

worksheets_endo imports this module, so this module imports worksheets_endo
(and main) only inside functions."""
import math
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import EndoPrepRule

# Step 1's standard Tris ratio 1:N. Mirrors src/lib/endo-prep-2ml.ts
# STEP1_RATIO; tests/test_endo_prep_rules.py pins it to
# worksheets_endo.STEP1_STANDARD_RATIO.
STEP1_RATIO = 10
# What locked a row's rule (spec section 6).
LOCK_EVENTS = ("print", "result", "complete", "reapply", "switch")

_SNAPSHOT_KEYS = ("id", "peptide_id", "min_mg", "max_mg", "total_dilution", "step1_ratio",
                  "cartridge_type_id", "status", "note", "sort_order", "active")


def snapshot(rule) -> dict:
    """A rule row as a plain JSON-safe dict: what matching reads, what the
    rules API serves and what a row lock copies whole."""
    return {key: getattr(rule, key) for key in _SNAPSHOT_KEYS}


def load_rules(db: Session, *, active_only: bool = True) -> list[dict]:
    """Every rule as a snapshot, in list order (sort_order, then id). One query."""
    q = select(EndoPrepRule).order_by(EndoPrepRule.sort_order, EndoPrepRule.id)
    if active_only:
        q = q.where(EndoPrepRule.active.is_(True))
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
    wide, so any closed band beats it (Dennis's quirk, spec section 4)."""
    hi = math.inf if rule["max_mg"] is None else rule["max_mg"]
    return hi - (rule["min_mg"] or 0)


def match_rule(rules: list[dict], *, peptide_id: Optional[int], weight_mg: Optional[float],
               is_bac: bool, endo_prep: Optional[str], rules_off: bool) -> Optional[dict]:
    """The active rule that sets this row's defaults, or None (spec section 4).
    Never ruled: a stock worksheet (endo_prep other than '2ml', NULL included),
    bac water, a sample with no single catalog peptide (a blend, or none) and
    a row switched to "no rule". Of several matching lines the narrowest band
    wins; a tie goes to the lowest sort_order, then the lowest id. Returns the
    snapshot from `rules` itself, not a copy."""
    if rules_off or is_bac or endo_prep != "2ml" or peptide_id is None:
        return None
    hits = [r for r in rules
            if r["active"] and r["peptide_id"] == peptide_id and _in_band(r, weight_mg)]
    if not hits:
        return None
    return min(hits, key=lambda r: (_width(r), r["sort_order"], r["id"]))


_REQUIRED_FIELDS = ("peptide_id", "status", "active")
# How match_rule settles an overlap, in the rules page's words (spec section 4).
OVERLAP_RULE = ("for this peptide; where both match, the narrower band wins (an open band "
                "is the widest) and a tie goes to the line listed first")
_NUMBER_FIELDS = ("min_mg", "max_mg", "total_dilution", "step1_ratio")


def _bounds(rule: dict) -> tuple[float, float]:
    """The band as an interval (lo, hi], a null bound as minus or plus infinity."""
    return (-math.inf if rule["min_mg"] is None else rule["min_mg"],
            math.inf if rule["max_mg"] is None else rule["max_mg"])


def _band_text(rule: dict) -> str:
    """The band in the rules page's words (its "above mg" and "up to mg" columns)."""
    lo, hi = rule["min_mg"], rule["max_mg"]
    if lo is None and hi is None:
        return "any weight"
    if lo is None:
        return f"up to {hi:g} mg"
    if hi is None:
        return f"above {lo:g} mg"
    return f"above {lo:g} up to {hi:g} mg"


def _active_endo_methods(db: Session) -> list[dict]:
    """The active Endotoxin method revisions: every active method that is the
    default for an endotoxin service (main's keyword rule, as
    worksheets_endo._endo_method_id reads it), in the endo_method wire shape.
    Usually one, and none until the launch step sets the default."""
    from main import _bench_kind_for_keyword
    from models import AnalysisService, HplcMethod, method_services
    from worksheets_endo import _method_payload

    rows = db.execute(
        select(method_services.c.method_id, AnalysisService.keyword)
        .join(AnalysisService, AnalysisService.id == method_services.c.analysis_service_id)
        .join(HplcMethod, HplcMethod.id == method_services.c.method_id)
        .where(method_services.c.is_default.is_(True), HplcMethod.status == "active")
    ).all()
    ids = sorted({mid for mid, keyword in rows if _bench_kind_for_keyword(keyword) == "endo"})
    return [_method_payload(db, mid) for mid in ids]


def check_rule(db: Session, values: dict, sent, *, rule_id: Optional[int] = None) -> list[str]:
    """Spec section 3's save checks on a rule as it will be stored. `values`
    holds every snapshot field after this request; `sent` names the fields
    the request sent. A refusal raises ValueError with the reason (the routes
    answer 400). Each check runs only when a field it reads was sent, so a
    line whose cartridge was retired, or whose ratio a new standard no longer
    fits, can still be deactivated or re-noted. The step 1 floor is
    check_item_endo_fields' rule on the effective values: total >= 2 x ratio,
    with the active method's standard total (250 when none resolves) and
    STEP1_RATIO standing in for an unset value. Returns the warnings, for an
    active line only: a band that overlaps another active line of the same
    peptide, and a cartridge an active Endotoxin method does not allow."""
    from models import ConsumableType, Peptide
    from worksheets_endo import ENDO_CARTRIDGE, cartridge_ids_allowed_by, endo_run_params

    sent = set(sent)
    for field in _REQUIRED_FIELDS:
        if field in sent and values[field] is None:
            raise ValueError(f"{field} cannot be empty")
    for field in _NUMBER_FIELDS:
        if field in sent and values[field] is not None and not math.isfinite(values[field]):
            raise ValueError(f"{field} must be a finite number")
    if "peptide_id" in sent and db.get(Peptide, values["peptide_id"]) is None:
        raise ValueError(f"peptide {values['peptide_id']} not found")
    total, ratio = values["total_dilution"], values["step1_ratio"]
    if "total_dilution" in sent and total is not None and total <= 0:
        raise ValueError("total_dilution must be greater than zero")
    if "step1_ratio" in sent and ratio is not None and ratio < 1:
        raise ValueError("step1_ratio must be at least 1")
    lo, hi = values["min_mg"], values["max_mg"]
    if sent & {"min_mg", "max_mg"} and lo is not None and hi is not None and lo >= hi:
        raise ValueError("min_mg must be below max_mg")
    cartridge_id = values["cartridge_type_id"]
    cartridge = db.get(ConsumableType, cartridge_id) if cartridge_id is not None else None
    if "cartridge_type_id" in sent and cartridge_id is not None and (
            cartridge is None or cartridge.kind != ENDO_CARTRIDGE or not cartridge.active):
        raise ValueError(f"cartridge {cartridge_id} is not an active endotoxin cartridge")
    methods = _active_endo_methods(db)
    if sent & {"total_dilution", "step1_ratio"}:
        step1 = STEP1_RATIO if ratio is None else ratio
        floor = 2 * step1
        if total is not None and total < floor:
            raise ValueError(f"total_dilution 1:{total:g} is below 2 x the step 1 ratio "
                             f"1:{step1:g}, so step 2 cannot be made")
        if total is None:
            std = min([endo_run_params(m["run_parameters"])["std_total_dilution"] for m in methods]
                      or [endo_run_params(None)["std_total_dilution"]])
            if std < floor:
                raise ValueError(f"step1_ratio 1:{step1:g} needs a total of at least 1:{floor:g}, "
                                 f"above the standard 1:{std:g}; set total_dilution too")
    if not values["active"]:
        return []
    mine_lo, mine_hi = _bounds(values)
    warnings = [
        f"overlaps rule {other['id']} ({_band_text(other)}) {OVERLAP_RULE}"
        for other in load_rules(db)
        if other["peptide_id"] == values["peptide_id"] and other["id"] != rule_id
        and mine_lo < _bounds(other)[1] and _bounds(other)[0] < mine_hi
    ]
    if cartridge is not None:
        warnings += [
            f"cartridge '{cartridge.name}' is not allowed by the active method "
            f"'{m['name']}' rev {m['revision']}; its rows keep their usual cartridge"
            for m in methods if cartridge_id not in cartridge_ids_allowed_by(db, m)
        ]
    return warnings
