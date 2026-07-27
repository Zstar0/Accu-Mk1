"""Seed / heal / reset lims_samples.native_status (2026-07-26 spec §7).

    docker exec -w /app -i <backend> python -m scripts.seed_native_status --all --apply
    docker exec -w /app -i <backend> python -m scripts.seed_native_status --samples P-1525 --apply

Dry-run by default. Sets native_status = status and writes one
outcome='seeded' trajectory row per sample (trigger='seed') recording the
adopted state. Serves three roles: initial deploy seed; per-sample heal after
a diagnosed divergence; global burn-in reset after a rule fix. Pure DB — no
SENAITE, no throttle needed. Exit 0 clean; 1 on any per-sample error.

Per-row commits in apply mode: each successful seed is durable before moving
to the next row. Repeated heals append a new seeded trajectory row (audit trail).
"""
from __future__ import annotations

import argparse
import sys

from sqlalchemy import select
from sqlalchemy.orm import Session


def seed_native_status(db: Session, *, sample_ids=None, apply: bool = False) -> dict:
    from models import LimsSample, LimsWorkflowShadowEvaluation
    q = select(LimsSample).order_by(LimsSample.id)
    if sample_ids:
        q = q.where(LimsSample.sample_id.in_(list(sample_ids)))
    stats = {"scanned": 0, "would_seed": 0, "seeded": 0, "errors": 0}
    for row in db.execute(q).scalars().all():
        stats["scanned"] += 1
        try:
            if not apply:
                stats["would_seed"] += 1
                continue
            prior = row.native_status
            row.native_status = row.status
            db.add(LimsWorkflowShadowEvaluation(
                lims_sample_pk=row.id, trigger="seed", verb=None,
                from_status=prior, to_status=row.status, outcome="seeded",
                requirements_met=None, outcomes=[]))
            db.flush()
            db.commit()
            stats["seeded"] += 1
        except Exception:
            stats["errors"] += 1
            db.rollback()
    return stats


def main() -> int:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--all", action="store_true")
    g.add_argument("--samples", type=str)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    from database import SessionLocal
    db = SessionLocal()
    try:
        ids = [s.strip() for s in args.samples.split(",")] if args.samples else None
        stats = seed_native_status(db, sample_ids=ids, apply=args.apply)
        print(f"seed_native_status stats: {stats} "
              f"(mode={'APPLY' if args.apply else 'DRY-RUN'})")
        return 1 if stats["errors"] else 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
