"""Attachment BYTES repatriation sweep — SENAITE phase-out section 4.

The L3 sweep backfilled attachment METADATA only: 3,163 lims_parent_attachments
rows carry storage='senaite' with storage_key NULL — the bytes' ONLY copy is
SENAITE blobstorage, and every historical download proxies through
/wizard/senaite/attachment/{uid}. The day SENAITE is switched off those files
404, including files referenced by published COAs. This sweep moves the bytes:

    for each senaite-stored row:
        fetch the byte-stream from SENAITE (Attachment/{uid} meta -> download)
        push to the Mk1 photo store (same save_photo path as live captures)
        VERIFY the stored copy byte-length round-trip
        flip the row: storage_key=<rel_key>, storage='s3'   (guarded, per-row commit)

Run (inside the backend container; the script only uses deployed app APIs):

    python -m scripts.sweep_attachment_bytes_repatriation                # dry-run
    python -m scripts.sweep_attachment_bytes_repatriation --apply --limit 25
    python -m scripts.sweep_attachment_bytes_repatriation --apply       # full

Dry-run reports the cohort and end-to-end byte-probes the first --probe rows
(fetches real bytes, writes NOTHING) so the pipeline is proven before any
mutation. Apply is naturally resumable: flipped rows drop out of the WHERE
clause, and a JSON checkpoint (key: last_pk — the documented one; last_id is
the silent-rescan trap) accelerates restarts past already-scanned ids.
Throttled (SENAITE bulk-scan hazard); aborts after --max-consecutive-errors
straight failures (SENAITE down != 3,000 error rows). Frozen-snapshot rule
preserved: rows are only ever flipped senaite->s3, never re-pointed.
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

log = logging.getLogger("sweep_attachment_bytes")

DEFAULT_CHECKPOINT = "/tmp/attachment_bytes_sweep.checkpoint.json"


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
        log.warning("checkpoint write failed (path=%s) — sweep continues; "
                    "restart falls back to the WHERE-clause resume", path)


def fetch_attachment_bytes(uid: str) -> tuple[bytes, str, str]:
    """(bytes, filename, content_type) for a SENAITE attachment uid.

    Same two-step the /wizard/senaite/attachment/{uid} proxy does:
    Attachment/{uid} meta -> AttachmentFile.download -> bytes. Raises
    RuntimeError on any failure (caller counts + continues)."""
    from lims_analyses.senaite_writeback import SENAITE_BASE_URL, _get

    meta_resp = _get(f"{SENAITE_BASE_URL}/@@API/senaite/v1/Attachment/{uid}")
    if meta_resp.status_code >= 300:
        raise RuntimeError(f"meta http {meta_resp.status_code}")
    meta = meta_resp.json()
    if "items" in meta and meta["items"]:
        meta = meta["items"][0]
    att_file = meta.get("AttachmentFile") or {}
    download_url = att_file.get("download")
    if not download_url:
        raise RuntimeError("AttachmentFile.download missing")
    file_resp = _get(download_url)
    if file_resp.status_code >= 300:
        raise RuntimeError(f"download http {file_resp.status_code}")
    data = file_resp.content
    if not data:
        raise RuntimeError("zero-byte download")
    return (data,
            att_file.get("filename") or "attachment",
            att_file.get("content_type") or "application/octet-stream")


def run(*, apply: bool, limit: Optional[int], probe: int, throttle: float,
        checkpoint_path: str, max_consecutive_errors: int) -> int:
    from sqlalchemy import select
    from database import SessionLocal
    from models import LimsParentAttachment, LimsSample
    from sub_samples.photo_storage import get_storage

    db = SessionLocal()
    last_pk = _load_checkpoint(checkpoint_path) if apply else 0

    q = (select(LimsParentAttachment, LimsSample.sample_id)
         .join(LimsSample, LimsParentAttachment.lims_sample_pk == LimsSample.id)
         .where(LimsParentAttachment.storage == "senaite",
                LimsParentAttachment.storage_key.is_(None),
                LimsParentAttachment.id > last_pk)
         .order_by(LimsParentAttachment.id))
    if limit:
        q = q.limit(limit)
    rows = db.execute(q).all()

    no_uid = [(a.id, sid) for a, sid in rows if not a.senaite_attachment_uid]
    print(f"cohort: {len(rows)} senaite-stored rows (checkpoint last_pk={last_pk}) "
          f"| mode={'APPLY' if apply else 'DRY-RUN'}"
          + (f" | limit={limit}" if limit else ""))
    if no_uid:
        print(f"  WARNING: {len(no_uid)} rows have NO senaite_attachment_uid "
              f"(unfetchable, will error): {no_uid[:10]}")

    stats = {"moved": 0, "probed": 0, "errors": 0, "bytes_moved": 0}
    failures: list[tuple[int, str, str]] = []
    consecutive_errors = 0
    storage = get_storage()

    for att, sample_id in rows:
        if not apply and stats["probed"] >= probe:
            break
        try:
            if not att.senaite_attachment_uid:
                raise RuntimeError("row has no senaite_attachment_uid")
            data, sen_filename, sen_ct = fetch_attachment_bytes(
                att.senaite_attachment_uid)
            if not apply:
                stats["probed"] += 1
                stats["bytes_moved"] += len(data)
                print(f"  probe id={att.id} {sample_id} {att.filename!r}: "
                      f"{len(data)} bytes ({sen_ct}; senaite name {sen_filename!r})")
            else:
                rel_key = storage.save_photo(sample_id, data, att.filename)
                stored = storage.fetch_photo(rel_key)      # round-trip verify
                if len(stored) != len(data):
                    raise RuntimeError(
                        f"verify mismatch: stored {len(stored)} != fetched {len(data)}")
                db.refresh(att)
                if att.storage != "senaite" or att.storage_key is not None:
                    raise RuntimeError("row drifted since select — not flipped")
                att.storage_key = rel_key
                att.storage = "s3"
                db.commit()
                stats["moved"] += 1
                stats["bytes_moved"] += len(data)
                _save_checkpoint(checkpoint_path, att.id)
                if stats["moved"] % 100 == 0:
                    print(f"  progress: {stats['moved']} moved, "
                          f"{stats['bytes_moved'] / 1e6:.1f} MB", flush=True)
            consecutive_errors = 0
        except Exception as e:
            db.rollback()
            stats["errors"] += 1
            consecutive_errors += 1
            failures.append((att.id, sample_id, f"{type(e).__name__}: {e}"))
            log.warning("sweep error id=%s sample=%s: %s", att.id, sample_id, e)
            if consecutive_errors >= max_consecutive_errors:
                print(f"ABORT: {consecutive_errors} consecutive errors — "
                      f"SENAITE/S3 trouble, not row trouble. Resume re-runs safely.")
                break
        time.sleep(throttle)

    db.close()
    print(f"stats: {stats} ({stats['bytes_moved'] / 1e6:.1f} MB)")
    if not apply and stats["probed"]:
        avg = stats["bytes_moved"] / stats["probed"]
        print(f"  projected full volume: ~{avg * len(rows) / 1e6:.0f} MB "
              f"across {len(rows)} rows (probe avg {avg / 1e3:.0f} KB)")
    if failures:
        print(f"failures ({len(failures)}):")
        for pk, sid, why in failures[:50]:
            print(f"  id={pk} {sid}: {why}")
    return 1 if failures else 0


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        description="Move senaite-stored parent-attachment BYTES to the Mk1 "
                    "photo store and flip the rows (phase-out section 4). "
                    "Dry-run by default.")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--limit", type=int, help="cap rows this run (staged apply)")
    ap.add_argument("--probe", type=int, default=5,
                    help="dry-run: end-to-end byte-probe this many rows (default 5)")
    ap.add_argument("--throttle", type=float, default=0.3,
                    help="seconds between SENAITE fetches (default 0.3)")
    ap.add_argument("--checkpoint", default=DEFAULT_CHECKPOINT,
                    help=f"JSON checkpoint path (default {DEFAULT_CHECKPOINT}; "
                         "key is last_pk)")
    ap.add_argument("--max-consecutive-errors", type=int, default=10)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    return run(apply=args.apply, limit=args.limit, probe=args.probe,
               throttle=args.throttle, checkpoint_path=args.checkpoint,
               max_consecutive_errors=args.max_consecutive_errors)


if __name__ == "__main__":
    sys.exit(main())
