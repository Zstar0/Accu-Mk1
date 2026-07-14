"""One-time sweep: heal lims_samples.status from the transition log
(2026-07-14 inbox-desync fix, RC2).

Samples received/moved BEFORE the 1.4.0 event-sync cold-start cursor only
ever got `is_seed` log rows — and the seed backfill deliberately never healed
the status column, so those rows are frozen at whatever status they carried
(mostly 'sample_due'), making them invisible to the mk1-mode worksheets
inbox. The truth is already sitting in `lims_sample_transitions`: this sweep
sets each sample's status to its LATEST whitelist-vocabulary transition
(occurred_at, then id, descending). Zero SENAITE load — purely local.

Non-whitelisted to_status values ('analyzing' from worksheet_assigned events,
etc.) are skipped when picking the winner, so a sample whose newest log row
is IS order-progress vocabulary still heals to its newest real review_state
(RC3 interplay). Samples with no whitelisted transitions are untouched.

Usage (dry-run by default; prints what it would do):

    docker exec -w /app -i accu-mk1-backend \
        python scripts/heal_sample_status_from_transitions.py [--apply]

Idempotent: a re-run after --apply reports 0.
"""
from __future__ import annotations

import argparse
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import select
from sqlalchemy.orm import Session


def sweep(db: Session, *, apply: bool) -> dict:
    """Compute (and with apply=True, write) status heals from the log.

    Returns stats: {"samples", "with_log_state", "would_heal", "healed",
    "by_transition": Counter}. Flush-only on apply — the caller owns the
    commit (mirrors workflow.sample_log's transaction contract)."""
    from models import LimsSample, LimsSampleTransition
    from workflow.sample_log import SAMPLE_REVIEW_STATE_WHITELIST

    stats: dict = {"samples": 0, "with_log_state": 0, "would_heal": 0,
                   "healed": 0, "by_transition": Counter()}

    # Latest whitelisted transition per sample, resolved in one pass: rows
    # arrive ordered newest-first; the first one seen per pk wins.
    latest: dict[int, str] = {}
    for pk, to_status in db.execute(
        select(LimsSampleTransition.lims_sample_pk,
               LimsSampleTransition.to_status)
        .where(LimsSampleTransition.to_status.in_(
            list(SAMPLE_REVIEW_STATE_WHITELIST)))
        .order_by(LimsSampleTransition.occurred_at.desc(),
                  LimsSampleTransition.id.desc())
    ):
        latest.setdefault(pk, to_status)

    rows = db.execute(select(LimsSample)).scalars().all()
    stats["samples"] = len(rows)
    for row in rows:
        target = latest.get(row.id)
        if target is None:
            continue
        stats["with_log_state"] += 1
        if row.status == target:
            continue
        stats["would_heal"] += 1
        stats["by_transition"][f"{row.status} -> {target}"] += 1
        if apply:
            row.status = target
            stats["healed"] += 1
    if apply:
        db.flush()
    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true",
                        help="write the heals (default: dry-run report only)")
    args = parser.parse_args()

    from database import SessionLocal

    with SessionLocal() as db:
        stats = sweep(db, apply=args.apply)
        if args.apply:
            db.commit()

    mode = "APPLIED" if args.apply else "DRY-RUN"
    print(f"[{mode}] samples={stats['samples']} "
          f"with_log_state={stats['with_log_state']} "
          f"would_heal={stats['would_heal']} healed={stats['healed']}")
    for pair, n in sorted(stats["by_transition"].items(),
                          key=lambda kv: -kv[1]):
        print(f"  {pair}: {n}")


if __name__ == "__main__":
    main()
