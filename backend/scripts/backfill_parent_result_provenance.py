#!/usr/bin/env python3
"""One-off, audited backfill: give EXISTING parent analysis rows the capture
time (and optionally the analyst) of the vial result they were promoted from.

Why (2026-09-21): until slice 24, promote minted the parent row with no
captured_at and with analyst_user_id = whoever clicked Promote. Prod on that
date: 0 of 10,662 canonical parent rows had a captured_at. Slice 24 carries
both over at every promote from now on; this script catches up the rows that
already exist. The values are DERIVED, never guessed: they come off the
promotion's own source rows through service._carried_result_provenance, the
same function promote uses, so old rows and new rows follow one rule.

What it writes:
  * captured_at, only where it is NULL (purely additive).
  * with --with-analyst (NEEDS SIGN-OFF): analyst_user_id and
    processed_by_user_id, and ONLY on a row whose analyst is still the old
    default (NULL, or equal to created_by_user_id = the promoter). A value
    someone set on purpose is never overwritten.

What it leaves alone, and reports: a parent row with no promotion record, or
whose source rows carry no capture time either (nothing to derive from).

Scope: NATIVE services only by default (analysis_services.origin = 'mk1').
--include-legacy widens it to SENAITE-origin services and needs its own
sign-off. No state, result, unit, method or instrument is touched. Every row
written gets a same-state 'auto' audit transition naming this script.

Dry-run by default. Idempotent. One short transaction per sample.

Run (from backend/):
    python scripts/backfill_parent_result_provenance.py                 # report only
    python scripts/backfill_parent_result_provenance.py --sample-id P-5010 --verbose
    python scripts/backfill_parent_result_provenance.py --apply
Prod (stdin form, per the data-fix runbook):
    docker exec -w /app -i accu-mk1-backend python - --apply < scripts/backfill_parent_result_provenance.py
"""
import argparse
import os
import sys
from collections import Counter
from typing import Optional

# Piped over stdin there is no __file__; /app is already importable then.
if "__file__" in globals():
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

SCRIPT = "scripts/backfill_parent_result_provenance.py"


def backfill(db, *, apply: bool = False, with_analyst: bool = False,
             include_legacy: bool = False, sample_ids: Optional[list] = None,
             limit: Optional[int] = None, verbose: bool = False, out=print) -> dict:
    """Core, importable for tests. Returns the report dict."""
    from sqlalchemy import or_, select

    from lims_analyses.service import _carried_result_provenance, _deltas, _snapshot
    from models import (AnalysisService, LimsAnalysis, LimsAnalysisPromotion,
                        LimsAnalysisTransition, LimsSample)

    needs = [LimsAnalysis.captured_at.is_(None)]
    if with_analyst:
        needs += [LimsAnalysis.analyst_user_id.is_(None),
                  LimsAnalysis.analyst_user_id == LimsAnalysis.created_by_user_id]
    q = (
        select(LimsAnalysis.id, LimsAnalysis.lims_sample_pk, LimsSample.sample_id)
        .join(LimsSample, LimsSample.id == LimsAnalysis.lims_sample_pk)
        .join(AnalysisService, AnalysisService.id == LimsAnalysis.analysis_service_id)
        .where(LimsAnalysis.lims_sub_sample_pk.is_(None),
               LimsAnalysis.provenance == "canonical",
               or_(*needs))
        .order_by(LimsSample.id, LimsAnalysis.id)
    )
    if not include_legacy:
        q = q.where(AnalysisService.origin == "mk1")
    if sample_ids:
        q = q.where(LimsSample.sample_id.in_([s.strip().upper() for s in sample_ids]))
    candidates = db.execute(q).all()
    db.rollback()                                     # release the read transaction

    by_sample: dict = {}
    for row in candidates:
        by_sample.setdefault(row.lims_sample_pk, []).append(row)
    sample_pks = list(by_sample)[:limit] if limit is not None else list(by_sample)

    report = {
        "mode": "APPLY" if apply else "dry-run",
        "scope": ("native + legacy" if include_legacy else "native only")
                 + (", captured + analyst" if with_analyst else ", captured only"),
        "candidate_rows": sum(len(by_sample[pk]) for pk in sample_pks),
        "candidate_samples": len(sample_pks),
        "rows_written": 0, "samples_written": 0,
        "captured_set": 0, "analyst_changed": 0, "processed_by_set": 0,
        "skipped_no_promotion": [],                  # (sample_id, analysis_id)
        "skipped_nothing_to_derive": [],             # (sample_id, analysis_id)
        "by_origin": Counter(),
        "errors": [],                                # (sample_id, message)
    }

    for pk in sample_pks:
        sample_id = by_sample[pk][0].sample_id
        touched = 0
        try:
            for cand in by_sample[pk]:
                row = db.get(LimsAnalysis, cand.id)
                promos = db.execute(
                    select(LimsAnalysisPromotion)
                    .where(LimsAnalysisPromotion.parent_analysis_id == row.id)
                    .order_by(LimsAnalysisPromotion.id)
                ).scalars().all()
                if not promos:
                    report["skipped_no_promotion"].append((sample_id, row.id))
                    continue
                source_rows = {
                    r.id: r for r in db.execute(
                        select(LimsAnalysis).where(
                            LimsAnalysis.id.in_([p.source_analysis_id for p in promos]))
                    ).scalars()
                }
                sources = [{"analysis_id": p.source_analysis_id,
                            "contribution_kind": p.contribution_kind}
                           for p in promos if p.source_analysis_id in source_rows]
                captured, analyst, processed_by = _carried_result_provenance(
                    db, sources, source_rows, row.created_by_user_id)

                # Work out the changes WITHOUT touching the row: a dry-run must
                # stay a pure read (no autoflushed UPDATE, no row lock on prod).
                changes: dict = {}
                if row.captured_at is None and captured is not None:
                    changes["captured_at"] = captured
                if with_analyst and row.analyst_user_id in (None, row.created_by_user_id):
                    if analyst is not None and analyst != row.analyst_user_id:
                        changes["analyst_user_id"] = analyst
                    if row.processed_by_user_id is None and processed_by is not None:
                        changes["processed_by_user_id"] = processed_by
                if not changes:
                    report["skipped_nothing_to_derive"].append((sample_id, row.id))
                    continue
                report["captured_set"] += "captured_at" in changes
                report["analyst_changed"] += "analyst_user_id" in changes
                report["processed_by_set"] += "processed_by_user_id" in changes
                note = (f" captured_at={str(changes['captured_at'])[:19]}"
                        if "captured_at" in changes else "")
                if verbose:
                    out(f"  {sample_id} #{row.id} {row.keyword}: {', '.join(sorted(changes))}{note}")
                if apply:
                    before = _snapshot(row)
                    for field, value in changes.items():
                        setattr(row, field, value)
                    db.add(LimsAnalysisTransition(
                        analysis_id=row.id, from_state=row.review_state,
                        to_state=row.review_state, transition_kind="auto", user_id=None,
                        reason=(f"backfill: carried over from the promoted source row(s) "
                                f"{[s['analysis_id'] for s in sources]}{note} ({SCRIPT})"),
                        details=_deltas(before, row),
                    ))
                touched += 1
                svc = db.get(AnalysisService, row.analysis_service_id)
                report["by_origin"][getattr(svc, "origin", None)] += 1
            if apply:
                db.commit()
            else:
                db.rollback()                         # dry-run: release the read transaction
        except Exception as e:  # noqa: BLE001 -- one bad sample never stops the rest
            db.rollback()
            report["errors"].append((sample_id, f"{type(e).__name__}: {e}"))
            continue
        if touched:
            report["rows_written"] += touched
            report["samples_written"] += 1
    return report


def print_report(report: dict, out=print) -> None:
    verb = "wrote" if report["mode"] == "APPLY" else "would write"
    out(f"mode={report['mode']}  scope={report['scope']}")
    out(f"candidates: {report['candidate_rows']} parent row(s) on {report['candidate_samples']} sample(s)")
    out(f"{verb}: {report['rows_written']} row(s) on {report['samples_written']} sample(s)")
    out(f"  captured_at set: {report['captured_set']}   analyst changed: {report['analyst_changed']}"
        f"   processed_by set: {report['processed_by_set']}")
    if report["by_origin"]:
        out("  by service origin: " + ", ".join(f"{k}={v}" for k, v in report["by_origin"].most_common()))
    for key, label in (("skipped_no_promotion", "LEFT ALONE, no promotion record"),
                       ("skipped_nothing_to_derive", "LEFT ALONE, already correct or nothing to derive from")):
        if report[key]:
            shown = ", ".join(f"{sid}#{aid}" for sid, aid in report[key][:12])
            out(f"{label}: {len(report[key])} ({shown})")
    for sid, msg in report["errors"]:
        out(f"ERROR {sid}: {msg}")
    if report["mode"] != "APPLY":
        out("dry-run: nothing was written. Re-run with --apply to write.")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--apply", action="store_true", help="write (default: report only)")
    ap.add_argument("--with-analyst", action="store_true",
                    help="also re-point the analyst off the promoter (NEEDS SIGN-OFF, see docstring)")
    ap.add_argument("--include-legacy", action="store_true",
                    help="also SENAITE-origin service rows (NEEDS SIGN-OFF)")
    ap.add_argument("--sample-id", action="append", default=[], help="limit to this sample id (repeatable)")
    ap.add_argument("--limit", type=int, default=None, help="process at most N samples")
    ap.add_argument("--verbose", action="store_true", help="list every row that changes")
    args = ap.parse_args()

    from database import SessionLocal

    db = SessionLocal()
    try:
        report = backfill(db, apply=args.apply, with_analyst=args.with_analyst,
                          include_legacy=args.include_legacy, sample_ids=args.sample_id,
                          limit=args.limit, verbose=args.verbose)
        print_report(report)
        return 1 if report["errors"] else 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
