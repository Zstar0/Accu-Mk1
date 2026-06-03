"""
Service layer for lims_analyses.

All DB writes go through here. Every state change writes a
LimsAnalysisTransition audit row in the same DB transaction as the
LimsAnalysis update — the two stay consistent or both roll back.

Service functions raise typed exceptions (NotFoundError, BadRequestError,
plus the state-machine exceptions re-exported from state_machine.py).
The route layer translates them to HTTP responses.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from lims_analyses.state_machine import (
    InvalidTransitionError,
    TierMismatchError,
    is_terminal,
    next_state,
    tier_of,
)
from models import LimsAnalysis, LimsAnalysisTransition


# ─── Typed exceptions ────────────────────────────────────────────────────────


class NotFoundError(LookupError):
    """Analysis (or related entity) not found."""


class BadRequestError(ValueError):
    """Request is structurally OK but semantically invalid (e.g. missing
    result on submit). Distinct from state-machine errors which are about
    the (from_state, kind) edge."""


# ─── Reads ───────────────────────────────────────────────────────────────────


def get_analysis(db: Session, analysis_id: int) -> LimsAnalysis:
    row = db.get(LimsAnalysis, analysis_id)
    if row is None:
        raise NotFoundError(f"lims_analysis id={analysis_id} not found")
    return row


def list_analyses_for_host(
    db: Session,
    *,
    host_kind: str,
    host_pk: int,
    include_retests: bool = True,
) -> List[LimsAnalysis]:
    """List analyses attached to a single host. Retests included by default;
    set include_retests=False to filter to the current (non-retest) rows
    that drive the AnalysisTable view."""
    if host_kind == "sample":
        stmt = select(LimsAnalysis).where(LimsAnalysis.lims_sample_pk == host_pk)
    elif host_kind == "sub_sample":
        stmt = select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == host_pk)
    else:
        raise BadRequestError(f"invalid host_kind={host_kind!r}")
    if not include_retests:
        stmt = stmt.where(LimsAnalysis.retest_of_id.is_(None))
    return list(db.execute(stmt.order_by(LimsAnalysis.keyword)).scalars().all())


# ─── Creation ────────────────────────────────────────────────────────────────


def create_analysis(
    db: Session,
    *,
    host_kind: str,
    host_pk: int,
    analysis_service_id: int,
    keyword: str,
    title: str,
    result_value: Optional[str] = None,
    result_unit: Optional[str] = None,
    method_id: Optional[int] = None,
    instrument_id: Optional[int] = None,
    created_by_user_id: Optional[int] = None,
) -> LimsAnalysis:
    """Insert a new lims_analyses row in state='unassigned'. Writes the
    initial audit row (from_state=NULL, to_state='unassigned',
    transition_kind='auto')."""
    if host_kind == "sample":
        lims_sample_pk, lims_sub_sample_pk = host_pk, None
    elif host_kind == "sub_sample":
        lims_sample_pk, lims_sub_sample_pk = None, host_pk
    else:
        raise BadRequestError(f"invalid host_kind={host_kind!r}")

    row = LimsAnalysis(
        lims_sample_pk=lims_sample_pk,
        lims_sub_sample_pk=lims_sub_sample_pk,
        analysis_service_id=analysis_service_id,
        keyword=keyword,
        title=title,
        result_value=result_value,
        result_unit=result_unit,
        review_state="unassigned",
        method_id=method_id,
        instrument_id=instrument_id,
        created_by_user_id=created_by_user_id,
    )
    db.add(row)
    db.flush()  # populate row.id before writing the audit log

    db.add(LimsAnalysisTransition(
        analysis_id=row.id,
        from_state=None,
        to_state="unassigned",
        transition_kind="auto",
        user_id=created_by_user_id,
        reason="initial insert",
    ))
    db.commit()
    db.refresh(row)
    return row


# ─── Transitions ─────────────────────────────────────────────────────────────


def apply_transition(
    db: Session,
    *,
    analysis_id: int,
    kind: str,
    result_value: Optional[str] = None,
    reason: Optional[str] = None,
    user_id: Optional[int] = None,
) -> LimsAnalysis:
    """
    Validate (from_state, kind) via the state machine, apply the
    state change, update timestamps, write the audit row, commit.

    Semantic guards beyond the state machine:
      - 'submit' requires a result_value (either already on the row or
        supplied in this call).
      - 'verify' requires the row to already carry a result_value.
    """
    row = get_analysis(db, analysis_id)
    from_state = row.review_state

    if is_terminal(from_state):
        # State machine will also reject this, but we surface a clearer
        # message: "this analysis is closed" rather than "kind not allowed".
        raise InvalidTransitionError(
            from_state, kind,
            message=f"analysis is in terminal state {from_state!r}; no transitions allowed",
        )

    # Tier guard. Vial-tier rows can't publish; parent-tier rows can't accept
    # assign/submit. The state machine's tier-aware next_state() raises
    # TierMismatchError on a violation — surfaced as 409 by the route layer.
    row_tier = tier_of(
        lims_sample_pk=row.lims_sample_pk,
        lims_sub_sample_pk=row.lims_sub_sample_pk,
        review_state=from_state,
    )
    to_state = next_state(from_state, kind, tier=row_tier)

    # Semantic guards
    if kind == "submit":
        # Accept inline result_value as the submitted result.
        if result_value is not None:
            row.result_value = result_value
        if not row.result_value:
            raise BadRequestError(
                "submit requires a result_value (either pre-existing on the "
                "row or supplied in this request)"
            )
    elif kind == "verify":
        if not row.result_value:
            raise BadRequestError("verify requires a result_value on the row")
    elif kind == "reset":
        # Clear any draft result + provenance on the way back to unassigned.
        row.result_value = None
        row.result_unit = None
        row.method_id = None
        row.instrument_id = None
        row.captured_at = None
        row.submitted_at = None
    elif kind == "retract":
        # Clear timestamps from the verified attempt; the row is now an
        # auditable record of "this attempt was retracted." A new attempt
        # (retest) is a separate row pointing here via retest_of_id.
        row.verified_at = None

    now = datetime.utcnow()

    # Timestamp markers per state.
    if to_state == "to_be_verified":
        row.submitted_at = row.submitted_at or now
        if not row.captured_at:
            row.captured_at = now
    elif to_state == "verified":
        row.verified_at = now
    elif to_state == "published":
        row.published_at = now

    row.review_state = to_state
    row.updated_at = now

    db.add(LimsAnalysisTransition(
        analysis_id=row.id,
        from_state=from_state,
        to_state=to_state,
        transition_kind=kind,
        user_id=user_id,
        reason=reason,
    ))
    db.commit()
    db.refresh(row)
    return row


def set_reportable(
    db: Session,
    *,
    analysis_id: int,
    reportable: bool,
    reason: Optional[str] = None,
    user_id: Optional[int] = None,
) -> LimsAnalysis:
    """Flip the reportable flag. Not a state-machine transition — written
    to the audit log with transition_kind='auto' and from_state==to_state."""
    row = get_analysis(db, analysis_id)
    if row.reportable == reportable:
        return row  # no-op

    row.reportable = reportable
    row.reportable_reason = reason
    row.updated_at = datetime.utcnow()

    db.add(LimsAnalysisTransition(
        analysis_id=row.id,
        from_state=row.review_state,
        to_state=row.review_state,
        transition_kind="auto",
        user_id=user_id,
        reason=(
            f"reportable={reportable}" + (f": {reason}" if reason else "")
        ),
    ))
    db.commit()
    db.refresh(row)
    return row


def set_method_instrument(
    db: Session,
    *,
    analysis_id: int,
    method_id: Optional[int],
    instrument_id: Optional[int],
    user_id: Optional[int] = None,
) -> LimsAnalysis:
    """Phase 3.6: update method_id + instrument_id on a lims_analyses row.

    Either may be None (clear). No-op + early-return if both match the
    current row state. Writes an 'auto' audit transition with a
    machine-parseable reason — same pattern as set_reportable.
    """
    row = get_analysis(db, analysis_id)

    if row.method_id == method_id and row.instrument_id == instrument_id:
        return row

    row.method_id = method_id
    row.instrument_id = instrument_id
    row.updated_at = datetime.utcnow()

    db.add(LimsAnalysisTransition(
        analysis_id=row.id,
        from_state=row.review_state,
        to_state=row.review_state,
        transition_kind="auto",
        user_id=user_id,
        reason=f"method_id={method_id},instrument_id={instrument_id}",
    ))
    db.commit()
    db.refresh(row)
    return row


# ─── Phase 3 adapter: SenaiteAnalysis-shape projection ──────────────────────


def list_analyses_in_senaite_shape(
    db: Session,
    *,
    host_kind: str,
    host_pk: int,
    include_retests: bool = False,
):
    """List analyses for a host, projected to the FE's SenaiteAnalysis shape.

    UID carries the 'mk1:' prefix so the FE can dispatch transitions to the
    Mk1 endpoints. method_options + instrument_options are left empty in
    Phase 3 — editing method/instrument on Mk1 vials would need new Mk1
    PATCH endpoints; deferred to a later phase. Bench-tech result-entry +
    state transitions DO work via the Phase 1 transitions endpoint.
    """
    from models import AnalysisService, HplcMethod, Instrument
    from lims_analyses.schemas import SenaiteShapeAnalysisResponse

    rows = list_analyses_for_host(
        db, host_kind=host_kind, host_pk=host_pk,
        include_retests=include_retests,
    )
    if not rows:
        return []

    # Bulk-load services for unit / method-name display
    service_ids = {r.analysis_service_id for r in rows}
    services_by_id = {
        s.id: s
        for s in db.execute(
            select(AnalysisService).where(AnalysisService.id.in_(service_ids))
        ).scalars().all()
    }

    # Bulk-load chosen method/instrument display names (only for the FKs
    # actually referenced by these rows — typically empty for new vials)
    method_ids = {r.method_id for r in rows if r.method_id}
    methods_by_id = {}
    if method_ids:
        methods_by_id = {
            m.id: m
            for m in db.execute(
                select(HplcMethod).where(HplcMethod.id.in_(method_ids))
            ).scalars().all()
        }
    instrument_ids = {r.instrument_id for r in rows if r.instrument_id}
    instruments_by_id = {}
    if instrument_ids:
        instruments_by_id = {
            i.id: i
            for i in db.execute(
                select(Instrument).where(Instrument.id.in_(instrument_ids))
            ).scalars().all()
        }

    out = []
    for r in rows:
        svc = services_by_id.get(r.analysis_service_id)
        method_name = None
        if r.method_id and r.method_id in methods_by_id:
            method_name = getattr(methods_by_id[r.method_id], "name", None)
        instrument_name = None
        if r.instrument_id and r.instrument_id in instruments_by_id:
            instrument_name = getattr(instruments_by_id[r.instrument_id], "name", None)

        out.append(SenaiteShapeAnalysisResponse(
            uid=f"mk1:{r.id}",
            keyword=r.keyword,
            title=r.title,
            result=r.result_value,
            result_options=[],
            unit=r.result_unit or (svc.unit if svc else None),
            method=method_name,
            method_uid=str(r.method_id) if r.method_id else None,
            method_options=[],          # Phase 3.5: lift method editing
            instrument=instrument_name,
            instrument_uid=str(r.instrument_id) if r.instrument_id else None,
            instrument_options=[],      # Phase 3.5: lift instrument editing
            analyst=None,
            review_state=r.review_state,
            sort_key=None,
            captured=r.captured_at.isoformat() if r.captured_at else None,
            retested=r.retested,
            service_group_id=None,
            service_group_name=None,
        ))
    return out
