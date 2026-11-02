"""Post-deploy check for the HPLC results engine schema (plan
docs/superpowers/plans/2026-10-31-hplc-results-engine.md, Task 6): do the new
hplc_analyses columns exist, and are the two stock-vial weighings nullable?

_run_migrations runs each ALTER on its own and LOGS a failure instead of raising, so a
column can silently fail to exist in production, and a DROP NOT NULL that failed leaves
every liquid row to 500 at insert. This reads information_schema only, in a read-only
transaction, and takes no arguments and no credentials: it uses the container's own
engine (database.SessionLocal), like capture_hplc_golden.py beside it.

Prints one line per column. Exits 1 if any column is missing or has the wrong
nullability, 0 otherwise, so a release script can gate on it. Prod (stdin form, per the
data-fix runbook):
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


def evaluate(found):
    """(report lines, number of problems) for `found`, a {column: (data_type, is_nullable)}.
    Pure, so the pass and fail paths can be checked without a database."""
    lines, bad = [], 0
    for name, want in EXPECTED.items():
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


def main():
    from sqlalchemy import text

    from database import SessionLocal

    with SessionLocal() as db:
        db.execute(text("SET TRANSACTION READ ONLY"))
        found = {
            name: (data_type, nullable)
            for name, data_type, nullable in db.execute(
                text(
                    "SELECT column_name, data_type, is_nullable FROM information_schema.columns "
                    "WHERE table_name = 'hplc_analyses' AND column_name = ANY(:names)"
                ),
                {"names": list(EXPECTED)},
            )
        }
    lines, bad = evaluate(found)
    print("\n".join(lines))
    print("ALL PRESENT" if not bad else f"{bad} PROBLEM(S): do not ship a liquid prep until fixed")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
