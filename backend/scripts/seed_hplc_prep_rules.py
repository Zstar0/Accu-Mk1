"""Seed the lab's own HPLC prep rule lines (plan 2026-11-12-hplc-prep-rules, Task 7).

First, the DRY RUN (writes nothing):
    Prod (stdin form, per the data-fix runbook):
        ssh root@100.120.92.93 'docker exec -w /app -i accu-mk1-backend python -' \\
            < backend/scripts/seed_hplc_prep_rules.py
    Local (from backend/, against the dev database):
        python scripts/seed_hplc_prep_rules.py
Read its output: for each line it would insert, the values it would insert and any save
check warnings; for each peptide it skips, how many lines that peptide already has; and
anything not found. Compare it with the rules page. Only then write, the same command with
--apply:
        ssh root@100.120.92.93 'docker exec -w /app -i accu-mk1-backend python - --apply' \\
            < backend/scripts/seed_hplc_prep_rules.py
        python scripts/seed_hplc_prep_rules.py --apply

The hplc_prep_rules table starts empty on every database. The lab already keeps four lines
in its prep worksheet tool (its DEFAULTS table: targetConcByPeptide,
blendTargetConcByPeptide, preferredLeads, diluentByPeptide, instrumentByPeptide); this
inserts them, as validated lines at the end of the list, each with an audit row like a line
typed on the rules page.

Safe to run twice: a peptide that already has ANY line (typed by hand, seeded before, or
retired) is skipped whole, so a second run inserts nothing and never overwrites a hand
edit. A peptide is found by abbreviation, then by name, case-insensitive and exact; one
that is not found, or matches more than one peptide, is reported and the run carries on.
If no ACTIVE instrument is named HPLC 1290b, the Retatrutide line goes in without one and
the output says so.
"""
import os
import sys

# Piped over stdin (`python < script`, the prod data-fix form) there is no
# __file__; the container's working dir (/app) is already importable then.
if "__file__" in globals():
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

SOURCE_NOTE = ("Seeded from the lab prep worksheet DEFAULTS table "
               "(as of 2026-11-12) by seed_hplc_prep_rules.")
INSTRUMENT = "HPLC 1290b"

# (peptide, fields, instrument name or None), in the order they join the list.
LINES = [
    ("NAD+", {"target_conc_ug_ml": 150.0}, None),
    ("GHK-Cu", {"target_conc_ug_ml": 125.0, "blend_target_conc_ug_ml": 350.0,
                "lead_priority": 2, "diluent": "Water + 0.1% TFA"}, None),
    ("Ipamorelin", {"target_conc_ug_ml": 150.0, "blend_target_conc_ug_ml": 175.0,
                    "lead_priority": 1}, None),
    ("Retatrutide", {}, INSTRUMENT),
]


def _one(db, model, column, wanted, *where):
    """(row, None) for one case-insensitive exact match on `column` (and `where`), (None,
    None) for none, (None, "more than one match") for several."""
    from sqlalchemy import func, select

    rows = db.execute(select(model).where(func.lower(column) == wanted.lower(), *where)
                      ).scalars().all()
    if len(rows) > 1:
        return None, "more than one match"
    return (rows[0] if rows else None), None


def _find_peptide(db, wanted):
    from models import Peptide

    row, problem = _one(db, Peptide, Peptide.abbreviation, wanted)
    if row is None and problem is None:
        row, problem = _one(db, Peptide, Peptide.name, wanted)
    return row, problem


def _values_text(values: dict, instrument_name) -> str:
    """The values a line gets, as the operator compares them with the rules page."""
    def num(v):
        return "standard" if v is None else f"{v:g}"
    return (f"target {num(values['target_conc_ug_ml'])}, "
            f"blend target {num(values['blend_target_conc_ug_ml'])}, "
            f"lead priority {values['lead_priority'] or 'none'}, "
            f"diluent {values['diluent'] or 'standard'}, "
            f"instrument {instrument_name or 'none'}")


def seed(db, *, apply: bool, say=lambda line: None) -> dict:
    """Insert the lines (apply=True, one commit at the end) or only say what it would
    insert (apply=False, writes nothing). Returns {"inserted", "skipped_existing",
    "not_found"}: peptide names, and for not_found "<name> (<reason>)". `say` gets one
    line per detail: the values each line would get (or got) and its save check warnings,
    and how many lines each skipped peptide already has."""
    from sqlalchemy import func, select

    from hplc_prep_rules import check_rule, snapshot
    from models import AuditLog, HplcPrepRule, Instrument

    out = {"inserted": [], "skipped_existing": [], "not_found": []}
    next_order = db.execute(
        select(func.coalesce(func.max(HplcPrepRule.sort_order), -1) + 1)).scalar_one()
    for name, fields, instrument_name in LINES:
        peptide, problem = _find_peptide(db, name)
        if peptide is None:
            out["not_found"].append(f"{name} ({problem or 'not in the database'})")
            continue
        existing = db.execute(select(func.count()).select_from(HplcPrepRule).where(
            HplcPrepRule.peptide_id == peptide.id)).scalar_one()
        if existing:
            out["skipped_existing"].append(name)
            say(f"{name}: skipped, the peptide already has {existing} line(s)")
            continue
        instrument_id, instrument_label, instrument_problem = None, None, None
        if instrument_name is not None:
            instrument, problem = _one(db, Instrument, Instrument.name, instrument_name,
                                       Instrument.active.is_(True))
            if instrument is None:
                instrument_problem = (f"instrument {problem}" if problem
                                      else "no active instrument by that name")
            else:
                instrument_id, instrument_label = instrument.id, instrument.name
        values = {key: None for key in ("min_mg", "max_mg", "target_conc_ug_ml",
                                        "blend_target_conc_ug_ml", "lead_component_id",
                                        "lead_priority", "floor_ug_ml", "diluent")}
        values.update(fields, peptide_id=peptide.id, default_instrument_id=instrument_id,
                      status="validated", note=SOURCE_NOTE, active=True)
        try:
            warnings = check_rule(db, {**values, "id": None}, values)
        except ValueError as e:
            out["not_found"].append(f"{name} ({'refused' if apply else 'would be refused'} "
                                    f"by the save checks: {e})")
            continue
        # Only a line that passed the checks gets the note, so it never contradicts a refusal.
        if instrument_problem is not None:
            out["not_found"].append(
                f"{instrument_name} ({instrument_problem}, the {name} line "
                f"{'goes' if apply else 'would go'} in without an instrument)")
        out["inserted"].append(name)
        say(f"{name}: {'inserted' if apply else 'would insert'} "
            f"{_values_text(values, instrument_label)}")
        for warning in warnings:
            say(f"{name}: warning: {warning}")
        if not apply:
            continue
        rule = HplcPrepRule(**values, sort_order=next_order, updated_by_id=None)
        next_order += 1
        db.add(rule)
        db.flush()
        db.add(AuditLog(operation="hplc_prep_rule_created", entity_type="hplc_prep_rule",
                        entity_id=str(rule.id),
                        details={"user_id": None, "source": "seed_hplc_prep_rules",
                                 "old": None, "new": snapshot(rule)}))
    if apply:
        db.commit()
    return out


def main():
    from database import SessionLocal

    apply = "--apply" in sys.argv[1:]
    with SessionLocal() as db:
        out = seed(db, apply=apply, say=print)
        if not apply:
            db.rollback()
    verb = "Inserted" if apply else "Would insert"
    print(f"{verb} a line for: {', '.join(out['inserted']) or 'none'}.")
    print("Skipped, the peptide already has a line (edit it on the rules page): "
          f"{', '.join(out['skipped_existing']) or 'none'}.")
    for miss in out["not_found"]:
        print(f"Not found or not inserted: {miss}.")
    if not apply:
        print("Dry run: nothing was written. Run again with --apply to write.")


if __name__ == "__main__":
    main()
