"""One-off repair for PB-0469 (2026-09-08 duplicate-analyte-slot incident).

What happened: the parent's analyte slot 1 (KPV) was typed over as "GHK-Cu"
in the inline slot editor while slot 2 already held GHK-Cu. A Process-HPLC
re-run then fell through the prep bridge's slot routing into the generic
slot-1 rows, bulk-promote promoted both pairs, and the Handler's retest of
Analyte 2 un-promoted the parent rows but minted two spurious PENDING
GHK-Cu retest children on the vial. SENAITE slot 2 still names GHK-Cu, so the
parent's declared-analytes list carries it twice.

This script (dry-run by default, `--apply` writes, one commit at the end):
  1. rejects the spurious retest children (PUR_GHKCU / QTY_GHKCU rows that
     are `unassigned`, have `retest_of_id`, and carry no result) -- audited
     as a `reject` transition with a repair reason
  2. blanks Analyte2Peptide + Analyte2DeclaredQuantity on the SENAITE AR
     (slot 1 keeps GHK-Cu; the surviving rows/identity belong to slot 1, so
     this is the fields-only clear -- `cascade=False`)
  3. records an `analyte_slot_cleared` event on the parent (via the same
     service the Clear action uses)
  4. optional `--rename-to GLOW`: ClientSampleID KLOW -> GLOW (SENAITE + mirror)
  5. refreshes the registry row so `lims_samples.analytes` drops the duplicate

Run INSIDE the backend container:

    docker exec -w /app -i accu-mk1-backend python -m scripts.repair_pb0469_duplicate_slot
    docker exec -w /app -i accu-mk1-backend python -m scripts.repair_pb0469_duplicate_slot --apply --rename-to GLOW

Idempotent: a second run finds no pending retest children and re-blanks an
already-empty slot (a no-op on SENAITE).
"""
from __future__ import annotations

import argparse
from typing import Callable, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from lims_analyses.service import apply_transition, clear_analyte_slot
from models import LimsAnalysis, LimsSample, LimsSubSample, Peptide

SAMPLE_ID = "PB-0469"
SLOT_TO_BLANK = 2
SPURIOUS_KEYWORDS = ("PUR_GHKCU", "QTY_GHKCU")
PEPTIDE_NAME = "GHK-Cu"
REASON = "repair PB-0469: spurious retest child from duplicate-slot un-promote (2026-09-08)"


def _default_senaite_update(uid: str, fields: dict) -> None:
    from sub_samples.senaite import _do_field_update
    _do_field_update(uid, fields)


def _default_refresh(db: Session, parent: LimsSample) -> None:
    from sub_samples.service import _refresh_parent_from_senaite
    _refresh_parent_from_senaite(db, parent)


def run(
    db: Session,
    *,
    apply: bool,
    senaite_update: Callable[[str, dict], None] = _default_senaite_update,
    refresh: Callable[[Session, LimsSample], None] = _default_refresh,
    rename_to: Optional[str] = None,
) -> dict:
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == SAMPLE_ID)
    ).scalar_one_or_none()
    if parent is None:
        raise SystemExit(f"{SAMPLE_ID} not found in lims_samples")
    vial_pks = [
        v.id for v in db.execute(
            select(LimsSubSample).where(LimsSubSample.parent_sample_pk == parent.id)
        ).scalars()
    ]
    spurious = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sub_sample_pk.in_(vial_pks or [-1]),
            LimsAnalysis.keyword.in_(SPURIOUS_KEYWORDS),
            LimsAnalysis.review_state == "unassigned",
            LimsAnalysis.retest_of_id.is_not(None),
            LimsAnalysis.result_value.is_(None),
        ).order_by(LimsAnalysis.id)
    ).scalars().all()
    senaite_fields = {
        f"Analyte{SLOT_TO_BLANK}Peptide": "",
        f"Analyte{SLOT_TO_BLANK}DeclaredQuantity": "",
    }
    peptide = db.execute(
        select(Peptide).where(Peptide.name == PEPTIDE_NAME)
    ).scalar_one_or_none()
    report = {
        "sample_id": SAMPLE_ID,
        "senaite_uid": parent.external_lims_uid,
        "reject_rows": [r.id for r in spurious],
        "reject_keywords": [r.keyword for r in spurious],
        "slot_to_blank": SLOT_TO_BLANK,
        "senaite_fields": senaite_fields,
        "rename_to": rename_to,
        "applied": apply,
    }
    if not apply:
        return report

    for row in spurious:
        # apply_transition commits per call (master); acceptable for a one-off
        # repair -- each reject is independently correct and audited.
        apply_transition(db, analysis_id=row.id, kind="reject", reason=REASON, user_id=None)
    senaite_update(parent.external_lims_uid, senaite_fields)
    clear_analyte_slot(
        db, parent_sample_id=SAMPLE_ID, slot=SLOT_TO_BLANK,
        old_peptide_id=peptide.id if peptide else None,
        confirm_retract=False, user_id=None, cascade=False,
    )
    if rename_to:
        senaite_update(parent.external_lims_uid, {"ClientSampleID": rename_to})
        parent.client_sample_id = rename_to
    db.flush()
    refresh(db, parent)
    db.commit()
    return report


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--apply", action="store_true", help="write; default is a dry-run report")
    ap.add_argument("--rename-to", default=None, help="also set ClientSampleID (e.g. GLOW)")
    args = ap.parse_args(argv)
    from database import SessionLocal

    db = SessionLocal()
    try:
        report = run(db, apply=args.apply, rename_to=args.rename_to)
    finally:
        db.close()
    for k, v in report.items():
        print(f"  {k}: {v}")
    print("APPLIED" if report["applied"] else "DRY RUN -- nothing written (re-run with --apply)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
