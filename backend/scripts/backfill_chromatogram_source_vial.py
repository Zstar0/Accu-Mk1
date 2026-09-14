#!/usr/bin/env python3
"""One-time backfill: stamp `lims_parent_attachments.source_sub_sample_pk` on
historical `kind='chromatogram'` rows that the push route wrote with NULL
lineage (P-2627, 2026-09-14 — vial 1's COA embedded vial 2's trace because
the only selection rule was "newest on the parent").

Resolution is from OUR OWN push filename only: `chromatogram_<label>.csv`
where `<label>` must EXACTLY equal an existing `lims_sub_samples.sample_id`
under the SAME parent. A bare parent label (`chromatogram_P-2627.csv`), a
vial of another parent, or any other name is left NULL and reported as
unresolved. `kind != 'chromatogram'` rows (manual uploads) are never
touched. Filename parsing lives ONLY here, as a migration aid — the live
push stamps the vial from the analysis' sample_id_label, never a filename.

Run (inside the backend container):

    python scripts/backfill_chromatogram_source_vial.py            # dry-run
    python scripts/backfill_chromatogram_source_vial.py --apply    # writes

Dry-run prints the per-row verdict and the stats line but writes nothing.
Idempotent: rows already carrying a source are `skipped`.
"""
import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import select  # noqa: E402

from models import LimsParentAttachment, LimsSubSample  # noqa: E402

_PUSH_FILENAME = re.compile(r"^chromatogram_(.+)\.csv$")


def backfill(db, *, apply: bool) -> dict:
    """Stamp resolvable rows; returns {"resolved", "unresolved", "skipped", "mode"}."""
    stats = {"resolved": 0, "unresolved": 0, "skipped": 0,
             "mode": "APPLY" if apply else "DRY-RUN"}
    rows = db.execute(
        select(LimsParentAttachment)
        .where(LimsParentAttachment.kind == "chromatogram")
        .order_by(LimsParentAttachment.id)
    ).scalars().all()
    for row in rows:
        if row.source_sub_sample_pk is not None:
            stats["skipped"] += 1
            continue
        m = _PUSH_FILENAME.match(row.filename or "")
        sub = None
        if m:
            sub = db.execute(
                select(LimsSubSample).where(
                    LimsSubSample.sample_id == m.group(1),
                    LimsSubSample.parent_sample_pk == row.lims_sample_pk,
                )
            ).scalar_one_or_none()
        if sub is None:
            stats["unresolved"] += 1
            print(f"  row {row.id} parent_pk={row.lims_sample_pk} {row.filename!r}: unresolved")
            continue
        stats["resolved"] += 1
        print(f"  row {row.id} parent_pk={row.lims_sample_pk} {row.filename!r}: "
              f"-> vial {sub.sample_id} (pk {sub.id})")
        if apply:
            row.source_sub_sample_pk = sub.id
    if apply:
        db.commit()
    return stats


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write (default: report only)")
    args = ap.parse_args()
    from database import SessionLocal
    db = SessionLocal()
    try:
        print(f"mode={'APPLY' if args.apply else 'dry-run'}")
        stats = backfill(db, apply=args.apply)
    finally:
        db.close()
    print(json.dumps(stats))
    return 0


if __name__ == "__main__":
    sys.exit(main())
