"""Owner-run prod gate for add-on test Variance in Mk1 (read only).

WHO AND WHEN
    The owner runs this after lab hours, BEFORE the Mk1 release that carries
    add-on test Variance is deployed. It WRITES NOTHING: every check runs in
    its own READ ONLY transaction with a 30 s statement timeout (which also
    bounds lock waits), confirms `SHOW transaction_read_only` is `on`, runs one
    SELECT and is rolled back. It never touches `sample_preps`. It prints
    catalog ids, keys, codes, titles of catalog rows, counts, flags and Mk1
    sample ids only, never a customer name, email, lot or order content. It
    uses the container's own DB settings; on any error it prints only the
    error type and the check label, never the message.

    It runs on the image that is on prod BEFORE this branch: it imports only
    `database.SessionLocal` and sqlalchemy. The four keys and the role codes
    are constants here; tests/test_addon_variance_gate_script.py compares
    them with the branch's code.

HOW (Git Bash, over Tailscale)
    ssh root@<prod host> 'docker exec -w /app -i accu-mk1-backend python' \
        < backend/scripts/addon_variance_gate.py

    Self-check only, no DB (brief step 2, from backend/):
        python -c "import runpy; runpy.run_path('scripts/addon_variance_gate.py', run_name='selfcheck')"
    It prints nothing and exits 0 when the self-check passes.

OUTPUT
    Each check prints `PASS|BLOCK|INFO <label>: <what to do>` and its rows.
    The last line is `VERDICT: PASS` (exit 0) or `VERDICT: BLOCK (<checks>)`
    (exit 2 on BLOCK only, exit 1 when any check errored; an errored check is
    named in the verdict). A failed self-check prints
    `VERDICT: BLOCK (self-check)` and exits 1. Record the output in the deploy
    ledger with no credentials.

    The stored services map (`services.variance`) lives in the Integration
    Service, not in Mk1; the IS gate (scripts/is_variance_gate.py, check B)
    reports the four keys there. Mk1 stores only `variance_override`.
"""

import logging
import re
import sys

# The four add-on Variance tests and the vial role each must have on prod
# (lane notes: role codes endo85, pcr, usp71, hm). Keys mirror
# sub_samples.variance_tests.VARIANCE_TEST_KEYS.
ROLE_BY_KEY = {
    "endotoxin-usp85-lal": "endo85",
    "heavy_metals": "hm",
    "rapid-sterility-pcr": "pcr",
    "sterility-usp71": "usp71",
}
KEYS = sorted(ROLE_BY_KEY)
ROLES = sorted(ROLE_BY_KEY.values())
# Roles the fence never covers (variance_tests.LEGACY_BUCKETS).
LEGACY_BUCKETS = ["endo", "hplc", "ster"]
# Legacy override keys on today's path (derive_variance_demand).
LEGACY_VARIANCE_KEYS = ["endotoxin", "sterility_pcr"]
# throughput.HPLC_CATEGORIES
HPLC_CATEGORIES = ["HPLC", "Peptide Analysis", "Peptide Identity"]
RUN_LABEL_VIAL = "Vial"
RUN_LABEL_DIGEST = "Digest"
# COABuilder's Test column fits the longest known title with ", Vial 10".
TITLE_REFERENCE = "Endotoxin USP85 LAL"
TITLE_LIMIT = 28
STATEMENT_TIMEOUT = "30s"
ID_CAP = 200
ERROR_WHY = "the check could not be read; it counts as BLOCK until a re-run reads it"

PARAMS = {
    "keys": KEYS, "roles": ROLES, "legacy": LEGACY_BUCKETS,
    "legacy_keys": LEGACY_VARIANCE_KEYS, "hplc_categories": HPLC_CATEGORIES,
    "hm": ROLE_BY_KEY["heavy_metals"], "limit": TITLE_LIMIT,
    "role_codes": ROLES + ["endo", "ster", "hm"], "cap": ID_CAP,
}

# A vial role belongs to the four tests: the expected codes, or the live
# catalog role of a four-key profile (legacy buckets excluded), as
# variance_test_roles(db) reads it.
TEST_ROLE = (
    "(ss.assignment_role = ANY(CAST(:roles AS text[])) "
    "OR ss.assignment_role IN (SELECT p.fulfillment_role FROM analysis_profiles p "
    "WHERE p.key = ANY(CAST(:keys AS text[])) AND p.fulfillment_role IS NOT NULL "
    "AND p.fulfillment_role <> ALL(CAST(:legacy AS text[]))))"
)
LIVE_ROW = "(NOT a.retested AND a.review_state NOT IN ('rejected', 'retracted'))"
OVERRIDE_SQL = (
    "SELECT k, count(*), "
    "count(*) FILTER (WHERE ls.variance_locked_at IS NOT NULL) AS locked, "
    "count(*) FILTER (WHERE ls.external_lims_system IS DISTINCT FROM 'mk1') AS not_native, "
    "count(*) FILTER (WHERE ls.is_retest) AS retest, "
    "(array_agg(ls.sample_id ORDER BY ls.sample_id))[1:200] "
    "FROM lims_samples ls, unnest(CAST(:{param} AS text[])) AS k "
    "WHERE ls.variance_override IS NOT NULL "
    "AND strpos(ls.variance_override, '\"' || k || '\"') > 0 "
    "GROUP BY k ORDER BY k"
)


class GateError(Exception):
    """A gate check failed. The message is written here, never by a driver."""


def _require(ok, message):
    """An assert that survives `python -O`."""
    if not ok:
        raise GateError(message)


# ---- verdict rules: each returns (tag, one sentence for the owner) ----------

def _judge_profiles(rows):
    """BLOCK on anything the resolver would refuse (resolve_variance_plan,
    _profile_facts) and on a role other than the expected code."""
    problems = []
    for key, pid, _name, active, dim, role, vials, analytical, archetype, role_row in rows:
        if pid is None:
            problems.append(f"{key} has no catalog profile")
            continue
        if not active:
            problems.append(f"{key} is inactive")
        if dim != "role":
            problems.append(f"{key} fulfillment_dim is {dim!r}, not 'role'")
        if archetype != "limit_table":
            problems.append(f"{key} coa_archetype is {archetype!r}, not 'limit_table'")
        if role != ROLE_BY_KEY[key]:
            problems.append(f"{key} role is {role!r}, expected {ROLE_BY_KEY[key]}")
        elif not role_row:
            problems.append(f"{key} role {role} has no vial_roles row")
        if not isinstance(vials, int) or isinstance(vials, bool) or vials < 1:
            problems.append(f"{key} vials_required is {vials!r}, needs 1 or more")
        elif (vials if analytical is None else analytical) != 1:
            problems.append(f"{key} has {vials if analytical is None else analytical} "
                            "analytical vials per run (Mk1 refuses its Variance until ruled)")
    wp = "confirm each test's WordPress `vials` value equals its vials_required"
    if problems:
        return "BLOCK", "fix or rule on each before release: " + "; ".join(problems) + f"; {wp}"
    return "PASS", f"nothing to fix; {wp}"


def _judge_members(rows):
    """BLOCK on a variance_capable member (brief step 4) or a test with no
    member (it cannot print a row)."""
    capable = [f"{r[0]} {r[2]}" for r in rows if r[5]]
    empty = sorted(set(KEYS) - {r[0] for r in rows})
    if capable or empty:
        parts = []
        if capable:
            parts.append("variance_capable is true on " + ", ".join(capable)
                         + " (leave it or set it false via PATCH "
                         "/analysis-services/{id}/variance-capable)")
        if empty:
            parts.append("no member service on " + ", ".join(empty))
        return "BLOCK", "rule on: " + "; ".join(parts)
    return "PASS", "nothing to do; no member is variance_capable"


def _judge_titles(rows):
    """INFO: the owner checks a flagged title against COABuilder's column."""
    long_ = [f"{r[1]!r} ({r[2]})" for r in rows if r[4]]
    if long_:
        return "INFO", (f"check these run labels against COABuilder's Test column "
                        f"(reference {TITLE_LIMIT} chars): " + ", ".join(long_))
    return "INFO", f"nothing to do; every run label fits {TITLE_LIMIT} chars"


def _judge_roles(_rows):
    return "INFO", ("variance_eligible false on the test roles is expected now; step 5 "
                    "switches it on after the deploy (a missing role is BLOCKed by check 1)")


def _judge_hm_census(_rows):
    return "INFO", "evidence only; the hm vials worth a look are listed in the next check"


def _judge_hm_in_set(rows):
    if not rows:
        return "INFO", "nothing to do; no hm vial is in a variance set or of kind variance"
    return "INFO", ("look at each: before this release a restart pulled every hm vial out "
                    "of its set; after it a manual include or a hand-set variance kind "
                    "persists; undo any that should not stand")


def _block_if_rows(why):
    def judge(rows):
        if rows:
            return "BLOCK", why
        return "PASS", "nothing to do; none found"
    return judge


def _judge_snapshot_roles(rows):
    bad = [f"{r[0]} -> {r[1]}" for r in rows if r[1] is not None and r[1] not in ROLES]
    if bad:
        return "BLOCK", ("rule on these snapshot roles: a four-test role that HPLC or another "
                         "test also uses would drop those vials out of the HPLC series: "
                         + ", ".join(bad))
    return "PASS", "nothing to do; every frozen role is one of " + ", ".join(ROLES)


def _info_legacy(_rows):
    return "INFO", "evidence only; legacy overrides keep today's path and lock rule"


# (label, sql, verdict rule). Every SQL is one SELECT; values are bound
# parameters from PARAMS, never interpolated input.
CHECKS = [
    (
        "1 profiles",
        "SELECT k.key, p.id, p.name, p.active, p.fulfillment_dim, p.fulfillment_role, "
        "p.vials_required, p.analytical_vials, p.coa_archetype, r.id IS NOT NULL AS role_row "
        "FROM unnest(CAST(:keys AS text[])) AS k(key) "
        "LEFT JOIN analysis_profiles p ON p.key = k.key "
        "LEFT JOIN vial_roles r ON r.code = p.fulfillment_role "
        "ORDER BY k.key",
        _judge_profiles,
    ),
    (
        "2 members",
        "SELECT p.key, s.id, s.keyword, s.title, s.origin, s.variance_capable, s.category "
        "FROM analysis_profiles p "
        "JOIN analysis_profile_members m ON m.analysis_profile_id = p.id "
        "JOIN analysis_services s ON s.id = m.analysis_service_id "
        "WHERE p.key = ANY(CAST(:keys AS text[])) "
        "ORDER BY p.key, m.sort_order, s.id",
        _judge_members,
    ),
    (
        "2b title lengths",
        "SELECT p.key, s.title, "
        "CASE WHEN coalesce(p.analytical_vials, p.vials_required) < p.vials_required "
        "THEN 'Digest' ELSE 'Vial' END AS label, "
        "char_length(s.title || ', Vial 10') AS vial_len, "
        "char_length(s.title || ', Digest 10') > :limit "
        "AND coalesce(p.analytical_vials, p.vials_required) < p.vials_required "
        "OR char_length(s.title || ', Vial 10') > :limit "
        "AND coalesce(p.analytical_vials, p.vials_required) >= p.vials_required AS over_limit, "
        "char_length(s.title || ', Digest 10') AS digest_len "
        "FROM analysis_profiles p "
        "JOIN analysis_profile_members m ON m.analysis_profile_id = p.id "
        "JOIN analysis_services s ON s.id = m.analysis_service_id "
        "WHERE p.key = ANY(CAST(:keys AS text[])) "
        "ORDER BY p.key, m.sort_order, s.id",
        _judge_titles,
    ),
    (
        "3 vial roles",
        "SELECT r.id, r.code, r.label, r.department_id, r.boxable, r.variance_eligible "
        "FROM vial_roles r "
        "WHERE r.code = ANY(CAST(:role_codes AS text[])) "
        "OR r.code IN (SELECT p.fulfillment_role FROM analysis_profiles p "
        "WHERE p.key = ANY(CAST(:keys AS text[]))) "
        "ORDER BY r.code",
        _judge_roles,
    ),
    (
        "4 hm census",
        "SELECT ss.assignment_kind, ss.in_variance_set, "
        "CASE WHEN ss.variance_exclusion_reason IS NULL THEN NULL "
        "WHEN ss.variance_exclusion_reason LIKE 'auto:%' THEN ss.variance_exclusion_reason "
        "ELSE '(lab-typed reason)' END AS reason, count(*) "
        "FROM lims_sub_samples ss WHERE ss.assignment_role = :hm "
        "GROUP BY 1, 2, 3 ORDER BY 1, 2, 3",
        _judge_hm_census,
    ),
    (
        "4b hm in set or variance kind",
        "SELECT ss.sample_id, ss.vial_sequence, ss.assignment_kind, ss.in_variance_set, "
        "ls.variance_locked_at IS NOT NULL AS parent_locked "
        "FROM lims_sub_samples ss JOIN lims_samples ls ON ls.id = ss.parent_sample_pk "
        "WHERE ss.assignment_role = :hm "
        "AND (ss.in_variance_set OR ss.assignment_kind = 'variance') "
        "ORDER BY ss.sample_id LIMIT :cap",
        _judge_hm_in_set,
    ),
    (
        "5 variance vials on test roles",
        "SELECT ss.assignment_role, count(*), "
        "(array_agg(ss.sample_id ORDER BY ss.sample_id))[1:200] "
        f"FROM lims_sub_samples ss WHERE ss.assignment_kind = 'variance' AND {TEST_ROLE} "
        "GROUP BY 1 ORDER BY 1",
        _block_if_rows(
            "give these vial ids to the owner before release: after it they leave the HPLC "
            "variance series and, on a sample with a four-test Variance map, count as "
            "replicate runs"),
    ),
    (
        "5b in-set test-role vials with HPLC or variance-capable rows",
        "SELECT ss.sample_id, ss.assignment_role, ss.assignment_kind, count(*) AS rows, "
        f"count(*) FILTER (WHERE {LIVE_ROW}) AS live_rows "
        "FROM lims_sub_samples ss "
        "JOIN lims_analyses a ON a.lims_sub_sample_pk = ss.id "
        "JOIN analysis_services s ON s.id = a.analysis_service_id "
        f"WHERE ss.in_variance_set AND {TEST_ROLE} "
        "AND (s.category = ANY(CAST(:hplc_categories AS text[])) OR s.variance_capable) "
        "GROUP BY 1, 2, 3 ORDER BY 1 LIMIT :cap",
        _block_if_rows(
            "rule on each vial before release: the fence drops it from the HPLC variance "
            "series, so these rows (live_rows counts the current ones) leave that series"),
    ),
    (
        "6 four-test overrides",
        OVERRIDE_SQL.format(param="keys"),
        _block_if_rows(
            "rule on each sample before release: after it these samples need the variance "
            "lock before a certificate can be generated, and a non-native or retest sample "
            "is refused"),
    ),
    (
        "6b legacy overrides",
        OVERRIDE_SQL.format(param="legacy_keys"),
        _info_legacy,
    ),
    (
        "7 snapshot roles of the four keys",
        "SELECT e->>'key' AS key, e->>'fulfillment_role' AS role, count(*) "
        "FROM lims_samples ls, jsonb_array_elements(CASE WHEN "
        "jsonb_typeof(ls.catalog_snapshot->'profiles') = 'array' "
        "THEN ls.catalog_snapshot->'profiles' ELSE '[]'::jsonb END) e "
        "WHERE jsonb_typeof(e) = 'object' AND e->>'key' = ANY(CAST(:keys AS text[])) "
        "GROUP BY 1, 2 ORDER BY 1, 2",
        _judge_snapshot_roles,
    ),
]

_WRITE_WORDS = re.compile(
    r"\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|"
    r"COPY|CALL|DO|VACUUM|ANALYZE|REFRESH|SET|LOCK|SHARE|NEXTVAL|SETVAL|SET_CONFIG|"
    r"DBLINK|INTO|EXECUTE|PREPARE|LISTEN|NOTIFY|RESET|DISCARD|COMMIT|BEGIN)\b|\bpg_\w+|\blo_\w+",
    re.IGNORECASE,
)
# Customer fields of lims_samples / lims_orders / lims_analyses, whole
# documents, and the table whose open read blocks a prod endpoint.
_FORBIDDEN = re.compile(
    r"\b(client_\w+|contact_\w+|customer_\w+|billing|shipping\w*|coa_meta|analytes|"
    r"peptide_name|company_logo_url|tracking_\w+|vendor_name|remarks|result_value|"
    r"email|phone|address|first_name|last_name|sample_preps|lims_orders)\b",
    re.IGNORECASE,
)
_WHOLE_VALUE = re.compile(r"(?<!count\()\*|\bSELECT\s+(\w+\.)?(catalog_snapshot|variance_override)\b"
                          r"|,\s*(\w+\.)?(catalog_snapshot|variance_override)\s*(,|FROM)",
                          re.IGNORECASE)


def _self_check(checks=None, keys=None):
    """Assert the query list is read only and customer-data free, and that
    the constants are in step with the code when it is importable. Raises
    GateError. Silent on success, except one line when the code could not
    be imported (prod before this release)."""
    checks = CHECKS if checks is None else checks
    keys = KEYS if keys is None else keys
    _require(len(f"{TITLE_REFERENCE}, {RUN_LABEL_VIAL} 10") == TITLE_LIMIT == 28,
             "title-length rule: the reference run label is not 28 chars")
    labels = [c[0] for c in checks]
    _require(len(labels) == len(set(labels)), f"duplicate labels: {labels}")
    for label, sql, judge in checks:
        _require(sql.lstrip().upper().startswith("SELECT "), f"{label}: not a SELECT")
        _require(";" not in sql, f"{label}: more than one statement")
        bad = _WRITE_WORDS.findall(sql)
        _require(not bad, f"{label}: write word(s) {bad}")
        hit = _FORBIDDEN.search(sql)
        _require(not hit, f"{label}: names a customer field or table ({hit and hit.group(0)})")
        _require(not _WHOLE_VALUE.search(sql), f"{label}: selects a whole row or document")
        _require(callable(judge), f"{label}: no verdict rule")
    _require(sorted(keys) == sorted(ROLE_BY_KEY), f"keys and roles disagree: {sorted(keys)}")
    _require(len(set(ROLE_BY_KEY.values())) == len(ROLE_BY_KEY), "two tests share a role")
    _require(not set(ROLES) & set(LEGACY_BUCKETS), "a test role is a legacy bucket")
    try:
        from sub_samples import variance_tests as vt
    except Exception as exc:  # the type only, never str(exc)
        print("self-check: the key list was NOT compared with the code on this run "
              f"({type(exc).__name__}; expected on the image before this release)")
        return
    _require(sorted(keys) == sorted(vt.VARIANCE_TEST_KEYS),
             f"keys drifted from the code: {sorted(vt.VARIANCE_TEST_KEYS)}")
    _require(sorted(LEGACY_BUCKETS) == sorted(vt.LEGACY_BUCKETS),
             f"legacy buckets drifted: {sorted(vt.LEGACY_BUCKETS)}")
    _require((RUN_LABEL_VIAL, RUN_LABEL_DIGEST) == (vt.RUN_LABEL_VIAL, vt.RUN_LABEL_DIGEST),
             "run labels drifted")


def _verdict(blocked, errored):
    if not blocked and not errored:
        print("VERDICT: PASS")
        return 0
    names = blocked + [f"{label} error" for label in errored]
    print(f"VERDICT: BLOCK ({', '.join(names)})")
    return 1 if errored else 2


def run(checks=None, params=None):
    """Run every check in its own read-only transaction. Returns the exit code."""
    previous = logging.root.manager.disable
    logging.disable(logging.CRITICAL)  # no driver log line can carry the DSN
    try:
        return _run_checks(CHECKS if checks is None else checks,
                           PARAMS if params is None else params)
    finally:
        logging.disable(previous)


def _run_checks(checks, params):
    try:
        from sqlalchemy import text

        from database import SessionLocal
    except Exception as exc:  # never str(exc): a URL error can carry the DSN
        print(f"setup: ERROR {type(exc).__name__} (check the container's DB settings)")
        return _verdict([], ["setup"])
    blocked, errored = [], []
    for label, sql, judge in checks:
        try:
            db = SessionLocal()
            try:
                db.execute(text("SET TRANSACTION READ ONLY"))
                db.execute(text(f"SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT}'"))
                read_only = db.execute(text("SHOW transaction_read_only")).scalar()
                _require(read_only == "on", f"transaction_read_only is {read_only!r}")
                stmt = text(sql)
                used = {k: v for k, v in params.items() if re.search(rf":{k}\b", sql)}
                rows = [tuple(r) for r in db.execute(stmt, used).all()]
            finally:
                db.rollback()
                db.close()
            tag, why = judge(rows)
        except GateError as exc:
            errored.append(label)
            print(f"ERROR {label}: {exc}; {ERROR_WHY}")
            continue
        except Exception as exc:  # never str(exc): it can carry connection details
            errored.append(label)
            print(f"ERROR {label}: {type(exc).__name__}; {ERROR_WHY}")
            continue
        if tag == "BLOCK":
            blocked.append(label)
        print(f"{tag} {label}: {why}")
        for r in rows:
            print(f"    {r}")
    return _verdict(blocked, errored)


def _self_check_or_exit():
    try:
        _self_check()
    except GateError as exc:
        print(f"self-check failed: {exc}")
        print("VERDICT: BLOCK (self-check)")
        sys.exit(1)


if __name__ == "__main__":
    _self_check_or_exit()
    sys.exit(run())
else:
    _self_check_or_exit()
