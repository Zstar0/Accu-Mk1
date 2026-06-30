"""Pre-ship scan for the variance-page-vial-list change.

Read-only. Finds variance samples whose PARENT carries an HPLC analyte figure
(purity / quantity / identity) that NO in-set sub-vial covers — the only data
shape where "list the sub-vials, ignore the parent" would drop a value. Any
sample flagged here must have the missing sub-vial added + populated (manager
data fix) before its certificate is regenerated under the new renderer.

Run inside the prod backend container (reads MK1_DB_* from the container env):
  ssh root@165.227.241.81 "docker exec -i accu-mk1-backend python -" < scripts/scan_parent_only_variance.py
"""
import os
import psycopg2

# Generic HPLC keywords; identity (ID_*) and per-substance PUR_/QTY_ matched by prefix.
HPLC_KW = ("HPLC-PUR", "PEPT-Total")
LIVE_STATES = (
    "submitted", "to_be_verified", "verified", "published",
    "variance_verified", "promoted",
)

conn = psycopg2.connect(
    host=os.environ["MK1_DB_HOST"], port=os.environ.get("MK1_DB_PORT", "5432"),
    dbname=os.environ.get("MK1_DB_NAME", "accumark_mk1"),
    user=os.environ["MK1_DB_USER"], password=os.environ["MK1_DB_PASSWORD"],
)
cur = conn.cursor()

# Variance samples = parents with >=1 in-set variance sub-vial.
cur.execute("""
    SELECT DISTINCT p.id, p.sample_id
    FROM lims_samples p
    JOIN lims_sub_samples ss ON ss.parent_sample_pk = p.id
    WHERE ss.in_variance_set = TRUE AND ss.assignment_kind = 'variance'
    ORDER BY p.sample_id
""")
variance_parents = cur.fetchall()

flagged = []
for pid, sid in variance_parents:
    # Parent-tier HPLC analyte categories with a current reportable figure.
    cur.execute("""
        SELECT DISTINCT a.keyword FROM lims_analyses a
        WHERE a.lims_sample_pk = %s AND a.retested = FALSE AND a.reportable = TRUE
          AND a.result_value IS NOT NULL AND a.result_value <> ''
          AND a.review_state = ANY(%s)
          AND (a.keyword = ANY(%s) OR a.keyword LIKE 'ID\\_%%'
               OR a.keyword LIKE 'PUR\\_%%' OR a.keyword LIKE 'QTY\\_%%')
    """, (pid, list(LIVE_STATES), list(HPLC_KW)))
    parent_kw = {r[0] for r in cur.fetchall()}

    # In-set sub-vial HPLC categories with a current reportable figure.
    cur.execute("""
        SELECT DISTINCT a.keyword FROM lims_analyses a
        JOIN lims_sub_samples ss ON ss.id = a.lims_sub_sample_pk
        WHERE ss.parent_sample_pk = %s AND ss.in_variance_set = TRUE
          AND a.retested = FALSE AND a.reportable = TRUE
          AND a.result_value IS NOT NULL AND a.result_value <> ''
          AND a.review_state = ANY(%s)
    """, (pid, list(LIVE_STATES)))
    sub_kw = {r[0] for r in cur.fetchall()}

    uncovered = parent_kw - sub_kw
    if uncovered:
        flagged.append((sid, sorted(uncovered)))

print(f"variance samples scanned: {len(variance_parents)}")
print(f"flagged (parent figure not covered by any in-set sub-vial): {len(flagged)}")
for sid, kws in flagged:
    print(f"  {sid}: {kws}")
