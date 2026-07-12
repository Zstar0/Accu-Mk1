"""Passive analysis drift observer (workflow state system Task 7, SENAITE
phase-out slice).

Zero additional SENAITE load: heals a parent's live shadow rows (and logs a
`transition_kind='observed'` row) using analysis data ALREADY fetched for
display by an unrelated caller — the sample-lookup page's analyses fetch and
the registry-debug panel's `_build_analysis_debug_rows` (`main.py`). This
module never issues its own SENAITE HTTP call; it only compares what the
caller handed it against the shadow mirror (slice 2, `lims_analyses.
parent_mirror`) and heals drift in place.

`transition_kind='observed'` is a documented non-performable-verb kind (see
`lims_analyses/state_machine.py`'s `VALID_TRANSITION_KINDS` comment) — rows
are written directly here, bypassing `apply_transition`, exactly like the
`'auto'` kind parent_mirror.py already writes for its own inserts.

Flush-only: this module never commits. Callers own the transaction (see
`main._observe_parent_analyses_bg`, the own-session/commit/never-raise
wrapper both hook sites schedule through).
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import LimsAnalysis, LimsAnalysisTransition, LimsSample

OBSERVED_REASON = "SENAITE-direct change observed via display fetch"


def _norm_result(v: Optional[str]) -> Optional[str]:
    return None if v is None else str(v).strip()


def _live_shadow(db: Session, parent_id: int, keyword: str) -> Optional[LimsAnalysis]:
    """The live shadow row for (parent, keyword) — same idiom as
    `lims_analyses.parent_mirror._existing_shadow` (provenance='shadow' AND
    retested=FALSE, newest id first — take-first rather than
    scalar_one_or_none so an anomaly resolves deterministically instead of
    raising), keyed by `keyword` instead of `analysis_service_id` since
    that's the only identifier both hook-site payloads carry (matches the
    registry-debug panel's own `shadow_best` selection in
    `main._build_analysis_debug_rows`)."""
    return db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == parent_id,
            LimsAnalysis.keyword == keyword,
            LimsAnalysis.provenance == "shadow",
            LimsAnalysis.retested.is_(False),
        ).order_by(LimsAnalysis.id.desc())
    ).scalars().first()


def observe_parent_analyses(db: Session, *, sample_id: str, observed: list[dict]) -> int:
    """Compare `observed` (already-fetched SENAITE analysis lines — dicts
    with `keyword`/`review_state`/`result`) against each keyword's live
    shadow row and heal drift in place.

    Per item:
      - falsy `keyword` or `review_state` -> skipped (nothing to key or
        compare on).
      - no live shadow row for this (parent, keyword) -> skipped; row
        creation belongs to the backfill/mirror hooks, not this observer.
      - `mirror_review_state != review_state` (state drift) -> heals
        `mirror_review_state`, ALSO heals `result_value` when `result` is
        non-None and differs, and writes a `transition_kind='observed'` row
        (from the OLD mirror state to the new one). Counted.
      - state matches but `result` differs (result-only drift) -> heals
        `result_value` only, no transition row (the transition log tracks
        STATE changes, not result edits). NOT counted.
      - neither differs -> no-op.

    Resolves the parent LimsSample by `sample_id` once up front; no parent
    registered -> 0 (nothing to heal against). Flush-never-commit; caller
    (`main._observe_parent_analyses_bg`) owns the transaction. Returns the
    count of `observed` transition rows written (NOT the count of rows
    healed — result-only healing writes no transition row but still
    persists via the flush)."""
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if parent is None:
        return 0

    written = 0
    healed = False
    for item in observed:
        keyword = item.get("keyword")
        review_state = item.get("review_state")
        if not keyword or not review_state:
            continue

        shadow = _live_shadow(db, parent.id, keyword)
        if shadow is None:
            continue  # backfill/mirror hooks own row creation, not this observer

        result = item.get("result")
        result_drifted = result is not None and _norm_result(result) != _norm_result(shadow.result_value)

        if shadow.mirror_review_state != review_state:
            old_state = shadow.mirror_review_state
            shadow.mirror_review_state = review_state
            if result_drifted:
                shadow.result_value = result
            shadow.updated_at = datetime.utcnow()
            db.add(LimsAnalysisTransition(
                analysis_id=shadow.id,
                from_state=old_state,
                to_state=review_state,
                transition_kind="observed",
                user_id=None,
                reason=OBSERVED_REASON,
            ))
            written += 1
            healed = True
        elif result_drifted:
            shadow.result_value = result
            shadow.updated_at = datetime.utcnow()
            healed = True

    if healed:
        db.flush()
    return written
