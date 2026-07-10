"""Orphaned-attachment GC (Slice 5; the job deferred from Slice 3).

Deletes flag_attachments that were uploaded but never linked to a saved comment
after 24h, freeing the S3/filesystem objects behind them. Lives in flags/ (not
slack_notify/) because it has zero Slack coupling and operates purely on the
flags attachment-storage seam — module-cohesive, same rationale as recurring.py.
The scheduler registers `gc_orphaned_attachments` hourly from main.py's lifespan.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy import select

logger = logging.getLogger(__name__)

_ORPHAN_TTL = timedelta(hours=24)


def gc_orphaned_attachments(db, *, now: datetime, storage=None) -> int:
    """Delete every flag_attachments row with comment_id IS NULL that is older
    than 24h, best-effort deleting its blob first. `storage` defaults to the
    live attachment-storage seam; tests inject a fake."""
    from flags import seams
    from flags.models import FlagAttachment
    if storage is None:
        storage = seams.get_attachment_storage()
    cutoff = now - _ORPHAN_TTL
    rows = db.execute(select(FlagAttachment).where(
        FlagAttachment.comment_id.is_(None),
        FlagAttachment.created_at < cutoff)).scalars().all()
    removed = 0
    for row in rows:
        try:
            storage.delete(row.storage_key)
        except Exception:                            # noqa: BLE001 — a storage miss never blocks the DB GC
            logger.warning("gc: storage delete failed for %s", row.storage_key)
        db.delete(row)
        removed += 1
    db.commit()
    return removed
