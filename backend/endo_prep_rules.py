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
