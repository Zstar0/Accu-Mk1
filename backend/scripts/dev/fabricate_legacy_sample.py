#!/usr/bin/env python3
"""DEV STACK ONLY: turn a published sample into a SENAITE-era shape, the E2E
fixture for spec docs/superpowers/specs/2026-09-30-retest-legacy-fallback-and-combined.md.

  * clears catalog_snapshot.profiles (other snapshot keys kept)
  * retires (review_state='rejected') every live mk1-origin parent-tier
    'canonical' / 'ordered' row, so native rows cannot win the effective-key
    dedupe (a SENAITE-era sample has none)
  * upserts parent-tier provenance='shadow', review_state='senaite_mirror',
    mirror_review_state='published' rows, with result values, for HPLC-PUR,
    PEPT-Total, ID_<peptide>, ENDO-LAL and STER-PCR using their SENAITE-origin
    services (a keyword with no such service is skipped)
  * prints effective_profiles() for the sample as the self-check

Refuses unless ACCUMARK_STACK_NAME is set (only accumark-stack containers set
it; the stack DB itself is named accumark_mk1, like prod). Never run it
against prod. Inside the stack's backend container:

  python scripts/dev/fabricate_legacy_sample.py P-0123 --peptide BPC157
"""
import argparse
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

RESULTS = {"HPLC-PUR": "99.12", "PEPT-Total": "10.40", "ENDO-LAL": "< 0.50", "STER-PCR": "Not Detected"}
ID_RESULT = "Conforms"


def _guard() -> None:
    if not os.environ.get("ACCUMARK_STACK_NAME", "").strip():
        sys.exit("refusing: ACCUMARK_STACK_NAME is not set (accumark-stack containers only)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("sample_id")
    ap.add_argument("--peptide", help="ID_<peptide> keyword suffix (default: first SENAITE ID_* service)")
    args = ap.parse_args()
    _guard()

    from sqlalchemy import select

    from database import SessionLocal
    from lims_analyses.retest_carry import effective_profiles
    from models import AnalysisService, LimsAnalysis, LimsSample

    db = SessionLocal()
    try:
        sample = db.execute(select(LimsSample).where(
            LimsSample.sample_id == args.sample_id)).scalar_one_or_none()
        if sample is None:
            sys.exit(f"{args.sample_id} not in Mk1")
        if sample.status != "published":
            sys.exit(f"{args.sample_id} is {sample.status}, not published")

        def senaite_service(keyword: str | None, prefix: str | None = None):
            q = select(AnalysisService).where(AnalysisService.origin != "mk1")
            q = q.where(AnalysisService.keyword == keyword) if keyword else \
                q.where(AnalysisService.keyword.like(f"{prefix}%")).order_by(AnalysisService.keyword)
            return db.execute(q.limit(1)).scalars().first()

        now = datetime.utcnow()  # noqa: DTZ003 (naive TIMESTAMP columns)
        snap = dict(sample.catalog_snapshot or {})
        print(f"{sample.sample_id}: snapshot profiles {[p.get('key') for p in snap.get('profiles') or []]} -> []")
        sample.catalog_snapshot = {**snap, "profiles": []}

        native = db.execute(
            select(LimsAnalysis).join(AnalysisService, AnalysisService.id == LimsAnalysis.analysis_service_id)
            .where(LimsAnalysis.lims_sample_pk == sample.id, LimsAnalysis.lims_sub_sample_pk.is_(None),
                   LimsAnalysis.provenance.in_(("canonical", "ordered")),
                   LimsAnalysis.review_state.notin_(("rejected", "retracted")),
                   AnalysisService.origin == "mk1")).scalars().all()
        for row in native:
            print(f"  retire {row.provenance} row {row.id} {row.keyword} ({row.review_state} -> rejected)")
            row.review_state = "rejected"
            row.updated_at = now

        wanted = [*RESULTS, f"ID_{args.peptide}" if args.peptide else None]
        for kw in wanted:
            svc = senaite_service(kw) if kw else senaite_service(None, "ID_")
            label = kw or "ID_*"
            if svc is None:
                print(f"  skip {label}: no SENAITE-origin service")
                continue
            value = RESULTS.get(svc.keyword, ID_RESULT)
            row = db.execute(select(LimsAnalysis).where(
                LimsAnalysis.lims_sample_pk == sample.id, LimsAnalysis.lims_sub_sample_pk.is_(None),
                LimsAnalysis.analysis_service_id == svc.id, LimsAnalysis.provenance == "shadow",
                LimsAnalysis.retested.is_(False))).scalars().first()
            if row is None:
                row = LimsAnalysis(lims_sample_pk=sample.id, lims_sub_sample_pk=None,
                                   analysis_service_id=svc.id, keyword=svc.keyword, title=svc.title,
                                   provenance="shadow", created_at=now)
                db.add(row)
                verb = "insert"
            else:
                verb = "update"
            row.review_state = "senaite_mirror"
            row.mirror_review_state = "published"
            row.result_value = value
            row.result_unit = svc.unit
            row.updated_at = now
            print(f"  {verb} shadow {svc.keyword} (service {svc.id}) = {value!r}")
        db.flush()
        print("effective_profiles:")
        for e in effective_profiles(db, sample):
            print(f"  {e.key} legacy={e.legacy} source={e.source}")
        db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
