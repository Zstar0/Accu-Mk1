"""S9 demand-catalog pre-deploy gate. Run against BOTH s3rehe and prod,
naming the environment. Exit codes: 0 clean · 3 violations (reported,
never auto-healed). A pre-catalog-layer DB reports the layer absent and
exits 0 — the demand flip is inert until first boot seeds profiles.

Consumes catalog.demand_verify.verify_demand_catalog (S9 Task 3) as the
single source of check logic — this script is a thin CLI gate around it,
modeled on scripts/s3_identity_precheck.py's run/report contract.

Usage:
    python scripts/s9_demand_precheck.py --env-label s3rehe
    (reads the same MK1_DB_* / .env config the app connects with — see
    database.get_database_url; override those vars to point at a different DB)
"""
import argparse
import os
import sys

# Make the /app package root importable when run as a file (python -m from
# /app makes this a no-op) — mirrors scripts/s3_identity_precheck.py.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import inspect as sa_inspect

from database import SessionLocal
from catalog.demand_verify import verify_demand_catalog


def run_precheck(db, env_label: str) -> int:
    """Run the demand-catalog check against `db` and print the report.
    Returns the exit code: 0 clean (including empty-catalog and a
    pre-catalog-layer DB), 3 violations found. Split out of main() so the
    decision/reporting logic is testable without a real CLI invocation or
    SessionLocal() of its own.

    verify_demand_catalog returns violation STRINGS, not distinct rows — a
    legacy key with a role set but vials_required=0 can trip both the
    legacy-completeness check and the zero-vials check and appear twice.
    Treat the list as truthy/falsy plus print-all; the printed count below
    is a line count, not a distinct-row count.

    Table probe uses db.connection() (the session's OWN bound connection),
    NOT db.get_bind() (the Engine). inspect(engine) checks out a SEPARATE
    connection from the pool; on the SQLite :memory: fixture (SingletonThread
    Pool shares one physical connection per thread) that second connection's
    implicit close/rollback silently wiped this session's flushed-but-
    uncommitted seed rows before verify_demand_catalog ever ran — caught by
    test_violations_exit_three_and_report going green with 0 violations
    instead of red. db.connection() reuses the session's live transaction
    connection, so the probe is side-effect-free everywhere (SQLite fixture
    and real Postgres alike)."""
    print(f"=== S9 demand pre-check — environment: {env_label} ===")

    if not sa_inspect(db.connection()).has_table("analysis_profiles"):
        print(
            "catalog layer absent — no analysis_profiles table on this DB "
            "(pre-first-boot). The demand flip is inert until the first "
            "boot seeds profiles — re-run this script post-boot."
        )
        print("=== clean (catalog layer absent) ===")
        return 0

    from models import AnalysisProfile
    if db.query(AnalysisProfile).count() == 0:
        # Mirrors verify_demand_catalog's own empty-catalog escape hatch —
        # a fresh install / pre-first-boot catalog is not a misconfiguration.
        # Reported explicitly here (rather than silently falling through to
        # the generic "=== clean ===") so an operator seeing this on a
        # supposedly-live environment knows to re-check the seed step, not
        # assume the catalog was validated.
        print(
            "demand catalog is empty (0 analysis_profiles rows) — fresh "
            "install / pre-first-boot, not a misconfiguration. Re-run once "
            "the catalog is seeded."
        )
        print("=== clean (empty catalog) ===")
        return 0

    violations = verify_demand_catalog(db)
    if violations:
        for v in violations:
            print(v)
        print(f"=== VIOLATIONS: {len(violations)} ===")
        return 3

    print("=== clean ===")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="S9 demand-catalog pre-deploy gate. Run against BOTH "
                    "s3rehe and prod, naming the environment each time via "
                    "--env-label.",
        epilog="Exit codes: 0 = clean (including empty-catalog and "
               "pre-catalog-layer DBs), 3 = violations found (reported "
               "only, never auto-healed).",
    )
    ap.add_argument(
        "--env-label", required=True,
        help="Name of the environment this run targets (e.g. s3rehe, prod, "
             "local-dev). Required — the environment must be named in output.",
    )
    args = ap.parse_args(argv)

    # Force UTF-8 stdout regardless of the ambient console codepage — same
    # rationale as s3_identity_precheck.py.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

    db = SessionLocal()
    try:
        return run_precheck(db, args.env_label)
    finally:
        # Read-only by convention — rollback is belt-and-braces, never a commit.
        db.rollback()
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
