"""Post-deploy check for the HPLC results engine schema (plan
docs/superpowers/plans/2026-10-31-hplc-results-engine.md, Task 6): do the new
hplc_analyses columns exist, and are the two stock-vial weighings nullable? Task 8 adds
lims_sample_forms: does hplc_prep exist, is its CHECK there, and did the backfill fill the
two built-in forms that have a prep kind?

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

# column -> is_nullable. The first five are new; the two stock weighings were NOT NULL
# until a liquid prep (which never weighs its stock vial) needed them blank.
EXPECTED = {
    "prep_form": "YES",
    "declared_volume_ml": "YES",
    "int_vial_empty": "YES",
    "int_vial_with_diluent": "YES",
    "int_vial_with_diluent_and_sample": "YES",
    "stock_vial_empty": "YES",
    "stock_vial_with_diluent": "YES",
}


# lims_sample_forms (Task 8): the new column stays nullable (NULL = no HPLC prep maths), its
# CHECK is added by a DO block that only logs on failure, and the backfill matches the six
# built-in names as lower(btrim(name)). Only the first two have a prep kind; the other four
# stay NULL until capsule is ruled. A form the Handler added or renamed is not judged.
FORMS_EXPECTED = {"hplc_prep": "YES"}
FORMS_CHECK = "ck_lims_sample_forms_hplc_prep"
FORMS_PREP = {
    "lyophilized powder": "powder",
    "reconstituted solution": "liquid",
    "pen": None,
    "nasal spray": None,
    "capsule": None,
    "tablet": None,
}


def evaluate(found, expected=EXPECTED):
    """(report lines, number of problems) for `found`, a {column: (data_type, is_nullable)}.
    Pure, so the pass and fail paths can be checked without a database."""
    lines, bad = [], 0
    for name, want in expected.items():
        got = found.get(name)
        if got is None:
            status = "MISSING"
        elif got[1] != want:
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
    lines, bad = evaluate(found)
    forms_lines, forms_bad, not_found = evaluate_sample_forms(forms_found, constraints, rows)
    print("\n".join(lines + forms_lines))
    bad += forms_bad
    if bad:
        closing = f"{bad} PROBLEM(S): do not ship a liquid prep or read hplc_prep until fixed"
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
