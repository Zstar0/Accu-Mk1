"""One-time backfill: mint native `lims_parent_attachments` chromatogram
rows for parents whose HPLCAnalysis already carries `chromatogram_data` but
never got pushed to SENAITE (so no `kind='chromatogram'` row exists yet) —
COA read-independence spec §6, Task 6, "Historical chromatogram CSV
coverage" gap.

Pure Mk1 data, no SENAITE call: `chromatogram_data` already lives on the
`hplc_analyses` row; the CSV is rebuilt with the exact SAME builder the live
push path uses (`backend/hplc_csv.py::build_chromatogram_csv`), so a
backfilled row's bytes are indistinguishable from a live push's. This is
NOT an R1 exemption like backfill_watermark_urls.py — it never touches
SENAITE at all.

APPLICATION-LEVEL JOIN (do not try to fold this into one SQL query): the
HPLC/prep world (`hplc_analyses.sample_prep_id` -> accumark_mk1's
`sample_preps` table) is reached through `mk1_db.get_mk1_db()`-style raw
access, not the main ORM session `lims_samples`/`lims_parent_attachments`
live in — see `sub_samples/routes.py::list_sub_sample_chromatograms` for
the same shape, read in reverse here (that route goes vial -> preps ->
analyses; this script goes analyses -> preps -> vial -> parent). Resolution
is two-tier per analysis:

  1. `sample_prep_id` -> `sample_preps.lims_sub_sample_pk` -> `LimsSubSample
     .parent_sample_pk` -> `LimsSample` (the vetted vial-tagged linkage).
  2. Fallback when (1) is unavailable (no prep, prep not vial-tagged, or a
     dangling prep id): `analysis.sample_id_label` matched directly against
     a `LimsSample.sample_id` (covers pre-vial-wizard analyses where the
     label IS the bare parent id).

Analyses that resolve to neither are counted under `unresolved_parent` and
skipped — never guessed at.

One row per PARENT (matching the read side, `coa/sample_meta.py::_newest`,
which only ever wants the newest `kind='chromatogram', storage='s3'` row
per parent): when several resolvable analyses belong to the same parent,
the highest-id (newest) one is used to build the CSV.

Run (inside the backend container; no SENAITE needed):

    python -m scripts.backfill_chromatogram_snapshots                # dry-run
    APPLY=1 python -m scripts.backfill_chromatogram_snapshots         # writes

Dry-run (default — no APPLY env var, or APPLY != "1") does the full
resolution + CSV-build pass (cheap, no external calls) and reports exactly
what an apply run would do, but calls neither the photo store nor the DB
write. Idempotent: a parent that already has an s3 chromatogram row is
skipped outright; APPLY mode also re-checks immediately before insert
(`race_skipped`) in case a live push landed one concurrently with this
script's run.

Per-row commits: each gap parent gets backfilled in its own short-lived
session/commit, so one parent's failure never rolls back another's write.

RECLASSIFY pass (UAT F-1, Ruling R-16), runs BEFORE the rebuild pass above:
historical chromatogram CSVs repatriated by the earlier §4 attachment sweep
landed in `lims_parent_attachments` as `kind='manual'` rows (filename
`chromatogram_*.csv`, content_type text/csv) — invisible to the kind-strict
native gate/producer, which select chromatograms by `kind='chromatogram'`
only. This pass finds `kind='manual' AND storage='s3'` rows matching
`filename LIKE 'chromatogram_%.csv'` OR (`content_type='text/csv'` AND
`attachment_type='HPLC Graph'`) and retags them `kind='chromatogram'`,
`attachment_type='HPLC Graph'`. Idempotent (a retagged row no longer
matches `kind='manual'`); dry-run counts only, APPLY retags with per-row
commits. Because it runs first, the rebuild pass's `already_covered` check
naturally skips parents satisfied by reclassification alone.

Stats line printed as JSON on completion (retain it as the run record):

    {"analyses_with_data": N, "unresolved_parent": N,
     "parents_with_chromatogram_data": N, "already_covered": N,
     "backfilled": N, "race_skipped": N, "errors": N, "reclassified": N,
     "mode": "APPLY"|"DRY-RUN"}

Exit code contract: 0 = clean run, no errors. 1 = run completed but one or
more parents (rebuild pass) or rows (reclassify pass) errored (see
"errors" in the stats line).
"""
import argparse
from collections import namedtuple
import json
import logging
import os
import sys
from typing import Optional

# Make the /app package root importable when run as a file (python -m from
# /app makes this a no-op).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import and_, or_, select

from database import SessionLocal
from hplc_csv import build_chromatogram_csv
from models import HPLCAnalysis, LimsParentAttachment, LimsSample, LimsSubSample

log = logging.getLogger("backfill_chromatogram_snapshots")


def _has_chromatogram_data(analysis) -> bool:
    chrom = analysis.chromatogram_data
    return bool(chrom and chrom.get("times") and chrom.get("signals"))


# Lightweight stand-in for a streamed HPLCAnalysis row: exactly the
# attributes resolve_parent_pk_for_analysis reads, plus the id the write
# loop re-fetches by. Keeps discovery memory flat at prod scale.
_CandidateRef = namedtuple("_CandidateRef", ("id", "sample_prep_id", "sample_id_label"))


def resolve_parent_pk_for_analysis(
    analysis,
    *,
    vial_pk_by_prep_id: dict,
    parent_pk_by_vial_pk: dict,
    parent_pk_by_sample_id: dict,
) -> Optional[int]:
    """Pure resolution (module docstring, tier 1 then tier 2) — dict-driven,
    zero DB/mk1_db calls inside, so it's unit-testable with plain fakes.
    `analysis` needs only `.sample_prep_id` and `.sample_id_label`."""
    prep_id = getattr(analysis, "sample_prep_id", None)
    if prep_id is not None:
        vial_pk = vial_pk_by_prep_id.get(prep_id)
        if vial_pk is not None:
            parent_pk = parent_pk_by_vial_pk.get(vial_pk)
            if parent_pk is not None:
                return parent_pk
    label = getattr(analysis, "sample_id_label", None)
    if label:
        return parent_pk_by_sample_id.get(label)
    return None


def _load_resolution_maps(db, candidates: list):
    """Bulk-load the dicts resolve_parent_pk_for_analysis needs, from BOTH
    databases: one mk1_db.list_sample_preps_by_ids call for the distinct
    sample_prep_ids referenced, then two main-db queries (LimsSubSample,
    LimsSample) keyed off what that returned plus every analysis's bare
    sample_id_label — no per-analysis round trips."""
    import mk1_db

    prep_ids = {a.sample_prep_id for a in candidates if a.sample_prep_id is not None}
    preps = mk1_db.list_sample_preps_by_ids(list(prep_ids))
    vial_pk_by_prep_id = {p["id"]: p.get("lims_sub_sample_pk") for p in preps}

    vial_pks = {v for v in vial_pk_by_prep_id.values() if v is not None}
    parent_pk_by_vial_pk = {}
    if vial_pks:
        subs = db.execute(
            select(LimsSubSample.id, LimsSubSample.parent_sample_pk)
            .where(LimsSubSample.id.in_(vial_pks))
        ).all()
        parent_pk_by_vial_pk = {s.id: s.parent_sample_pk for s in subs}

    labels = {a.sample_id_label for a in candidates if a.sample_id_label}
    parent_pk_by_sample_id = {}
    if labels:
        parents = db.execute(
            select(LimsSample.id, LimsSample.sample_id)
            .where(LimsSample.sample_id.in_(labels))
        ).all()
        parent_pk_by_sample_id = {p.sample_id: p.id for p in parents}

    return vial_pk_by_prep_id, parent_pk_by_vial_pk, parent_pk_by_sample_id


def reclassify_manual_chromatogram_rows(db_factory, *, apply: bool):
    """RECLASSIFY pass — UAT F-1 / Ruling R-16.

    Historical chromatogram CSVs repatriated by the earlier §4 attachment
    sweep landed in `lims_parent_attachments` as `kind='manual'` rows
    (filename `chromatogram_*.csv`, content_type text/csv) — invisible to
    the kind-strict native gate (`_parent_attachment_kinds_native`) and
    producer (`build_sample_meta`), which per ruling select chromatograms
    by `kind='chromatogram'` only.

    Finds `kind='manual' AND storage='s3'` rows where `filename LIKE
    'chromatogram_%.csv'` OR (`content_type='text/csv'` AND
    `attachment_type='HPLC Graph'`), and retags them `kind='chromatogram'`,
    `attachment_type='HPLC Graph'`.

    Runs BEFORE the rebuild pass so the rebuild pass's `already_covered`
    check naturally skips parents satisfied by reclassification: the
    matched rows' parent pks are returned too (not just the count), so a
    dry-run — which never writes — can still fold them into the rebuild
    pass's already_covered/backfilled accounting and keep the module's
    "dry-run reports exactly what an apply run would do" promise true.

    Idempotent: a retagged row's kind is now 'chromatogram', so it no
    longer matches the `kind='manual'` filter on any later run.

    Dry-run (apply=False) only counts matching rows — no writes. APPLY
    retags with per-row commits (mirrors the rebuild pass's per-parent
    commit isolation: one row's failure never blocks another's) and folds
    any per-row failure into the returned error count so the script's
    "exit 1 if any parent/row errored" contract holds for this pass too.

    Returns (reclassified_count, error_count, affected_parent_pks: set[int]).
    reclassified_count is rows matched in dry-run, rows actually retagged
    in apply (a row that raced to kind != 'manual' between the scan and the
    per-row write is not counted). affected_parent_pks is always the full
    matched set (dry-run: what WOULD be retagged; apply: what WAS retagged
    plus any that errored, since the rebuild pass should not re-attempt a
    parent this pass already claimed).
    """
    db = db_factory()
    try:
        rows = db.execute(
            select(LimsParentAttachment.id, LimsParentAttachment.lims_sample_pk)
            .where(
                LimsParentAttachment.kind == "manual",
                LimsParentAttachment.storage == "s3",
                or_(
                    # The '_' is a LITERAL underscore, not a LIKE
                    # single-character wildcard: unescaped, this also matched
                    # 'chromatograms.csv' / 'chromatogram-notes-2026.csv' and
                    # retagged them kind='chromatogram' with no reverse path,
                    # after which _newest() would mint the wrong CSV onto a
                    # certificate. Filenames are user-controlled (adopted
                    # verbatim from SENAITE's AttachmentFile).
                    LimsParentAttachment.filename.like(
                        r"chromatogram\_%.csv", escape="\\"),
                    and_(
                        LimsParentAttachment.content_type == "text/csv",
                        LimsParentAttachment.attachment_type == "HPLC Graph",
                    ),
                ),
            )
        ).all()
    finally:
        db.close()

    if not rows:
        return 0, 0, set()

    affected_pks = {r.lims_sample_pk for r in rows}

    if not apply:
        return len(rows), 0, affected_pks

    count = 0
    errors = 0
    for row_id, _parent_pk in rows:
        db = db_factory()
        try:
            row = db.get(LimsParentAttachment, row_id)
            if row is None or row.kind != "manual":
                continue
            row.kind = "chromatogram"
            row.attachment_type = "HPLC Graph"
            db.commit()
            count += 1
        except Exception as e:
            errors += 1
            log.warning("reclassify error attachment_id=%s err=%s",
                        row_id, e, exc_info=True)
        finally:
            db.close()
    return count, errors, affected_pks


def backfill(db_factory, *, apply: bool, limit=None) -> dict:
    stats = {
        "analyses_with_data": 0, "unresolved_parent": 0,
        "parents_with_chromatogram_data": 0, "already_covered": 0,
        "backfilled": 0, "race_skipped": 0, "errors": 0, "reclassified": 0,
    }

    reclassified, reclassify_errors, reclassified_parent_pks = \
        reclassify_manual_chromatogram_rows(db_factory, apply=apply)
    stats["reclassified"] = reclassified
    stats["errors"] += reclassify_errors

    db = db_factory()
    try:
        # Prod-scale memory guard (launch-night finding, 2026-08-30): the
        # original `.all()` materialised EVERY chromatogram JSON blob at
        # once (~4k rows on prod) and the process was SIGKILLed. Stream in
        # server-cursor batches and keep only a lightweight ref per
        # candidate — the blob is re-fetched per selected parent in the
        # write loop below. The `_has_chromatogram_data` check runs on the
        # streamed row, so candidacy semantics are byte-identical.
        candidates = []
        for a in db.execute(
            select(HPLCAnalysis)
            .where(HPLCAnalysis.chromatogram_data.is_not(None))
            .order_by(HPLCAnalysis.id)
            .execution_options(yield_per=200)
        ).scalars():
            if _has_chromatogram_data(a):
                candidates.append(_CandidateRef(
                    a.id, a.sample_prep_id, a.sample_id_label))
            db.expunge(a)
        stats["analyses_with_data"] = len(candidates)
        if not candidates:
            return stats

        vial_pk_by_prep_id, parent_pk_by_vial_pk, parent_pk_by_sample_id = \
            _load_resolution_maps(db, candidates)

        newest_by_parent_pk: dict[int, HPLCAnalysis] = {}
        for a in candidates:
            parent_pk = resolve_parent_pk_for_analysis(
                a, vial_pk_by_prep_id=vial_pk_by_prep_id,
                parent_pk_by_vial_pk=parent_pk_by_vial_pk,
                parent_pk_by_sample_id=parent_pk_by_sample_id,
            )
            if parent_pk is None:
                stats["unresolved_parent"] += 1
                continue
            current = newest_by_parent_pk.get(parent_pk)
            if current is None or a.id > current.id:
                newest_by_parent_pk[parent_pk] = a

        stats["parents_with_chromatogram_data"] = len(newest_by_parent_pk)
        if not newest_by_parent_pk:
            return stats

        parent_pks = list(newest_by_parent_pk)
        covered_pks = set(db.execute(
            select(LimsParentAttachment.lims_sample_pk)
            .where(LimsParentAttachment.kind == "chromatogram",
                   LimsParentAttachment.storage == "s3",
                   LimsParentAttachment.lims_sample_pk.in_(parent_pks))
        ).scalars().all())
        # Fold in parents the reclassify pass matched, scoped to this run's
        # candidate set. In APPLY this is already reflected by the query
        # above (the retag committed first); in DRY-RUN nothing was written,
        # so without this a parent satisfied purely by reclassification
        # would misreport as a rebuild-pass gap — breaking the "dry-run
        # reports exactly what an apply run would do" contract.
        covered_pks |= (reclassified_parent_pks & set(parent_pks))
        stats["already_covered"] = len(covered_pks)

        gap_pks = sorted(pk for pk in parent_pks if pk not in covered_pks)
        if limit is not None:
            gap_pks = gap_pks[:limit]

        parents_by_pk = {
            p.id: p for p in db.execute(
                select(LimsSample).where(LimsSample.id.in_(gap_pks))
            ).scalars().all()
        }
    finally:
        db.close()

    from sub_samples.photo_storage import get_storage

    for pk in gap_pks:
        parent = parents_by_pk.get(pk)
        ref = newest_by_parent_pk[pk]
        if parent is None:
            stats["errors"] += 1
            log.warning("backfill error parent_pk=%s err=parent-row-vanished", pk)
            continue
        try:
            # Re-fetch the full row (blob included) only for the parents
            # actually being rebuilt — the streamed discovery kept refs only.
            _ref_db = db_factory()
            try:
                analysis = _ref_db.get(HPLCAnalysis, ref.id)
                if analysis is None or not _has_chromatogram_data(analysis):
                    stats["errors"] += 1
                    log.warning(
                        "backfill error parent_pk=%s err=analysis-row-vanished id=%s",
                        pk, ref.id)
                    continue
                csv_bytes = build_chromatogram_csv(analysis)
                filename = f"chromatogram_{analysis.sample_id_label}.csv"[:255]
            finally:
                _ref_db.close()
            if apply:
                db = db_factory()
                try:
                    already = db.execute(
                        select(LimsParentAttachment.id).where(
                            LimsParentAttachment.lims_sample_pk == pk,
                            LimsParentAttachment.kind == "chromatogram",
                            LimsParentAttachment.storage == "s3",
                        ).limit(1)
                    ).scalar_one_or_none()
                    if already is not None:
                        # A live push landed one concurrently with this run.
                        stats["race_skipped"] += 1
                        continue
                    key = get_storage().save_photo(parent.sample_id, csv_bytes, filename)
                    db.add(LimsParentAttachment(
                        lims_sample_pk=pk, kind="chromatogram", filename=filename,
                        content_type="text/csv", storage="s3", storage_key=key,
                        render_in_report=False, attachment_type="HPLC Graph",
                    ))
                    db.commit()
                finally:
                    db.close()
            stats["backfilled"] += 1
        except Exception as e:
            stats["errors"] += 1
            log.warning("backfill error parent_pk=%s analysis_id=%s err=%s",
                        pk, analysis.id, e, exc_info=True)

    log.info("chromatogram backfill done: %s", stats)
    return stats


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Backfill lims_parent_attachments chromatogram rows from "
                    "HPLCAnalysis.chromatogram_data (pure Mk1 data — no SENAITE "
                    "call). Dry-run unless APPLY=1.",
        epilog="Exit codes: 0 = clean, 1 = completed with per-parent or "
               "per-row errors (see stats line).")
    ap.add_argument("--limit", type=int, default=None,
                    help="stop the REBUILD pass after N gap parents (smoke "
                         "runs); the reclassify pass is unbounded — it "
                         "always retags every matching manual row, since "
                         "the retag itself is the intended end state")
    args = ap.parse_args(argv)

    apply = os.environ.get("APPLY") == "1"
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    stats = backfill(SessionLocal, apply=apply, limit=args.limit)
    print(json.dumps({**stats, "mode": "APPLY" if apply else "DRY-RUN"}))
    return 1 if stats["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
