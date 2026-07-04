"""One-time backfill: populate lims_samples with COMPLETE basic info for every
SENAITE AnalysisRequest (2026-07-02-lims-sample-canonical-basic-info-design.md).

Run INSIDE the backend container so the app's modules and env are available:

    docker exec -w /app -i <backend-container> \
        python -m scripts.backfill_lims_sample_basic_info --sleep 0.5 --batch-size 50

Idempotent: re-running only fills gaps / refreshes; never duplicates. Resumable
via --checkpoint (JSON file holding the last page cursor). Use --dry-run for an
enumerate-only rehearsal and --limit N for a smoke run.

SENAITE BULK-SCAN SAFETY (load-bearing — do not "optimize" away): SENAITE runs
a single Zope core; an unthrottled jsonapi sweep over the full ~1,200+ AR set
has taken it down for ~15 minutes before. This script therefore pages in modest
batches, sleeps between EVERY per-sample fetch, runs strictly sequentially
(concurrency 1), and must be run off-hours.

The final stats line on stdout is the ISO 17025 coverage evidence (7.4.2 /
7.11.2) — retain it with the run record.
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
             "skipped_secondary": 0, "errors": 0}
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
                        _create_sample_row(db, sample_id, meta)
                        stats["created"] += 1
                    else:
                        _populate_basic_info(row, meta)
                        stats["updated"] += 1
                    db.commit()
                finally:
                    db.close()
        except Exception as e:
            stats["errors"] += 1
            log.warning("backfill error sample=%s err=%s", sample_id, e)

        save_checkpoint(checkpoint_path, b_start, sample_id)
        time.sleep(sleep_s)  # bulk-scan safety: throttle EVERY sample

    log.info("backfill done: %s", stats)
    return stats
