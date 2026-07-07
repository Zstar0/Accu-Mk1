"""One-time backfill: populate lims_samples with COMPLETE basic info for every
SENAITE AnalysisRequest (2026-07-02-lims-sample-canonical-basic-info-design.md).

Run INSIDE the backend container so the app's modules and env are available:

    docker exec -w /app -i <backend-container> \
        python -m scripts.backfill_lims_sample_basic_info --sleep 0.5 --batch-size 50

Idempotent: re-running only fills gaps / refreshes; never duplicates. Resumable
via --checkpoint (JSON file holding the last page cursor). Use --dry-run for a
rehearsal that enumerates + fetches (throttled) but writes nothing (no DB rows,
no checkpoint), and --limit N for a smoke run.

SENAITE BULK-SCAN SAFETY (load-bearing — do not "optimize" away): SENAITE runs
a single Zope core; an unthrottled jsonapi sweep over the full ~1,200+ AR set
has taken it down for ~15 minutes before. This script therefore pages in modest
batches, sleeps between EVERY per-sample fetch, runs strictly sequentially
(concurrency 1), and must be run off-hours.

The final stats line on stdout is the ISO 17025 coverage evidence (7.4.2 /
7.11.2) — retain it with the run record.

Checkpoint retention: after ANY completed run (clean or with per-sample
errors) the checkpoint file remains at the FINAL cursor. Re-running with the
same --checkpoint path resumes at the END and processes nothing. To re-scan
from the start — including retrying samples that errored, since an errored
sample still advances the cursor — DELETE the checkpoint file first.

Exit code contract: 0 = clean run, no per-sample errors. 1 = run completed
but one or more samples errored (see the "errors" count in the stats line).
"""
import argparse
import json
import logging
import os
import re
import sys
import time

# Make the /app package root importable when run as a file (python -m from
# /app makes this a no-op).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import select

from database import SessionLocal
from models import LimsSample
from sub_samples import senaite
from sub_samples.service import _create_sample_row, _populate_basic_info
from sub_samples.native_id import mint_native_id, seed_native_id_counters

log = logging.getLogger("backfill_basic_info")

# Sub-sample secondaries use `<parent>-S<NN>` ids (models.LimsSubSample); they
# are vials, NOT parents — creating lims_samples rows for them would corrupt
# the registry. Matches anywhere so `P-0134-S01-R01` (secondary retest) is
# also excluded. Plain retests (P-0134-R01) ARE backfilled.
_SECONDARY_ID = re.compile(r"-S\d+")

DEFAULT_CHECKPOINT = "/tmp/backfill_lims_sample_basic_info.checkpoint.json"


def load_checkpoint(path: str) -> int:
    """Return the b_start cursor to resume from (0 = fresh run)."""
    try:
        with open(path) as f:
            return int(json.load(f).get("b_start", 0))
    except (OSError, ValueError):
        return 0


def save_checkpoint(path: str, b_start: int, last_id: str) -> None:
    """Persist the page cursor. Page-granular: resuming re-processes the
    current page, which is safe because the upsert is idempotent."""
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"b_start": b_start, "last_id": last_id}, f)
    os.replace(tmp, path)


def backfill(db_factory, *, sleep_s: float, batch_size: int,
             checkpoint_path: str, dry_run: bool, limit) -> dict:
    """Enumerate every SENAITE AR; for each PARENT id, fetch meta ONCE and
    upsert the full basic-info set. One sample's failure never aborts the run.
    Returns coverage stats."""
    stats = {"seen": 0, "created": 0, "updated": 0,
             "skipped_secondary": 0, "errors": 0,
             "native_minted": 0, "counters_seeded": 0}
    start = load_checkpoint(checkpoint_path)
    if start:
        log.info("resuming from checkpoint b_start=%s", start)

    for sample_id, b_start in senaite.iter_all_sample_ids(
            batch_size=batch_size, start=start):
        if limit is not None and stats["seen"] >= limit:
            break
        stats["seen"] += 1

        if _SECONDARY_ID.search(sample_id):
            stats["skipped_secondary"] += 1
            time.sleep(sleep_s)  # bulk-scan safety: throttle even skip-only pages
            continue

        try:
            meta = senaite.fetch_parent_metadata(sample_id)  # fetch ONCE
            if not dry_run:
                db = db_factory()
                try:
                    row = db.execute(
                        select(LimsSample).where(LimsSample.sample_id == sample_id)
                    ).scalar_one_or_none()
                    if row is None:
                        row = _create_sample_row(db, sample_id, meta)
                        stats["created"] += 1
                    else:
                        _populate_basic_info(row, meta)
                        stats["updated"] += 1
                    if row.native_id is None:
                        row.native_id = mint_native_id(db, senaite_sample_id=sample_id)
                        stats["native_minted"] += 1
                    db.commit()
                finally:
                    db.close()
        except Exception as e:
            stats["errors"] += 1
            log.warning("backfill error sample=%s err=%s", sample_id, e, exc_info=True)

        if not dry_run:
            save_checkpoint(checkpoint_path, b_start, sample_id)
        time.sleep(sleep_s)  # bulk-scan safety: throttle EVERY sample

    if not dry_run and limit is None:
        db = db_factory()
        try:
            stats["counters_seeded"] = seed_native_id_counters(db)
            db.commit()
        finally:
            db.close()

    log.info("backfill done: %s", stats)
    if not dry_run:
        log.info("checkpoint retained at %s — delete it to re-scan from the start",
                 checkpoint_path)
    return stats


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Backfill lims_samples basic info from SENAITE "
                    "(throttled, resumable — see module docstring).",
        epilog="Exit codes: 0 = clean, 1 = completed with per-sample errors "
               "(see stats line). Checkpoint is retained after completion — "
               "delete it to re-scan from the start / retry errored samples.")
    ap.add_argument("--sleep", type=float, default=0.5,
                    help="seconds between per-sample fetches (bulk-scan safety; default 0.5)")
    ap.add_argument("--batch-size", type=int, default=50,
                    help="enumeration page size (default 50)")
    ap.add_argument("--checkpoint", default=DEFAULT_CHECKPOINT,
                    help=f"resume-cursor JSON path (default {DEFAULT_CHECKPOINT})")
    ap.add_argument("--dry-run", action="store_true",
                    help="enumerate + fetch but write nothing (no DB rows, no checkpoint)")
    ap.add_argument("--limit", type=int, default=None,
                    help="stop after N samples (smoke runs)")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    stats = backfill(SessionLocal, sleep_s=args.sleep, batch_size=args.batch_size,
                     checkpoint_path=args.checkpoint, dry_run=args.dry_run,
                     limit=args.limit)
    print(json.dumps(stats))  # coverage evidence line — retain (ISO 17025)
    return 1 if stats["errors"] else 0  # nonzero so unattended runs surface partial failure


if __name__ == "__main__":
    raise SystemExit(main())
