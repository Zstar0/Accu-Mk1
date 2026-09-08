#!/usr/bin/env python3
"""Convergence heal: parents with live native vial-tier analyses whose services
have no parent-tier row (no 'ordered' placeholder, no live canonical) get their
placeholders seeded from IS's services dict.

Born 2026-09-08 to heal the nine parents that lost the registration race
(P-2586, P-2655, P-2659, P-2660, P-2687, P-2688, P-2689, P-2693, P-2694); safe
to run any time (idempotent) and cron-able via `docker exec accu-mk1-backend
python scripts/heal_missing_placeholders.py --apply`.

Dry-run by default. --sample restricts to the given ids.
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="seed (default: report only)")
    ap.add_argument("--sample", action="append", default=[], help="restrict to sample id(s)")
    args = ap.parse_args()

    from database import SessionLocal
    from models import AnalysisService
    from lims_analyses.order_seed import (
        find_parents_missing_native_placeholders, seed_parent_from_services,
    )
    from sub_samples.service import fetch_sample_services

    db = SessionLocal()
    try:
        kw = {a.id: a.keyword for a in db.query(AnalysisService).all()}
        found = find_parents_missing_native_placeholders(db)
        if args.sample:
            only = set(args.sample)
            found = [(p, m) for p, m in found if p.sample_id in only]
        print(f"parents missing native placeholders: {len(found)}  ({'APPLY' if args.apply else 'dry-run'})")
        for parent, missing in found:
            names = ", ".join(sorted(kw.get(i, str(i)) for i in missing))
            if not args.apply:
                print(f"  {parent.sample_id}: missing {names}")
                continue
            raw = fetch_sample_services(parent.sample_id)
            if not raw:
                print(f"  {parent.sample_id}: SKIP no services from IS (missing {names})")
                continue
            try:
                stats = seed_parent_from_services(
                    db, parent=parent, services=raw.get("services") or {},
                    package=raw.get("package"), source="heal",
                )
                db.commit()
                print(f"  {parent.sample_id}: created={stats['created']} existing={stats['existing']} "
                      f"skipped={stats['skipped']} (was missing {names})")
            except Exception as e:  # noqa: BLE001
                db.rollback()
                print(f"  {parent.sample_id}: FAILED {type(e).__name__}: {e}")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
