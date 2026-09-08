#!/usr/bin/env python3
"""One-off, audited data correction: move the `hm` vial role and every member
service of a profile fulfilled by that role into the Heavy Metals department.

Why (2026-09-08, P-2690): the hm role and its four -PPM services were created
in the catalog admin under Analytical. `coa_exempt_keywords` (RULED 2026-08-12:
Heavy Metals never blocks COA generation) is department-driven, so the
exemption never covered them and their 'ordered' placeholders blocked the COA
with "No verified result yet" for Arsenic/Cadmium/Lead/Mercury.
`backfill_departments` deliberately never clobbers a set department (admin
edits survive restarts), so the correction is explicit, dry-run by default,
and writes a CatalogChangeLog row per changed service.

Run: python scripts/fix_heavy_metals_department.py [--apply] [--role hm]
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write (default: report only)")
    ap.add_argument("--role", default="hm", help="vial role code whose department is authoritative")
    args = ap.parse_args()

    from database import SessionLocal
    from catalog.departments import HEAVY_METALS_DEPARTMENT, department_id_by_name
    from models import AnalysisProfile, CatalogChangeLog, VialRole

    db = SessionLocal()
    try:
        target_id = department_id_by_name(db, HEAVY_METALS_DEPARTMENT)
        if target_id is None:
            print(f"ABORT: department {HEAVY_METALS_DEPARTMENT!r} does not exist")
            return 1
        role = db.query(VialRole).filter_by(code=args.role).one_or_none()
        if role is None:
            print(f"ABORT: vial role {args.role!r} not found")
            return 1
        print(f"target department: {HEAVY_METALS_DEPARTMENT} (id={target_id})  mode={'APPLY' if args.apply else 'dry-run'}")
        changes = 0
        if role.department_id != target_id:
            print(f"  role {role.code}: department {role.department_id} -> {target_id}")
            if args.apply:
                role.department_id = target_id
            changes += 1
        else:
            print(f"  role {role.code}: already {target_id}")
        profiles = db.query(AnalysisProfile).filter_by(fulfillment_role=args.role).all()
        for prof in profiles:
            for svc in prof.analysis_services:
                if svc.department_id == target_id:
                    print(f"  {prof.key}/{svc.keyword}: already {target_id}")
                    continue
                print(f"  {prof.key}/{svc.keyword} (service {svc.id}): department {svc.department_id} -> {target_id}")
                if args.apply:
                    before = svc.department_id
                    svc.department_id = target_id
                    db.add(CatalogChangeLog(
                        entity_type="service", entity_pk=svc.id, action="update",
                        details={"changed": {"department_id": {"before": before, "after": target_id}},
                                 "reason": "scripts/fix_heavy_metals_department.py (2026-09-08 P-2690 COA block)"},
                        user_id=None,
                    ))
                changes += 1
        if args.apply:
            db.commit()
            print(f"applied {changes} change(s)")
        else:
            print(f"{changes} change(s) pending — re-run with --apply")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
