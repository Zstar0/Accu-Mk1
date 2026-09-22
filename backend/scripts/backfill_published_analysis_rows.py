#!/usr/bin/env python3
"""One-off, audited backfill: move parent analysis rows that are already ON a
published certificate from 'verified' to 'published'.

Why (2026-09-21): the analysis-tier `verified -> published` edge was described
in the workflow catalog and present in the state machine, but nothing ever
applied it to canonical rows. Slice 19 (`service.publish_parent_rows`) does it
at every publish from now on; this script catches up the samples published
BEFORE that. It matters because `published` is what makes a result citable:
a retest of a published row keeps the figure and lets the re-promote supersede
it, whereas a retest of a `verified` row retracts it and clears the value.

What it moves: a live canonical parent-tier row, state 'verified', on a sample
whose status is 'published', that was verified AT OR BEFORE the sample's last
publish. "Last publish" is the later of the two signals main.py's
`_delivered_sample_pks` trusts: a `publish` row in the sample ledger
(lims_sample_transitions) and a parent `coa_published` event.

What it deliberately does NOT move, and reports instead:
  * a row verified AFTER the last publish. That result is on no published
    certificate (an add-on verified after the primary went out, or a retest
    promoted and never re-published). Stamping it 'published' would be false,
    and it is exactly what a "re-publish owed" signal needs to find.
    Prod 2026-09-21: 8 such native rows on 6 samples.
  * a row with no verified_at, or a sample with no publish signal at all:
    nothing to compare, so nothing is assumed.

Scope: NATIVE services only by default (analysis_services.origin = 'mk1'),
matching slice 19 and the Handler's ruling. `--include-legacy` widens it to
SENAITE-origin services; that changes what the lab sees on published legacy
samples (the vial lock tests for 'verified') and needs its own sign-off first.
Prod 2026-09-21: 271 native rows eligible; ~10k with legacy.

It goes through the state machine's own `publish` verb, so each row gets an
audit transition naming this script. `published_at` is then set to the real
publish time rather than the time the backfill ran. No result value, unit,
method or instrument is touched.

Dry-run by default. Idempotent: it only ever selects 'verified' rows, so a
second run finds nothing. One short transaction per sample.

Run (from backend/):
    python scripts/backfill_published_analysis_rows.py                 # report only
    python scripts/backfill_published_analysis_rows.py --sample-id PB-1002 --verbose
    python scripts/backfill_published_analysis_rows.py --apply
Prod (stdin form, per the data-fix runbook):
    docker exec -w /app -i accu-mk1-backend python - --apply < scripts/backfill_published_analysis_rows.py
"""
import argparse
import os
import sys
from collections import Counter
from typing import Optional

# Piped over stdin (`python - < script`, the prod data-fix form) there is no
# __file__; the container's working dir (/app) is already importable then.
if "__file__" in globals():
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

REASON = "backfill: on a COA published {at} (scripts/backfill_published_analysis_rows.py)"


def last_publish_times(db, sample_pks) -> dict:
    """{lims_sample_pk: datetime of the latest publish signal}. Two sources,
    the later wins; a sample with neither is absent."""
    from sqlalchemy import func, select

    from models import LimsSampleTransition, LimsSubSampleEvent

    out: dict = {}
    pks = list(sample_pks)
    if not pks:
        return out
    for pk, at in db.execute(
        select(LimsSampleTransition.lims_sample_pk, func.max(LimsSampleTransition.occurred_at))
        .where(LimsSampleTransition.verb == "publish",
               LimsSampleTransition.lims_sample_pk.in_(pks))
        .group_by(LimsSampleTransition.lims_sample_pk)
    ):
        out[pk] = at
    for pk, at in db.execute(
        select(LimsSubSampleEvent.lims_sample_pk, func.max(LimsSubSampleEvent.created_at))
        .where(LimsSubSampleEvent.event == "coa_published",
               LimsSubSampleEvent.lims_sample_pk.in_(pks))
        .group_by(LimsSubSampleEvent.lims_sample_pk)
    ):
        if at is not None and (out.get(pk) is None or at > out[pk]):
            out[pk] = at
    return out


def backfill(db, *, apply: bool = False, include_legacy: bool = False,
             sample_ids: Optional[list] = None, limit: Optional[int] = None,
             verbose: bool = False, out=print) -> dict:
    """Core, importable for tests. Returns the report dict."""
    from sqlalchemy import select

    from lims_analyses.service import apply_transition
    from models import AnalysisService, LimsAnalysis, LimsSample

    q = (
        select(LimsAnalysis.id, LimsAnalysis.lims_sample_pk, LimsSample.sample_id,
               AnalysisService.keyword, AnalysisService.origin, LimsAnalysis.verified_at)
        .join(LimsSample, LimsSample.id == LimsAnalysis.lims_sample_pk)
        .join(AnalysisService, AnalysisService.id == LimsAnalysis.analysis_service_id)
        .where(
            LimsAnalysis.lims_sub_sample_pk.is_(None),
            LimsAnalysis.provenance == "canonical",
            LimsAnalysis.retested.is_(False),
            LimsAnalysis.review_state == "verified",
            LimsSample.status == "published",
        )
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
    sample_pks = list(by_sample)
    if limit is not None:
        sample_pks = sample_pks[:limit]
    publish_at = last_publish_times(db, sample_pks)
    db.rollback()

    report = {
        "mode": "APPLY" if apply else "dry-run",
        "scope": "native + legacy" if include_legacy else "native only",
        "candidate_rows": sum(len(by_sample[pk]) for pk in sample_pks),
        "candidate_samples": len(sample_pks),
        "moved_rows": 0, "moved_samples": 0,
        "by_keyword": Counter(), "by_origin": Counter(),
        "skipped_verified_after_publish": [],       # (sample_id, keyword, verified_at, last_publish)
        "skipped_no_publish_signal": [],            # sample_id
        "skipped_no_verified_at": [],               # (sample_id, keyword)
        "errors": [],                               # (sample_id, message)
    }

    for pk in sample_pks:
        rows = by_sample[pk]
        sample_id = rows[0].sample_id
        at = publish_at.get(pk)
        if at is None:
            report["skipped_no_publish_signal"].append(sample_id)
            continue
        eligible = []
        for r in rows:
            if r.verified_at is None:
                report["skipped_no_verified_at"].append((sample_id, r.keyword))
            elif r.verified_at > at:
                report["skipped_verified_after_publish"].append(
                    (sample_id, r.keyword, str(r.verified_at)[:19], str(at)[:19]))
            else:
                eligible.append(r)
        if not eligible:
            continue
        if verbose:
            out(f"  {sample_id}: {len(eligible)} row(s) -> published "
                f"[{', '.join(sorted(r.keyword for r in eligible))}] (published {str(at)[:19]})")
        if apply:
            try:
                for r in eligible:
                    moved = apply_transition(
                        db, analysis_id=r.id, kind="publish", user_id=None,
                        reason=REASON.format(at=str(at)[:19]), commit=False)
                    moved.published_at = at             # when it really went out, not now
                db.commit()
            except Exception as e:  # noqa: BLE001 -- one bad sample never stops the rest
                db.rollback()
                report["errors"].append((sample_id, f"{type(e).__name__}: {e}"))
                continue
        report["moved_rows"] += len(eligible)
        report["moved_samples"] += 1
        for r in eligible:
            report["by_keyword"][r.keyword] += 1
            report["by_origin"][r.origin] += 1
    return report


def print_report(report: dict, out=print) -> None:
    verb = "moved" if report["mode"] == "APPLY" else "would move"
    out(f"mode={report['mode']}  scope={report['scope']}")
    out(f"candidates: {report['candidate_rows']} verified row(s) on {report['candidate_samples']} published sample(s)")
    out(f"{verb}: {report['moved_rows']} row(s) on {report['moved_samples']} sample(s)")
    if report["by_origin"]:
        out("  by service origin: " + ", ".join(f"{k}={v}" for k, v in report["by_origin"].most_common()))
    for kw, n in report["by_keyword"].most_common(12):
        out(f"    {kw:<28} {n}")
    after = report["skipped_verified_after_publish"]
    out(f"LEFT ALONE, verified AFTER the last publish (on no published certificate): {len(after)}")
    for sid, kw, v, p in after[:40]:
        out(f"    {sid:<12} {kw:<24} verified {v}   last publish {p}")
    if report["skipped_no_publish_signal"]:
        out(f"LEFT ALONE, sample has no publish signal: {len(report['skipped_no_publish_signal'])} "
            f"({', '.join(report['skipped_no_publish_signal'][:12])})")
    if report["skipped_no_verified_at"]:
        out(f"LEFT ALONE, row has no verified_at: {len(report['skipped_no_verified_at'])}")
    for sid, msg in report["errors"]:
        out(f"ERROR {sid}: {msg}")
    if report["mode"] != "APPLY":
        out("dry-run: nothing was written. Re-run with --apply to write.")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--apply", action="store_true", help="write (default: report only)")
    ap.add_argument("--include-legacy", action="store_true",
                    help="also move SENAITE-origin service rows (NEEDS SIGN-OFF, see docstring)")
    ap.add_argument("--sample-id", action="append", default=[],
                    help="limit to this sample id (repeatable)")
    ap.add_argument("--limit", type=int, default=None, help="process at most N samples")
    ap.add_argument("--verbose", action="store_true", help="list every sample that moves")
    args = ap.parse_args()

    from database import SessionLocal

    db = SessionLocal()
    try:
        report = backfill(db, apply=args.apply, include_legacy=args.include_legacy,
                          sample_ids=args.sample_id, limit=args.limit, verbose=args.verbose)
        print_report(report)
        return 1 if report["errors"] else 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
