"""S3 identity pre-check — REQUIRED pre-deploy gate (run against BOTH s3rehe
and prod, naming the environment). run_migrations swallows a failing CREATE
INDEX into an ignorable warning; this script is the only failure surface.

Exit codes: 0 clean · 2 canary failed (existing keyword index missing —
investigate the migration mechanism before anything else) · 3 violations.
Violations are reported, never auto-healed (humans decide repairs).

Usage:
    python scripts/s3_identity_precheck.py --env-label s3rehe
    (reads the same MK1_DB_* / .env config the app connects with — see
    database.get_database_url; override those vars to point at a different DB)
"""
import argparse
import os
import sys

# Make the /app package root importable when run as a file (python -m from
# /app makes this a no-op) — mirrors scripts/backfill_lims_sample_remarks.py.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import text

from database import SessionLocal

# ── the canary: proves the EXISTING keyword-uniqueness index is still live ──
#
# Same (host, keyword) resolving to >1 service under each root predicate.
# Non-zero means the pre-S3 keyword index (uq_lims_analyses_sub_service_root /
# uq_lims_analyses_parent_service_root) is absent or invalid on this DB —
# a migration-mechanism integrity failure that must be investigated BEFORE
# anything below, because if the OLD index silently failed to apply, trusting
# results built on top of it (the S3 checks) would be worthless.
_CANARY_SQL = """
SELECT 'vial' AS tier, lims_sub_sample_pk AS host_pk, keyword,
       COUNT(DISTINCT analysis_service_id) AS n_services,
       array_agg(DISTINCT analysis_service_id) AS service_ids,
       array_agg(id ORDER BY id) AS row_ids
  FROM lims_analyses
 WHERE retest_of_id IS NULL AND lims_sub_sample_pk IS NOT NULL
   AND review_state NOT IN ('retracted', 'rejected')
 GROUP BY lims_sub_sample_pk, keyword
HAVING COUNT(*) > 1
UNION ALL
SELECT 'parent', lims_sample_pk, keyword,
       COUNT(DISTINCT analysis_service_id),
       array_agg(DISTINCT analysis_service_id),
       array_agg(id ORDER BY id)
  FROM lims_analyses
 WHERE retest_of_id IS NULL AND lims_sample_pk IS NOT NULL
   AND review_state NOT IN ('retracted', 'rejected')
   AND provenance = 'canonical'
 GROUP BY lims_sample_pk, keyword
HAVING COUNT(*) > 1
"""

# ── the two hard-blocker gates: would-be violations of the NEW S3 indexes ──

_VIAL_VIOLATIONS_SQL = """
SELECT lims_sub_sample_pk, analysis_service_id, COUNT(*) AS n_rows,
       array_agg(id ORDER BY id) AS row_ids,
       array_agg(DISTINCT keyword) AS distinct_keywords,
       array_agg(DISTINCT review_state) AS states
  FROM lims_analyses
 WHERE retest_of_id IS NULL AND lims_sub_sample_pk IS NOT NULL
   AND review_state NOT IN ('retracted', 'rejected')
 GROUP BY lims_sub_sample_pk, analysis_service_id
HAVING COUNT(*) > 1
 ORDER BY n_rows DESC, lims_sub_sample_pk
"""

_PARENT_VIOLATIONS_SQL = """
SELECT lims_sample_pk, analysis_service_id, COUNT(*) AS n_rows,
       array_agg(id ORDER BY id) AS row_ids,
       array_agg(DISTINCT keyword) AS distinct_keywords,
       array_agg(DISTINCT review_state) AS states
  FROM lims_analyses
 WHERE retest_of_id IS NULL AND lims_sample_pk IS NOT NULL
   AND review_state NOT IN ('retracted', 'rejected')
   AND provenance = 'canonical'
 GROUP BY lims_sample_pk, analysis_service_id
HAVING COUNT(*) > 1
 ORDER BY n_rows DESC, lims_sample_pk
"""

# ── diagnostics only — never gate the exit code, just tell you WHOSE rows ──

_ORIGIN_SPLIT_SQL = """
SELECT 'vial' AS tier, svc.origin AS origin, la.lims_sub_sample_pk AS host_pk,
       la.analysis_service_id, COUNT(*) AS n_rows,
       array_agg(la.id ORDER BY la.id) AS row_ids,
       array_agg(DISTINCT la.keyword) AS distinct_keywords
  FROM lims_analyses la
  JOIN analysis_services svc ON svc.id = la.analysis_service_id
 WHERE la.retest_of_id IS NULL AND la.lims_sub_sample_pk IS NOT NULL
   AND la.review_state NOT IN ('retracted', 'rejected')
 GROUP BY svc.origin, la.lims_sub_sample_pk, la.analysis_service_id
HAVING COUNT(*) > 1
UNION ALL
SELECT 'parent', svc.origin, la.lims_sample_pk,
       la.analysis_service_id, COUNT(*),
       array_agg(la.id ORDER BY la.id),
       array_agg(DISTINCT la.keyword)
  FROM lims_analyses la
  JOIN analysis_services svc ON svc.id = la.analysis_service_id
 WHERE la.retest_of_id IS NULL AND la.lims_sample_pk IS NOT NULL
   AND la.review_state NOT IN ('retracted', 'rejected')
   AND la.provenance = 'canonical'
 GROUP BY svc.origin, la.lims_sample_pk, la.analysis_service_id
HAVING COUNT(*) > 1
 ORDER BY tier, n_rows DESC
"""

_DRIFT_SIZER_SQL = """
SELECT svc.origin AS origin, COUNT(*) AS n_rows
  FROM lims_analyses la
  JOIN analysis_services svc ON svc.id = la.analysis_service_id
 WHERE la.keyword IS DISTINCT FROM svc.keyword
 GROUP BY svc.origin
 ORDER BY n_rows DESC
"""


def keyword_index_canary(db) -> list[dict]:
    """Run FIRST. Non-empty ⇒ the EXISTING keyword index is absent/invalid
    on this DB — investigate the migration mechanism before anything else."""
    return [dict(r) for r in db.execute(text(_CANARY_SQL)).mappings().all()]


def vial_tier_violations(db) -> list[dict]:
    """Would-be violations of the NEW vial-tier S3 index (hard blocker)."""
    return [dict(r) for r in db.execute(text(_VIAL_VIOLATIONS_SQL)).mappings().all()]


def parent_tier_violations(db) -> list[dict]:
    """Would-be violations of the NEW parent-tier S3 index (hard blocker)."""
    return [dict(r) for r in db.execute(text(_PARENT_VIOLATIONS_SQL)).mappings().all()]


def origin_split_diagnostic(db) -> list[dict]:
    """Both tiers' violations segmented by analysis_services.origin —
    diagnostic only, tells you WHOSE rows to repair."""
    return [dict(r) for r in db.execute(text(_ORIGIN_SPLIT_SQL)).mappings().all()]


def drift_sizer(db) -> list[dict]:
    """Diagnostic only — must not raise on any data. Counts rows whose
    denormalized keyword no longer matches the catalog service's current
    keyword, by origin."""
    return [dict(r) for r in db.execute(text(_DRIFT_SIZER_SQL)).mappings().all()]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="S3 identity pre-check — REQUIRED pre-deploy gate. Run "
                    "against BOTH s3rehe and prod, naming the environment "
                    "each time via --env-label.",
        epilog="Exit codes: 0 = clean, 2 = canary failed (existing keyword "
               "index missing — investigate the migration mechanism FIRST), "
               "3 = violations found (reported only, never auto-healed).",
    )
    ap.add_argument(
        "--env-label", required=True,
        help="Name of the environment this run targets (e.g. s3rehe, prod, "
             "local-dev). Required — the environment must be named in output.",
    )
    args = ap.parse_args(argv)

    # Force UTF-8 stdout regardless of the ambient console codepage — on a
    # default Windows cmd.exe/PowerShell (cp1252 or cp437) `print()` of the
    # em-dash below raises UnicodeEncodeError and this "only failure
    # surface" script would itself crash before reporting anything.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

    print(f"=== S3 identity pre-check — environment: {args.env_label} ===")

    db = SessionLocal()
    try:
        canary_hits = keyword_index_canary(db)
        if canary_hits:
            print(f"CANARY FAILED: {len(canary_hits)} (host, keyword) group(s) "
                 "resolve to >1 service.")
            print("The EXISTING keyword-uniqueness index is absent or invalid "
                 "on this DB — investigate the migration mechanism FIRST, "
                 "before trusting anything below.")
            for row in canary_hits:
                print(row)
            return 2
        print("canary: OK — existing keyword index enforced")

        vial_hits = vial_tier_violations(db)
        parent_hits = parent_tier_violations(db)
        if vial_hits or parent_hits:
            print(f"VIOLATIONS FOUND: {len(vial_hits)} vial-tier, "
                 f"{len(parent_hits)} parent-tier.")
            print("These rows would violate the new S3 identity indexes. "
                 "Reported only — NOT auto-healed; a human decides repairs.")
            for row in vial_hits:
                print("[vial]", row)
            for row in parent_hits:
                print("[parent]", row)
            return 3
        print("vial-tier: clean (0 violations)")
        print("parent-tier: clean (0 violations)")

        origin_rows = origin_split_diagnostic(db)
        if origin_rows:
            print(f"origin split diagnostic: {len(origin_rows)} row(s)")
            for row in origin_rows:
                print(row)
        else:
            print("origin split diagnostic: 0 row(s) — nothing to attribute (both gates are clean)")

        drift_rows = drift_sizer(db)
        print(f"drift sizer: {len(drift_rows)} origin group(s) with keyword drift")
        for row in drift_rows:
            print(row)

        print("=== clean ===")
        return 0
    finally:
        # No writes anywhere in this script — rollback is belt-and-braces,
        # never a commit, on a connection that is read-only by convention.
        db.rollback()
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
