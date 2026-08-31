"""One-time backfill: populate `ChromatographBackgroundUrl` into
lims_samples.coa_meta from SENAITE (COA read-independence spec §6, Task 6).

`ChromatographBackgroundUrl` joined the `_COA_META_FIELDS` capture set
(sub_samples/service.py) in this same change, so every FUTURE registration
and field-edit mirror captures it going forward. This script closes the gap
for samples that already had a lims_samples row BEFORE that capture went
live — their coa_meta was written by the old (narrower) field set and never
picked the key up.

R1 EXEMPTION (read this before treating this as a template for other
scripts): the COA read-independence design's R1 rule forbids RUNTIME reads
of SENAITE once the read-flip is live — envelope assembly must be pure Mk1
data. This script is explicitly NOT a runtime read: it is a WRITE-WINDOW,
one-time, human-run data-population pass that runs BEFORE the flip (or in a
deploy maintenance window), same category as backfill_lims_sample_basic_info.py
and backfill_lims_parent_attachments.py. Once this script's coverage is
adequate, `coa_meta` carries the value natively and nothing at request time
ever calls SENAITE for it again. Do not adapt this pattern into a
runtime/request-path code path — that would violate R1.

Run INSIDE the backend container so the app's modules and env are available:

    docker exec -w /app -i <backend-container> \\
        python -m scripts.backfill_watermark_urls                 # dry-run
    docker exec -w /app -i <backend-container> \\
        env APPLY=1 python -m scripts.backfill_watermark_urls      # writes

Dry-run (default — no APPLY env var, or APPLY != "1") enumerates the
candidate cohort and fetches each candidate's AR metadata from SENAITE
(so the reported counts are real, not guesses) but writes NOTHING to the
database. Set APPLY=1 to commit.

Idempotent: re-running only touches rows still missing (or still holding a
falsy) ChromatographBackgroundUrl — see `_needs_watermark_backfill`. Prod
watermark-key coverage was verified ZERO at spec time (no coa_meta row
carries this key), so a first run is expected to report `empty_from_senaite`
for the whole cohort — that is NOT a bug, it means SENAITE's AR objects
don't expose the field yet either. The script is safe (and cheap) to
re-run periodically once SENAITE-side coverage improves.

SENAITE BULK-SCAN SAFETY: strictly sequential (concurrency 1), throttled
between EVERY per-sample fetch (default 0.25s — see module docstring
convention in backfill_lims_sample_basic_info.py); run off-hours for a
full-cohort pass.

Stats line printed as JSON on completion (retain it as the run record):

    {"candidates": N, "updated": N, "empty_from_senaite": N, "errors": N,
     "mode": "APPLY"|"DRY-RUN"}

`candidates` = lims_samples rows selected by the cohort predicate.
`updated` = rows where SENAITE returned a non-empty ChromatographBackgroundUrl
(actually written to coa_meta in APPLY mode; would-be in dry-run — the fetch
still happens either way, so this count is trustworthy pre-flight evidence).
`empty_from_senaite` = fetched successfully but the AR carries no (or a
falsy) ChromatographBackgroundUrl — nothing to write. `errors` = the
per-sample SENAITE fetch raised (network/SENAITE trouble); logged, never
aborts the run.

Exit code contract: 0 = clean run, no per-sample errors. 1 = run completed
but one or more samples errored (see the "errors" count in the stats line).
"""
import argparse
import json
import logging
import os
import sys
import time

# Make the /app package root importable when run as a file (python -m from
# /app makes this a no-op).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import select

from database import SessionLocal
from models import LimsSample
from sub_samples import senaite
from sub_samples.service import _COA_META_FIELDS

log = logging.getLogger("backfill_watermark_urls")

WATERMARK_KEY = "ChromatographBackgroundUrl"


def _needs_watermark_backfill(row) -> bool:
    """True when `row.coa_meta` is missing WATERMARK_KEY or carries a
    falsy value for it — the backfill cohort predicate. Pure function
    (only touches `row.coa_meta`) so it's unit-testable with a bare fake
    carrying just that attribute — no DB or SENAITE needed."""
    try:
        meta = json.loads(row.coa_meta) if row.coa_meta else {}
    except (ValueError, TypeError):
        meta = {}
    if not isinstance(meta, dict):
        return True
    return not meta.get(WATERMARK_KEY)


def load_candidates(db_factory) -> list[tuple[int, str]]:
    """One read-only pass: (lims_samples.id, sample_id) for every row with
    external_lims_uid set (has a live SENAITE counterpart to fetch from)
    AND `_needs_watermark_backfill`. The write loop re-fetches each row
    fresh in its own commit-scoped session (per-row-session shape, same as
    backfill_lims_sample_basic_info.py) — this pass never holds a session
    open across the throttled SENAITE calls that follow."""
    db = db_factory()
    try:
        rows = db.execute(
            select(LimsSample)
            .where(LimsSample.external_lims_uid.is_not(None))
            .order_by(LimsSample.id)
        ).scalars().all()
        return [(r.id, r.sample_id) for r in rows if _needs_watermark_backfill(r)]
    finally:
        db.close()


def backfill(db_factory, *, sleep_s: float, apply: bool, limit=None) -> dict:
    """For each candidate, ONE throttled `fetch_parent_metadata` call; a
    non-empty ChromatographBackgroundUrl gets merged into coa_meta (APPLY
    mode) or counted as a would-update (dry-run — the SENAITE fetch still
    happens, so the count is real). One sample's failure never aborts the
    run. Returns coverage stats (see module docstring)."""
    stats = {"candidates": 0, "updated": 0, "empty_from_senaite": 0, "errors": 0}
    candidates = load_candidates(db_factory)
    if limit is not None:
        candidates = candidates[:limit]
    stats["candidates"] = len(candidates)

    for pk, sample_id in candidates:
        try:
            meta = senaite.fetch_parent_metadata(sample_id)
            value = meta.get(WATERMARK_KEY)
            if value:
                if apply:
                    db = db_factory()
                    try:
                        row = db.execute(
                            select(LimsSample).where(LimsSample.id == pk)
                        ).scalar_one_or_none()
                        if row is not None:
                            cm = (json.loads(row.coa_meta) if row.coa_meta
                                  else {k: None for k in _COA_META_FIELDS})
                            if not isinstance(cm, dict):
                                cm = {k: None for k in _COA_META_FIELDS}
                            cm[WATERMARK_KEY] = value
                            row.coa_meta = json.dumps(cm)
                            db.commit()
                    finally:
                        db.close()
                stats["updated"] += 1
            else:
                stats["empty_from_senaite"] += 1
        except Exception as e:
            stats["errors"] += 1
            log.warning("watermark backfill error sample=%s err=%s",
                        sample_id, e, exc_info=True)
        time.sleep(sleep_s)

    log.info("watermark backfill done: %s", stats)
    return stats


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Backfill lims_samples.coa_meta ChromatographBackgroundUrl "
                    "from SENAITE (write-window one-time script — see module "
                    "docstring's R1 EXEMPTION note). Dry-run unless APPLY=1.",
        epilog="Exit codes: 0 = clean, 1 = completed with per-sample errors "
               "(see stats line).")
    ap.add_argument("--sleep", type=float, default=0.25,
                    help="seconds between per-sample SENAITE fetches (default 0.25)")
    ap.add_argument("--limit", type=int, default=None,
                    help="stop after N candidates (smoke runs)")
    args = ap.parse_args(argv)

    apply = os.environ.get("APPLY") == "1"
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    stats = backfill(SessionLocal, sleep_s=args.sleep, apply=apply, limit=args.limit)
    print(json.dumps({**stats, "mode": "APPLY" if apply else "DRY-RUN"}))
    return 1 if stats["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
