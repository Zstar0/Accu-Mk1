# backend/documents/comment_attachments_gc.py
"""Orphaned comment-attachment sweep (spec §4.2), a sibling of flags/attachments_gc.py:
same 24h TTL, same storage seam, registered on the same scheduler job in main.py.
Lives in documents/ so flags/ never learns about document comments."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy import select

logger = logging.getLogger(__name__)
_ORPHAN_TTL = timedelta(hours=24)


def gc_orphaned_comment_attachments(db, *, now: datetime, storage=None) -> int:
    from documents.models import DocumentCommentAttachment
    if storage is None:
        from flags import seams as flag_seams
        storage = flag_seams.get_attachment_storage()
    cutoff = now - _ORPHAN_TTL
    rows = db.execute(select(DocumentCommentAttachment).where(
        DocumentCommentAttachment.comment_id.is_(None),
        DocumentCommentAttachment.created_at < cutoff)).scalars().all()
    removed = 0
    for row in rows:
        try:
            storage.delete(row.storage_key)
        except Exception:  # noqa: BLE001 — a storage miss never blocks the DB sweep
            logger.warning("comment attachment gc: storage delete failed for %s", row.storage_key)
        db.delete(row)
        removed += 1
    db.commit()
    return removed
