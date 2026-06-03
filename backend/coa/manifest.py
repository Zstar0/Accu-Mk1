"""
Persist a per-generation COA source manifest. Called once at the tail of a
successful COA generation; rows are immutable afterwards.

See: docs/superpowers/specs/2026-06-02-coa-rollup-override-design.md
"""

from __future__ import annotations

import uuid
from typing import List

from sqlalchemy import select
from sqlalchemy.orm import Session

from coa.schemas import ResolverResult
from models import CoaGenerationSource


def write_generation_manifest(
    db: Session,
    *,
    generation_id: uuid.UUID,
    generation_number: int,
    result: ResolverResult,
) -> None:
    """
    Write one CoaGenerationSource row per resolved decision. Caller must
    have already confirmed `result.is_blocked == False` — this function
    skips any decision that is still blocked (defensive).
    """
    for d in result.decisions:
        if d.blocked is not None or d.chosen is None:
            continue
        db.add(CoaGenerationSource(
            generation_id=generation_id,
            generation_number=generation_number,
            parent_sample_id=result.parent_sample_id,
            analyte_keyword=d.analyte_keyword,
            source_sample_id=d.chosen.source_sample_id,
            source_analysis_uid=d.chosen.source_analysis_uid,
            result_value=d.chosen.value,
            result_unit=d.chosen.unit,
            candidates_count=len(d.candidates),
            resolution_mode=d.mode,
            candidates_snapshot=[c.model_dump() for c in d.candidates],
        ))
    db.commit()


def read_generation_manifest(
    db: Session,
    *,
    generation_id: uuid.UUID,
) -> List[CoaGenerationSource]:
    return list(
        db.execute(
            select(CoaGenerationSource)
            .where(CoaGenerationSource.generation_id == generation_id)
            .order_by(CoaGenerationSource.analyte_keyword)
        ).scalars().all()
    )
