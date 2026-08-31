"""Stamp SENAITE's AttachmentType onto historical lims_parent_attachments rows.

The L3 metadata sweep (backfill_lims_parent_attachments.py) ran before the
`attachment_type` column existed, so its rows carry attachment_type=NULL —
and the sample_meta image gate (coa/sample_meta.py `_newest`) can't see them:
eligibility is kind=='receive_image' OR attachment_type=='Sample Image', and
historical rows are kind='manual' by rule. Result (probed 2026-08-30): 2,089
of 3,073 parents refuse mk1-mode COA regeneration with "no native sample
image" even though 1,514 of them ALREADY hold the image bytes in native S3
(the §4 bytes sweep moved them).

This script closes that gap without moving a byte: for each
kind='manual' / attachment_type IS NULL / senaite_attachment_uid IS NOT NULL
row, fetch the Attachment detail from SENAITE (metadata only) and stamp the
true AttachmentType title ("Sample Image" / "HPLC Graph") onto the row. Rows
whose SENAITE detail carries no type are left NULL and counted (`no_type`) —
no guessing. kind stays 'manual' (historical provenance is unknown — the
gate's attachment_type arm exists precisely for these rows).

Run (inside the backend container):

    python -m scripts.backfill_attachment_type_stamp                 # dry-run
    python -m scripts.backfill_attachment_type_stamp --apply --limit 25
    python -m scripts.backfill_attachment_type_stamp --apply         # full

Dry-run reports the cohort census and end-to-end probes the first --probe
rows (fetches real SENAITE metadata, writes NOTHING). Apply commits per row,
is checkpointed (key: last_pk) and naturally resumable (stamped rows drop out
of the WHERE clause). Throttled between EVERY SENAITE call (bulk-scan
hazard); aborts after --max-consecutive-errors straight failures (SENAITE
down != 1,900 error rows). Companion runs to fully close the image gap:
re-run backfill_lims_parent_attachments.py (inserts rows for parents the L3
sweep never covered), then sweep_attachment_bytes_repatriation.py (moves the
new rows' bytes senaite->s3).
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

log = logging.getLogger("backfill_attachment_type_stamp")

DEFAULT_CHECKPOINT = "/tmp/attachment_type_stamp.checkpoint.json"


def _load_checkpoint(path: str) -> int:
    try:
        with open(path) as f:
            return int(json.load(f).get("last_pk", 0))
    except (OSError, ValueError, TypeError):
        return 0


def _save_checkpoint(path: str, last_pk: int) -> None:
    try:
        with open(path, "w") as f:
            json.dump({"last_pk": last_pk}, f)
    except OSError:
        log.warning("checkpoint write failed (path=%s) — run continues; "
                    "restart falls back to the WHERE-clause resume", path)


def extract_attachment_type(detail: dict) -> Optional[str]:
    """AttachmentType title from an Attachment detail payload — same
    string-or-{title|Title}-dict extraction as the L3 sweep's
    _rows_for_sample and the display path in main.py. Clamped to the
    column's VARCHAR(100). Returns None when the detail carries no type."""
    attachment_type = (
        detail.get("AttachmentType") or detail.get("getAttachmentType") or None
    )
    if isinstance(attachment_type, dict):
        attachment_type = (
            attachment_type.get("title") or attachment_type.get("Title") or None
        )
    if isinstance(attachment_type, str) and attachment_type.strip():
        return attachment_type[:100]
    return None


def run(*, apply: bool, limit: Optional[int], probe: int, throttle: float,
        checkpoint_path: str, max_consecutive_errors: int) -> int:
    from sqlalchemy import func, select
    from database import SessionLocal
    from models import LimsParentAttachment as A, LimsSample
    from sub_samples import senaite as sen

    db = SessionLocal()
    last_pk = _load_checkpoint(checkpoint_path) if apply else 0

    cohort_where = (
        A.kind == "manual",
        A.attachment_type.is_(None),
        A.senaite_attachment_uid.isnot(None),
    )

    census = db.execute(
        select(A.content_type, func.count())
        .where(*cohort_where).group_by(A.content_type)
    ).all()
    print("cohort census by content_type:",
          {str(ct): n for ct, n in sorted(census, key=lambda x: -x[1])})

    q = (select(A, LimsSample.sample_id)
         .join(LimsSample, A.lims_sample_pk == LimsSample.id)
         .where(*cohort_where, A.id > last_pk)
         .order_by(A.id))
    if limit:
        q = q.limit(limit)
    rows = db.execute(q).all()
    print(f"cohort: {len(rows)} rows (checkpoint last_pk={last_pk}) "
          f"| mode={'APPLY' if apply else 'DRY-RUN'}"
          + (f" | limit={limit}" if limit else ""))

    stats = {"stamped": 0, "probed": 0, "no_type": 0, "errors": 0}
    by_type: dict[str, int] = {}
    failures: list[tuple[int, str, str]] = []
    consecutive_errors = 0

    for att, sample_id in rows:
        if not apply and stats["probed"] >= probe:
            break
        try:
            detail = sen.fetch_attachment_meta(att.senaite_attachment_uid)
            att_type = extract_attachment_type(detail)
            if att_type is None:
                stats["no_type"] += 1
                log.info("no AttachmentType in SENAITE for id=%s sample=%s "
                         "uid=%s — left NULL", att.id, sample_id,
                         att.senaite_attachment_uid)
            elif not apply:
                stats["probed"] += 1
                by_type[att_type] = by_type.get(att_type, 0) + 1
                print(f"  probe id={att.id} {sample_id} {att.filename!r} "
                      f"({att.content_type}) -> would stamp {att_type!r}")
            else:
                db.refresh(att)
                if att.attachment_type is not None:
                    raise RuntimeError("row drifted since select — not stamped")
                att.attachment_type = att_type
                db.commit()
                stats["stamped"] += 1
                by_type[att_type] = by_type.get(att_type, 0) + 1
                _save_checkpoint(checkpoint_path, att.id)
                if stats["stamped"] % 100 == 0:
                    print(f"  progress: {stats['stamped']} stamped {by_type}",
                          flush=True)
            consecutive_errors = 0
        except Exception as e:
            db.rollback()
            stats["errors"] += 1
            consecutive_errors += 1
            failures.append((att.id, sample_id, f"{type(e).__name__}: {e}"))
            log.warning("stamp error id=%s sample=%s: %s", att.id, sample_id, e)
            if consecutive_errors >= max_consecutive_errors:
                print(f"ABORT: {consecutive_errors} consecutive errors — "
                      f"SENAITE trouble, not row trouble. Resume re-runs safely.")
                break
        time.sleep(throttle)

    db.close()
    print(f"stats: {stats} | by_type: {by_type}")
    if failures:
        print(f"failures (first 10): {failures[:10]}")
    return 1 if consecutive_errors >= max_consecutive_errors else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--apply", action="store_true",
                        help="write stamps (default: dry-run, no writes)")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--probe", type=int, default=8,
                        help="dry-run: rows to end-to-end probe (default 8)")
    parser.add_argument("--throttle", type=float, default=0.4,
                        help="seconds between SENAITE calls (default 0.4)")
    parser.add_argument("--checkpoint", default=DEFAULT_CHECKPOINT)
    parser.add_argument("--max-consecutive-errors", type=int, default=10)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    return run(apply=args.apply, limit=args.limit, probe=args.probe,
               throttle=args.throttle, checkpoint_path=args.checkpoint,
               max_consecutive_errors=args.max_consecutive_errors)


if __name__ == "__main__":
    sys.exit(main())
