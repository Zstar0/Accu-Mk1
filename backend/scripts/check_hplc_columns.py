"""Post-deploy check for the HPLC results engine schema (plan
docs/superpowers/plans/2026-10-31-hplc-results-engine.md, Task 6): do the new
hplc_analyses columns exist, and are the two stock-vial weighings nullable? Task 8 adds
lims_sample_forms: does hplc_prep exist, is its CHECK there, and did the backfill fill the
built-in forms that have a prep kind (three since the HPLC prep worksheet plan added
capsule, with hplc_analyses.capsules_used)? The HPLC prep rules plan (2026-11-12, Task 2)
adds hplc_prep_rules: does the table exist with every column, nullable as its CREATE
TABLE statement makes it (created_at and updated_at either way)? The HPLC prep worksheet plan (2026-11-12, Task 2) adds eight
nullable sample_preps columns and the unique partial index uq_sample_preps_worksheet_item.
sample_preps is not created by database.py or _run_migrations: mk1_db.ensure_sample_preps_table()
creates and alters it, and the /sample-preps routes (and others) call it before they touch the
table, so a fresh deploy gets the columns on the first such request. Run this check after one
(open the Sample Preps page): a miss before that is expected, a miss after it is not. Task 5
adds worksheet_items.hplc_prep, nullable (an HPLC row's typed prep inputs). The Calibration
Curve Worksheet plan (2026-11-13, Task 1) adds the hplc_calibration_sheets table (every
column, nullable as its CREATE TABLE makes it) and nineteen nullable calibration_curves
columns (the net peptide derivation, the serial dilution, the sheet and replicate links).

_run_migrations runs each ALTER on its own and LOGS a failure instead of raising, so a
column can silently fail to exist in production, and a DROP NOT NULL that failed leaves
every liquid row to 500 at insert. This reads information_schema and pg_constraint and
the lims_sample_forms rows only, in a read-only transaction, and takes no arguments and no
credentials: it uses the container's own engine (database.SessionLocal), like
capture_hplc_golden.py beside it.

Prints one line per column, constraint and form. Exits 1 if any column is missing or has
the wrong nullability, the CHECK is missing, or a built-in form has the wrong prep kind,
0 otherwise, so a release script can gate on it. A built-in form renamed in Settings
since the 1.55.0 seed does not fail the gate (a rename is a data condition, not a failed
migration): its prep kind is NULL and the fix is one UPDATE by id, not a code change. It
prints a NOTICE line with the UPDATE, every form row prints its id, and the closing line
reads "ALL PRESENT (N built-in form(s) not found by name, see NOTICE)" rather than a bare
"ALL PRESENT". Prod (stdin form, per the data-fix runbook):
    ssh root@100.120.92.93 'docker exec -w /app -i accu-mk1-backend python' \\
        < backend/scripts/check_hplc_columns.py
Local (from backend/, against the dev database):
    python scripts/check_hplc_columns.py

Then GET one existing analysis through the deployed route and confirm "prep_form" and
"dilution_factor_steps" are in the JSON: response_model drops undeclared keys, so a
local pass proves nothing about the deployed image.
"""
import os
import sys

# Piped over stdin (`python < script`, the prod data-fix form) there is no
# __file__; the container's working dir (/app) is already importable then.
if "__file__" in globals():
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# column -> is_nullable. The first six are new (capsules_used from the HPLC prep worksheet
# plan, 2026-11-12, Task 1); the two stock weighings were NOT NULL until a liquid prep
# (which never weighs its stock vial) needed them blank.
EXPECTED = {
    "prep_form": "YES",
    "declared_volume_ml": "YES",
    "capsules_used": "YES",
    "int_vial_empty": "YES",
    "int_vial_with_diluent": "YES",
    "int_vial_with_diluent_and_sample": "YES",
    "stock_vial_empty": "YES",
    "stock_vial_with_diluent": "YES",
}


# lims_sample_forms (Task 8): the new column stays nullable (NULL = no HPLC prep maths), its
# CHECK is added by a DO block that only logs on failure, and the backfill matches the six
# built-in names as lower(btrim(name)). Three have a prep kind (capsule since its 2026-11-12
# ruling: its fill runs after a DO block that widens the CHECK and also only logs on failure,
# so a Capsule row still NULL is how a failed widen shows here); the other three stay NULL.
# A form the Handler added or renamed is not judged.
FORMS_EXPECTED = {"hplc_prep": "YES"}

# hplc_prep_rules (HPLC prep rules plan, Task 2): the boot CREATE TABLE IF NOT EXISTS runs
# before create_all, so its nullability (created_at and updated_at nullable) is the one a
# database that already has peptides, instruments and users gets.
RULES_EXPECTED = {
    **{name: "NO" for name in ("id", "peptide_id", "status", "active", "sort_order")},
    **{name: "YES" for name in (
        "min_mg", "max_mg", "target_conc_ug_ml", "blend_target_conc_ug_ml",
        "lead_component_id", "lead_priority", "floor_ug_ml", "diluent",
        "default_instrument_id", "note", "created_at", "updated_at", "updated_by_id")},
}
# ...but a fresh database, where SQLAlchemy's create_all made the table, has these two NOT
# NULL. Both are a working table, so either nullability passes for them.
RULES_EITHER_NULLABLE = ("created_at", "updated_at")
# sample_preps (HPLC prep worksheet plan, Task 2): all eight nullable, and one prep per
# worksheet item through a unique partial index.
PREPS_EXPECTED = {
    name: "YES"
    for name in (
        "prep_form", "declared_volume_ml", "capsules_used", "diluent",
        "int_vial_empty_mg", "int_vial_with_diluent_mg", "int_vial_final_mg",
        "worksheet_item_id",
    )
}
PREPS_INDEX = "uq_sample_preps_worksheet_item"
# worksheet_items (HPLC prep worksheet plan, Task 5): the row's typed inputs, nullable.
ITEMS_EXPECTED = {"hplc_prep": "YES"}
# hplc_calibration_sheets (Calibration Curve Worksheet plan, Task 1): the model declares the
# timestamps nullable too, so the boot CREATE and create_all agree and nothing bends.
SHEETS_EXPECTED = {
    **{name: "NO" for name in ("id", "inputs", "version")},
    **{name: "YES" for name in (
        "peptide_id", "instrument_id", "replicate_of_sheet_id", "calibration_curve_id",
        "filed_at", "created_at", "updated_at", "created_by_id", "updated_by_id")},
}
# calibration_curves (same task): all nullable, no backfill.
CURVES_EXPECTED = {
    name: "YES"
    for name in (
        "cas_number", "net_counterion", "net_counterion_mw", "net_equivalents", "net_free_mw",
        "net_stated_fw", "net_ms_mz", "net_ms_ion", "net_assay_pct", "net_water_pct",
        "net_assumption", "net_factor_computed", "net_factor_applied", "net_override_reason",
        "net_parts_used", "serial_dilution", "calibration_sheet_id", "replicate_of_id", "injection",
    )
}
FORMS_CHECK = "ck_lims_sample_forms_hplc_prep"
FORMS_PREP = {
    "lyophilized powder": "powder",
    "reconstituted solution": "liquid",
    "pen": None,
    "nasal spray": None,
    "capsule": "capsule",
    "tablet": None,
}


def evaluate(found, expected=EXPECTED, either_nullable=()):
    """(report lines, number of problems) for `found`, a {column: (data_type, is_nullable)}.
    A column in `either_nullable` passes whatever its nullability. Pure, so the pass and
    fail paths can be checked without a database."""
    lines, bad = [], 0
    for name, want in expected.items():
        got = found.get(name)
        if got is None:
            status = "MISSING"
        elif got[1] != want and name not in either_nullable:
            status = f"WRONG nullable={got[1]}, want {want}"
        else:
            status = "ok"
        bad += status != "ok"
        lines.append(f"{name:36} {got[0] if got else '-':20} {status}")
    return lines, bad


def evaluate_sample_forms(found, constraints, rows):
    """(report lines, number of problems, built-in names not found) for lims_sample_forms.
    `found` is evaluate()'s {column: (data_type, is_nullable)}, `constraints` the constraint
    names on the table, and `rows` its (id, name, route, hplc_prep) tuples, or None when the
    column is missing so no value can be read. Pure, like evaluate().

    A built-in name that matches no row (renamed in Settings) is not a problem: a rename is a
    data condition, not a failed migration, and a gate that stays red after the documented fix
    is one a release script learns to route around. It is loud instead: a NOTICE line naming
    the UPDATE, the renamed form's own row printing its id, and the caller's closing line
    counting the names in the third value."""
    lines, bad = evaluate(found, FORMS_EXPECTED)
    has_check = FORMS_CHECK in constraints
    bad += not has_check
    lines.append(f"{FORMS_CHECK:36} {'constraint':20} {'ok' if has_check else 'MISSING'}")
    if rows is None:
        lines.append("lims_sample_forms values not checked: the hplc_prep column is missing")
        return lines, bad, []
    seen = set()
    for form_id, name, route, prep in rows:
        key = name.strip(" ").lower()  # the migration's lower(btrim(name))
        if key not in FORMS_PREP:
            status = "not a built-in name, not judged"
        else:
            seen.add(key)
            want = FORMS_PREP[key]
            status = "ok" if prep == want else f"WRONG, want {want or 'NULL'}"
            bad += prep != want
        lines.append(f"{name:36} {route:20} {prep or 'NULL':8} {'id=' + str(form_id):9} {status}")
    not_found = [key for key in FORMS_PREP if key not in seen]
    for key in not_found:
        want = FORMS_PREP[key]
        fix = (
            f"UPDATE lims_sample_forms SET hplc_prep = '{want}' WHERE id = <the id of its renamed row>"
            if want
            else "if renamed, its hplc_prep should stay NULL"
        )
        lines.append(f"{'NOTICE ' + key:36} {'-':20} {'-':8} {'-':9} not found by name: {fix}")
    return lines, bad, not_found


def evaluate_sample_preps(found, indexdef):
    """(report lines, number of problems) for the sample_preps columns and the worksheet-item
    index, whose pg_indexes definition is `indexdef` (None when it is missing). Pure."""
    lines, bad = evaluate(found, PREPS_EXPECTED)
    ok = bool(indexdef) and "UNIQUE" in indexdef and "worksheet_item_id IS NOT NULL" in indexdef
    bad += not ok
    lines.append(f"{PREPS_INDEX:36} {'index':20} {'ok' if ok else 'MISSING' if not indexdef else 'WRONG ' + indexdef}")
    return lines, bad


def _columns(db, table, names):
    from sqlalchemy import text

    return {
        name: (data_type, nullable)
        for name, data_type, nullable in db.execute(
            text(
                "SELECT column_name, data_type, is_nullable FROM information_schema.columns "
                "WHERE table_name = :table AND column_name = ANY(:names)"
            ),
            {"table": table, "names": list(names)},
        )
    }


def main():
    from sqlalchemy import text

    from database import SessionLocal

    with SessionLocal() as db:
        db.execute(text("SET TRANSACTION READ ONLY"))
        found = _columns(db, "hplc_analyses", EXPECTED)
        forms_found = _columns(db, "lims_sample_forms", FORMS_EXPECTED)
        rules_found = _columns(db, "hplc_prep_rules", RULES_EXPECTED)
        preps_found = _columns(db, "sample_preps", PREPS_EXPECTED)
        items_found = _columns(db, "worksheet_items", ITEMS_EXPECTED)
        sheets_found = _columns(db, "hplc_calibration_sheets", SHEETS_EXPECTED)
        curves_found = _columns(db, "calibration_curves", CURVES_EXPECTED)
        preps_index = next(
            (
                row[0]
                for row in db.execute(
                    text("SELECT indexdef FROM pg_indexes WHERE tablename = 'sample_preps' AND indexname = :name"),
                    {"name": PREPS_INDEX},
                )
            ),
            None,
        )
        # to_regclass is NULL for a missing table, where a bare ::regclass cast would raise.
        constraints = {
            row[0]
            for row in db.execute(
                text("SELECT conname FROM pg_constraint WHERE conrelid = to_regclass('lims_sample_forms')")
            )
        }
        # Selecting a column that was never added would abort the whole transaction.
        rows = (
            [
                tuple(r)
                for r in db.execute(
                    text("SELECT id, name, route, hplc_prep FROM lims_sample_forms ORDER BY sort_order, id")
                )
            ]
            if "hplc_prep" in forms_found
            else None
        )
    lines, analyses_bad = evaluate(found)
    forms_lines, forms_bad, not_found = evaluate_sample_forms(forms_found, constraints, rows)
    rules_lines, rules_bad = evaluate(rules_found, RULES_EXPECTED, RULES_EITHER_NULLABLE)
    preps_lines, preps_bad = evaluate_sample_preps(preps_found, preps_index)
    items_lines, items_bad = evaluate(items_found, ITEMS_EXPECTED)
    sheets_lines, sheets_bad = evaluate(sheets_found, SHEETS_EXPECTED)
    curves_lines, curves_bad = evaluate(curves_found, CURVES_EXPECTED)
    print("\n".join(lines + forms_lines + ["hplc_prep_rules:"] + rules_lines + ["sample_preps:"] + preps_lines
                    + ["worksheet_items:"] + items_lines + ["hplc_calibration_sheets:"] + sheets_lines
                    + ["calibration_curves:"] + curves_lines))
    bad = analyses_bad + forms_bad + rules_bad + preps_bad + items_bad + sheets_bad + curves_bad
    if bad:
        # Name only what failed, so a rules-table problem does not read as a liquid-prep one.
        failed = [why for count, why in (
            (analyses_bad, "do not ship a liquid prep until hplc_analyses is fixed"),
            (forms_bad, "do not read hplc_prep until lims_sample_forms is fixed"),
            (rules_bad, "do not use the HPLC prep rules until hplc_prep_rules is fixed"),
            (preps_bad, "do not use the HPLC prep worksheet until sample_preps is fixed"),
            (items_bad, "do not use the HPLC prep worksheet until worksheet_items is fixed"),
            (sheets_bad, "do not use the Calibration Curve Worksheet until hplc_calibration_sheets is fixed"),
            (curves_bad, "do not file a worksheet curve until calibration_curves is fixed"),
        ) if count]
        closing = f"{bad} PROBLEM(S): {'; '.join(failed)}"
    elif not_found:
        # Still exit 0, but never a bare "ALL PRESENT" under a NOTICE: a deployer who reads
        # only the last line must learn that a built-in form may hold a NULL prep kind.
        closing = f"ALL PRESENT ({len(not_found)} built-in form(s) not found by name, see NOTICE)"
    else:
        closing = "ALL PRESENT"
    print(closing)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
