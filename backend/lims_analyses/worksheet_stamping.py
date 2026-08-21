"""Slice 2: worksheet-level method/instrument apply (R6/R7/R8).

Coverage-scoped: only analyses whose service the method covers are stamped;
only STAMPABLE_STATES rows are touched; everything else is reported, never
silent. One transaction — the caller's route commits once.
"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from lims_analyses.service import STAMPABLE_STATES, stamp_method_instrument
from models import LimsAnalysis, LimsSubSample, WorksheetItem, method_services


def apply_method_instrument_to_worksheet(db: Session, *, worksheet, method_id: int,
                                         instrument_id: int, item_ids, user_id) -> dict:
    covered = {r[0] for r in db.execute(
        select(method_services.c.analysis_service_id)
        .where(method_services.c.method_id == method_id)).all()}
    items = [it for it in db.execute(
        select(WorksheetItem).where(WorksheetItem.worksheet_id == worksheet.id)
    ).scalars().all() if item_ids is None or it.id in set(item_ids)]

    stamped, items_updated = 0, 0
    skipped_state, skipped_uncovered = [], []
    for it in items:
        vial = db.execute(select(LimsSubSample).where(
            LimsSubSample.sample_id == it.sample_id)).scalar_one_or_none()
        if vial is None:
            continue  # parent-sample item (no vial) — nothing to stamp
        rows = db.execute(select(LimsAnalysis).where(
            LimsAnalysis.lims_sub_sample_pk == vial.id)).scalars().all()
        for row in rows:
            if row.analysis_service_id not in covered:
                skipped_uncovered.append({"analysis_id": row.id, "keyword": row.keyword})
                continue
            if row.review_state not in STAMPABLE_STATES:
                skipped_state.append({"analysis_id": row.id, "review_state": row.review_state})
                continue
            if stamp_method_instrument(db, row, method_id=method_id,
                                       instrument_id=instrument_id, user_id=user_id):
                stamped += 1
        it.instrument_id = instrument_id
        items_updated += 1
    return {"stamped": stamped, "items_updated": items_updated,
            "skipped_state": skipped_state, "skipped_uncovered": skipped_uncovered}
