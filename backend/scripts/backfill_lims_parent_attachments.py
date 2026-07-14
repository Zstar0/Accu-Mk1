"""One-time backfill: sweep SENAITE's historical AR `Attachment` lists into
the native `lims_parent_attachments` table (2026-07-14-parent-ar-read-flip
spec §7).

Capture-time rows (upload endpoint, Tasks 2-3) already write natively going
forward, but everything attached to an AR BEFORE that write went live only
exists in SENAITE. This script sweeps that history AND adopts any uid-less
capture-time row it finds matching `(lims_sample_pk, filename)` — see
ADOPTION below.

Run INSIDE the backend container so the app's modules and env are available:

    docker exec -w /app -i <backend-container> \
        python -m scripts.backfill_lims_parent_attachments --sleep 0.5 --batch-size 200

DEPLOY ORDERING: same as backfill_lims_sample_remarks.py — the write-flip
(native capture) deploys FIRST, THEN this backfill sweeps pre-existing
SENAITE history, then again shortly after to close the gap. A stale re-run
long after the flip still works (idempotent) but its "errors" count may
include native-only samples with no SENAITE AR — read the log lines, not
just the top-line count.

Idempotent: re-running only inserts uids not already present, keyed by the
PARTIAL unique index `uq_lims_parent_attachments_uid` on
(senaite_attachment_uid) WHERE senaite_attachment_uid IS NOT NULL, via
`ON CONFLICT (senaite_attachment_uid) WHERE senaite_attachment_uid IS NOT
NULL DO NOTHING`. Use --dry-run for a rehearsal that iterates the registry +
fetches (throttled) but writes nothing (no DB rows, no UPDATEs, no
checkpoint) — it reports the same insert/dup/adopted counts a real run
would, using the SELECT side of each check only. Use --limit N for a smoke
run.

MECHANISM (registry-cursor, same shape as backfill_lims_sample_remarks.py):
this script iterates Mk1's OWN `lims_samples` registry table, ordered by id.
For each row, ONE throttled `fetch_parent_metadata` call retrieves the AR
detail (its `Attachment` list of refs); each ref then needs its OWN
throttled `fetch_attachment_meta(uid)` call to resolve the object's
`AttachmentFile` sub-object (filename/content_type) plus `RenderInReport`
and `created` — a two-step fetch per attachment, unlike the remarks sweep's
one-step-per-sample. A malformed ref (not a dict, no uid) or a failed
per-ref detail fetch is skipped and counted (`skipped_malformed`) — it never
aborts the sample; a sample-level failure (e.g. `fetch_parent_metadata`
itself raising) is the only thing counted under `errors`.

ADOPTION (the one novel mechanic here, vs. the remarks sweep): a capture-time
row (Tasks 2-3's upload endpoint) has no SENAITE attachment uid — the Plone
form upload response doesn't return one. Before inserting a swept
attachment, if a native row already exists for this sample with
`senaite_attachment_uid IS NULL` and the same `filename`, that row's uid is
UPDATED in place instead of inserting a duplicate (counted under `adopted`,
never under `inserted`). Every other column on that row (storage,
storage_key, kind, render_in_report, created_at — the capture-time truth) is
left untouched; adoption only closes the "which SENAITE object is this"
gap. Only the FIRST matching uid-less row (lowest id) is adopted if more
than one exists for the same (sample, filename).

Row shape for a genuinely new (non-adopted) insert: storage='senaite',
storage_key=NULL, senaite_attachment_uid=<uid>, filename/content_type from
the attachment detail's `AttachmentFile`, render_in_report from the
detail's `RenderInReport` when present (truthy) else False, kind='manual'
(historical provenance is unknown — capture-time kinds like 'vial_image' /
'receive_image' don't apply retroactively), created_at parsed from the
detail's `created` when parseable else the epoch sentinel `datetime(1970,
1, 1)` (counted under `unparseable_created`, same convention as the remarks
sweep).

SENAITE BULK-SCAN SAFETY (load-bearing — do not "optimize" away): strictly
sequential (concurrency 1), throttled between EVERY SENAITE call — both the
per-sample `fetch_parent_metadata` and each per-attachment
`fetch_attachment_meta` — never in parallel; run off-hours.

Checkpoint retention / re-scan contract: identical to
backfill_lims_sample_remarks.py — delete the checkpoint file to re-scan from
the start (including retrying errored samples); safe because every write
here is idempotent.

Stats line printed as JSON on completion (retain it as the run record):

    {"fetched": N, "attachments_seen": N, "inserted": N, "dup": N,
     "adopted": N, "skipped_malformed": N, "unparseable_created": N,
     "errors": N}

`fetched` = registry rows visited. `attachments_seen` = total `Attachment`
list entries encountered across all visited samples, well-formed or not
(invariant: attachments_seen == inserted + dup + adopted + skipped_malformed
on a real run; --dry-run's inserted/dup/adopted are would-be counts, so the
same invariant holds there too). `inserted`/`dup`/`adopted` mean "would
insert" / "already present" / "would adopt" during --dry-run (SELECT-side
only, nothing written) and the real outcome on a real run.
`skipped_malformed` = individual Attachment refs that were not a dict, had
no uid, or whose detail fetch failed/returned no usable filename (the AR's
OTHER attachments still get backfilled). `unparseable_created` = entries
whose `created` timestamp did not parse; they are still inserted/adopted,
keyed on the epoch sentinel (see `_rows_for_sample`).

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

from sqlalchemy import Boolean, DateTime, bindparam, select, text

from database import SessionLocal
from models import LimsSample
from sub_samples import senaite as sen

log = logging.getLogger("backfill_parent_attachments")

DEFAULT_CHECKPOINT = "/tmp/backfill_lims_parent_attachments.checkpoint.json"

# Explicit DateTime/Boolean bind types so both statements go through
# SQLAlchemy's dialect-level bind processor for these Python values — same
# rationale as backfill_lims_sample_remarks.py's INSERT_SQL: keeps the
# stored/compared representation identical to whatever the ORM's own columns
# produce (sqlite in tests, native types in prod Postgres).
INSERT_SQL = text(
    "INSERT INTO lims_parent_attachments "
    "  (lims_sample_pk, kind, filename, content_type, storage, storage_key, "
    "   senaite_attachment_uid, render_in_report, created_at) "
    "VALUES (:pk, 'manual', :filename, :content_type, 'senaite', NULL, "
    "   :uid, :render_in_report, :created) "
    "ON CONFLICT (senaite_attachment_uid) WHERE senaite_attachment_uid IS NOT NULL "
    "DO NOTHING"
).bindparams(bindparam("created", type_=DateTime()), bindparam("render_in_report", type_=Boolean()))
# inserted-vs-dup: rowcount is 1 on insert, 0 on conflict. The conflict
# target is given EXPLICITLY with the matching partial predicate — a bare,
# target-less `ON CONFLICT DO NOTHING` is not guaranteed to consult a
# PARTIAL unique index the same way across engines (this index is partial,
# unlike the remarks sweep's full dedup index), so the target is pinned here
# rather than relying on inference.

EXISTS_UID_SQL = text(
    "SELECT 1 FROM lims_parent_attachments WHERE senaite_attachment_uid=:uid"
)

# Adoption: find the (lowest-id) uid-less capture-time row for this
# (sample, filename), if any. Used both to decide adopt-vs-insert and, on a
# real run, to target the UPDATE by id (never a bare
# WHERE-sample-AND-filename UPDATE, which could touch more than one row if
# duplicate filenames were ever captured for the same sample).
ADOPT_CANDIDATE_SQL = text(
    "SELECT id FROM lims_parent_attachments "
    "WHERE lims_sample_pk=:pk AND filename=:filename AND senaite_attachment_uid IS NULL "
    "ORDER BY id LIMIT 1"
)
ADOPT_UPDATE_SQL = text(
    "UPDATE lims_parent_attachments SET senaite_attachment_uid=:uid WHERE id=:id"
)
# Adoption touches ONLY the uid column — every other field (storage,
# storage_key, kind, render_in_report, created_at) is the capture-time
# truth and is left exactly as it was.


def load_checkpoint(path: str) -> int:
    """Return the last-processed lims_samples.id to resume AFTER (0 = fresh run)."""
    try:
        with open(path) as f:
            return int(json.load(f).get("last_pk", 0))
    except (OSError, ValueError):
        return 0


def save_checkpoint(path: str, last_pk: int, last_sample_id: str) -> None:
    """Persist the registry cursor. Row-granular: resuming picks up strictly
    AFTER last_pk, never reprocessing it — safe regardless because every
    write here is idempotent anyway."""
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


def _rows_for_sample(meta: dict, lims_sample_pk: int, *, sleep_s: float):
    """SENAITE Attachment list → per-ref detail fetch → insert/adopt param
    dicts + stat deltas. Strictly sequential: sleeps after EVERY per-ref
    `fetch_attachment_meta` call (bulk-scan safety). A malformed ref (not a
    dict, no uid, no usable filename in the detail) or a raised detail-fetch
    error is skipped and counted — it never aborts the sample."""
    out, malformed, unparseable = [], 0, 0
    seen = 0
    raw = meta.get("Attachment")
    if not isinstance(raw, list):
        return out, seen, malformed, unparseable

    for ref in raw:
        seen += 1
        uid = ref.get("uid") if isinstance(ref, dict) else None
        if not uid:
            malformed += 1
            continue

        try:
            detail = sen.fetch_attachment_meta(uid)
        except Exception as e:
            malformed += 1
            log.warning("attachment detail fetch failed uid=%s err=%s", uid, e)
            continue
        finally:
            time.sleep(sleep_s)  # bulk-scan safety: throttle EVERY fetch

        att_file = detail.get("AttachmentFile")
        filename = att_file.get("filename") if isinstance(att_file, dict) else None
        if not filename:
            malformed += 1
            continue
        content_type = att_file.get("content_type")

        render_flag = detail.get("RenderInReport")
        render_in_report = bool(render_flag) if render_flag is not None else False

        created = detail.get("created")
        try:
            created_dt = datetime.fromisoformat(created) if created else None
        except (TypeError, ValueError):
            created_dt = None
        if created_dt is None:
            # Deterministic sentinel, same convention as the remarks sweep:
            # keeps the row insertable/adoptable without a real timestamp.
            created_dt = datetime(1970, 1, 1)
            unparseable += 1

        out.append({
            "pk": lims_sample_pk,
            "uid": uid,
            "filename": filename,
            "content_type": content_type,
            "render_in_report": render_in_report,
            "created": created_dt,
        })
    return out, seen, malformed, unparseable


def backfill(db_factory, *, sleep_s: float, batch_size: int,
             checkpoint_path: str, dry_run: bool, limit) -> dict:
    """Iterate the lims_samples registry; for each PARENT fetch its SENAITE
    Attachment list ONCE and, for every ref, adopt-or-insert a native row
    (idempotent — see module docstring). One sample's failure never aborts
    the run. Returns coverage stats."""
    stats = {"fetched": 0, "attachments_seen": 0, "inserted": 0, "dup": 0,
             "adopted": 0, "skipped_malformed": 0, "unparseable_created": 0,
             "errors": 0}
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
            rows, seen, malformed, unparseable = _rows_for_sample(
                meta, pk, sleep_s=sleep_s)
            stats["attachments_seen"] += seen
            stats["skipped_malformed"] += malformed
            stats["unparseable_created"] += unparseable

            if rows:
                # Accumulate in LOCALS and fold into `stats` only after the
                # transaction actually lands (or, for --dry-run, only after
                # the read-only loop finishes clean) — same rule as
                # backfill_lims_sample_remarks.py: if a later row in this
                # sample's batch raises, the whole per-sample transaction
                # rolls back, and counting eagerly would let the stats line
                # (the retained coverage evidence) overcount rows that never
                # landed. Adoption UPDATEs and fresh INSERTs for this sample
                # share the SAME session/transaction, so they land or roll
                # back together.
                ins_here, dup_here, adopted_here = 0, 0, 0
                db = db_factory()
                try:
                    for row in rows:
                        candidate_id = db.execute(ADOPT_CANDIDATE_SQL, {
                            "pk": row["pk"], "filename": row["filename"],
                        }).scalar()
                        if candidate_id:
                            if not dry_run:
                                db.execute(ADOPT_UPDATE_SQL, {
                                    "uid": row["uid"], "id": candidate_id,
                                })
                            adopted_here += 1
                            continue  # adopted, never also inserted

                        if dry_run:
                            exists = db.execute(
                                EXISTS_UID_SQL, {"uid": row["uid"]}).scalar()
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
                stats["adopted"] += adopted_here
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
        description="Backfill lims_parent_attachments from SENAITE AR "
                    "Attachment history, with uid adoption for capture-time "
                    "rows (throttled, resumable — see module docstring).",
        epilog="Exit codes: 0 = clean, 1 = completed with per-sample errors "
               "(see stats line). Checkpoint is retained after completion — "
               "delete it to re-scan from the start / retry errored samples.")
    ap.add_argument("--sleep", type=float, default=0.5,
                    help="seconds between SENAITE fetches (bulk-scan safety; default 0.5)")
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
