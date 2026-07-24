"""One-time backfill: sweep SENAITE's historical AR `Remarks` field into the
native `lims_sample_remarks` table (2026-07-14-parent-ar-read-flip spec §6).

The receive flow now writes remarks natively going forward (5b731d6) and the
lookup already serves this table in BOTH read modes (f4d3bcf / 7d1c935) — but
every remark left on an AR BEFORE that write flip only exists in SENAITE
until this script runs once.

Run INSIDE the backend container so the app's modules and env are available:

    docker exec -w /app -i <backend-container> \
        python -m scripts.backfill_lims_sample_remarks --sleep 0.5 --batch-size 200

DEPLOY ORDERING (spec §6): the write-flip deploys FIRST (remarks written
natively from that point on), THEN this backfill sweeps the pre-existing
SENAITE history. Re-run it (idempotent — see below) once, shortly after the
deploy window, to close any gap between those two events. Re-running LONG
after the flip is not the intended use: every registry row is visited (no
`external_lims_uid` gate — see MECHANISM) and a native-only sample created
post-flip has no SENAITE AR to fetch, so a stale re-run's "errors" count
will include these expected non-issues alongside real per-sample failures —
read the run's log lines (which name the failing sample_id), not just the
top-line count, before treating "errors" as a regression.

Idempotent: re-running only inserts rows not already present, keyed by the
dedup index `uq_lims_sample_remarks_dedup` on
(lims_sample_pk, created_at, md5(content)) via ON CONFLICT DO NOTHING. Use
--dry-run for a rehearsal that iterates the registry + fetches (throttled)
but writes nothing (no DB rows, no checkpoint) — it reports the same
insert/dup counts a real run would, using the dedup check's SELECT side
only. Use --limit N for a smoke run.

MECHANISM (registry-cursor, same shape as backfill_parent_analysis_shadows.py
— NOT SENAITE-side enumeration like backfill_lims_sample_basic_info.py): this
script iterates Mk1's OWN `lims_samples` registry table, ordered by id. Every
row the cursor visits is, by construction, already a registered parent
sample — there is no "no_registry_row" case to count (unlike a SENAITE-side
sweep, which would need to resolve a registry row on the way in), so that
stat key is deliberately absent from the JSON shape below. For each row,
exactly ONE throttled `fetch_parent_metadata` call retrieves the complete AR
detail (its `Remarks` list), and every remark on it is upserted in the same
per-sample transaction. A parent with no SENAITE-side history (e.g. a
native-only sample created after the flip, or one SENAITE genuinely has no
AR for) surfaces as an isolated per-sample error, not a hard stop — see
"errors" below.

SENAITE BULK-SCAN SAFETY (load-bearing — do not "optimize" away): SENAITE
runs a single Zope core; an unthrottled sweep over the full AR set has taken
it down for ~15 minutes before (feedback_senaite_bulk_scan_hazard). This
script therefore sleeps between EVERY per-sample fetch and runs strictly
sequentially (concurrency 1) — never in parallel; run off-hours.

Checkpoint retention: after ANY completed run (clean or with per-sample
errors) the checkpoint file remains at the id of the LAST PROCESSED
lims_samples row. Re-running with the same --checkpoint path resumes
strictly AFTER that row. To re-scan from the start — including retrying
samples that errored, since an errored sample still advances the checkpoint
— DELETE the checkpoint file first; re-scanning is safe because of the
dedup index.

Stats line printed as JSON on completion (retain it as the run record):

    {"fetched": N, "inserted": N, "dup": N, "skipped_malformed": N,
     "unparseable_created": N, "errors": N}

`fetched` = registry rows visited. `inserted`/`dup` mean "would insert" /
"already present" during --dry-run (SELECT-side only, nothing written) and
"actually inserted" / "hit the dedup conflict" on a real run.
`skipped_malformed` = individual Remarks entries that were not a dict or had
no `content` (the AR's OTHER remarks still get backfilled).
`unparseable_created` = entries whose `created` timestamp did not parse;
they are still inserted, keyed on the epoch sentinel (see
`_rows_for_sample`).

Exit code contract: 0 = clean run, no per-sample errors. 1 = run completed
but one or more samples errored (see the "errors" count in the stats line).
"""
import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime

# Make the /app package root importable when run as a file (python -m from
# /app makes this a no-op).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import DateTime, bindparam, select, text

from database import SessionLocal
from models import LimsSample
from sub_samples import senaite as sen

log = logging.getLogger("backfill_remarks")

DEFAULT_CHECKPOINT = "/tmp/backfill_lims_sample_remarks.checkpoint.json"

# `created` is bound with an explicit DateTime type so both statements go
# through SQLAlchemy's dialect-level bind processor for a Python datetime —
# this keeps the stored/compared representation identical to whatever the
# ORM's own DateTime column produces (sqlite in tests, native timestamps in
# prod Postgres), which matters because the dedup index compares created_at
# by exact value.
INSERT_SQL = text(
    "INSERT INTO lims_sample_remarks "
    "  (lims_sample_pk, content, author_label, created_at) "
    "VALUES (:pk, :content, :author_label, :created) "
    "ON CONFLICT DO NOTHING"
).bindparams(bindparam("created", type_=DateTime()))
# inserted-vs-dup: rowcount is 1 on insert, 0 on conflict (dedup index
# uq_lims_sample_remarks_dedup on (lims_sample_pk, created_at, md5(content))).

EXISTS_SQL = text(
    "SELECT 1 FROM lims_sample_remarks WHERE lims_sample_pk=:pk AND "
    "created_at=:created AND md5(content)=md5(:content)"
).bindparams(bindparam("created", type_=DateTime()))


def load_checkpoint(path: str) -> int:
    """Return the last-processed lims_samples.id to resume AFTER (0 = fresh run)."""
    try:
        with open(path) as f:
            return int(json.load(f).get("last_pk", 0))
    except (OSError, ValueError):
        return 0


def save_checkpoint(path: str, last_pk: int, last_sample_id: str) -> None:
    """Persist the registry cursor. Row-granular: resuming picks up strictly
    AFTER last_pk, never reprocessing it — safe regardless because the
    insert is idempotent anyway."""
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"last_pk": last_pk, "last_sample_id": last_sample_id}, f)
    os.replace(tmp, path)


def iter_registry_rows(db_factory, *, batch_size: int, start: int = 0):
    """Yield (id, sample_id) for every lims_samples row with id > start,
    ordered by id, paged so no single DB session is held open across the
    (throttled, potentially slow) per-sample SENAITE calls."""
    last_id = start
    while True:
        db = db_factory()
        try:
            rows = db.execute(
                select(LimsSample.id, LimsSample.sample_id)
                .where(LimsSample.id > last_id)
                .order_by(LimsSample.id)
                .limit(batch_size)
            ).all()
        finally:
            db.close()
        if not rows:
            return
        for row in rows:
            yield row.id, row.sample_id
        last_id = rows[-1].id


def _rows_for_sample(meta: dict, lims_sample_pk: int):
    """SENAITE Remarks list → insert-param dicts + stat deltas."""
    out, malformed, unparseable = [], 0, 0
    raw = meta.get("Remarks")
    if not isinstance(raw, list):
        return out, malformed, unparseable
    for r in raw:
        if not isinstance(r, dict) or not r.get("content"):
            malformed += 1
            continue
        created = r.get("created")
        try:
            created_dt = datetime.fromisoformat(created) if created else None
        except (TypeError, ValueError):
            created_dt = None
        if created_dt is None:
            # Deterministic dedup key for entries without a usable timestamp:
            # the epoch sentinel keeps (pk, created_at, md5) stable across
            # re-runs where NOW() would create duplicates.
            created_dt = datetime(1970, 1, 1)
            unparseable += 1
        out.append({
            "pk": lims_sample_pk,
            "content": r["content"],
            "author_label": (r.get("user_id") or None),
            "created": created_dt,
        })
    return out, malformed, unparseable


def backfill(db_factory, *, sleep_s: float, batch_size: int,
             checkpoint_path: str, dry_run: bool, limit) -> dict:
    """Iterate the lims_samples registry; for each PARENT fetch its SENAITE
    Remarks ONCE and upsert every entry (idempotent — see module docstring).
    One sample's failure never aborts the run. Returns coverage stats."""
    stats = {"fetched": 0, "inserted": 0, "dup": 0,
             "skipped_malformed": 0, "unparseable_created": 0, "errors": 0}
    start = load_checkpoint(checkpoint_path)
    if start:
        log.info("resuming from checkpoint last_pk=%s", start)

    for pk, sample_id in iter_registry_rows(
            db_factory, batch_size=batch_size, start=start):
        if limit is not None and stats["fetched"] >= limit:
            break
        stats["fetched"] += 1

        try:
            meta = sen.fetch_parent_metadata(sample_id)  # fetch ONCE
            rows, malformed, unparseable = _rows_for_sample(meta, pk)
            stats["skipped_malformed"] += malformed
            stats["unparseable_created"] += unparseable

            if rows:
                # Accumulate in LOCALS and fold into `stats` only after the
                # transaction actually lands (or, for --dry-run, only after
                # the read-only loop finishes clean) — same rule as
                # backfill_parent_analysis_shadows.py: if a later row in this
                # sample's batch raises, the whole per-sample transaction
                # rolls back, and counting eagerly would let the stats line
                # (the retained coverage evidence) overcount rows that never
                # landed.
                ins_here, dup_here = 0, 0
                db = db_factory()
                try:
                    for row in rows:
                        if dry_run:
                            exists = db.execute(EXISTS_SQL, row).scalar()
                            if exists:
                                dup_here += 1
                            else:
                                ins_here += 1
                        else:
                            result = db.execute(INSERT_SQL, row)
                            if result.rowcount:
                                ins_here += 1
                            else:
                                dup_here += 1
                    if not dry_run:
                        db.commit()
                finally:
                    db.close()
                stats["inserted"] += ins_here
                stats["dup"] += dup_here
        except Exception as e:
            stats["errors"] += 1
            log.warning("backfill error sample=%s err=%s", sample_id, e, exc_info=True)

        if not dry_run:
            save_checkpoint(checkpoint_path, pk, sample_id)
        time.sleep(sleep_s)  # bulk-scan safety: throttle EVERY sample

    log.info("backfill done: %s", stats)
    if not dry_run:
        log.info("checkpoint retained at %s — delete it to re-scan from the start "
                 "/ retry errored samples", checkpoint_path)
    return stats


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Backfill lims_sample_remarks from SENAITE AR Remarks "
                    "history (throttled, resumable — see module docstring).",
        epilog="Exit codes: 0 = clean, 1 = completed with per-sample errors "
               "(see stats line). Checkpoint is retained after completion — "
               "delete it to re-scan from the start / retry errored samples.")
    ap.add_argument("--sleep", type=float, default=0.5,
                    help="seconds between per-sample fetches (bulk-scan safety; default 0.5)")
    ap.add_argument("--batch-size", type=int, default=200,
                    help="lims_samples registry page size (default 200)")
    ap.add_argument("--checkpoint", default=DEFAULT_CHECKPOINT,
                    help=f"resume-cursor JSON path (default {DEFAULT_CHECKPOINT})")
    ap.add_argument("--dry-run", action="store_true",
                    help="iterate + fetch but write nothing (no DB rows, no checkpoint)")
    ap.add_argument("--limit", type=int, default=None,
                    help="stop after N samples (smoke runs)")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    stats = backfill(SessionLocal, sleep_s=args.sleep, batch_size=args.batch_size,
                     checkpoint_path=args.checkpoint, dry_run=args.dry_run,
                     limit=args.limit)
    print(json.dumps(stats))  # coverage evidence line — retain
    return 1 if stats["errors"] else 0  # nonzero so unattended runs surface partial failure


if __name__ == "__main__":
    raise SystemExit(main())
