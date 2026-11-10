"""A la carte (no-HPLC) prod recount: the GATE for the Mk1 deploy.

Mk1 is the step that turns a la carte certificates on. This script counts
the existing native samples whose key set would start certifying, and
prints the catalog facts the deploy depends on. READ ONLY by construction:
every DB read runs in its own transaction that starts with
SET TRANSACTION READ ONLY and ends with rollback(); no transaction is open
across an Integration Service call. It prints sample ids, statuses,
matrices and keys only, never a customer name or email.

It imports only modules already in prod 1.58.x (never coa.a_la_carte), and
mirrors the key set coa/a_la_carte.py builds before its c3 HPLC/BW check.
It does NOT apply c1, c2, c4, c5 or the package check, so a hit is an
upper bound: a hit Mk1 would still refuse is reviewed, never missed.

Run on prod (Handler only, after lab hours), from Git Bash:
    ssh root@100.120.92.93 'docker exec -w /app -i accu-mk1-backend python' \
        < backend/scripts/a_la_carte_recount.py
Self-check (no DB, no output, exit 0), from backend/:
    $PY -c "import runpy; runpy.run_path('scripts/a_la_carte_recount.py', run_name='selfcheck')"
"""
import os
import sys
from types import SimpleNamespace

# Run as a file: make the backend package root importable. Piped through
# stdin (the prod form) there is no __file__ and the cwd /app is on sys.path.
if "__file__" in globals():
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from catalog.bw_keys import BW_PRIMARY_KEYS
from catalog.hplc_keys import HPLC_PRIMARY_KEYS

CATALOG_KEYS = (
    "endotoxin-usp85-lal", "rapid-sterility-pcr", "sterility-usp71",
    "heavy_metals", "fentanyl", "vial-vacuum-test", "ph-profile",
)
BW_MATRIX = "Bacteriostatic Water"


def is_hit(keys) -> bool:
    """The samples that start certifying: a non-empty key set with no HPLC
    and no BW primary (the a la carte helper's c3)."""
    keys = set(keys)
    return bool(keys) and not (keys & (HPLC_PRIMARY_KEYS | BW_PRIMARY_KEYS))


def _self_check() -> None:
    assert is_hit({"fentanyl"})
    assert not is_hit({"fentanyl", "hplc-purity-identity"})
    assert not is_hit({"fentanyl", "hplcpurity_identity"})
    assert not is_hit({"endotoxin-usp85-lal", "bac_water_panel"})
    assert not is_hit(set())


def _read(db, fn):
    """One guarded read. fn must return plain data: rollback() expires every
    ORM instance, and touching one afterwards would reload it outside the
    READ ONLY guard."""
    from sqlalchemy import text
    try:
        db.execute(text("SET TRANSACTION READ ONLY"))
        db.execute(text("SET LOCAL statement_timeout = '30s'"))
        return fn(db)
    finally:
        db.rollback()


def _is_retest(is_retest, retest_of, snap) -> bool:
    return bool(is_retest or retest_of or (isinstance(snap, dict) and "retest" in snap))


def _catalog(db) -> list:
    from sqlalchemy import select
    from models import AnalysisProfile, analysis_profile_members, profile_ride_hosts

    out = []
    for key in CATALOG_KEYS:
        prof = db.execute(
            select(AnalysisProfile).where(AnalysisProfile.key == key)
        ).scalar_one_or_none()
        if prof is None:
            out.append({"key": key, "missing": True})
            continue
        hosts = db.execute(
            select(profile_ride_hosts.c.host_role_code)
            .where(profile_ride_hosts.c.analysis_profile_id == prof.id)
            .order_by(profile_ride_hosts.c.priority, profile_ride_hosts.c.id)
        ).scalars().all()
        members = []
        for m in prof.analysis_services:
            others = db.execute(
                select(AnalysisProfile.key, AnalysisProfile.coa_archetype)
                .join(analysis_profile_members,
                      analysis_profile_members.c.analysis_profile_id == AnalysisProfile.id)
                .where(analysis_profile_members.c.analysis_service_id == m.id,
                       AnalysisProfile.active.is_(True),
                       AnalysisProfile.id != prof.id)
                .order_by(AnalysisProfile.key)
            ).all()
            members.append((m.keyword, m.origin, [tuple(o) for o in others]))
        out.append({
            "key": key, "missing": False, "active": prof.active,
            "coa_archetype": prof.coa_archetype,
            "fulfillment_dim": prof.fulfillment_dim,
            "fulfillment_role": prof.fulfillment_role,
            "vials_required": prof.vials_required,
            "ride_hosts": list(hosts), "members": members,
        })
    return out


def _print_catalog(rows) -> None:
    print("== Part 1: catalog")
    for p in rows:
        if p["missing"]:
            print(f"{p['key']}: MISSING (no profile with this key)")
            continue
        print(f"{p['key']}: active={p['active']} coa_archetype={p['coa_archetype']} "
              f"fulfillment_dim={p['fulfillment_dim']} "
              f"fulfillment_role={p['fulfillment_role']} "
              f"vials_required={p['vials_required']}")
        print(f"  ride_hosts (priority order): {p['ride_hosts']}")
        if not p["members"]:
            print("  members: NONE")
        for keyword, origin, others in p["members"]:
            print(f"  member {keyword} origin={origin}")
            for okey, oarch in others:
                flag = "" if oarch == "limit_table" else "  <-- OVERLAP, not limit_table"
                print(f"    also in active profile {okey} coa_archetype={oarch}{flag}")


def main() -> int:
    from sqlalchemy import select
    from coa.native_sections import _lab_added_profile_keys
    from coa.spec_rules import normalize_matrix
    from database import SessionLocal
    from lims_analyses.order_seed import _retest_demand_only
    from models import LimsSample
    from sub_samples.service import fetch_sample_services

    db = SessionLocal()
    try:
        _print_catalog(_read(db, _catalog))

        samples = _read(db, lambda s: [tuple(r) for r in s.execute(
            select(LimsSample.id, LimsSample.sample_id, LimsSample.status,
                   LimsSample.sample_type_title, LimsSample.is_retest,
                   LimsSample.retest_of_sample_id, LimsSample.catalog_snapshot)
            .where(LimsSample.external_lims_system == "mk1")
            .order_by(LimsSample.id)
        ).all()])

        lookup_failures, no_order, no_ordered_test = [], [], []
        hits = {"Peptide": [], BW_MATRIX: [], "Other": []}
        for pk, sample_id, status, title, is_retest, retest_of, snap in samples:
            # No transaction is open here: _read rolled back.
            try:
                raw = fetch_sample_services(sample_id)
            except Exception:
                lookup_failures.append(sample_id)
                continue
            if raw is None:
                no_order.append(sample_id)
                continue
            services = {k: v for k, v in (raw.get("services") or {}).items() if v}
            retest = _is_retest(is_retest, retest_of, snap)
            if retest:
                services = _retest_demand_only(
                    SimpleNamespace(catalog_snapshot=snap), services) or {}
            if not services:
                no_ordered_test.append(sample_id)
                continue
            keys = list(services)
            keys += _read(db, lambda s: _lab_added_profile_keys(s, pk))
            rider = (snap or {}).get("retest") or {}
            keys += sorted(set(rider.get("carry") or []) - set(rider.get("missing") or []))
            keys = list(dict.fromkeys(keys))
            if not is_hit(keys):
                continue
            matrix = normalize_matrix(title)
            bucket = matrix if matrix in ("Peptide", BW_MATRIX) else "Other"
            hits[bucket].append(
                (sample_id, status, matrix, retest, raw.get("package"), sorted(keys)))

        print("== Part 2: recount")
        print(f"scanned={len(samples)}")
        print(f"lookup_failures={len(lookup_failures)} {lookup_failures}")
        print(f"no_order (IS 404)={len(no_order)}")
        print(f"no_ordered_test={len(no_ordered_test)}")
        for bucket, rows in hits.items():
            print(f"-- {bucket} hits: {len(rows)}")
            for row in rows:
                print("  " + ", ".join(str(v) for v in row))
        return 0
    finally:
        db.close()


_self_check()
if __name__ == "__main__":
    sys.exit(main())
