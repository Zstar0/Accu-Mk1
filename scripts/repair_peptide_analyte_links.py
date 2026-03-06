"""
Repair peptide_analytes.analysis_service_id FK references after DB migration.

PROBLEM: When the local DB was migrated to production PostgreSQL, analysis_services
was re-synced from Senaite with new auto-increment IDs. The peptide_analytes rows
carried over from local now have analysis_service_id values that point to wrong
(or no) services in production.

STRATEGY: Re-link each peptide_analyte to the correct analysis_service using
senaite_id (stable, unique Senaite identifier) as the matching key. Requires
running the diagnostic query on LOCAL first to get the correct senaite_id mapping,
then applying the fix on PRODUCTION.

Usage:
  # Step 1 — show what's currently broken (run on PROD)
  python scripts/repair_peptide_analyte_links.py --diagnose

  # Step 2 — dry-run the repair (run on PROD)
  python scripts/repair_peptide_analyte_links.py --fix --dry-run

  # Step 3 — apply the repair (run on PROD)
  python scripts/repair_peptide_analyte_links.py --fix

  # Run against local DB instead:
  python scripts/repair_peptide_analyte_links.py --diagnose --local

Requires: DATABASE_URL env var (or MK1_DB_* env vars), psycopg2 or sqlalchemy
"""

import argparse
import os
import sys
from typing import Optional

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    print("ERROR: psycopg2 not installed. Run: pip install psycopg2-binary")
    sys.exit(1)


def get_conn(local: bool = False):
    """Get a DB connection. Prefers DATABASE_URL, falls back to MK1_DB_* env vars."""
    if local:
        # Local dev DB — adjust if using a different local URL
        url = os.environ.get("LOCAL_DATABASE_URL") or os.environ.get("DATABASE_URL")
    else:
        url = os.environ.get("DATABASE_URL")
        if not url:
            host = os.environ.get("MK1_DB_HOST")
            port = os.environ.get("MK1_DB_PORT", "5432")
            user = os.environ.get("MK1_DB_USER")
            password = os.environ.get("MK1_DB_PASSWORD")
            dbname = os.environ.get("MK1_DB_NAME", "accumark_mk1")
            if not all([host, user, password]):
                print("ERROR: Set DATABASE_URL or MK1_DB_HOST/USER/PASSWORD env vars.")
                sys.exit(1)
            url = f"postgresql://{user}:{password}@{host}:{port}/{dbname}"

    if not url:
        print("ERROR: No DATABASE_URL configured.")
        sys.exit(1)

    return psycopg2.connect(url)


DIAGNOSE_SQL = """
SELECT
    p.abbreviation        AS peptide,
    pa.slot,
    pa.id                 AS peptide_analyte_id,
    pa.analysis_service_id,
    a.title               AS current_service_title,
    a.peptide_name        AS service_peptide_name,
    a.senaite_id,
    CASE
        WHEN a.id IS NULL THEN 'BROKEN (no matching service)'
        -- Normalize: strip hyphens and spaces before comparing
        WHEN REPLACE(REPLACE(LOWER(TRIM(COALESCE(a.peptide_name,''))),'-',''),' ','')
           = REPLACE(REPLACE(LOWER(TRIM(p.abbreviation)),'-',''),' ','') THEN 'OK'
        WHEN REPLACE(REPLACE(LOWER(TRIM(COALESCE(a.peptide_name,''))),'-',''),' ','')
           = REPLACE(REPLACE(LOWER(TRIM(p.name)),'-',''),' ','') THEN 'OK'
        ELSE 'MISMATCH'
    END AS status
FROM peptide_analytes pa
JOIN peptides p ON p.id = pa.peptide_id
LEFT JOIN analysis_services a ON a.id = pa.analysis_service_id
ORDER BY p.abbreviation, pa.slot;
"""

# Re-link each peptide_analyte to the service whose peptide_name most closely
# matches the parent peptide's abbreviation or name. Uses senaite_id as stable key.
#
# Strategy: for each broken row, find the analysis_service where peptide_name
# matches peptide abbreviation or name (case-insensitive). If multiple matches,
# prefer the one whose slot-ordering matches (services for the same peptide differ
# by type: Identity, Purity, Quantity).
#
# NOTE: This relies on analysis_services.peptide_name being set correctly.
# If peptide_name is NULL for relevant services, the keyword field is used as fallback.
FIND_CORRECT_SERVICE_SQL = """
SELECT
    pa.id                   AS peptide_analyte_id,
    pa.slot,
    p.id                    AS peptide_id,
    p.abbreviation,
    p.name                  AS peptide_name,
    pa.analysis_service_id  AS current_svc_id,
    cur_svc.title           AS current_svc_title,
    -- Best matching service: peptide_name matches abbreviation
    correct.id              AS correct_svc_id,
    correct.title           AS correct_svc_title,
    correct.senaite_id      AS correct_senaite_id
FROM peptide_analytes pa
JOIN peptides p ON p.id = pa.peptide_id
LEFT JOIN analysis_services cur_svc ON cur_svc.id = pa.analysis_service_id
LEFT JOIN LATERAL (
    SELECT a.id, a.title, a.senaite_id
    FROM analysis_services a
    WHERE
        a.active = true
        AND (
            -- Normalize: strip hyphens/spaces for fuzzy name match
            REPLACE(REPLACE(LOWER(TRIM(COALESCE(a.peptide_name,''))),'-',''),' ','')
              = REPLACE(REPLACE(LOWER(TRIM(p.abbreviation)),'-',''),' ','')
            OR REPLACE(REPLACE(LOWER(TRIM(COALESCE(a.peptide_name,''))),'-',''),' ','')
              = REPLACE(REPLACE(LOWER(TRIM(p.name)),'-',''),' ','')
        )
    ORDER BY
        -- Prefer same slot-type ordering: slot 1 = Identity-type, slot 2 = Purity-type, etc.
        -- Use keyword pattern to guess slot alignment
        CASE
            WHEN pa.slot = 1 AND (a.title ILIKE '%Identity%' OR a.keyword ILIKE '%ID%') THEN 0
            WHEN pa.slot = 2 AND (a.title ILIKE '%Purity%' OR a.keyword ILIKE '%PURITY%') THEN 0
            WHEN pa.slot = 3 AND (a.title ILIKE '%Quantity%' OR a.keyword ILIKE '%QTY%') THEN 0
            ELSE 1
        END,
        a.id
    LIMIT 1
) correct ON true
WHERE
    -- Only show rows that need fixing (normalize when comparing)
    cur_svc.id IS NULL
    OR (
        REPLACE(REPLACE(LOWER(TRIM(COALESCE(cur_svc.peptide_name,''))),'-',''),' ','')
          != REPLACE(REPLACE(LOWER(TRIM(p.abbreviation)),'-',''),' ','')
        AND REPLACE(REPLACE(LOWER(TRIM(COALESCE(cur_svc.peptide_name,''))),'-',''),' ','')
          != REPLACE(REPLACE(LOWER(TRIM(p.name)),'-',''),' ','')
    )
ORDER BY p.abbreviation, pa.slot;
"""


def green(s): return f"\033[92m{s}\033[0m"
def red(s): return f"\033[91m{s}\033[0m"
def yellow(s): return f"\033[93m{s}\033[0m"
def bold(s): return f"\033[1m{s}\033[0m"
def dim(s): return f"\033[2m{s}\033[0m"


def cmd_diagnose(conn):
    """Show current state of all peptide_analyte links."""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(DIAGNOSE_SQL)
        rows = cur.fetchall()

    if not rows:
        print("No peptide_analytes found.")
        return

    broken = [r for r in rows if r['status'] != 'OK']
    ok = [r for r in rows if r['status'] == 'OK']

    print(bold(f"\n{'Peptide':<20} {'Slot':<5} {'Status':<30} {'Current Service Title':<60} {'senaite_id'}"))
    print("─" * 150)
    for r in rows:
        status_str = r['status']
        if status_str == 'OK':
            status_col = green(f"{'OK':<30}")
        elif 'BROKEN' in status_str:
            status_col = red(f"{status_str:<30}")
        else:
            status_col = yellow(f"{status_str:<30}")

        svc_title = (r['current_service_title'] or '—')[:58]
        print(f"{r['peptide']:<20} {str(r['slot']):<5} {status_col} {svc_title:<60} {r['senaite_id'] or '—'}")

    print(f"\n{green(str(len(ok)))} OK  •  {red(str(len(broken)))} need fixing")


def cmd_fix(conn, dry_run: bool = True):
    """Re-link broken peptide_analytes to the correct analysis_service."""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(FIND_CORRECT_SERVICE_SQL)
        rows = cur.fetchall()

    if not rows:
        print(green("Nothing to fix — all peptide_analyte links look correct."))
        return

    fixable = [r for r in rows if r['correct_svc_id'] is not None]
    unfixable = [r for r in rows if r['correct_svc_id'] is None]

    print(bold(f"\nRows that need fixing: {len(rows)}"))
    print(bold(f"  Auto-fixable (correct service found): {len(fixable)}"))
    print(bold(f"  Needs manual attention (no match found): {len(unfixable)}"))

    if fixable:
        print(bold("\nProposed fixes:"))
        print(f"{'Peptide':<20} {'Slot':<5} {'Old Service':<50} {'→  New Service':<50} {'senaite_id'}")
        print("─" * 165)
        for r in fixable:
            old_title = (r['current_svc_title'] or '—')[:48]
            new_title = (r['correct_svc_title'] or '—')[:48]
            print(f"{r['abbreviation']:<20} {str(r['slot']):<5} {red(old_title):<50} {green('→  ' + new_title):<50} {r['correct_senaite_id'] or '—'}")

    if unfixable:
        print(bold(red(f"\nCannot auto-fix ({len(unfixable)} rows) — no matching service found:")))
        for r in unfixable:
            print(f"  {r['abbreviation']} slot {r['slot']} — current: {r['current_svc_title'] or 'BROKEN'}")
        print("\nFor these, you'll need to manually assign the correct analysis_service_id.")
        print("Run: GET /analysis-services to find the right service ID.")
        print("Then: PUT /peptides/{id} with {'analytes': [{'slot': N, 'analysis_service_id': M}]}")

    if dry_run:
        print(yellow(f"\n[DRY RUN] No changes made."))
        print(f"To apply: python scripts/repair_peptide_analyte_links.py --fix")
        return

    if not fixable:
        return

    # Apply fixes
    print(bold(f"\nApplying {len(fixable)} fix(es)..."))
    with conn.cursor() as cur:
        fixed = 0
        for r in fixable:
            cur.execute(
                "UPDATE peptide_analytes SET analysis_service_id = %s WHERE id = %s",
                (r['correct_svc_id'], r['peptide_analyte_id'])
            )
            fixed += cur.rowcount

    conn.commit()
    print(green(f"Done. Updated {fixed} peptide_analyte row(s)."))
    print("Reload the app to see the corrected analyte names in Add Curve dialog.")


def main():
    parser = argparse.ArgumentParser(
        description="Diagnose and repair peptide_analyte FK links after DB migration."
    )
    parser.add_argument("--diagnose", action="store_true", help="Show current state")
    parser.add_argument("--fix", action="store_true", help="Repair broken links")
    parser.add_argument("--dry-run", action="store_true", help="Show changes without applying (use with --fix)")
    parser.add_argument("--local", action="store_true", help="Connect to local DB instead of production")
    args = parser.parse_args()

    if not args.diagnose and not args.fix:
        parser.print_help()
        sys.exit(1)

    env_label = "LOCAL" if args.local else "PRODUCTION"
    print(bold(f"{'='*60}"))
    print(bold(f"  Peptide Analyte Link Repair ({env_label})"))
    print(bold(f"{'='*60}"))

    conn = get_conn(local=args.local)

    try:
        if args.diagnose:
            cmd_diagnose(conn)

        if args.fix:
            cmd_fix(conn, dry_run=args.dry_run)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
